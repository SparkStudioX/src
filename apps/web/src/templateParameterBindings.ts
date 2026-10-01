import { bindingReferenceDependencies, constantPropertyBinding, evaluatePropertyBinding, validatePropertyBinding, validateTagAddress } from "./propertyBindings";
import type { BindingContext } from "./propertyBindings";
import { coerceTemplateParameter } from "./templateModel";
import { isInput, validateInputs } from "./inputs";
import type { CanvasComponent, InputValues, ParameterBindingState, PropertyBinding, RuntimeParameters, RuntimeStateValues, StateDefinitions, Template, TemplateParameterType } from "./types";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, name: string) => Object.hasOwn(value, name);
const stateScopes = { sessionState: "session", screenState: "screen", instanceState: "instance" } as const;
const boundedScalar = (value: unknown): value is string | number | boolean => typeof value === "boolean"
  || typeof value === "string" && value.length <= 4096
  || typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
const sourceStateValue = (state: Partial<RuntimeStateValues> | undefined, scope: keyof RuntimeStateValues, key: string) => {
  const values = state?.[scope];
  if (!object(values) || !own(values, key)) throw new Error(`Parent ${scope} state '${key}' is unavailable.`);
  const value = values[key];
  if (!boundedScalar(value)) throw new Error(`Parent ${scope} state '${key}' requires text up to 4096 characters, a Boolean, or an exact finite number.`);
  return value;
};

/** References always read the containing form, before the child shadows parameters. */
export function validateTemplateParameterBinding(binding: PropertyBinding, component: CanvasComponent,
  components: CanvasComponent[], parentParameters: RuntimeParameters, targetName: string, type: TemplateParameterType,
  state?: RuntimeStateValues, allowUnresolvedScreenState = false): string | undefined {
  try {
    const error = validatePropertyBinding(binding);
    if (error) throw new Error(error);
    for (const { reference, component: ownerComponent } of bindingReferenceDependencies(binding, component, { components })) {
      if (reference.kind === "parameter") {
        if (!own(parentParameters, reference.key)) throw new Error(`Parent parameter '${reference.key}' is not declared.`);
      } else if (reference.kind === "input") {
        const input = components.find(item => isInput(item.type) && (item.props.fieldKey || item.id) === reference.key);
        if (!input || input.type === "passwordInput") throw new Error(`Input '${reference.key}' must be a non-password input in the containing form.`);
      } else if (reference.kind === "custom") {
        const owner = reference.componentId === undefined || reference.componentId === ownerComponent.id ? ownerComponent : components.find(item => item.id === reference.componentId);
        if (!owner?.props.customProperties || !own(owner.props.customProperties, reference.key)) throw new Error(`Custom property '${reference.key}' was not found in the containing form.`);
      } else if (reference.kind === "sessionState" || reference.kind === "screenState" || reference.kind === "instanceState") {
        const scope = stateScopes[reference.kind];
        if (!(scope === "screen" && allowUnresolvedScreenState && !own(state?.screen ?? {}, reference.key)))
          sourceStateValue(state, scope, reference.key);
      } else if (reference.kind === "tag") {
        validateTagAddress(reference.path, parentParameters);
      } else throw new Error("Unsupported template parameter source.");
    }
    const result = constantPropertyBinding(binding);
    if (result.constant) {
      coerceTemplateParameter(targetName, result.value, type);
    }
    return undefined;
  } catch (reason) { return reason instanceof Error ? reason.message : String(reason); }
}

/** Send only declared source fields, never the entire parent form or computed parameters. */
export function parameterBindingInputs(component: CanvasComponent, inputs: InputValues, components: CanvasComponent[] = [component]): InputValues {
  const values: InputValues = {};
  for (const binding of Object.values(component.props.parameterBindings ?? {})) {
    for (const { reference } of bindingReferenceDependencies(binding, component, { components })) if (reference.kind === "input") {
      if (!own(inputs, reference.key)) throw new Error(`Parent input '${reference.key}' is unavailable.`);
      values[reference.key] = inputs[reference.key];
    }
  }
  return values;
}

/** Capture the containing scopes before a child introduces its own private state. */
export function parameterBindingState(component: CanvasComponent, state?: Partial<RuntimeStateValues>, components: CanvasComponent[] = [component]): ParameterBindingState {
  const result: ParameterBindingState = {};
  for (const binding of Object.values(component.props.parameterBindings ?? {})) {
    const error = validatePropertyBinding(binding); if (error) throw new Error(error);
    for (const { reference } of bindingReferenceDependencies(binding, component, { components })) {
      if (reference.kind !== "sessionState" && reference.kind !== "screenState" && reference.kind !== "instanceState") continue;
      const scope = stateScopes[reference.kind];
      (result[scope] ??= {})[reference.key] = sourceStateValue(state, scope, reference.key);
    }
  }
  return result;
}

/** Validate a frozen source snapshot without filling absent keys from defaults. */
export function parameterBindingStateContext(component: CanvasComponent, snapshot: ParameterBindingState | undefined,
  definitions?: Partial<Record<keyof RuntimeStateValues, StateDefinitions>>, components: CanvasComponent[] = [component]): RuntimeStateValues {
  if (snapshot !== undefined && !object(snapshot)) throw new Error("The source state binding context must be an object.");
  const expected = parameterBindingState(component, snapshot, components);
  if (Object.keys(snapshot ?? {}).length !== Object.keys(expected).length)
    throw new Error("The source state binding context contains an unreferenced scope.");
  for (const [scope, values] of Object.entries(snapshot ?? {})) {
    const referenced = expected[scope as keyof RuntimeStateValues];
    if (!object(values) || !referenced || Object.keys(values).length !== Object.keys(referenced).length)
      throw new Error("The source state binding context contains an unreferenced value.");
    if (definitions) for (const [key, value] of Object.entries(referenced)) {
      const declared = definitions[scope as keyof RuntimeStateValues];
      if (!declared || !own(declared, key) || declared[key].type !== typeof value)
        throw new Error(`Parent ${scope} state '${key}' no longer matches its declared type.`);
    }
  }
  return { session: expected.session ?? {}, screen: expected.screen ?? {}, ...(expected.instance ? { instance: expected.instance } : {}) };
}

/** Bound values are literal scalars. A failed binding blocks the complete instance. */
export function resolveParameterBindings(component: CanvasComponent, template: Template, context: BindingContext): RuntimeParameters {
  const bindings = component.props.parameterBindings;
  if (bindings === undefined) return {};
  if (component.type !== "template" && component.type !== "repeater") throw new Error("Parameter bindings require a template instance or repeater.");
  if (!object(bindings) || Object.keys(bindings).length > 64) throw new Error("Parameter bindings must be a map of at most 64 declared parameters.");
  const result: [string, string | number | boolean][] = [];
  for (const [name, binding] of Object.entries(bindings)) {
    if (!own(template.parameters, name)) throw new Error(`Template parameter '${name}' is not declared.`);
    const type = own(template.parameterTypes ?? {}, name) ? template.parameterTypes![name] : "string";
    const error = validateTemplateParameterBinding(binding, component, context.components, context.parameters, name, type, context.state);
    if (error) throw new Error(`${name}: ${error}`);
    // Tag quality is required even for an unused alias or a short-circuited expression.
    const dependencies = bindingReferenceDependencies(binding, component, context);
    for (const { reference, component: owner } of dependencies) if (reference.kind === "tag" || reference.kind === "custom")
      evaluatePropertyBinding({ expression: "source", references: { source: reference } }, owner, context);
    // Reject invalid intermediate edits even when an expression would mask them.
    // Other, unrelated parent inputs need not be valid to operate this child.
    for (const { reference } of dependencies) if (reference.kind === "input") {
      const input = context.components.find(item => isInput(item.type) && (item.props.fieldKey || item.id) === reference.key)!;
      if (!own(context.inputs, reference.key)) throw new Error(`Parent input '${reference.key}' is unavailable.`);
      const inputError = validateInputs({ id: "binding-source", name: "Binding source", width: 1, height: 1, components: [input] }, context.inputs, context.parameters);
      if (inputError) throw new Error(inputError);
    }
    result.push([name, coerceTemplateParameter(name, evaluatePropertyBinding(binding, component, context).value, type)]);
  }
  return Object.fromEntries(result);
}
