import { useEffect, useRef, useState } from "react";
import { useAuth } from "./Auth";
import Icon from "./Icon";
import { operatorProjectLink } from "./operatorAccessModel";
import type { RuntimePresentation } from "./operatorAccessModel";
import type { Publication } from "./types";
import "./operatorAccess.css";

export function SessionIdentity({ operator = false, onAccountSettings, iconOnlySignOut = false, placement = "inline" }: { operator?: boolean; onAccountSettings?: () => void; iconOnlySignOut?: boolean; placement?: "inline" | "sidebar" }) {
  const { user, gatewayAdmin, permissions, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const leave = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try { await signOut(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to sign out."); setBusy(false); }
  };
  const name = user?.displayName || user?.username || "Signed in";
  const signOutIcon = iconOnlySignOut || Boolean(onAccountSettings);
  const person = <><Icon name="shield" size={15} /><span><strong>{name}</strong><small>{operator ? permissions.operate ? "Operator" : "Read-only viewer" : gatewayAdmin ? "Gateway administrator" : "Engineering"}</small></span></>;
  return <div className={`session-identity${operator ? " operator-identity" : ""}${placement === "sidebar" ? " sidebar-session" : ""}`}>
    {onAccountSettings ? <button type="button" className="session-person session-settings" onClick={onAccountSettings} aria-label={`Account settings for ${name}`} title="Account settings" disabled={busy}>{person}</button> : <div className="session-person">{person}</div>}
    <div className="session-actions">{operator && <button type="button" disabled={busy} onClick={() => void leave()}>Switch user</button>}<button type="button" className={signOutIcon ? "session-sign-out" : undefined} aria-label={busy ? "Signing out…" : "Sign out"} title={signOutIcon ? "Sign out" : undefined} disabled={busy} onClick={() => void leave()}>{signOutIcon ? <Icon name="logout" size={18} /> : busy ? "Signing out…" : "Sign out"}</button></div>
    {error && <span className="session-error" role="alert">{error}</span>}
  </div>;
}

export function OperatorAccessDialog({ projectId, projectName, publication, onClose }: { projectId: string; projectName: string; publication: Publication | null; onClose: () => void }) {
  const { publicOperatorBaseUrl } = useAuth();
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");
  const [presentation, setPresentation] = useState<RuntimePresentation>("application");
  let url = "", error = "";
  try { url = operatorProjectLink(projectId, publicOperatorBaseUrl, window.location.origin, presentation); }
  catch (reason) { error = reason instanceof Error ? reason.message : "Unable to create the operator link."; }
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setStatus("Operator link copied."); }
    catch { field.current?.focus(); field.current?.select(); setStatus("Select and copy the link from the field above."); }
  };
  return <dialog ref={dialog} className="project-dialog operator-access-dialog" aria-labelledby="operator-access-title" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><div className="eyebrow">OPERATOR ACCESS</div><h2 id="operator-access-title">Open {projectName}</h2></header>
    <div className="project-dialog-body"><p>Share this project link with operators. Each person signs in with their own operator account.</p>
      <label>Presentation<select aria-describedby="operator-presentation-note" value={presentation} onChange={event => { setPresentation(event.target.value === "controls" ? "controls" : "application"); setStatus(""); }}>
        <option value="application">Application only (default)</option><option value="controls">Show runtime controls</option>
      </select></label>
      <p id="operator-presentation-note" className="operator-presentation-note">{presentation === "application" ? "Shows only the application screens, without the runtime header, screen menu, parameter selectors, theme and account controls, or footer. Use navigation built into your screens." : "Adds the runtime header, screen menu, parameter selectors, theme and account controls, and footer around the application."}</p>
      {error ? <p role="alert" className="project-error">{error}</p> : <label>Operator link<input ref={field} value={url} readOnly onFocus={event => event.target.select()} /></label>}
      <dl className="operator-access-publication"><div><dt>Publication</dt><dd>{publication?.published ? `Revision ${publication.revision ?? "—"}` : "Not published"}</dd></div>{publication?.publishedAt && <div><dt>Published</dt><dd>{new Date(publication.publishedAt).toLocaleString()}</dd></div>}</dl>
      <p className="project-note">{publicOperatorBaseUrl ? "This link uses the gateway's configured operator address." : "This link uses this browser's gateway address. If it contains localhost, open Designer using the address operators can reach, or ask a gateway administrator to configure the operator base URL."}</p>
      {!publication?.published && <p className="project-note">Publish this project before operators can open its screens.</p>}
      {status && <p role="status">{status}</p>}
    </div><footer><button className="button" onClick={onClose}>Close</button><button className="button primary" disabled={!url} onClick={() => void copy()}><Icon name="copy" size={15} />Copy operator link</button></footer>
  </dialog>;
}
