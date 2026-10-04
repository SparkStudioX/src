import type { Connection, SourceBrowseEntry, Tag, TagDefinition } from "./types";
import { connectionPoints } from "./sourceConnections";
import { exactModelInt64Text, wholeModelPlaceholderPattern } from "./modelParameterRules";

export type ModelScalar = string | number | boolean;
export type ModelParameterType = "String" | "Double" | "Int64" | "Boolean";
export interface ModelMetadata { description?: string; semanticType?: string; semanticId?: string; attributes?: Record<string, ModelScalar>; unit?: string; unitSystem?: "ucum" | "custom"; range?: { low: number; high: number }; freshnessMs?: number; enumValues?: ModelScalar[]; alarms?: ModelAlarm[] }
export interface ModelAlarm { id: string; name: string; enabled?: boolean; mode: "high" | "low" | "equal"; setpoint: number; deadband?: number; priority?: number; message?: string }
export interface ModelParameter { name: string; type: ModelParameterType; required?: boolean; default?: ModelScalar }
export interface ModelMember extends ModelMetadata {
  path: string; kind: "memory" | "expression" | "opcua" | "device" | "reference" | "type"; dataType?: string;
  value?: unknown; expression?: string; inputs?: Record<string, string>; connectionId?: string; nodeId?: string; target?: string;
  definitionId?: string; version?: number; parameters?: Record<string, ModelScalar>; enabled?: boolean; writable?: boolean;
  scanGroup?: string; publishingIntervalMs?: number; absoluteDeadband?: number; queueSize?: number;
}
export interface ModelDefinition extends ModelMetadata { id: string; version: number; parameters?: ModelParameter[]; members: ModelMember[] }
export interface ModelInstance { path: string; definitionId: string; version: number; enabled?: boolean; mappingProfileId?: string; parameters?: Record<string, ModelScalar>; overrides?: Record<string, Partial<ModelMember>> }
export interface ModelMappingProfile { id: string; definitionId: string; version: number; description?: string; bindings: Record<string, Pick<ModelMember, "kind" | "target" | "connectionId" | "nodeId" | "value" | "expression" | "inputs" | "absoluteDeadband" | "queueSize">> }
export interface ModelHierarchy extends ModelMetadata { path: string; level: string }
export interface ModelGroup { name: string; publishingIntervalMs: number; enabled?: boolean }
export interface ModelPackage { format: "sparkstudio.tags"; version: number; provider?: { name: string; enabled: boolean; requireDeclaredHierarchy?: boolean }; tags: unknown[]; hierarchy: ModelHierarchy[]; udtDefinitions: ModelDefinition[]; instances: ModelInstance[]; scanGroups: ModelGroup[]; mappingProfiles?: ModelMappingProfile[]; removeMappingProfiles?: string[]; removeHierarchy?: string[]; removeUdtDefinitions?: string[]; removeInstances?: string[]; removeScanGroups?: string[] }
export interface ModelExpandedTag extends ModelMember { dataType: string; effectiveEnabled?: boolean; udtInstance?: string; udtDefinition?: string; udtVersion?: number; udtMember?: string; modelPath?: string; overrideFields?: string[]; fieldProvenance?: Record<string, string> }
export interface ModelProviderHealth { state: string; configuredTags: number; goodTags: number; unavailableTags: number; disabledTags: number }
function modelTagState(definition: ModelExpandedTag, quality: string): "good" | "waiting" | "unavailable" | "uncertain" | "disabled" {
  if (definition.enabled === false || definition.effectiveEnabled === false || quality === "Bad_Disabled") return "disabled";
  if (!quality || quality === "Bad_WaitingForInitialData") return "waiting";
  if (/^Uncertain/i.test(quality)) return "uncertain";
  return /^Good/i.test(quality) ? "good" : "unavailable";
}
export function modelProviderStatus(health: ModelProviderHealth | null, definitions: ModelExpandedTag[], tags: Tag[]): { label: string; degraded: boolean } {
  if (!health) return { label: "Connecting to gateway…", degraded: false };
  if (health.state.toLowerCase() === "disabled") return { label: "Data collection paused", degraded: false };
  if (!definitions.length && health.configuredTags) return { label: "Loading data status…", degraded: false };
  const live = new Map(tags.map(tag => [tag.path, tag]));
  const counts = { good: 0, waiting: 0, unavailable: 0, uncertain: 0, disabled: 0 };
  for (const definition of definitions) counts[modelTagState(definition, live.get(definition.path)?.quality || "")]++;
  const parts = [counts.unavailable && `${counts.unavailable} unavailable`, counts.uncertain && `${counts.uncertain} uncertain`, counts.waiting && `${counts.waiting} waiting for data`, counts.disabled && `${counts.disabled} disabled`].filter(Boolean);
  return { label: parts.length ? parts.join(" · ") : `Data running · ${definitions.length} ${definitions.length === 1 ? "tag" : "tags"}`, degraded: counts.unavailable + counts.uncertain > 0 };
}
export interface ModelPreview { revision: string; previewToken: string; totalTags: number; canApply: boolean; conflicts?: string[]; changes: { path: string; kind: string; action: string; overrideFields?: string[] }[]; expandedTags?: ModelExpandedTag[] }
export interface ModelDraft { definition?: ModelDefinition; csv?: string; origin?: "ask-spark" | "source" }
export const modelDataTypes = ["Boolean", "Int16", "Int32", "Int64", "UInt16", "UInt32", "Float", "Double", "String"];
export const modelLevels = ["Enterprise", "Site", "Area", "Line", "Cell", "WorkCenter", "Custom"];
export const definitionKey = (definition: Pick<ModelDefinition, "id" | "version">) => `${definition.id}@${definition.version}`;
export const emptyModelPackage = (): ModelPackage => ({ format: "sparkstudio.tags", version: 3, tags: [], hierarchy: [], udtDefinitions: [], instances: [], scanGroups: [] });
export const newModelDefinition = (): ModelDefinition => ({ id: "NewUnit", version: 1, parameters: [], members: [{ path: "Value", kind: "memory", dataType: "Double", value: 0 }] });
export function nextModelDefinition(model: ModelPackage, key: string): ModelDefinition {
  const source = model.udtDefinitions.find(item => definitionKey(item) === key);
  if (!source) return newModelDefinition();
  return { ...structuredClone(source), version: Math.max(...model.udtDefinitions.filter(item => item.id === source.id).map(item => item.version)) + 1 };
}
export function modelScalar(text: string, type: string): ModelScalar {
  if (type === "String" || wholeModelPlaceholderPattern.test(text)) return text;
  if (type === "Boolean") return text === "true" ? true : text === "false" ? false : text;
  if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(text)) return text;
  const value = Number(text);
  return Number.isFinite(value) && (!/Int/.test(type) || Number.isSafeInteger(value)) ? value : text;
}
export const modelInt64Text = exactModelInt64Text;
export function modelLeaves(definition: ModelDefinition, definitions: ModelDefinition[], prefix = "", seen = new Set<string>()): ModelMember[] {
  const key = definitionKey(definition);
  if (seen.has(key) || seen.size >= 4) return [];
  const visited = new Set([...seen, key]);
  return definition.members.flatMap(member => {
    const path = prefix + member.path;
    if (member.kind !== "type") return [{ ...member, path }];
    const child = definitions.find(item => item.id === member.definitionId && item.version === member.version);
    return child ? modelLeaves(child, definitions, `${path}/`, visited) : [];
  });
}
function modelTableDelimiter(text: string): string {
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '"') { if (quoted && text[index + 1] === '"') index++; else quoted = !quoted; }
    if (!quoted && text[index] === "\t") return "\t";
    if (!quoted && /[\r\n]/.test(text[index])) break;
  }
  return ",";
}
/** Quoted CSV or tab-separated spreadsheet rows, including escaped quotes and multiline cells. */
export function parseModelCsv(text: string): string[][] {
  if (new TextEncoder().encode(text).length > 32 * 1024 * 1024) throw new Error("CSV files are limited to 32 MiB.");
  text = text.replace(/^\uFEFF/, ""); const delimiter = modelTableDelimiter(text);
  const rows: string[][] = [], row: string[] = []; let cell = "", quoted = false, closed = false;
  const field = () => { row.push(cell); cell = ""; closed = false; };
  const finish = () => { field(); if (row.some(value => value !== "")) rows.push([...row]); row.length = 0; if (rows.length > 2001) throw new Error("Instantiate at most 2,000 CSV rows per review."); };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) { if (char !== '"') cell += char; else if (text[index + 1] === '"') { cell += '"'; index++; } else { quoted = false; closed = true; } continue; }
    if (char === delimiter) field();
    else if (char === "\r" || char === "\n") { finish(); if (char === "\r" && text[index + 1] === "\n") index++; }
    else if (char === '"' && !cell && !closed) quoted = true;
    else if (closed || char === '"') throw new Error("CSV quotes must enclose the complete field.");
    else cell += char;
  }
  if (quoted) throw new Error("CSV contains an unclosed quoted field.");
  finish(); return rows;
}
export function bulkModelInstances(text: string, definitions: ModelDefinition[], existing: ModelInstance[] = []): ModelInstance[] {
  const [rawHeader, ...rows] = parseModelCsv(text.replace(/^\uFEFF/, ""));
  const header = rawHeader?.map(value => value.trim());
  if (!header || ["path", "definitionId", "version"].some(key => !header.includes(key)) || new Set(header).size !== header.length) throw new Error("CSV needs unique path, definitionId and version columns, followed by parameter names.");
  if (!rows.length) throw new Error("Add at least one instance row.");
  const paths = new Set<string>(), occupied = new Set(existing.map(item => item.path));
  return rows.map((values, index) => {
    if (values.length !== header.length) throw new Error(`CSV row ${index + 2} has ${values.length} fields; expected ${header.length}.`);
    const row = Object.fromEntries(header.map((key, offset) => [key, values[offset]]));
    const version = Number(row.version), definition = definitions.find(item => item.id === row.definitionId && item.version === version);
    if (!definition) throw new Error(`CSV row ${index + 2}: choose a saved definition version.`);
    if (paths.has(row.path)) throw new Error(`CSV row ${index + 2}: duplicate path ${row.path}.`);
    if (occupied.has(row.path)) throw new Error(`CSV row ${index + 2}: ${row.path} already exists. Edit or upgrade the saved instance instead.`);
    paths.add(row.path);
    const parameters: Record<string, ModelScalar> = {};
    for (const key of header.filter(name => !["path", "definitionId", "version"].includes(name))) {
      const parameter = definition.parameters?.find(item => item.name === key);
      if (!parameter) { if (row[key] !== "") throw new Error(`CSV row ${index + 2}: ${key} is not a parameter of ${definition.id}.`); continue; }
      if (row[key] === "") continue;
      parameters[key] = modelScalar(row[key], parameter.type);
      if (parameter.type !== "String" && typeof parameters[key] === "string" && !(parameter.type === "Int64" && modelInt64Text(parameters[key]))) throw new Error(`CSV row ${index + 2}: ${key} must be ${parameter.type}.`);
    }
    return { path: row.path, definitionId: definition.id, version, parameters, overrides: {} };
  });
}
export function upgradeModelInstances(instances: ModelInstance[], paths: string[], definition: ModelDefinition): ModelInstance[] {
  if (!paths.length) throw new Error("Select at least one instance to upgrade.");
  return paths.map(path => {
    const instance = instances.find(item => item.path === path);
    if (!instance || instance.definitionId !== definition.id) throw new Error("Upgrade only instances of the selected type.");
    return { ...structuredClone(instance), version: definition.version };
  });
}
/** Only existing concrete tags on this saved connection can become reference members. */
export function modelFromSource(connection: Connection, selection: SourceBrowseEntry[], tags: TagDefinition[]): ModelDefinition {
  const points = connectionPoints(connection), members: ModelMember[] = [], used = new Set<string>();
  for (const entry of selection) {
    const pointIds = points.filter(point => point.address === entry.address && (("selector" in point && point.selector) || "") === (entry.selector || "") && (("mappingId" in point && point.mappingId) || "") === (entry.mappingId || "")).map(point => point.id);
    const candidates = tags.filter(tag => tag.kind === "device" && tag.connectionId === connection.id && pointIds.includes(tag.nodeId || ""));
    if (!candidates.length) throw new Error(`Import ${entry.name} as a gateway tag first, then select it again to create a type. Modeling does not acquire new data.`);
    for (const tag of candidates) {
      if (members.some(member => member.target === tag.path)) continue;
      const base = entry.name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]/, "_") || "Member";
      let name = base, suffix = 2; while (used.has(name)) name = `${base}_${suffix++}`; used.add(name);
      const unit = entry.metadata?.units ?? entry.metadata?.unit;
      members.push({ path: name, kind: "reference", dataType: tag.dataType, target: tag.path, ...(typeof unit === "string" ? { unit } : {}) });
    }
  }
  if (!members.length) throw new Error("Import these points as gateway tags first, then select them again to create a type. Modeling does not acquire new data.");
  if (members.length > 128) throw new Error("Select at most 128 existing tag members for one type.");
  const paths = members.map(member => member.target!.split("/")); let common = 0;
  while (common < paths[0].length - 1 && paths.every(path => path[common] === paths[0][common])) common++;
  const root = paths[0].slice(0, common).join("/");
  return { id: "SourceAsset", version: 1, description: `References existing tags from ${connection.name}.`, parameters: root ? [{ name: "SourceRoot", type: "String", required: true, default: root }] : [], members: members.map(member => root ? { ...member, target: "{SourceRoot}" + member.target!.slice(root.length) } : member) };
}
export const modelDraftEvent = "sparkstudio:model-draft";
const modelDraftStorage = "sparkstudio.model-draft";
export function openModelDraft(draft: ModelDraft, ownerId: string): void {
  if (!ownerId) throw new Error("Sign in before drafting a model.");
  validateModelDraft(draft);
  const text = JSON.stringify({ ownerId, draft });
  if (new TextEncoder().encode(text).length > 1024 * 1024) throw new Error("Model drafts are limited to 1 MiB. Use CSV upload for larger batches.");
  sessionStorage.setItem(modelDraftStorage, text);
  window.dispatchEvent(new CustomEvent(modelDraftEvent));
}
export function clearModelDraft(): void { try { sessionStorage.removeItem(modelDraftStorage); } catch { /* Browser storage can be unavailable. */ } }
export function takeModelDraft(ownerId: string): ModelDraft | undefined {
  try {
    const text = sessionStorage.getItem(modelDraftStorage); if (!text) return undefined;
    const saved = JSON.parse(text); clearModelDraft();
    if (saved.ownerId !== ownerId || typeof saved.draft !== "object" || !saved.draft) return undefined;
    validateModelDraft(saved.draft); return saved.draft as ModelDraft;
  } catch { clearModelDraft(); return undefined; }
}
function validateModelDraft(draft: ModelDraft): void {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error("A model definition or CSV draft is required.");
  if (draft.csv !== undefined && typeof draft.csv !== "string") throw new Error("CSV draft must be text.");
  if (draft.definition !== undefined) validateDraftDefinition(draft.definition);
  if (draft.definition === undefined && draft.csv === undefined) throw new Error("A model definition or CSV draft is required.");
}
export function validateDraftDefinition(value: ModelDefinition): void {
    if (!value || typeof value.id !== "string" || !Number.isInteger(value.version) || !Array.isArray(value.members) || value.members.length > 128) throw new Error("A model draft needs a named version and at most 128 members.");
    if (value.parameters !== undefined && (!Array.isArray(value.parameters) || value.parameters.length > 32 || value.parameters.some(item => !item || typeof item.name !== "string" || !["String", "Double", "Int64", "Boolean"].includes(item.type)))) throw new Error("Model draft parameters need names and supported types.");
    if (value.members.some(item => !item || typeof item.path !== "string" || !["memory", "expression", "opcua", "device", "reference", "type"].includes(item.kind))) throw new Error("Model draft members need paths and supported kinds.");
    validateDraftMetadata(value);
    for (const parameter of value.parameters || []) if (parameter.default !== undefined && !draftScalar(parameter.default)) throw new Error("Parameter defaults must be scalar values.");
    for (const member of value.members) validateDraftMember(member);
}
const draftScalar = (value: unknown) => ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value);
export function validateDraftMap(value: unknown, stringValues = false): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(item => stringValues ? typeof item !== "string" : !draftScalar(item))) throw new Error("Model draft maps must contain named scalar values.");
}
export function validateDraftMetadata(value: ModelMetadata): void {
  for (const field of ["description", "semanticType", "semanticId", "unit"] as const) if (value[field] !== undefined && typeof value[field] !== "string") throw new Error(`Model ${field} must be text.`);
  validateDraftMap(value.attributes);
  if (value.range !== undefined && (!value.range || !Number.isFinite(value.range.low) || !Number.isFinite(value.range.high))) throw new Error("Model range requires finite low and high values.");
  validateDraftContract(value);
}
function validateDraftContract(value: ModelMetadata): void {
  if (value.freshnessMs !== undefined && (!Number.isInteger(value.freshnessMs) || value.freshnessMs < 0 || value.freshnessMs > 86400000)) throw new Error("Freshness must be 0–86400000 milliseconds.");
  if (value.unitSystem !== undefined && !["custom", "ucum"].includes(value.unitSystem)) throw new Error("Choose custom or UCUM units.");
  if (value.enumValues !== undefined && (!Array.isArray(value.enumValues) || value.enumValues.length > 128 || value.enumValues.some(item => !draftScalar(item)))) throw new Error("Allowed values must contain at most 128 scalar values.");
  if (value.alarms !== undefined) {
    if (!Array.isArray(value.alarms) || value.alarms.length > 16) throw new Error("A field supports at most 16 alarms.");
    for (const alarm of value.alarms) validateDraftAlarm(alarm);
  }
}
function validateDraftAlarm(alarm: ModelAlarm): void {
  if (!alarm || typeof alarm.id !== "string" || typeof alarm.name !== "string" || !["high", "low", "equal"].includes(alarm.mode)) throw new Error("Each alarm needs an ID, name and supported condition.");
  if (!Number.isFinite(alarm.setpoint) || (alarm.deadband !== undefined && (!Number.isFinite(alarm.deadband) || alarm.deadband < 0)) || (alarm.priority !== undefined && ![1, 2, 3, 4].includes(alarm.priority))) throw new Error("Alarm thresholds, deadbands and priorities must be valid numbers.");
}
export function validateDraftMember(member: Partial<ModelMember>): void {
  validateDraftMetadata(member); validateDraftMap(member.parameters); validateDraftMap(member.inputs, true);
  for (const field of ["expression", "connectionId", "nodeId", "target", "definitionId", "scanGroup", "dataType"] as const) if (member[field] !== undefined && typeof member[field] !== "string") throw new Error(`Model ${field} must be text.`);
  if (member.value !== undefined && !draftScalar(member.value)) throw new Error("Model initial values must be scalar values.");
}
