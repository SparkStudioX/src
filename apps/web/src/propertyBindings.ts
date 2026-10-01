import type { BindingReference, BindingTarget, CanvasComponent, ComponentType, InputValues, PropertyBinding, Tag } from "./types";
import { drawingBindingTargets } from "./drawingComponents";
import { maximumRuntimeBindings, normalizeRuntimePropertyValue, runtimePropertyDefinition, runtimePropertyDefinitions, runtimePropertyGroupErrors, runtimePropertyValue, withRuntimeProperty } from "./runtimePropertyCatalog";

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
export const legacyBindingTargets: BindingTarget[] = ["text", "enabled", "visible", "color", "x", "y", "width", "height", "fontSize", "backgroundColor", "foregroundColor", "borderColor", "borderWidth", "tagPath", "stateValue", ...processBindingTargets, ...drawingBindingTargets];
export const bindingTargets: BindingTarget[] = runtimePropertyDefinitions.filter(item => !item.path.includes("*")).map(item => item.path as BindingTarget);
export function supportsBindingTarget(component: ComponentType | CanvasComponent, target: BindingTarget, definition?: CanvasComponent): boolean { return runtimePropertyDefinition(target, definition ?? component) !== undefined; }
export const geometryTargets = ["x", "y", "width", "height"] as const;
export function isGeometryTarget(target: string): target is typeof geometryTargets[number] { return (geometryTargets as readonly string[]).includes(target); }
export function propertyValue(component: CanvasComponent, target: BindingTarget): unknown {
  return runtimePropertyValue(component, target);
}
export function componentGeometry(component: CanvasComponent, context: BindingContext, preview = true) {
  const resolved = preview ? evaluateComponentBindings(component, context).component : component;
  return { left: resolved.x, top: resolved.y, width: resolved.width, height: resolved.height };
}
const tagIndexes = new WeakMap<Tag[], Map<string, Tag>>();
function tagByPath(tags: Tag[], path: string) {
  let index = tagIndexes.get(tags);
  if (!index) { index = new Map(tags.map(tag => [tag.path, tag])); tagIndexes.set(tags, index); }
  return index.get(path);
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
      validateTagAddress(ref.path);
    } else fail(`Reference '${name}' has an unsupported source.`);
  }
  for (const name of parsed.names) if (!own(binding.references, name)) fail(`Reference '${name}' is not declared.`);
  return parsed.node;
}

/** Structural validation does not require a connection or current operator values. */
export function validatePropertyBinding(binding: PropertyBinding, target?: BindingTarget, component?: CanvasComponent): string | undefined {
  try {
    if (target && component && !supportsBindingTarget(component, target)) fail(`${target} bindings are not supported on ${component.type}.`);
    const node = validateDefinition(binding);
    if (target && parse(binding.expression).names.size === 0) normalizeRuntimePropertyValue(target, evaluate(node, () => fail("A reference is missing.")), component);
    if (component && (target === "min" || target === "max")) {
      validateComponentBindingRange({ ...component, props: { ...component.props, bindings: { ...component.props.bindings, [target]: binding } } });
    }
    if (component && target) validateComponentBindingConstants({ ...component, props: { ...component.props, bindings: { ...component.props.bindings, [target]: binding } } });
    return undefined;
  }
  catch (error) { return error instanceof Error ? error.message : "Invalid property binding."; }
}

/** Compare only values that are known without fetching or observing runtime sources. */
export function validateComponentBindingRange(component: CanvasComponent): void {
  const range = (key: "min" | "max"): number | undefined => {
    const expression = component.props.bindings?.[key];
    const query = component.props.queryBindings?.[key];
    if (!expression && !query) return component.props[key] ?? (["numberInput", "spinner"].includes(component.type) ? undefined : key === "min" ? 0 : 100);
    const definition = expression ?? (query?.transform === undefined ? undefined
      : { expression: query.transform, references: { value: { kind: "custom" as const, key: "value" } } });
    if (!definition) return undefined;
    const constant = constantPropertyBinding(definition);
    if (!constant.constant) return undefined;
    normalizeRuntimePropertyValue(key, constant.value, component); return constant.value as number;
  };
  const minimum = range("min"), maximum = range("max");
  if (minimum !== undefined && maximum !== undefined && (["numberInput", "spinner"].includes(component.type) ? minimum > maximum : minimum >= maximum)) fail("Minimum must be less than maximum.");
}

/** Family checks use authored/constant fields only; live fields are checked together at runtime. */
export function validateComponentBindingConstants(component: CanvasComponent): void {
  let projected = component;
  const known: string[] = [], unknown: string[] = [];
  const targets = [...new Set([...Object.keys(component.props.bindings ?? {}), ...Object.keys(component.props.queryBindings ?? {})])] as BindingTarget[];
  for (const target of targets) {
    const expression = component.props.bindings?.[target], query = component.props.queryBindings?.[target];
    const definition = expression ?? (query?.transform === undefined ? undefined : { expression: query.transform, references: { value: { kind: "custom" as const, key: "value" } } });
    if (!definition) { unknown.push(target); continue; }
    const constant = constantPropertyBinding(definition);
    if (!constant.constant) { unknown.push(target); continue; }
    projected = withRuntimeProperty(projected, target, normalizeRuntimePropertyValue(target, constant.value, component)); known.push(target);
  }
  const family = (target: string) => target.startsWith("chart.") || target === "data" ? "chart" : target.startsWith("viewLayout.") ? "viewLayout"
    : target.startsWith("validation.") || ["formatMask", "textCase", "scanTerminator"].includes(target) ? "validation" : target === "min" || target === "max" ? "range" : target;
  const errors = runtimePropertyGroupErrors(projected, known.filter(target => !unknown.some(other => family(other) === family(target))));
  const error = Object.values(errors)[0]; if (error) fail(error);
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
function resolveReference(ref: BindingReference, component: CanvasComponent, context: BindingContext, resolveCustom?: (owner: CanvasComponent, target: BindingTarget) => ResolvedReference): ResolvedReference {
  if (ref.kind === "sessionState" || ref.kind === "screenState" || ref.kind === "instanceState") {
    const values = ref.kind === "sessionState" ? context.state?.session : ref.kind === "screenState" ? context.state?.screen : context.state?.instance;
    if (!values || !own(values, ref.key)) return fail(`${ref.kind === "sessionState" ? "Session" : ref.kind === "screenState" ? "Screen" : "Instance"} state '${ref.key}' is not declared in this scope.`);
    return { value: scalar(values[ref.key]) };
  }
  if (ref.kind === "custom") {
    const owner = ref.componentId === undefined || ref.componentId === component.id ? component : context.components.find(item => item.id === ref.componentId);
    const customs = owner?.props.customProperties;
    if (!customs || !own(customs, ref.key)) return fail(`Custom property '${ref.key}' was not found in this component scope.`);
    const target = `customProperties.${ref.key}.value` as BindingTarget;
    if (owner && (own(owner.props.bindings ?? {}, target) || own(owner.props.queryBindings ?? {}, target))) return (resolveCustom ?? runtimeResolver(context).target)(owner, target);
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
  const path = resolveTagAddress(ref.path, context.parameters);
  const tag = tagByPath(context.tags, path);
  if (!tag) return fail(`Tag '${path}' was not found.`);
  if (!/^good(?:$|[_ (])/i.test(tag.quality)) return fail(`Tag '${path}' quality is ${tag.quality || "unknown"}.`);
  return { value: scalar(tag.value), ...(tag.source === "simulated" ? { simulated: true as const } : {}) };
}

/** Single-pass parameter indirection. Values cannot inject another substitution or control characters. */
export function validateTagAddress(path: string, parameters?: BindingContext["parameters"]): void {
  if (typeof path !== "string" || !path.trim() || path.length > 1024 || /[\x00-\x1f\x7f]/.test(path))
    fail("A tag address needs 1–1024 characters without control characters.");
  let count = 0;
  const literal = path.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
    count++;
    if (!safeKey(key) || parameters && !own(parameters, key)) fail(`Tag path parameter '${key}' is not declared.`);
    return "";
  });
  if (count > 16 || /[{}]/.test(literal)) fail("A tag address supports at most 16 complete parameter placeholders.");
}
export function resolveTagAddress(path: string, parameters: BindingContext["parameters"]): string {
  validateTagAddress(path, parameters);
  const result = path.replace(/\{([^{}]+)\}/g, (_match, key: string) => String(scalar(parameters[key])));
  if (!result.trim() || result.length > 1024 || /[{}\x00-\x1f\x7f]/.test(result)) fail("The resolved tag address must be bounded text without unresolved placeholders or control characters.");
  return result;
}

/** Shared bounded expression evaluator; the caller validates its target type. */
export function constantPropertyBinding(binding: PropertyBinding): { constant: false } | { constant: true; value: Scalar } {
  const node = validateDefinition(binding);
  return parse(binding.expression).names.size ? { constant: false } : { constant: true, value: evaluate(node, () => fail("A reference is missing.")) };
}

/** Shared bounded expression evaluator; the caller validates its target type. */
export function evaluatePropertyBinding(binding: PropertyBinding, component: CanvasComponent, context: BindingContext): { value: Scalar; simulated?: true } {
  return runtimeResolver(context).expression(binding, component);
}

/** Query cells use exactly the same scalar and target constraints as expressions. */
export function validateBindingTargetValue(target: BindingTarget, value: unknown, component?: CanvasComponent): asserts value is Scalar {
  normalizeRuntimePropertyValue(target, scalar(value), component);
}

/** Walk definitions, including aliases in unused branches, for source authorization and capture. */
export function bindingReferenceDependencies(binding: PropertyBinding, component: CanvasComponent, context: Pick<BindingContext, "components">): { reference: BindingReference; component: CanvasComponent }[] {
  const result: { reference: BindingReference; component: CanvasComponent }[] = [], visiting = new Set<string>(), completed = new Set<string>();
  let visits = 0, queries = 0;
  const walk = (definition: PropertyBinding, owner: CanvasComponent, depth: number) => {
    if (depth > 32 || ++visits > 4096) fail("Custom binding dependencies exceed their depth or work limit.");
    validateDefinition(definition);
    for (const reference of Object.values(definition.references)) {
      if (result.length >= 4096) fail("Custom binding dependencies exceed their depth or work limit.");
      result.push({ reference, component: owner });
      if (reference.kind !== "custom") continue;
      const source = reference.componentId === undefined || reference.componentId === owner.id ? owner : context.components.find(item => item.id === reference.componentId);
      if (!source || !own(source.props.customProperties ?? {}, reference.key)) fail(`Custom property '${reference.key}' was not found in this component scope.`);
      const target = `customProperties.${reference.key}.value` as BindingTarget, key = `${source!.id}:${target}`;
      if (visiting.has(key)) fail(`Custom property dependency cycle at '${reference.key}'.`);
      if (completed.has(key)) continue;
      if (visiting.size >= 32) fail("Custom binding dependencies exceed their depth or work limit.");
      visiting.add(key);
      const child = source!.props.bindings?.[target], query = source!.props.queryBindings?.[target];
      if (child && query) fail("Choose an expression or a query for this property, not both.");
      if (query && ++queries > 128) fail("A custom-property source context supports at most 128 query dependencies.");
      if (child) walk(child, source!, depth + 1);
      for (const parameter of Object.values(query?.parameters ?? {})) walk(parameter, source!, depth + 1);
      visiting.delete(key); completed.add(key);
    }
  };
  walk(binding, component, 0); return result;
}

function runtimeResolver(context: BindingContext) {
  const visiting = new Set<string>(), cache = new Map<string, ResolvedReference>(), validatedGraphs = new Set<string>();
  let visits = 0, customDepth = 0;
  const expression = (binding: PropertyBinding, component: CanvasComponent): ResolvedReference => {
    let simulated = false;
    const value = evaluate(validateDefinition(binding), name => {
      if (++visits > 4096) fail("Custom binding dependencies exceed their depth or work limit.");
      const reference = resolveReference(binding.references[name], component, context, target);
      simulated ||= reference.simulated === true; return reference.value;
    });
    return { value, ...(simulated ? { simulated: true as const } : {}) };
  };
  const target = (component: CanvasComponent, path: BindingTarget): ResolvedReference => {
    const key = `${component.id}:${path}`;
    if (visiting.has(key)) return fail(`Custom property dependency cycle at '${path}'.`);
    const custom = path.startsWith("customProperties.");
    const saved = cache.get(key); if (saved) return saved;
    if (custom && customDepth >= 32) return fail("Custom binding dependencies exceed their depth or work limit.");
    if (!supportsBindingTarget(component, path)) return fail(`${path} bindings are not supported on ${component.type}.`);
    if (custom && !validatedGraphs.has(key)) {
      bindingReferenceDependencies({ expression: "source", references: { source: { kind: "custom", key: path.split(".")[1] } } }, component, context);
      validatedGraphs.add(key);
    }
    visiting.add(key);
    if (custom) customDepth++;
    try {
      const binding = component.props.bindings?.[path], query = component.props.queryBindings?.[path];
      if (binding && query) fail("Choose an expression or a query for this property, not both.");
      let resolved: ResolvedReference;
      if (query) {
        const sample = context.queryProperties?.[component.id]?.[path];
        if (sample?.status !== "ready") return fail(sample?.error || (sample?.status === "loading" ? "Query property is loading." : "Query property is unavailable."));
        resolved = { value: scalar(sample.value) };
      } else if (binding) resolved = expression(binding, component);
      else resolved = { value: scalar(runtimePropertyValue(component, path)) };
      normalizeRuntimePropertyValue(path, resolved.value, component);
      cache.set(key, resolved); return resolved;
    } finally { visiting.delete(key); if (custom) customDepth--; }
  };
  return { expression, target };
}

function failedRuntimeProperty(component: CanvasComponent, target: BindingTarget): CanvasComponent {
  if (!runtimePropertyDefinition(target, component)) return component;
  if (target === "text") return withRuntimeProperty(component, target, "Binding error");
  if (target === "enabled") return withRuntimeProperty(component, target, false);
  if (target === "visible") return withRuntimeProperty(component, target, true);
  if (target === "tagPath") return withRuntimeProperty(component, target, "");
  // Layout stays authored when unavailable; data and process values must not masquerade as fresh samples.
  if (isGeometryTarget(target) || target === "fontSize" || target === "borderWidth") return component;
  const result = withRuntimeProperty(component, target, undefined);
  if (target.startsWith("validation.") || ["min", "max", "step", "options", "formatMask", "textCase", "scanTerminator"].includes(target)) result.props.enabled = false;
  return result;
}

/** Pure evaluation: a failure affects one target; saved definitions are never mutated. */
export function evaluateComponentBindings(component: CanvasComponent, context: BindingContext): {
  component: CanvasComponent;
  errors: Record<string, string>;
  /** A successful target consumed a simulated tag; unused branches do not count. */
  simulated?: true;
} {
  const errors: Record<string, string> = {};
  let simulated = false;
  if (component.props.bindings === undefined && component.props.queryBindings === undefined) return { component, errors };
  let result: CanvasComponent = { ...component, props: { ...component.props } };
  if (component.props.bindings !== undefined && !object(component.props.bindings) || component.props.queryBindings !== undefined && !object(component.props.queryBindings)) {
    errors.text = "Component bindings must be an object.";
    result.props.text = "Binding error";
    result.props.enabled = false;
    return { component: result, errors };
  }
  const targets = [...new Set([...Object.keys(component.props.bindings ?? {}), ...Object.keys(component.props.queryBindings ?? {})])] as BindingTarget[];
  if (Object.keys(component.props.bindings ?? {}).length > maximumRuntimeBindings || Object.keys(component.props.queryBindings ?? {}).length > maximumRuntimeBindings) {
    return { component: { ...result, props: { ...result.props, enabled: false, text: "Binding error" } }, errors: { text: "A component supports at most 128 expression bindings and 128 query bindings." } };
  }
  const resolver = runtimeResolver(context), successful: BindingTarget[] = [];
  for (const target of targets) {
    try {
      if (!supportsBindingTarget(component, target)) fail(`${target} bindings are not supported on ${component.type}.`);
      // An inactive query retains its authored design preview; dependencies require ready samples.
      if (!own(component.props.bindings ?? {}, target) && own(component.props.queryBindings ?? {}, target)
        && (!context.queryProperties || context.queryProperties[component.id]?.[target]?.status === "idle")) continue;
      const resolved = resolver.target(component, target);
      result = withRuntimeProperty(result, target, normalizeRuntimePropertyValue(target, resolved.value, component));
      successful.push(target); simulated ||= resolved.simulated === true;
    } catch (error) {
      // Imported property names are untrusted, including the legacy prototype setter name.
      Object.defineProperty(errors, target, { value: error instanceof Error ? error.message : "Property binding failed.", enumerable: true, configurable: true, writable: true });
      result = failedRuntimeProperty(result, target);
    }
  }
  for (const [target, error] of Object.entries(runtimePropertyGroupErrors(result, successful))) {
    errors[target as BindingTarget] = error; result = failedRuntimeProperty(result, target as BindingTarget);
  }
  // A later enabled expression must never override a failed input constraint.
  if (Object.keys(errors).some(target => target.startsWith("validation.") || ["min", "max", "step", "options", "formatMask", "textCase", "scanTerminator"].includes(target))) result.props.enabled = false;
  return { component: result, errors, ...(simulated ? { simulated: true as const } : {}) };
}
