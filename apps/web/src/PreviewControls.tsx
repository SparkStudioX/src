import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PreviewMode, PreviewSession } from "./previewRequest";
import Icon from "./Icon";
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
  const keepReadOnly = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!confirm) return;
    const element = dialog.current, previous = document.activeElement;
    element?.showModal();
    keepReadOnly.current?.focus();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [confirm]);
  const change = async (mode: PreviewMode) => {
    setError(""); setConfirm(false);
    try { await onChangeMode(mode); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const live = session?.mode === "live-actions";
  const explanation = live
    ? "Live actions enabled. Draft scripts can change real tags and database data. Select to return to read-only."
    : "Read-only preview uses unsaved screen changes and saved queries. Enable live actions to run draft scripts and writes; table commits require the published operator application.";
  return <div className="preview-communication" role="group" aria-label="Preview communication">
    {children}
    <button type="button" className="preview-live-toggle" aria-pressed={live}
      disabled={busy || !session || (!gatewayAdmin && !live)}
      title={!session ? "Preview session unavailable. Exit and reopen Preview." : !gatewayAdmin && !live ? "A gateway administrator can enable live actions." : explanation}
      onClick={() => live ? void change("read-only") : setConfirm(true)}>
      <Icon name="spark" size={13} /><span>Live actions</span><span className="preview-live-state" aria-hidden="true">{live ? "On" : "Off"}</span>
    </button>
    {onDiagnostics && <button type="button" className="icon-button preview-diagnostics" disabled={busy} onClick={onDiagnostics} aria-label="Project diagnostics" title="Project diagnostics"><Icon name="activity" size={13} /></button>}
    {(busy || !session) && <span className="preview-communication-status" role="status" title="Exit and reopen Preview if its session is unavailable.">{busy ? "Connecting preview…" : "Preview unavailable"}</span>}
    {error && <span className="preview-communication-error" role="alert" title={error}>{error}</span>}
    {confirm && <dialog ref={dialog} className="preview-live-dialog" aria-labelledby="preview-live-title" aria-describedby="preview-live-description preview-live-impact" onCancel={() => setConfirm(false)} onKeyDown={event => event.stopPropagation()}>
      <header>
        <div><h2 id="preview-live-title">Enable live actions?</h2><p id="preview-live-description">Allow draft scripts and actions in this preview.</p></div>
        <button type="button" className="icon-button" aria-label="Close live actions confirmation" onClick={() => setConfirm(false)}><Icon name="close" /></button>
      </header>
      <div className="preview-live-body">
        <div className="preview-live-impact" id="preview-live-impact"><strong>Actions can change real tags and database data.</strong><p>Changes already made are not undone when you leave Preview.</p></div>
        <dl className="preview-live-details">
          <div><dt>Script access</dt><dd>Python runs with gateway permissions. Browser scripts run with this page's privileges. Both are trusted code and are not sandboxed.</dd></div>
          <div><dt>Duration</dt><dd>15 minutes, limited to this project and your engineering session.</dd></div>
          <div><dt>Switching modes</dt><dd>Ends the current preview access and cancels pending requests.</dd></div>
        </dl>
      </div>
      <footer><button type="button" className="button" ref={keepReadOnly} onClick={() => setConfirm(false)}>Keep read-only</button><button type="button" className="button primary" onClick={() => void change("live-actions")}>Enable live actions</button></footer>
    </dialog>}
  </div>;
}
