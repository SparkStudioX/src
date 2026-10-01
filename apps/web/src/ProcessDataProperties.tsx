import { RuntimePropertyRow } from "./RuntimePropertyRow";
import { useEffect, useId, useState } from "react";
import type { CanvasComponent } from "./types";
import { processDataPropertyError } from "./processDataModel";
export default function ProcessDataProperties({ component, onChange }: { component: CanvasComponent; onChange: (props: Partial<CanvasComponent["props"]>) => void }) {
  const id = useId(), [paths, setPaths] = useState((component.props.historyPaths ?? []).join("\n"));
  const [minutes, setMinutes] = useState(component.props.historyMinutes ?? 60), [points, setPoints] = useState(component.props.historyMaxPoints ?? 1000);
  const [error, setError] = useState("");
  useEffect(() => { setPaths((component.props.historyPaths ?? []).join("\n")); setMinutes(component.props.historyMinutes ?? 60); setPoints(component.props.historyMaxPoints ?? 1000); setError(""); }, [component]);
  const apply = () => { const props = { historyPaths: paths.split(/\r?\n/).map(path => path.trim()).filter(Boolean), historyMinutes: minutes, historyMaxPoints: points }; const problem = processDataPropertyError({ ...component, props: { ...component.props, ...props } }); if (problem) setError(problem); else { onChange(props); setError(""); } };
  return <div className="property-sheet-group"><h4>{component.type === "historicalTrend" ? "Tag history" : "Alarms"}</h4>
    {component.type === "historicalTrend" ? <>
      <RuntimePropertyRow target="historyPaths" label="Tag paths" id={id + "-paths"}><textarea id={id + "-paths"} rows={3} value={paths} onChange={event => setPaths(event.target.value)} placeholder="One configured tag path per line" /><small>Up to eight paths. Parameters in braces are resolved in this instance.</small></RuntimePropertyRow>
      <RuntimePropertyRow target="historyMinutes" label="Range (minutes)" id={id + "-minutes"}><input id={id + "-minutes"} type="number" min={1} max={43200} step={1} value={minutes} onChange={event => setMinutes(Number(event.target.value))} /></RuntimePropertyRow>
      <RuntimePropertyRow target="historyMaxPoints" label="Maximum samples" id={id + "-points"}><input id={id + "-points"} type="number" min={10} max={10000} step={1} value={points} onChange={event => setPoints(Number(event.target.value))} /></RuntimePropertyRow>
      <div className="property-sheet-row"><span>History configuration</span><div className="property-sheet-value"><button className="button" type="button" onClick={apply}>Apply history settings</button></div><span /></div>
    </> : <RuntimePropertyRow target="alarmMinimumPriority" label="Minimum priority" id={id + "-priority"}><select id={id + "-priority"} value={component.props.alarmMinimumPriority ?? 1} onChange={event => onChange({ alarmMinimumPriority: Number(event.target.value) })}>{[1, 2, 3, 4].map(priority => <option key={priority} value={priority}>{priority}</option>)}</select></RuntimePropertyRow>}
    {error && <p role="alert">{error}</p>}
    <small>Configure alarm definitions and history collection in Gateway Settings. These controls show recorded gateway data; charts do not fabricate history.</small>
  </div>;
}
