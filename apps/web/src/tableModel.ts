import type { QueryResult } from "./types";

export type TableSort = { column: string; descending: boolean } | null;
export type TableProjectionColumns = {
  columns: string[];
  cellText: (row: Record<string, unknown>, column: string) => string;
};

/** Paging is a projection over the complete, already bounded query result. */
export function tablePage(result: QueryResult | null, filter: string, sort: TableSort, requestedPage: number, pageSize: number, visible?: TableProjectionColumns) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("Table page size must be a whole number from 1 to 100.");
  const all = result?.rows ?? [];
  const needle = filter.toLowerCase();
  const rows = all.filter(row => !needle || (visible
    ? visible.columns.some(column => visible.cellText(row, column).toLowerCase().includes(needle))
    : Object.values(row).some(value => String(value ?? "").toLowerCase().includes(needle))));
  if (sort && result?.columns.includes(sort.column) && (!visible || visible.columns.includes(sort.column))) rows.sort((a, b) => {
    const left = a[sort.column], right = b[sort.column];
    const order = typeof left === "number" && typeof right === "number" ? left - right
      : String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true });
    return sort.descending ? -order : order;
  });
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.max(0, Math.min(pages - 1, Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0));
  const offset = page * pageSize;
  return { rows: rows.slice(offset, offset + pageSize), total: all.length, filtered: rows.length, page, pages,
    start: rows.length ? offset + 1 : 0, end: Math.min(offset + pageSize, rows.length) };
}
