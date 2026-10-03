import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Connection } from "./types";
import { isEquipmentType } from "./deviceConnections";

interface SourceStatus {
  state: string; generation?: number; bindingRevision?: number; reason?: string | null; message?: string | null;
  nativeStatus?: string | null; lostUpdates?: number; diagnostics?: Record<string, unknown>;
}
interface SourceTransport extends SourceStatus {
  lastAcceptedAt?: string | null; acceptedValues?: number; globalMemory?: Record<string, number>;
  peakGlobalMemory?: Record<string, number>; effectiveLimits?: Record<string, number>;
}
interface Diagnostics {
  capturedAt: string; revision: number; enabled: boolean; dependencyCount: number; omittedDependencies: number; omittedValues: number;
  dependencies: { scope: string; projectId?: string; projectName?: string; id: string; name: string }[];
  values: { path: string; quality: string; dataType: string; timestamp: string; displayValue: string }[];
  subscriptions: { publishingIntervalMs: number; tagCount: number; state: string; lastNotificationAt?: string }[];
  source?: { transport: SourceTransport; state?: SourceStatus | null; acquisitionFailure?: string | null; ownership: number };
}

export default function ConnectionDiagnostics({ connection, expanded, onExpandedChange, embedded = false }: {
  connection: Connection;
  expanded: boolean;
  onExpandedChange: (value: boolean) => void;
  embedded?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<Diagnostics | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [receivedAt, setReceivedAt] = useState(0), [now, setNow] = useState(Date.now());
  const request = useRef(0), mounted = useRef(false), pending = useRef(false);
  const refresh = useCallback(async (showLoading = false) => {
    if (!mounted.current || pending.current) return;
    pending.current = true;
    const serial = ++request.current;
    if (showLoading) setBusy(true);
    try {
      const result = await api<Diagnostics>(`/connections/${encodeURIComponent(connection.id)}/diagnostics`);
      if (!mounted.current || serial !== request.current) return;
      if (result.revision !== (connection.revision ?? 0)) {
        setError("This connection changed. Reopen Connections to load its latest configuration."); return;
      }
      setSnapshot(result); setReceivedAt(Date.now()); setNow(Date.now()); setError("");
    } catch (cause) {
      if (mounted.current && serial === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (mounted.current && serial === request.current) { pending.current = false; setBusy(false); } }
  }, [connection.id, connection.revision]);
  useEffect(() => {
    mounted.current = true; void refresh(true);
    return () => { mounted.current = false; pending.current = false; request.current++; };
  }, [refresh]);
  useEffect(() => {
    if (!expanded) return;
    setNow(Date.now()); void refresh();
    const interval = window.setInterval(() => setNow(Date.now()), 5000);
    const polling = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 15_000);
    return () => { window.clearInterval(interval); window.clearInterval(polling); };
  }, [refresh, expanded]);
  const stale = Boolean(error) || now - receivedAt > 30_000;
  const tagCount = snapshot ? snapshot.values.length + snapshot.omittedValues : 0;
  const source = snapshot?.source;
  const acquisition = source?.state ?? source?.transport;
  const summary = snapshot ? [
    snapshot.dependencyCount > 0 ? `${snapshot.dependencyCount} reference${snapshot.dependencyCount === 1 ? "" : "s"}` : "",
    isEquipmentType(connection.type) && tagCount > 0 ? `${tagCount} tag${tagCount === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ") || "No saved references" : "Loading…";
  const body = <div className="connection-diagnostics-body">
    {error && <div className="inline-error connection-diagnostics-error" role="alert"><p>{error}</p><button type="button" className="button" disabled={busy} onClick={() => void refresh(true)}>Retry diagnostics</button></div>}
    {!snapshot && !error && <p role="status">Loading connection diagnostics…</p>}
    {snapshot && <>
      <p className={`connection-diagnostics-status${stale ? " is-stale" : ""}`} role="status">{snapshot.enabled ? "" : "Disabled · "}{stale ? "Last update may be outdated" : "Updated"} {new Date(snapshot.capturedAt).toLocaleTimeString()}</p>
      {source && acquisition && <><h4>Source acquisition</h4><p>{acquisition.state} · generation {acquisition.generation ?? "—"} · binding revision {acquisition.bindingRevision ?? "—"}{acquisition.reason ? ` · ${acquisition.reason}` : ""}</p>{acquisition.message && <p>{acquisition.message}</p>}{source.acquisitionFailure && <p className="inline-error" role="alert">{source.acquisitionFailure}</p>}<p className="muted">Transport {source.transport.state}. Transport health and value freshness are separate. Last accepted delivery {source.transport.lastAcceptedAt ? new Date(source.transport.lastAcceptedAt).toLocaleString() : "not received"} · {source.transport.acceptedValues ?? 0} values · {acquisition.lostUpdates ?? 0} known lost updates · {source.ownership} owned leaves.</p>{source.transport.diagnostics && <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Diagnostic</th><th>Value</th></tr></thead><tbody>{Object.entries(source.transport.diagnostics).map(([key, value]) => <tr key={key}><td>{key}</td><td style={{ overflowWrap: "anywhere" }}>{typeof value === "object" ? JSON.stringify(value) : String(value ?? "—")}</td></tr>)}</tbody></table></div>}<details><summary>Effective limits and gateway memory</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify({ limits: source.transport.effectiveLimits, globalMemory: source.transport.globalMemory, peakGlobalMemory: source.transport.peakGlobalMemory }, null, 2)}</pre></details></>}
      {snapshot.dependencies.length > 0 && <><h4>Used by</h4><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Resource</th><th>Project</th><th>Type</th></tr></thead><tbody>
        {snapshot.dependencies.map((item, index) => <tr key={`${item.scope}:${item.projectId}:${item.id}:${index}`}><td>{item.name}</td><td>{item.projectName || "Gateway"}</td><td>{item.scope}</td></tr>)}
      </tbody></table></div></>}
      {snapshot.omittedDependencies > 0 && <p>{snapshot.omittedDependencies} additional references are omitted.</p>}
      {isEquipmentType(connection.type) && <>
        {snapshot.subscriptions.length > 0 && <><h4>Subscriptions</h4><div className="connection-subscription-list">{snapshot.subscriptions.map((item, index) => <div key={index}><strong>{item.state}</strong><span>{item.tagCount} tags · {item.publishingIntervalMs} ms</span><small>Last value {item.lastNotificationAt ? new Date(item.lastNotificationAt).toLocaleString() : "not received"}</small></div>)}</div></>}
        {snapshot.values.length > 0 && <><h4>Tag values</h4>{connection.type === "opcua" && !snapshot.subscriptions.length && <p className="muted">Subscriptions are inactive.</p>}<div className="data-table-wrap"><table className="data-table"><thead><tr><th>Tag</th><th>Value</th><th>Quality</th><th>Type</th><th title="Time of the last value acquisition.">Last value</th></tr></thead><tbody>
          {snapshot.values.map(value => <tr key={value.path}><td style={{overflowWrap: "anywhere"}}>{value.path}</td><td style={{overflowWrap: "anywhere", maxWidth: 300}}>{value.displayValue}</td><td>{value.quality}</td><td>{value.dataType}</td><td>{new Date(value.timestamp).toLocaleString()}</td></tr>)}
        </tbody></table></div></>}
        {snapshot.omittedValues > 0 && <p>{snapshot.omittedValues} additional tag values are omitted.</p>}
      </>}
    </>}
    </div>;
  return embedded ? <section className="connection-diagnostics">
    <div className="connection-diagnostics-heading"><h3>Diagnostics</h3><span className="connection-diagnostics-summary">{error ? "Unavailable" : summary}</span></div>
    {body}
  </section> : <details className="connection-diagnostics" open={expanded} onToggle={event => onExpandedChange(event.currentTarget.open)}>
    <summary><strong>Diagnostics</strong><span className="connection-diagnostics-summary">{error ? "Unavailable" : summary}</span></summary>
    {body}
  </details>;
}
