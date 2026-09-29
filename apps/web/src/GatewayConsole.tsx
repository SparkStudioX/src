import { useCallback, useEffect, useState } from "react";
import { api, apiUrl, authenticatedFetch, assertAuthResponseCurrent } from "./api";
import { SessionIdentity } from "./OperatorAccess";
import Icon from "./Icon";
import "./gatewayConsole.css";

interface Session { id: string; username: string; displayName: string; audience: string; createdAt: string; lastActivityAt: string; expiresAt: string }
interface Metrics { observedAt: string; uptimeSeconds: number; cpuPercent: number | null; processWorkingSetBytes: number; managedMemoryBytes: number; diskAvailableBytes: number | null; activeRequests: number; completedRequests: number; failedRequests: number; retention: string; requestWindow: { recordedAt: string; method: string; route: string; status: number; durationMs: number }[] }
interface Overview { currentSessionId: string; observedAt: string; identity: string; version: string; framework: string; platform: string; sessions: Session[]; metrics: Metrics; projects: { id: string; name: string; archived: boolean; published: boolean }[]; connections: { id: string; name: string; type: string; status: string }[]; tags: { total: number; configured: number; good: number; unavailable: number } }
const bytes = (value: number | null) => value === null ? "Unavailable" : `${(value / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 })} MiB`;
const time = (value: string) => new Date(value).toLocaleString();
const sections = [{ id: "overview", name: "Overview" }, { id: "sessions", name: "Sessions" }, { id: "diagnostics", name: "Diagnostics" }] as const;
type Section = typeof sections[number]["id"];
const sectionFromHash = (): Section => sections.find(item => `#${item.id}` === window.location.hash)?.id ?? "overview";

export default function GatewayConsole() {
  const [section, setSection] = useState<Section>(sectionFromHash);
  const [data, setData] = useState<Overview | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [query, setQuery] = useState("");
  const [pending, setPending] = useState<Session | null>(null), [revoking, setRevoking] = useState(false);
  const [now, setNow] = useState(Date.now());
  const refresh = useCallback(async () => {
    setBusy(true); setError("");
    try { setData(await api<Overview>("/gateway/overview")); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => setNow(Date.now()), 1000); const hash = () => setSection(sectionFromHash()); window.addEventListener("hashchange", hash); return () => { clearInterval(timer); window.removeEventListener("hashchange", hash); }; }, [refresh]);
  const stale = data !== null && (Boolean(error) || now - new Date(data.observedAt).getTime() > 30_000);
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
  return <div className="gateway-console">
    <header><a href="/" className="projects-brand"><span className="brand-mark"><Icon name="spark" size={24} /></span><strong>SparkStudio</strong></a><strong>Gateway</strong><a href="/">Projects</a><a href="/security">Security and audit</a><SessionIdentity /></header>
    <main><div className="gateway-heading"><div><div className="eyebrow">GATEWAY ADMINISTRATION</div><h1>{data?.identity || "Gateway console"}</h1><p>Shared resources, active sessions and process diagnostics.</p></div><button className="button" disabled={busy} onClick={() => void refresh()}>{busy ? "Refreshing…" : "Refresh status"}</button></div>
      <nav aria-label="Gateway sections">{sections.map(item => <a key={item.id} href={`#${item.id}`} aria-current={section === item.id ? "page" : undefined}>{item.name}</a>)}</nav>
      {error && <p className="gateway-error" role="alert">{error}</p>}
      {data && <p className={stale ? "gateway-stale" : "gateway-observation"} role="status">{stale ? "Stale observation — refresh before relying on this status." : "Snapshot"} · Observed {time(data.observedAt)}</p>}
      {!data ? <p>{busy ? "Loading gateway status…" : "Status unavailable. Use Refresh status to retry."}</p> : <>
        {section === "overview" && <>
          <div className="gateway-cards"><article><span>Projects</span><strong>{data.projects.filter(item => !item.archived).length}</strong><small>{data.projects.filter(item => item.archived).length} archived</small></article><article><span>Connections</span><strong>{data.connections.length}</strong><small>Saved status; not a fresh connection test</small></article><article><span>Tag values</span><strong>{data.tags.total}</strong><small>{data.tags.unavailable} unavailable · {data.tags.configured} configured</small></article><article><span>Uptime</span><strong>{Math.floor(data.metrics.uptimeSeconds / 60)} min</strong><small>Resets on gateway restart</small></article></div>
          <p>{data.version} · {data.framework} · {data.platform}</p><label>Find a resource<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Project or connection name" /></label>
          <h2>Applications</h2><div className="gateway-resource-list">{data.projects.filter(item => matching(`${item.name} ${item.id}`)).map(item => <article key={item.id}><strong>{item.name}</strong><span>{item.archived ? "Archived" : item.published ? "Published" : "Draft only"}</span>{!item.archived && <><a href={`/designer/${item.id}`}>Designer</a>{item.published && <a href={`/runtime/${item.id}`}>Operator application</a>}</>}</article>)}</div>
          <h2>Connections</h2>{data.connections.length === 0 ? <p>No connections configured.</p> : <div className="gateway-resource-list">{data.connections.filter(item => matching(`${item.name} ${item.type}`)).map(item => <article key={item.id}><strong>{item.name}</strong><span>{item.type}</span><span>{item.status}</span></article>)}</div>}
        </>}
        {section === "sessions" && <><h2>Active sign-ins</h2><p>Engineering and operator sign-ins are separate. These are authenticated sessions, not a count of browser tabs. Project grants remain in Security.</p><div className="gateway-table"><table><thead><tr><th>User</th><th>Audience</th><th>Signed in</th><th>Last activity</th><th>Expires</th><th>Action</th></tr></thead><tbody>{data.sessions.map(session => <tr key={session.id}><td>{session.displayName} ({session.username}){session.id === data.currentSessionId ? " · This session" : ""}</td><td>{session.audience}</td><td>{time(session.createdAt)}</td><td>{time(session.lastActivityAt)}</td><td>{time(session.expiresAt)}</td><td><button className="button" onClick={() => setPending(session)}>Revoke session</button></td></tr>)}</tbody></table></div>{!data.sessions.length && <p>No active sessions in this snapshot.</p>}
          {pending && <section className="gateway-confirm" role="region" aria-label="Confirm session revocation"><strong>Revoke {pending.username}'s {pending.audience} session?</strong><p>The next authenticated request will require sign-in again. Revoking your current session signs you out.</p><button className="button" disabled={revoking} onClick={() => setPending(null)}>Cancel</button><button className="button primary" disabled={revoking} onClick={() => void revoke()}>{revoking ? "Revoking…" : "Confirm revocation"}</button></section>}
        </>}
        {section === "diagnostics" && <><h2>Process and API observations</h2><div className="gateway-cards"><article><span>Process memory</span><strong>{bytes(data.metrics.processWorkingSetBytes)}</strong><small>Managed heap {bytes(data.metrics.managedMemoryBytes)}</small></article><article><span>CPU</span><strong>{data.metrics.cpuPercent === null ? "Not sampled" : `${data.metrics.cpuPercent.toFixed(1)}%`}</strong><small>Process CPU / logical processors since prior sample</small></article><article><span>Available disk</span><strong>{bytes(data.metrics.diskAvailableBytes)}</strong><small>Volume containing gateway data</small></article><article><span>API requests</span><strong>{data.metrics.completedRequests}</strong><small>{data.metrics.failedRequests} returned errors · {data.metrics.activeRequests} active (includes streams)</small></article></div>
          <p>{data.metrics.retention} Request paths are route templates; request values and bodies are excluded.</p><button className="button" disabled={busy} onClick={() => void download()}>Download support snapshot</button><p>The JSON snapshot contains process metrics and resource counts. It excludes credentials, identities, configuration values, tag values, scripts and keys.</p>
          <label>Filter request routes<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Route, status or method" /></label><div className="gateway-table"><table><thead><tr><th>Observed</th><th>Method</th><th>Route</th><th>Status</th><th>Duration</th></tr></thead><tbody>{data.metrics.requestWindow.filter(item => matching(`${item.route} ${item.method} ${item.status}`)).map((item, index) => <tr key={index}><td>{time(item.recordedAt)}</td><td>{item.method}</td><td><code>{item.route}</code></td><td>{item.status}</td><td>{item.durationMs.toFixed(1)} ms</td></tr>)}</tbody></table></div>
        </>}
      </>}
    </main>
  </div>;
}
