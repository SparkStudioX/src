import type { RuntimeParameters } from "./types";
import { validateListTreeOptions } from "./listTreeModel";
import { resolvePath, tagByPath } from "./api";
import { inputConstraintError } from "./inputValidation";
import type {
  CanvasComponent,
  ComponentType,
  InputValue,
  InputValues,
  Screen,
  Tag,
  RuntimeStateValues,
} from "./types";

export function isInput(type: ComponentType): boolean {
  return (
    type === "textInput" ||
    type === "formattedInput" ||
    type === "barcodeInput" ||
    type === "passwordInput" ||
    type === "multiStateButton" ||
    type === "list" ||
    type === "treeView" ||
    type === "textArea" ||
    isNumericInput(type) ||
    type === "checkbox" ||
    type === "toggle" ||
    type === "select" ||
    type === "radioGroup" ||
    type === "dateTimeInput"
  );
}

export function isNumericInput(type: ComponentType): boolean {
  return type === "numberInput" || type === "spinner" || type === "slider";
}

export function isSafeNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  );
}

/** Local wall-clock values have no offset and must never pass through Date. */
export function isLocalDateTime(value: unknown): value is string {
  if (value === "") return true;
  if (typeof value !== "string" || value.length !== 16) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute] = match.map(Number);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59)
    return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

/** Preserve invalid typed digits instead of rounding an unsafe integer on input. */
export function numericInputValue(text: string): InputValue {
  if (text === "") return "";
  const value = Number(text);
  return isSafeNumber(value) ? value : text;
}

function validNumericDefinition(component: CanvasComponent): boolean {
  const { min, max, step } = component.props;
  return (
    (min === undefined || isSafeNumber(min)) &&
    (max === undefined || isSafeNumber(max)) &&
    (min === undefined || max === undefined || min <= max) &&
    (component.type !== "slider" ||
      (min !== undefined && max !== undefined && min < max)) &&
    (step === undefined ||
      (typeof step === "number" && Number.isFinite(step) && step > 0))
  );
}

function withinRange(component: CanvasComponent, value: number): boolean {
  return (
    (component.props.min === undefined || value >= component.props.min) &&
    (component.props.max === undefined || value <= component.props.max)
  );
}

function roundIncrement(result: number, step: number, base: number): number {
  const decimals = (number: number) => {
    const [coefficient, exponent = "0"] = String(number).toLowerCase().split("e");
    return Math.max(0, (coefficient.split(".")[1]?.length || 0) - Number(exponent));
  };
  const precision = Math.max(decimals(step), decimals(base));
  return precision > 0 && precision <= 12 && Math.abs(result) < 1e15
    ? Number(result.toFixed(precision))
    : result;
}

/** Stepping is a UI convenience, not a requirement that values divide by step. */
export function incrementInput(
  component: CanvasComponent,
  value: InputValue | null,
  direction: -1 | 1,
): number | null {
  if (!validNumericDefinition(component)) return null;
  const { min, max } = component.props;
  const step = component.props.step ?? 1;
  let result = isSafeNumber(value)
    ? value + direction * step
    : min ?? (max !== undefined && max < 0 ? max : 0);
  // Avoid visible 0.1 + 0.2 artifacts for ordinary decimal increments.
  result = roundIncrement(result, step, isSafeNumber(value) ? value : 0);
  if (min !== undefined) result = Math.max(min, result);
  if (max !== undefined) result = Math.min(max, result);
  return isSafeNumber(result) ? result : null;
}

/** Quantize pointer changes, while keeping valid off-step initial values exact. */
export function sliderInputValue(component: CanvasComponent, value: number): number | null {
  if (!validNumericDefinition(component) || !isSafeNumber(value)) return null;
  const { min, max } = component.props;
  if (min === undefined || max === undefined) return null;
  const step = component.props.step ?? 1;
  const increments = (value - min) / step;
  let result = value === min || value === max || !Number.isFinite(increments)
    ? value
    : roundIncrement(min + Math.round(increments) * step, step, min);
  result = Math.max(min, Math.min(max, result));
  return isSafeNumber(result) ? result : null;
}

/** Edited values belong to the asset context in which the operator entered them. */
export function inputsAfterContextChange(
  before: RuntimeParameters,
  after: RuntimeParameters,
  edits: Record<string, InputValues>,
): Record<string, InputValues> {
  const keys = Object.keys(before);
  return keys.length === Object.keys(after).length &&
    keys.every((key) => before[key] === after[key])
    ? edits
    : {};
}

export function initialInput(
  component: CanvasComponent,
  tags: Tag[],
  parameters: RuntimeParameters,
  communicationLost = false,
  state?: RuntimeStateValues,
): InputValue | null {
  // Passwords are operator-entered transient form values, never seeded from a
  // saved default, a live tag, or a published project document.
  if (component.type === "passwordInput") return "";
  if (component.props.stateBinding !== undefined) {
    if (stateInputError(component, state)) return null;
    const binding = component.props.stateBinding;
    return state![binding.scope]![binding.key];
  }
  const tag = component.props.tagPath
    ? tagByPath(tags, resolvePath(component.props.tagPath || "", parameters))
    : undefined;
  const bound = Boolean(component.props.tagPath);
  if (
    bound &&
    (communicationLost || !tag?.quality.toLowerCase().startsWith("good"))
  )
    return null;
  const value = tag?.quality.toLowerCase().startsWith("good")
    ? tag.value
    : component.props.defaultValue;
  if (component.type === "checkbox" || component.type === "toggle")
    return typeof value === "boolean"
      ? value
      : !bound && value === undefined
        ? false
        : null;
  if (isNumericInput(component.type)) {
    const initial = !bound && value === undefined ? 0 : value;
    return validNumericDefinition(component) &&
      isSafeNumber(initial) &&
      withinRange(component, initial)
      ? initial
      : null;
  }
  if (component.type === "select" || component.type === "list" || component.type === "treeView" || component.type === "radioGroup" || component.type === "multiStateButton") {
    if (["select", "list", "treeView"].includes(component.type) && component.props.optionsSource) {
      // Query results never choose or replace a value on the operator's behalf.
      return typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : null;
    }
    const options = component.props.options || [];
    if (component.type === "list" || component.type === "treeView") {
      try { validateListTreeOptions(component.type, options); } catch { return null; }
    }
    const initial = !bound && value === undefined ? options[0]?.value : value;
    return typeof initial === "string" &&
      options.some((option) => option.value === initial)
      ? initial
      : null;
  }
  const initial = !bound && value === undefined ? "" : value;
  if (component.type === "dateTimeInput")
    return isLocalDateTime(initial) ? initial : null;
  return typeof initial === "string" && initial.length <= 4096 ? initial : null;
}

export function resolveInputs(
  screen: Screen,
  tags: Tag[],
  parameters: RuntimeParameters,
  edited: InputValues = {},
  communicationLost = false,
  state?: RuntimeStateValues,
): InputValues {
  return Object.fromEntries(
    screen.components
      .filter((component) => isInput(component.type))
      .map((component) => {
        const key = component.props.fieldKey || component.id;
        return [
          key,
          component.props.stateBinding !== undefined ? initialInput(component, tags, parameters, communicationLost, state) : Object.hasOwn(edited, key)
            ? edited[key]
            : initialInput(component, tags, parameters, communicationLost),
        ];
      }),
  );
}

/** A direct input binding never coerces or seeds its declared browser state. */
export function stateInputError(component: CanvasComponent, state?: RuntimeStateValues): string | null {
  const binding = component.props.stateBinding;
  if (binding === undefined) return null;
  if (!binding || typeof binding !== "object" || Array.isArray(binding) || Object.keys(binding).length !== 2 ||
    (binding.scope !== "session" && binding.scope !== "screen" && binding.scope !== "instance") || typeof binding.key !== "string" ||
    binding.key.trim() !== binding.key || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(binding.key) || ["constructor", "prototype", "__proto__"].includes(binding.key))
    return "An input state binding needs a session, screen or instance scope and a declared state name.";
  if (!isInput(component.type) || component.type === "passwordInput") return "State bindings require a non-password input.";
  if (component.props.tagPath || Object.hasOwn(component.props, "optionsSource") && component.props.optionsSource !== undefined ||
    Object.hasOwn(component.props, "selectionFields") && component.props.selectionFields !== undefined)
    return "Choose a state binding without a tag source, query options or selection mappings.";
  const values = state?.[binding.scope];
  if (!values || !Object.hasOwn(values, binding.key)) return `${binding.scope === "session" ? "Session" : binding.scope === "screen" ? "Screen" : "Instance"} state '${binding.key}' is unavailable in this form.`;
  const key = component.props.fieldKey || component.id;
  // Required/mask rules describe a completed form, not whether a typed draft
  // can be edited. Keep an empty or partially entered state value available.
  const draft = { ...component, props: { ...component.props, validation: undefined, formatMask: undefined, textCase: undefined } };
  return validateInputs({ id: "bound-value", name: "Bound value", width: 1, height: 1, components: [draft] }, { [key]: values[binding.key] });
}

export function validateInputs(
  screen: Screen,
  inputs: InputValues,
  parameters: RuntimeParameters = {},
): string | null {
  for (const component of screen.components.filter((item) =>
    isInput(item.type),
  )) {
    const key = component.props.fieldKey || component.id;
    const value = inputs[key];
    const label = resolvePath(component.props.text || key, parameters);
    const constraint = inputConstraintError(component, value);
    if (constraint) return `${label}: ${constraint}`;
    if (value === null)
      return `${label}: the initial value is unavailable. Enter a value before running this action.`;
    if (isNumericInput(component.type)) {
      if (!validNumericDefinition(component))
        return `${label}: the configured numeric limits or increment are invalid.`;
      if (
        typeof value === "string" &&
        value.trim() !== "" &&
        Number.isInteger(Number(value)) &&
        !Number.isSafeInteger(Number(value))
      )
        return `${label}: the number exceeds the browser’s exact integer range.`;
      if (typeof value !== "number" || !Number.isFinite(value))
        return `${label}: enter a finite number.`;
      if (Number.isInteger(value) && !Number.isSafeInteger(value))
        return `${label}: the number exceeds the browser’s exact integer range.`;
      if (component.props.min !== undefined && value < component.props.min)
        return `${label}: enter a value of at least ${component.props.min}.`;
      if (component.props.max !== undefined && value > component.props.max)
        return `${label}: enter a value of at most ${component.props.max}.`;
    } else if (component.type === "checkbox" || component.type === "toggle") {
      if (typeof value !== "boolean") return `${label}: choose an On or Off value.`;
    } else if (component.type === "dateTimeInput") {
      if (!isLocalDateTime(value))
        return `${label}: enter a valid local date and time (YYYY-MM-DDTHH:mm), or leave it empty.`;
    } else {
      if (typeof value !== "string") return `${label}: enter a text value.`;
      if (value.length > 4096) return `${label}: use at most 4096 characters.`;
    }
    if (
      (component.type === "select" || component.type === "list" || component.type === "treeView" || component.type === "radioGroup" || component.type === "multiStateButton") &&
      (["select", "list", "treeView"].includes(component.type) && component.props.optionsSource
        ? typeof value !== "string" || !value.trim()
        : !component.props.options?.some((option) => option.value === value))
    )
      return `${label}: choose one of the available options.`;
    if ((component.type === "list" || component.type === "treeView") && !component.props.optionsSource) {
      try { validateListTreeOptions(component.type, component.props.options); }
      catch (reason) { return `${label}: ${reason instanceof Error ? reason.message : String(reason)}`; }
    }
  }
  return null;
}
