import type { RuntimeParameters } from "./types";
import { isInput, isSafeNumber, validateInputs } from "./inputs";
import { validateListTreeOptions } from "./listTreeModel";
import type { CanvasComponent, InputValue, NamedQuery, QueryOptionsSource, QueryResult } from "./types";

export interface QueryOption { value: string; label: string; parentValue?: string; row: Record<string, unknown> }
export interface OptionsApi {
  <T>(path: string, method?: string, body?: unknown): Promise<T>;
}

function optionText(value: unknown, maximum: number, name: string): string {
  if (typeof value !== "string" && !isSafeNumber(value)) throw new Error(`${name} must contain text or an exact finite number.`);
  const text = String(value);
  if (!text.trim() || text.length > maximum) throw new Error(`${name} must contain 1–${maximum} characters.`);
  return text;
}

/** Reject ambiguous or incomplete results; never truncate or coerce null into a choice. */
export function queryOptions(result: QueryResult, source: QueryOptionsSource): QueryOption[] {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) throw new Error("The options query returned an invalid result.");
  if (result.rows.length > 500) throw new Error("The options query returned more than 500 rows. Narrow the query.");
  if (!result.columns.includes(source.valueColumn) || !result.columns.includes(source.labelColumn) || source.parentColumn !== undefined && !result.columns.includes(source.parentColumn))
    throw new Error("The options query must return the configured value and label columns.");
  const values = new Set<string>();
  const options = result.rows.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("The options query returned an invalid row.");
    const value = optionText(Object.hasOwn(row, source.valueColumn) ? row[source.valueColumn] : undefined, 4096, "Option values");
    const label = optionText(Object.hasOwn(row, source.labelColumn) ? row[source.labelColumn] : undefined, 200, "Option labels");
    if (values.has(value)) throw new Error("The options query returned duplicate values. Each option needs a unique value.");
    values.add(value);
    let parentValue: string | undefined;
    if (source.parentColumn !== undefined) {
      if (!Object.hasOwn(row, source.parentColumn)) throw new Error("The options query returned a row without its parent column.");
      const parent = row[source.parentColumn];
      if (parent !== null && parent !== "") parentValue = optionText(parent, 4096, "Parent values");
    }
    return { value, label, ...(parentValue === undefined ? {} : { parentValue }), row };
  });
  if (source.parentColumn !== undefined) validateListTreeOptions("treeView", options.map(({ value, label, parentValue }) => ({ value, label, ...(parentValue === undefined ? {} : { parentValue }) })), 500);
  return options;
}

/** Only declared context parameters are sent; omitted values use gateway defaults. */
export async function loadQueryOptions(
  source: QueryOptionsSource, scope: "designer" | "runtime", parameters: RuntimeParameters, request: OptionsApi,
  publishedAt?: string,
): Promise<QueryOption[]> {
  if (!source.queryId || !source.valueColumn || !source.labelColumn) throw new Error("Choose an options query and its value and label columns in Properties.");
  const prefix = scope === "runtime" ? "/runtime" : "";
  const publication = scope === "runtime" && publishedAt !== undefined ? publishedAt : undefined;
  const queries = await request<Pick<NamedQuery, "id" | "kind" | "parameters">[]>(`${prefix}/queries${publication === undefined ? "" : `?publishedAt=${encodeURIComponent(publication)}`}`);
  const query = queries.find(item => item.id === source.queryId);
  if (!query || query.kind === "update") throw new Error("The options query is not available as a read query in this application.");
  const queryParameters = Object.fromEntries(query.parameters.filter(item => Object.hasOwn(parameters, item.name)).map(item => [item.name, parameters[item.name]]));
  const result = await request<QueryResult>(`${prefix}/queries/${encodeURIComponent(source.queryId)}/execute`, "POST", { parameters: queryParameters, ...(publication === undefined ? {} : { publishedAt: publication }) });
  return queryOptions(result, source);
}

/** Check every target before applying any change so an invalid row cannot partly overwrite a form. */
export function querySelectionChanges(option: QueryOption, component: CanvasComponent, components: CanvasComponent[]): [string, InputValue][] {
  const changes: [string, InputValue][] = [];
  const ownKey = component.props.fieldKey || component.id;
  for (const [field, column] of Object.entries(component.props.selectionFields ?? {})) {
    if (field === ownKey) throw new Error("The selection value field cannot also be a mapped field.");
    const targets = components.filter(item => isInput(item.type) && (item.props.fieldKey || item.id) === field);
    if (targets.length !== 1) throw new Error(`Mapped field ${field} must name one input in this form.`);
    const value = Object.hasOwn(option.row, column) ? option.row[column] : undefined;
    if (typeof value !== "string" && typeof value !== "boolean" && !isSafeNumber(value))
      throw new Error(`Column ${column} has no usable form value.`);
    const error = validateInputs({ id: "selection", name: "Selection", width: 1, height: 1, components: targets }, { [field]: value });
    if (error) throw new Error(error);
    changes.push([field, value]);
  }
  return changes;
}
