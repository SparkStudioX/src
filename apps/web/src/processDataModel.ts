import type { CanvasComponent } from "./types";
export const processDataTypes = ["alarmStatusTable", "alarmJournalTable", "historicalTrend"] as const;
export const isProcessDataComponent = (type: string) => (processDataTypes as readonly string[]).includes(type);
export interface AlarmSample {
  id: string; name: string; tagPath: string; priority: number; active: boolean; acknowledged: boolean;
  quality: string; value: unknown; eventId: string; activeAt?: string; clearedAt?: string;
  acknowledgedAt?: string; acknowledgedBy?: string; recordedAt?: string; kind?: string; actor?: string;
}
export interface HistorySeries { path: string; points: { timestamp: string; value: unknown; quality: string }[] }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function alarmSamples(value: unknown, journal = false): AlarmSample[] {
  if (!record(value) || !Array.isArray(value[journal ? "events" : "alarms"]) || journal && typeof value.truncated !== "boolean") throw new Error("The gateway returned an invalid alarm response.");
  const rows = value[journal ? "events" : "alarms"] as unknown[];
  if (rows.length > 10000 || !rows.every(row => record(row) && [row.id, row.name, row.tagPath, row.quality, row.eventId].every(item => typeof item === "string")
    && typeof row.priority === "number" && Number.isInteger(row.priority) && row.priority >= 1 && row.priority <= 4
    && typeof row.active === "boolean" && typeof row.acknowledged === "boolean")) throw new Error("The gateway returned an invalid alarm row.");
  return rows as AlarmSample[];
}
export function alarmJournalPage(value: unknown): { events: AlarmSample[]; truncated: boolean } {
  const events = alarmSamples(value, true);
  return { events, truncated: (value as Record<string, unknown>).truncated as boolean };
}
export function historySeries(value: unknown): { series: HistorySeries[]; truncated: boolean } {
  if (!record(value) || !Array.isArray(value.series) || value.series.length > 8 || typeof value.truncated !== "boolean") throw new Error("The gateway returned invalid history.");
  for (const series of value.series) if (!record(series) || typeof series.path !== "string" || !Array.isArray(series.points) || series.points.length > 100000
    || !series.points.every(point => record(point) && typeof point.timestamp === "string" && Number.isFinite(Date.parse(point.timestamp)) && typeof point.quality === "string" && Object.hasOwn(point, "value"))) throw new Error("The gateway returned invalid historical samples.");
  return value as unknown as { series: HistorySeries[]; truncated: boolean };
}
export function processDataPropertyError(component: CanvasComponent): string | undefined {
  const p = component.props;
  if (component.type === "historicalTrend") {
    if (!Array.isArray(p.historyPaths) || p.historyPaths.length < 1 || p.historyPaths.length > 8 || p.historyPaths.some(path => typeof path !== "string" || !path.trim() || path.length > 1024) || new Set(p.historyPaths).size !== p.historyPaths.length) return "Enter 1–8 unique historical tag paths.";
    if (!Number.isInteger(p.historyMinutes ?? 60) || Number(p.historyMinutes ?? 60) < 1 || Number(p.historyMinutes ?? 60) > 43200) return "History range must be 1–43,200 minutes.";
    if (!Number.isInteger(p.historyMaxPoints ?? 1000) || Number(p.historyMaxPoints ?? 1000) < 10 || Number(p.historyMaxPoints ?? 1000) > 10000) return "History points must be 10–10,000 per request.";
  } else if (!Number.isInteger(p.alarmMinimumPriority ?? 1) || Number(p.alarmMinimumPriority ?? 1) < 1 || Number(p.alarmMinimumPriority ?? 1) > 4) return "Minimum alarm priority must be 1–4.";
  return undefined;
}
