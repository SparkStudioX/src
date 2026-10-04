import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Connection, Tag } from "./types";
import { clearPersistedModelDraft, createModelDraft, editModelDraft, mergeAssistantModelDraft, mergeModelPackage, modelDraftChanges, modelDraftPackage, persistModelDraft, readPersistedModelDraft, redoModelDraft, restoreModelDraft, undoModelDraft, type ModelDraftState } from "./modelDraft";
import { emptyModelPackage, type ModelDraft, type ModelExpandedTag, type ModelPackage, type ModelPreview, type ModelProviderHealth } from "./modelWorkspace";

export type ModelHealth = ModelProviderHealth;
export interface WorkspaceReview { package: ModelPackage; preview: ModelPreview; revision: number }
type WorkspaceData = { definitions: ModelExpandedTag[]; live: Tag[]; health: ModelHealth | null; connections: Connection[] };
function bundleSetupNotice(value: unknown): string {
  if (value === undefined) return "";
  if (!Array.isArray(value) || value.length > 10000 || value.some(item => !item || [item.kind, item.id, item.reason].some(field => typeof field !== "string"))) throw new Error("Model bundle dependencies must be a list of named resources and setup instructions.");
  return value.map(item => `${item.kind}: ${item.id} (${item.reason})`).join("; ");
}
export function useModelWorkspace(ownerId: string, initialDraft: ModelDraft | undefined, onApplied: () => void) {
  const [state, setState] = useState<ModelDraftState | null>(null);
  const [data, setData] = useState<WorkspaceData>({ definitions: [], live: [], health: null, connections: [] });
  const [review, setReview] = useState<WorkspaceReview | null>(null), [reviewOpen, setReviewOpen] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [recoveryWarning, setRecoveryWarning] = useState("");
  const [recoveryDraft, setRecoveryDraft] = useState("");
  const suspendedRecovery = useRef(false);
  const current = useRef(state), locked = useRef(false), generation = useRef(0), receivedDraft = useRef<ModelDraft | undefined>(undefined);
  current.current = state;
  function update(next: ModelDraftState) { current.current = next; setState(next); setReview(null); setError(""); setNotice(""); }
  async function fetchWorkspace() {
    const [model, definitions, live, health, connections] = await Promise.all([api<ModelPackage>("/tag-engineering/export"), api<ModelExpandedTag[]>("/tag-engineering/definitions"), api<Tag[]>("/tag-engineering/values"), api<ModelHealth>("/tag-engineering/status"), api<Connection[]>("/connections")]);
    return { model: { ...emptyModelPackage(), ...model }, data: { definitions, live, health, connections } };
  }
  useEffect(() => {
    const run = ++generation.current;
    void fetchWorkspace().then(result => {
      if (generation.current !== run) return;
      setData(result.data);
      let next = createModelDraft(result.model);
      let recoveryText = "";
      try {
        recoveryText = readPersistedModelDraft(sessionStorage, ownerId) ?? "";
        const restored = restoreModelDraft(sessionStorage, ownerId, result.model); next = restored.state;
        if (restored.restored) setNotice("Restored an unapplied model draft from this session.");
        if (restored.conflicts.length) setRecoveryWarning(restored.conflicts.join(" "));
      } catch (reason) {
        suspendedRecovery.current = true; setRecoveryDraft(recoveryText);
        setRecoveryWarning(`${reason instanceof Error ? reason.message : String(reason)} Session recovery is paused to preserve the saved draft. Export it or explicitly discard it before replacing it.`);
      }
      current.current = next; setState(next); setReview(null); setError("");
    }).catch(reason => { if (generation.current === run) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { generation.current++; };
  }, [ownerId]);
  useEffect(() => {
    if (!state || !initialDraft || locked.current || initialDraft === receivedDraft.current) return;
    receivedDraft.current = initialDraft;
    try { update(mergeAssistantModelDraft(current.current!, initialDraft)); setNotice(initialDraft.origin === "source" ? "The source selection was merged into this unapplied draft." : "Ask Spark's proposal was merged into this unapplied draft. Review all changes before applying."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [state, initialDraft, busy]);
  useEffect(() => {
    if (!state || suspendedRecovery.current) return;
    try { persistModelDraft(sessionStorage, ownerId, state); }
    catch (reason) { setRecoveryWarning(reason instanceof Error ? reason.message : "Session storage is unavailable. Keep this page open until you apply or export the draft."); }
  }, [state, ownerId]);
  const changes = state ? modelDraftChanges(state.base, state.present) : [];
  function editable() { if (!locked.current) return true; setError("Wait for the current model review or apply to finish before changing the draft."); return false; }
  function change(model: ModelPackage) { if (editable() && current.current) update(editModelDraft(current.current, model)); }
  function undo() { if (editable() && current.current) update(undoModelDraft(current.current)); }
  function redo() { if (editable() && current.current) update(redoModelDraft(current.current)); }
  function discardRecovery() {
    if (!editable()) return;
    try {
      clearPersistedModelDraft(sessionStorage, ownerId); suspendedRecovery.current = false; setRecoveryDraft(""); setRecoveryWarning("");
      if (current.current) persistModelDraft(sessionStorage, ownerId, current.current);
    } catch (reason) { setRecoveryWarning(reason instanceof Error ? reason.message : String(reason)); }
  }
  function discard() {
    if (!editable() || !current.current) return;
    update(createModelDraft(current.current.base)); setReviewOpen(false); setNotice("Model draft discarded."); setRecoveryWarning("");
    discardRecovery();
  }
  async function perform(action: () => Promise<void>) {
    if (locked.current) return; locked.current = true; setBusy(true); setError("");
    try { await action(); } catch (reason) { setReview(null); setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { locked.current = false; setBusy(false); }
  }
  async function preview() {
    const snapshot = current.current; if (!snapshot || !modelDraftChanges(snapshot.base, snapshot.present).length) return;
    setReviewOpen(true);
    const package_ = structuredClone(modelDraftPackage(snapshot.base, snapshot.present));
    await perform(async () => {
      const result = await api<ModelPreview>("/tag-engineering/preview", "POST", package_);
      if (current.current === snapshot) setReview({ package: package_, preview: result, revision: snapshot.revision });
    });
  }
  async function apply() {
    const snapshot = current.current, accepted = review;
    if (!snapshot || !accepted || !accepted.preview.canApply || accepted.revision !== snapshot.revision) return;
    await perform(async () => {
      await api("/tag-engineering/apply", "POST", { package: accepted.package, revision: accepted.preview.revision, previewToken: accepted.preview.previewToken });
      // Clear the accepted delta immediately, even if the subsequent refresh fails.
      update(createModelDraft(snapshot.present)); setReviewOpen(false);
      if (!suspendedRecovery.current) { setRecoveryWarning(""); try { clearPersistedModelDraft(sessionStorage, ownerId); } catch { /* Session persistence is optional. */ } }
      window.dispatchEvent(new Event("sparkstudio:model-changed")); onApplied();
      try { const result = await fetchWorkspace(); setData(result.data); update(createModelDraft(result.model)); setNotice("All reviewed model changes were applied together."); }
      catch { setError("Changes applied, but the model library and data status could not refresh. Reload this page to get the current status."); }
    });
  }
  function importText(text: string) {
    if (!editable()) throw new Error("Wait for the current model review or apply to finish before importing. Your pasted package is still here.");
    if (!current.current) return;
    if (new TextEncoder().encode(text).length > 32 * 1024 * 1024) throw new Error("Model imports are limited to 32 MiB.");
    const imported = JSON.parse(text, (_key, value) => {
      if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error("Use decimal strings for Int64 values outside JavaScript's exact integer range.");
      return value;
    }) as ModelPackage | { format: "sparkstudio.model-bundle"; version: number; package: ModelPackage; externalDependencies?: { kind: string; id: string; reason: string }[] };
    if (imported.format === "sparkstudio.model-bundle" && imported.version !== 1) throw new Error("Unsupported model bundle version.");
    const package_ = imported.format === "sparkstudio.model-bundle" ? imported.package : imported;
    const setup = imported.format === "sparkstudio.model-bundle" ? bundleSetupNotice(imported.externalDependencies) : "";
    change(mergeModelPackage(current.current.present, package_)); setNotice(setup ? `Imported into the draft. Set up separately: ${setup}. Review changes to validate and apply.` : "Imported into the combined draft. Review changes to validate and apply.");
  }
  return { state, data, changes, busy, error, setError, notice, setNotice, recoveryWarning, recoveryDraft, discardRecovery, review, reviewOpen, setReviewOpen, change, undo, redo, discard, preview, apply, importText };
}
