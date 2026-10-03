import type { Connection, SourceBrowseEntry, SourceConnectionType, SourceImportPoint, SourcePoint, SourceSettings, TagWriteDataType } from "./types";
import { scalarTypes } from "./deviceConnections";

export const sourceTypes: SourceConnectionType[] = ["mtconnect", "i3x", "mqtt"];
export const isSourceType = (type: string): type is SourceConnectionType => sourceTypes.includes(type as SourceConnectionType);
export const isPointConnection = (connection: Connection) => Boolean(connection.device || isSourceType(connection.type));
export const connectionPoints = (connection?: Connection): (SourcePoint | import("./types").DevicePoint)[] => connection?.source?.points ?? connection?.device?.points ?? [];
export const defaultSourceSettings = (type: SourceConnectionType): SourceSettings => ({
  endpoint: type === "mqtt" ? "mqtt://127.0.0.1:1883" : type === "i3x" ? "https://api.i3x.dev/v1" : "http://127.0.0.1:5000",
  acquisition: type === "mqtt" ? "subscribe" : "poll", intervalMs: 1000, points: [], authentication: { mode: "none" },
  ...(type === "mtconnect" ? { mtConnect: { heartbeatMs: 10000, count: 1000, userAgent: "SparkStudio/1.0" } }
    : type === "i3x" ? { i3x: { preferStream: true, maxDepth: 1, reconciliationSeconds: 30 } }
    : { mqtt: { protocolVersion: "5", transport: "tcp", keepAliveSeconds: 30, cleanStart: true, sessionExpirySeconds: 0, mappings: [] } }),
});
export const sourceEntryKey = (entry: Pick<SourceBrowseEntry, "address" | "selector" | "mappingId">) => JSON.stringify([entry.mappingId ?? "", entry.address, entry.selector ?? ""]);
export function sourceImportPoint(entry: SourceBrowseEntry, root: string): SourceImportPoint {
  // eslint-disable-next-line no-control-regex -- This character filter intentionally matches control characters.
  const segment = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f[\]{}\\/]/g, "_").trim() || "_";
  const suggested = entry.suggestedPath ?? segment(entry.name) + (entry.selector ? "/" + segment(entry.selector) : "");
  return { address: entry.address, name: entry.name, selector: entry.selector, mappingId: entry.mappingId,
    dataType: scalarTypes.includes(entry.dataType as TagWriteDataType) ? entry.dataType as TagWriteDataType : "String",
    path: suggested.startsWith("[default]") ? suggested : root.replace(/\/$/, "") + "/" + suggested };
}
export function validateSourcePoints(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10000) return ["Use an array with at most 10,000 read-only source points."];
  const errors: string[] = [], ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push(`Point ${index + 1} must be an object.`); continue; }
    const point = raw as Record<string, unknown>;
    if (typeof point.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(point.id) || ids.has(point.id)) errors.push(`Point ${index + 1}: choose a valid unique ID.`);
    else ids.add(point.id);
    if (typeof point.name !== "string" || !point.name.trim() || point.name.length > 256) errors.push(`Point ${index + 1}: name is required, up to 256 characters.`);
    // eslint-disable-next-line no-control-regex -- This character filter intentionally matches control characters.
    if (typeof point.address !== "string" || !point.address.trim() || point.address.length > 2048 || /[\u0000-\u001f\u007f]/.test(point.address)) errors.push(`Point ${index + 1}: raw address is required, up to 2,048 characters.`);
    // eslint-disable-next-line no-control-regex -- This character filter intentionally matches control characters.
    if (point.selector != null && (typeof point.selector !== "string" || point.selector.length > 512 || /[\u0000-\u001f\u007f]/.test(point.selector))) errors.push(`Point ${index + 1}: selector must be bounded text.`);
    if (!scalarTypes.includes(point.dataType as TagWriteDataType)) errors.push(`Point ${index + 1}: choose a supported scalar type.`);
    if (point.writable != null && point.writable !== false) errors.push(`Point ${index + 1}: writable must be false; these sources are read-only.`);
    if (point.mappingId != null && (typeof point.mappingId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(point.mappingId))) errors.push(`Point ${index + 1}: mapping ID must be a valid stable identity.`);
    if (errors.length >= 50) break;
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 768 * 1024) errors.push("The source map exceeds 768 KiB.");
  return errors;
}
export function parseSourceMap(text: string): SourcePoint[] {
  if (text.length > 2 * 1024 * 1024) throw new Error("Source-map JSON exceeds 2 MiB.");
  const parsed: unknown = JSON.parse(text);
  const points = Array.isArray(parsed) ? parsed : (parsed as { points?: unknown })?.points;
  const errors = validateSourcePoints(points);
  if (errors.length) throw new Error(errors.join("\n"));
  return (points as SourcePoint[]).map(point => ({ ...point, writable: false }));
}
/** A topic may be both a variable and a folder. Keep both rows in the tree. */
export function sourceBrowseRows(entries: SourceBrowseEntry[]) {
  const seen = new Set<string>();
  return entries.filter(entry => { const key = JSON.stringify([sourceEntryKey(entry), entry.isVariable]); if (seen.has(key)) return false; seen.add(key); return true; });
}
