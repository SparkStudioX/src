import type { NamedQuery, QueryRepeaterSource, QueryResult, Template, ResolvedTemplateRow, RuntimeParameters } from "./types";
import { coerceTemplateParameter, validateTemplateParameterTypes } from "./templateModel";

export interface RepeaterApi {
  <T>(path: string, method?: string, body?: unknown): Promise<T>;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const column = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= 128;

export function validateRepeaterSource(source: QueryRepeaterSource, template: Template): void {
  validateTemplateParameterTypes(template);
  if (!object(source) || Object.keys(source).length !== 3 || !column(source.queryId) || !column(source.rowKey) || !object(source.parameterMap))
    throw new Error("Choose a rows query, its row-key column, and a parameter mapping in Properties.");
  if (Object.keys(source.parameterMap).length > 64 || Object.entries(source.parameterMap).some(([parameter, field]) =>
    !Object.hasOwn(template.parameters, parameter) || !column(field)))
    throw new Error("Map at most 64 declared template parameters to nonempty column names of up to 128 characters.");
}

/** Reject the entire result if any row would create an ambiguous or incomplete form. */
export function queryRepeaterRows(result: QueryResult, source: QueryRepeaterSource, template: Template): ResolvedTemplateRow[] {
  validateRepeaterSource(source, template);
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) throw new Error("The rows query returned an invalid result.");
  if (result.rows.length > 100) throw new Error("The rows query returned more than 100 records. Narrow the query.");
  if (![source.rowKey, ...Object.values(source.parameterMap)].every(name => result.columns.includes(name)))
    throw new Error("The rows query must return its configured row-key and parameter columns.");
  const ids = new Set<string>();
  return result.rows.map(row => {
    if (!object(row)) throw new Error("The rows query returned an invalid record.");
    const id = Object.hasOwn(row, source.rowKey) ? row[source.rowKey] : undefined;
    if (typeof id !== "string" || !id.trim() || id.length > 200 || ids.has(id))
      throw new Error("Repeater row keys must be unique nonempty text values up to 200 characters.");
    ids.add(id);
    const parameters = Object.fromEntries(Object.entries(source.parameterMap).map(([name, field]) => {
      const value = Object.hasOwn(row, field) ? row[field] : undefined;
      if (typeof value === "string" && value.length > 4096) throw new Error(`Mapped template parameter '${name}' exceeds 4096 characters.`);
      return [name, coerceTemplateParameter(name, value,
        Object.hasOwn(template.parameterTypes ?? {}, name) ? template.parameterTypes![name] : "string")];
    }));
    return { id, parameters };
  });
}

/** Only declared screen/root query parameters are sent; missing values use saved query defaults. */
export async function loadQueryRepeater(
  source: QueryRepeaterSource, template: Template, scope: "designer" | "runtime",
  parameters: RuntimeParameters, request: RepeaterApi, publishedAt?: string,
): Promise<ResolvedTemplateRow[]> {
  validateRepeaterSource(source, template);
  const prefix = scope === "runtime" ? "/runtime" : "";
  const publication = scope === "runtime" ? publishedAt : undefined;
  const queries = await request<Pick<NamedQuery, "id" | "kind" | "parameters">[]>(`${prefix}/queries${publication === undefined ? "" : `?publishedAt=${encodeURIComponent(publication)}`}`);
  const query = queries.find(item => item.id === source.queryId);
  if (!query || query.kind === "update") throw new Error("The rows query is not available as a read query in this application.");
  const queryParameters = Object.fromEntries(query.parameters.filter(item => Object.hasOwn(parameters, item.name)).map(item => [item.name, parameters[item.name]]));
  const result = await request<QueryResult>(`${prefix}/queries/${encodeURIComponent(source.queryId)}/execute`, "POST", {
    parameters: queryParameters, ...(publication === undefined ? {} : { publishedAt: publication }),
  });
  return queryRepeaterRows(result, source, template);
}

/** React row identity resets only the form whose query context, values, or input contract changed. */
export function queryRowFormKey(queryKey: string, row: ResolvedTemplateRow, template: Template, parameters: RuntimeParameters): string {
  return JSON.stringify([queryKey, row.id, Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b)), template.id, template.parameterTypes,
    template.components.map(component => ({
      id: component.id, type: component.type, fieldKey: component.props.fieldKey,
      defaultValue: component.props.defaultValue, tagPath: component.props.tagPath,
      stateBinding: component.props.stateBinding,
      min: component.props.min, max: component.props.max, step: component.props.step,
      options: component.props.options, optionsSource: component.props.optionsSource,
      selectionFields: component.props.selectionFields, events: component.props.events,
    })),
  ]);
}
