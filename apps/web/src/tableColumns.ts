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
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const fields = new Set(["key", "label", "visible", "width", "align", "format", "precision", "suffix"]);
const formats = new Set(["auto", "text", "number", "boolean", "datetime"]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, maximum: number, allowEmpty = false) => typeof value === "string" && value.length <= maximum && !controls.test(value) && (allowEmpty || Boolean(value.trim()));
const integer = (value: unknown, minimum: number, maximum: number) => typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;

/** Undefined and an empty array both retain automatic query-column display. */
export function validateTableColumns(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 64) return "Table columns must be an array of at most 64 definitions.";
  const keys = new Set<string>();
  let visible = 0;
  for (let index = 0; index < value.length; index++) {
    const column: unknown = value[index], prefix = `Column ${index + 1}`;
    if (!record(column) || Object.keys(column).some(key => !fields.has(key))) return `${prefix} contains an unsupported definition or property.`;
    if (!Object.hasOwn(column, "key") || !text(column.key, 128) || column.key !== (column.key as string).trim())
      return `${prefix} needs an exact source key of 1–128 characters, without outer whitespace or control characters.`;
    const key = column.key as string;
    if (keys.has(key)) return `${prefix} repeats the source key "${key}".`;
    keys.add(key);
    if (Object.hasOwn(column, "label") && !text(column.label, 120)) return `${prefix} label must contain 1–120 characters without control characters.`;
    if (Object.hasOwn(column, "visible") && typeof column.visible !== "boolean") return `${prefix} visibility must be true or false.`;
    if (!Object.hasOwn(column, "visible") || column.visible !== false) visible++;
    if (Object.hasOwn(column, "width") && !integer(column.width, 40, 1200)) return `${prefix} width must be a whole number from 40 to 1,200 pixels.`;
    if (Object.hasOwn(column, "align") && !["left", "center", "right"].includes(column.align as string)) return `${prefix} alignment must be left, center or right.`;
    if (Object.hasOwn(column, "format") && !formats.has(column.format as string)) return `${prefix} has an unsupported display format.`;
    if (Object.hasOwn(column, "precision") && (!Object.hasOwn(column, "format") || column.format !== "number" || !integer(column.precision, 0, 10))) return `${prefix} precision requires number format and a whole number from 0 to 10.`;
    if (Object.hasOwn(column, "suffix") && (!Object.hasOwn(column, "format") || column.format !== "number" || !text(column.suffix, 32, true))) return `${prefix} suffix requires number format and at most 32 characters without control characters.`;
  }
  return value.length && !visible ? "Show at least one configured column, or use automatic columns." : null;
}

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
