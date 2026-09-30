import { resolveQueryPropertyParameters, validateQueryPropertyBinding, validateQueryPropertyParameters } from "./queryPropertyModel";
import type { QueryPropertyApi } from "./queryPropertyModel";
import type { BindingContext } from "./propertyBindings";
import type { CanvasComponent, Dataset, NamedQuery, QueryDatasetSource, RuntimeParameters } from "./types";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const safe = (value: unknown) => value === null || typeof value === "boolean" || typeof value === "string" && value.length <= 4096
  || typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));

/** Complete, rectangular, bounded data. Never silently truncate rows or turn missing cells into zero. */
export function validateDataset(value: unknown): Dataset {
  if (!object(value) || Object.keys(value).some(key => !["columns", "rows", "rowsAffected", "durationMs"].includes(key))
    || !Array.isArray(value.columns) || value.columns.length > 64 || !Array.isArray(value.rows) || value.rows.length > 1000)
    throw new Error("A dataset needs up to 64 columns and 1,000 rows.");
  const columns = value.columns;
  if (columns.some(name => typeof name !== "string" || !name.trim() || name.length > 128 || ["__proto__", "constructor", "prototype"].includes(name))
    || new Set(columns).size !== columns.length) throw new Error("Dataset columns must have unique, nonempty names up to 128 characters.");
  for (const row of value.rows) if (!object(row) || Object.keys(row).length !== columns.length
    || columns.some(name => !Object.hasOwn(row, name) || !safe(row[name])))
    throw new Error("Each dataset row must contain exactly its declared columns, using bounded text, exact finite numbers, Boolean values or null.");
  return { columns: columns as string[], rows: value.rows as Dataset["rows"] };
}

export function validateDatasetSource(source: QueryDatasetSource, component: CanvasComponent, context: BindingContext,
  queries?: NamedQuery[], allowUnresolvedScreenState = false): string | undefined {
  if (!object(source) || Object.keys(source).some(key => !["queryId", "parameters", "refresh"].includes(key)))
    return "A dataset source needs a read query, optional parameter expressions and refresh policy.";
  const bindings = { ...component.props.bindings }; delete bindings.text;
  return validateQueryPropertyBinding({ ...source, column: "dataset" }, "text", { ...component, props: { ...component.props, bindings } }, context, queries, allowUnresolvedScreenState);
}
export function resolveDatasetParameters(source: QueryDatasetSource, component: CanvasComponent, context: BindingContext): RuntimeParameters {
  const error = validateDatasetSource(source, component, context); if (error) throw new Error(error);
  return resolveQueryPropertyParameters({ ...source, column: "dataset" }, component, context);
}
export async function loadDataset(source: QueryDatasetSource, component: CanvasComponent, context: BindingContext,
  scope: "designer" | "runtime", request: QueryPropertyApi, publishedAt?: string, signal?: AbortSignal): Promise<Dataset> {
  const parameters = resolveDatasetParameters(source, component, context), prefix = scope === "runtime" ? "/runtime" : "";
  const publication = scope === "runtime" ? publishedAt : undefined;
  const timeout = AbortSignal.timeout(30000), cancellation = signal ? AbortSignal.any([signal, timeout]) : timeout;
  cancellation.throwIfAborted();
  const catalog = await request<NamedQuery[]>(`${prefix}/queries${publication === undefined ? "" : `?publishedAt=${encodeURIComponent(publication)}`}`, "GET", undefined, cancellation);
  cancellation.throwIfAborted(); validateQueryPropertyParameters(catalog.find(item => item.id === source.queryId), parameters);
  const result = await request<unknown>(`${prefix}/queries/${encodeURIComponent(source.queryId)}/execute`, "POST", { parameters, ...(publication === undefined ? {} : { publishedAt: publication }) }, cancellation);
  cancellation.throwIfAborted(); return validateDataset(result);
}
