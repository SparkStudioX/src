import { useEffect, useRef, useState } from "react";
import { api, displayValue, resolvePath } from "./api";
import { useComponentActivity } from "./ComponentActivity";
import { ChartGraphic } from "./ChartComponent";
import { buildChart } from "./chartModel";
import type { CanvasComponent, RuntimeParameters } from "./types";
import { alarmSamples, alarmJournalPage, historySeries, processDataPropertyError } from "./processDataModel";
import type { AlarmSample, HistorySeries } from "./processDataModel";
import "./processData.css";

export default function ProcessDataComponent({ component, parameters, preview, communicationLost, queryScope, publishedAt, readOnly, interactionLocked }: {
  component: CanvasComponent; parameters: RuntimeParameters; preview: boolean; communicationLost?: boolean;
  queryScope?: "designer" | "runtime"; publishedAt?: string; readOnly?: boolean; interactionLocked?: boolean;
}) {
  const active = useComponentActivity();
  const [rows, setRows] = useState<AlarmSample[]>([]), [series, setSeries] = useState<HistorySeries[]>([]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [truncated, setTruncated] = useState(false);
  const [ack, setAck] = useState<AlarmSample | null>(null), [refresh, setRefresh] = useState(0);
  const problem = processDataPropertyError(component), history = component.type === "historicalTrend", journal = component.type === "alarmJournalTable";
  const enabled = preview && active && !communicationLost && queryScope === "runtime" && !problem;
  const key = JSON.stringify([component.id, component.type, component.props.historyPaths, component.props.historyMinutes, component.props.historyMaxPoints, publishedAt, parameters, enabled]);
  const current = useRef(key); current.current = key;
  useEffect(() => {
    if (!enabled) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined; const abort = new AbortController();
    const load = async () => {
      setBusy(true);
      try {
        if (history) {
          const end = new Date(), start = new Date(end.getTime() - Number(component.props.historyMinutes ?? 60) * 60000);
          const result = historySeries(await api("/history/query", "POST", { paths: component.props.historyPaths!.map(path => resolvePath(path, parameters)), start: start.toISOString(), end: end.toISOString(), maxPoints: component.props.historyMaxPoints ?? 1000 }, abort.signal));
          if (!stopped) { setSeries(result.series); setTruncated(result.truncated); }
        } else {
          const response = await api(journal ? "/alarm-journal?limit=500" : "/alarms", "GET", undefined, abort.signal);
          const page = journal ? alarmJournalPage(response) : { events: alarmSamples(response), truncated: false };
          if (!stopped) { setRows(page.events); setTruncated(page.truncated); }
        }
        if (!stopped) setError("");
      } catch (reason) { if (!stopped) setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { if (!stopped) { setBusy(false); timer = setTimeout(() => void load(), history ? 10000 : 2000); } }
    };
    void load(); return () => { stopped = true; abort.abort(); clearTimeout(timer); };
  }, [key, refresh]);
  useEffect(() => { setAck(null); }, [key]);
  async function acknowledge() {
    if (!ack || !enabled || readOnly || interactionLocked || busy) return;
    const expected = key; setBusy(true);
    try { await api(`/alarms/${encodeURIComponent(ack.id)}/ack`, "POST", { eventId: ack.eventId }); if (current.current === expected) { setAck(null); setRefresh(value => value + 1); } }
    catch (reason) { if (current.current === expected) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (current.current === expected) setBusy(false); }
  }
  const visible = rows.filter(row => row.priority >= Number(component.props.alarmMinimumPriority ?? 1));
  return <section className={`process-data-component${history ? " process-data-history" : ""}`} aria-label={component.props.text || component.type}>
    <header><strong>{component.props.text || (history ? "Historical trend" : journal ? "Alarm journal" : "Alarm status")}</strong>{enabled && <button type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Refresh</button>}</header>
    {problem ? <p role="status">{problem}</p> : !preview || queryScope !== "runtime" ? <p role="status">Publish and open the operator application to read configured {history ? "tag history" : "alarms"}. Configure sources in Gateway Settings.</p> : communicationLost ? <p role="alert">Communication lost. Last received {history ? "history" : "alarm status"} may be stale.</p> : null}
    {error && <p role="alert">{error} Last received data may be stale.</p>}
    {history ? <div className={`historical-series${series.length <= 1 ? " single-series" : ""}`}>{series.map(item => {
      const config = { kind: "timeSeries" as const, xKey: "timestamp", qualityKey: "quality", series: [{ key: "value", label: item.path.slice(-128) }] };
      const model = buildChart(config, { columns: ["timestamp", "value", "quality"], rows: item.points });
      return <figure key={item.path}><figcaption>{item.path}</figcaption>{model.error ? <p role="status">{model.error}</p> : model.points.length ? <ChartGraphic config={config} model={model} /> : <p>No recorded samples in this range.</p>}{model.gaps > 0 && <small>{model.gaps} bad or unavailable samples; gaps are preserved.</small>}</figure>;
    })}{truncated && <p role="status">Results were limited. Narrow the time range to inspect omitted samples.</p>}{enabled && !busy && !series.length && !error && <p>No historical samples found. Confirm the tag history configuration.</p>}</div>
    : <div className="process-data-table"><table><thead><tr><th>Priority</th><th>Alarm</th><th>State</th><th>Quality</th><th>Value</th><th>{journal ? "Recorded" : "Active since"}</th><th>{journal ? "Actor" : "Acknowledgement"}</th></tr></thead><tbody>{visible.map((row, index) => <tr key={`${row.eventId}:${row.recordedAt ?? ""}:${index}`}><td>{row.priority}</td><td><strong>{row.name}</strong><small>{row.tagPath}</small></td><td>{journal ? row.kind : row.active ? "Active" : "Cleared"}</td><td>{row.quality}</td><td>{displayValue(row.value)}</td><td>{row.recordedAt ?? row.activeAt ?? "—"}</td><td>{journal ? row.actor || "—" : row.acknowledged ? `Acknowledged${row.acknowledgedBy ? ` · ${row.acknowledgedBy}` : ""}` : <button type="button" disabled={!enabled || busy || readOnly || interactionLocked || !row.eventId} onClick={() => setAck(row)}>Acknowledge</button>}</td></tr>)}</tbody></table>{journal && truncated && <p role="status">Incomplete journal results. The gateway reached its scan or result limit; additional matching events may be retained, including when no rows are shown.</p>}{enabled && !busy && !visible.length && !error && !(journal && truncated) && <p>No matching {journal ? "alarm events" : "alarms"}.</p>}</div>}
    {ack && <div className="alarm-ack-review" role="alertdialog" aria-label="Confirm alarm acknowledgement"><strong>Acknowledge {ack.name}?</strong><p>This records your acknowledgement of this alarm event. It does not clear the alarm condition.</p><button disabled={busy} type="button" onClick={() => setAck(null)}>Cancel</button><button disabled={busy || !enabled || readOnly || interactionLocked} type="button" onClick={() => void acknowledge()}>Confirm acknowledgement</button></div>}
  </section>;
}
