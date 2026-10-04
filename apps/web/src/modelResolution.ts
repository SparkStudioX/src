import { definitionKey, modelDataTypes } from "./modelWorkspace";
import type { ModelDefinition, ModelInstance, ModelMember, ModelScalar, ModelMappingProfile } from "./modelWorkspace";
import type { ModelSourceTag } from "./modelBuilderOperations";
import { modelParameterNamePattern, modelParameterValueError, modelPathError, modelPlaceholderNames, modelPlaceholderPattern, wholeModelPlaceholderPattern } from "./modelParameterRules";

export type ModelResolutionStatus = "valid" | "warning" | "invalid";
export interface ModelResolvedMember extends ModelMember { status: ModelResolutionStatus; concretePath: string; message?: string; targetDataType?: string; issues: string[] }
export interface ModelInstanceResolution { status: ModelResolutionStatus; members: ModelResolvedMember[]; errors: string[]; resolved: number; total: number }
interface ParameterBinding { values: Record<string, ModelScalar>; types: Record<string, string>; declared: boolean }
interface ResolutionContext { definitions: Map<string, ModelDefinition>; tags: Map<string, ModelSourceTag>; pathCounts: Map<string, number>; instancePaths: string[]; mappings: Map<string, ModelMappingProfile> }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function unsafeReplacement(value: ModelScalar): boolean {
  return typeof value === "string" && (/[{}]/.test(value) || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159));
}
function validateParameterDeclaration(parameter: NonNullable<ModelDefinition["parameters"]>[number]): void {
  if (!["String", "Double", "Int64", "Boolean"].includes(parameter.type) || parameter.required !== undefined && typeof parameter.required !== "boolean") throw new Error(`Invalid parameter declaration: ${parameter.name}.`);
  if (parameter.default !== undefined) { const error = modelParameterValueError(parameter.type, parameter.default); if (error) throw new Error(`${parameter.name}: ${error}`); }
}
export function bindModelParameters(definition: ModelDefinition, supplied: Record<string, ModelScalar> = {}): ParameterBinding {
  const declarations = new Map<string, NonNullable<ModelDefinition["parameters"]>[number]>();
  if ((definition.parameters?.length || 0) > 32) throw new Error("A type supports at most 32 parameters.");
  for (const parameter of definition.parameters || []) {
    if (!modelParameterNamePattern.test(parameter.name) || declarations.has(parameter.name)) throw new Error(`Invalid or duplicate parameter name: ${parameter.name}.`);
    validateParameterDeclaration(parameter);
    declarations.set(parameter.name, parameter);
  }
  for (const name of Object.keys(supplied)) if (!declarations.has(name)) throw new Error(`Unknown model parameter: ${name}.`);
  const values: Record<string, ModelScalar> = {};
  for (const parameter of declarations.values()) {
    const value = Object.hasOwn(supplied, parameter.name) ? supplied[parameter.name] : parameter.default;
    if (value === undefined) { if (parameter.required) throw new Error(`Required model parameter is missing: ${parameter.name}.`); continue; }
    const error = modelParameterValueError(parameter.type, value); if (error) throw new Error(`${parameter.name}: ${error}`);
    values[parameter.name] = value;
  }
  return { values, types: Object.fromEntries([...declarations.values()].map(parameter => [parameter.name, parameter.type])), declared: declarations.size > 0 };
}
export function substituteModelValue(value: unknown, binding: ParameterBinding, wholeValue = false): unknown {
  if (!binding.declared || typeof value !== "string") return value;
  const names = modelPlaceholderNames(value, Object.keys(binding.values)); if (!names.length) return value;
  for (const name of names) if (unsafeReplacement(binding.values[name])) throw new Error("Parameter values cannot introduce placeholders or control characters into model fields.");
  if (wholeValue) {
    if (names.length !== 1 || value !== `{${names[0]}}`) throw new Error("A memory value or typed nested parameter requires a whole-field placeholder.");
    return binding.values[names[0]];
  }
  return value.replace(modelPlaceholderPattern(), (_match, name: string) => String(binding.values[name]));
}
function exactIntegerJson(text: string): number | string {
  const match = text.match(/^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/);
  if (!match) throw new Error("Integer values require a JSON integer without a fractional part.");
  let digits = (match[2] + (match[3] || "")).replace(/^0+/, ""); if (!digits) return 0;
  const shift = Number(match[4] || 0) - (match[3]?.length || 0);
  if (!Number.isSafeInteger(shift) || digits.length + shift > 19) throw new Error("Integer value is outside the signed 64-bit range.");
  if (shift < 0) {
    if (-shift >= digits.length || /[^0]/.test(digits.slice(shift))) throw new Error("Integer values cannot have a fractional part.");
    digits = digits.slice(0, shift);
  } else digits += "0".repeat(shift);
  const value = BigInt(match[1] + digits);
  if (value < -9223372036854775808n || value > 9223372036854775807n) throw new Error("Integer value is outside the signed 64-bit range.");
  return value >= -9007199254740991n && value <= 9007199254740991n ? Number(value) : value.toString();
}
function substitutedMemory(type: string, value: unknown, hasParameters: boolean): unknown {
  if (!hasParameters || type === "String" || typeof value !== "string") return value;
  if (["Int16", "UInt16", "Int32", "UInt32", "Int64"].includes(type)) return exactIntegerJson(value);
  try { return JSON.parse(value); } catch { throw new Error(`A substituted memory value must match ${type}.`); }
}
function resolvedMemory(member: ModelMember, binding: ParameterBinding): unknown {
  const placeholder = typeof member.value === "string" ? member.value.match(wholeModelPlaceholderPattern)?.[1] : undefined;
  const value = substituteModelValue(member.value, binding, true);
  // Wire-safe Int64 text still represents an integer, not a String parameter.
  if (placeholder && binding.types[placeholder] === "Int64" && member.dataType === "String") throw new Error("String memory requires a String parameter.");
  return substitutedMemory(member.dataType || "", value, binding.declared);
}
function memoryValueError(type: string | undefined, value: unknown): string | undefined {
  if (type === "String") return typeof value === "string" ? undefined : "String memory requires text.";
  if (type === "Boolean" || type === "Double" || type === "Int64") return modelParameterValueError(type, value);
  const range: Record<string, number[]> = { Int16: [-32768, 32767], UInt16: [0, 65535], Int32: [-2147483648, 2147483647], UInt32: [0, 4294967295], Float: [-3.4028234663852886e38, 3.4028234663852886e38] };
  if (!type || !range[type]) return "Choose a supported data type.";
  if (typeof value !== "number" || !Number.isFinite(value) || value < range[type][0] || value > range[type][1]) return `Memory value is outside the ${type} range.`;
  return type !== "Float" && !Number.isInteger(value) ? "Integer memory requires a whole number." : undefined;
}
const overrideFields = new Set(["value", "enabled", "publishingIntervalMs", "scanGroup", "connectionId", "nodeId", "absoluteDeadband", "queueSize", "expression", "inputs", "target", "unit", "description", "range", "semanticType", "semanticId", "attributes", "unitSystem", "freshnessMs", "enumValues", "alarms"]);
function mappedMember(member: ModelMember, modelPath: string, instance: ModelInstance, context: ResolutionContext): ModelMember {
  const profile = instance.mappingProfileId ? context.mappings.get(instance.mappingProfileId) : undefined;
  const source = profile?.bindings[modelPath];
  if (!source) return member;
  const root = context.definitions.get(`${instance.definitionId}@${instance.version}`)!;
  const binding = bindModelParameters(root, instance.parameters), mapped = structuredClone(source);
  for (const field of ["target", "connectionId", "nodeId"] as const) if (mapped[field] !== undefined) mapped[field] = String(substituteModelValue(mapped[field], binding));
  if (Object.hasOwn(mapped, "value")) mapped.value = resolvedMemory({ ...member, ...mapped }, binding);
  if (mapped.inputs) mapped.inputs = Object.fromEntries(Object.entries(mapped.inputs).map(([name, input]) => [name, String(substituteModelValue(input, binding))]));
  const result = { ...member };
  for (const field of ["target", "connectionId", "nodeId", "value", "expression", "inputs", "absoluteDeadband", "queueSize", "writable"] as const) delete result[field];
  return { ...result, ...mapped };
}
function expandMember(member: ModelMember, context: ResolutionContext, root: string, modelPath: string, binding: ParameterBinding, instance: ModelInstance, used: Set<string>): ModelResolvedMember {
  member = mappedMember(member, modelPath, instance, context);
  const patch = instance.overrides?.[modelPath];
  if (patch && Object.keys(patch).some(field => !overrideFields.has(field))) throw new Error(`${modelPath}: override cannot change member identity, kind or data type.`);
  if (patch) used.add(modelPath);
  const result = { ...structuredClone(member), ...structuredClone(patch || {}), path: modelPath, concretePath: root + "/" + member.path, status: "valid" as ModelResolutionStatus, issues: [] as string[] };
  for (const field of ["connectionId", "nodeId", "target"] as const) if (result[field] !== undefined) result[field] = String(substituteModelValue(result[field], binding));
  if (Object.hasOwn(result, "value")) result.value = resolvedMemory(result, binding);
  if (result.target?.startsWith("./")) result.target = root + "/" + result.target.slice(2);
  if (result.inputs) result.inputs = Object.fromEntries(Object.entries(result.inputs).map(([name, input]) => {
    const value = String(substituteModelValue(input, binding)); return [name, value.startsWith("./") ? root + "/" + value.slice(2) : value];
  }));
  return result;
}
function expandType(type: ModelDefinition, root: string, prefix: string, binding: ParameterBinding, instance: ModelInstance, context: ResolutionContext, stack: string[], used: Set<string>, output: ModelResolvedMember[]): void {
  const key = definitionKey(type);
  if (stack.includes(key)) throw new Error(`Nested type cycle: ${key}.`);
  if (stack.length >= 4) throw new Error("Nested types are limited to 4 levels.");
  if (!type.members.length || type.members.length > 128) throw new Error(`${key} needs 1–128 members.`);
  for (const member of type.members) {
    const path = prefix + member.path;
    if (member.path.length > 256 || modelPathError("[default]Member/" + member.path)) throw new Error(`Invalid member path: ${path}.`);
    if (member.kind !== "type") { output.push(expandMember(member, context, root, path, binding, instance, used)); if (output.length > 10000) throw new Error("A model supports at most 10,000 expanded tags."); continue; }
    const child = context.definitions.get(`${member.definitionId}@${member.version}`); if (!child) throw new Error(`Missing nested type ${member.definitionId}@${member.version}.`);
    validateNestedParameterTypes(member, type, child);
    const parameters = nestedParameterValues(member, child, binding);
    expandType(child, root + "/" + member.path, path + "/", bindModelParameters(child, parameters), instance, context, [...stack, key], used, output);
  }
}
function nestedParameterValues(member: ModelMember, child: ModelDefinition, binding: ParameterBinding): Record<string, ModelScalar> {
  return Object.fromEntries(Object.entries(member.parameters || {}).map(([name, value]) => {
    const whole = typeof value === "string" && wholeModelPlaceholderPattern.test(value);
    let resolved = substituteModelValue(value, binding, whole) as ModelScalar;
    const sourceName = whole ? value.match(wholeModelPlaceholderPattern)![1] : undefined;
    if (sourceName && binding.types[sourceName] === "Int64" && child.parameters?.find(parameter => parameter.name === name)?.type === "Double") resolved = Number(resolved);
    return [name, resolved];
  }));
}
function validateNestedParameterTypes(member: ModelMember, parent: ModelDefinition, child: ModelDefinition): void {
  for (const [name, value] of Object.entries(member.parameters || {})) {
    if (typeof value !== "string" || !value.includes("{")) continue;
    const names = modelPlaceholderNames(value, (parent.parameters || []).map(parameter => parameter.name));
    const expected = child.parameters?.find(parameter => parameter.name === name)?.type;
    if (!expected) throw new Error(`Unknown nested type parameter: ${name}.`);
    if (!wholeModelPlaceholderPattern.test(value)) { if (expected !== "String") throw new Error("A non-string nested parameter requires a whole-field placeholder."); continue; }
    const supplied = parent.parameters?.find(parameter => parameter.name === names[0])?.type;
    if (supplied !== expected && !(supplied === "Int64" && expected === "Double")) throw new Error(`Nested parameter ${name} must match its parent parameter type.`);
  }
}
function memberIssue(member: ModelResolvedMember, message: string, status: ModelResolutionStatus = "warning"): void {
  member.issues.push(message); member.message = member.issues.join(" "); if (member.status !== "invalid") member.status = status;
}
type TargetLookup = (path: string) => ModelSourceTag | undefined;
function referenceIssue(member: ModelResolvedMember, target: string | undefined, lookup: TargetLookup): void {
  const error = modelPathError(target); if (error) { memberIssue(member, error, "invalid"); return; }
  const source = lookup(target!); if (!source) { memberIssue(member, `${target} not found.`); return; }
  member.targetDataType = source.dataType;
  if (member.kind !== "reference") return;
  if (!source.dataType) memberIssue(member, `${target}: type unknown. Declare the target dataType in tag configuration; live values are only a hint.`);
  else if (source.dataType !== member.dataType) memberIssue(member, `${source.dataType} target, ${member.dataType || "unknown"} member.`);
}
function validateMember(member: ModelResolvedMember, lookup: TargetLookup): void {
  if (modelPathError(member.concretePath)) memberIssue(member, "Expanded member path is invalid or exceeds 512 characters.", "invalid");
  if (!["opcua"].includes(member.kind) && !modelDataTypes.includes(member.dataType || "")) memberIssue(member, "Choose a supported member data type.", "invalid");
  if (!["reference", "memory", "expression", "opcua", "device"].includes(member.kind)) memberIssue(member, "Choose a supported member kind.", "invalid");
  if (member.kind === "reference") referenceIssue(member, member.target, lookup);
  if (member.kind === "memory") { const error = memoryValueError(member.dataType, member.value); if (error) memberIssue(member, error, "invalid"); }
  if (member.kind === "expression") {
    if (!member.expression?.trim()) memberIssue(member, "An expression is required.", "invalid");
    for (const input of Object.values(member.inputs || {})) referenceIssue(member, input, lookup);
  }
  if (["opcua", "device"].includes(member.kind) && (!member.connectionId?.trim() || !member.nodeId?.trim())) memberIssue(member, "A connection and source address are required.", "invalid");
}
function validateDependencies(members: ModelResolvedMember[]): void {
  const byPath = new Map(members.map(member => [member.concretePath, member])), heights = new Map<string, number>();
  function visit(member: ModelResolvedMember, stack: Set<string>): number {
    if (stack.has(member.concretePath)) throw new Error(`Reference/expression cycle at ${member.path}.`);
    if (stack.size > 64) throw new Error("Reference/expression chains are limited to 64 tags.");
    const cached = heights.get(member.concretePath); if (cached !== undefined) return cached;
    const targets = member.kind === "reference" ? [member.target || ""] : Object.values(member.inputs || {});
    let height = ["reference", "expression"].includes(member.kind) ? 1 : 0;
    for (const target of targets) { const dependency = byPath.get(target); if (dependency) height = Math.max(height, 1 + visit(dependency, new Set([...stack, member.concretePath]))); }
    if (height > 64) throw new Error("Reference/expression chains are limited to 64 tags.");
    heights.set(member.concretePath, height); return height;
  }
  for (const member of members) visit(member, new Set());
}
function buildContext(definitions: ModelDefinition[], tags: ModelSourceTag[], instances: ModelInstance[], profiles: ModelMappingProfile[] = []): ResolutionContext {
  const pathCounts = new Map<string, number>(); for (const instance of instances) pathCounts.set(instance.path, (pathCounts.get(instance.path) || 0) + 1);
  return { definitions: new Map(definitions.map(type => [definitionKey(type), type])), tags: new Map(tags.map(tag => [tag.path, tag])), pathCounts, instancePaths: [...pathCounts.keys()], mappings: new Map(profiles.map(profile => [profile.id, profile])) };
}
function validateMappingProfile(instance: ModelInstance, context: ResolutionContext) {
  if (!instance.mappingProfileId) return;
  const mapping = context.mappings.get(instance.mappingProfileId);
  if (!mapping || mapping.definitionId !== instance.definitionId || mapping.version !== instance.version) throw new Error("Choose a source mapping for this exact model version.");
}
function resolveInstance(instance: ModelInstance, context: ResolutionContext): ModelInstanceResolution {
  const members: ModelResolvedMember[] = [], errors: string[] = [];
  try {
    const error = modelPathError(instance.path); if (error) throw new Error(error);
    if ((context.pathCounts.get(instance.path) || 0) > 1) throw new Error(`Duplicate instance path: ${instance.path}.`);
    if (context.instancePaths.some(path => path !== instance.path && (path.startsWith(instance.path + "/") || instance.path.startsWith(path + "/")))) throw new Error("Instance namespaces cannot overlap.");
    const type = context.definitions.get(`${instance.definitionId}@${instance.version}`); if (!type) throw new Error("Choose an existing saved or draft type version.");
    validateMappingProfile(instance, context);
    const used = new Set<string>(); expandType(type, instance.path, "", bindModelParameters(type, instance.parameters), instance, context, [], used, members);
    for (const path of Object.keys(instance.overrides || {})) if (!used.has(path)) errors.push(`Override references removed or missing member: ${path}.`);
    const paths = new Set<string>();
    for (const member of members) { if (paths.has(member.path)) errors.push(`Duplicate member path: ${member.path}.`); paths.add(member.path); }
    for (const member of members) if (member.path.split("/").slice(0, -1).some((_segment, index, parts) => paths.has(parts.slice(0, index + 1).join("/")))) errors.push(`Leaf/folder path collision: ${member.path}.`);
    const types = new Map(members.map(member => [member.concretePath, member]));
    for (const member of members) validateMember(member, path => types.get(path) || context.tags.get(path));
    validateDependencies(members);
  } catch (error) { errors.push(errorText(error)); }
  const status: ModelResolutionStatus = errors.length || members.some(member => member.status === "invalid") ? "invalid" : members.some(member => member.status === "warning") ? "warning" : "valid";
  return { status, members, errors, resolved: members.filter(member => member.status === "valid").length, total: members.length };
}
export function resolveModelInstance(instance: ModelInstance, definitions: ModelDefinition[], tags: ModelSourceTag[], allInstances: ModelInstance[] = [], profiles: ModelMappingProfile[] = []): ModelInstanceResolution {
  return resolveInstance(instance, buildContext(definitions, tags, allInstances, profiles));
}
export function resolveModelInstances(instances: ModelInstance[], definitions: ModelDefinition[], tags: ModelSourceTag[], profiles: ModelMappingProfile[] = []): ModelInstanceResolution[] {
  const context = buildContext(definitions, tags, instances, profiles); return instances.map(instance => resolveInstance(instance, context));
}
