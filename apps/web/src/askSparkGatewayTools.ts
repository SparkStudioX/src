import declarations from "./askSparkGatewayTools.json";
import { ApiError, apiUrl, authenticatedFetch, assertAuthResponseCurrent } from "./api";
import { preparePreviewRequest } from "./previewRequest";
import { authSessionRevision } from "./authSession";
import { runtimeAuthenticatedFetch, signInRuntime, testRuntimeSession } from "./askSparkRuntimeTools";
import { askSparkNavigationLink } from "./askSparkNavigation";

type Values = Record<string, unknown>;
type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean | Schema; items?: Schema; enum?: unknown[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; maxItems?: number; pattern?: string };
export interface GatewayToolContext {
  projectId?: string | null;
  resolveSecret?: (handle: string | undefined, purpose: string) => Promise<Record<string, string>>;
  resolveAttachment?: (handle: string | undefined, purpose?: string) => Promise<Blob>;
  download?: (blob: Blob, filename: string) => Promise<void>;
  [key: string]: unknown;
}
type Run = (args: Values, context: GatewayToolContext, signal?: AbortSignal) => Promise<unknown>;
type Request = { method?: string; body?: unknown; scoped?: boolean; binary?: boolean };
const operationGuard = Symbol("ask-spark-operation-guard");
const operatorGrant = Symbol("ask-spark-operator-grant");
type OperatorGrant = "view" | "operate" | "command";
type BoundContext = GatewayToolContext & { [operationGuard]?: () => void; [operatorGrant]?: OperatorGrant };
const schemas = new Map(declarations.map(item => [item.name, item.parameters as unknown as Schema]));
const toolKinds = new Map(declarations.map(item => [item.name, item.kind]));
const toolPermissions = new Map(declarations.map(item => [item.name, item.permission]));
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
const maximumResponseBytes = 16 * 1024 * 1024;
const object = (value: unknown): value is Values => value !== null && typeof value === "object" && !Array.isArray(value);
const field = (args: Values, name: string): string => String(args[name]);
const segment = (args: Values, name = "id"): string => encodeURIComponent(field(args, name));
const select = (args: Values, keys: string[]): Values => Object.fromEntries(keys.filter(key => args[key] !== undefined).map(key => [key, args[key]]));
const pageKeys = new Set(["resultPath", "offset", "limit"]);
const bodyArgs = (args: Values): Values => Object.fromEntries(Object.entries(args).filter(([key]) => !pageKeys.has(key)));

function projectId(context: GatewayToolContext): string {
  if (typeof context.projectId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(context.projectId))
    throw new Error("Select an explicit project before using this tool.");
  return context.projectId;
}

function checkScalar(value: unknown, schema: Schema, path: string): void {
  if (schema.enum && !schema.enum.some(item => item === value)) throw new Error(`${path} is not a supported value.`);
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 262144)) throw new Error(`${path} has an invalid length.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${path} has an invalid format.`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < (schema.minimum ?? -Number.MAX_VALUE) || value > (schema.maximum ?? Number.MAX_VALUE)) throw new Error(`${path} is out of range.`);
    if (schema.type === "integer" && !Number.isSafeInteger(value)) throw new Error(`${path} must be a safe integer.`);
  }
}

function checkObject(value: Values, schema: Schema, path: string, depth: number): void {
  for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) throw new Error(`${path}.${required} is required.`);
  if (Object.keys(value).length > 10000) throw new Error(`${path} contains too many fields.`);
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) throw new Error(`${path} contains a forbidden field.`);
    const property = schema.properties?.[key];
    if (!property && schema.additionalProperties === false) throw new Error(`${path}.${key} is not supported.`);
    const fallback = object(schema.additionalProperties) ? schema.additionalProperties as Schema : {};
    checkValue(child, property ?? fallback, `${path}.${key}`, depth + 1);
  }
}

function checkValue(value: unknown, schema: Schema, path: string, depth = 0): void {
  if (depth > 32) throw new Error("Tool arguments exceed the maximum nesting depth.");
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const types = schema.type ? [schema.type].flat() : [];
  const accepted = types.includes(actual) || actual === "number" && types.includes("integer");
  if (types.length && !accepted) throw new Error(`${path} must have type ${types.join(" or ")}.`);
  if (["undefined", "function", "symbol", "bigint"].includes(actual)) throw new Error(`${path} must be JSON data.`);
  checkScalar(value, schema, path);
  if (object(value)) checkObject(value, schema, path, depth);
  if (Array.isArray(value)) {
    if (value.length > (schema.maxItems ?? 10000)) throw new Error(`${path} contains too many items.`);
    value.forEach((child, index) => checkValue(child, schema.items ?? {}, `${path}[${index}]`, depth + 1));
  }
}

function safeText(value: string): string {
  return value.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[redacted]")
    .replace(/((?:password|pwd|secretAccessKey|api[_-]?key|access[_-]?token)\s*[=:]\s*)([^\s;,]+)/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[private key redacted]");
}

function secretField(key: string, allowReviewToken: boolean): boolean {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  if (/^(has|clear)[A-Z_-]/.test(key) || /(?:reference|handle|file|sha256)$/.test(normalized)) return false;
  if (allowReviewToken && normalized === "token") return false;
  return /(?:password|passwordhash|passphrase|secretaccesskey|clientsecret|apikey|accesstoken|refreshtoken|csrftoken|sessiontoken|authorization|privatekey|protectedtoken)$/.test(normalized)
    || normalized === "token" || normalized === "credentials";
}

type ListTruncation = { path: string; total: number; returnedCount: number; nextOffset: number };
type OutputBudget = { nodes: number; characters: number; truncated: boolean; allowReviewToken: boolean; lists: ListTruncation[] };
const pointerKey = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
function redactArray(value: unknown[], budget: OutputBudget, depth: number, path: string): unknown[] {
  if (value.length > 25) {
    budget.truncated = true;
    if (budget.lists.length < 20) budget.lists.push({ path, total: value.length, returnedCount: 25, nextOffset: 25 });
  }
  return value.slice(0, 25).map((item, index) => redact(item, budget, depth + 1, `${path}/${index}`));
}
function redact(value: unknown, budget: OutputBudget, depth = 0, path = ""): unknown {
  if (++budget.nodes > 5000 || budget.characters > 60000 || depth > 20) { budget.truncated = true; return "[result omitted: request a narrower resultPath]"; }
  if (typeof value === "string") {
    const clean = safeText(value); budget.characters += Math.min(clean.length, 12000);
    if (clean.length > 12000) { budget.truncated = true; return clean.slice(0, 12000) + "… [truncated]"; }
    return clean;
  }
  if (Array.isArray(value)) return redactArray(value, budget, depth, path);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !forbiddenKeys.has(key)).map(([key, child]) =>
    [key, secretField(key, budget.allowReviewToken) ? "[redacted]" : redact(child, budget, depth + 1, `${path}/${pointerKey(key)}`)]));
}

function selectedResult(result: unknown, path: unknown): unknown {
  if (path === undefined || path === "") return result;
  let selected = result;
  for (const part of String(path).slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (forbiddenKeys.has(key) || !selected || typeof selected !== "object" || !Object.hasOwn(selected, key)) throw new Error("resultPath does not exist in this result.");
    selected = (selected as Values)[key];
  }
  return selected;
}

function failedReceipt(result: unknown, name: string): Values {
  if (!object(result)) return {};
  const status = typeof result.status === "string" ? result.status.toLowerCase() : "";
  const mutation = toolKinds.get(name) !== "read";
  const uncertain = mutation && ["uncertain", "notconfirmed", "unknown", "interrupted"].includes(status);
  const failed = result.success === false || mutation && ["failed", "rejected", "cancelled", "canceled"].includes(status);
  const explicitError = typeof result.error === "string" && result.error.length > 0;
  if (!uncertain && !failed && !explicitError) return {};
  const diagnostic = [result.error, result.message, result.stderr].find(value => typeof value === "string" && value.trim());
  const message = safeText(typeof diagnostic === "string" ? diagnostic.slice(0, 4096) : "The gateway operation did not succeed.");
  const effectsMayHaveOccurred = mutation;
  return { error: message, outcome: uncertain ? "uncertain" : "failed", effectsMayHaveOccurred, retryAutomatically: false,
    guidance: effectsMayHaveOccurred ? "Side effects may already have occurred. Inspect authoritative state before another attempt. Do not automatically retry this operation."
      : "Inspect the reported problem before trying again." };
}

/** Every response is bounded; JSON Pointer selection retrieves omitted subtrees without exposing secrets. */
function resultPage(result: unknown, args: Values, name: string): unknown {
  const budget: OutputBudget = { nodes: 0, characters: 0, truncated: false, lists: [], allowReviewToken: /^(commands_review|tag_actions_review|source_migration_preview)$/.test(name) };
  // Redact before selecting a subtree so a resultPath cannot bypass secret-field handling.
  const selected = selectedResult(redactSensitiveTree(result, budget.allowReviewToken), args.resultPath);
  const page = boundedPage(selected, args, budget), truncated = budget.truncated || page.nextOffset != null;
  return { ...failedReceipt(result, name), ...page, truncated,
    ...(page.total === undefined ? {} : { showing: `Showing ${page.returnedCount} of ${page.total} ${Array.isArray(selected) ? "items" : "characters"}.` }),
    ...(truncated ? { notice: "Result bounded. More data is available; do not treat this as the complete list.", filterHint: "Use a supported tool filter to narrow the request, or resultPath (JSON Pointer), offset and limit to inspect the next page." } : {}),
    ...(budget.lists.length ? { truncatedLists: budget.lists } : {}) };
}

function boundedRows(rows: unknown[], offset: number, limit: number, budget: OutputBudget, path: string): unknown[] {
  const data: unknown[] = [];
  for (const row of rows.slice(offset, offset + limit)) {
    const previousLists = budget.lists.length, bounded = redact(row, budget, 0, `${path}/${offset + data.length}`);
    if (budget.nodes > 5000 || budget.characters > 60000) {
      budget.truncated = true;
      if (data.length) { budget.lists.length = previousLists; break; }
    }
    data.push(bounded);
  }
  return data;
}

function boundedPage(selected: unknown, args: Values, budget: OutputBudget): { data: unknown; total?: number; offset?: number; returnedCount?: number; nextOffset?: number | null } {
  const path = typeof args.resultPath === "string" ? args.resultPath : "";
  if (!Array.isArray(selected) && typeof selected !== "string") return { data: redact(selected, budget, 0, path) };
  const offset = Number(args.offset ?? 0), limit = Math.min(Number(args.limit ?? (Array.isArray(selected) ? 25 : 100)), typeof selected === "string" ? 12000 : 200);
  const data = Array.isArray(selected) ? boundedRows(selected, offset, limit, budget, path) : redact(selected.slice(offset, offset + limit), budget, 0, path) as string;
  const returnedCount = data.length, next = offset + returnedCount;
  return { data, total: selected.length, offset, returnedCount, nextOffset: next < selected.length ? next : null };
}

function redactSensitiveTree(value: unknown, allowReviewToken: boolean, depth = 0): unknown {
  if (depth > 64) return "[result exceeds nesting limit]";
  if (Array.isArray(value)) return value.map(item => redactSensitiveTree(item, allowReviewToken, depth + 1));
  if (!object(value)) return typeof value === "string" ? safeText(value) : value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !forbiddenKeys.has(key)).map(([key, child]) =>
    [key, secretField(key, allowReviewToken) ? "[redacted]" : redactSensitiveTree(child, allowReviewToken, depth + 1)]));
}

async function responseBytes(response: Response, maximum = maximumResponseBytes): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length") ?? 0) > maximum) throw new Error("Gateway response is too large. Narrow the request.");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > maximum) { await reader.cancel(); throw new Error("Gateway response is too large. Narrow the request."); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function request(path: string, context: GatewayToolContext, signal: AbortSignal | undefined, options: Request = {}): Promise<unknown> {
  (context as BoundContext)[operationGuard]?.();
  signal?.throwIfAborted();
  const id = options.scoped ? projectId(context) : null;
  const preview = preparePreviewRequest(path, signal);
  try {
  const isBlob = options.body instanceof Blob;
  const headers = { ...preview.headers, ...(options.body === undefined ? {} : { "Content-Type": isBlob ? "application/zip" : "application/json" }) };
  const response = await fetchForTool(apiUrl(preview.path, id), context, { method: options.method ?? "GET", signal: preview.signal, headers,
    body: options.body === undefined ? undefined : isBlob ? options.body as Blob : JSON.stringify(options.body) });
  const bytes = await responseBytes(response, options.binary ? 128 * 1024 * 1024 : maximumResponseBytes);
  preview.assertCurrent();
  assertToolResponse(context, response);
  signal?.throwIfAborted();
  if (options.binary && response.ok) return new Blob([bytes as BlobPart], { type: response.headers.get("content-type") ?? "application/octet-stream" });
  const raw = new TextDecoder().decode(bytes); let data: unknown;
  try { data = raw ? JSON.parse(raw) : null; } catch { throw new ApiError(`Gateway returned a non-JSON response (${response.status}).`, response.status); }
  if (!response.ok) {
    const error = object(data) ? data : {};
    throw new ApiError(safeText(String(error.message ?? error.error ?? error.detail ?? `Gateway request failed (${response.status}).`)), response.status);
  }
  return data;
  } finally { preview.finish(); }
}

function fetchForTool(path: string, context: GatewayToolContext, init: RequestInit): Promise<Response> {
  const grant = (context as BoundContext)[operatorGrant];
  if (!grant) return authenticatedFetch(path, init);
  if (new Headers(init.headers).has("X-SPARK-PREVIEW")) throw new Error("Exit Designer Preview before testing the published operator runtime.");
  return runtimeAuthenticatedFetch(path, init, context, grant);
}

function assertToolResponse(context: GatewayToolContext, response: Response): void {
  (context as BoundContext)[operationGuard]?.();
  if (!(context as BoundContext)[operatorGrant] && response.status !== 401) assertAuthResponseCurrent(response);
}

function runtimeGrant(name: string): OperatorGrant | undefined {
  const permission = toolPermissions.get(name);
  return permission === "view" || permission === "operate" || permission === "command" ? permission : undefined;
}

function endpoint(path: string | ((args: Values) => string), method = "GET", keys?: string[], scoped = false): Run {
  return (args, context, signal) => request(typeof path === "string" ? path : path(args), context, signal,
    { method, scoped, body: method === "GET" ? undefined : keys ? select(args, keys) : bodyArgs(args) });
}
const connectionPath = (args: Values, suffix = "") => `/connections/${segment(args)}${suffix}`;
const sourcePath = (args: Values, suffix: string) => connectionPath(args, `/source/${suffix}`);
const query = (args: Values, keys: string[]): string => {
  const parameters = new URLSearchParams(Object.entries(select(args, keys)).map(([key, value]) => [key, String(value)]));
  return parameters.size ? `?${parameters}` : "";
};

async function secret(args: Values, context: GatewayToolContext, purpose: string, allowed: string[]): Promise<Values> {
  if (!context.resolveSecret) throw new Error("Secure credential entry is required. Open the connection or account settings to supply credentials.");
  const result = await context.resolveSecret(typeof args.secretHandle === "string" ? args.secretHandle : undefined, purpose);
  const values = select(result, allowed);
  if (!Object.keys(values).length || Object.values(values).some(value => typeof value !== "string" || value.length > 16384))
    throw new Error("Secure credential entry did not return valid credentials.");
  return values;
}

async function attachment(args: Values, context: GatewayToolContext, purpose: string, maximum: number): Promise<Blob> {
  if (!context.resolveAttachment) throw new Error("Choose a local file using the assistant attachment control first.");
  const blob = await context.resolveAttachment(typeof args.attachmentHandle === "string" ? args.attachmentHandle : undefined, purpose);
  if (!(blob instanceof Blob) || blob.size < 1 || blob.size > maximum) throw new Error(`Attachment size must be 1–${maximum} bytes.`);
  return blob;
}

async function saveDownload(blob: Blob, filename: string, context: GatewayToolContext): Promise<unknown> {
  (context as BoundContext)[operationGuard]?.();
  if (context.download) await context.download(blob, filename);
  else {
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return { downloaded: true, filename, bytes: blob.size };
}

async function fetchConnection(args: Values, context: GatewayToolContext, signal?: AbortSignal): Promise<Values> {
  const list = await request("/connections", context, signal);
  const found = Array.isArray(list) ? list.find(item => object(item) && item.id === args.id) : null;
  if (!object(found)) throw new Error("Connection not found.");
  return found;
}

function expectRevision(document: Values, args: Values, name = "revision"): void {
  if (document.revision !== args[name]) throw new Error("The resource changed after it was read. Reload and review the change again.");
}

async function saveConnection(args: Values, context: GatewayToolContext, signal?: AbortSignal): Promise<unknown> {
  const input = structuredClone(args.connection) as Values;
  if (input.revision !== undefined) {
    const current = await fetchConnection({ id: input.id }, context, signal); expectRevision(current, input);
  }
  return request("/connections", context, signal, { method: "POST", body: input });
}

async function connectionCredentials(args: Values, context: GatewayToolContext, signal?: AbortSignal): Promise<unknown> {
  const current = await fetchConnection(args, context, signal); expectRevision(current, args);
  if (object(current.source)) {
    const credentials = await secret(args, context, "source-connection", ["password", "token"]);
    current.source = { ...current.source, authentication: { ...(current.source.authentication as Values), ...credentials } };
  } else Object.assign(current, await secret(args, context, "connection", ["password"]));
  return request("/connections", context, signal, { method: "POST", body: current });
}

function mergeSettings(current: Values, patch: Values): Values {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch))
    next[key] = object(value) && object(next[key]) ? mergeSettings(next[key] as Values, value) : value;
  return next;
}

async function updateConnectionPart(args: Values, context: GatewayToolContext, signal: AbortSignal | undefined, part: "device" | "source"): Promise<unknown> {
  const current = await fetchConnection(args, context, signal); expectRevision(current, args);
  if (!object(current[part])) throw new Error(`This connection does not have ${part} settings.`);
  current[part] = mergeSettings(current[part] as Values, args.settings as Values);
  if (args.sourceMigrationToken) current.sourceMigrationToken = args.sourceMigrationToken;
  return request("/connections", context, signal, { method: "POST", body: current });
}

async function mqttMapping(args: Values, context: GatewayToolContext, signal?: AbortSignal): Promise<unknown> {
  const current = await fetchConnection(args, context, signal); expectRevision(current, args);
  if (current.type !== "mqtt" || !object(current.source) || !object(current.source.mqtt)) throw new Error("Choose an MQTT connection.");
  const mqtt = current.source.mqtt, mappings = Array.isArray(mqtt.mappings) ? mqtt.mappings as Values[] : [];
  const mapping = args.mapping as Values;
  mqtt.mappings = [...mappings.filter(item => item.id !== mapping.id), mapping];
  if (args.sourceMigrationToken) current.sourceMigrationToken = args.sourceMigrationToken;
  return request("/connections", context, signal, { method: "POST", body: current });
}

async function tagModel(context: GatewayToolContext, signal?: AbortSignal): Promise<Values> {
  const model = await request("/tag-engineering/export", context, signal);
  if (!object(model)) throw new Error("Gateway returned an invalid tag model.");
  return model;
}

function tagPackage(value: Values): Values {
  return { format: "sparkstudio.tags", version: 3, tags: [], udtDefinitions: [], instances: [], scanGroups: [], hierarchy: [], ...value };
}

async function previewTagPart(args: Values, context: GatewayToolContext, signal: AbortSignal | undefined, collection: string): Promise<unknown> {
  const package_ = tagPackage({ [collection]: args.items });
  const review = await request("/tag-engineering/preview", context, signal, { method: "POST", body: package_ });
  return { package: package_, review };
}

async function previewProvider(args: Values, context: GatewayToolContext, signal?: AbortSignal): Promise<unknown> {
  const package_ = tagPackage({ provider: { name: "default", enabled: args.enabled } });
  const review = await request("/tag-engineering/preview", context, signal, { method: "POST", body: package_ });
  return { package: package_, review };
}

function requireDirectTagImport(package_: Values): void {
  const modelFields = ["udtDefinitions", "instances", "hierarchy", "removeUdtDefinitions", "removeInstances", "removeHierarchy"];
  if (modelFields.some(key => Array.isArray(package_[key]) && package_[key].length > 0)
    || object(package_.provider) && package_.provider.requireDeclaredHierarchy !== undefined)
    throw new Error("Model changes must be reviewed and applied by the user in Models. Use model_draft to prepare the change.");
}

type ModelWorkspaceModule = typeof import("./modelWorkspace");
type ModelDraftInput = import("./modelWorkspace").ModelDraft;
const modelsLink = (params: Record<string, string>) => "/workspace?" + new URLSearchParams({ workspace: "models", ...params }).toString();
function parseDraftJson(text: unknown, label: string): unknown {
  if (typeof text !== "string") return undefined;
  try { return JSON.parse(text); } catch { throw new Error(label + " is not valid JSON."); }
}
function assistantDraft(args: Values, workspace: ModelWorkspaceModule): ModelDraftInput {
  const draft: ModelDraftInput = { origin: "ask-spark" };
  const definition = parseDraftJson(args.definitionJson, "definitionJson");
  if (definition !== undefined) {
    if (!object(definition) || typeof definition.id !== "string" || !Number.isSafeInteger(definition.version) || !Array.isArray(definition.members))
      throw new Error("The definition must contain id, version and a members array.");
    draft.definition = definition as unknown as import("./modelWorkspace").ModelDefinition;
  }
  const package_ = parseDraftJson(args.packageJson, "packageJson");
  if (package_ !== undefined) {
    if (!object(package_)) throw new Error("packageJson must be one model package object.");
    draft.package = { ...workspace.emptyModelPackage(), ...package_, format: "sparkstudio.tags", version: 3 } as import("./modelWorkspace").ModelPackage;
  }
  if (typeof args.csv === "string") draft.csv = args.csv;
  if (Array.isArray(args.locationRenames)) draft.locationRenames = args.locationRenames as import("./modelWorkspace").ModelLocationRename[];
  if (Array.isArray(args.moves)) draft.moves = args.moves as import("./modelWorkspace").ModelMachineMove[];
  if (Object.keys(draft).length === 1) throw new Error("Provide a definition, package, CSV, location renames or machine moves.");
  return draft;
}
function draftLink(draft: ModelDraftInput, workspace: ModelWorkspaceModule): string {
  const type = draft.definition ?? draft.package?.udtDefinitions?.[0];
  if (type) return modelsLink({ view: "models", type: workspace.definitionKey(type) });
  const move = draft.moves?.[0], machine = move ? move.destination + "/" + String(move.paths[0]).split("/").at(-1) : draft.package?.instances?.[0]?.path;
  if (machine) return modelsLink({ view: "plant", item: machine, kind: "machine" });
  const location = draft.package?.hierarchy?.[0]?.path ?? draft.locationRenames?.[0]?.path;
  return location ? modelsLink({ view: "plant", item: location, kind: "location" }) : modelsLink({ view: "plant" });
}

/** Merge the proposal exactly as Models will, preview that delta against saved configuration, then hand it to the user's Models draft. */
async function draftModel(args: Values, context: GatewayToolContext, signal?: AbortSignal): Promise<unknown> {
  if (typeof context.ownerId !== "string" || !context.ownerId) throw new Error("A signed-in engineering user is required to prepare a model draft.");
  const workspace = await import("./modelWorkspace"), drafts = await import("./modelDraft");
  const draft = assistantDraft(args, workspace);
  const saved = await tagModel(context, signal) as unknown as import("./modelWorkspace").ModelPackage;
  const merged = drafts.mergeAssistantModelDraft(drafts.createModelDraft(saved), draft);
  const changes = drafts.modelDraftChanges(saved, merged.present);
  if (!changes.length) throw new Error("This proposal does not change the saved model.");
  const preview = await request("/tag-engineering/preview", context, signal, { method: "POST", body: drafts.modelDraftPackage(saved, merged.present) });
  (context as BoundContext)[operationGuard]?.(); signal?.throwIfAborted();
  workspace.openModelDraft(draft, context.ownerId);
  const url = draftLink(draft, workspace);
  return { status: "draft_prepared", applied: false, summary: drafts.modelDraftChangeSummary(changes), changes: changes.slice(0, 200), changeCount: changes.length, preview, url, markdown: "[Review in Models](" + url + ")",
    guidance: "Show the link. The proposal joins the user's unapplied Models draft when Models opens; the user reviews and applies it. The preview compares against saved configuration, not other unapplied edits. Ask Spark cannot apply model changes." };
}

/** The user's unapplied Models draft in this browser tab, plus any Ask Spark proposal Models has not opened yet. */
async function readModelDraft(_args: Values, context: GatewayToolContext): Promise<unknown> {
  if (typeof context.ownerId !== "string" || !context.ownerId) throw new Error("A signed-in engineering user is required to read the Models draft.");
  const drafts = await import("./modelDraft");
  let saved: Values | undefined;
  try { const text = drafts.readPersistedModelDraft(sessionStorage, context.ownerId); saved = text ? JSON.parse(text) as Values : undefined; }
  catch { throw new Error("The saved Models draft in this browser tab could not be read."); }
  const changes = Array.isArray(saved?.expected) ? (saved.expected as Values[]).map(item => ({ kind: item.kind, key: item.key, action: item.action })) : [];
  let pendingProposal = false;
  try { pendingProposal = Boolean(sessionStorage.getItem("sparkstudio.model-draft")); } catch { /* Browser storage can be unavailable. */ }
  return { hasDraft: changes.length > 0, changeCount: changes.length, changes, package: saved?.package ?? null, fromAskSpark: saved?.fromAskSpark ?? [], pendingAssistantProposal: pendingProposal,
    scope: "This browser tab only. Changes appear after Models records them; an unopened Ask Spark proposal is reported separately and is not merged yet." };
}

async function publishingSnapshot(context: GatewayToolContext, signal?: AbortSignal): Promise<Values> {
  const snapshot = await request("/model/publishing", context, signal);
  if (!object(snapshot) || !Array.isArray(snapshot.publishers)) throw new Error("Gateway returned invalid model publishing settings.");
  return snapshot;
}
async function savePublisher(args: Values, context: GatewayToolContext, signal?: AbortSignal): Promise<unknown> {
  const publisher = structuredClone(args.publisher) as Values;
  const snapshot = await publishingSnapshot(context, signal);
  if (snapshot.revision !== args.revision) throw new Error("Model publishing changed after it was read. Reload and review the change again.");
  return request("/model/publishing/" + encodeURIComponent(String(publisher.id)), context, signal, { method: "PUT", body: { revision: args.revision, publisher } });
}
/** The broker password is typed by the user in the secure dialog; it never enters the conversation. */
async function publisherCredentials(args: Values, context: GatewayToolContext, signal?: AbortSignal): Promise<unknown> {
  const snapshot = await publishingSnapshot(context, signal);
  if (snapshot.revision !== args.revision) throw new Error("Model publishing changed after it was read. Reload and review the change again.");
  const publisher = (snapshot.publishers as unknown[]).find(item => object(item) && item.id === args.id);
  if (!object(publisher)) throw new Error("Model publisher not found.");
  if (typeof publisher.username !== "string" || !publisher.username) throw new Error("Save a broker username on this publisher before entering its password.");
  const { password } = await secret(args, context, "model-publisher", ["password"]);
  return request("/model/publishing/" + segment(args), context, signal, { method: "PUT", body: { revision: args.revision, publisher: { ...publisher, password, clearPassword: false, hasPassword: false } } });
}

function modelReadPath(path: string, context: GatewayToolContext): string {
  return context.projectId == null ? `/model/${path}` : `/projects/${encodeURIComponent(projectId(context))}/model/${path}`;
}

function modelRead(path: string, keys: string[]): Run {
  return (args, context, signal) => request(`${modelReadPath(path, context)}${query({ ...args, offset: args.pageOffset ?? 0, limit: args.pageSize ?? 25 }, [...keys, "offset", "limit"])}`, context, signal);
}

async function resourceFromList(args: Values, context: GatewayToolContext, signal: AbortSignal | undefined, path: string, key: string, scoped = false): Promise<unknown> {
  const response = await request(path, context, signal, { scoped });
  const list = Array.isArray(response) ? response : object(response) && Array.isArray(response.resources) ? response.resources : [];
  const item = list.find(value => object(value) && value[key] === args[key]);
  if (!item) throw new Error("Resource not found.");
  return item;
}

async function getScriptDraft(context: GatewayToolContext, signal?: AbortSignal): Promise<Values> {
  const draft = await request("/scripts/resources", context, signal, { scoped: true });
  if (!object(draft) || !Array.isArray(draft.resources)) throw new Error("Gateway returned an invalid script draft.");
  return draft;
}

async function editScript(args: Values, context: GatewayToolContext, signal: AbortSignal | undefined, remove = false): Promise<unknown> {
  const draft = await getScriptDraft(context, signal); expectRevision(draft, args);
  const resource = args.resource as Values | undefined, id = resource?.id ?? args.id;
  const previous = draft.resources as Values[];
  if (remove && !previous.some(item => item.id === id)) throw new Error("Script resource not found.");
  draft.resources = previous.filter(item => item.id !== id);
  if (!remove) (draft.resources as unknown[]).push(resource);
  return request("/scripts/resources", context, signal, { method: "PUT", body: draft, scoped: true });
}

async function getProject(context: GatewayToolContext, signal?: AbortSignal): Promise<Values> {
  const project = await request("/project", context, signal, { scoped: true });
  if (!object(project)) throw new Error("Gateway returned an invalid project.");
  return project;
}

async function saveCommands(args: Values, context: GatewayToolContext, signal?: AbortSignal): Promise<unknown> {
  const project = await getProject(context, signal); expectRevision(project, args);
  project.commands = args.commands;
  return request("/project", context, signal, { method: "PUT", body: project, scoped: true });
}

async function saveUser(args: Values, context: GatewayToolContext, signal: AbortSignal | undefined, create: boolean): Promise<unknown> {
  const fields = ["revision", "username", "displayName", "gatewayAdmin", "disabled", "projectGrants", "gatewayCapabilities"];
  const body = select(args, fields);
  if (create || args.updateCredentials || args.secretHandle) Object.assign(body, await secret(args, context, create ? "create-user" : "update-user", ["password"]));
  return request(create ? "/security/users" : `/security/users/${segment(args)}`, context, signal, { method: create ? "POST" : "PUT", body });
}

async function backupSecret(args: Values, context: GatewayToolContext, signal: AbortSignal | undefined, archive = false): Promise<unknown> {
  const current = await request("/gateway/backups", context, signal);
  if (!object(current)) throw new Error("Invalid backup configuration.");
  expectRevision(current, args);
  const body: Values = { revision: args.revision, settings: current.saved };
  if (archive) Object.assign(body, await secret(args, context, "backup-archive", ["archivePassphrase"]));
  else body.destinationSecrets = [{ destinationId: args.destinationId, ...await secret(args, context, "backup-destination", ["password", "secretAccessKey", "sessionToken"]) }];
  return request("/gateway/backups", context, signal, { method: "PUT", body });
}

async function assetUpload(args: Values, context: GatewayToolContext, signal?: AbortSignal): Promise<unknown> {
  const blob = await attachment(args, context, "asset-upload", 512 * 1024);
  const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return request("/assets", context, signal, { method: "POST", scoped: true, body: { name: args.name, contentType: blob.type, dataBase64: btoa(binary) } });
}

async function certificateTrust(args: Values, context: GatewayToolContext, signal?: AbortSignal): Promise<unknown> {
  const blob = await request(`/gateway/opcua/certificates/${segment(args, "store")}/${segment(args, "sha256")}`, context, signal, { binary: true }) as Blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  if (fingerprint.toLowerCase() !== field(args, "sha256").toLowerCase()) throw new Error("Certificate fingerprint changed. Inspect the certificate again.");
  return request("/gateway/opcua/certificates/trust", context, signal, { method: "POST", body: { certificate: btoa(String.fromCharCode(...bytes)), confirmedSha256: args.sha256 } });
}

async function prepareRecovery(_args: Values, context: GatewayToolContext, signal?: AbortSignal): Promise<unknown> {
  const recovery = await request("/gateway/recovery", context, signal);
  const deployment = await request("/gateway/deployment/settings", context, signal);
  return { recovery, deployment, changesApplied: false, onlineRestoreSupported: false,
    checklist: ["Download and verify a current configuration backup.", "Use the documented offline backup/restore procedure for database contents, history and audit.", "Stop the gateway before an offline restore.", "Review restored connections, published scripts, accounts and deployment before approving recovery.", "Restart deliberately, then verify the actual listeners and gateway health."] };
}

const handlers: Record<string, Run> = {
  model_types: modelRead("types", ["type"]),
  model_tree: modelRead("tree", ["path", "depth"]),
  model_instances: modelRead("instances", ["type", "version", "under"]),
  model_object: (args, context, signal) => request(`${modelReadPath("object", context)}${query(args, ["path"])}`, context, signal),
  model_draft: draftModel,
  model_draft_get: readModelDraft,
  model_issues: modelRead("issues", ["path"]),
  model_units: (_args, context, signal) => request(modelReadPath("units", context), context, signal),
  model_dependencies: endpoint(args => "/model/dependencies" + query(args, ["type", "instance", "query"])),
  model_versions_compare: async (args, context, signal) => request("/model/versions/compare", context, signal, { method: "POST",
    body: { definition: parseDraftJson(args.definitionJson, "definitionJson"), fromVersion: args.fromVersion, definitions: parseDraftJson(args.definitionsJson, "definitionsJson") } }),
  model_starters: endpoint("/model/starters"),
  model_export: endpoint("/model/export", "POST", ["definitionKeys", "instancePaths", "includeSourceTags"]),
  model_publishing_get: endpoint("/model/publishing"),
  model_publishing_preview: endpoint("/model/publishing/preview", "POST", ["publisher"]),
  model_publishing_save: savePublisher,
  model_publishing_set_credentials: publisherCredentials,
  model_publishing_test: endpoint(args => "/model/publishing/" + segment(args) + "/test", "POST", []),
  model_publishing_discard: endpoint(args => "/model/publishing/" + segment(args) + "/discard", "POST", []),
  model_publishing_delete: endpoint(args => "/model/publishing/" + segment(args) + query(args, ["revision", "discardPending"]), "DELETE", []),
  runtime_test_session: (_args, context, signal) => testRuntimeSession(context, signal),
  runtime_operator_sign_in: (args, context, signal) => signInRuntime(args, context, signal),
  navigate_workspace: async (args, context) => askSparkNavigationLink(args, context),
  gateway_overview: endpoint("/gateway/overview"),
  gateway_diagnostics: endpoint("/gateway/diagnostics"),
  gateway_support_snapshot: endpoint("/gateway/support-snapshot"),
  gateway_health: endpoint("/health"),
  gateway_drivers: endpoint("/device-drivers"),
  projects_list: endpoint("/projects"),
  projects_create: endpoint("/projects", "POST", ["name"]),
  projects_rename: endpoint(args => `/projects/${segment(args)}`, "PATCH", ["name", "revision"]),
  projects_duplicate: endpoint(args => `/projects/${segment(args)}/duplicate`, "POST", ["name"]),
  projects_archive: endpoint(args => `/projects/${segment(args)}/archive`, "POST", ["archived"]),
  projects_export: async (args, context, signal) => saveDownload(await request(`/projects/${segment(args)}/export`, context, signal, { binary: true }) as Blob, `${field(args, "id")}.sparkproj`, context),
  projects_import: async (args, context, signal) => request(`/projects/import${query(args, ["name"])}`, context, signal, { method: "POST", body: await attachment(args, context, "project-import", 32 * 1024 * 1024) }),
  project_get: (_args, context, signal) => getProject(context, signal),
  publication_get: endpoint("/project/publication", "GET", undefined, true),
  publication_review: endpoint("/project/publication-review", "GET", undefined, true),
  publication_publish: endpoint("/project/publish", "POST", ["revision", "scriptsRevision", "reviewToken"], true),
  publication_history: endpoint("/project/history", "GET", undefined, true),
  publication_restore: endpoint(args => `/project/history/${segment(args)}/restore`, "POST", ["expectedPublishedAt", "acknowledgeLegacy"], true),
  connections_list: endpoint("/connections"),
  connections_get: fetchConnection,
  connections_save: saveConnection,
  connections_set_credentials: connectionCredentials,
  connections_set_enabled: async (args, context, signal) => {
    const current = await fetchConnection(args, context, signal); expectRevision(current, args);
    return request("/connections", context, signal, { method: "POST", body: { ...current, enabled: args.enabled } });
  },
  connections_delete: endpoint(args => connectionPath(args), "DELETE", ["revision"]),
  connections_test: endpoint(args => connectionPath(args, "/test"), "POST", []),
  connections_diagnostics: endpoint(args => connectionPath(args, "/diagnostics")),
  connections_discover_endpoints: endpoint(args => `/opcua/endpoints${query(args, ["endpoint"])}`),
  connections_browse: endpoint(args => connectionPath(args, `/browse${query(args, ["nodeId"])}`)),
  points_configure: (args, context, signal) => updateConnectionPart(args, context, signal, "device"),
  points_read: endpoint(args => connectionPath(args, "/read"), "POST", ["revision", "nodeIds"]),
  database_schema: endpoint(args => connectionPath(args, "/schema")),
  database_create: endpoint(args => connectionPath(args, "/database"), "POST", ["initializeSampleData"]),
  source_configure: (args, context, signal) => updateConnectionPart(args, context, signal, "source"),
  source_test: endpoint(args => sourcePath(args, "test"), "POST", ["revision"]),
  source_browse: endpoint(args => sourcePath(args, "browse"), "POST", ["revision", "parent", "pageSize", "continuationToken"]),
  source_read: endpoint(args => sourcePath(args, "read"), "POST", ["revision", "nodeIds"]),
  source_import_preview: endpoint(args => sourcePath(args, "import/preview"), "POST", ["revision", "points"]),
  source_import_apply: endpoint(args => sourcePath(args, "import/apply"), "POST", ["revision", "points", "previewToken"]),
  source_migration_preview: endpoint(args => sourcePath(args, "migration/preview"), "POST", ["revision", "source"]),
  source_ownership: endpoint(args => sourcePath(args, "ownership")),
  source_unsuppress: endpoint(args => sourcePath(args, "suppression/clear"), "POST", ["pointId"]),
  mqtt_mapping_save: mqttMapping,
  mqtt_test_payload: endpoint(args => sourcePath(args, "script/test"), "POST", ["revision", "mappingId", "topic", "payload", "retained", "mapping"]),
  tags_list: endpoint("/tag-definitions"),
  tags_get: (args, context, signal) => resourceFromList(args, context, signal, "/tag-definitions", "path"),
  tags_read: (args, context, signal) => request(`/projects/${encodeURIComponent(projectId(context))}/tags/read`, context, signal, { method: "POST", body: select(args, ["paths", "parameters"]) }),
  tags_model: (_args, context, signal) => tagModel(context, signal),
  tags_status: endpoint("/tag-engineering/status"),
  tags_subscriptions: endpoint("/opcua/subscriptions"),
  tags_import_preview: (args, context, signal) => request("/tag-engineering/preview", context, signal, { method: "POST", body: tagPackage(args.package as Values) }),
  tags_import_apply: (args, context, signal) => { requireDirectTagImport(args.package as Values); return request("/tag-engineering/apply", context, signal, { method: "POST", body: { ...select(args, ["revision", "previewToken"]), package: tagPackage(args.package as Values) } }); },
  tags_upsert_preview: (args, context, signal) => previewTagPart(args, context, signal, "tags"),
  tags_delete_preview: (args, context, signal) => previewTagPart(args, context, signal, "removeTags"),
  udts_define_preview: (args, context, signal) => previewTagPart(args, context, signal, "udtDefinitions"),
  udts_instances_preview: (args, context, signal) => previewTagPart(args, context, signal, "instances"),
  udts_remove_preview: (args, context, signal) => previewTagPart(args, context, signal, "removeUdtDefinitions"),
  udts_remove_instances_preview: (args, context, signal) => previewTagPart(args, context, signal, "removeInstances"),
  scan_groups_preview: (args, context, signal) => previewTagPart(args, context, signal, "scanGroups"),
  scan_groups_remove_preview: (args, context, signal) => previewTagPart(args, context, signal, "removeScanGroups"),
  provider_preview: previewProvider,
  process_data_get: endpoint("/gateway/process-data"),
  process_data_save: endpoint("/gateway/process-data", "PUT", ["revision", "alarmRetentionDays", "alarms", "history", "replaceInvalidConfiguration"]),
  process_data_diagnostics: endpoint("/gateway/process-data/diagnostics"),
  alarms_active: endpoint("/alarms", "GET", undefined, true),
  alarms_journal: endpoint(args => `/alarm-journal${query(args, ["limit"])}`, "GET", undefined, true),
  alarms_acknowledge: endpoint(args => `/alarms/${segment(args)}/ack`, "POST", ["eventId"], true),
  history_query: endpoint("/history/query", "POST", ["paths", "start", "end", "maxPoints"], true),
  commands_get: async (_args, context, signal) => { const project = await getProject(context, signal); return { revision: project.revision, commands: project.commands ?? [] }; },
  commands_save: saveCommands,
  commands_published: endpoint(args => `/runtime/commands${query(args, ["publishedAt"])}`, "GET", undefined, true),
  commands_review: endpoint(args => `/runtime/commands/${segment(args)}/review`, "POST", ["publishedAt", "value"], true),
  commands_execute: endpoint(args => `/runtime/commands/${segment(args)}/execute`, "POST", ["token", "confirmed"], true),
  users_list: endpoint("/security/users"),
  users_create: (args, context, signal) => saveUser(args, context, signal, true),
  users_update: (args, context, signal) => saveUser(args, context, signal, false),
  security_get: endpoint("/security/settings"),
  security_save: endpoint("/security/settings", "PUT", ["revision", "publicBaseUrl", "projectTagPrefixes"]),
  sessions_list: async (_args, context, signal) => { const overview = await request("/gateway/overview", context, signal); return object(overview) ? { currentSessionId: overview.currentSessionId, sessions: overview.sessions } : overview; },
  sessions_revoke: endpoint(args => `/gateway/sessions/${segment(args)}/revoke`, "POST", []),
  audit_query: endpoint(args => `/security/audit${query(args, ["limit"])}`),
  deployment_get: endpoint("/gateway/deployment"),
  deployment_settings: endpoint("/gateway/deployment/settings"),
  deployment_validate: (args, context, signal) => request("/gateway/deployment/settings/validate", context, signal, { method: "POST", body: args.settings }),
  deployment_save: endpoint("/gateway/deployment/settings", "PUT", ["revision", "settings"]),
  deployment_restore: endpoint("/gateway/deployment/settings/restore", "POST", ["revision"]),
  certificates_list: endpoint("/gateway/opcua/certificates"),
  certificates_trust: certificateTrust,
  certificates_remove: (args, context, signal) => request(`/gateway/opcua/certificates/trusted/${segment(args, "sha256")}/remove`, context, signal, { method: "POST", body: { confirmedSha256: args.sha256 } }),
  backups_get: endpoint("/gateway/backups"),
  backups_save: endpoint("/gateway/backups", "PUT", ["revision", "settings"]),
  backups_set_credentials: (args, context, signal) => backupSecret(args, context, signal),
  backups_set_archive_passphrase: (args, context, signal) => backupSecret(args, context, signal, true),
  backups_run: endpoint("/gateway/backups/run", "POST", ["deliver", "destinationId", "scheduleId"]),
  backups_download: async (args, context, signal) => saveDownload(await request(`/gateway/backups/download/${segment(args)}`, context, signal, { binary: true }) as Blob, `sparkstudio-backup-${field(args, "id")}.zip`, context),
  recovery_get: endpoint("/gateway/recovery"),
  recovery_prepare: prepareRecovery,
  recovery_approve: endpoint("/gateway/recovery/approve", "POST", ["revision", "confirmation", "reviewedConnections", "reviewedScripts", "reviewedIdentityAndDeployment"]),
  queries_list: endpoint("/queries", "GET", undefined, true),
  queries_get: (args, context, signal) => resourceFromList(args, context, signal, "/queries", "id", true),
  queries_review: endpoint(args => `/queries/${segment(args)}/review`, "GET", undefined, true),
  queries_save: (args, context, signal) => request(`/queries/${segment(args)}/reviewed`, context, signal, { method: "PUT", body: { query: args.definition, expectedFingerprint: args.expectedFingerprint }, scoped: true }),
  queries_delete: endpoint(args => `/queries/${segment(args)}/reviewed${query(args, ["expectedFingerprint"])}`, "DELETE", [], true),
  queries_execute: endpoint(args => `/queries/${segment(args)}/execute`, "POST", ["parameters", "timeoutMs"], true),
  scripts_list: endpoint("/scripts/resources", "GET", undefined, true),
  scripts_get: (args, context, signal) => resourceFromList(args, context, signal, "/scripts/resources", "id", true),
  scripts_validate: endpoint("/scripts/validate", "POST", ["code"], true),
  scripts_save: (args, context, signal) => editScript(args, context, signal),
  scripts_delete: (args, context, signal) => editScript(args, context, signal, true),
  scripts_publication: endpoint("/scripts/publication", "GET", undefined, true),
  scripts_status: endpoint("/scripts/events/status", "GET", undefined, true),
  scripts_logs: endpoint("/scripts/events/logs", "GET", undefined, true),
  scripts_run: endpoint(args => `/scripts/resources/${segment(args)}/run`, "POST", ["revision", "source", "parameters"], true),
  scripts_run_code: endpoint("/scripts/run", "POST", ["code", "parameters", "inputs"], true),
  scripts_cancel: endpoint(args => `/scripts/events/runs/${segment(args, "runId")}/cancel`, "POST", [], true),
  scripts_message_request: endpoint(args => `/scripts/messages/${segment(args, "name")}/request`, "POST", ["payload", "revision"], true),
  scripts_message_send: endpoint(args => `/scripts/messages/${segment(args, "name")}/send`, "POST", ["payload", "revision"], true),
  assets_list: endpoint("/assets", "GET", undefined, true),
  assets_upload: assetUpload,
  runtime_project: endpoint("/runtime/project", "GET", undefined, true),
  runtime_queries: endpoint(args => `/runtime/queries${query(args, ["publishedAt"])}`, "GET", undefined, true),
  runtime_query_execute: endpoint(args => `/runtime/queries/${segment(args)}/execute`, "POST", ["parameters", "publishedAt"], true),
  runtime_scripts: endpoint(args => `/runtime/scripts${query(args, ["publishedAt"])}`, "GET", undefined, true),
  runtime_action: endpoint(args => `/runtime/screens/${segment(args, "screenId")}/components/${segment(args, "componentId")}/action`, "POST", ["publishedAt", "parameters", "inputs", "instanceId", "rowId", "instancePath", "popupOrigin", "bindingInputs", "bindingState", "ui"], true),
  runtime_table_edit: (args, context, signal) => request(`/runtime/screens/${segment(args, "screenId")}/components/${segment(args, "componentId")}/table-edit`, context, signal, { method: "POST", body: args.edit, scoped: true }),
  tag_actions_review: endpoint(args => `/runtime/screens/${segment(args, "screenId")}/components/${segment(args, "componentId")}/tag-action/review`, "POST", ["publishedAt", "parameters", "inputs", "instanceId", "rowId", "instancePath", "popupOrigin", "bindingInputs", "bindingState", "ui"], true),
  tag_actions_execute: endpoint(args => `/runtime/screens/${segment(args, "screenId")}/components/${segment(args, "componentId")}/tag-action/execute`, "POST", ["token", "confirmed"], true),
  runtime_message_request: endpoint(args => `/runtime/messages/${segment(args, "name")}/request`, "POST", ["payload", "revision"], true),
  runtime_message_send: endpoint(args => `/runtime/messages/${segment(args, "name")}/send`, "POST", ["payload", "revision"], true),
};

export function supportsGatewayTool(name: string): boolean { return schemas.has(name) && Object.hasOwn(handlers, name); }

/** This is a fixed command registry, never an arbitrary URL/method proxy. Server authorization remains authoritative. */
export async function executeGatewayTool(name: string, args: Values, context: GatewayToolContext, signal?: AbortSignal): Promise<unknown> {
  if (!supportsGatewayTool(name)) throw new Error("Unknown gateway tool.");
  if (!object(args) || JSON.stringify(args).length > 1024 * 1024) throw new Error("Tool arguments must be a bounded JSON object.");
  if (toolKinds.get(name) !== "read" && Object.hasOwn(args, "resultPath")) throw new Error("resultPath is only available for read tools. No operation was performed.");
  checkValue(args, schemas.get(name)!, "arguments");
  const revision = authSessionRevision();
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (authSessionRevision() !== revision) throw new Error("The signed-in session changed. Review this action again.");
  };
  assertCurrent();
  const result = await handlers[name](args, { ...context, [operationGuard]: assertCurrent, [operatorGrant]: runtimeGrant(name) }, signal);
  assertCurrent();
  return resultPage(result, args, name);
}
