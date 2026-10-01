import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Connection } from "./types";

interface Diagnostics {
  capturedAt: string; revision: number; enabled: boolean; dependencyCount: number; omittedDependencies: number; omittedValues: number; note: string;
  dependencies: { scope: string; projectId?: string; projectName?: string; id: string; name: string }[];
  values: { path: string; quality: string; dataType: string; timestamp: string; displayValue: string }[];
  subscriptions: { publishingIntervalMs: number; tagCount: number; state: string; lastNotificationAt?: string }[];
}

export default function ConnectionDiagnostics({ connection }: { connection: Connection }) {
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
        setError("These diagnostics no longer match the selected saved connection. Select its updated configuration before relying on this status."); return;
      }
      setSnapshot(result); setReceivedAt(Date.now()); setNow(Date.now()); setError("");
    } catch (cause) {
      if (mounted.current && serial === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (mounted.current && serial === request.current) { pending.current = false; setBusy(false); } }
  }, [connection.id, connection.revision]);
  useEffect(() => {
    mounted.current = true; void refresh(true);
    const interval = window.setInterval(() => setNow(Date.now()), 5000);
    const polling = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 15_000);
    return () => { mounted.current = false; pending.current = false; request.current++; window.clearInterval(interval); window.clearInterval(polling); };
  }, [refresh]);
  const stale = Boolean(error) || now - receivedAt > 30_000;
  return <section className="browse-section" aria-label="Connection diagnostics">
    <div className="browse-section-heading"><div><h3>Dependencies and tag values</h3><p>Read-only snapshots of this connection's references and OPC UA subscription state. Diagnostics update automatically.</p></div></div>
    {error && <div className="inline-error connection-diagnostics-error" role="alert"><p>{error}</p><button type="button" className="button" disabled={busy} onClick={() => void refresh(true)}>Retry diagnostics</button></div>}
    {!snapshot && !error && <p role="status">Loading connection diagnostics…</p>}
    {snapshot && <>
      <p className={`connection-diagnostics-status${stale ? " is-stale" : ""}`} role="status">{snapshot.enabled ? "Enabled" : "Disabled"} · Revision {snapshot.revision} · <strong>{stale ? "Last snapshot may be outdated" : "Snapshot"}</strong> · {new Date(snapshot.capturedAt).toLocaleString()}</p>
      <h4>{snapshot.dependencyCount} references</h4>
      <p>{snapshot.note}</p>
      {snapshot.dependencies.length > 0 ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Scope</th><th>Project</th><th>Resource</th></tr></thead><tbody>
        {snapshot.dependencies.map((item, index) => <tr key={`${item.scope}:${item.projectId}:${item.id}:${index}`}><td>{item.scope}</td><td>{item.projectName || "Gateway"}</td><td>{item.name}</td></tr>)}
      </tbody></table></div> : <p>No gateway tag or named-query references found.</p>}
      {snapshot.omittedDependencies > 0 && <p>{snapshot.omittedDependencies} additional references are omitted.</p>}
      {connection.type === "opcua" && <>
        <h4>Subscription state</h4>
        {snapshot.subscriptions.length ? snapshot.subscriptions.map((item, index) => <p key={index}>{item.state} · {item.tagCount} tags · {item.publishingIntervalMs} ms · Last notification {item.lastNotificationAt ? new Date(item.lastNotificationAt).toLocaleString() : "not received"}</p>) : <p>No active subscription groups.</p>}
        <h4>Tag quick watch</h4><p>Source timestamps describe the last value notification, not the time of this snapshot. Unchanged values can retain an older timestamp. This watch updates automatically.</p>
        {snapshot.values.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Tag</th><th>Value</th><th>Quality</th><th>Type</th><th>Source timestamp</th></tr></thead><tbody>
          {snapshot.values.map(value => <tr key={value.path}><td style={{overflowWrap: "anywhere"}}>{value.path}</td><td style={{overflowWrap: "anywhere", maxWidth: 300}}>{value.displayValue}</td><td>{value.quality}</td><td>{value.dataType}</td><td>{new Date(value.timestamp).toLocaleString()}</td></tr>)}
        </tbody></table></div> : <p>Add OPC UA tag definitions to see their current values here.</p>}
        {snapshot.omittedValues > 0 && <p>{snapshot.omittedValues} additional tag values are omitted.</p>}
      </>}
    </>}
  </section>;
}
