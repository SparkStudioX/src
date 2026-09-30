import type { InputValue, TableEditColumn } from "./types";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const key = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128 && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const boundedNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const definitionFields = new Set(["versionColumn", "columns", "script", "batch"]);
const identifier = (value: unknown): value is string => typeof value === "string" && value === value.trim() && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
const columnFields = new Set(["key", "type", "required", "maxLength", "min", "max", "integer"]);

export function validateTableEditDefinition(value: unknown, rowKey: unknown, allowRuntime = false): string | null {
  if (value === undefined) return null;
  if (!record(value) || Object.keys(value).some(field => !definitionFields.has(field))) return "Table editing contains an unsupported definition or property.";
  if (!key(rowKey)) return "Table editing requires an exact row key of 1–128 characters without outer whitespace or control characters.";
  if (!key(value.versionColumn) || value.versionColumn === rowKey) return "Choose a version column distinct from the row key, with an exact source key of 1–128 characters.";
  const batch = Object.hasOwn(value, "batch");
  if (batch && (!record(value.batch) || Object.keys(value.batch).length !== 1 || !identifier(value.batch.table) || Object.hasOwn(value, "script"))) return "Atomic editing requires one database table name and cannot contain a Python handler.";
  if (batch && (!identifier(rowKey) || !identifier(value.versionColumn) || rowKey.toLowerCase() === value.versionColumn.toLowerCase())) return "Atomic row key and version must be different ASCII database identifiers.";
  if (!Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > 64) return "Configure 1–64 editable columns.";
  const keys = new Set<string>();
  for (const [index, column] of value.columns.entries()) {
    const prefix = `Editable column ${index + 1}`;
    if (!record(column) || Object.keys(column).some(field => !columnFields.has(field))) return `${prefix} contains an unsupported definition or property.`;
    if (!key(column.key) || keys.has(column.key) || column.key === rowKey || column.key === value.versionColumn) return `${prefix} needs a unique exact source key distinct from the row key and version column.`;
    const columnName = column.key;
    if (batch && (!identifier(columnName) || [...keys, rowKey, value.versionColumn].some(existing => existing.toLowerCase() === columnName.toLowerCase()))) return `${prefix} needs a unique ASCII database identifier distinct from the row key and version.`;
    keys.add(column.key);
    if (!["string", "number", "boolean"].includes(column.type as string)) return `${prefix} must have string, number or boolean type.`;
    for (const field of ["required", "maxLength"]) if (Object.hasOwn(column, field) && column.type !== "string") return `${prefix}: ${field} applies only to string values.`;
    for (const field of ["min", "max", "integer"]) if (Object.hasOwn(column, field) && column.type !== "number") return `${prefix}: ${field} applies only to number values.`;
    if (Object.hasOwn(column, "required") && typeof column.required !== "boolean") return `${prefix}: required must be true or false.`;
    if (Object.hasOwn(column, "maxLength") && (typeof column.maxLength !== "number" || !Number.isInteger(column.maxLength) || column.maxLength < 1 || column.maxLength > 4096)) return `${prefix}: maximum length must be a whole number from 1 to 4,096.`;
    for (const field of ["min", "max"]) if (Object.hasOwn(column, field) && !boundedNumber(column[field])) return `${prefix}: ${field} must be a finite number within the safe integer range.`;
    if (typeof column.min === "number" && typeof column.max === "number" && column.min > column.max) return `${prefix}: minimum must not exceed maximum.`;
    if (Object.hasOwn(column, "integer") && typeof column.integer !== "boolean") return `${prefix}: integer must be true or false.`;
  }
  if (!batch && (!allowRuntime || Object.hasOwn(value, "script")) && (typeof value.script !== "string" || !value.script.trim() || value.script.length > 64000)) return "Table editing requires a Python handler of 1–64,000 characters.";
  return null;
}

export function parseTableEditValue(text: string | boolean, column: TableEditColumn): { value?: InputValue; error?: string } {
  if (column.type === "boolean") return typeof text === "boolean" ? { value: text } : { error: "Choose true or false." };
  if (typeof text !== "string") return { error: `Enter a ${column.type} value.` };
  if (column.type === "string") {
    if (column.required && !text.trim()) return { error: "A nonblank value is required." };
    if (text.length > (column.maxLength ?? 4096)) return { error: `Use at most ${column.maxLength ?? 4096} characters.` };
    return { value: text };
  }
  if (column.type !== "number" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim())) return { error: "Enter a finite decimal number." };
  const value = Number(text);
  if (!boundedNumber(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) return { error: "Enter a finite number within the safe integer range." };
  if (column.integer && !Number.isInteger(value)) return { error: "Enter a whole number." };
  if (column.min !== undefined && value < column.min) return { error: `The value must be at least ${column.min}.` };
  if (column.max !== undefined && value > column.max) return { error: `The value must be at most ${column.max}.` };
  return { value };
}

export function tableEditRowIdentity(rows: Record<string, unknown>[], row: Record<string, unknown>, rowKey: string | undefined, versionColumn: string): { key?: string | number; version?: number; error?: string } {
  if (!key(rowKey) || !key(versionColumn) || rowKey === versionColumn) return { error: "Table editing requires distinct row key and version columns." };
  const keys = new Set<string | number>();
  for (const item of rows) {
    const identity = Object.hasOwn(item, rowKey) ? item[rowKey] : undefined;
    if (typeof identity === "string" ? !identity.trim() || identity.length > 4096 : typeof identity !== "number" || !Number.isSafeInteger(identity)) return { error: "Every row requires a nonblank text key (at most 4,096 characters) or a safe integer key." };
    if (keys.has(identity as string | number)) return { error: "Every row must have a unique key." };
    keys.add(identity as string | number);
    const version = Object.hasOwn(item, versionColumn) ? item[versionColumn] : undefined;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) return { error: "Every row requires a nonnegative safe integer version." };
  }
  if (!rows.includes(row)) return { error: "This row is no longer available. Reload the table before editing." };
  return { key: row[rowKey] as string | number, version: row[versionColumn] as number };
}
