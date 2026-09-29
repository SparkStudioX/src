import { useEffect, useRef, useState } from "react";
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
  const request = useRef(0);
  const refresh = async () => {
    const serial = ++request.current;
    setBusy(true); setError("");
    try {
      const result = await api<Diagnostics>(`/connections/${encodeURIComponent(connection.id)}/diagnostics`);
      if (serial !== request.current) return;
      if (result.revision !== (connection.revision ?? 0)) {
        setSnapshot(null); setError("The saved connection changed. Reload its configuration before refreshing diagnostics."); return;
      }
      setSnapshot(result); setReceivedAt(Date.now()); setNow(Date.now());
    } catch (cause) {
      if (serial === request.current) { setSnapshot(null); setError(cause instanceof Error ? cause.message : String(cause)); }
    } finally { if (serial === request.current) setBusy(false); }
  };
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => setNow(Date.now()), 5000);
    return () => { request.current++; window.clearInterval(interval); };
    // The parent remounts this panel for every selected ID or saved revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <section className="browse-section" aria-label="Connection diagnostics">
    <div className="browse-section-heading"><div><h3>Dependencies and tag values</h3><p>Read-only snapshots of this connection's references and OPC UA subscription state.</p></div>
      <button className="button" disabled={busy} onClick={() => void refresh()}>{busy ? "Refreshing…" : "Refresh diagnostics"}</button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {snapshot && <>
      <p>{snapshot.enabled ? "Enabled" : "Disabled"} · Revision {snapshot.revision} · {now - receivedAt > 30000 ? "Stale snapshot — refresh to update" : "Snapshot"} · {new Date(snapshot.capturedAt).toLocaleString()}</p>
      <h4>{snapshot.dependencyCount} references</h4>
      <p>{snapshot.note}</p>
      {snapshot.dependencies.length > 0 ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Scope</th><th>Project</th><th>Resource</th></tr></thead><tbody>
        {snapshot.dependencies.map((item, index) => <tr key={`${item.scope}:${item.projectId}:${item.id}:${index}`}><td>{item.scope}</td><td>{item.projectName || "Gateway"}</td><td>{item.name}</td></tr>)}
      </tbody></table></div> : <p>No gateway tag or named-query references found.</p>}
      {snapshot.omittedDependencies > 0 && <p>{snapshot.omittedDependencies} additional references are omitted.</p>}
      {connection.type === "opcua" && <>
        <h4>Subscription state</h4>
        {snapshot.subscriptions.length ? snapshot.subscriptions.map((item, index) => <p key={index}>{item.state} · {item.tagCount} tags · {item.publishingIntervalMs} ms · Last notification {item.lastNotificationAt ? new Date(item.lastNotificationAt).toLocaleString() : "not received"}</p>) : <p>No active subscription groups.</p>}
        <h4>Tag quick watch</h4><p>Source timestamps describe the last value notification, not the time of this snapshot. Unchanged values can retain an older timestamp. Refresh to see new data.</p>
        {snapshot.values.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Tag</th><th>Value</th><th>Quality</th><th>Type</th><th>Source timestamp</th></tr></thead><tbody>
          {snapshot.values.map(value => <tr key={value.path}><td style={{overflowWrap: "anywhere"}}>{value.path}</td><td style={{overflowWrap: "anywhere", maxWidth: 300}}>{value.displayValue}</td><td>{value.quality}</td><td>{value.dataType}</td><td>{new Date(value.timestamp).toLocaleString()}</td></tr>)}
        </tbody></table></div> : <p>Add OPC UA tag definitions to see their current values here.</p>}
        {snapshot.omittedValues > 0 && <p>{snapshot.omittedValues} additional tag values are omitted.</p>}
      </>}
    </>}
  </section>;
}
