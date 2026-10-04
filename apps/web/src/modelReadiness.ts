import type { ModelInstanceResolution, ModelResolvedMember } from "./modelResolution";
import type { ModelDefinition, ModelInstance, ModelPackage } from "./modelWorkspace";
import type { Tag } from "./types";

type LiveModelTag = Tag & { sourceQuality?: string; receiptTimestamp?: string; modelIssues?: { code: string; message: string; expected: string }[] };
export type ModelReadinessState = "setup" | "waiting" | "issue" | "ready";
export interface ModelReadiness { state: ModelReadinessState; label: string; message: string; good: number; total: number; fields: { path: string; label: string; quality?: string }[] }
interface ReadinessContext { live: Map<string, LiveModelTag>; draft: Map<string, ModelInstance>; saved: Map<string, ModelInstance>; definitions: Map<string, string>; savedDefinitions: Map<string, string>; mappings: Map<string, string>; savedMappings: Map<string, string>; groups: Map<string, string>; savedGroups: Map<string, string>; disabledGroups: Set<string>; disabledNested: Map<string, Set<string>>; sourceTags: Map<string, string>; savedSourceTags: Map<string, string>; providerEnabled: boolean; savedProviderEnabled: boolean }
const definitionKey = (value: Pick<ModelDefinition, "id" | "version">) => `${value.id}@${value.version}`;
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + stable(item)).join(",") + "}";
  return JSON.stringify(value) ?? "undefined";
}
function definitionSignatures(definitions: ModelDefinition[]): Map<string, string> {
  const byKey = new Map(definitions.map(item => [definitionKey(item), item])), signatures = new Map<string, string>();
  function visit(key: string, seen = new Set<string>()): string {
    if (seen.has(key)) return "cycle:" + key;
    const cached = signatures.get(key); if (cached !== undefined) return cached;
    const definition = byKey.get(key); if (!definition) return "missing:" + key;
    const children = definition.members.filter(item => item.kind === "type").map(item => visit(`${item.definitionId}@${item.version}`, new Set([...seen, key])));
    const signature = stable(definition) + children.join("|"); signatures.set(key, signature); return signature;
  }
  for (const key of byKey.keys()) visit(key);
  return signatures;
}
function disabledNestedPaths(definitions: ModelDefinition[]): Map<string, Set<string>> {
  const byKey = new Map(definitions.map(item => [definitionKey(item), item])), paths = new Map<string, Set<string>>();
  function visit(key: string, seen = new Set<string>()): Set<string> {
    const cached = paths.get(key); if (cached) return cached;
    const result = new Set<string>(); if (seen.has(key)) return result;
    for (const member of byKey.get(key)?.members || []) {
      if (member.kind !== "type") continue;
      if (member.enabled === false) result.add(member.path);
      else for (const child of visit(`${member.definitionId}@${member.version}`, new Set([...seen, key]))) result.add(member.path + "/" + child);
    }
    paths.set(key, result); return result;
  }
  for (const key of byKey.keys()) visit(key);
  return paths;
}
function sourceSignatures(tags: unknown[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const tag of tags) if (tag && typeof tag === "object" && "path" in tag && typeof tag.path === "string") result.set(tag.path, stable(tag));
  return result;
}
/** Build once per draft/runtime snapshot; equipment rows do not scan all tags. */
export function modelReadinessContext(model: ModelPackage, savedModel: ModelPackage, tags: Tag[]): ReadinessContext {
  return { live: new Map(tags.map(tag => [tag.path, tag])), draft: new Map(model.instances.map(item => [item.path, item])), saved: new Map(savedModel.instances.map(item => [item.path, item])), definitions: definitionSignatures(model.udtDefinitions), savedDefinitions: definitionSignatures(savedModel.udtDefinitions), mappings: new Map(model.mappingProfiles?.map(item => [item.id, stable(item)])), savedMappings: new Map(savedModel.mappingProfiles?.map(item => [item.id, stable(item)])), groups: new Map(model.scanGroups.map(item => [item.name, stable(item)])), savedGroups: new Map(savedModel.scanGroups.map(item => [item.name, stable(item)])), disabledGroups: new Set(model.scanGroups.filter(item => item.enabled === false).map(item => item.name)), disabledNested: disabledNestedPaths(model.udtDefinitions), sourceTags: sourceSignatures(model.tags), savedSourceTags: sourceSignatures(savedModel.tags), providerEnabled: model.provider?.enabled !== false, savedProviderEnabled: savedModel.provider?.enabled !== false };
}
function hasSavedInstance(instance: ModelInstance, context: ReadinessContext): boolean {
  const key = `${instance.definitionId}@${instance.version}`, mapping = instance.mappingProfileId;
  return stable(instance) === stable(context.saved.get(instance.path)) && context.definitions.get(key) === context.savedDefinitions.get(key)
    && (!mapping || context.mappings.get(mapping) === context.savedMappings.get(mapping));
}
function hasSavedTarget(path: string, context: ReadinessContext): boolean {
  if (context.sourceTags.get(path) !== context.savedSourceTags.get(path)) return false;
  let slash = path.lastIndexOf("/");
  while (slash >= 0) {
    const root = path.slice(0, slash), instance = context.draft.get(root);
    if (instance) return hasSavedInstance(instance, context);
    if (context.saved.has(root)) return false;
    slash = path.lastIndexOf("/", slash - 1);
  }
  return true;
}
function hasSavedConfiguration(instance: ModelInstance, resolution: ModelInstanceResolution, context: ReadinessContext): boolean {
  return hasSavedInstance(instance, context) && context.providerEnabled === context.savedProviderEnabled
    && resolution.members.every(member => (!member.scanGroup || context.groups.get(member.scanGroup) === context.savedGroups.get(member.scanGroup))
      && (!member.target || hasSavedTarget(member.target, context)) && Object.values(member.inputs || {}).every(path => hasSavedTarget(path, context)));
}
function isNestedDisabled(member: ModelResolvedMember, instance: ModelInstance, context: ReadinessContext): boolean {
  const paths = context.disabledNested.get(`${instance.definitionId}@${instance.version}`);
  let slash = member.path.lastIndexOf("/");
  while (slash >= 0) { if (paths?.has(member.path.slice(0, slash))) return true; slash = member.path.lastIndexOf("/", slash - 1); }
  return false;
}
function memberDataState(member: ModelResolvedMember, context: ReadinessContext): { state: "good" | "waiting" | "issue"; path: string; label: string; quality?: string } {
  const tag = context.live.get(member.concretePath), quality = tag?.quality;
  if (!tag || !quality || quality === "Bad_WaitingForInitialData" || quality === "Bad_NoData") return { state: "waiting", path: member.path, label: "Waiting for a sample", quality };
  if (!/^Good/i.test(quality) || tag.modelIssues?.length) return { state: "issue", path: member.path, label: tag.modelIssues?.map(issue => modelIssueLabel(issue.code)).join(", ") || modelQualityLabel(quality), quality };
  const timestamp = tag.receiptTimestamp || tag.timestamp;
  if (!timestamp || timestamp.startsWith("0001-01-01") || !Number.isFinite(Date.parse(timestamp))) return { state: "waiting", path: member.path, label: "Waiting for a sample timestamp", quality };
  return { state: "good", path: member.path, label: "Receiving data", quality };
}
export function modelEquipmentReadiness(instance: ModelInstance, resolution: ModelInstanceResolution | undefined, context: ReadinessContext): ModelReadiness | undefined {
  if (!resolution) return undefined;
  const base = { good: 0, total: resolution.total, fields: [] };
  if (resolution.status !== "valid") return { ...base, state: "setup", label: "Needs setup", message: "Fix the equipment settings or missing data links below." };
  if (!hasSavedConfiguration(instance, resolution, context)) return { ...base, state: "setup", label: "Needs setup", message: "The links are valid. Review and apply the draft before checking live data." };
  if (instance.enabled === false || !context.providerEnabled) return { ...base, state: "setup", label: "Needs setup", message: instance.enabled === false ? "This equipment is turned off. Enable it to receive data." : "Data collection is paused in Models settings." };
  const members = resolution.members.filter(member => member.enabled !== false && (!member.scanGroup || !context.disabledGroups.has(member.scanGroup)) && !isNestedDisabled(member, instance, context));
  if (!members.length) return { ...base, state: "setup", label: "Needs setup", message: "No fields are enabled. Enable a field and its scan group to receive data." };
  const values = members.map(member => memberDataState(member, context)), good = values.filter(value => value.state === "good").length;
  const fields = values.filter(value => value.state !== "good"), counts = { good, total: members.length, fields };
  if (values.some(value => value.state === "issue")) return { ...counts, state: "issue", label: "Data issue", message: "The equipment is saved, but some measurements need attention." };
  if (fields.length) return { ...counts, state: "waiting", label: "Waiting for data", message: "The equipment is saved. Waiting for its first good measurements." };
  return { ...counts, state: "ready", label: "Ready", message: "The saved equipment is receiving good data for every enabled field." };
}
export function modelIssueLabel(code: string): string {
  return ({ outOfRange: "Out of range", stale: "Data is stale", invalidEnum: "Unexpected value", invalidType: "Wrong data type", sourceQuality: "Source data issue" } as Record<string, string>)[code] || "Data issue";
}
export function modelQualityLabel(quality: string): string {
  if (quality === "Uncertain_ModelStale") return "Data is stale";
  if (quality === "Uncertain_ModelValidation") return "Outside model rules";
  if (quality === "Bad_Disabled") return "Data source is off";
  if (quality === "Bad_NotFound") return "Data source not found";
  return /^Uncertain/i.test(quality) ? "Data is uncertain" : "Data unavailable";
}
