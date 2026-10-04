import type { ModelDefinition, ModelInstance } from "./modelWorkspace";
import type { ModelSourceTag } from "./modelBuilderOperations";
import { modelParameterNamePattern, modelPathError, modelPlaceholderPattern } from "./modelParameterRules";

export interface ModelFolderSuggestion { folder: string; value: string; matched: number; total: number; complete: boolean }
export interface ModelParameterizationOffer {
  root: string; parent: string; sourceValue: string; parameterName: string; relativePaths: string[];
  mappings: { memberPath: string; relativePath: string; dataType?: string }[];
  suggestions: ModelFolderSuggestion[];
}
const joinPath = (parent: string, child: string) => parent === "[default]" ? parent + child : parent + "/" + child;
const parentPath = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "[default]";
const lastSegment = (path: string) => path.slice(Math.max(path.lastIndexOf("/"), path.indexOf("]")) + 1);
function sourceFolderPlaceholder(target: string | undefined): { prefix: string; name: string } | undefined {
  if (!target) return undefined;
  const match = modelPlaceholderPattern().exec(target); if (!match) return undefined;
  const prefix = target.slice(0, match.index), suffix = target.slice(match.index + match[0].length);
  if ((!prefix.endsWith("/") && prefix !== "[default]") || !suffix.startsWith("/") || suffix.length < 2) return undefined;
  return { prefix, name: match[1] };
}
export function commonModelTargetRoot(targets: string[]): string | undefined {
  if (!targets.length || targets.some(target => modelPathError(target))) return undefined;
  const parts = targets.map(target => target.split("/")); let common = 0;
  while (common < parts[0].length - 1 && parts.every(path => path.length > common + 1 && path[common] === parts[0][common])) common++;
  return common ? parts[0].slice(0, common).join("/") : undefined;
}
function siblingFolders(parent: string, tags: ModelSourceTag[]): string[] {
  const prefix = parent === "[default]" ? parent : parent + "/", folders = new Set<string>();
  for (const tag of tags) {
    if (!tag.path.startsWith(prefix)) continue;
    const relative = tag.path.slice(prefix.length), slash = relative.indexOf("/");
    if (slash > 0) folders.add(joinPath(parent, relative.slice(0, slash)));
  }
  return [...folders].sort();
}
export function suggestModelFolders(definition: ModelDefinition, tags: ModelSourceTag[], offer: ModelParameterizationOffer): ModelFolderSuggestion[] {
  const byPath = new Map(tags.map(tag => [tag.path, tag]));
  return siblingFolders(offer.parent, tags).filter(folder => folder !== offer.root).map(folder => {
    const matched = offer.mappings.filter(mapping => {
      const source = byPath.get(folder + "/" + mapping.relativePath), member = definition.members.find(item => item.path === mapping.memberPath);
      return source?.dataType !== undefined && source.dataType === member?.dataType;
    }).length;
    return { folder, value: lastSegment(folder), matched, total: offer.mappings.length, complete: matched === offer.mappings.length };
  }).sort((left, right) => right.matched - left.matched || left.folder.localeCompare(right.folder));
}
export function offerModelParameterization(definition: ModelDefinition, tags: ModelSourceTag[], folder?: string): ModelParameterizationOffer | undefined {
  const members = definition.members.filter(member => member.kind === "reference" && member.target && !modelPathError(member.target));
  const root = folder || commonModelTargetRoot(members.map(member => member.target!));
  if (!root || modelPathError(root)) return undefined;
  const mappings = members.filter(member => member.target!.startsWith(root + "/")).map(member => ({ memberPath: member.path, relativePath: member.target!.slice(root.length + 1), dataType: member.dataType }));
  if (!mappings.length) return undefined;
  const offer: ModelParameterizationOffer = { root, parent: parentPath(root), sourceValue: lastSegment(root), parameterName: "Device", relativePaths: mappings.map(item => item.relativePath), mappings, suggestions: [] };
  const paths = new Set(tags.map(tag => tag.path)), threshold = Math.ceil(mappings.length / 2);
  const similar = new Set(siblingFolders(offer.parent, tags).filter(candidate => candidate !== root && mappings.filter(mapping => paths.has(candidate + "/" + mapping.relativePath)).length >= threshold));
  offer.suggestions = suggestModelFolders(definition, tags, offer).filter(suggestion => similar.has(suggestion.folder));
  return offer.suggestions.length ? offer : undefined;
}
/** Reopen suggestions for an existing parameterized type, without adding parameters or rewriting it. */
export function inferModelParameterization(definition: ModelDefinition, folder: string, tags: ModelSourceTag[]): ModelParameterizationOffer | undefined {
  if (modelPathError(folder)) return undefined;
  for (const member of definition.members.filter(item => item.kind === "reference")) {
    const match = sourceFolderPlaceholder(member.target);
    if (!match || !definition.parameters?.some(parameter => parameter.name === match.name && parameter.type === "String")) continue;
    const value = folder.startsWith(match.prefix) ? folder.slice(match.prefix.length) : ""; if (!value || value.includes("/")) continue;
    const prefix = `${match.prefix}{${match.name}}/`;
    const mappings = definition.members.filter(item => item.kind === "reference" && item.target?.startsWith(prefix))
      .map(item => ({ memberPath: item.path, relativePath: item.target!.slice(prefix.length), dataType: item.dataType }));
    const offer: ModelParameterizationOffer = { root: folder, parent: parentPath(folder), sourceValue: value, parameterName: match.name, relativePaths: mappings.map(item => item.relativePath), mappings, suggestions: [] };
    offer.suggestions = suggestModelFolders(definition, tags, offer); return offer;
  }
  return undefined;
}
export function suggestedModelInstance(definition: ModelDefinition, offer: ModelParameterizationOffer, suggestion: ModelFolderSuggestion, firstInstance?: ModelInstance): ModelInstance {
  let path = `[default]Models/${definition.id}/${suggestion.value}`;
  if (firstInstance) {
    const original = firstInstance.parameters?.[offer.parameterName] ?? offer.sourceValue;
    const segments = firstInstance.path.slice(9).split("/");
    const index = segments.lastIndexOf(String(original));
    if (index >= 0) segments[index] = suggestion.value;
    else segments[segments.length - 1] = suggestion.value;
    path = "[default]" + segments.join("/");
  }
  const error = modelPathError(path); if (error) throw new Error(error);
  return { path, definitionId: definition.id, version: definition.version, parameters: { ...firstInstance?.parameters, [offer.parameterName]: suggestion.value }, overrides: {} };
}
export function applyModelParameterization(definition: ModelDefinition, offer: ModelParameterizationOffer, parameterName = "Device", instancePath = `[default]Models/${definition.id}/${offer.sourceValue}`) {
  if (!modelParameterNamePattern.test(parameterName)) throw new Error("Parameter names must start with a letter and contain at most 64 letters, digits, underscores or hyphens.");
  if (definition.parameters?.some(parameter => parameter.name === parameterName)) throw new Error(`Parameter ${parameterName} already exists.`);
  if ((definition.parameters?.length || 0) >= 32) throw new Error("A type supports at most 32 parameters.");
  const error = modelPathError(instancePath); if (error) throw new Error(error);
  const next = structuredClone(definition), mappings = new Map(offer.mappings.map(mapping => [mapping.memberPath, mapping]));
  next.parameters = [...next.parameters || [], { name: parameterName, type: "String", required: true }];
  for (const member of next.members) {
    const mapping = mappings.get(member.path); if (!mapping) continue;
    if (member.target !== offer.root + "/" + mapping.relativePath) throw new Error("Targets changed after the parameterize offer; reopen the offer.");
    member.target = joinPath(offer.parent, `{${parameterName}}`) + "/" + mapping.relativePath;
  }
  const instance: ModelInstance = { path: instancePath, definitionId: next.id, version: next.version, parameters: { [parameterName]: offer.sourceValue }, overrides: {} };
  return { definition: next, instance, suggestions: structuredClone(offer.suggestions), offer: { ...offer, parameterName } };
}
export function modelInstanceFromFolder(definition: ModelDefinition, folder: string, firstInstance?: ModelInstance): ModelInstance {
  const error = modelPathError(folder); if (error) throw new Error(error);
  for (const member of definition.members.filter(item => item.kind === "reference")) {
    const match = sourceFolderPlaceholder(member.target);
    if (!match || !definition.parameters?.some(parameter => parameter.name === match.name && parameter.type === "String")) continue;
    if (!folder.startsWith(match.prefix)) continue;
    const value = folder.slice(match.prefix.length); if (!value || value.includes("/")) continue;
    const offer: ModelParameterizationOffer = { root: folder, parent: parentPath(folder), sourceValue: String(firstInstance?.parameters?.[match.name] ?? value), parameterName: match.name, relativePaths: [], mappings: [], suggestions: [] };
    return suggestedModelInstance(definition, offer, { folder, value, matched: 0, total: 0, complete: false }, firstInstance);
  }
  throw new Error("This folder does not match a parameterized source position in the selected type.");
}
