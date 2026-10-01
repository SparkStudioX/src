import type { CanvasComponent } from "./types";

export const chartKinds = ["line", "area", "bar", "scatter", "timeSeries", "pie", "radar", "status", "box", "gantt"] as const;
export type ChartKind = typeof chartKinds[number];
export interface ChartSeries { key: string; label?: string; color?: string }
export interface ChartDefinition {
  kind: ChartKind;
  xKey: string;
  series: ChartSeries[];
  endKey?: string;
  qualityKey?: string;
  yMin?: number;
  yMax?: number;
  showLegend?: boolean;
  rangeSelector?: boolean;
}
export interface ChartData { columns: string[]; rows: Record<string, unknown>[] }
export interface ChartPoint { label: string; x: number; values: (number | null)[]; end?: number; good: boolean }
export interface ChartModel {
  points: ChartPoint[];
  xMin: number; xMax: number; yMin: number; yMax: number;
  gaps: number;
  error?: string;
}
const safe = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
const name = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128 && !["__proto__", "constructor", "prototype"].includes(value);
export function isChart(type: string) { return type === "chart" || type === "sparkline"; }
export function chartDefinitionError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Configure the chart's axes and series.";
  const config = value as ChartDefinition;
  if (Object.keys(config).some(key => !["kind", "xKey", "series", "endKey", "qualityKey", "yMin", "yMax", "showLegend", "rangeSelector"].includes(key))) return "Unknown chart setting.";
  if (!chartKinds.includes(config.kind) || !name(config.xKey)) return "Choose a chart type and a valid X/category column.";
  if (!Array.isArray(config.series) || config.series.length < 1 || config.series.length > 8) return "Configure 1–8 chart series.";
  return chartSeriesError(config.series) ?? chartOptionalSettingsError(config);
}

function chartSeriesError(seriesList: ChartSeries[]): string | undefined {
  const seen = new Set<string>();
  for (const series of seriesList) {
    if (!series || Object.keys(series).some(key => !["key", "label", "color"].includes(key)) || !name(series.key) || seen.has(series.key)) return "Chart series need unique, valid column names.";
    seen.add(series.key);
    if (series.label !== undefined && (typeof series.label !== "string" || series.label.length > 128)) return "Series labels allow up to 128 characters.";
    if (series.color !== undefined && !/^#[\da-f]{6}$/i.test(series.color)) return "Series colors must be six-digit hex colors.";
  }
  return undefined;
}

function chartOptionalSettingsError(config: ChartDefinition): string | undefined {
  for (const key of ["endKey", "qualityKey"] as const) if (config[key] !== undefined && !name(config[key])) return `Choose a valid ${key} column.`;
  for (const key of ["yMin", "yMax"] as const) if (config[key] !== undefined && !safe(config[key])) return "Axis bounds must be finite, precise numbers.";
  if (config.yMin !== undefined && config.yMax !== undefined && config.yMin >= config.yMax) return "The Y minimum must be below its maximum.";
  for (const key of ["showLegend", "rangeSelector"] as const) if (config[key] !== undefined && typeof config[key] !== "boolean") return "Chart display settings must be Boolean.";
  if (config.kind === "gantt" && !config.endKey) return "Gantt requires a finish column.";
  if (config.kind === "box" && config.series.length !== 5) return "Box plot requires five series in order: minimum, Q1, median, Q3, maximum.";
  if (config.kind === "pie" && config.series.length !== 1) return "Pie charts require one value series.";
  return undefined;
}
function instant(value: unknown): number | undefined {
  if (safe(value)) return Number.isFinite(new Date(value).getTime()) ? value : undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
export function buildChart(config: ChartDefinition, data: ChartData, range?: [number, number]): ChartModel {
  const empty: ChartModel = { points: [], xMin: 0, xMax: 1, yMin: 0, yMax: 1, gaps: 0 };
  const fail = (error: string): ChartModel => ({ ...empty, error });
  const invalid = chartDefinitionError(config);
  if (invalid) return fail(invalid);
  const keys = chartColumnKeys(config);
  const datasetError = chartDatasetError(data, keys);
  if (datasetError) return fail(datasetError);
  const points: ChartPoint[] = [];
  const numericX = ["scatter", "timeSeries", "gantt"].includes(config.kind);
  for (const [index, row] of data.rows.entries()) {
    const parsed = readChartPoint(config, row, index, keys, numericX);
    if (typeof parsed === "string") return fail(parsed);
    points.push(parsed);
  }
  if (numericX && config.kind !== "gantt") points.sort((a, b) => a.x - b.x);
  if (range && (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite))) return fail("Chart range percentages must be finite numbers.");
  const selected = selectedChartPoints(points, range);
  const model: ChartModel = {
    points: selected,
    ...chartYBounds(config, selected),
    ...chartXBounds(selected),
    gaps: selected.reduce((count, point) => count + point.values.filter(value => value === null).length, 0),
  };
  if (!chartRenderingRangeIsSafe(model)) return fail("The chart's numeric range exceeds safe rendering limits.");
  return model;
}

function chartColumnKeys(config: ChartDefinition): string[] {
  return [config.xKey, ...config.series.map(item => item.key), config.qualityKey, config.kind === "gantt" ? config.endKey : undefined].filter((key): key is string => !!key);
}

function chartDatasetError(data: ChartData, keys: string[]): string | undefined {
  if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows) || data.rows.length > 1000 || data.columns.length > 64 || new Set(data.columns).size !== data.columns.length) return "Chart data must contain at most 1,000 rows and 64 unique columns.";
  if (keys.some(key => !data.columns.includes(key))) return "A configured chart column is missing from the dataset.";
  return undefined;
}

function readChartX(config: ChartDefinition, raw: unknown, index: number): number | undefined {
  if (config.kind === "scatter") return safe(raw) ? raw : undefined;
  if (config.kind === "timeSeries" || config.kind === "gantt") return instant(raw);
  return index;
}

function readChartValues(config: ChartDefinition, row: Record<string, unknown>, good: boolean, index: number): (number | null)[] | string {
  const values: (number | null)[] = [];
  for (const series of config.series) {
    const value = row[series.key];
    if (!good || value === null) values.push(null);
    else if (!safe(value)) return `Row ${index + 1}, ${series.key} must be a finite number or null.`;
    else if (["pie", "radar"].includes(config.kind) && value < 0) return `${config.kind} values cannot be negative.`;
    else values.push(value);
  }
  return values;
}

function readChartPoint(config: ChartDefinition, row: Record<string, unknown>, index: number, keys: string[], numericX: boolean): ChartPoint | string {
  if (!row || typeof row !== "object" || keys.some(key => !Object.hasOwn(row, key))) return `Row ${index + 1} is missing a configured column.`;
  const rawX = row[config.xKey], x = readChartX(config, rawX, index);
  if (x === undefined || !(typeof rawX === "string" || safe(rawX))) return `Row ${index + 1} needs a ${numericX ? "numeric X value or a timestamp with a time zone" : "text or numeric category"}.`;
  const good = !config.qualityKey || typeof row[config.qualityKey] === "string" && /^good(?:$|_)/i.test(row[config.qualityKey] as string);
  const values = readChartValues(config, row, good, index);
  if (typeof values === "string") return values;
  let end: number | undefined;
  if (config.kind === "gantt") {
    end = instant(row[config.endKey!]);
    if (end === undefined || end < x) return `Row ${index + 1} needs a finish at or after its start.`;
  }
  if (config.kind === "box" && values.every(value => value !== null) && values.some((value, offset) => offset > 0 && value! < values[offset - 1]!)) return `Row ${index + 1} has out-of-order box statistics.`;
  return { label: String(rawX), x, values, end, good };
}

function selectedChartPoints(points: ChartPoint[], range?: [number, number]): ChartPoint[] {
  const minPercent = Math.max(0, Math.min(99, range?.[0] ?? 0));
  const maxPercent = Math.max(minPercent + 1, Math.min(100, range?.[1] ?? 100));
  return points.slice(Math.floor(points.length * minPercent / 100), Math.ceil(points.length * maxPercent / 100));
}

function chartYBounds(config: ChartDefinition, points: ChartPoint[]): Pick<ChartModel, "yMin" | "yMax"> {
  const values = points.flatMap(point => point.values.filter((value): value is number => value !== null));
  let yMin = config.yMin ?? Math.min(0, ...values), yMax = config.yMax ?? Math.max(0, ...values);
  if (yMin >= yMax) {
    if (config.yMin !== undefined) yMax = yMin + Math.max(1, Math.abs(yMin) * .05);
    else if (config.yMax !== undefined) yMin = yMax - Math.max(1, Math.abs(yMax) * .05);
    else { yMin -= .5; yMax += .5; }
  }
  return { yMin, yMax };
}

function chartXBounds(points: ChartPoint[]): Pick<ChartModel, "xMin" | "xMax"> {
  let xMin = Math.min(...points.map(point => point.x)), xMax = Math.max(...points.map(point => point.end ?? point.x));
  if (!points.length) { xMin = 0; xMax = 1; }
  else if (xMin === xMax) { xMin -= .5; xMax += .5; }
  return { xMin, xMax };
}

function chartRenderingRangeIsSafe({ points, xMin, xMax, yMin, yMax }: ChartModel): boolean {
  if (![xMin, xMax, yMin, yMax, xMax - xMin, yMax - yMin].every(Number.isFinite) || xMin >= xMax || yMin >= yMax) return false;
  return !points.some(point => !Number.isFinite((point.x - xMin) / (xMax - xMin) * 1000)
    || point.values.some(value => value !== null && !Number.isFinite((value - yMin) / (yMax - yMin) * 1000)));
}
export function chartSegments(points: ChartPoint[], series: number): ChartPoint[][] {
  const segments: ChartPoint[][] = [];
  let current: ChartPoint[] = [];
  for (const point of points) {
    if (point.values[series] === null) { if (current.length) segments.push(current); current = []; }
    else current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}
export const chartColors = ["#6488dc", "#dd9862", "#5ca78c", "#ba80c5", "#d46e79", "#7f9eaa", "#b4a052", "#9f89df"];
export function defaultChartProps(sparkline = false): CanvasComponent["props"] {
  return {
    text: sparkline ? "Production sparkline" : "Production chart", chart: { kind: "line", xKey: "hour", series: [{ key: "produced", label: "Produced" }, { key: "target", label: "Target" }], showLegend: !sparkline },
    data: { columns: ["hour", "produced", "target"], rows: [8, 9, 10, 11, 12, 13].map((hour, index) => ({ hour: String(hour).padStart(2, "0") + ":00", produced: [42, 57, 51, 68, 64, 73][index], target: 60 })) }
  };
}
