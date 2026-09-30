import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import "./accountSettings.css";

type Preview = { revision: string; previewToken: string; totalTags: number; canApply: boolean; conflicts: string[]; changes: { path: string; action: string; kind: string; overrideFields?: string[] }[] };
const maximumBytes = 32 * 1024 * 1024, pageSize = 100;

export default function TagTransfer({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), id = useId();
  const [text, setText] = useState(""), [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil((preview?.changes.length ?? 0) / pageSize)), currentPage = Math.min(page, pageCount - 1);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (reason) { setPreview(null); setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return createPortal(<dialog ref={dialog} className="account-settings-dialog" aria-labelledby={`${id}-title`}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id={`${id}-title`}>Import / export tags</h2><button className="account-settings-close" aria-label="Close tag transfer" disabled={busy} onClick={onClose}>×</button></header>
    <section className="security-form account-settings-password">
      <p>Import merges tags, immutable UDT versions, pinned instances and named scan groups across the gateway. Existing resources absent from the file are retained unless explicitly removed. Version 1 tag files migrate automatically; exports use version 2. Connections are configured separately.</p>
      <button className="button" disabled={busy} onClick={() => void run(async () => {
        const result = await api<unknown>("/tag-engineering/export");
        const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2) + "\n"], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = "sparkstudio-tags.json"; link.click(); URL.revokeObjectURL(url);
        setMessage("Export downloaded. It includes configured memory values; store it appropriately.");
      })}>Export configured tags</button>
      <label>Choose a tag file<input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
        const file = event.target.files?.[0]; if (!file) return;
        void run(async () => { if (file.size > maximumBytes) throw new Error("Tag files are limited to 32 MiB."); setText(await file.text()); setPreview(null); });
      }} /></label>
      <label>Tag package JSON<textarea rows={9} spellCheck={false} value={text} disabled={busy} onChange={event => { setText(event.target.value); setPreview(null); setMessage(""); }} /></label>
      <button className="button" disabled={busy || !text.trim()} onClick={() => void run(async () => {
        if (new Blob([text]).size > maximumBytes) throw new Error("Tag packages are limited to 32 MiB.");
        setPage(0);
        setPreview(await api<Preview>("/tag-engineering/preview", "POST", JSON.parse(text)));
      })}>Preview import</button>
      {preview && <div role="status"><p>{preview.changes.length} resources reviewed · {preview.totalTags} total tags after import</p>
        {preview.conflicts?.length > 0 && <div className="security-error"><strong>Resolve conflicts before applying</strong><ul>{preview.conflicts.map(conflict => <li key={conflict}>{conflict}</li>)}</ul></div>}
        <div style={{ maxHeight: 220, overflow: "auto" }}><table className="data-table"><thead><tr><th>Action</th><th>Tag path</th><th>Source</th></tr></thead><tbody>
          {preview.changes.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(item => <tr key={`${item.kind}:${item.path}`}><td>{item.action}</td><td>{item.path}{item.overrideFields?.length ? ` (overrides: ${item.overrideFields.join(", ")})` : ""}</td><td>{item.kind}</td></tr>)}
        </tbody></table></div>
        <nav aria-label="Tag import preview pages" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span>{preview.changes.length ? `Showing ${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, preview.changes.length)} of ${preview.changes.length} reviewed changes` : "No changes"}</span>
          <button className="button small" disabled={busy || currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous changes</button>
          <button className="button small" disabled={busy || currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next changes</button>
        </nav><p>Changes to tag definitions, connections or this file invalidate the preview.</p></div>}
      {error && <p className="security-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      <footer><button className="button" disabled={busy} onClick={onClose}>Done</button>
        <button className="button primary" disabled={busy || !preview?.canApply} onClick={() => void run(async () => {
          const request = { package: JSON.parse(text), revision: preview!.revision, previewToken: preview!.previewToken };
          if (new Blob([JSON.stringify(request)]).size > maximumBytes) throw new Error("The reviewed import request exceeds 32 MiB. Split the package into smaller imports.");
          await api("/tag-engineering/apply", "POST", request);
          setPreview(null); setMessage("Tag import applied. All changes were saved together."); onApplied();
        })}>{busy ? "Working…" : "Apply reviewed import"}</button></footer>
    </section>
  </dialog>, document.body);
}
