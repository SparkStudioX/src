import { resolvePath } from "./api";
import type {
  CanvasComponent,
  ComponentType,
  InstanceAction,
  InstancePathStep,
  Project,
  Template,
  RuntimeParameters,
  ParameterValue,
  TemplateParameterType,
} from "./types";

export function isTemplateInstance(type: ComponentType): boolean {
  return type === "template" || type === "repeater";
}

const numberText = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
const exactNumber = (value: number) => Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));

/** Coerce a resolved value once. Query strings stay literal and never interpolate braces. */
export function coerceTemplateParameter(name: string, value: unknown, type: TemplateParameterType = "string"): ParameterValue {
  if (type === "string") {
    if (typeof value === "string") return value;
    if (typeof value === "boolean" || typeof value === "number" && exactNumber(value)) return String(value);
    throw new Error(`Template parameter '${name}' requires text, a Boolean, or an exact finite number.`);
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`Template parameter '${name}' requires true or false.`);
  }
  if (type === "number") {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() === value && numberText.test(value) ? Number(value) : NaN;
    if (exactNumber(parsed)) return parsed;
    throw new Error(`Template parameter '${name}' requires an exact finite number in JSON number format.`);
  }
  throw new Error(`Template parameter '${name}' has an unsupported type.`);
}

export function validateTemplateParameterTypes(template: Template): void {
  if (template.parameterTypes === undefined) return;
  const types = template.parameterTypes;
  if (!types || typeof types !== "object" || Array.isArray(types) || Object.keys(types).length > 64)
    throw new Error("Template parameter types must be a map of at most 64 declared parameters.");
  for (const [name, type] of Object.entries(types))
    if (!Object.hasOwn(template.parameters, name) || !["string", "number", "boolean"].includes(type))
      throw new Error(`Template parameter '${name}' has an invalid type declaration.`);
}

function resolvedTemplateParameters(template: Template, root: RuntimeParameters, authored: Record<string, string>, literals: RuntimeParameters = {}): RuntimeParameters {
  validateTemplateParameterTypes(template);
  const saved: RuntimeParameters = { ...Object.fromEntries(Object.entries(authored).map(([name, value]) => [name, resolvePath(value, root)])), ...literals };
  return { ...root, ...Object.fromEntries(Object.entries(saved).map(([name, value]) => [name,
    coerceTemplateParameter(name, value, Object.hasOwn(template.parameterTypes ?? {}, name) ? template.parameterTypes![name] : "string")])) };
}

export function templateParameters(
  template: Template,
  root: RuntimeParameters,
  overrides: Record<string, string> = {},
  row: Record<string, string> = {},
  boundValues: RuntimeParameters = {},
): RuntimeParameters {
  const saved = { ...template.parameters, ...overrides };
  // Only root context is substituted, once, before template keys shadow it.
  const rowValues = Object.fromEntries(Object.entries(row).map(([name, value]) => [name, resolvePath(value, root)]));
  return resolvedTemplateParameters(template, root, saved, { ...boundValues, ...rowValues });
}

export function resolveTemplateParameters(template: Template, root: RuntimeParameters, overrides: Record<string, string> = {}, row: Record<string, string> = {}, boundValues: RuntimeParameters = {}):
  { parameters: RuntimeParameters; error?: undefined } | { parameters?: undefined; error: string } {
  try { return { parameters: templateParameters(template, root, overrides, row, boundValues) }; }
  catch (reason) { return { error: reason instanceof Error ? reason.message : String(reason) }; }
}

export function instanceInputKey(
  screenId: string,
  instanceId: string | InstancePathStep[],
  rowId?: string,
): string {
  const path = typeof instanceId === "string" ? [{ instanceId, ...(rowId === undefined ? {} : { rowId }) }] : instanceId;
  return path.length === 1
    ? JSON.stringify([screenId, path[0].instanceId, path[0].rowId ?? null])
    : JSON.stringify([screenId, path.map(step => [step.instanceId, step.rowId ?? null])]);
}

type InstanceIdentity = Pick<InstanceAction, "instanceId" | "rowId" | "instancePath" | "bindingInputs" | "bindingState">;

/** Legacy identities remain the first step, while nested requests carry the complete path. */
export function instancePath(instance?: InstanceIdentity): InstancePathStep[] {
  if (!instance) return [];
  return instance.instancePath ?? [{ instanceId: instance.instanceId, ...(instance.rowId === undefined ? {} : { rowId: instance.rowId }) }];
}

export function instanceRequestScope(instance?: InstanceIdentity): { instancePath?: InstancePathStep[]; instanceId?: string; rowId?: string; bindingInputs?: InstanceAction["bindingInputs"]; bindingState?: InstanceAction["bindingState"] } {
  if (!instance) return {};
  const path = instancePath(instance);
  return { ...(path.length > 1 ? { instancePath: path } : { ...path[0] }),
    ...(instance.bindingInputs ? { bindingInputs: instance.bindingInputs } : {}),
    ...(instance.bindingState ? { bindingState: instance.bindingState } : {}) };
}

/** Database row parameters overlay resolved saved defaults without a second substitution pass. */
export function queryTemplateParameters(
  template: Template, root: RuntimeParameters, overrides: Record<string, string> = {}, row: RuntimeParameters = {},
  boundValues: RuntimeParameters = {},
): RuntimeParameters {
  return resolvedTemplateParameters(template, root, { ...template.parameters, ...overrides }, { ...boundValues, ...row });
}

export function actionKey(
  componentId: string,
  instance?: InstanceIdentity,
): string {
  if (!instance) return componentId;
  const path = instancePath(instance);
  return path.length === 1 ? JSON.stringify([path[0].instanceId, path[0].rowId ?? null, componentId])
    : JSON.stringify([path.map(step => [step.instanceId, step.rowId ?? null]), componentId]);
}

export const MAX_TEMPLATE_DEPTH = 4;
export const MAX_EXPANDED_COMPONENTS = 10000;

/** Validate a picker candidate in the containing definition before adding its instance. */
export function templatePlacementError(templates: Template[], parentTemplateId: string | undefined, candidateTemplateId: string): string | undefined {
  const instance: CanvasComponent = { id: "placement", type: "template", x: 0, y: 0, width: 1, height: 1, props: { templateId: candidateTemplateId } };
  if (!parentTemplateId) return templateExpansion([instance], templates).error;
  // Definitions can have several callers, including definitions not placed on a
  // screen yet. Every incoming path must still fit after the proposed addition.
  const parents = new Map<string, Set<string>>();
  for (const template of templates) for (const component of template.components) {
    if (!isTemplateInstance(component.type) || !component.props.templateId) continue;
    const callers = parents.get(component.props.templateId) ?? new Set<string>();
    callers.add(template.id); parents.set(component.props.templateId, callers);
  }
  const memo = new Map<string, string[]>(), visiting = new Set<string>();
  const longestAncestors = (id: string): string[] => {
    if (visiting.has(id)) throw new Error(`Template cycle detected at '${id}'.`);
    const saved = memo.get(id);
    if (saved) return saved;
    if (visiting.size >= MAX_TEMPLATE_DEPTH) throw new Error(`Templates support at most ${MAX_TEMPLATE_DEPTH} levels.`);
    visiting.add(id);
    let longest = [id];
    for (const parent of parents.get(id) ?? []) {
      const chain = [...longestAncestors(parent), id];
      if (chain.length > MAX_TEMPLATE_DEPTH) throw new Error(`Templates support at most ${MAX_TEMPLATE_DEPTH} levels.`);
      if (chain.length > longest.length) longest = chain;
    }
    visiting.delete(id); memo.set(id, longest); return longest;
  };
  try { return templateExpansion([instance], templates, longestAncestors(parentTemplateId)).error; }
  catch (reason) { return reason instanceof Error ? reason.message : String(reason); }
}

/** Count with multiplication instead of materializing rows. Query roots reserve their maximum 100 rows. */
export function templateExpansion(components: CanvasComponent[], templates: Template[], ancestors: string[] = []): { count: number; error?: string } {
  const definitions = new Map(templates.map(template => [template.id, template]));
  type Metrics = { count: number; depth: number };
  const memo = new Map<string, Metrics>(), visiting = new Set<string>();
  const depthError = () => new Error(`Templates support at most ${MAX_TEMPLATE_DEPTH} levels.`);
  const definition = (id: string): Metrics => {
    const template = definitions.get(id);
    if (!template) throw new Error("The referenced template is unavailable.");
    if (visiting.has(id) || ancestors.includes(id)) throw new Error(`Template cycle detected at '${template.name || template.id}'.`);
    const saved = memo.get(id);
    if (saved) return saved;
    if (visiting.size >= MAX_TEMPLATE_DEPTH) throw depthError();
    visiting.add(id);
    const child = measure(template.components, true);
    const result = { count: child.count, depth: child.depth + 1 };
    if (result.depth + ancestors.length > MAX_TEMPLATE_DEPTH) throw depthError();
    visiting.delete(id); memo.set(id, result); return result;
  };
  const measure = (items: CanvasComponent[], nested: boolean): Metrics => {
    let count = 0, depth = 0;
    for (const component of items) {
      count++;
      if (isTemplateInstance(component.type)) {
        if (component.props.rowsSource && nested)
          throw new Error("Query-backed repeaters are only supported at the screen root.");
        const child = definition(component.props.templateId ?? "");
        const rows = component.type === "repeater" ? component.props.rowsSource ? 100 : (component.props.rows ?? []).length : 1;
        count += rows * child.count;
        depth = Math.max(depth, child.depth);
      }
      // Keep zero-row branches cheap and avoid integer overflow. Their definitions
      // still participate in missing-reference, cycle, depth and query validation.
      count = Math.min(count, MAX_EXPANDED_COMPONENTS + 1);
    }
    return { count, depth };
  };
  try {
    const result = measure(components, ancestors.length > 0);
    if (result.count > MAX_EXPANDED_COMPONENTS) throw new Error(`Template expansion exceeds ${MAX_EXPANDED_COMPONENTS.toLocaleString("en-US")} components.`);
    return { count: result.count };
  }
  catch (reason) { return { count: MAX_EXPANDED_COMPONENTS + 1, error: reason instanceof Error ? reason.message : String(reason) }; }
}

export function componentContexts(
  components: CanvasComponent[],
  templates: Template[],
  root: RuntimeParameters,
): { component: CanvasComponent; parameters: RuntimeParameters }[] {
  if (templateExpansion(components, templates).error) return [];
  const expand = (items: CanvasComponent[], context: RuntimeParameters): { component: CanvasComponent; parameters: RuntimeParameters }[] => items.flatMap((component) => {
    if (!isTemplateInstance(component.type))
      return [{ component, parameters: context }];
    const template = templates.find(
      (item) => item.id === component.props.templateId,
    );
    // This static helper enumerates authored parameter choices; a live parent
    // input is unavailable here, so do not advertise an authored fallback.
    if (!template || component.props.rowsSource || Object.keys(component.props.parameterBindings ?? {}).length) return [];
    const rows =
      component.type === "repeater" ? component.props.rows || [] : [undefined];
    return rows.flatMap((row) => {
      const resolved = resolveTemplateParameters(
        template,
        context,
        component.props.parameters,
        row?.parameters,
      );
      if (resolved.error) return [];
      const parameters = resolved.parameters!;
      return expand(template.components, parameters);
    });
  });
  return expand(components, root);
}

// Synchronous authoring changes must invalidate edits before another action can run.
// Geometry is excluded, so moving a form does not discard typed preview values.
export function projectInputContext(project: Project): string {
  const form = (components: CanvasComponent[]) =>
    components.map((component) => ({
      id: component.id,
      type: component.type,
      fieldKey: component.props.fieldKey,
      tagPath: component.props.tagPath,
      stateBinding: component.props.stateBinding,
      defaultValue: component.props.defaultValue,
      templateId: component.props.templateId,
      parameters: component.props.parameters,
      parameterBindings: component.props.parameterBindings,
      rows: component.props.rows,
      rowsSource: component.props.rowsSource,
    }));
  return JSON.stringify({
    parameters: project.parameters,
    screens: project.screens.map((screen) => ({
      id: screen.id,
      parameters: screen.parameters,
      components: form(screen.components),
    })),
    templates: (project.templates || []).map((template) => ({
      id: template.id,
      parameters: template.parameters,
      parameterTypes: template.parameterTypes,
      components: form(template.components),
    })),
  });
}
