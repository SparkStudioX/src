import { RuntimePropertyRow } from "./RuntimePropertyRow";
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import type { CanvasComponent } from "./types";
import { buildChart, chartDefinitionError, chartKinds, defaultChartProps } from "./chartModel";
import { validateDataset } from "./datasets";
import type { ChartDefinition } from "./chartModel";

function ChartRow({ name, label, id, children }: { name: string; label: string; id?: string; children: ReactNode }) {
  return <RuntimePropertyRow target={name === "data" ? "data" : `chart.${name}`} label={label} id={id}>{children}</RuntimePropertyRow>;
}

export default function ChartProperties({ component, onChange }: { component: CanvasComponent; onChange: (props: Partial<CanvasComponent["props"]>) => void }) {
  const id = useId();
  const defaults = defaultChartProps(component.type === "sparkline");
  const [draft, setDraft] = useState<ChartDefinition>(component.props.chart ?? defaults.chart!);
  const [seriesText, setSeriesText] = useState(JSON.stringify(draft.series, null, 2));
  const [dataText, setDataText] = useState(JSON.stringify(component.props.data ?? defaults.data, null, 2));
  const [error, setError] = useState("");
  function resetDraft() { const config = component.props.chart ?? defaults.chart!; setDraft(config); setSeriesText(JSON.stringify(config.series, null, 2)); setDataText(JSON.stringify(component.props.data ?? defaults.data, null, 2)); setError(""); }
  useEffect(() => { resetDraft(); }, [component.id, component.props.chart, component.props.data]);
  function apply() {
    try {
      const config = { ...draft, series: JSON.parse(seriesText) } as ChartDefinition;
      const invalid = chartDefinitionError(config);
      if (invalid) throw new Error(invalid);
      const data = validateDataset(JSON.parse(dataText));
      if (!component.props.dataSource) { const model = buildChart(config, data); if (model.error) throw new Error(model.error); }
      onChange({ chart: config, data }); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Invalid chart configuration."); }
  }
  return <div className="property-sheet-group chart-properties"><h4>Chart</h4>
    <ChartRow name="kind" label="Chart type" id={id + "-kind"}><select id={id + "-kind"} value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as ChartDefinition["kind"] })}>{chartKinds.map(kind => <option key={kind} value={kind}>{({ timeSeries: "Time series", box: "Box and whisker" } as Record<string, string>)[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1)}</option>)}</select></ChartRow>
    <ChartRow name="xKey" label="X / category column" id={id + "-x"}><input id={id + "-x"} value={draft.xKey} maxLength={128} onChange={event => setDraft({ ...draft, xKey: event.target.value })} /></ChartRow>
    <ChartRow name="endKey" label="Finish column" id={id + "-end"}><input id={id + "-end"} value={draft.endKey ?? ""} maxLength={128} onChange={event => setDraft({ ...draft, endKey: event.target.value || undefined })} /></ChartRow>
    <ChartRow name="qualityKey" label="Quality column" id={id + "-quality"}><input id={id + "-quality"} placeholder="None" value={draft.qualityKey ?? ""} maxLength={128} onChange={event => setDraft({ ...draft, qualityKey: event.target.value || undefined })} /></ChartRow>
    <ChartRow name="yMin" label="Y minimum" id={id + "-min"}><input id={id + "-min"} type="number" step="any" placeholder="Automatic" value={draft.yMin ?? ""} onChange={event => setDraft({ ...draft, yMin: event.target.value === "" ? undefined : Number(event.target.value) })} /></ChartRow>
    <ChartRow name="yMax" label="Y maximum" id={id + "-max"}><input id={id + "-max"} type="number" step="any" placeholder="Automatic" value={draft.yMax ?? ""} onChange={event => setDraft({ ...draft, yMax: event.target.value === "" ? undefined : Number(event.target.value) })} /></ChartRow>
    <ChartRow name="showLegend" label="Show legend" id={id + "-legend"}><input id={id + "-legend"} type="checkbox" checked={draft.showLegend !== false} onChange={event => setDraft({ ...draft, showLegend: event.target.checked })} /></ChartRow>
    <ChartRow name="rangeSelector" label="Range selector" id={id + "-range"}><input id={id + "-range"} type="checkbox" checked={draft.rangeSelector === true} onChange={event => setDraft({ ...draft, rangeSelector: event.target.checked })} /></ChartRow>
    <ChartRow name="series" label="Series"><details className="property-structured-editor"><summary>Edit series ({draft.series.length})</summary><div><textarea aria-label="Chart series" value={seriesText} onChange={event => setSeriesText(event.target.value)} spellCheck={false} /><small>Column key, optional label and hex color. Box plots use minimum, Q1, median, Q3, maximum, in that order.</small></div></details></ChartRow>
    <ChartRow name="data" label="Saved dataset"><details className="property-structured-editor"><summary>Edit saved data</summary><div><textarea aria-label="Chart dataset" value={dataText} onChange={event => setDataText(event.target.value)} spellCheck={false} /><small>Columns and rows, up to 1,000 rows. Null numeric values preserve gaps. Time axes use epoch milliseconds or ISO timestamps with a time zone. A query binding takes precedence.</small></div></details></ChartRow>
    <div className="property-sheet-actions">{error && <p className="property-sheet-error" role="alert">{error}</p>}<button type="button" className="button" onClick={apply}>Apply chart</button><button type="button" className="button" onClick={resetDraft}>Cancel</button></div>
  </div>;
}
