import { definitionKey, modelDataTypes, modelScalar, parseModelCsv } from "./modelWorkspace";
import type { ModelDefinition, ModelInstance, ModelMember, ModelMetadata, ModelScalar } from "./modelWorkspace";
import { modelParameterValueError, modelPathError } from "./modelParameterRules";

export interface ModelSourceTag extends ModelMetadata { path: string; dataType?: string; liveDataType?: string }
export interface ModelReferenceDrop { members: ModelMember[]; warnings: string[] }
export function modelMemberName(value: string): string {
  return value.split("/").map(part => part.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[^A-Za-z]/, "_") || "Member").join("/").slice(0, 240);
}
function uniqueMemberPath(value: string, existing: ModelMember[]): string {
  const base = modelMemberName(value), occupied = existing.map(member => member.path);
  let candidate = base, suffix = 2;
  while (occupied.some(path => path === candidate || path.startsWith(candidate + "/") || candidate.startsWith(path + "/"))) candidate = `${base.replaceAll("/", "_")}_${suffix++}`;
  return candidate;
}
export function referenceMembersFromTags(tags: ModelSourceTag[], existingMembers: ModelMember[] = [], folder?: string): ModelReferenceDrop {
  if (tags.length + existingMembers.length > 128) throw new Error(`Choose at most ${Math.max(0, 128 - existingMembers.length)} tags; one type supports 128 members.`);
  const members: ModelMember[] = [], warnings: string[] = [];
  for (const tag of tags) {
    const error = modelPathError(tag.path); if (error) throw new Error(error);
    if (folder && !tag.path.startsWith(folder + "/")) throw new Error(`${tag.path} is outside the dropped folder.`);
    const name = folder ? tag.path.slice(folder.length + 1) : tag.path.slice(Math.max(tag.path.lastIndexOf("/"), tag.path.indexOf("]")) + 1);
    const dataType = modelDataTypes.includes(tag.dataType || "") ? tag.dataType : modelDataTypes.includes(tag.liveDataType || "") ? tag.liveDataType : undefined;
    if (!modelDataTypes.includes(tag.dataType || "")) warnings.push(`${tag.path}: type unknown in configuration${dataType ? `; using live ${dataType} as a hint` : ""}. Declare the source dataType before applying.`);
    const member: ModelMember = { path: uniqueMemberPath(name, [...existingMembers, ...members]), kind: "reference", target: tag.path, ...(dataType ? { dataType } : {}) };
    for (const field of ["unit", "description", "range", "semanticType", "attributes"] as const) if (tag[field] !== undefined) Object.assign(member, { [field]: structuredClone(tag[field]) });
    members.push(member);
  }
  return { members, warnings };
}
export function folderDropCandidates(folder: string, tags: ModelSourceTag[], existingMembers: ModelMember[] = []) {
  const candidates = tags.filter(tag => tag.path.startsWith(folder + "/")).sort((left, right) => left.path.localeCompare(right.path));
  const limit = Math.max(0, 128 - existingMembers.length);
  return { tags: candidates, limit, requiresSelection: candidates.length > limit };
}
export function replaceModelReferenceTarget(member: ModelMember, tag: ModelSourceTag) {
  if (member.kind !== "reference") throw new Error("Only reference members can replace their target.");
  const result = referenceMembersFromTags([tag]);
  return { member: { ...member, target: tag.path, dataType: result.members[0].dataType }, warnings: result.warnings,
    requiresTypeConfirmation: member.dataType !== result.members[0].dataType };
}
export function validateModelNesting(definition: ModelDefinition, definitions: ModelDefinition[]): void {
  const types = new Map(definitions.map(item => [definitionKey(item), item])); types.set(definitionKey(definition), definition);
  function visit(current: ModelDefinition, stack: string[]): void {
    const key = definitionKey(current);
    if (stack.includes(key)) throw new Error(`Nested type cycle: ${[...stack, key].join(" → ")}.`);
    if (stack.length >= 4) throw new Error("Nested types are limited to 4 levels.");
    for (const member of current.members.filter(item => item.kind === "type")) {
      const child = types.get(`${member.definitionId}@${member.version}`);
      if (!child) throw new Error(`Nested type ${member.definitionId}@${member.version} is missing.`);
      visit(child, [...stack, key]);
    }
  }
  // Ancestors of the edited draft also need to remain within the depth allowance.
  for (const type of types.values()) visit(type, []);
}
export function addNestedModelType(definition: ModelDefinition, nested: ModelDefinition, definitions: ModelDefinition[], path = nested.id): ModelDefinition {
  if (definition.members.length >= 128) throw new Error("One type supports at most 128 members.");
  const next = structuredClone(definition);
  next.members.push({ path: uniqueMemberPath(path, next.members), kind: "type", definitionId: nested.id, version: nested.version, parameters: {} });
  validateModelNesting(next, [...definitions.filter(item => definitionKey(item) !== definitionKey(nested)), nested]);
  return next;
}
export function reorderModelMember(definition: ModelDefinition, fromIndex: number, toIndex: number): ModelDefinition {
  const next = structuredClone(definition), length = next.members.length;
  if (![fromIndex, toIndex].every(index => Number.isInteger(index) && index >= 0 && index < length)) throw new Error("Choose existing member rows to reorder.");
  const [member] = next.members.splice(fromIndex, 1); next.members.splice(toIndex, 0, member); return next;
}
export function pasteModelInstances(text: string, selectedDefinition: ModelDefinition, existing: ModelInstance[] = []): ModelInstance[] {
  const [rawHeader, ...rows] = parseModelCsv(text), header = rawHeader?.map(value => value.trim());
  if (!header?.includes("path") || new Set(header).size !== header.length) throw new Error("Paste a unique path column followed by parameter columns.");
  if (!rows.length || rows.length + existing.length > 2000) throw new Error("Add 1–2,000 instance rows within the 2,000-instance gateway limit.");
  const declarations = new Map((selectedDefinition.parameters || []).map(parameter => [parameter.name, parameter]));
  for (const name of header) if (name !== "path" && !declarations.has(name)) throw new Error(`${name} is not a parameter of ${selectedDefinition.id}.`);
  const occupied = new Set(existing.map(instance => instance.path));
  return rows.map((cells, index) => {
    if (cells.length !== header.length) throw new Error(`Row ${index + 2}: expected ${header.length} columns.`);
    const values = Object.fromEntries(header.map((name, offset) => [name, cells[offset]])), path = values.path;
    const error = modelPathError(path); if (error) throw new Error(`Row ${index + 2}: ${error}`);
    if (occupied.has(path)) throw new Error(`Row ${index + 2}: duplicate path ${path}.`); occupied.add(path);
    const parameters: Record<string, ModelScalar> = {};
    for (const parameter of declarations.values()) {
      if (values[parameter.name] === undefined || values[parameter.name] === "") continue;
      const value = modelScalar(values[parameter.name], parameter.type), issue = modelParameterValueError(parameter.type, value);
      if (issue) throw new Error(`Row ${index + 2}, ${parameter.name}: ${issue}`); parameters[parameter.name] = value;
    }
    return { path, definitionId: selectedDefinition.id, version: selectedDefinition.version, parameters, overrides: {} };
  });
}
