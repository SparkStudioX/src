import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "./Auth";
import { ThemePicker } from "./Theme";
import "./accountSettings.css";

export function AccountSettingsDialog({ onClose, hasUnsavedChanges = false }: { onClose: () => void; hasUnsavedChanges?: boolean }) {
  const auth = useAuth();
  const dialog = useRef<HTMLDialogElement>(null), mounted = useRef(true), pending = useRef(false);
  const id = useId();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState(""), [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    const element = dialog.current, previous = document.activeElement;
    element?.showModal();
    return () => {
      mounted.current = false; element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const clearPasswords = () => { setCurrentPassword(""); setNewPassword(""); setConfirmation(""); };
  const close = () => { if (!pending.current) { clearPasswords(); setError(""); onClose(); } };
  async function submit() {
    if (pending.current) return;
    const problem = hasUnsavedChanges ? "Save your project before changing your password."
      : !currentPassword ? "Enter your current password."
      : newPassword.length < 12 || newPassword.length > 256 ? "Use 12–256 characters for your new password."
      : newPassword !== confirmation ? "The new passwords do not match."
      : newPassword === currentPassword ? "Choose a password different from your current password." : "";
    if (problem) { clearPasswords(); setError(problem); return; }
    pending.current = true; setBusy(true); setError("");
    try { await auth.changePassword(currentPassword, newPassword); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "The gateway could not change your password."); }
    finally {
      pending.current = false;
      if (mounted.current) { clearPasswords(); setBusy(false); }
    }
  }
  return createPortal(<dialog ref={dialog} className="account-settings-dialog" aria-labelledby={`${id}-title`}
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id={`${id}-title`}>Account settings</h2><button type="button" className="account-settings-close" aria-label="Close account settings" disabled={busy} onClick={close}>×</button></header>
    <div className="account-settings-identity"><strong>{auth.user?.displayName || auth.user?.username}</strong>{auth.user?.displayName && auth.user.displayName !== auth.user.username && <span>{auth.user.username}</span>}<small>{auth.gatewayAdmin ? "Gateway administrator" : auth.audience === "operator" ? "Operator" : "Designer"}</small></div>
    <section className="account-settings-appearance" aria-labelledby={`${id}-appearance`}><h3 id={`${id}-appearance`}>Appearance</h3><ThemePicker /><p>Applies immediately in this browser.</p></section>
    <form className="security-form account-settings-password" noValidate onSubmit={event => { event.preventDefault(); void submit(); }}>
      <h3>Change password</h3>
      <p id={`${id}-password-help`}>Use 12–256 characters. Changing your password signs you out on all devices.</p>
      {hasUnsavedChanges && <p className="security-notice" role="status">Save your project before changing your password. You can still change the theme here.</p>}
      <label>Current password<input type="password" autoComplete="current-password" required maxLength={256} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} disabled={busy || hasUnsavedChanges} /></label>
      <label>New password<input type="password" autoComplete="new-password" required minLength={12} maxLength={256} aria-describedby={`${id}-password-help`} value={newPassword} onChange={event => setNewPassword(event.target.value)} disabled={busy || hasUnsavedChanges} /></label>
      <label>Confirm new password<input type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy || hasUnsavedChanges} /></label>
      {error && <p className="security-error" role="alert">{error}</p>}
      <footer><button type="button" className="button" onClick={close} disabled={busy}>Done</button><button className="button primary" disabled={busy || hasUnsavedChanges}>{busy ? "Changing password…" : "Change password"}</button></footer>
    </form>
  </dialog>, document.body);
}
