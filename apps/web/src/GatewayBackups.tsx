import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { api, apiUrl, authenticatedFetch, assertAuthResponseCurrent } from "./api";
import { backupDraftFromSaved, backupSettingsRequest, backupSecretsDirty, emptyBackupSecrets, emptyDestinationSecrets, newBackupDestination, newBackupSchedule } from "./gatewayBackupModel";
import type { BackupDraft, BackupSecretEdits, BackupStatus, BackupDestinationKind, BackupDestinationDraft, BackupSchedule, BackupDestinationSecretEdits } from "./gatewayBackupModel";
import "./gatewayBackups.css";

const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString(undefined, { timeZoneName: "short" }) : "Not yet";
const bytes = (value: number | null | undefined) => value === null || value === undefined ? "" : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
const number = (value: string) => value.trim() ? Number(value) : Number.NaN;
const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const kinds = { smb: "Network share (SMB)", ftps: "FTPS (explicit TLS)", ftp: "FTP (unencrypted)", s3: "S3 object storage" };
type Tab = "schedules" | "destinations" | "restore";
const tabFromHash = (hasRestore: boolean): Tab => hasRestore && ["#backups/restore", "#recovery"].includes(window.location?.hash) ? "restore" : window.location?.hash === "#backups/destinations" ? "destinations" : "schedules";

export default function GatewayBackups({ restoreContent }: { restoreContent?: ReactNode } = {}) {
  const [status, setStatus] = useState<BackupStatus | null>(null), [draft, setDraft] = useState<BackupDraft | null>(null);
  const [baseline, setBaseline] = useState<BackupDraft | null>(null), [revision, setRevision] = useState("");
  const [secrets, setSecrets] = useState<BackupSecretEdits>(emptyBackupSecrets);
  const [tab, setTab] = useState<Tab>(() => tabFromHash(Boolean(restoreContent)));
  const [selectedSchedule, setSelectedSchedule] = useState(""), [selectedDestination, setSelectedDestination] = useState("");
  const [search, setSearch] = useState({ schedules: "", destinations: "" }), [removing, setRemoving] = useState<"schedule" | "destination" | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [statusError, setStatusError] = useState(""), [message, setMessage] = useState("");
  const mounted = useRef(true), pending = useRef(false), serial = useRef(0);
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const accept = useCallback((next: BackupStatus, clearStatusError = true) => {
    const nextDraft = backupDraftFromSaved(next.saved, next.gatewayTimeZoneId);
    setStatus(next); setDraft(nextDraft); setBaseline(nextDraft); setRevision(next.revision);
    setSelectedSchedule(current => nextDraft.schedules.some(item => item.id === current) ? current : nextDraft.schedules[0]?.id || "");
    setSelectedDestination(current => nextDraft.destinations.some(item => item.id === current) ? current : nextDraft.destinations[0]?.id || "");
    setSecrets(emptyBackupSecrets()); if (clearStatusError) setStatusError(""); setRemoving(null);
  }, []);
  const reload = useCallback(async (reset: boolean) => {
    if (pending.current) return;
    const request = ++serial.current;
    if (reset) { pending.current = true; setBusy(true); setError(""); setMessage(""); }
    try {
      const next = await api<BackupStatus>("/gateway/backups");
      if (!mounted.current || request !== serial.current) return;
      if (reset) accept(next); else { setStatus(next); setStatusError(""); }
    } catch (reason) { if (mounted.current && request === serial.current) setStatusError(reason instanceof Error ? reason.message : "Unable to refresh backup status."); }
    finally { if (reset && request === serial.current) { pending.current = false; if (mounted.current) setBusy(false); } }
  }, [accept]);
  useEffect(() => { mounted.current = true; void reload(true); return () => { mounted.current = false; pending.current = false; serial.current++; }; }, [reload]);
  useEffect(() => { const timer = window.setInterval(() => void reload(false), status?.running ? 2000 : 30000); return () => window.clearInterval(timer); }, [reload, status?.running]);
  useEffect(() => { const changed = () => { setTab(tabFromHash(Boolean(restoreContent))); setRemoving(null); }; window.addEventListener("hashchange", changed); return () => window.removeEventListener("hashchange", changed); }, [restoreContent]);
  const chooseTab = (next: Tab) => { setTab(next); setRemoving(null); window.location.hash = `#backups/${next}`; };
  const tabs: Tab[] = ["schedules", "destinations", ...(restoreContent ? ["restore" as const] : [])];
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    chooseTab(tabs[next]); tabButtons.current[next]?.focus();
  }
  const dirty = draft !== null && (JSON.stringify(draft) !== JSON.stringify(baseline) || backupSecretsDirty(secrets));
  const stale = status !== null && revision !== "" && revision !== status.revision;
  const schedule = draft?.schedules.find(item => item.id === selectedSchedule), destination = draft?.destinations.find(item => item.id === selectedDestination);
  const scheduleState = status?.scheduleStates.find(item => item.scheduleId === selectedSchedule);
  const savedSchedule = status?.saved.schedules.find(item => item.id === selectedSchedule);
  const visibleSchedules = draft?.schedules.filter(item => `${item.name} ${draft.destinations.find(target => target.id === item.destinationId)?.name || ""}`.toLowerCase().includes(search.schedules.toLowerCase())) || [];
  const visibleDestinations = draft?.destinations.filter(item => `${item.name} ${kinds[item.kind]}`.toLowerCase().includes(search.destinations.toLowerCase())) || [];
  const scheduleCount = (destinationId: string) => draft?.schedules.filter(item => item.destinationId === destinationId).length || 0;
  const referenced = destination ? draft?.schedules.filter(item => item.destinationId === destination.id) || [] : [];
  const touch = () => { setError(""); setMessage(""); };
  const changeSchedule = (patch: Partial<BackupSchedule>) => { setDraft(current => current ? { ...current, schedules: current.schedules.map(item => item.id === selectedSchedule ? { ...item, ...patch } : item) } : current); touch(); };
  const changeDestination = (patch: Partial<BackupDestinationDraft>) => { setDraft(current => current ? { ...current, destinations: current.destinations.map(item => item.id === selectedDestination ? { ...item, ...patch } : item) } : current); touch(); };
  const secret = (patch: Partial<BackupSecretEdits>) => { setSecrets(current => ({ ...current, ...patch })); touch(); };
  const destinationSecret = (patch: Partial<BackupDestinationSecretEdits>) => { setSecrets(current => ({ ...current, destinations: { ...current.destinations, [selectedDestination]: { ...emptyDestinationSecrets(), ...current.destinations[selectedDestination], ...patch } } })); touch(); };
  async function action(run: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; serial.current++; setBusy(true); setError(""); setMessage("");
    try { await run(); } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "The backup operation failed."); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  let validation = "";
  if (draft) { try { backupSettingsRequest(revision, draft, secrets, status?.destinationSecrets, status?.hasArchivePassphrase); } catch (reason) { validation = reason instanceof Error ? reason.message : "Review the backup settings."; } }
  const locked = busy || Boolean(status?.running);
  const canSave = Boolean(dirty && !stale && !locked && !statusError && !validation);
  const canRun = Boolean(status?.hasArchivePassphrase && !status.running && !status.recoveryBlocked && !status.configurationError && !statusError && !dirty && !stale && !busy);
  function cancel() {
    if (!status || pending.current || locked || (!dirty && !stale)) return;
    accept(status, false); touch();
  }
  async function save() {
    if (!draft || !status || !canSave) return;
    await action(async () => { const next = await api<BackupStatus>("/gateway/backups", "PUT", backupSettingsRequest(revision, draft, secrets, status.destinationSecrets, status.hasArchivePassphrase)); if (mounted.current) { accept(next); setMessage("Backup schedules, destinations and encryption settings saved."); } });
  }
  const completeDestination = (id: string) => {
    const saved = status?.saved.destinations.find(item => item.id === id)?.settings, credentials = status?.destinationSecrets.find(item => item.destinationId === id);
    return Boolean(saved && (saved.kind === "s3" ? saved.bucket && saved.region && saved.accessKeyId && credentials?.hasSecretAccessKey : saved.address && (saved.kind === "smb" ? !saved.username || credentials?.hasPassword : saved.username?.toLowerCase() === "anonymous" || credentials?.hasPassword)));
  };
  async function backup(target?: { destinationId: string } | { scheduleId: string }) {
    if (!canRun) return;
    if (target && ("destinationId" in target ? !completeDestination(target.destinationId) : !completeDestination(status?.saved.schedules.find(item => item.id === target.scheduleId)?.destinationId || ""))) return;
    await action(async () => { const next = await api<BackupStatus>("/gateway/backups/run", "POST", { deliver: Boolean(target), ...target }); if (mounted.current) { setStatus(next); setMessage(target ? "Backup requested using saved settings. The result will show whether the destination copy succeeded." : "Configuration backup requested. Download the completed archive below."); } });
  }
  async function download() {
    if (!status?.downloadId) return;
    const downloadId = status.downloadId;
    await action(async () => {
      const response = await authenticatedFetch(apiUrl(`/gateway/backups/download/${encodeURIComponent(downloadId)}`));
      if (response.status !== 401) assertAuthResponseCurrent(response);
      if (!response.ok) throw new Error(`The backup download is unavailable (HTTP ${response.status}). Create a new download or refresh status.`);
      const blob = await response.blob(); assertAuthResponseCurrent(response);
      const suggested = (response.headers.get("Content-Disposition") || "").match(/filename="?([^";]+)"?/i)?.[1] || "SparkStudio-configuration.sparkbak";
      const filename = /^[A-Za-z0-9_.-]+\.sparkbak$/.test(suggested) ? suggested : "SparkStudio-configuration.sparkbak";
      const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (mounted.current) setMessage("Archive downloaded. Keep its passphrase separately and verify a restore on an isolated gateway.");
    });
  }
  function add(kind: "schedule" | "destination") {
    if (!draft || locked) return;
    const id = crypto.randomUUID();
    if (kind === "schedule") { if (draft.schedules.length >= 64) return; setDraft({ ...draft, schedules: [...draft.schedules, newBackupSchedule(id, draft.destinations[0]?.id || "", status?.gatewayTimeZoneId || "UTC")] }); setSelectedSchedule(id); setSearch(current => ({ ...current, schedules: "" })); }
    else { if (draft.destinations.length >= 32) return; setDraft({ ...draft, destinations: [...draft.destinations, newBackupDestination(id)] }); setSelectedDestination(id); setSearch(current => ({ ...current, destinations: "" })); }
    setRemoving(null); touch();
  }
  function remove() {
    if (!draft || locked) return;
    if (removing === "schedule") { const remaining = draft.schedules.filter(item => item.id !== selectedSchedule); setDraft({ ...draft, schedules: remaining }); setSelectedSchedule(remaining[0]?.id || ""); }
    else if (removing === "destination" && !referenced.length) { const remaining = draft.destinations.filter(item => item.id !== selectedDestination); setDraft({ ...draft, destinations: remaining }); setSelectedDestination(remaining[0]?.id || ""); setSecrets(current => { const next = { ...current.destinations }; delete next[selectedDestination]; return { ...current, destinations: next }; }); }
    setRemoving(null); touch();
  }
  const secretDraft = secrets.destinations[selectedDestination] || emptyDestinationSecrets();
  const secretStatus = status?.destinationSecrets.find(item => item.destinationId === selectedDestination);
  const lastRunOwner = status?.lastRun?.scheduleId ? `Schedule: ${status.saved.schedules.find(item => item.id === status.lastRun?.scheduleId)?.name || status.lastRun.scheduleId}` : status?.lastRun?.destinationId ? `Destination: ${status.saved.destinations.find(item => item.id === status.lastRun?.destinationId)?.name || status.lastRun.destinationId}` : "Local download";
  const renderSecret = (kind: "password" | "secretAccessKey" | "sessionToken", label: string, stored: boolean) => {
    const replace = kind === "password" ? "replacePassword" : kind === "secretAccessKey" ? "replaceSecretAccessKey" : "replaceSessionToken";
    const clear = kind === "password" ? "clearPassword" : kind === "secretAccessKey" ? "clearSecretAccessKey" : "clearSessionToken";
    return <div className="gateway-backup-secret" key={kind}><h4>{label}</h4><p>{stored ? "Stored securely. Leave these controls unchanged to retain it." : "No saved value. The gateway never returns destination secrets."}</p><div className="gateway-backup-fields">
      <label className="gateway-backup-checkbox"><input type="checkbox" checked={secretDraft[replace]} onChange={event => destinationSecret({ [replace]: event.target.checked, [clear]: false, [kind]: "" })} /><span>{stored ? `Replace ${label.toLowerCase()}` : `Set ${label.toLowerCase()}`}</span></label>
      {stored && <label className="gateway-backup-checkbox"><input type="checkbox" checked={secretDraft[clear]} onChange={event => destinationSecret({ [clear]: event.target.checked, [replace]: false, [kind]: "" })} /><span>Clear stored {label.toLowerCase()}</span></label>}
      {secretDraft[replace] && <label className="gateway-backup-full">New {label.toLowerCase()}<input type="password" value={secretDraft[kind]} autoComplete="new-password" maxLength={4096} onChange={event => destinationSecret({ [kind]: event.target.value })} /></label>}
    </div></div>;
  };
  // Pure render helpers share this hook owner, preserving child keys and edit lifetimes.
  function renderBackupWorkspace(draft: BackupDraft, status: BackupStatus) {
    return (<div className="gateway-backup-workspace"><section className="gateway-backup-panel gateway-backup-list-panel" aria-label={tab === "schedules" ? "Backup schedules" : "Backup destinations"}>
      <div className="gateway-backup-panel-heading"><div><h3>{tab === "schedules" ? "Schedules" : "Destinations"}</h3><p>{tab === "schedules" ? draft.schedules.length : draft.destinations.length} configured</p></div><button type="button" className="button primary" disabled={tab === "schedules" ? draft.schedules.length >= 64 : draft.destinations.length >= 32} onClick={() => add(tab === "schedules" ? "schedule" : "destination")}>{tab === "schedules" ? "Add schedule" : "Add destination"}</button></div>
      {tab === "schedules" ? <><label className="gateway-backup-search">Search schedules<input type="search" value={search.schedules} onChange={event => setSearch(current => ({ ...current, schedules: event.target.value }))} /></label><ul className="gateway-backup-list">{visibleSchedules.map(item => <li key={item.id}><button type="button" aria-label={`Edit schedule ${item.name || item.id}`} aria-pressed={item.id === selectedSchedule} onClick={() => { setSelectedSchedule(item.id); setRemoving(null); }}><strong>{item.name || "Unnamed schedule"}</strong><span>{item.enabled ? "Enabled" : "Disabled"} · {item.dailyTime} · {item.daysOfWeek?.length ? "Selected weekdays" : "Daily"}</span><small>{draft.destinations.find(target => target.id === item.destinationId)?.name || "No destination selected"}</small></button></li>)}</ul>{!visibleSchedules.length && <p className="gateway-backup-empty">{draft.schedules.length ? "No schedules match this search." : "Add a schedule to send backups automatically."}</p>}</> : <><label className="gateway-backup-search">Search destinations<input type="search" value={search.destinations} onChange={event => setSearch(current => ({ ...current, destinations: event.target.value }))} /></label><ul className="gateway-backup-list">{visibleDestinations.map(item => <li key={item.id}><button type="button" aria-label={`Edit destination ${item.name || item.id}`} aria-pressed={item.id === selectedDestination} onClick={() => { setSelectedDestination(item.id); setRemoving(null); }}><strong>{item.name || "Unnamed destination"}</strong><span>{kinds[item.kind]}</span><small>{scheduleCount(item.id)} schedule{scheduleCount(item.id) === 1 ? "" : "s"}</small></button></li>)}</ul>{!visibleDestinations.length && <p className="gateway-backup-empty">{draft.destinations.length ? "No destinations match this search." : "Add a destination for a network share, FTP server or S3 bucket."}</p>}</>}
    </section><section className="gateway-backup-panel gateway-backup-editor-panel">
        <div className="gateway-backup-panel-heading"><div><h3>{tab === "schedules" ? schedule?.name || "Schedule properties" : destination?.name || "Destination properties"}</h3><p>{tab === "schedules" ? "Timing, destination and retention" : destination ? kinds[destination.kind] : "Connection and credential settings"}</p></div>{(tab === "schedules" ? schedule : destination) && <button type="button" className="button danger" disabled={tab === "destinations" && referenced.length > 0} onClick={() => setRemoving(tab === "schedules" ? "schedule" : "destination")}>{tab === "schedules" ? "Remove schedule" : "Remove destination"}</button>}</div>
        <div className="gateway-backup-editor-body">
          {removing && <div className="gateway-backup-confirm" role="alert"><strong>Remove this {removing}?</strong><p>The change is applied only after Save backup settings. Existing archives remain unchanged.</p><div className="gateway-backup-actions"><button type="button" className="button danger" onClick={remove}>Confirm remove {removing}</button><button type="button" className="button" onClick={() => setRemoving(null)}>Keep {removing}</button></div></div>}
          {tab === "schedules" && schedule ? <><div className="gateway-backup-fields">
            <label className="gateway-backup-full">Schedule name<input value={schedule.name} maxLength={100} onChange={event => changeSchedule({ name: event.target.value })} /></label>
            <label className="gateway-backup-full">Destination<select value={schedule.destinationId} onChange={event => changeSchedule({ destinationId: event.target.value })}><option value="">Choose a destination</option>{draft.destinations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="gateway-backup-checkbox gateway-backup-full"><input type="checkbox" checked={schedule.enabled} onChange={event => changeSchedule({ enabled: event.target.checked })} /><span>Enable schedule</span></label>
            <label>Daily time<input type="time" step={60} value={schedule.dailyTime} onChange={event => changeSchedule({ dailyTime: event.target.value })} /><small>Default 02:00 in the selected time zone.</small></label>
            <label>Time zone<input value={schedule.timeZoneId} spellCheck={false} onChange={event => changeSchedule({ timeZoneId: event.target.value })} /><small>Gateway: {status.gatewayTimeZoneId}. Use a supported Windows or IANA ID.</small></label>
            <label>Repeat<select value={schedule.daysOfWeek?.length ? "weekly" : "daily"} onChange={event => changeSchedule({ daysOfWeek: event.target.value === "weekly" ? [1] : [] })}><option value="daily">Every day</option><option value="weekly">Selected weekdays</option></select></label>
            <label>Keep backups for days<input type="number" min={1} max={3650} step={1} value={Number.isFinite(schedule.retentionDays) ? schedule.retentionDays : ""} onChange={event => changeSchedule({ retentionDays: number(event.target.value) })} /><small>Default 7 days. Retention applies to this schedule's archives.</small></label>
            {Boolean(schedule.daysOfWeek?.length) && <div className="gateway-backup-weekdays gateway-backup-full" role="group" aria-label="Schedule weekdays">{weekdays.map((day, index) => <label className="gateway-backup-checkbox" key={day}><input type="checkbox" checked={schedule.daysOfWeek?.includes(index) || false} disabled={schedule.daysOfWeek?.length === 1 && schedule.daysOfWeek[0] === index} onChange={event => changeSchedule({ daysOfWeek: event.target.checked ? [...schedule.daysOfWeek || [], index].sort() : schedule.daysOfWeek?.filter(value => value !== index) })} /><span>{day}</span></label>)}</div>}
          </div><div className="gateway-backup-schedule-status"><p>Next saved run: {savedSchedule?.enabled ? date(scheduleState?.nextDueAt) : savedSchedule ? "Schedule disabled" : "Not saved"}</p><p>Last run: {date(scheduleState?.lastRun?.completedAt || scheduleState?.lastRun?.startedAt)}</p>{scheduleState?.lastRun && <p>{scheduleState.lastRun.message}</p>}<button type="button" className="button" disabled={!canRun || !completeDestination(schedule.destinationId) || !status.saved.schedules.some(item => item.id === schedule.id)} onClick={() => void backup({ scheduleId: schedule.id })}>Run saved schedule now</button><small>Runs this schedule's saved destination and retention, even when automatic runs are disabled.</small></div></> : tab === "destinations" && destination ? <>
            {referenced.length > 0 && <p className="gateway-backup-reference-note">Used by {referenced.map(item => item.name).join(", ")}. Reassign or remove these schedules before removing this destination.</p>}
            <div className="gateway-backup-fields"><label>Destination name<input value={destination.name} maxLength={100} onChange={event => changeDestination({ name: event.target.value })} /></label><label>Destination type<select value={destination.kind} onChange={event => { changeDestination({ kind: event.target.value as BackupDestinationKind, allowInsecureFtp: false }); setSecrets(current => ({ ...current, destinations: { ...current.destinations, [destination.id]: emptyDestinationSecrets() } })); }} >{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              {destination.kind === "smb" && <label className="gateway-backup-full">Network share folder<input value={destination.sharePath} spellCheck={false} placeholder="\\backup-server\backups\sparkstudio" onChange={event => changeDestination({ sharePath: event.target.value })} /><small>Use a UNC path reachable by the gateway service, not a mapped drive.</small></label>}
              {(destination.kind === "ftp" || destination.kind === "ftps") && <><label>FTP host<input value={destination.ftpHost} spellCheck={false} onChange={event => changeDestination({ ftpHost: event.target.value })} /></label><label>FTP port<input type="number" min={1} max={65535} value={Number.isFinite(destination.ftpPort) ? destination.ftpPort : ""} onChange={event => changeDestination({ ftpPort: number(event.target.value) })} /></label><label className="gateway-backup-full">FTP folder<input value={destination.ftpFolder} spellCheck={false} onChange={event => changeDestination({ ftpFolder: event.target.value })} /><small>Folder beneath the account's login directory. FTPS validates the server certificate using gateway trust.</small></label>{destination.kind === "ftp" && <label className="gateway-backup-checkbox gateway-backup-full"><input type="checkbox" checked={destination.allowInsecureFtp} onChange={event => changeDestination({ allowInsecureFtp: event.target.checked })} /><span>I accept that FTP sends destination credentials without encryption.</span></label>}</>}
              {destination.kind === "s3" ? <><label>Bucket<input value={destination.bucket} spellCheck={false} onChange={event => changeDestination({ bucket: event.target.value })} /></label><label>Region<input value={destination.region} spellCheck={false} placeholder="us-east-1" onChange={event => changeDestination({ region: event.target.value })} /></label><label className="gateway-backup-full">Key prefix<input value={destination.prefix} spellCheck={false} placeholder="sparkstudio/" onChange={event => changeDestination({ prefix: event.target.value })} /></label><label className="gateway-backup-full">Access key ID<input value={destination.accessKeyId} autoComplete="off" onChange={event => changeDestination({ accessKeyId: event.target.value })} /></label><label className="gateway-backup-full">HTTPS endpoint (optional)<input value={destination.endpoint} spellCheck={false} placeholder="https://s3.example.com" onChange={event => changeDestination({ endpoint: event.target.value })} /><small>Leave empty for AWS S3. Custom endpoints must use HTTPS without a path or query.</small></label><label className="gateway-backup-checkbox gateway-backup-full"><input type="checkbox" checked={destination.forcePathStyle} onChange={event => changeDestination({ forcePathStyle: event.target.checked })} /><span>Use path-style bucket URLs</span></label></> : <><label>Destination username<input value={destination.username} autoComplete="off" maxLength={256} onChange={event => changeDestination({ username: event.target.value })} /><small>{destination.kind === "smb" ? "Leave credentials unset to use the gateway service identity." : "Use an explicit username, including anonymous when permitted."}</small></label>{destination.kind === "smb" && <label>Domain (optional)<input value={destination.domain} autoComplete="off" maxLength={256} onChange={event => changeDestination({ domain: event.target.value })} /></label>}</>}
              <label>Transfer timeout (seconds)<input type="number" min={30} max={3600} value={Number.isFinite(destination.timeoutSeconds) ? destination.timeoutSeconds : ""} onChange={event => changeDestination({ timeoutSeconds: number(event.target.value) })} /><small>30–3600 seconds.</small></label>
            </div>{destination.kind === "s3" ? <>{renderSecret("secretAccessKey", "Secret access key", Boolean(secretStatus?.hasSecretAccessKey))}{renderSecret("sessionToken", "Session token", Boolean(secretStatus?.hasSessionToken))}</> : renderSecret("password", "Destination password", Boolean(secretStatus?.hasPassword))}
            <div className="gateway-backup-schedule-status"><button type="button" className="button" disabled={!canRun || !completeDestination(destination.id)} onClick={() => void backup({ destinationId: destination.id })}>Back up to saved destination</button><small>Uses the saved destination and seven-day retention for manual destination backups.</small></div>
          </> : <p className="gateway-backup-empty">Select an item or add one to edit its properties.</p>}
        </div>
      </section></div>);
  }

  function renderBackupPage() {
    return (<section className="gateway-backups" aria-labelledby="gateway-backups-title">
      <div className="gateway-backup-tabs" role="tablist" aria-label="Backup settings sections">{tabs.map((item, index) => <button type="button" key={item} ref={element => { tabButtons.current[index] = element; }} role="tab" id={`gateway-backup-tab-${item}`} aria-controls={`gateway-backup-panel-${item}`} aria-selected={tab === item} tabIndex={tab === item ? 0 : -1} onClick={() => chooseTab(item)} onKeyDown={event => moveTab(event, index)}>{item === "schedules" ? "Schedules" : item === "destinations" ? "Destinations" : "Restore"}</button>)}</div>
      <div className="gateway-backup-content management-page">
        <div className="gateway-backup-heading"><div><h2 id="gateway-backups-title">Backups</h2><p>Manage encrypted archives, scheduled copies and backup destinations.</p></div><div className="gateway-backup-actions"><button type="button" className="button" disabled={!canRun} onClick={() => void backup()}>Create download</button>{status?.downloadId && <button type="button" className="button" disabled={busy} onClick={() => void download()}>Download latest archive</button>}</div></div>
        {statusError && <p className="gateway-backup-error" role="alert">Status unavailable: {statusError} <button type="button" className="button small" disabled={busy} onClick={() => void reload(!draft)}>Retry</button></p>}
        {error && <p className="gateway-backup-error" role="alert">{error}</p>}{message && <p className="gateway-backup-feedback" role="status">{message}</p>}
        <div role="tabpanel" id={`gateway-backup-panel-${tab}`} aria-labelledby={`gateway-backup-tab-${tab}`} tabIndex={0}>{tab === "restore" && restoreContent ? restoreContent : !status || !draft ? <p role="status">{busy ? "Loading backup settings…" : "Backup settings are unavailable."}</p> : <>
          <dl className="gateway-backup-status"><div><dt>Current state</dt><dd>{status.running ? "Backup running" : status.recoveryBlocked ? "Recovery mode" : "Ready"}</dd></div><div><dt>Schedules</dt><dd>{status.saved.schedules.filter(item => item.enabled).length} enabled · {status.saved.schedules.length} total</dd></div><div><dt>Last run</dt><dd>{status.lastRun ? status.lastRun.status === "running" ? "In progress" : status.lastRun.status === "succeeded" ? "Succeeded" : "Failed" : "No backup yet"}{status.lastRun && <small>{date(status.lastRun.completedAt || status.lastRun.startedAt)} · {bytes(status.lastRun.bytes)}</small>}</dd></div></dl>
          {status.lastRun && <p className={status.lastRun.status === "failed" ? "gateway-backup-error" : "gateway-backup-feedback"} role="status"><strong>{lastRunOwner}</strong> · {status.lastRun.message}{status.lastRun.removedCount > 0 && <> · {status.lastRun.removedCount} expired archives removed.</>}</p>}
          {status.configurationError && <p className="gateway-backup-error" role="alert">{status.configurationError}</p>}
          {status.recoveryBlocked && <p className="gateway-stale">Backups and remote transfers are blocked in recovery mode. Finish the restore review and restart before creating a backup.</p>}
          {stale && <p className="gateway-stale">Saved backup settings changed in another session. Cancel changes to use the latest saved settings before editing or starting a backup. Your draft has been kept.</p>}
          <p className="gateway-backup-draft-status" role="status">{dirty ? "Unsaved changes. Save applies schedules, destinations and encryption together." : "All changes saved"}</p>
          <form onSubmit={event => { event.preventDefault(); void save(); }} autoComplete="off">
            <fieldset disabled={locked}>
              {renderBackupWorkspace(draft, status)}
              <section className="gateway-backup-panel gateway-backup-encryption"><div className="gateway-backup-panel-heading"><div><h3>Archive encryption</h3><p>{status.hasArchivePassphrase ? "A passphrase is stored securely and is never returned to this browser." : "Set and save a passphrase before creating backups."}</p></div></div><div className="gateway-backup-editor-body"><p className="gateway-backup-note">Keep it separately from your archives; restoring requires the passphrase used when each archive was created.</p><div className="gateway-backup-fields"><label className="gateway-backup-checkbox gateway-backup-full"><input type="checkbox" checked={secrets.replaceArchivePassphrase} onChange={event => secret({ replaceArchivePassphrase: event.target.checked, archivePassphrase: "", confirmation: "" })} /><span>{status.hasArchivePassphrase ? "Replace archive passphrase for future backups" : "Set archive passphrase"}</span></label>{secrets.replaceArchivePassphrase && <><label>New archive passphrase<input type="password" autoComplete="new-password" value={secrets.archivePassphrase} minLength={12} maxLength={1024} onChange={event => secret({ archivePassphrase: event.target.value })} /></label><label>Confirm archive passphrase<input type="password" autoComplete="new-password" value={secrets.confirmation} maxLength={1024} onChange={event => secret({ confirmation: event.target.value })} /></label></>}</div></div></section>
              {dirty && validation && <p className="gateway-backup-error" role="alert">{validation}</p>}
              <div className="gateway-backup-actions gateway-backup-settings-actions"><button type="submit" className="button primary" disabled={!canSave}>Save backup settings</button><button type="button" className="button" disabled={locked || (!dirty && !stale)} onClick={cancel}>Cancel changes</button></div>
            </fieldset>
          </form><p className="gateway-backup-note">{status.coverage} Configuration capture briefly holds configuration writes; the gateway stays running. Retention runs after a verified copy and removes only this gateway's expired archives owned by the selected schedule or manual destination.</p>
        </>}</div>
      </div>
    </section>);
  }

  return renderBackupPage();
}
