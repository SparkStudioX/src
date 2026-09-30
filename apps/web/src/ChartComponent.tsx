import { useId, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import type { ComponentView } from "./Components";
import { useApplicationStateContext } from "./applicationState";
import { useDatasetBinding } from "./useDatasetBinding";
import { buildChart, chartColors, chartSegments } from "./chartModel";
import type { ChartData, ChartDefinition, ChartModel, ChartPoint } from "./chartModel";
import "./charts.css";

export function ChartGraphic({ config, model, compact = false }: { config: ChartDefinition; model: ChartModel; compact?: boolean }) {
  const clipId = useId().replaceAll(":", "");
  const width = 640, height = 300, left = compact ? 8 : 58, top = 14, right = 622, bottom = compact ? 280 : 250;
  const { points, xMin, xMax, yMin, yMax } = model;
  const x = (point: ChartPoint) => left + (point.x - xMin) / (xMax - xMin) * (right - left);
  const y = (value: number) => bottom - (value - yMin) / (yMax - yMin) * (bottom - top);
  const color = (series: number) => config.series[series].color ?? chartColors[series % chartColors.length];
  const plot: ReactNode[] = [];
  const captions: ReactNode[] = [];
  const format = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, notation: Math.abs(value) >= 1e6 ? "compact" : "standard" }).format(value);
  if (config.kind === "pie") {
    const total = points.reduce((sum, point) => sum + (point.values[0] ?? 0), 0);
    if (!Number.isFinite(total)) return <p role="status">Pie total exceeds the supported numeric range.</p>;
    if (total <= 0) return <p role="status">No positive values to display.</p>;
    let angle = -Math.PI / 2;
    points.forEach((point, index) => {
      const value = point.values[0];
      if (value === null || value === 0) return;
      const sweep = value / total * Math.PI * 2;
      const next = angle + sweep, cx = 320, cy = 140, radius = 116;
      const title = `${point.label}: ${format(value)} (${format(value / total * 100)}%)`;
      if (sweep >= Math.PI * 2 - 1e-10) plot.push(<circle key={index} cx={cx} cy={cy} r={radius} fill={chartColors[index % chartColors.length]}><title>{title}</title></circle>);
      else plot.push(<path key={index} d={`M${cx},${cy} L${cx + Math.cos(angle) * radius},${cy + Math.sin(angle) * radius} A${radius},${radius} 0 ${sweep > Math.PI ? 1 : 0},1 ${cx + Math.cos(next) * radius},${cy + Math.sin(next) * radius} Z`} fill={chartColors[index % chartColors.length]} stroke="var(--panel)" strokeWidth={1}><title>{title}</title></path>);
      angle = next;
    });
  } else if (config.kind === "radar") {
    if (points.length < 3) return <p role="status">Radar charts need at least three categories.</p>;
    const radius = 112, cx = 320, cy = 140;
    const polar = (index: number, ratio: number) => [cx + Math.sin(index / points.length * 2 * Math.PI) * radius * ratio, cy - Math.cos(index / points.length * 2 * Math.PI) * radius * ratio];
    [0.25, .5, .75, 1].forEach(ratio => plot.push(<polygon key={`grid-${ratio}`} points={points.map((_, index) => polar(index, ratio).join(",")).join(" ")} fill="none" className="chart-grid" />));
    points.forEach((point, index) => { const [px, py] = polar(index, 1.12); captions.push(<text key={index} x={px} y={py} textAnchor="middle">{point.label.slice(0, 18)}</text>); });
    config.series.forEach((series, index) => {
      // A missing observation never becomes zero or closes a fabricated polygon.
      if (points.some(point => point.values[index] === null)) return;
      plot.push(<polygon key={series.key} points={points.map((point, offset) => polar(offset, Math.max(0, Math.min(1, (point.values[index]! - yMin) / (yMax - yMin)))).join(",")).join(" ")} fill={color(index)} fillOpacity={.15} stroke={color(index)} strokeWidth={2}><title>{series.label ?? series.key}</title></polygon>);
    });
  } else if (config.kind === "gantt") {
    const lane = (bottom - top) / Math.max(1, points.length);
    points.forEach((point, index) => {
      if (!point.good || point.values[0] === null) return;
      plot.push(<rect key={index} x={x(point)} y={top + index * lane + lane * .15} width={Math.max(1, (point.end! - point.x) / (xMax - xMin) * (right - left))} height={lane * .7} fill={color(0)}><title>{`${point.label} → ${new Date(point.end!).toISOString()}`}</title></rect>);
    });
  } else {
    const slot = (right - left) / Math.max(1, points.length), categoryX = (index: number) => left + slot * (index + .5);
    if (config.kind === "box") {
      points.forEach((point, index) => {
        if (point.values.some(value => value === null)) return;
        const [low, q1, median, q3, high] = point.values as number[], px = categoryX(index), half = Math.min(25, slot * .3);
        plot.push(<g key={index} stroke={color(0)} strokeWidth={2}><title>{`${point.label}: ${point.values.join(", ")}`}</title><path d={`M${px},${y(low)} V${y(high)} M${px - half / 2},${y(low)} H${px + half / 2} M${px - half / 2},${y(high)} H${px + half / 2}`} /><rect x={px - half} y={y(q3)} width={half * 2} height={Math.max(1, y(q1) - y(q3))} fill={color(0)} fillOpacity={.25} /><path d={`M${px - half},${y(median)} H${px + half}`} /></g>);
      });
    } else config.series.forEach((series, index) => {
      if (config.kind === "bar") {
        const barWidth = slot * .8 / config.series.length;
        points.forEach((point, offset) => {
          const value = point.values[index]; if (value === null) return;
          plot.push(<rect key={`${index}-${offset}`} x={left + offset * slot + slot * .1 + index * barWidth} y={Math.min(y(value), y(0))} width={barWidth} height={Math.max(1, Math.abs(y(value) - y(0)))} fill={color(index)}><title>{`${point.label}, ${series.label ?? series.key}: ${format(value)}`}</title></rect>);
        });
      } else if (config.kind === "scatter") {
        points.forEach((point, offset) => { if (point.values[index] !== null) plot.push(<circle key={`${index}-${offset}`} cx={x(point)} cy={y(point.values[index]!)} r={3} fill={color(index)}><title>{`${point.label}, ${series.label ?? series.key}: ${format(point.values[index]!)}`}</title></circle>); });
      } else {
        chartSegments(points, index).forEach((segment, offset) => {
          let path = segment.map((point, position) => `${position ? "L" : "M"}${x(point)},${y(point.values[index]!)}`).join(" ");
          if (config.kind === "status") path = segment.map((point, position) => `${position ? `H${x(point)} V` : `M${x(point)},`}${y(point.values[index]!)}`).join(" ");
          if (config.kind === "area") plot.push(<path key={`area-${index}-${offset}`} d={`${path} L${x(segment.at(-1)!)},${y(Math.max(yMin, Math.min(yMax, 0)))} L${x(segment[0])},${y(Math.max(yMin, Math.min(yMax, 0)))} Z`} fill={color(index)} fillOpacity={.16} />);
          plot.push(<path key={`line-${index}-${offset}`} d={path} fill="none" stroke={color(index)} strokeWidth={2} vectorEffect="non-scaling-stroke"><title>{series.label ?? series.key}</title></path>);
          if (segment.length === 1) plot.push(<circle key={`single-${index}-${offset}`} cx={x(segment[0])} cy={y(segment[0].values[index]!)} r={3} fill={color(index)} />);
        });
      }
    });
    if (!compact) {
      for (let index = 0; index <= 4; index++) { const value = yMin + (yMax - yMin) * index / 4; captions.push(<g key={`y-${index}`}><path d={`M${left},${y(value)} H${right}`} className="chart-grid" /><text x={left - 7} y={y(value) + 4} textAnchor="end">{format(value)}</text></g>); }
      const every = Math.max(1, Math.ceil(points.length / 6));
      points.forEach((point, index) => { if (index % every === 0) captions.push(<text key={`x-${index}`} x={["bar", "box"].includes(config.kind) ? categoryX(index) : x(point)} y={bottom + 21} textAnchor="middle">{config.kind === "timeSeries" ? new Date(point.x).toISOString().slice(11, 19) : point.label.slice(0, 16)}</text>); });
    }
  }
  return <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${config.kind} chart, ${points.length} observations${model.gaps ? `, ${model.gaps} missing or bad-quality values` : ""}`}>
    <defs><clipPath id={clipId}><rect x={left - 1} y={top - 1} width={right - left + 2} height={bottom - top + 2} /></clipPath></defs>
    {captions}<g clipPath={["pie", "radar"].includes(config.kind) ? undefined : `url(#${clipId})`}>{plot}</g>
  </svg>;
}

export function ChartPresentation({ component, data, status = "ready", error, refreshing = false }: {
  component: ComponentProps<typeof ComponentView>["component"]; data?: ChartData; status?: string; error?: string; refreshing?: boolean;
}) {
  const [range, setRange] = useState<[number, number]>([0, 100]);
  const config = component.props.chart;
  const compact = component.type === "sparkline";
  const model = config && data ? buildChart(config, data, config.rangeSelector ? range : undefined) : undefined;
  const problem = error ?? model?.error;
  return <figure className={`render-chart${compact ? " chart-compact" : ""}`}>
    {component.props.text && <figcaption>{component.props.text}</figcaption>}
    {problem ? <p role="status" className="chart-diagnostic">{problem}</p> : !config ? <p role="status">Configure chart axes and series.</p> : !data ? <p role="status">{status === "loading" ? "Loading chart data…" : "Choose a chart dataset."}</p> : !model?.points.length ? <p role="status">No observations in this range.</p> : <ChartGraphic config={config} model={model} compact={compact} />}
    {model && config && !problem && !compact && config.showLegend !== false && <ul className="chart-legend">{config.kind === "pie"
      ? model.points.map((point, index) => point.values[0] !== null && point.values[0] > 0 && <li key={index}><i style={{ backgroundColor: chartColors[index % chartColors.length] }} />{point.label}</li>)
      : config.series.map((series, index) => <li key={series.key}><i style={{ backgroundColor: series.color ?? chartColors[index % chartColors.length] }} />{series.label ?? series.key}</li>)}</ul>}
    {!!model?.gaps && <small role="status">{model.gaps} missing or bad-quality values; gaps are preserved.</small>}
    {refreshing && <small role="status">Refreshing…</small>}
    {config?.rangeSelector && <div className="chart-range"><label>From %<input type="range" min="0" max={range[1] - 1} value={range[0]} onChange={event => setRange([Number(event.target.value), range[1]])} /></label><label>To %<input type="range" min={range[0] + 1} max="100" value={range[1]} onChange={event => setRange([range[0], Number(event.target.value)])} /></label><span>{range[0]}–{range[1]}%</span></div>}
    {!compact && data && <details className="chart-data"><summary>View data ({data.rows.length} rows)</summary><div><table><thead><tr>{data.columns.map(key => <th key={key}>{key}</th>)}</tr></thead><tbody>{data.rows.map((row, index) => <tr key={index}>{data.columns.map(key => <td key={key}>{row[key] === null ? "—" : String(row[key] ?? "")}</td>)}</tr>)}</tbody></table></div></details>}
  </figure>;
}

// The dataset hook supplies publication-aware query results; the presentation
// never fetches arbitrary URLs and never invents history from current values.
export default function ChartComponent(props: ComponentProps<typeof ComponentView>) {
  const state = useApplicationStateContext();
  const sample = useDatasetBinding(props.component, { components: props.scopeComponents ?? [props.component], tags: props.tags, parameters: props.parameters,
    inputs: props.inputs ?? {}, state: state?.values, communicationLost: props.communicationLost }, { scope: props.queryScope ?? "designer", publishedAt: props.publishedAt, active: true });
  return <ChartPresentation key={JSON.stringify([props.component.id, props.component.props.chart, props.parameters, props.publishedAt])} component={props.component} {...sample} />;
}
