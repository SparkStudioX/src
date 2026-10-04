import { bulkModelInstances, definitionKey, emptyModelPackage, validateDraftDefinition, validateDraftMap, validateDraftMember, validateDraftMetadata, type ModelDraft, type ModelInstance, type ModelPackage } from "./modelWorkspace";

export interface ModelDraftState { base: ModelPackage; present: ModelPackage; past: ModelPackage[]; future: ModelPackage[]; fromAskSpark: string[]; revision: number }
export interface ModelDraftChange { kind: string; key: string; action: "add" | "update" | "remove" }
export interface ModelDraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
type Collection = "udtDefinitions" | "instances" | "hierarchy" | "scanGroups" | "tags" | "mappingProfiles";
const collections: Collection[] = ["udtDefinitions", "instances", "hierarchy", "scanGroups", "tags", "mappingProfiles"];
const removalFields = { udtDefinitions: "removeUdtDefinitions", instances: "removeInstances", hierarchy: "removeHierarchy", scanGroups: "removeScanGroups", tags: "removeTags", mappingProfiles: "removeMappingProfiles" } as const;
const resourceKey = (kind: Collection, item: unknown): string => {
  const value = item as { id: string; version: number; path: string; name: string };
  return kind === "mappingProfiles" ? value.id : kind === "udtDefinitions" ? definitionKey(value) : kind === "scanGroups" ? value.name : value.path;
};
function requireRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}
function validateInstanceShape(item: ModelInstance) {
  if (typeof item.definitionId !== "string" || !Number.isInteger(item.version)) throw new Error("Model instances require a type ID and integer version.");
  validateDraftMap(item.parameters);
  if (item.overrides !== undefined) {
    requireRecord(item.overrides, "Model instance overrides");
    for (const member of Object.values(item.overrides)) { requireRecord(member, "Member override"); validateDraftMember(member); }
  }
}
function validateResourceShape(kind: Collection, item: unknown) {
  requireRecord(item, `Model ${kind} entry`);
  if (kind === "udtDefinitions") { validateDraftDefinition(item as unknown as ModelPackage["udtDefinitions"][number]); return; }
  if (kind === "mappingProfiles") { if (typeof item.id !== "string" || typeof item.definitionId !== "string" || !Number.isInteger(item.version)) throw new Error("Mapping profiles require an ID and model version."); requireRecord(item.bindings, "Mapping bindings"); for (const binding of Object.values(item.bindings)) { requireRecord(binding, "Mapping source"); validateDraftMember(binding); } return; }
  const key = kind === "scanGroups" ? "name" : "path";
  if (typeof item[key] !== "string" || !item[key]) throw new Error(`Model ${kind} entries require a ${key} string.`);
  if (item.enabled !== undefined && typeof item.enabled !== "boolean") throw new Error("Model enabled must be a Boolean.");
  if (kind === "instances") validateInstanceShape(item as unknown as ModelInstance);
  if (kind === "hierarchy" && typeof item.level !== "string") throw new Error("Hierarchy nodes require a level string.");
  if (kind === "scanGroups" && typeof item.publishingIntervalMs !== "number") throw new Error("Scan groups require a numeric publishing interval.");
  validateDraftMetadata(item);
  if (kind === "tags") validateDraftMember(item);
}
function validatePackageShape(package_: ModelPackage) {
  for (const kind of collections) {
    const incoming = package_[kind] ?? [];
    if (!Array.isArray(incoming)) throw new Error(`Invalid ${kind} collection: expected an array.`);
    for (const item of incoming) validateResourceShape(kind, item);
    const removed = (package_ as unknown as Record<string, unknown>)[removalFields[kind]];
    if (removed !== undefined && (!Array.isArray(removed) || removed.some(item => typeof item !== "string"))) throw new Error(`Model ${removalFields[kind]} must be an array of paths or names.`);
  }
  if (package_.provider !== undefined) {
    requireRecord(package_.provider, "Model provider");
    if (typeof package_.provider.name !== "string" || typeof package_.provider.enabled !== "boolean" || package_.provider.requireDeclaredHierarchy !== undefined && typeof package_.provider.requireDeclaredHierarchy !== "boolean") throw new Error("Model provider requires a name and Boolean settings.");
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
const equal = (a: unknown, b: unknown) => a === b || canonical(a) === canonical(b);
const equalProvider = (a: ModelPackage["provider"], b: ModelPackage["provider"]) => equal({ name: "default", enabled: true, requireDeclaredHierarchy: false, ...a }, { name: "default", enabled: true, requireDeclaredHierarchy: false, ...b });
export function createModelDraft(base: ModelPackage): ModelDraftState { return { base, present: base, past: [], future: [], fromAskSpark: [], revision: 0 }; }
export function editModelDraft(state: ModelDraftState, present: ModelPackage): ModelDraftState {
  if (collections.every(kind => equal(state.present[kind], present[kind])) && equalProvider(state.present.provider, present.provider)) return state;
  return { ...state, present, past: [...state.past.slice(-39), state.present], future: [], revision: state.revision + 1 };
}
export function undoModelDraft(state: ModelDraftState): ModelDraftState {
  const present = state.past.at(-1); return present ? { ...state, present, past: state.past.slice(0, -1), future: [state.present, ...state.future], revision: state.revision + 1 } : state;
}
export function redoModelDraft(state: ModelDraftState): ModelDraftState {
  const [present, ...future] = state.future; return present ? { ...state, present, past: [...state.past, state.present], future, revision: state.revision + 1 } : state;
}
export function modelDraftChanges(base: ModelPackage, present: ModelPackage): ModelDraftChange[] {
  const changes: ModelDraftChange[] = [];
  for (const kind of collections) {
    if (base[kind] === present[kind]) continue;
    const old = new Map((base[kind] || []).map(item => [resourceKey(kind, item), item]));
    for (const item of present[kind] || []) { const key = resourceKey(kind, item); if (!old.has(key) || !equal(old.get(key), item)) changes.push({ kind, key, action: old.has(key) ? "update" : "add" }); old.delete(key); }
    for (const key of old.keys()) changes.push({ kind, key, action: "remove" });
  }
  if (!equalProvider(base.provider, present.provider)) changes.push({ kind: "provider", key: "default", action: "update" });
  return changes;
}
export function modelDraftChangeSummary(changes: ModelDraftChange[]): string {
  const names: Record<string, [string, string]> = { udtDefinitions: ["model", "models"], instances: ["equipment entry", "equipment entries"], hierarchy: ["location", "locations"], scanGroups: ["update group", "update groups"], mappingProfiles: ["source mapping", "source mappings"], tags: ["tag", "tags"], provider: ["gateway data setting", "gateway data settings"] };
  return Object.entries(names).map(([kind, labels]) => { const count = changes.filter(change => change.kind === kind).length; return count ? `${count} ${labels[count === 1 ? 0 : 1]}` : ""; }).filter(Boolean).join(" · ");
}
/** One delta for every view. Saved, unchanged resources are never resubmitted. */
export function modelDraftPackage(base: ModelPackage, present: ModelPackage): ModelPackage {
  const result: ModelPackage & { removeTags?: string[] } = emptyModelPackage();
  for (const kind of collections) {
    if (base[kind] === present[kind]) continue;
    const old = new Map((base[kind] || []).map(item => [resourceKey(kind, item), item]));
    const incoming = (present[kind] || []).filter(item => !old.has(resourceKey(kind, item)) || !equal(old.get(resourceKey(kind, item)), item));
    Object.assign(result, { [kind]: incoming });
    const remaining = new Set((present[kind] || []).map(item => resourceKey(kind, item)));
    const removed = [...old.keys()].filter(key => !remaining.has(key));
    if (removed.length) result[removalFields[kind]] = removed;
  }
  if (!equalProvider(base.provider, present.provider)) result.provider = present.provider;
  return result;
}
/** Merge a package into the draft only; this never calls a gateway endpoint. */
export function mergeModelPackage(model: ModelPackage, package_: ModelPackage): ModelPackage {
  if (package_?.format !== "sparkstudio.tags" || package_.version !== 3) throw new Error("Only the current SparkStudio model format is supported.");
  validatePackageShape(package_);
  const result = { ...model };
  for (const kind of collections) {
    if (kind === "mappingProfiles" && model.mappingProfiles === undefined && package_.mappingProfiles === undefined && !package_.removeMappingProfiles?.length) continue;
    const incoming = package_[kind] ?? [];
    if (!Array.isArray(incoming) || incoming.some(item => !item || typeof item !== "object" || !resourceKey(kind, item))) throw new Error(`Invalid ${kind} collection.`);
    const replacements = new Map(incoming.map(item => [resourceKey(kind, item), item]));
    if (replacements.size !== incoming.length) throw new Error(`Duplicate ${kind} in imported draft.`);
    const removed = new Set((package_ as unknown as Record<string, string[]>)[removalFields[kind]] || []);
    if ([...removed].some(key => replacements.has(key))) throw new Error(`Cannot import and remove the same ${kind} entry.`);
    Object.assign(result, { [kind]: [...(model[kind] || []).filter(item => !replacements.has(resourceKey(kind, item)) && !removed.has(resourceKey(kind, item))), ...incoming] });
  }
  if (package_.provider) result.provider = package_.provider;
  return result;
}
export function mergeAssistantModelDraft(state: ModelDraftState, draft: ModelDraft): ModelDraftState {
  if (!draft || typeof draft !== "object" || draft.csv !== undefined && typeof draft.csv !== "string") throw new Error("A model draft must contain a definition or CSV text.");
  if (draft.definition !== undefined) validateDraftDefinition(draft.definition);
  let present = state.present; const fromAskSpark = [...state.fromAskSpark];
  if (draft.definition) {
    const definition = structuredClone(draft.definition), used = present.udtDefinitions.filter(item => item.id === definition.id);
    // An incoming assistant draft cannot replace the user's current work or a saved version.
    if (used.some(item => item.version === definition.version)) definition.version = Math.max(...used.map(item => item.version)) + 1;
    present = { ...present, udtDefinitions: [...present.udtDefinitions, definition] }; if (draft.origin !== "source") fromAskSpark.push(definitionKey(definition));
  }
  if (draft.csv) {
    const instances = bulkModelInstances(draft.csv, present.udtDefinitions, present.instances);
    present = { ...present, instances: [...present.instances, ...instances] }; if (draft.origin !== "source") fromAskSpark.push(...instances.map(item => item.path));
  }
  return { ...editModelDraft(state, present), fromAskSpark: [...new Set(fromAskSpark)] };
}
const storageKey = (ownerId: string) => "sparkstudio.model-workspace." + encodeURIComponent(ownerId);
export function readPersistedModelDraft(storage: ModelDraftStorage, ownerId: string): string | null { return ownerId ? storage.getItem(storageKey(ownerId)) : null; }
export function clearPersistedModelDraft(storage: ModelDraftStorage, ownerId: string): void { if (ownerId) storage.removeItem(storageKey(ownerId)); }
export function persistModelDraft(storage: ModelDraftStorage, ownerId: string, state: ModelDraftState): void {
  if (!ownerId) return;
  const changes = modelDraftChanges(state.base, state.present);
  if (!changes.length) { clearPersistedModelDraft(storage, ownerId); return; }
  const package_ = modelDraftPackage(state.base, state.present);
  const expected = changes.map(change => ({ ...change, before: change.kind === "provider" ? state.base.provider : state.base[change.kind as Collection]?.find(item => resourceKey(change.kind as Collection, item) === change.key) ?? null }));
  const text = JSON.stringify({ schema: 1, ownerId, package: package_, expected, fromAskSpark: state.fromAskSpark });
  if (new TextEncoder().encode(text).length > 4 * 1024 * 1024) throw new Error("This draft is too large for session recovery. Keep this page open until you apply or export it.");
  storage.setItem(storageKey(ownerId), text);
}
export function restoreModelDraft(storage: ModelDraftStorage, ownerId: string, base: ModelPackage): { state: ModelDraftState; restored: boolean; conflicts: string[] } {
  const fresh = { state: createModelDraft(base), restored: false, conflicts: [] as string[] };
  if (!ownerId) return fresh;
  const text = readPersistedModelDraft(storage, ownerId); if (!text) return fresh;
  const saved = JSON.parse(text);
  if (saved.schema !== 1 || saved.ownerId !== ownerId || !Array.isArray(saved.expected)) throw new Error("The saved model draft is invalid. Export or discard it before continuing.");
  const conflicts = saved.expected.filter((item: ModelDraftChange & { before: unknown }) => {
    const current = item.kind === "provider" ? base.provider : base[item.kind as Collection]?.find(value => resourceKey(item.kind as Collection, value) === item.key) ?? null;
    return item.kind === "provider" ? !equalProvider(current as ModelPackage["provider"], item.before as ModelPackage["provider"]) : !equal(current, item.before);
  }).map((item: ModelDraftChange) => `${item.key} changed on the gateway while this draft was closed. Review its current configuration before applying.`);
  return { state: { ...createModelDraft(base), present: mergeModelPackage(base, saved.package), fromAskSpark: Array.isArray(saved.fromAskSpark) ? saved.fromAskSpark : [] }, restored: true, conflicts };
}
