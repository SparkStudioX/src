import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import "./accountSettings.css";

type Preview = { revision: string; previewToken: string; totalTags: number; changes: { path: string; action: string; kind: string }[] };

export default function TagTransfer({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), id = useId();
  const [text, setText] = useState(""), [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
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
      <p>Import adds tags and updates matching paths across the gateway. Existing tags absent from the file are retained. Preview all changes before applying. Connections and UDT definitions are not imported.</p>
      <button className="button" disabled={busy} onClick={() => void run(async () => {
        const result = await api<unknown>("/tag-engineering/export");
        const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2) + "\n"], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = "sparkstudio-tags.json"; link.click(); URL.revokeObjectURL(url);
        setMessage("Export downloaded. It includes configured memory values; store it appropriately.");
      })}>Export configured tags</button>
      <label>Choose a tag file<input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
        const file = event.target.files?.[0]; if (!file) return;
        void run(async () => { if (file.size > 900_000) throw new Error("Use a tag file smaller than 900 KB."); setText(await file.text()); setPreview(null); });
      }} /></label>
      <label>Tag package JSON<textarea rows={9} spellCheck={false} value={text} disabled={busy} onChange={event => { setText(event.target.value); setPreview(null); setMessage(""); }} /></label>
      <button className="button" disabled={busy || !text.trim()} onClick={() => void run(async () => {
        if (new Blob([text]).size > 900_000) throw new Error("Use a tag package smaller than 900 KB.");
        setPreview(await api<Preview>("/tag-engineering/preview", "POST", JSON.parse(text)));
      })}>Preview import</button>
      {preview && <div role="status"><p>{preview.changes.length} definitions reviewed · {preview.totalTags} total tags after import</p>
        <div style={{ maxHeight: 220, overflow: "auto" }}><table className="data-table"><thead><tr><th>Action</th><th>Tag path</th><th>Source</th></tr></thead><tbody>
          {preview.changes.map(item => <tr key={item.path}><td>{item.action}</td><td>{item.path}</td><td>{item.kind}</td></tr>)}
        </tbody></table></div><p>Changes to tags, memory values, connections or this file invalidate the preview.</p></div>}
      {error && <p className="security-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      <footer><button className="button" disabled={busy} onClick={onClose}>Done</button>
        <button className="button primary" disabled={busy || !preview} onClick={() => void run(async () => {
          await api("/tag-engineering/apply", "POST", { package: JSON.parse(text), revision: preview!.revision, previewToken: preview!.previewToken });
          setPreview(null); setMessage("Tag import applied. All changes were saved together."); onApplied();
        })}>{busy ? "Working…" : "Apply reviewed import"}</button></footer>
    </section>
  </dialog>, document.body);
}
