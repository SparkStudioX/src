import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import "./accountSettings.css";

type Member = { path: string; kind: string; dataType: string; value?: unknown; expression?: string; inputs?: Record<string, string> };
type Definition = { id: string; version: number; members: Member[] };
type Instance = { path: string; definitionId: string; version: number; enabled?: boolean; overrides: Record<string, unknown> };
type Group = { name: string; publishingIntervalMs: number; enabled?: boolean };
type Model = { format: string; version: number; provider: { name: string; enabled: boolean }; tags: unknown[]; udtDefinitions: Definition[]; instances: Instance[]; scanGroups: Group[] };
type Preview = { revision: string; previewToken: string; totalTags: number; canApply: boolean; conflicts: string[]; changes: { path: string; kind: string; action: string; overrideFields?: string[] }[] };
type Status = { state: string; configuredTags: number; goodTags: number; unavailableTags: number; disabledTags: number };
type Tab = "definitions" | "instances" | "groups" | "provider";
const empty = () => ({ format: "sparkstudio.tags", version: 2, tags: [], udtDefinitions: [], instances: [], scanGroups: [] });
const initialMembers = '[\n  { "path": "Count", "kind": "memory", "dataType": "Int32", "value": 0 },\n  { "path": "Doubled", "kind": "expression", "dataType": "Int32", "expression": "count * 2", "inputs": { "count": "./Count" } }\n]';

export default function TagModels({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), id = useId();
  const [model, setModel] = useState<Model | null>(null), [status, setStatus] = useState<Status | null>(null);
  const [tab, setTab] = useState<Tab>("definitions"), [selected, setSelected] = useState("");
  const [name, setName] = useState("NewUnit"), [version, setVersion] = useState(1), [text, setText] = useState(initialMembers);
  const [definitionId, setDefinitionId] = useState(""), [enabled, setEnabled] = useState(true), [interval, setInterval] = useState(1000);
  const [review, setReview] = useState<{ package: object; preview: Preview } | null>(null);
  const [reviewPage, setReviewPage] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  async function load() {
    const [next, health] = await Promise.all([api<Model>("/tag-engineering/export"), api<Status>("/tag-engineering/status")]);
    setModel(next); setStatus(health); return next;
  }
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement; element?.showModal();
    void load().catch(reason => setError(String(reason)));
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  function change() { setReview(null); setReviewPage(0); setError(""); setMessage(""); }
  function choose(nextTab: Tab, key = "") {
    change(); setTab(nextTab); setSelected(key);
    if (nextTab === "definitions") {
      const existing = model?.udtDefinitions.find(item => `${item.id}@${item.version}` === key);
      setName(existing?.id ?? "NewUnit");
      setVersion(existing ? Math.max(...(model?.udtDefinitions.filter(item => item.id === existing.id).map(item => item.version) ?? [0])) + 1 : 1);
      setText(existing ? JSON.stringify(existing.members, null, 2) : initialMembers);
    } else if (nextTab === "instances") {
      const existing = model?.instances.find(item => item.path === key), first = model?.udtDefinitions[0];
      setName(existing?.path ?? "[default]Equipment/NewUnit"); setDefinitionId(existing?.definitionId ?? first?.id ?? "");
      setVersion(existing?.version ?? first?.version ?? 1); setEnabled(existing?.enabled !== false); setText(JSON.stringify(existing?.overrides ?? {}, null, 2));
    } else if (nextTab === "groups") {
      const existing = model?.scanGroups.find(item => item.name === key);
      setName(existing?.name ?? "Normal"); setInterval(existing?.publishingIntervalMs ?? 1000); setEnabled(existing?.enabled !== false);
    } else setEnabled(model?.provider.enabled !== false);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (reason) { setReview(null); setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function preview(remove = false) {
    const package_: Record<string, unknown> = empty();
    if (tab === "definitions") {
      if (remove) package_.removeUdtDefinitions = [selected];
      else package_.udtDefinitions = [{ id: name, version, members: JSON.parse(text) }];
    } else if (tab === "instances") {
      if (remove) package_.removeInstances = [selected];
      else package_.instances = [{ path: name, definitionId, version, enabled, overrides: JSON.parse(text) }];
    } else if (tab === "groups") {
      if (remove) package_.removeScanGroups = [selected];
      else package_.scanGroups = [{ name, publishingIntervalMs: interval, enabled }];
    } else package_.provider = { name: "default", enabled };
    setReview({ package: package_, preview: await api<Preview>("/tag-engineering/preview", "POST", package_) }); setReviewPage(0);
  }
  const reviewChanges = review?.preview.changes ?? [], reviewPageSize = 200;
  const currentReviewPage = Math.min(reviewPage, Math.max(0, Math.ceil(reviewChanges.length / reviewPageSize) - 1));
  const reviewOffset = currentReviewPage * reviewPageSize;
  return createPortal(<dialog ref={dialog} className="account-settings-dialog" style={{ width: "min(1000px, 95vw)" }} aria-labelledby={`${id}-title`}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id={`${id}-title`}>Tag model</h2><button className="account-settings-close" aria-label="Close tag model" disabled={busy} onClick={onClose}>×</button></header>
    <section className="security-form account-settings-password">
      {status && <p role="status">[default] {status.state} · {status.configuredTags} configured · {status.goodTags} good · {status.unavailableTags} unavailable · {status.disabledTags} disabled</p>}
      <nav aria-label="Tag model sections" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {([ ["definitions", "UDT definitions"], ["instances", "Instances"], ["groups", "Scan groups"], ["provider", "Provider"] ] as const).map(([key, label]) =>
          <button className={`button ${tab === key ? "primary" : ""}`} key={key} aria-pressed={tab === key} disabled={busy || !model} onClick={() => choose(key)}>{label}</button>)}
      </nav>
      {model && <fieldset disabled={busy} style={{ border: 0, padding: 0, display: "grid", gap: 12 }}>
        {tab === "definitions" && <>
          <p>Versions are immutable. Select a version to create its successor, then explicitly upgrade each instance. Existing overrides stay with the instance.</p>
          <label>Start from<select value={selected} onChange={event => choose(tab, event.target.value)}><option value="">New definition</option>{model.udtDefinitions.map(item => <option key={`${item.id}@${item.version}`}>{item.id}@{item.version}</option>)}</select></label>
          <label>Definition ID<input value={name} onChange={event => { change(); setName(event.target.value); }} /></label>
          <label>New version<input type="number" min={1} max={1000000} value={version} onChange={event => { change(); setVersion(Number(event.target.value)); }} /></label>
          <label>Members (JSON)<textarea rows={12} spellCheck={false} value={text} onChange={event => { change(); setText(event.target.value); }} /></label>
          <small>Use relative member paths and ./Member for expression inputs. Each member has a source, scalar dataType, and optional scanGroup. Nested UDTs and additional providers are unsupported.</small>
        </>}
        {tab === "instances" && <>
          <label>Instance<select value={selected} onChange={event => choose(tab, event.target.value)}><option value="">New instance</option>{model.instances.map(item => <option key={item.path}>{item.path}</option>)}</select></label>
          <label>Instance path<input value={name} readOnly={Boolean(selected)} onChange={event => { change(); setName(event.target.value); }} /></label>
          <label>Pinned definition version<select value={`${definitionId}@${version}`} onChange={event => { change(); const split = event.target.value.lastIndexOf("@"); setDefinitionId(event.target.value.slice(0, split)); setVersion(Number(event.target.value.slice(split + 1))); }}>
            <option value="@1">Choose a definition…</option>{model.udtDefinitions.map(item => <option key={`${item.id}@${item.version}`}>{item.id}@{item.version}</option>)}
          </select></label>
          <label>Member overrides (JSON)<textarea rows={9} spellCheck={false} value={text} onChange={event => { change(); setText(event.target.value); }} /></label>
          <small>Example: {"{\"Count\": {\"value\": 12}, \"Doubled\": {\"scanGroup\": \"Normal\"}}"}. Remove an override field to inherit the definition again. Memory writes become value overrides. Kind and data type belong to the definition.</small>
        </>}
        {tab === "groups" && <>
          <p>A named scan group controls member/tag timing and availability. Updating it previews every affected tag. Memory values keep their source timestamps.</p>
          <label>Scan group<select value={selected} onChange={event => choose(tab, event.target.value)}><option value="">New scan group</option>{model.scanGroups.map(item => <option key={item.name}>{item.name}</option>)}</select></label>
          <label>Name<input value={name} readOnly={Boolean(selected)} onChange={event => { change(); setName(event.target.value); }} /></label>
          <label>Publishing interval (ms)<input type="number" min={100} max={60000} step={100} value={interval} onChange={event => { change(); setInterval(Number(event.target.value)); }} /></label>
          <small>OPC UA requests this interval. Expressions use a 100 ms scheduler resolution.</small>
        </>}
        {tab === "provider" && <p>The built-in [default] provider owns all configured tags and sample tags. Disabling it marks values unavailable and stops configured OPC UA subscriptions. Re-enabling restarts acquisition. Connection settings remain separate.</p>}
        {tab !== "definitions" && <label className="checkbox-field"><input type="checkbox" checked={enabled} onChange={event => { change(); setEnabled(event.target.checked); }} /><span>{tab === "provider" ? "Provider" : tab === "groups" ? "Scan group" : "Instance"} enabled</span></label>}
      </fieldset>}
      <div style={{ display: "flex", gap: 8 }}><button className="button" disabled={busy || !model} onClick={() => void run(() => preview())}>Preview changes</button>
        {selected && tab !== "provider" && <button className="button danger" disabled={busy} onClick={() => void run(() => preview(true))}>Preview removal</button>}</div>
      {review && <div role="status">
        {review.preview.conflicts?.length > 0 ? <div className="security-error"><strong>Resolve these conflicts before applying</strong><ul>{review.preview.conflicts.map(item => <li key={item}>{item}</li>)}</ul></div> : <p>{review.preview.totalTags} configured tags after apply. Review inherited changes and retained overrides below.</p>}
        <div style={{ maxHeight: 260, overflow: "auto" }}><table className="data-table"><thead><tr><th>Action</th><th>Resource / path</th><th>Kind</th><th>Retained overrides</th></tr></thead><tbody>
          {reviewChanges.slice(reviewOffset, reviewOffset + reviewPageSize).map(item => <tr key={`${item.kind}:${item.path}`}><td>{item.action}</td><td>{item.path}</td><td>{item.kind}</td><td>{item.overrideFields?.join(", ") || "—"}</td></tr>)}
        </tbody></table></div>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <span>{reviewChanges.length ? `Showing ${reviewOffset + 1}–${Math.min(reviewOffset + reviewPageSize, reviewChanges.length)} of ${reviewChanges.length.toLocaleString()} changes.` : "No resource changes."}</span>
          {reviewChanges.length > reviewPageSize && <>
            <button type="button" className="button" disabled={busy || currentReviewPage === 0} onClick={() => setReviewPage(currentReviewPage - 1)}>Previous changes</button>
            <button type="button" className="button" disabled={busy || reviewOffset + reviewPageSize >= reviewChanges.length} onClick={() => setReviewPage(currentReviewPage + 1)}>Next changes</button>
          </>}
        </div><small>Apply includes all {reviewChanges.length.toLocaleString()} changes, including other pages. Concurrent tag-definition, connection, or model edits invalidate this preview.</small>
      </div>}
      {error && <p className="security-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      <footer><button className="button" disabled={busy} onClick={onClose}>Done</button><button className="button primary" disabled={busy || !review?.preview.canApply} onClick={() => void run(async () => {
        await api("/tag-engineering/apply", "POST", { package: review!.package, revision: review!.preview.revision, previewToken: review!.preview.previewToken });
        setReview(null); await load(); setSelected(""); setMessage("Reviewed tag model saved atomically."); onApplied();
      })}>{busy ? "Working…" : "Apply reviewed changes"}</button></footer>
    </section>
  </dialog>, document.body);
}
