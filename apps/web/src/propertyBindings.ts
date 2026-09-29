import type { BindingReference, BindingTarget, CanvasComponent, ComponentType, InputValues, PropertyBinding, Tag } from "./types";
import { drawingBindingTargets, supportsDrawingProperty } from "./drawingComponents";

type Scalar = string | number | boolean;
type Node =
  | { kind: "literal"; value: Scalar }
  | { kind: "reference"; name: string }
  | { kind: "unary"; operator: string; operand: Node }
  | { kind: "binary"; operator: string; left: Node; right: Node }
  | { kind: "conditional"; condition: Node; yes: Node; no: Node };
type Token = { kind: "literal"; value: Scalar } | { kind: "identifier" | "operator"; value: string };
export interface BindingContext {
  components: CanvasComponent[];
  tags: Tag[];
  parameters: import("./types").RuntimeParameters;
  inputs: InputValues;
  communicationLost?: boolean;
  state?: import("./types").RuntimeStateValues;
  queryProperties?: import("./types").QueryPropertyValues;
}

export const processBindingTargets = ["value", "min", "max", "decimals", "unit", "showValue", "showPercent", "orientation"] as const;
export const bindingTargets: BindingTarget[] = ["text", "enabled", "visible", "color", "x", "y", "width", "height", "fontSize", "backgroundColor", "foregroundColor", "borderColor", "borderWidth", "tagPath", "stateValue", ...processBindingTargets, ...drawingBindingTargets];
export function supportsBindingTarget(type: ComponentType, target: BindingTarget): boolean {
  if ((drawingBindingTargets as readonly string[]).includes(target)) return supportsDrawingProperty(type, target);
  if (target === "tagPath") return type === "value" || type === "gauge";
  if (target === "stateValue") return type === "multiStateIndicator";
  if (!(processBindingTargets as readonly string[]).includes(target)) return true;
  if (!["ledDisplay", "progressBar", "cylindricalTank", "levelIndicator", "thermometer"].includes(type)) return false;
  if (["min", "max", "showValue", "showPercent"].includes(target)) return type !== "ledDisplay";
  return target !== "orientation" || type === "progressBar" || type === "levelIndicator";
}
export const geometryTargets = ["x", "y", "width", "height"] as const;
export function isGeometryTarget(target: string): target is typeof geometryTargets[number] { return (geometryTargets as readonly string[]).includes(target); }
export function propertyValue(component: CanvasComponent, target: BindingTarget): unknown {
  return isGeometryTarget(target) ? component[target] : component.props[target];
}
export function componentGeometry(component: CanvasComponent, context: BindingContext, preview = true) {
  const resolved = preview ? evaluateComponentBindings(component, context).component : component;
  return { left: resolved.x, top: resolved.y, width: resolved.width, height: resolved.height };
}
const reserved = new Set(["__proto__", "constructor", "prototype", "true", "false", "null"]);
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new Error(message); };
const safeKey = (key: unknown): key is string => typeof key === "string" && key.trim().length > 0 && key.length <= 256 && !["__proto__", "constructor", "prototype"].includes(key);
const alias = (key: string) => identifier.test(key) && !/\s/.test(key) && !reserved.has(key);
const scalar = (value: unknown): Scalar => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (typeof value === "string" && value.length <= 4096) return value;
  return fail("A binding value must be a finite number within the exact integer range, Boolean, or text up to 4096 characters.");
};
const numeric = (value: Scalar): number => typeof value === "number" ? value : fail("Arithmetic requires numeric values.");
const boolean = (value: Scalar): boolean => typeof value === "boolean" ? value : fail("A condition must be Boolean.");

function tokenize(expression: string): Token[] {
  if (typeof expression !== "string" || !expression.trim() || expression.length > 2048)
    fail("An expression needs 1 to 2048 characters.");
  const tokens: Token[] = [];
  for (let index = 0; index < expression.length;) {
    const char = expression[index];
    if (/\s/.test(char)) { index++; continue; }
    if (tokens.length >= 256) fail("An expression can contain at most 256 tokens.");
    if (char === '"' || char === "'") {
      const quote = char;
      let value = "", closed = false;
      index++;
      while (index < expression.length) {
        const next = expression[index++];
        if (next === quote) { closed = true; break; }
        if (next.charCodeAt(0) < 32) fail("String literals cannot contain unescaped control characters.");
        if (next !== "\\") { value += next; continue; }
        const escape = expression[index++];
        if (escape === "u") {
          const hex = expression.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Invalid Unicode escape.");
          value += String.fromCharCode(parseInt(hex, 16)); index += 4;
        } else {
          const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "\\": "\\", '"': '"', "'": "'", "/": "/" };
          if (!own(escapes, escape)) fail("Invalid string escape.");
          value += escapes[escape];
        }
      }
      if (!closed) fail("Unclosed string literal.");
      tokens.push({ kind: "literal", value }); continue;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(expression.slice(index));
    if (number) {
      tokens.push({ kind: "literal", value: scalar(Number(number[0])) }); index += number[0].length; continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expression.slice(index));
    if (name) {
      const value = name[0]; index += value.length;
      if (value === "true" || value === "false") tokens.push({ kind: "literal", value: value === "true" });
      else { if (!alias(value)) fail("Invalid reference name."); tokens.push({ kind: "identifier", value }); }
      continue;
    }
    const operator = /^(===|!==|==|!=|<=|>=|&&|\|\||[()+\-*/%<>!?:])/.exec(expression.slice(index));
    if (!operator) return fail(`Unsupported expression character at position ${index + 1}.`);
    tokens.push({ kind: "operator", value: operator[0] }); index += operator[0].length;
  }
  return tokens;
}

const precedence: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "===": 3, "!==": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
const cache = new Map<string, { node: Node; names: Set<string> }>();
function parse(expression: string): { node: Node; names: Set<string> } {
  const cached = cache.get(expression);
  if (cached) return cached;
  const tokens = tokenize(expression);
  const names = new Set<string>();
  let position = 0;
  const matches = (value: string) => tokens[position]?.kind === "operator" && tokens[position]?.value === value;
  const consume = (value: string) => { if (!matches(value)) fail(`Expected '${value}'.`); position++; };
  function parseExpression(minimum = 0, depth = 0): Node {
    if (depth > 32) fail("Expression nesting cannot exceed 32 levels.");
    const token = tokens[position++];
    if (!token) return fail("An expression value is missing.");
    let left: Node;
    if (token.kind === "literal") left = { kind: "literal", value: token.value };
    else if (token.kind === "identifier") { names.add(token.value); left = { kind: "reference", name: token.value }; }
    else if (["!", "+", "-"].includes(token.value)) left = { kind: "unary", operator: token.value, operand: parseExpression(7, depth + 1) };
    else if (token.value === "(") { left = parseExpression(0, depth + 1); consume(")"); }
    else return fail("Expected a literal, reference, or parenthesized expression.");
    while (position < tokens.length) {
      const next = tokens[position];
      const rank = next.kind === "operator" && own(precedence, next.value) ? precedence[next.value] : -1;
      if (rank < minimum) break;
      position++;
      left = { kind: "binary", operator: next.value as string, left, right: parseExpression(rank + 1, depth + 1) };
    }
    if (minimum === 0 && matches("?")) {
      position++;
      const yes = parseExpression(0, depth + 1); consume(":");
      left = { kind: "conditional", condition: left, yes, no: parseExpression(0, depth + 1) };
    }
    return left;
  }
  const node = parseExpression();
  if (position !== tokens.length) fail("Unexpected text after the expression.");
  // A flat left-associative expression can also create a deep evaluation tree.
  function checkDepth(value: Node, depth = 0): void {
    if (depth > 32) fail("Expression nesting cannot exceed 32 levels.");
    if (value.kind === "unary") checkDepth(value.operand, depth + 1);
    if (value.kind === "binary") { checkDepth(value.left, depth + 1); checkDepth(value.right, depth + 1); }
    if (value.kind === "conditional") { checkDepth(value.condition, depth + 1); checkDepth(value.yes, depth + 1); checkDepth(value.no, depth + 1); }
  }
  checkDepth(node);
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  const result = { node, names }; cache.set(expression, result); return result;
}

function validateDefinition(binding: PropertyBinding): Node {
  if (!object(binding) || Object.keys(binding).some(key => key !== "expression" && key !== "references")) fail("A binding needs an expression and reference map.");
  if (!object(binding.references) || Object.keys(binding.references).length > 32) fail("A binding can contain at most 32 references.");
  const parsed = parse(binding.expression);
  for (const [name, raw] of Object.entries(binding.references)) {
    if (!alias(name) || !object(raw)) fail("References need valid identifier names and definitions.");
    const ref = raw as unknown as BindingReference;
    const allowed = ref.kind === "custom" ? ["kind", "key", "componentId"] : ref.kind === "tag" ? ["kind", "path"] : ["kind", "key"];
    if (Object.keys(raw).some(key => !allowed.includes(key))) fail(`Reference '${name}' has unsupported fields.`);
    if (ref.kind === "custom" || ref.kind === "input" || ref.kind === "parameter" || ref.kind === "sessionState" || ref.kind === "screenState" || ref.kind === "instanceState") {
      if (!safeKey(ref.key)) fail(`Reference '${name}' needs a valid key.`);
      if ((ref.kind === "sessionState" || ref.kind === "screenState" || ref.kind === "instanceState") && (ref.key.trim() !== ref.key || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(ref.key))) fail(`Reference '${name}' needs a declared state name.`);
      if (ref.kind === "custom" && (!alias(ref.key) || (own(ref, "componentId") && !safeKey(ref.componentId)))) fail(`Reference '${name}' needs a valid custom property and component ID.`);
    } else if (ref.kind === "tag") {
      if (typeof ref.path !== "string" || !ref.path.trim() || ref.path.length > 1024) fail(`Reference '${name}' needs a tag path up to 1024 characters.`);
    } else fail(`Reference '${name}' has an unsupported source.`);
  }
  for (const name of parsed.names) if (!own(binding.references, name)) fail(`Reference '${name}' is not declared.`);
  return parsed.node;
}

/** Structural validation does not require a connection or current operator values. */
export function validatePropertyBinding(binding: PropertyBinding, target?: BindingTarget, component?: CanvasComponent): string | undefined {
  try {
    if (target && component && !supportsBindingTarget(component.type, target)) fail(`${target} bindings are not supported on ${component.type}.`);
    const node = validateDefinition(binding);
    if (target && parse(binding.expression).names.size === 0) validateTarget(target, evaluate(node, () => fail("A reference is missing.")));
    if (component && (target === "min" || target === "max")) {
      validateComponentBindingRange({ ...component, props: { ...component.props, bindings: { ...component.props.bindings, [target]: binding } } });
    }
    return undefined;
  }
  catch (error) { return error instanceof Error ? error.message : "Invalid property binding."; }
}

/** Compare only values that are known without fetching or observing runtime sources. */
export function validateComponentBindingRange(component: CanvasComponent): void {
  const range = (key: "min" | "max"): number | undefined => {
    const expression = component.props.bindings?.[key];
    const query = component.props.queryBindings?.[key];
    if (!expression && !query) return component.props[key] ?? (key === "min" ? 0 : 100);
    const definition = expression ?? (query?.transform === undefined ? undefined
      : { expression: query.transform, references: { value: { kind: "custom" as const, key: "value" } } });
    if (!definition) return undefined;
    const constant = constantPropertyBinding(definition);
    if (!constant.constant) return undefined;
    validateTarget(key, constant.value); return constant.value as number;
  };
  const minimum = range("min"), maximum = range("max");
  if (minimum !== undefined && maximum !== undefined && minimum >= maximum) fail("Minimum must be less than maximum.");
}

function validateTarget(target: BindingTarget, value: Scalar): void {
  if (target === "strokeWidth" && (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 32)) fail("Stroke width must produce a number from 1 to 32.");
  if (target === "rotation" && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 360)) fail("Rotation must produce a number from 0 to 360 degrees.");
  if (["flowing", "flowReverse", "active"].includes(target)) boolean(value);
  if (target === "fillColor" && value !== "none" && (typeof value !== "string" || value.trim() !== value || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value))) fail("Fill must produce a hex color or 'none'.");
  if (["value", "min", "max"].includes(target) && (typeof value !== "number" || !Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)))
    fail(`${target} must produce an exact finite number.`);
  if (target === "decimals" && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 6))
    fail("decimals must produce a whole number from 0 to 6.");
  if (target === "unit" && (typeof value !== "string" || value.length > 32)) fail("unit must produce text up to 32 characters.");
  if (target === "showValue" || target === "showPercent") boolean(value);
  if (target === "orientation" && value !== "horizontal" && value !== "vertical") fail("orientation must produce 'horizontal' or 'vertical'.");
  if (target === "tagPath" && (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f{}]/.test(value)))
    fail("A tag path binding must produce a complete path of 1–1024 characters without control characters or unresolved parameters.");
  if (target === "enabled" || target === "visible") boolean(value);
  if (["color", "backgroundColor", "foregroundColor", "borderColor", "strokeColor"].includes(target) && (typeof value !== "string" || value.trim() !== value || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)))
    fail("A color binding must produce a hex color: #RGB, #RGBA, #RRGGBB or #RRGGBBAA.");
  if (isGeometryTarget(target) || target === "fontSize" || target === "borderWidth") {
    const minimum = target === "x" || target === "y" || target === "borderWidth" ? 0 : 1;
    const maximum = target === "fontSize" ? 256 : target === "borderWidth" ? 32 : 8192;
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)
      fail(`${target} must produce a number between ${minimum} and ${maximum}.`);
  }
}

function evaluate(node: Node, resolve: (name: string) => Scalar): Scalar {
  if (node.kind === "literal") return node.value;
  if (node.kind === "reference") return resolve(node.name);
  if (node.kind === "conditional") return evaluate(boolean(evaluate(node.condition, resolve)) ? node.yes : node.no, resolve);
  if (node.kind === "unary") {
    const value = evaluate(node.operand, resolve);
    return node.operator === "!" ? !boolean(value) : scalar(node.operator === "-" ? -numeric(value) : numeric(value));
  }
  const left = evaluate(node.left, resolve);
  if (node.operator === "&&") return boolean(left) && boolean(evaluate(node.right, resolve));
  if (node.operator === "||") return boolean(left) || boolean(evaluate(node.right, resolve));
  const right = evaluate(node.right, resolve);
  if (["==", "===", "!=", "!=="].includes(node.operator)) {
    if (typeof left !== typeof right) fail("Equality compares values of the same type.");
    return node.operator === "==" || node.operator === "===" ? left === right : left !== right;
  }
  if (["<", "<=", ">", ">="].includes(node.operator)) {
    if (typeof left !== typeof right || typeof left === "boolean") fail("Comparison requires two numbers or two strings.");
    switch (node.operator) { case "<": return left < right; case "<=": return left <= right; case ">": return left > right; default: return left >= right; }
  }
  if (node.operator === "+" && typeof left === "string" && typeof right === "string") return scalar(left + right);
  const a = numeric(left), b = numeric(right);
  switch (node.operator) {
    case "+": return scalar(a + b);
    case "-": return scalar(a - b);
    case "*": return scalar(a * b);
    case "/": return scalar(a / b);
    case "%": return scalar(a % b);
    default: return fail("Unsupported expression operator.");
  }
}

type ResolvedReference = { value: Scalar; simulated?: true };
function resolveReference(ref: BindingReference, component: CanvasComponent, context: BindingContext): ResolvedReference {
  if (ref.kind === "sessionState" || ref.kind === "screenState" || ref.kind === "instanceState") {
    const values = ref.kind === "sessionState" ? context.state?.session : ref.kind === "screenState" ? context.state?.screen : context.state?.instance;
    if (!values || !own(values, ref.key)) return fail(`${ref.kind === "sessionState" ? "Session" : ref.kind === "screenState" ? "Screen" : "Instance"} state '${ref.key}' is not declared in this scope.`);
    return { value: scalar(values[ref.key]) };
  }
  if (ref.kind === "custom") {
    const owner = ref.componentId === undefined || ref.componentId === component.id ? component : context.components.find(item => item.id === ref.componentId);
    const customs = owner?.props.customProperties;
    if (!customs || !own(customs, ref.key)) return fail(`Custom property '${ref.key}' was not found in this component scope.`);
    const definition = customs[ref.key];
    if (!object(definition) || !["number", "string", "boolean"].includes(definition.type) || typeof definition.value !== definition.type) fail(`Custom property '${ref.key}' does not match its declared type.`);
    return { value: scalar(definition.value) };
  }
  if (ref.kind === "input" || ref.kind === "parameter") {
    const values = ref.kind === "input" ? context.inputs : context.parameters;
    if (!own(values, ref.key)) return fail(`${ref.kind === "input" ? "Input" : "Parameter"} '${ref.key}' was not found.`);
    return { value: scalar(values[ref.key]) };
  }
  if (context.communicationLost) return fail("Gateway connection is offline.");
  const path = ref.path.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
    if (!safeKey(key) || !own(context.parameters, key)) return fail(`Tag path parameter '${key}' was not found.`);
    return String(context.parameters[key]);
  });
  if (path.length > 1024) fail("The resolved tag path exceeds 1024 characters.");
  const tag = context.tags.find(item => item.path === path);
  if (!tag) return fail(`Tag '${path}' was not found.`);
  if (!/^good(?:$|[_ (])/i.test(tag.quality)) return fail(`Tag '${path}' quality is ${tag.quality || "unknown"}.`);
  return { value: scalar(tag.value), ...(tag.source === "simulated" ? { simulated: true as const } : {}) };
}

/** Shared bounded expression evaluator; the caller validates its target type. */
export function constantPropertyBinding(binding: PropertyBinding): { constant: false } | { constant: true; value: Scalar } {
  const node = validateDefinition(binding);
  return parse(binding.expression).names.size ? { constant: false } : { constant: true, value: evaluate(node, () => fail("A reference is missing.")) };
}

/** Shared bounded expression evaluator; the caller validates its target type. */
export function evaluatePropertyBinding(binding: PropertyBinding, component: CanvasComponent, context: BindingContext): { value: Scalar; simulated?: true } {
  let simulated = false;
  const value = evaluate(validateDefinition(binding), name => {
    const reference = resolveReference(binding.references[name], component, context);
    simulated ||= reference.simulated === true;
    return reference.value;
  });
  return { value, ...(simulated ? { simulated: true as const } : {}) };
}

/** Query cells use exactly the same scalar and target constraints as expressions. */
export function validateBindingTargetValue(target: BindingTarget, value: unknown): asserts value is Scalar {
  validateTarget(target, scalar(value));
}

/** Pure evaluation: a failure affects one target; saved definitions are never mutated. */
export function evaluateComponentBindings(component: CanvasComponent, context: BindingContext): {
  component: CanvasComponent;
  errors: Partial<Record<BindingTarget, string>>;
  /** A successful target consumed a simulated tag; unused branches do not count. */
  simulated?: true;
} {
  const errors: Partial<Record<BindingTarget, string>> = {};
  let simulated = false;
  if (component.props.bindings === undefined && component.props.queryBindings === undefined) return { component, errors };
  const result: CanvasComponent = { ...component, props: { ...component.props } };
  if (component.props.bindings !== undefined && !object(component.props.bindings) || component.props.queryBindings !== undefined && !object(component.props.queryBindings)) {
    errors.text = "Component bindings must be an object.";
    result.props.text = "Binding error";
    result.props.enabled = false;
    return { component: result, errors };
  }
  for (const target of bindingTargets) {
    const expressionBound = own(component.props.bindings ?? {}, target), queryBound = own(component.props.queryBindings ?? {}, target);
    if (!expressionBound && !queryBound) continue;
    try {
      if (!supportsBindingTarget(component.type, target)) fail(`${target} bindings are not supported on ${component.type}.`);
      let targetSimulated = false;
      let value: Scalar;
      if (queryBound) {
        if (expressionBound) fail("Choose an expression or a query for this property, not both.");
        const sample = context.queryProperties?.[component.id]?.[target];
        if (sample?.status === "idle" || !context.queryProperties) continue;
        if (sample?.status !== "ready") fail(sample?.error || (sample?.status === "loading" ? "Query property is loading." : "Query property is unavailable."));
        value = scalar(sample?.value);
      } else {
        const binding = component.props.bindings![target]!;
        value = evaluate(validateDefinition(binding), name => {
          const reference = resolveReference(binding.references[name], component, context);
          targetSimulated ||= reference.simulated === true;
          return reference.value;
        });
      }
      validateTarget(target, value);
      if (target === "text" || target === "stateValue") result.props[target] = String(value);
      else if (target === "enabled" || target === "visible" || target === "showValue" || target === "showPercent" || target === "flowing" || target === "flowReverse" || target === "active") result.props[target] = boolean(value);
      else if (isGeometryTarget(target)) result[target] = value as number;
      else if (target === "fontSize" || target === "borderWidth" || target === "value" || target === "min" || target === "max" || target === "decimals" || target === "strokeWidth" || target === "rotation") result.props[target] = value as number;
      else if (target === "orientation") result.props.orientation = value as "horizontal" | "vertical";
      else result.props[target] = value as string;
      simulated ||= targetSimulated;
    } catch (error) {
      errors[target] = error instanceof Error ? error.message : "Property binding failed.";
      if (target === "text") result.props.text = "Binding error";
      else if (target === "enabled") result.props.enabled = false;
      else if (target === "visible") result.props.visible = true;
      // Never show the authored fallback tag as if it were the selected asset.
      else if (target === "tagPath") result.props.tagPath = "";
      else if (target === "stateValue") result.props.stateValue = undefined;
      else if ((processBindingTargets as readonly string[]).includes(target)) result.props[target] = undefined;
      else if ((drawingBindingTargets as readonly string[]).includes(target)) result.props[target] = undefined;
      else if (["color", "backgroundColor", "foregroundColor", "borderColor"].includes(target)) result.props[target] = undefined;
      // Invalid geometry/style numbers retain their authored fallback value.
    }
  }
  return { component: result, errors, ...(simulated ? { simulated: true as const } : {}) };
}
