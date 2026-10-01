import catalog from "./runtimeProperties.json";
import type { BindingTarget, CanvasComponent, ComponentType } from "./types";
import { buildChart, chartDefinitionError } from "./chartModel";
import { validateDrawingProps } from "./drawingComponents";
import { inputDefinitionError } from "./inputValidation";
import { validateListTreeOptions } from "./listTreeModel";
import { validateTableColumns } from "./tableColumnValidation";
import { viewLayoutError } from "./viewContainers";
import { imageUrlError } from "./imageSource";

export interface RuntimePropertyDefinition {
  path: string; label: string; type: "string" | "number" | "boolean" | "scalar" | "color" | "tagPath" | "json";
  components: string[]; default?: unknown; min?: number; max?: number; integer?: boolean; exclusiveMin?: boolean;
  minLength?: number; maxLength?: number; enum?: string[]; schema?: string; pattern?: string;
}
export const runtimePropertyDefinitions = catalog.properties as RuntimePropertyDefinition[];
export const maximumRuntimeBindings = catalog.maxBindings;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const precise = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
const hex = (value: unknown) => typeof value === "string" && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value);
const text = (value: unknown, max: number, min = 1): value is string => typeof value === "string" && value.length <= max && value.trim().length >= min;
const fail = (message: string): never => { throw new Error(message); };

export function customPropertyKey(target: string): string | undefined {
  const match = /^customProperties\.([A-Za-z_][A-Za-z0-9_]{0,63})\.value$/.exec(target);
  return match && !forbidden.has(match[1]) && !["true", "false", "null"].includes(match[1]) ? match[1] : undefined;
}
/** Every writable path is registered; wildcard paths address existing authored panes only. */
export function runtimePropertyDefinition(target: string, component?: CanvasComponent | ComponentType): RuntimePropertyDefinition | undefined {
  const type = typeof component === "string" ? component : component?.type;
  if (target === "data" && component && typeof component !== "string" && component.props.tableEdit) return undefined;
  const custom = customPropertyKey(target);
  if (custom) {
    if (!component || typeof component === "string" || !own(component.props.customProperties ?? {}, custom)) return undefined;
    const definition = component.props.customProperties![custom];
    if (!definition || !["string", "number", "boolean"].includes(definition.type)) return undefined;
    return { path: target, label: `Custom › ${custom}`, type: definition.type, components: [component.type], default: definition.value, maxLength: 4096 };
  }
  const pane = /^viewLayout\.panes\.(0|[1-9]\d?)\.(label|size|edge)$/.exec(target);
  const path = pane ? `viewLayout.panes.*.${pane[2]}` : target;
  const definition = runtimePropertyDefinitions.find(item => item.path === path);
  if (!definition || type && !definition.components.includes("*") && !definition.components.includes(type)) return undefined;
  if (pane && component && typeof component !== "string") {
    const layout = component.props.viewLayout, index = Number(pane[1]);
    if (!layout?.panes[index] || pane[2] !== "label" && layout.kind !== "dock" || pane[2] === "size" && layout.panes[index].edge === "center") return undefined;
    return { ...definition, path: target, label: `Pane ${index + 1} › ${pane[2]}` };
  }
  if (definition.path.includes("*")) return undefined;
  return definition;
}
export function runtimeBindingTargets(component: CanvasComponent): BindingTarget[] {
  const targets: BindingTarget[] = [];
  for (const definition of runtimePropertyDefinitions) {
    if (definition.path.includes("*")) {
      (component.props.viewLayout?.panes ?? []).forEach((_pane, index) => {
        const path = definition.path.replace("*", String(index));
        if (runtimePropertyDefinition(path, component)) targets.push(path as BindingTarget);
      });
    } else if (runtimePropertyDefinition(definition.path, component)) targets.push(definition.path as BindingTarget);
  }
  for (const key of Object.keys(component.props.customProperties ?? {})) {
    const target = `customProperties.${key}.value` as BindingTarget;
    if (runtimePropertyDefinition(target, component)) targets.push(target);
  }
  return targets;
}
export function runtimePropertyLabel(target: string, component?: CanvasComponent): string { return runtimePropertyDefinition(target, component)?.label ?? target; }
export function runtimePropertyValue(component: CanvasComponent, target: string): unknown {
  if (["x", "y", "width", "height"].includes(target)) return component[target as "x"];
  let value: unknown = component.props;
  for (const key of target.split(".")) {
    if (forbidden.has(key) || !value || typeof value !== "object" || !own(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
/** Copies just the addressed ancestry, including arrays; authored objects never change. */
export function withRuntimeProperty(component: CanvasComponent, target: string, value: unknown): CanvasComponent {
  if (["x", "y", "width", "height"].includes(target)) return { ...component, [target]: value };
  const keys = target.split(".");
  if (keys.some(key => forbidden.has(key) || !/^(?:[A-Za-z_][A-Za-z0-9_]*|0|[1-9]\d?)$/.test(key))) fail("Unsupported runtime property path.");
  const update = (source: unknown, index: number): unknown => {
    const result: Record<string, unknown> | unknown[] = Array.isArray(source) ? [...source] : object(source) ? { ...source } : {};
    const key = keys[index];
    (result as Record<string, unknown>)[key] = index === keys.length - 1 ? value : update((result as Record<string, unknown>)[key], index + 1);
    return result;
  };
  return { ...component, props: update(component.props, 0) as CanvasComponent["props"] };
}

function validateJsonTree(value: unknown, depth = 0): void {
  if (depth > 12) fail("Structured runtime values support at most 12 levels.");
  if (value === null || typeof value === "boolean" || precise(value) || typeof value === "string" && value.length <= 4096) return;
  if (Array.isArray(value)) { if (value.length > 1000) fail("Structured arrays allow at most 1,000 entries."); value.forEach(item => validateJsonTree(item, depth + 1)); return; }
  if (!object(value) || Object.keys(value).length > 128) fail("Structured values require bounded JSON objects.");
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key) || key.length > 256) fail("Structured values contain an unsafe property name.");
    validateJsonTree(entry, depth + 1);
  }
}
function validateStructured(schema: string | undefined, value: unknown, component?: CanvasComponent): void {
  if (schema === "dataset") {
    if (!object(value) || Object.keys(value).some(key => !["columns", "rows"].includes(key)) || !Array.isArray(value.columns) || !Array.isArray(value.rows) || value.columns.length > 64 || value.rows.length > 1000) fail("A dataset needs up to 64 columns and 1,000 rows.");
    const data = value as Record<string, unknown>, columns = data.columns as unknown[], rows = data.rows as unknown[];
    if (columns.some(key => !text(key, 128) || forbidden.has(key)) || new Set(columns).size !== columns.length) fail("Dataset columns must be unique bounded names.");
    for (const row of rows) if (!object(row) || Object.keys(row).some(key => !columns.includes(key)) || columns.some(key => !own(row, key as string)) || Object.values(row).some(item => item !== null && typeof item !== "string" && typeof item !== "boolean" && !precise(item))) fail("Dataset rows need one scalar or null cell for each column.");
    return;
  }
  if (!Array.isArray(value)) fail("This runtime property needs a JSON array.");
  const entries = value as unknown[];
  if (schema === "options") {
    const type = component?.type;
    validateListTreeOptions(type === "treeView" ? "treeView" : "list", entries);
    if (type === "multiStateButton" && (entries.length < 2 || entries.length > 32)) fail("A multi-state button needs 2–32 options.");
  } else if (schema === "states") {
    if (entries.length < 1 || entries.length > 32 || entries.some(item => !object(item) || Object.keys(item).length !== 3 || !text(item.value, 128) || !text(item.label, 128) || !hex(item.color)) || new Set(entries.map(item => (item as Record<string, unknown>).value)).size !== entries.length) fail("Configure 1–32 unique states with labels and hex colors.");
  } else if (schema === "points") {
    const error = validateDrawingProps(component?.type ?? "polyline", { points: entries }); if (error) fail(error);
  } else if (schema === "tableColumns") {
    const error = validateTableColumns(entries); if (error) fail(error);
  } else if (schema === "historyPaths") {
    if (entries.length < 1 || entries.length > 8 || entries.some(path => !text(path, 1024) || !/^\[[^\]]+\].+/.test(path) || /[\u0000-\u001f\u007f{}]/.test(path)) || new Set(entries).size !== entries.length) fail("History needs 1–8 unique, fully resolved tag paths including a provider.");
  } else if (schema === "chartSeries") {
    const error = chartDefinitionError({ kind: "line", xKey: "x", series: entries }); if (error) fail(error);
  } else fail("Unknown structured runtime property schema.");
}
/** Structured values are JSON text carried by the same bounded scalar expression/query contract. */
export function normalizeRuntimePropertyValue(target: string, value: unknown, component?: CanvasComponent): unknown {
  const definition = runtimePropertyDefinition(target, component);
  if (!definition) fail(`${target} is not a supported runtime property${component ? ` on ${component.type}` : ""}.`);
  const spec = definition!;
  if (spec.type === "json") {
    if (typeof value !== "string" || value.length > catalog.structuredTextMaxLength) fail("Structured bindings must produce JSON text up to 4096 characters.");
    let decoded: unknown;
    try { decoded = JSON.parse(value as string); } catch { return fail("A structured binding must produce valid JSON text."); }
    validateJsonTree(decoded); validateStructured(spec.schema, decoded, component); return decoded;
  }
  if (spec.type === "scalar") {
    if (typeof value !== "boolean" && !precise(value) && !(typeof value === "string" && value.length <= 4096)) fail("A binding value must be finite number, Boolean, or text up to 4096 characters.");
    return String(value);
  }
  if (spec.type === "number") {
    if (!precise(value) || spec.integer && !Number.isInteger(value) || spec.min !== undefined && (spec.exclusiveMin ? value <= spec.min : value < spec.min) || spec.max !== undefined && value > spec.max) fail(`${target} must produce ${spec.integer ? "a whole" : "a finite"} number${spec.min !== undefined ? ` ${spec.exclusiveMin ? "above" : "from"} ${spec.min}` : ""}${spec.max !== undefined ? ` to ${spec.max}` : ""}.`);
  } else if (spec.type === "boolean") { if (typeof value !== "boolean") fail(`${target} must produce a Boolean.`); }
  else if (spec.type === "color") { if (!hex(value) && !spec.enum?.includes(value as string)) fail("A color binding must produce a hex color: #RGB, #RGBA, #RRGGBB or #RRGGBBAA."); }
  else {
    if (typeof value !== "string" || value.length > (spec.maxLength ?? 4096) || spec.minLength !== undefined && value.trim().length < spec.minLength) fail(`${target} must produce text${spec.maxLength ? ` up to ${spec.maxLength} characters` : ""}.`);
    if (spec.enum && !spec.enum.includes(value as string)) fail(`${target} must produce ${spec.enum.map(item => `'${item}'`).join(", ")}.`);
    if (spec.pattern && !new RegExp(spec.pattern).test(value as string)) fail(`${target} must produce a valid stored asset content ID.`);
    if (target === "imageUrl") {
      const error = imageUrlError(value, typeof window === "undefined" ? undefined : window.location.origin);
      if (error) fail(error);
    }
    if (spec.type === "tagPath" && (!(value as string).trim() || /[\u0000-\u001f\u007f{}]/.test(value as string))) fail("A tag path binding must produce a complete path of 1–1024 characters without control characters or unresolved parameters.");
  }
  return value;
}

/** Validate related resolved fields together so two bound limits can move atomically. */
export function runtimePropertyGroupErrors(component: CanvasComponent, targets: readonly string[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const group = (accept: (target: string) => boolean, error: string | null | undefined) => { if (error) for (const target of targets.filter(accept)) errors[target] = error; };
  if (["chart", "sparkline"].includes(component.type) && targets.some(target => target.startsWith("chart.") || target === "data")) {
    const error = chartDefinitionError(component.props.chart)
      ?? (component.props.chart && component.props.data && !component.props.dataSource ? buildChart(component.props.chart, component.props.data).error : undefined);
    group(target => target.startsWith("chart.") || target === "data", error);
  }
  if (targets.some(target => target.startsWith("viewLayout."))) group(target => target.startsWith("viewLayout."), viewLayoutError(component.props.viewLayout));
  if (targets.some(target => target.startsWith("validation.") || ["formatMask", "textCase", "scanTerminator"].includes(target))) group(target => target.startsWith("validation.") || ["formatMask", "textCase", "scanTerminator"].includes(target), inputDefinitionError(component));
  if (targets.some(target => ["min", "max"].includes(target))) {
    const { min, max } = component.props;
    const allowEqual = component.type === "numberInput" || component.type === "spinner";
    const lower = min ?? (["numberInput", "spinner"].includes(component.type) ? undefined : 0), upper = max ?? (["numberInput", "spinner"].includes(component.type) ? undefined : 100);
    if (lower !== undefined && upper !== undefined && (allowEqual ? lower > upper : lower >= upper)) group(target => target === "min" || target === "max", "Minimum must be less than maximum.");
  }
  if (targets.includes("selectionMode") && component.props.tableEdit?.batch && component.props.selectionMode !== "multiple") errors.selectionMode = "Atomic batch editing requires multiple selection.";
  return errors;
}
