import { constantPropertyBinding, evaluatePropertyBinding, validatePropertyBinding } from "./propertyBindings";
import type { BindingContext } from "./propertyBindings";
import { coerceTemplateParameter } from "./templateModel";
import { isInput, validateInputs } from "./inputs";
import type { CanvasComponent, InputValues, PropertyBinding, RuntimeParameters, Template, TemplateParameterType } from "./types";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, name: string) => Object.hasOwn(value, name);

/** References always read the containing form, before the child shadows parameters. */
export function validateTemplateParameterBinding(binding: PropertyBinding, component: CanvasComponent,
  components: CanvasComponent[], parentParameters: RuntimeParameters, targetName: string, type: TemplateParameterType): string | undefined {
  try {
    const error = validatePropertyBinding(binding);
    if (error) throw new Error(error);
    for (const reference of Object.values(binding.references)) {
      if (reference.kind === "parameter") {
        if (!own(parentParameters, reference.key)) throw new Error(`Parent parameter '${reference.key}' is not declared.`);
      } else if (reference.kind === "input") {
        const input = components.find(item => isInput(item.type) && (item.props.fieldKey || item.id) === reference.key);
        if (!input || input.type === "passwordInput") throw new Error(`Input '${reference.key}' must be a non-password input in the containing form.`);
      } else if (reference.kind === "custom") {
        const owner = reference.componentId === undefined || reference.componentId === component.id ? component : components.find(item => item.id === reference.componentId);
        if (!owner?.props.customProperties || !own(owner.props.customProperties, reference.key)) throw new Error(`Custom property '${reference.key}' was not found in the containing form.`);
      } else throw new Error("Template parameter bindings support parent parameters, form inputs and custom properties.");
    }
    const result = constantPropertyBinding(binding);
    if (result.constant) {
      coerceTemplateParameter(targetName, result.value, type);
    }
    return undefined;
  } catch (reason) { return reason instanceof Error ? reason.message : String(reason); }
}

/** Send only declared source fields, never the entire parent form or computed parameters. */
export function parameterBindingInputs(component: CanvasComponent, inputs: InputValues): InputValues {
  const values: InputValues = {};
  for (const binding of Object.values(component.props.parameterBindings ?? {})) {
    for (const reference of Object.values(binding.references)) if (reference.kind === "input") {
      if (!own(inputs, reference.key)) throw new Error(`Parent input '${reference.key}' is unavailable.`);
      values[reference.key] = inputs[reference.key];
    }
  }
  return values;
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
    const error = validateTemplateParameterBinding(binding, component, context.components, context.parameters, name, type);
    if (error) throw new Error(`${name}: ${error}`);
    // Reject invalid intermediate edits even when an expression would mask them.
    // Other, unrelated parent inputs need not be valid to operate this child.
    for (const reference of Object.values(binding.references)) if (reference.kind === "input") {
      const input = context.components.find(item => isInput(item.type) && (item.props.fieldKey || item.id) === reference.key)!;
      if (!own(context.inputs, reference.key)) throw new Error(`Parent input '${reference.key}' is unavailable.`);
      const inputError = validateInputs({ id: "binding-source", name: "Binding source", width: 1, height: 1, components: [input] }, context.inputs, context.parameters);
      if (inputError) throw new Error(inputError);
    }
    result.push([name, coerceTemplateParameter(name, evaluatePropertyBinding(binding, component, context).value, type)]);
  }
  return Object.fromEntries(result);
}
