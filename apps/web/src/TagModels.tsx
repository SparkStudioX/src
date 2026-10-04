import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Connection, Tag } from "./types";
import { useAskSpark } from "./askSparkContext";
import { downloadModelExport } from "./modelWorkspaceDownload";
import { modelDraftChangeSummary, modelDraftPackage } from "./modelDraft";
import { recordModelNavigationLocation, registerModelNavigationGuard } from "./modelNavigation";
import ModelOperationsPanel, { type ModelOperationTool } from "./modelOperationsPanel";
import ModelBuilder from "./modelBuilder";
import ModelNamespace from "./modelWorkspaceNamespace";
import ModelWorkspaceSettings from "./modelWorkspaceSettings";
import { ModelDiscardConfirmation, ModelImportPanel, ModelWorkspaceReviewPanel } from "./modelWorkspacePanels";
import { useModelWorkspace } from "./useModelWorkspace";
import { definitionKey, modelProviderStatus, type ModelDraft } from "./modelWorkspace";
import "./accountSettings.css";
import "./modelWorkspace.css";

type View = "build" | "namespace" | "settings" | "operate";
const views: [View, string, string][] = [["build", "Build models", "Choose data and add equipment"], ["namespace", "Organize", "Put equipment in the right place"], ["operate", "Inspect & share", "Quality, mappings and publishing"], ["settings", "Settings", "Control how data updates"]];
const initialView = (): View => { const value = new URLSearchParams(window.location.search).get("view"); return value === "namespace" || value === "settings" || value === "operate" ? value : "build"; };
type OperationRequest = { tool: ModelOperationTool; requestId: number; equipmentPath?: string };
function WorkspaceSurface({ workspace, view, selectedType, setSelectedType, tags, connections, focusTarget, navigate, announce, onContextChange, onLockChange, requestedTool, openTool }: { workspace: ReturnType<typeof useModelWorkspace>; view: View; selectedType: string; setSelectedType: (key: string) => void; tags?: Tag[]; connections: Connection[]; focusTarget: string; navigate: (path: string) => void; announce: (text: string) => void; onContextChange: (next: { selection: string[]; resolution: string[] }) => void; onLockChange: (locked: boolean) => void; requestedTool?: OperationRequest; openTool: (tool: ModelOperationTool, equipmentPath?: string) => void }) {
  const { state, data } = workspace; if (!state) return null;
  const live = tags ?? data.live;
  return <fieldset className="model-body" disabled={workspace.busy}>{view === "build" && <ModelBuilder model={state.present} savedModel={state.base} definitions={data.definitions} tags={live} connections={data.connections.length ? data.connections : connections} selectedType={selectedType} onSelectType={setSelectedType} onChange={workspace.change} fromAskSpark={state.fromAskSpark} onAnnounce={announce} onContextChange={onContextChange} focusTarget={focusTarget} disabled={workspace.busy} onUseStarter={() => openTool("start")} onReview={() => void workspace.preview()} onVerify={path => openTool("live", path)} hasChanges={workspace.changes.length > 0} onIssues={path => openTool("issues", path)} />}
    {view === "namespace" && <ModelNamespace key={focusTarget} model={state.present} definitions={data.definitions} tags={live} onChange={workspace.change} onInstance={instance => navigate(instance.path)} onAnnounce={announce} focusTarget={focusTarget} />}
    {view === "operate" && <ModelOperationsPanel model={state.present} savedModel={state.base} onChange={workspace.change} connections={data.connections.length ? data.connections : connections} tagPaths={data.definitions.map(item => item.path)} onNavigate={navigate} onSelect={key => { setSelectedType(key); navigate(key); }} onLockChange={onLockChange} requestedTool={requestedTool} />}
    {view === "settings" && <ModelWorkspaceSettings model={state.present} onChange={workspace.change} />}</fieldset>;
}
function downloadDraft(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  try { const link = document.createElement("a"); link.href = url; link.download = "sparkstudio-model-draft.json"; link.click(); } finally { URL.revokeObjectURL(url); }
}
function ModelRecoveryNotice({ workspace }: { workspace: ReturnType<typeof useModelWorkspace> }) {
  const [confirming, setConfirming] = useState(false);
  if (!workspace.recoveryWarning) return null;
  return <div className="model-notice"><p className="model-warning" role="alert">{workspace.recoveryWarning}</p>{workspace.recoveryDraft && <div className="model-actions"><button type="button" className="button" onClick={() => downloadDraft(workspace.recoveryDraft)}>Export recovered draft</button><button type="button" className="button danger" disabled={workspace.busy} onClick={() => setConfirming(true)}>Discard recovered draft</button></div>}{confirming && <ModelDiscardConfirmation title="Discard the recovered session draft?" description="This removes the saved draft that could not be restored. Export it first if you want to recover its contents. Your current workspace edits are kept." onCancel={() => setConfirming(false)} onConfirm={() => { workspace.discardRecovery(); setConfirming(false); }} />}</div>;
}
export default function TagModels({ onApplied, connections = [], tags, initialDraft, ownerId = "" }: { onApplied: () => void; connections?: Connection[]; tags?: Tag[]; initialDraft?: ModelDraft; ownerId?: string }) {
  const id = useId(), ask = useAskSpark();
  const workspace = useModelWorkspace(ownerId, initialDraft, onApplied);
  const { state, changes, busy, data, review, reviewOpen } = workspace;
  const [view, setView] = useState<View>(initialDraft ? "build" : initialView);
  const [selectedType, setSelectedType] = useState(() => new URLSearchParams(window.location.search).get("type") || "");
  const [operationLocked, setOperationLocked] = useState(false);
  const [operationRequest, setOperationRequest] = useState<OperationRequest>();
  const [focusTarget, setFocusTarget] = useState(""), [announcement, setAnnouncement] = useState("");
  const [discarding, setDiscarding] = useState(false), [importing, setImporting] = useState(false);
  const [builderContext, setBuilderContext] = useState<{ selection: string[]; resolution: string[] }>({ selection: [], resolution: [] });
  const draftLocked = busy || operationLocked;
  const guard = useRef({ dirty: false, blocked: false, onBlocked: () => {}, discard: () => {} });
  const context = useRef({ view, selectedType, changes, builderContext }); context.current = { view, selectedType, changes, builderContext };
  guard.current = { dirty: changes.length > 0, blocked: draftLocked, onBlocked: () => workspace.setError("Finish the current request or save/discard publisher edits before leaving this workspace."), discard: () => { if (busy) return; guard.current.dirty = false; workspace.discard(); } };
  const onContextChange = useCallback((next: { selection: string[]; resolution: string[] }) => setBuilderContext(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next), []);
  function changeView(next: View) { if (next !== "operate") setOperationRequest(undefined); if (next !== view) { workspace.setNotice(""); setAnnouncement(""); } setView(next); }
  function selectType(next: string) { if (next !== selectedType) { workspace.setNotice(""); setAnnouncement(""); } setSelectedType(next); }
  function openTool(tool: ModelOperationTool, equipmentPath?: string) {
    if (draftLocked) return;
    setOperationRequest(previous => ({ tool, equipmentPath, requestId: (previous?.requestId ?? 0) + 1 }));
    changeView("operate");
  }
  useEffect(() => registerModelNavigationGuard(id, { isDirty: () => guard.current.dirty, isBlocked: () => guard.current.blocked, onBlocked: () => guard.current.onBlocked(), discard: () => guard.current.discard() }), [id]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (guard.current.dirty || guard.current.blocked) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload); return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  useEffect(() => ask.registerContext(`model-workspace:${id}`, () => {
    const value = context.current;
    return { section: "models", editorAvailable: false, documentId: undefined, documentName: undefined, documentKind: undefined, selectedComponentIds: [], selectedComponentNames: [], snapshotToken: undefined, selection: undefined, screenId: undefined, screenName: undefined, templateId: undefined,
      ...(guard.current.dirty ? { unsavedChanges: true } : {}), modelView: value.view, modelType: value.selectedType, modelSelection: value.builderContext.selection.slice(0, 20), modelResolution: value.builderContext.resolution.slice(0, 20),
      modelDraftSummary: value.changes.map(item => `${item.action} ${item.kind}: ${item.key}`).slice(0, 30).join("; ").slice(0, 4000) };
  }, 30), [ask.registerContext, id]);
  useEffect(() => { ask.refreshContext(); }, [view, selectedType, builderContext, state]);
  useEffect(() => {
    const url = new URL(window.location.href); url.searchParams.set("workspace", "models"); url.searchParams.delete("section"); url.searchParams.set("view", view);
    if (selectedType) url.searchParams.set("type", selectedType); else url.searchParams.delete("type");
    window.history.replaceState(window.history.state, "", url); recordModelNavigationLocation();
  }, [view, selectedType]);
  useEffect(() => {
    if (!initialDraft || !state) return;
    setView("build");
    if (initialDraft.definition) { const candidates = state.present.udtDefinitions.filter(item => item.id === initialDraft.definition!.id); if (candidates.length) setSelectedType(definitionKey(candidates.reduce((a, b) => a.version > b.version ? a : b))); }
  }, [initialDraft, state?.fromAskSpark]);
  function navigate(path: string) {
    if (!state) return;
    setOperationRequest(undefined); setFocusTarget(path); workspace.setReviewOpen(false); workspace.setNotice(""); setAnnouncement("");
    const instance = state.present.instances.find(item => path === item.path || path.startsWith(item.path + "/"));
    const type = state.present.udtDefinitions.find(item => definitionKey(item) === path);
    if (instance || type) { setSelectedType(instance ? `${instance.definitionId}@${instance.version}` : definitionKey(type!)); setView("build"); }
    else if (state.present.hierarchy.some(item => item.path === path)) setView("namespace");
    else if (state.present.scanGroups.some(item => item.name === path) || path === "default") setView("settings");
    else setView("build");
  }
  async function exportSaved() { try { await downloadModelExport(); } catch (reason) { workspace.setError(reason instanceof Error ? reason.message : String(reason)); } }
  const menuAction = (event: React.MouseEvent<HTMLButtonElement>, action: () => void) => { event.currentTarget.closest("details")?.removeAttribute("open"); action(); };
  const status = modelProviderStatus(data.health, data.definitions, tags ?? data.live);
  return <div className="management-page model-workspace model-workspace-builder" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !busy && state) { event.preventDefault(); event.stopPropagation(); if (event.shiftKey) workspace.redo(); else workspace.undo(); }
  }}>
    <div className="page-heading"><div><div className="model-title-line"><h1 id={`${id}-title`}>Models</h1><span className={`model-status-pill ${status.degraded ? "degraded" : ""}`}>{status.label}</span></div><p>Turn your data into reusable models. Build once, then use it for every machine.</p></div><div className="page-heading-actions">
      <details className="model-transfer-menu"><summary className="button" aria-label="Import / export model">Import / export ▾</summary><div><button type="button" className="button" disabled={!state || busy} onClick={event => menuAction(event, () => setImporting(true))}>Import into draft</button><button type="button" className="button" disabled={!state || busy} onClick={event => menuAction(event, () => void exportSaved())}>Export saved model</button><button type="button" className="button" disabled={!changes.length || busy} onClick={event => menuAction(event, () => downloadDraft(JSON.stringify(modelDraftPackage(state!.base, state!.present), null, 2)))}>Export draft</button></div></details>
      <button type="button" className="button primary" disabled={draftLocked || !changes.length} onClick={() => void workspace.preview()}>Review changes ({changes.length})</button>
      <details className="model-transfer-menu"><summary className="button" aria-label="Model workspace actions">⋯</summary><div><button type="button" className="button" disabled={busy || !state?.past.length} onClick={event => menuAction(event, workspace.undo)}>Undo</button><button type="button" className="button" disabled={busy || !state?.future.length} onClick={event => menuAction(event, workspace.redo)}>Redo</button><button type="button" className="button danger" disabled={busy || !changes.length} onClick={event => menuAction(event, () => setDiscarding(true))}>Discard draft</button></div></details>
    </div></div>
    <div className="model-workspace-subnav"><nav className="model-view-switch" aria-label="Model workspace views">{views.map(([key, label, hint]) => <button type="button" key={key} disabled={operationLocked && key !== view} aria-label={label} aria-pressed={view === key} className={view === key ? "active" : ""} onClick={() => changeView(key)}><strong>{label}</strong><small>{hint}</small></button>)}</nav><details className="model-workspace-help"><summary>How models work</summary><div><strong>One blueprint. Many machines.</strong><p>A <b>model</b> lists the data you need, like a pump’s speed and temperature. Each piece of data is a <b>field</b>.</p><p>Add <b>equipment</b> to use that blueprint for a real machine, like Pump01. Each equipment entry is an <b>instance</b> with its own data sources.</p><p>Nothing goes live until you review and apply your changes.</p></div></details></div>
    <div className="model-draft-status" role="status"><span className={changes.length ? "has-changes" : ""} title="Counts the items that differ from the saved gateway. Editing the same item again does not add another change.">{changes.length ? `${changes.length} changed ${changes.length === 1 ? "item" : "items"}` : "All changes saved"}</span><span>{changes.length ? modelDraftChangeSummary(changes) : "Shared across projects on this gateway."}</span></div>
    {workspace.notice && <div className="model-notice" role="status">{workspace.notice}</div>}<ModelRecoveryNotice workspace={workspace} />{workspace.error && !reviewOpen && <p className="security-error" role="alert">{workspace.error}</p>}
    {!state && !workspace.error && <p role="status">Loading model library…</p>}
    <WorkspaceSurface workspace={workspace} view={view} selectedType={selectedType} setSelectedType={selectType} tags={tags} connections={connections} focusTarget={focusTarget} navigate={navigate} announce={setAnnouncement} onContextChange={onContextChange} onLockChange={setOperationLocked} requestedTool={operationRequest} openTool={openTool} />
    {view !== "build" && <div className="model-live-region" role="status" aria-live="polite">{announcement}</div>}
    {reviewOpen && state && <ModelWorkspaceReviewPanel review={review} error={workspace.error} count={changes.length} busy={busy} onApply={() => void workspace.apply()} onPreview={() => void workspace.preview()} onClose={() => workspace.setReviewOpen(false)} onDiscard={() => setDiscarding(true)} onNavigate={navigate} model={state.present} />}
    {importing && <ModelImportPanel onImport={workspace.importText} onClose={() => setImporting(false)} />}{discarding && <ModelDiscardConfirmation onCancel={() => setDiscarding(false)} onConfirm={() => { guard.current.discard(); setDiscarding(false); }} />}
  </div>;
}
