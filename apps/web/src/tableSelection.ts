import type { InputValue } from "./types";

export type TableRow = Record<string, unknown>;
export type TableSelection =
  | { ok: true; key: string | number; changes: [string, InputValue][] }
  | { ok: false; error: string; changes: [] };

/** Text and numeric keys keep their distinct identities, including in React lists. */
export function tableRowIdentity(key: unknown): string {
  return JSON.stringify([typeof key, key]);
}

/** Validate the complete result and mapping before exposing any form changes. */
export function resolveTableSelection(
  rows: readonly TableRow[],
  row: TableRow,
  rowKey: string | undefined,
  selectionFields: Readonly<Record<string, string>>,
  validateField?: (field: string, value: InputValue) => string | null,
): TableSelection {
  const invalid = (error: string): TableSelection => ({ ok: false, error, changes: [] });
  const keys = rows.map(item => rowKey && Object.hasOwn(item, rowKey) ? item[rowKey] : undefined);
  if (!rowKey || keys.some(value => typeof value === "string"
    ? !value.trim()
    : typeof value !== "number" || !Number.isSafeInteger(value)) || new Set(keys).size !== keys.length)
    return invalid("Row selection requires a unique, nonempty text or safe integer key for every row.");
  if (!rows.includes(row)) return invalid("This row is no longer available. Refresh the table and select it again.");
  const changes: [string, InputValue][] = [];
  for (const [field, column] of Object.entries(selectionFields)) {
    const value = Object.hasOwn(row, column) ? row[column] : undefined;
    if (typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))))
    {
      const error = validateField?.(field, value);
      if (error) return invalid(error);
      changes.push([field, value]);
    }
    else return invalid(`Cannot select this row: ${column} has no usable form value.`);
  }
  return { ok: true, key: row[rowKey] as string | number, changes };
}
