import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiUrl, authenticatedFetch, assertAuthResponseCurrent } from "./api";
import WorkspaceHeader from "./WorkspaceHeader";
import Security from "./Security";
import GatewayDeployment from "./GatewayDeployment";
import GatewayRecovery from "./GatewayRecovery";
import GatewayBackups from "./GatewayBackups";
import GatewayConfiguration from "./GatewayConfiguration";
import GatewayProcessData from "./GatewayProcessData";
import { useAuth } from "./Auth";
import "./gatewayConsole.css";

interface Session { id: string; username: string; displayName: string; audience: string; createdAt: string; lastActivityAt: string; expiresAt: string }
interface Metrics { observedAt: string; uptimeSeconds: number; cpuPercent: number | null; processWorkingSetBytes: number; managedMemoryBytes: number; diskAvailableBytes: number | null; activeRequests: number; completedRequests: number; failedRequests: number; retention: string; requestWindow: { recordedAt: string; method: string; route: string; status: number; durationMs: number }[] }
interface Overview { recoveryMode: boolean; currentSessionId: string; observedAt: string; identity: string; version: string; framework: string; platform: string; sessions: Session[]; metrics: Metrics | null; projects: { id: string; name: string; archived: boolean; published: boolean }[]; connections: { id: string; name: string; type: string; status: string }[]; tags: { total: number; configured: number; good: number; unavailable: number } }
const bytes = (value: number | null) => value === null ? "Unavailable" : `${(value / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 })} MiB`;
const time = (value: string) => new Date(value).toLocaleString();
const sections = [{ id: "overview", name: "Overview" }, { id: "configuration", name: "Configuration" }, { id: "alarms", name: "Alarms" }, { id: "history", name: "History" }, { id: "deployment", name: "Deployment" }, { id: "backups", name: "Backups" }, { id: "sessions", name: "Sessions" }, { id: "diagnostics", name: "Diagnostics" }, { id: "security", name: "Security" }, { id: "audit", name: "Audit" }] as const;
type Section = typeof sections[number]["id"];
const sectionFromHash = (): Section => window.location.hash === "#process-data" ? "alarms" : window.location.hash === "#recovery" || window.location.hash.startsWith("#backups/") ? "backups" : sections.find(item => `#${item.id}` === window.location.hash)?.id ?? "overview";

export default function GatewayConsole() {
  const { gatewayAdmin, gatewayCapabilities } = useAuth();
  const allowed = (id: Section) => gatewayAdmin || (id === "overview" ? gatewayCapabilities.diagnostics || gatewayCapabilities.configuration : id === "deployment" || id === "configuration" || id === "alarms" || id === "history" ? gatewayCapabilities.configuration : id === "security" ? false : gatewayCapabilities[id]);
  const visibleSections = sections.filter(item => allowed(item.id));
  const [requestedSection, setSection] = useState<Section>(sectionFromHash);
  const section = allowed(requestedSection) ? requestedSection : visibleSections[0]?.id ?? "overview";
  const [data, setData] = useState<Overview | null>(null), [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [busy, setBusy] = useState(false), [query, setQuery] = useState("");
  const [pending, setPending] = useState<Session | null>(null), [revoking, setRevoking] = useState(false);
  const [now, setNow] = useState(Date.now());
  const refreshSerial = useRef(0), refreshPending = useRef(false);
  const refresh = useCallback(async (quiet = false) => {
    if (quiet && refreshPending.current) return;
    const run = ++refreshSerial.current;
    refreshPending.current = true;
    if (!quiet) setBusy(true);
    try {
      const next = await api<Overview>("/gateway/overview");
      if (run === refreshSerial.current) { setData(next); setStatusError(""); }
    }
    catch (failure) { if (run === refreshSerial.current) setStatusError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (run === refreshSerial.current) { refreshPending.current = false; if (!quiet) setBusy(false); } }
  }, []);
  useEffect(() => { const hash = () => setSection(sectionFromHash()); window.addEventListener("hashchange", hash); return () => window.removeEventListener("hashchange", hash); }, []);
  useEffect(() => {
    void refresh();
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const polling = section === "overview" || section === "sessions" || section === "diagnostics"
      ? window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(true); }, 15_000) : undefined;
    return () => { refreshSerial.current++; refreshPending.current = false; window.clearInterval(clock); if (polling !== undefined) window.clearInterval(polling); };
  }, [refresh, section]);
  const stale = data !== null && (Boolean(statusError) || now - new Date(data.observedAt).getTime() > 30_000);
  async function revoke() {
    if (!pending) return; setRevoking(true); setError("");
    try { await api(`/gateway/sessions/${pending.id}/revoke`, "POST", {}); setPending(null); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setRevoking(false); }
  }
  async function download() {
    setBusy(true); setError("");
    try {
      const response = await authenticatedFetch(apiUrl("/gateway/support-snapshot"));
      assertAuthResponseCurrent(response);
      if (!response.ok) throw new Error(`Support snapshot unavailable (${response.status}).`);
      const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = "sparkstudio-support-snapshot.json"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  const matching = (text: string) => text.toLowerCase().includes(query.toLowerCase());
  const securitySection = section === "security" || section === "audit";
  const statusTitle = section === "sessions" ? "Sessions" : section === "diagnostics" ? "Diagnostics" : "Overview";
  const statusDescription = section === "sessions"
    ? "Review engineering and operator sign-ins and revoke a session when access should end."
    : section === "diagnostics"
      ? "Inspect process health and recent API requests, or download a support snapshot."
      : "Review the running gateway and its shared resources at a glance.";
  return <div className="gateway-console">
    <WorkspaceHeader page="gateway" />
    <main><div className="gateway-heading"><div><h1>{data?.identity || "Gateway Settings"}</h1><p>Shared resources, deployment, active sessions, security and diagnostics.</p></div></div>
      {data?.recoveryMode && <p className="gateway-stale" role="status">This restored gateway is isolated. Connections, Python and operator applications are blocked. {gatewayAdmin && <a href="#backups/restore">Review recovery</a>}</p>}
      <nav aria-label="Gateway sections">{visibleSections.map(item => <a key={item.id} href={`#${item.id}`} aria-current={section === item.id ? "page" : undefined}>{item.name}</a>)}</nav>
      {securitySection ? <Security key={section} section={section} /> : section === "deployment" ? <GatewayDeployment /> : section === "configuration" ? <GatewayConfiguration /> : section === "alarms" || section === "history" ? <GatewayProcessData section={section} onSectionChange={next => { window.location.hash = `#${next}`; }} /> : section === "backups" ? <GatewayBackups restoreContent={gatewayAdmin ? <GatewayRecovery /> : undefined} /> : <section className="gateway-status-page management-page" aria-labelledby="gateway-status-title">
      <div className="gateway-section-heading"><div><h2 id="gateway-status-title">{statusTitle}</h2><p>{statusDescription}</p></div></div>
      {error && <p className="gateway-error" role="alert">{error}</p>}
      {statusError && <p className="gateway-error" role="alert">{statusError} <button type="button" className="button" disabled={busy} onClick={() => void refresh()}>Retry</button></p>}
      {data && <p className={`gateway-status-strip ${stale ? "gateway-stale" : "gateway-observation"}`} role="status">{stale ? "Stale observation — refresh before relying on this status." : "Snapshot"} · Observed <time dateTime={data.observedAt}>{time(data.observedAt)}</time></p>}
      {!data ? <div className="gateway-panel gateway-empty" role="status">{busy ? "Loading gateway status…" : "Gateway status is unavailable."}</div> : <>
        {section === "overview" && <>
          <div className="gateway-cards"><article><span>Projects</span><strong>{data.projects.filter(item => !item.archived).length}</strong><small>{data.projects.filter(item => item.archived).length} archived</small></article><article><span>Connections</span><strong>{data.connections.length}</strong><small>Saved status; not a fresh connection test</small></article><article><span>Tag values</span><strong>{data.tags.total}</strong><small>{data.tags.unavailable} unavailable · {data.tags.configured} configured</small></article>{data.metrics && <article><span>Uptime</span><strong>{Math.floor(data.metrics.uptimeSeconds / 60)} min</strong><small>Resets on gateway restart</small></article>}</div>
          <section className="gateway-panel" aria-labelledby="gateway-identity-title"><div className="gateway-panel-heading"><div><h3 id="gateway-identity-title">Running gateway</h3><p>Version and host information for this process.</p></div></div><dl className="gateway-detail-grid"><div><dt>Version</dt><dd>{data.version}</dd></div><div><dt>Framework</dt><dd>{data.framework}</dd></div><div><dt>Platform</dt><dd>{data.platform}</dd></div></dl></section>
        </>}
        {section === "sessions" && <><section className="gateway-panel" aria-labelledby="gateway-sessions-title"><div className="gateway-panel-heading"><div><h3 id="gateway-sessions-title">Active sign-ins</h3><p>Engineering and operator sign-ins are separate. Sessions count sign-ins, not browser tabs.</p></div><span className="gateway-panel-count">{data.sessions.length} active</span></div><div className="gateway-table"><table><thead><tr><th>User</th><th>Audience</th><th>Signed in</th><th>Last activity</th><th>Expires</th><th>Action</th></tr></thead><tbody>{data.sessions.map(session => <tr key={session.id}><td><strong>{session.displayName}</strong><small>{session.username}{session.id === data.currentSessionId ? " · This session" : ""}</small></td><td><span className="gateway-badge">{session.audience}</span></td><td>{time(session.createdAt)}</td><td>{time(session.lastActivityAt)}</td><td>{time(session.expiresAt)}</td><td><button className="button" onClick={() => setPending(session)}>Revoke session</button></td></tr>)}</tbody></table></div>{!data.sessions.length && <div className="gateway-empty">No active sessions in this snapshot.</div>}<p className="gateway-panel-note">Manage project grants in <a href="#security">Security</a>.</p></section>
          {pending && <section className="gateway-panel gateway-confirm" role="region" aria-label="Confirm session revocation"><div className="gateway-panel-heading"><div><h3>Revoke {pending.username}'s {pending.audience} session?</h3><p>The next authenticated request will require sign-in again. Revoking your current session signs you out.</p></div></div><div className="gateway-panel-body gateway-section-actions"><button className="button" disabled={revoking} onClick={() => setPending(null)}>Cancel</button><button className="button primary" disabled={revoking} onClick={() => void revoke()}>{revoking ? "Revoking…" : "Confirm revocation"}</button></div></section>}
        </>}
        {section === "diagnostics" && (data.metrics ? <><div className="gateway-cards"><article><span>Process memory</span><strong>{bytes(data.metrics.processWorkingSetBytes)}</strong><small>Managed heap {bytes(data.metrics.managedMemoryBytes)}</small></article><article><span>CPU</span><strong>{data.metrics.cpuPercent === null ? "Not sampled" : `${data.metrics.cpuPercent.toFixed(1)}%`}</strong><small>Process CPU / logical processors since prior sample</small></article><article><span>Available disk</span><strong>{bytes(data.metrics.diskAvailableBytes)}</strong><small>Volume containing gateway data</small></article><article><span>API requests</span><strong>{data.metrics.completedRequests}</strong><small>{data.metrics.failedRequests} returned errors · {data.metrics.activeRequests} active (includes streams)</small></article></div>
          <section className="gateway-panel gateway-support" aria-labelledby="gateway-support-title"><div className="gateway-panel-heading"><div><h3 id="gateway-support-title">Support snapshot</h3><p>Download process metrics and resource counts as JSON.</p></div><button className="button" disabled={busy} onClick={() => void download()}>Download support snapshot</button></div><p className="gateway-panel-note">The snapshot excludes credentials, identities, configuration values, tag values, scripts and keys.</p></section>
          <section className="gateway-panel" aria-labelledby="gateway-requests-title"><div className="gateway-panel-heading"><div><h3 id="gateway-requests-title">Recent API requests</h3><p>{data.metrics.retention} Paths are route templates; request values and bodies are excluded.</p></div></div><label className="gateway-filter">Filter request routes<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Route, status or method" /></label><div className="gateway-table"><table><thead><tr><th>Observed</th><th>Method</th><th>Route</th><th>Status</th><th>Duration</th></tr></thead><tbody>{data.metrics.requestWindow.filter(item => matching(`${item.route} ${item.method} ${item.status}`)).map((item, index) => <tr key={index}><td>{time(item.recordedAt)}</td><td>{item.method}</td><td><code>{item.route}</code></td><td><span className="gateway-badge">{item.status}</span></td><td>{item.durationMs.toFixed(1)} ms</td></tr>)}</tbody></table></div>{!data.metrics.requestWindow.some(item => matching(`${item.route} ${item.method} ${item.status}`)) && <div className="gateway-empty">{data.metrics.requestWindow.length ? "No requests match this filter." : "No recent requests in this snapshot."}</div>}</section>
        </> : <div className="gateway-panel gateway-empty" role="status">Process metrics are unavailable in this snapshot. Status updates automatically.</div>)}
      </>}
      </section>}
    </main>
  </div>;
}
