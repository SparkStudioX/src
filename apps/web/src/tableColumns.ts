import { validateTableColumns } from "./tableColumnValidation";
export { validateTableColumns } from "./tableColumnValidation";
import { displayValue } from "./api";
import type { TableColumnDefinition } from "./types";

export interface ResolvedTableColumn {
  key: string;
  label: string;
  align: "left" | "center" | "right";
  width?: number;
  format: "auto" | "text" | "number" | "boolean" | "datetime";
  precision?: number;
  suffix?: string;
}
const integer = (value: unknown, minimum: number, maximum: number) => typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;

const heading = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
export function resolveTableColumns(config: unknown, sourceColumns: string[]): { columns: ResolvedTableColumn[]; error: string | null } {
  const error = validateTableColumns(config);
  if (error) return { columns: [], error };
  if (!Array.isArray(sourceColumns) || sourceColumns.some(key => typeof key !== "string") || new Set(sourceColumns).size !== sourceColumns.length)
    return { columns: [], error: "The query must return unique column names." };
  const definitions = config as TableColumnDefinition[] | undefined;
  if (!definitions?.length) return { columns: sourceColumns.map(key => ({ key, label: heading(key), align: "left", format: "auto" })), error: null };
  const source = new Set(sourceColumns);
  const missing = definitions.find(column => !source.has(column.key));
  if (missing) return { columns: [], error: `Configured source column "${missing.key}" is missing from this query result.` };
  return { columns: definitions.filter(column => !Object.hasOwn(column, "visible") || column.visible !== false).map(column => ({
    key: column.key, label: Object.hasOwn(column, "label") ? column.label! : heading(column.key), align: Object.hasOwn(column, "align") ? column.align! : "left", format: Object.hasOwn(column, "format") ? column.format! : "auto",
    ...(Object.hasOwn(column, "width") ? { width: column.width } : {}),
    ...(Object.hasOwn(column, "precision") ? { precision: column.precision } : {}),
    ...(Object.hasOwn(column, "suffix") ? { suffix: column.suffix } : {}),
  })), error: null };
}

function utcTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|([+-])(\d{2}):(\d{2}))(?![\s\S])/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59
    || match[8] !== "Z" && (Number(match[10]) > 23 || Number(match[11]) > 59)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const fraction = match[7]?.replace(/0+$/, "");
  return new Date(milliseconds).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, `${fraction ? `.${fraction}` : ""} UTC`);
}

export function formatTableCell(value: unknown, column: ResolvedTableColumn): { text: string; error?: string } {
  if (value === null || value === undefined) return { text: "—" };
  const invalid = (expected: string) => ({ text: "—", error: `Column "${column.label}" requires ${expected}.` });
  if (column.format === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) return invalid("a finite number within JavaScript's exact integer range");
    if (column.precision !== undefined && !integer(column.precision, 0, 10)) return invalid("a precision from 0 to 10");
    return { text: `${value.toFixed(column.precision ?? 2)}${column.suffix ?? ""}` };
  }
  if (column.format === "boolean") {
    if (value === true || value === 1) return { text: "True" };
    if (value === false || value === 0) return { text: "False" };
    return invalid("a Boolean or the number 0 or 1");
  }
  if (column.format === "datetime") {
    const formatted = utcTimestamp(value);
    return formatted === null ? invalid("an ISO date/time with an explicit timezone") : { text: formatted };
  }
  try {
    if (column.format === "auto") return { text: displayValue(value) };
    if (column.format === "text") {
      if (typeof value === "number" && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) return invalid("an exact finite number or an exact text value");
      const formatted = typeof value === "object" ? JSON.stringify(value) : String(value);
      return typeof formatted === "string" ? { text: formatted } : invalid("a displayable text value");
    }
  } catch { return invalid("a displayable value"); }
  return invalid("a supported display format");
}
