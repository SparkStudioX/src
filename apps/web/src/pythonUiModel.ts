import type { StateContext } from "./applicationStateModel";
import type { AutomaticInputAssignment } from "./inputStateBindings";
import { inputAssignmentError } from "./inputEvents";
import { isInput } from "./inputs";
import type { CanvasComponent, InputValue, InstanceAction, PythonUiAction, PythonUiEffect, PythonUiLocalEffect, PythonUiProperty, PythonUiSnapshot, RuntimeParameters, ScriptResult, StateScope } from "./types";

export const pythonUiProperties: PythonUiProperty[] = ["text", "enabled", "visible", "color", "backgroundColor", "foregroundColor", "borderColor", "borderWidth", "fontSize"];
const own = (object: object, key: string) => Object.hasOwn(object, key);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const effectKey = (effect: PythonUiLocalEffect) => JSON.stringify(effect.kind === "state" ? ["state", effect.scope, effect.key] : ["property", effect.componentId, effect.property]);
const scalar = (value: unknown): value is InputValue => typeof value === "boolean" || typeof value === "string" && value.length <= 4096 ||
  typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
function target(components: CanvasComponent[], componentId: string, property: string) {
  const component = components.find(item => item.id === componentId);
  if (!component) throw new Error("A Python UI property target must be a component in the calling form.");
  if (component.type === "passwordInput" && (property === "text" || property === "value")) throw new Error("Python cannot access password text or values.");
  if (!pythonUiProperties.includes(property as PythonUiProperty)) throw new Error(`Python UI cannot change property '${property}'.`);
  if (own(component.props.bindings ?? {}, property) || own(component.props.queryBindings ?? {}, property))
    throw new Error(`Property '${componentId}.${property}' has a binding. Update its source value instead.`);
}
export function pythonInputWritable(component: CanvasComponent): boolean {
  return isInput(component.type) && component.type !== "passwordInput" && !component.props.stateBinding && !component.props.tagPath &&
    !component.props.optionsSource && !component.props.selectionFields && component.props.readOnly !== true &&
    !Object.hasOwn(component.props.bindings ?? {}, "value") && !Object.hasOwn(component.props.queryBindings ?? {}, "value");
}
function propertyValue(property: PythonUiProperty, value: unknown): value is InputValue {
  if (property === "text") return typeof value === "string" && value.length <= 4096;
  if (property === "enabled" || property === "visible") return typeof value === "boolean";
  if (property === "borderWidth" || property === "fontSize") return typeof value === "number" && Number.isFinite(value) &&
    value >= (property === "fontSize" ? 1 : 0) && value <= (property === "fontSize" ? 256 : 32);
  return typeof value === "string" && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value);
}
function bounded(value: unknown, bytes: number, label: string) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > bytes) throw new Error(`${label} exceeds ${bytes / 1024} KiB.`);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Local overrides are presentation values. Published bindings remain authoritative. */
export function applyPythonUiOverrides(component: CanvasComponent, context: StateContext | undefined): CanvasComponent {
  const overrides = context?.propertyOverrides;
  if (!overrides || !own(overrides, component.id)) return component;
  const values = overrides[component.id];
  const applied: Record<string, InputValue> = {};
  for (const [property, value] of Object.entries(values)) {
    // A later draft edit can add a binding without remounting the form.
    // Its source takes precedence over an override from an earlier action.
    try { target([component], component.id, property); } catch { continue; }
    if (!propertyValue(property as PythonUiProperty, value)) throw new Error("The stored Python UI property value is invalid.");
    applied[property] = value;
  }
  return { ...component, props: { ...component.props, ...applied } };
}

/** Captures one form and its revisions; neither snapshot nor effects convey authorization. */
export function capturePythonUiAction(context: StateContext, source: CanvasComponent[], isCurrent: () => boolean = () => true,
  form?: { assign: AutomaticInputAssignment | undefined; parameters: RuntimeParameters }): PythonUiAction {
  const components = structuredClone(source), snapshot = context.uiSnapshot(), revisions = new Map<string, number>();
  const inputCapture = form?.assign?.capturePythonInputs?.();
  const live = () => context.isCurrent() && isCurrent();
  if (!live()) throw new Error("This action's UI scope has closed.");
  for (const [scope, values] of Object.entries(snapshot.state)) {
    if (!["session", "screen", "instance"].includes(scope) || !record(values)) throw new Error("Invalid local UI state snapshot.");
    for (const [key, value] of Object.entries(values)) {
      if (!scalar(value)) throw new Error("Invalid local UI state value.");
      const effect: PythonUiLocalEffect = { kind: "state", scope: scope as StateScope, key, value };
      revisions.set(effectKey(effect), context.uiRevision(effect)!);
    }
  }
  for (const [componentId, properties] of Object.entries(snapshot.properties)) {
    for (const [property, value] of Object.entries(properties)) {
      try { target(components, componentId, property); } catch { delete properties[property as PythonUiProperty]; continue; }
      if (!propertyValue(property as PythonUiProperty, value)) throw new Error("Invalid local UI property snapshot.");
    }
    if (!Object.keys(properties).length) delete snapshot.properties[componentId];
  }
  for (const component of components) for (const property of pythonUiProperties) {
    const effect: PythonUiLocalEffect = { kind: "property", componentId: component.id, property, value: "" };
    revisions.set(effectKey(effect), context.uiRevision(effect)!);
  }
  bounded(snapshot, 256 * 1024, "Python UI snapshot");
  const ui = freeze(snapshot); let applied = false;
  return { ui, isCurrent: live, apply(raw) {
    if (!live()) throw new Error("This action's UI scope has closed. Its UI changes were discarded.");
    if (applied) throw new Error("This action's UI result was already applied.");
    if (raw === undefined) raw = [];
    if (!Array.isArray(raw) || raw.length > 128) throw new Error("Python UI effects must be an array of at most 128 changes.");
    const effects: PythonUiEffect[] = [];
    const inputValues: Record<string, InputValue> = {};
    for (const value of raw) {
      if (!record(value) || Object.keys(value).length !== (value.kind === "input" ? 3 : 4) || !own(value, "kind") || !own(value, "value")) throw new Error("Invalid Python UI effect.");
      if (value.kind === "state") {
        if (!own(value, "scope") || !own(value, "key") || typeof value.scope !== "string" || typeof value.key !== "string" ||
          !own(snapshot.state, value.scope)) throw new Error("Python UI state target is unavailable.");
        const state = snapshot.state[value.scope as StateScope];
        if (!state || !own(state, value.key) || !scalar(value.value) || typeof state[value.key] !== typeof value.value)
          throw new Error("Python UI state must match a declared value in the calling scope.");
        effects.push({ kind: "state", scope: value.scope as StateScope, key: value.key, value: value.value });
      } else if (value.kind === "property") {
        if (!own(value, "componentId") || !own(value, "property") || typeof value.componentId !== "string" || typeof value.property !== "string") throw new Error("Invalid Python UI property target.");
        target(components, value.componentId, value.property);
        if (!propertyValue(value.property as PythonUiProperty, value.value)) throw new Error(`Invalid Python UI value for '${value.property}'.`);
        effects.push({ kind: "property", componentId: value.componentId, property: value.property as PythonUiProperty, value: value.value });
      } else if (value.kind === "input") {
        if (!own(value, "componentId") || typeof value.componentId !== "string" || !inputCapture) throw new Error("Python input effects require a live form in the calling context.");
        const component = components.find(item => item.id === value.componentId);
        if (!component || !pythonInputWritable(component)) throw new Error("Python input assignments require an unbound non-password field in the calling form. Update a bound field's source instead.");
        if (!scalar(value.value)) throw new Error("Python input values must be finite typed scalars.");
        const field = component.props.fieldKey || component.id;
        const error = inputAssignmentError(components, field, value.value, form?.parameters);
        if (error) throw new Error(error);
        Object.defineProperty(inputValues, field, { value: value.value, enumerable: true, configurable: true, writable: true });
        effects.push({ kind: "input", componentId: component.id, value: value.value });
      } else throw new Error("Unknown Python UI effect kind.");
    }
    bounded(effects, 64 * 1024, "Python UI effects");
    const localEffects = effects.filter((effect): effect is PythonUiLocalEffect => effect.kind !== "input");
    const commitInputs = Object.keys(inputValues).length ? inputCapture!.prepare(inputValues) : undefined;
    context.commitUi(localEffects, localEffects.map(effect => revisions.get(effectKey(effect))!), commitInputs);
    applied = true;
  } };
}

export function pythonUiRequest(action: PythonUiAction | undefined): { ui?: PythonUiSnapshot } {
  if (!action) return {};
  if (!action.isCurrent()) throw new Error("This action's UI scope has closed.");
  return { ui: action.ui };
}

export function pythonUiPreviewContext(owner: { screenId: string } | { templateId: string }, componentId: string,
  instance?: Pick<InstanceAction, "instanceId" | "rowId" | "instancePath">) {
  return { ...owner, componentId, ...(instance?.instancePath ? { instancePath: structuredClone(instance.instancePath) }
    : instance ? { instanceId: instance.instanceId, ...(instance.rowId !== undefined ? { rowId: instance.rowId } : {}) } : {}) };
}

/** Gateway side effects have already happened when a successful result arrives. */
export function applyPythonUiResult(action: PythonUiAction | undefined, result: Pick<ScriptResult, "success" | "uiEffects">): void {
  if (!result.success) return;
  try {
    if (action) action.apply(result.uiEffects);
    else if (result.uiEffects?.length) throw new Error("The response has no live UI action context.");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} Gateway data changes may already have completed.`, { cause: error });
  }
}
