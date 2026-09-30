import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiUrl, authenticatedFetch, assertAuthResponseCurrent } from "./api";
import { backupDraftFromSaved, backupSettingsRequest, emptyBackupSecrets } from "./gatewayBackupModel";
import type { BackupDraft, BackupSecretEdits, BackupStatus, BackupDestinationKind } from "./gatewayBackupModel";
import "./gatewayBackups.css";

const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString(undefined, { timeZoneName: "short" }) : "Not yet";
const bytes = (value: number | null | undefined) => value === null || value === undefined ? "" : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;

export default function GatewayBackups() {
  const [status, setStatus] = useState<BackupStatus | null>(null), [draft, setDraft] = useState<BackupDraft | null>(null);
  const [baseline, setBaseline] = useState<BackupDraft | null>(null), [revision, setRevision] = useState("");
  const [secrets, setSecrets] = useState<BackupSecretEdits>(emptyBackupSecrets);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [statusError, setStatusError] = useState(""), [message, setMessage] = useState("");
  const mounted = useRef(true), pending = useRef(false), serial = useRef(0);
  const accept = useCallback((next: BackupStatus) => {
    const nextDraft = backupDraftFromSaved(next.saved, next.gatewayTimeZoneId);
    setStatus(next); setDraft(nextDraft); setBaseline(nextDraft); setRevision(next.revision);
    setSecrets(emptyBackupSecrets()); setStatusError("");
  }, []);
  const reload = useCallback(async (reset: boolean) => {
    if (pending.current) return;
    const request = ++serial.current;
    if (reset) { pending.current = true; setBusy(true); setError(""); setMessage(""); }
    try {
      const next = await api<BackupStatus>("/gateway/backups");
      if (!mounted.current || request !== serial.current) return;
      if (reset) accept(next); else { setStatus(next); setStatusError(""); }
    } catch (reason) {
      if (mounted.current && request === serial.current) setStatusError(reason instanceof Error ? reason.message : "Unable to refresh backup status.");
    } finally {
      if (reset && request === serial.current) { pending.current = false; if (mounted.current) setBusy(false); }
    }
  }, [accept]);
  useEffect(() => { mounted.current = true; void reload(true); return () => { mounted.current = false; pending.current = false; serial.current++; }; }, [reload]);
  useEffect(() => {
    const timer = window.setInterval(() => void reload(false), status?.running ? 2000 : 30000);
    return () => window.clearInterval(timer);
  }, [reload, status?.running]);
  const dirty = draft !== null && (JSON.stringify(draft) !== JSON.stringify(baseline) || secrets.replaceArchivePassphrase || secrets.replaceDestinationPassword || secrets.clearDestinationPassword);
  const stale = status !== null && revision !== "" && revision !== status.revision;
  const change = (patch: Partial<BackupDraft>) => { setDraft(current => current ? { ...current, ...patch } : current); setError(""); setMessage(""); };
  const secret = (patch: Partial<BackupSecretEdits>) => { setSecrets(current => ({ ...current, ...patch })); setError(""); setMessage(""); };
  async function action(run: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; serial.current++; setBusy(true); setError(""); setMessage("");
    try { await run(); } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "The backup operation failed."); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function save() {
    if (!draft || !status) return;
    await action(async () => {
      const request = backupSettingsRequest(revision, draft, secrets);
      const next = await api<BackupStatus>("/gateway/backups", "PUT", request);
      if (mounted.current) { accept(next); setMessage("Backup settings saved. The schedule uses the gateway time zone selected below."); }
    });
  }
  async function backup(deliver: boolean) {
    await action(async () => {
      const next = await api<BackupStatus>("/gateway/backups/run", "POST", { deliver });
      if (mounted.current) { setStatus(next); setMessage(deliver ? "Backup requested. The result below will show whether the destination copy succeeded." : "Configuration backup requested. Download the completed archive below."); }
    });
  }
  async function download() {
    if (!status?.downloadId) return;
    const downloadId = status.downloadId;
    await action(async () => {
      const response = await authenticatedFetch(apiUrl(`/gateway/backups/download/${encodeURIComponent(downloadId)}`));
      if (response.status !== 401) assertAuthResponseCurrent(response);
      if (!response.ok) throw new Error(`The backup download is unavailable (HTTP ${response.status}). Create a new download or refresh status.`);
      const blob = await response.blob(); assertAuthResponseCurrent(response);
      const disposition = response.headers.get("Content-Disposition") || "";
      const suggested = disposition.match(/filename="?([^";]+)"?/i)?.[1] || "SparkStudio-configuration.sparkbak";
      const filename = /^[A-Za-z0-9_.-]+\.sparkbak$/.test(suggested) ? suggested : "SparkStudio-configuration.sparkbak";
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (mounted.current) setMessage("Archive downloaded. Keep its passphrase separately and verify a restore on an isolated gateway.");
    });
  }
  const canRun = Boolean(status?.hasArchivePassphrase && !status.running && !status.recoveryBlocked && !status.configurationError && !statusError && !dirty && !stale && !busy);
  const hasDestination = Boolean(status?.saved.destination.address);
  return <section className="gateway-backups" aria-labelledby="gateway-backups-title">
    <div className="gateway-backup-heading"><div><h3 id="gateway-backups-title">Configuration backups</h3><p>Create an encrypted download or send backups to a share or FTP server on a daily schedule.</p></div>
      <div className="gateway-backup-actions"><button type="button" className="button" disabled={!canRun} onClick={() => void backup(false)}>Create download</button><button type="button" className="button primary" disabled={!canRun || !hasDestination} onClick={() => void backup(true)}>Back up to destination</button></div>
    </div>
    {statusError && <p className="gateway-backup-error" role="alert">Status unavailable: {statusError} <button className="button small" disabled={busy} onClick={() => void reload(!draft)}>Retry</button></p>}
    {!status || !draft ? <p role="status">{busy ? "Loading backup settings…" : "Backup settings are unavailable."}</p> : <>
      <p className="gateway-backup-note">{status.coverage}</p>
      <p className="gateway-backup-note">Configuration capture briefly holds configuration writes; the gateway stays running.</p>
      {status.configurationError && <p className="gateway-backup-error" role="alert">{status.configurationError}</p>}
      {status.recoveryBlocked && <p className="gateway-stale">Backups and remote transfers are blocked in recovery mode. Finish the restore review and restart before creating a backup.</p>}
      <dl className="gateway-backup-status">
        <div><dt>Current state</dt><dd>{status.running ? "Backup running" : status.recoveryBlocked ? "Recovery mode" : "Ready"}{status.downloadId && <small><button type="button" className="button small" disabled={busy} onClick={() => void download()}>Download latest archive</button></small>}</dd></div>
        <div><dt>Next scheduled run</dt><dd>{status.saved.enabled ? date(status.nextDueAt) : "Schedule disabled"}<small>{status.saved.dailyTime} · {status.saved.timeZoneId || status.gatewayTimeZoneId}<br />Gateway time zone: {status.gatewayTimeZoneId}</small></dd></div>
        <div><dt>Last run</dt><dd>{status.lastRun ? status.lastRun.status === "running" ? "In progress" : status.lastRun.status === "succeeded" ? "Succeeded" : "Failed" : "No backup yet"}{status.lastRun && <small>{date(status.lastRun.completedAt || status.lastRun.startedAt)}{status.lastRun.bytes !== null && <> · {bytes(status.lastRun.bytes)}</>}</small>}</dd></div>
      </dl>
      {status.lastRun && <p className={status.lastRun.status === "failed" ? "gateway-backup-error" : "gateway-backup-note"} role="status">{status.lastRun.message}{status.lastRun.removedCount > 0 && <> · {status.lastRun.removedCount} expired archive{status.lastRun.removedCount === 1 ? "" : "s"} removed.</>}</p>}
      {stale && <p className="gateway-stale">Saved backup settings changed in another session. Reload before saving or starting a backup. Your draft has been kept.</p>}
      {dirty && <p className="gateway-backup-note">Save or discard these changes before starting a backup. Backup now uses saved settings.</p>}
      {!status.hasArchivePassphrase && <p className="gateway-backup-note">Set and save an archive passphrase below before creating your first backup.</p>}
      <form onSubmit={event => { event.preventDefault(); void save(); }} autoComplete="off">
        <fieldset disabled={busy || status.running}>
          <div className="gateway-backup-fields">
            <label className="gateway-backup-checkbox gateway-backup-full"><input type="checkbox" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })} /><span>Enable daily backups to the saved destination</span></label>
            <label>Daily time<input type="time" step={60} value={draft.dailyTime} onChange={event => change({ dailyTime: event.target.value })} /><small>Default 02:00 in the selected gateway time zone.</small></label>
            <label>Time zone<input value={draft.timeZoneId} spellCheck={false} onChange={event => change({ timeZoneId: event.target.value })} /><small>Use a Windows or IANA ID supported by the gateway. Current gateway: {status.gatewayTimeZoneId}.</small></label>
            <label>Keep backups for days<input type="number" min={1} max={3650} step={1} value={draft.retentionDays} onChange={event => change({ retentionDays: Number(event.target.value) })} /><small>1–3650 days. Default 7 days.</small></label>
            <label>Destination<select value={draft.kind} onChange={event => change({ kind: event.target.value as BackupDestinationKind })}><option value="smb">Network share (SMB)</option><option value="ftps">FTPS (explicit TLS)</option><option value="ftp">FTP</option></select></label>
            {draft.kind === "smb" ? <label className="gateway-backup-full">Network share folder<input value={draft.sharePath} spellCheck={false} placeholder="\\backup-server\backups\sparkstudio" onChange={event => change({ sharePath: event.target.value })} /><small>Use a UNC path, not a mapped drive. The gateway service must be able to reach the share.</small></label> : <>
              <label>FTP host<input value={draft.ftpHost} spellCheck={false} placeholder="backup.factory.local" onChange={event => change({ ftpHost: event.target.value })} /></label>
              <label>FTP port<input type="number" min={1} max={65535} step={1} value={draft.ftpPort} onChange={event => change({ ftpPort: Number(event.target.value) })} /><small>Explicit FTPS normally uses port 21, with TLS negotiated on that connection.</small></label>
              <label className="gateway-backup-full">FTP folder<input value={draft.ftpFolder} spellCheck={false} placeholder="/sparkstudio/" onChange={event => change({ ftpFolder: event.target.value })} /><small>Folder beneath the FTP account’s login directory; the leading / formats the URL and does not select the server root. Folder segments support letters, digits, periods, underscores and hyphens. {draft.kind === "ftp" ? "FTP sends destination credentials without transport encryption. Choose FTPS when the server supports it. Archive contents remain passphrase encrypted." : "The gateway validates the FTPS server certificate. Its issuing authority must be trusted by the gateway."}</small></label>
            </>}
            <label>Destination username<input value={draft.username} autoComplete="off" maxLength={256} onChange={event => change({ username: event.target.value })} /><small>{draft.kind === "smb" ? "Leave username and password unset to use the gateway service identity. LocalService installations should normally use a dedicated remote backup account." : "A username is required; choose anonymous explicitly if permitted. The account needs upload, read/download, rename, list and delete permissions."}</small></label>
            {draft.kind === "smb" && <label>Domain (optional)<input value={draft.domain} autoComplete="off" maxLength={256} onChange={event => change({ domain: event.target.value })} /></label>}
            <label>Transfer timeout (seconds)<input type="number" min={30} max={3600} step={1} value={draft.timeoutSeconds} onChange={event => change({ timeoutSeconds: Number(event.target.value) })} /><small>30–3600 seconds.</small></label>
          </div>
          <div className="gateway-backup-secret"><h4>Destination password</h4><p>{status.hasDestinationPassword ? "A password is stored. It is retained unless you replace or clear it, including when you change the destination." : "No destination password is stored."}</p>
            <div className="gateway-backup-fields">
              <label className="gateway-backup-checkbox"><input type="checkbox" checked={secrets.replaceDestinationPassword} onChange={event => secret({ replaceDestinationPassword: event.target.checked, destinationPassword: "", clearDestinationPassword: false })} /><span>{status.hasDestinationPassword ? "Replace stored password" : "Set destination password"}</span></label>
              {status.hasDestinationPassword && <label className="gateway-backup-checkbox"><input type="checkbox" checked={secrets.clearDestinationPassword} onChange={event => secret({ clearDestinationPassword: event.target.checked, replaceDestinationPassword: false, destinationPassword: "" })} /><span>Clear stored destination password</span></label>}
              {secrets.replaceDestinationPassword && <label className="gateway-backup-full">New destination password<input type="password" value={secrets.destinationPassword} autoComplete="new-password" maxLength={4096} onChange={event => secret({ destinationPassword: event.target.value })} /></label>}
            </div>
          </div>
          <div className="gateway-backup-secret"><h4>Archive passphrase</h4><p>{status.hasArchivePassphrase ? "A passphrase is stored securely for creating backups. It is never returned to this browser." : "Choose a passphrase to encrypt every archive. Daily backups remain disabled until configured."} Keep it separately from the archives; it is required to restore them.</p>
            <div className="gateway-backup-fields"><label className="gateway-backup-checkbox gateway-backup-full"><input type="checkbox" checked={secrets.replaceArchivePassphrase} onChange={event => secret({ replaceArchivePassphrase: event.target.checked, archivePassphrase: "", confirmation: "" })} /><span>{status.hasArchivePassphrase ? "Replace archive passphrase for future backups" : "Set archive passphrase"}</span></label>
              {secrets.replaceArchivePassphrase && <><label>New archive passphrase<input type="password" value={secrets.archivePassphrase} autoComplete="new-password" minLength={12} maxLength={1024} onChange={event => secret({ archivePassphrase: event.target.value })} /><small>12–1024 characters. Existing archives keep their original passphrase.</small></label><label>Confirm archive passphrase<input type="password" value={secrets.confirmation} autoComplete="new-password" maxLength={1024} onChange={event => secret({ confirmation: event.target.value })} /></label></>}
            </div>
          </div>
          <p className="gateway-backup-note">Retention runs after a verified new destination copy. It removes only archives owned by this gateway that are older than the saved retention period. Failed copies do not trigger cleanup.</p>
          {error && <p className="gateway-backup-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
          <div className="gateway-backup-actions gateway-backup-settings-actions"><button type="submit" className="button primary" disabled={!dirty || stale}>Save backup settings</button><button type="button" className="button" onClick={() => void reload(true)}>{dirty ? "Discard changes and reload" : "Reload saved settings"}</button></div>
        </fieldset>
      </form>
    </>}
  </section>;
}
