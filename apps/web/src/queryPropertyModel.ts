import { bindingTargets, constantPropertyBinding, evaluatePropertyBinding, supportsBindingTarget, validateBindingTargetValue, validateComponentBindingRange, validatePropertyBinding } from "./propertyBindings";
import type { BindingContext } from "./propertyBindings";
import { validateTemplateParameterBinding } from "./templateParameterBindings";
import { isInput, validateInputs } from "./inputs";
import type { BindingTarget, CanvasComponent, NamedQuery, ParameterValue, QueryParameter, QueryPropertyBinding, QueryResult, RuntimeParameters } from "./types";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const name = (value: unknown, max: number): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= max;
const scalar = (value: unknown): value is ParameterValue => typeof value === "boolean" || typeof value === "string" && value.length <= 4096
  || typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
const fail = (message: string): never => { throw new Error(message); };
export interface QueryPropertyApi { <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal): Promise<T> }

export function queryParameterValue(parameter: QueryParameter, value: unknown): ParameterValue {
  const type = (parameter.type ?? "string").toLowerCase();
  const text = ["string", "nvarchar", "date", "datetime", "datetime2", "datetimeoffset", "guid", "uniqueidentifier"].includes(type);
  const integer = ["int", "int32", "integer", "long", "int64", "bigint"].includes(type);
  const number = integer || ["number", "double", "float", "decimal"].includes(type);
  const boolean = ["bool", "boolean", "bit"].includes(type);
  if (!scalar(value) || text && typeof value !== "string" || number && typeof value !== "number" || boolean && typeof value !== "boolean"
    || integer && !Number.isSafeInteger(value) || ["int", "int32", "integer"].includes(type) && (Number(value) < -2147483648 || Number(value) > 2147483647)
    || !text && !number && !boolean) fail(`Query parameter '${parameter.name}' requires a valid ${parameter.type} value without implicit conversion.`);
  return value as ParameterValue;
}

export function validateQueryPropertyBinding(binding: QueryPropertyBinding, target: BindingTarget, component: CanvasComponent,
  context: BindingContext, queries?: NamedQuery[], allowUnresolvedScreenState = false): string | undefined {
  try {
    if (!object(binding) || Object.keys(binding).some(key => !["queryId", "column", "transform", "parameters", "refresh"].includes(key))
      || !name(binding.queryId, 256) || !name(binding.column, 128)) fail("Choose a query and a nonempty result column of up to 128 characters.");
    if (!bindingTargets.includes(target) || !supportsBindingTarget(component.type, target)) fail(`Query bindings are not supported for ${target} on ${component.type}.`);
    if (Object.hasOwn(component.props.bindings ?? {}, target)) fail("Choose an expression or a query for this property, not both.");
    if (binding.transform !== undefined) {
      const expression = { expression: binding.transform, references: { value: { kind: "custom" as const, key: "value" } } };
      const error = validatePropertyBinding(expression); if (error) fail(error);
      const constant = constantPropertyBinding(expression); if (constant.constant) validateBindingTargetValue(target, constant.value);
    }
    if (target === "min" || target === "max") validateComponentBindingRange({ ...component,
      props: { ...component.props, queryBindings: { ...component.props.queryBindings, [target]: binding } } });
    if (binding.refresh !== undefined && (!object(binding.refresh) || !["onChange", "poll"].includes(binding.refresh.mode)
      || Object.keys(binding.refresh).some(key => !["mode", "intervalMs"].includes(key))
      || binding.refresh.mode === "onChange" && binding.refresh.intervalMs !== undefined
      || binding.refresh.mode === "poll" && (!Number.isInteger(binding.refresh.intervalMs) || binding.refresh.intervalMs! < 1000 || binding.refresh.intervalMs! > 3600000)))
      fail("Refresh must be on change, or polling every 1,000–3,600,000 milliseconds.");
    if (binding.parameters !== undefined && (!object(binding.parameters) || Object.keys(binding.parameters).length > 128)) fail("Query mappings need at most 128 declared parameters.");
    const query = queries?.find(item => item.id === binding.queryId);
    if (queries && (!query || query.kind === "update")) fail("Choose an available read query.");
    if (query) for (const parameter of query.parameters) if (!Object.hasOwn(binding.parameters ?? {}, parameter.name) && !Object.hasOwn(parameter, "defaultValue"))
      fail(`Query parameter '${parameter.name}' needs a mapping or a saved default.`);
    for (const [key, expression] of Object.entries(binding.parameters ?? {})) {
      if (Object.values(expression.references ?? {}).some(reference => reference.kind === "tag")) fail("Query parameter expressions cannot reference tags.");
      if (!/^@?[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || key.length > 129) fail(`Query parameter '${key}' has an invalid name.`);
      const error = validateTemplateParameterBinding(expression, component, context.components, context.parameters, key, "string", context.state, allowUnresolvedScreenState);
      if (error) fail(`${key}: ${error}`);
      const parameter = query?.parameters.find(item => item.name === key);
      if (query && !parameter) fail(`Query parameter '${key}' is not declared.`);
      const constant = constantPropertyBinding(expression);
      if (constant.constant && parameter) queryParameterValue(parameter, constant.value);
    }
    return undefined;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

/** No tag/query recursion or parent/child data ambiguity. Check unused aliases too. */
export function resolveQueryPropertyParameters(binding: QueryPropertyBinding, component: CanvasComponent, context: BindingContext): RuntimeParameters {
  return Object.fromEntries(Object.entries(binding.parameters ?? {}).map(([key, expression]) => {
    if (Object.values(expression.references ?? {}).some(reference => reference.kind === "tag")) fail("Query parameter expressions cannot reference tags.");
    const error = validateTemplateParameterBinding(expression, component, context.components, context.parameters, key, "string", context.state);
    if (error) fail(`${key}: ${error}`);
    for (const [alias, reference] of Object.entries(expression.references)) {
      evaluatePropertyBinding({ expression: alias, references: { [alias]: reference } }, component, context);
      if (reference.kind === "input") {
        const input = context.components.find(item => isInput(item.type) && (item.props.fieldKey || item.id) === reference.key)!;
        const error = validateInputs({ id: "query-source", name: "Query source", width: 1, height: 1, components: [input] }, context.inputs, context.parameters);
        if (error) fail(error);
      }
    }
    return [key, evaluatePropertyBinding(expression, component, context).value];
  }));
}

export function queryPropertyValue(result: QueryResult, column: string): ParameterValue {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) fail("The query returned an invalid result.");
  if (result.rows.length !== 1) fail(`A scalar property query must return exactly one row; received ${result.rows.length}.`);
  const row = result.rows[0];
  if (!result.columns.includes(column) || !object(row) || !Object.hasOwn(row, column)) fail(`The query did not return column '${column}'.`);
  const value = row[column];
  if (!scalar(value)) fail(`Query column '${column}' requires non-null text up to 4096 characters, a Boolean, or an exact finite number.`);
  return value as ParameterValue;
}

export function transformQueryPropertyValue(value: ParameterValue, transform: string | undefined, target: BindingTarget): ParameterValue {
  if (!scalar(value)) fail("The query result has no valid scalar value.");
  const component: CanvasComponent = { id: "query-result", type: "label", x: 0, y: 0, width: 1, height: 1,
    props: { customProperties: { value: { type: typeof value as "string" | "number" | "boolean", value } } } };
  const result = transform === undefined ? value : evaluatePropertyBinding({ expression: transform, references: { value: { kind: "custom", key: "value" } } }, component,
    { components: [component], tags: [], parameters: {}, inputs: {} }).value;
  validateBindingTargetValue(target, result);
  return target === "text" || target === "stateValue" ? String(result) : result;
}

export function validateQueryPropertyParameters(query: Pick<NamedQuery, "kind" | "parameters"> | undefined, values: RuntimeParameters): void {
  if (!query || query.kind === "update") fail("The named query is unavailable as a read query.");
  for (const parameter of query!.parameters) if (!Object.hasOwn(values, parameter.name) && !Object.hasOwn(parameter, "defaultValue"))
    fail(`Query parameter '${parameter.name}' needs a mapping or a saved default.`);
  for (const [key, value] of Object.entries(values)) {
    const parameter = query!.parameters.find(item => item.name === key);
    if (!parameter) fail(`Query parameter '${key}' is not declared.`);
    queryParameterValue(parameter!, value);
  }
}

export async function loadQueryProperty(binding: QueryPropertyBinding, target: BindingTarget, component: CanvasComponent,
  context: BindingContext, scope: "designer" | "runtime", request: QueryPropertyApi, publishedAt?: string, signal?: AbortSignal): Promise<ParameterValue> {
  const error = validateQueryPropertyBinding(binding, target, component, context); if (error) fail(error);
  const parameters = resolveQueryPropertyParameters(binding, component, context), prefix = scope === "runtime" ? "/runtime" : "";
  const publication = scope === "runtime" ? publishedAt : undefined;
  const deadline = new AbortController(), readSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timeout = setTimeout(() => deadline.abort(new Error("Query property preview timed out after 30 seconds.")), 30000);
  const read = <T,>(pending: Promise<T>) => new Promise<T>((resolve, reject) => {
    const abort = () => { readSignal.removeEventListener("abort", abort); reject(readSignal.reason ?? new Error("Query preview was cancelled.")); };
    readSignal.addEventListener("abort", abort, { once: true }); if (readSignal.aborted) abort();
    pending.then(value => { readSignal.removeEventListener("abort", abort); resolve(value); }, error => { readSignal.removeEventListener("abort", abort); reject(error); });
  });
  try {
    readSignal.throwIfAborted();
    const catalog = await read(request<NamedQuery[]>(`${prefix}/queries${publication === undefined ? "" : `?publishedAt=${encodeURIComponent(publication)}`}`, "GET", undefined, readSignal));
    validateQueryPropertyParameters(catalog.find(item => item.id === binding.queryId), parameters); readSignal.throwIfAborted();
    const result = await read(request<QueryResult>(`${prefix}/queries/${encodeURIComponent(binding.queryId)}/execute`, "POST", { parameters, ...(publication === undefined ? {} : { publishedAt: publication }) }, readSignal));
    readSignal.throwIfAborted(); return transformQueryPropertyValue(queryPropertyValue(result, binding.column), binding.transform, target);
  } finally { clearTimeout(timeout); }
}
