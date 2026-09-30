import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import GatewayBackups from "./GatewayBackups";

interface RecoveryStatus {
  active: boolean; restartRequired: boolean; invalidMarker: boolean; revision: string | null;
  dataDirectory: string; restoredAtUtc: string | null; archiveId: string | null; sourceVersion: string | null;
  fileCount: number | null; totalBytes: number | null; coverage: string; portability: string; backupMode: string;
  scope?: string; excludedPaths?: string[]; excludedPathCount?: number;
}

export default function GatewayRecovery() {
  const [status, setStatus] = useState<RecoveryStatus | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [confirmation, setConfirmation] = useState("");
  const [connections, setConnections] = useState(false), [scripts, setScripts] = useState(false), [identity, setIdentity] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true); setError("");
    try { setStatus(await api<RecoveryStatus>("/gateway/recovery")); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  async function approve() {
    if (!status?.revision) return;
    setBusy(true); setError("");
    try {
      setStatus(await api<RecoveryStatus>("/gateway/recovery/approve", "POST", {
        revision: status.revision, confirmation, reviewedConnections: connections,
        reviewedScripts: scripts, reviewedIdentityAndDeployment: identity,
      }));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  return <section className="gateway-recovery">
    <h2>Backup and recovery</h2>
    <GatewayBackups />
    {error && <p className="gateway-error" role="alert">{error}</p>}
    <button className="button" disabled={busy} onClick={() => void refresh()}>Refresh recovery status</button>
    {status && <>
      <p role="status" className={status.active ? "gateway-stale" : "gateway-observation"}>
        {status.active ? status.restartRequired ? "Recovery reviewed. Restart the gateway to resume connections and scripts." : "Recovery mode: connections, Python scripts and operator applications are blocked. Only localhost is listening." : "Normal operation. No restored gateway is awaiting review."}
      </p>
      <details className="gateway-recovery-guide" open={!status.active}>
      <summary>Complete offline backup and restore guide</summary>
      <h3>Complete gateway data backup</h3>
      <p>An offline full-data archive includes the gateway data directory: projects, publications, scripts, assets, accounts, grants, connections, tags, keys, certificates, managed databases and audit history. External databases require their own backup.</p><p>{status.backupMode}</p>
      <p>Gateway data directory: <code>{status.dataDirectory}</code></p>
      <ol>
        <li>Stop the gateway service and confirm its process and workers have exited.</li>
        <li>Run the gateway executable with <code>--recovery backup --data-dir "DATA_DIRECTORY" --archive "BACKUP_PATH.sparkbak"</code>.</li>
        <li>Supply the archive passphrase through standard input or the environment variable named by <code>--passphrase-env</code>. Keep the passphrase separately from the archive.</li>
        <li>Verify the archive with <code>--recovery inspect --archive "BACKUP_PATH.sparkbak"</code>.</li>
      </ol>
      <h3>Restore to an isolated location</h3>
      <p>Run <code>--recovery restore --archive "BACKUP_PATH.sparkbak" --data-dir "NEW_DIRECTORY"</code> while the destination gateway is stopped. The destination must not already exist. Keep the original data until recovery is verified.</p>
      <p>Start the gateway against that directory and sign in with a restored administrator account. Use <code>--RecoveryPort 5091</code> to inspect a restored copy alongside an existing installation. Recovery always forces a localhost listener.</p>
      <p>{status.portability} Use the same companion gateway build; archive verification does not establish compatibility with other application versions.</p>
      <p>A <code>.sparkproj</code> contains one project. The configuration backups above run while the gateway is online and exclude database contents, audit history and runtime files. This offline procedure includes the complete gateway data directory. Inspect an archive’s declared coverage before restoring it. Automatic service switching is not available.</p>
      </details>
      {status.active && <section className="gateway-recovery-review">
        <h3>Review this restore</h3>
        {status.invalidMarker ? <p className="gateway-error">The recovery receipt is invalid or unreadable. Inspect this restore offline before resuming it.</p> : <>
          <p><strong>{status.scope === "configuration" ? "Configuration backup" : status.scope === "full" ? "Full data backup" : "Gateway backup"}</strong> · {status.fileCount?.toLocaleString()} files · source {status.sourceVersion?.split("+")[0]}<br /><span className="gateway-observation">Archive {status.archiveId}</span></p>
          <p>{status.coverage}</p>
          {!!status.excludedPaths?.length && <details className="gateway-recovery-exclusions"><summary>Excluded paths ({status.excludedPaths.length < (status.excludedPathCount ?? status.excludedPaths.length) ? `showing ${status.excludedPaths.length} of ${status.excludedPathCount}` : status.excludedPaths.length})</summary><ul>{status.excludedPaths.map(path => <li key={path}><code>{path}</code></li>)}</ul></details>}
          {status.restoredAtUtc && <p>Restored {new Date(status.restoredAtUtc).toLocaleString()}</p>}
          <p>Review connection destinations, published gateway jobs and access before allowing this copy to run. Prevent the original and restored gateways from both controlling the same equipment.</p>
          <label><input type="checkbox" disabled={busy || status.restartRequired} checked={connections} onChange={event => setConnections(event.target.checked)} /> I reviewed connection destinations and which gateway will be active.</label>
          <label><input type="checkbox" disabled={busy || status.restartRequired} checked={scripts} onChange={event => setScripts(event.target.checked)} /> I reviewed published gateway scripts and their external effects.</label>
          <label><input type="checkbox" disabled={busy || status.restartRequired} checked={identity} onChange={event => setIdentity(event.target.checked)} /> I reviewed accounts, protected credentials, certificates and saved deployment settings.</label>
          <label className="gateway-filter">Enter RESUME RESTORED GATEWAY<input autoComplete="off" value={confirmation} disabled={busy || status.restartRequired} onChange={event => setConfirmation(event.target.value)} /></label>
          <button className="button primary" disabled={busy || status.restartRequired || !connections || !scripts || !identity || confirmation !== "RESUME RESTORED GATEWAY"} onClick={() => void approve()}>Approve resuming after restart</button>
          <p>Approval is recorded in Audit. Connections and scripts stay blocked in this process; restart is required.</p>
        </>}
      </section>}
    </>}
  </section>;
}
