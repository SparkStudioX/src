import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

interface RecoveryStatus {
  active: boolean; restartRequired: boolean; invalidMarker: boolean; revision: string | null;
  dataDirectory: string; restoredAtUtc: string | null; archiveId: string | null; sourceVersion: string | null;
  fileCount: number | null; totalBytes: number | null; coverage: string; portability: string; backupMode: string;
  scope?: string; excludedPaths?: string[]; excludedPathCount?: number;
}

export default function GatewayRecovery() {
  const [status, setStatus] = useState<RecoveryStatus | null>(null), [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [busy, setBusy] = useState(false), [confirmation, setConfirmation] = useState("");
  const [connections, setConnections] = useState(false), [scripts, setScripts] = useState(false), [identity, setIdentity] = useState(false);
  const serial = useRef(0), mounted = useRef(false), pending = useRef(false), approving = useRef(false);
  const readController = useRef<AbortController | null>(null), reviewRevision = useRef<string | null>(null);
  const accept = useCallback((next: RecoveryStatus) => {
    if (reviewRevision.current !== next.revision) { setConnections(false); setScripts(false); setIdentity(false); setConfirmation(""); }
    reviewRevision.current = next.revision;
    setStatus(next);
  }, []);
  const refresh = useCallback(async (showLoading = false) => {
    if (!mounted.current || pending.current) return;
    pending.current = true;
    const request = ++serial.current, controller = new AbortController();
    readController.current = controller;
    if (showLoading) setBusy(true);
    try {
      const next = await api<RecoveryStatus>("/gateway/recovery", "GET", undefined, controller.signal);
      if (mounted.current && request === serial.current) { accept(next); setStatusError(""); }
    } catch (failure) { if (mounted.current && request === serial.current) setStatusError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (mounted.current && request === serial.current) { pending.current = false; readController.current = null; setBusy(false); } }
  }, [accept]);
  useEffect(() => {
    mounted.current = true; void refresh(true);
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { mounted.current = false; pending.current = false; approving.current = false; serial.current++; readController.current?.abort(); window.clearInterval(timer); };
  }, [refresh]);
  async function approve() {
    if (!mounted.current || approving.current || busy || !status?.revision || status.restartRequired || !connections || !scripts || !identity || confirmation !== "RESUME RESTORED GATEWAY") return;
    approving.current = true;
    readController.current?.abort(); readController.current = null;
    const request = ++serial.current;
    pending.current = true; setBusy(true); setError("");
    try {
      const next = await api<RecoveryStatus>("/gateway/recovery/approve", "POST", {
        revision: status.revision, confirmation, reviewedConnections: connections,
        reviewedScripts: scripts, reviewedIdentityAndDeployment: identity,
      });
      if (mounted.current && request === serial.current) accept(next);
    } catch (failure) { if (mounted.current && request === serial.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (mounted.current && request === serial.current) { pending.current = false; approving.current = false; setBusy(false); } }
  }
  return <section className="gateway-recovery" aria-labelledby="gateway-recovery-title">
    <div className="gateway-recovery-heading"><div><h3 id="gateway-recovery-title">Restore and recovery</h3>
      <p>Restore archives into a new isolated directory, then review the restored gateway before resuming operation. Recovery status updates automatically.</p></div>
    </div>
    {error && <p className="gateway-error" role="alert">{error}</p>}
    {statusError && <div className="gateway-error gateway-recovery-error" role="alert"><p>{statusError}</p><button type="button" className="button" disabled={busy} onClick={() => void refresh(true)}>Retry recovery status</button></div>}
    {!status && !statusError && <p className="gateway-recovery-status" role="status">Loading recovery status…</p>}
    {status && <>
      <p role="status" className={`gateway-recovery-status ${status.active ? "gateway-stale" : "gateway-observation"}`}>
        {status.active ? status.restartRequired ? "Recovery reviewed. Restart the gateway to resume connections and scripts." : "Recovery mode: connections, Python scripts and operator applications are blocked. Only localhost is listening." : "Normal operation. No restored gateway is awaiting review."}
      </p>
      <details className="gateway-recovery-guide">
      <summary>Complete offline backup and restore guide</summary>
      <section className="gateway-recovery-guide-body" aria-labelledby="gateway-full-backup-title"><h4 id="gateway-full-backup-title">Complete gateway data backup</h4>
      <p>An offline full-data archive includes the gateway data directory: projects, publications, scripts, assets, accounts, grants, connections, tags, keys, certificates, managed databases and audit history. External databases require their own backup.</p><p>{status.backupMode}</p>
      <p>Gateway data directory: <code>{status.dataDirectory}</code></p>
      <ol>
        <li>Stop the gateway service and confirm its process and workers have exited.</li>
        <li>Run the gateway executable with <code>--recovery backup --data-dir "DATA_DIRECTORY" --archive "BACKUP_PATH.sparkbak"</code>.</li>
        <li>Supply the archive passphrase through standard input or the environment variable named by <code>--passphrase-env</code>. Keep the passphrase separately from the archive.</li>
        <li>Verify the archive with <code>--recovery inspect --archive "BACKUP_PATH.sparkbak"</code>.</li>
      </ol>
      </section>
      <section className="gateway-recovery-guide-body" aria-labelledby="gateway-isolated-restore-title"><h4 id="gateway-isolated-restore-title">Restore to an isolated location</h4>
      <p>Run <code>--recovery restore --archive "BACKUP_PATH.sparkbak" --data-dir "NEW_DIRECTORY"</code> while the destination gateway is stopped. The destination must not already exist. Keep the original data until recovery is verified.</p>
      <p>Start the gateway against that directory and sign in with a restored administrator account. Use <code>--RecoveryPort 5091</code> to inspect a restored copy alongside an existing installation. Recovery always forces a localhost listener.</p>
      <p>{status.portability} Use the same companion gateway build; archive verification does not establish compatibility with other application versions.</p>
      <p>A <code>.sparkproj</code> contains one project. Configuration backups run while the gateway is online and exclude database contents, audit history and runtime files. This offline procedure includes the complete gateway data directory. Inspect an archive’s declared coverage before restoring it. Automatic service switching is not available.</p>
      </section>
      </details>
      {status.active && <section className="gateway-recovery-review" aria-labelledby="gateway-restore-review-title">
        <div className="gateway-recovery-panel-heading"><h3 id="gateway-restore-review-title">Review this restore</h3><p>Verify the restored configuration before permitting external effects.</p></div>
        <div className="gateway-recovery-panel-body">
        {status.invalidMarker ? <p className="gateway-error">The recovery receipt is invalid or unreadable. Inspect this restore offline before resuming it.</p> : <>
          <dl className="gateway-recovery-receipt"><div><dt>Archive coverage</dt><dd>{status.scope === "configuration" ? "Configuration backup" : status.scope === "full" ? "Full data backup" : "Gateway backup"}</dd></div><div><dt>Files</dt><dd>{status.fileCount?.toLocaleString()}</dd></div><div><dt>Source version</dt><dd>{status.sourceVersion?.split("+")[0]}</dd></div><div className="gateway-recovery-receipt-wide"><dt>Archive ID</dt><dd><code>{status.archiveId}</code></dd></div></dl>
          <p>{status.coverage}</p>
          {!!status.excludedPaths?.length && <details className="gateway-recovery-exclusions"><summary>Excluded paths ({status.excludedPaths.length < (status.excludedPathCount ?? status.excludedPaths.length) ? `showing ${status.excludedPaths.length} of ${status.excludedPathCount}` : status.excludedPaths.length})</summary><ul>{status.excludedPaths.map(path => <li key={path}><code>{path}</code></li>)}</ul></details>}
          {status.restoredAtUtc && <p>Restored {new Date(status.restoredAtUtc).toLocaleString()}</p>}
          <p>Review connection destinations, published gateway jobs and access before allowing this copy to run. Prevent the original and restored gateways from both controlling the same equipment.</p>
          <div className="gateway-recovery-checks"><label><input type="checkbox" disabled={busy || status.restartRequired} checked={connections} onChange={event => setConnections(event.target.checked)} /><span>I reviewed connection destinations and which gateway will be active.</span></label>
          <label><input type="checkbox" disabled={busy || status.restartRequired} checked={scripts} onChange={event => setScripts(event.target.checked)} /><span>I reviewed published gateway scripts and their external effects.</span></label>
          <label><input type="checkbox" disabled={busy || status.restartRequired} checked={identity} onChange={event => setIdentity(event.target.checked)} /><span>I reviewed accounts, protected credentials, certificates and saved deployment settings.</span></label></div>
          <label className="gateway-filter">Enter RESUME RESTORED GATEWAY<input autoComplete="off" value={confirmation} disabled={busy || status.restartRequired} onChange={event => setConfirmation(event.target.value)} /></label>
          <button className="button primary" disabled={busy || status.restartRequired || !connections || !scripts || !identity || confirmation !== "RESUME RESTORED GATEWAY"} onClick={() => void approve()}>Approve resuming after restart</button>
          <p>Approval is recorded in Audit. Connections and scripts stay blocked in this process; restart is required.</p>
        </>}
        </div>
      </section>}
    </>}
  </section>;
}
