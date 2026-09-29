import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PreviewMode, PreviewSession } from "./previewRequest";
import "./previewControls.css";

export function PreviewControls({ session, busy, gatewayAdmin, onChangeMode, onDiagnostics, children }: {
  session: PreviewSession | null; busy: boolean; gatewayAdmin: boolean;
  onChangeMode: (mode: PreviewMode) => Promise<void>;
  onDiagnostics?: () => void;
  children?: ReactNode;
}) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (confirm) dialog.current?.showModal(); }, [confirm]);
  const change = async (mode: PreviewMode) => {
    setError(""); setConfirm(false);
    try { await onChangeMode(mode); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <section className={`preview-communication ${session?.mode === "live-actions" ? "preview-communication-live" : ""}`} aria-label="Preview communication">
    <div className="preview-communication-summary"><strong>{busy ? "Connecting preview…" : !session ? "Preview session unavailable · exit and reopen Preview" : session.mode === "live-actions" ? "Live actions enabled" : "Live read-only preview"}</strong>
      <span>{session?.mode === "live-actions" ? "Draft Python and browser scripts can change real data. Table commits still require the published operator application." : "Live reads and native local interactions. Python, authored browser scripts, data writes and table commits are blocked."} Unsaved screen layout · saved query definitions.</span></div>
    <div className="preview-communication-actions">{children}
    {session?.mode === "live-actions" ? <button type="button" className="button small" disabled={busy} onClick={() => void change("read-only")}>Return to read-only</button>
      : gatewayAdmin && <button type="button" className="button small" disabled={busy || !session} onClick={() => setConfirm(true)}>Enable live actions…</button>}
    {onDiagnostics && <button type="button" className="button small" disabled={busy} onClick={onDiagnostics}>Project diagnostics</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {confirm && <dialog ref={dialog} className="preview-live-dialog" aria-labelledby="preview-live-title" onCancel={() => setConfirm(false)}>
      <h2 id="preview-live-title">Enable live actions for this preview?</h2>
      <p>Buttons and popup actions can execute draft Python with the gateway's permissions, including tag and database writes. Authored browser events also run with this page's privileges. These scripts are trusted code and are not sandboxed. Their effects cannot be undone by leaving Preview.</p>
      <p>This engineering session and project receive a 15-minute capability. Switching modes closes the old capability and cancels pending requests; actions already completed are not rolled back.</p>
      <footer><button type="button" className="button" onClick={() => setConfirm(false)}>Keep read-only</button><button type="button" className="button primary" onClick={() => void change("live-actions")}>Enable live actions</button></footer>
    </dialog>}
  </section>;
}
