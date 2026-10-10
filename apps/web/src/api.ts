import type { RuntimeParameters } from "./types";
import { authenticatedFetch, assertAuthResponseCurrent } from "./authSession";
import { preparePreviewRequest } from "./previewRequest";
export { authenticatedFetch, assertAuthResponseCurrent, authHeaders, eventStreamUrl } from "./authSession";
export interface AiProviderError { provider: "Gemini"; httpStatus: number; status?: string; message?: string; retryable: boolean }
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly aiProviderError?: AiProviderError,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Provider responses are untrusted text; retain only the bounded public error fields. */
function readAiProviderError(value: unknown): AiProviderError | undefined {
  if (!value || typeof value !== "object") return undefined;
  const error = value as Record<string, unknown>;
  if (error.provider !== "Gemini" || !Number.isInteger(error.httpStatus) || Number(error.httpStatus) < 400 || Number(error.httpStatus) > 599 || typeof error.retryable !== "boolean") return undefined;
  return {
    provider: "Gemini", httpStatus: Number(error.httpStatus), retryable: error.retryable,
    status: typeof error.status === "string" ? error.status.slice(0, 64) : undefined,
    message: typeof error.message === "string" ? error.message.slice(0, 2048) : undefined,
  };
}

export type ProjectRoute = { kind: "home" } | { kind: "security" } | { kind: "gateway" } | { kind: "designer" | "runtime"; projectId: string | null } | { kind: "invalid" };
const projectIdPattern = /^[a-z][a-z0-9-]{0,63}$/;

/** Route IDs are opaque catalog keys, never arbitrary path fragments. */
export function parseProjectRoute(pathname: string): ProjectRoute {
  if (pathname === "/" || pathname === "/projects" || pathname === "/projects/") return { kind: "home" };
  if (pathname === "/security" || pathname === "/security/") return { kind: "security" };
  if (pathname === "/gateway" || pathname === "/gateway/") return { kind: "gateway" };
  // Tags and Models live in a project Designer; earlier /workspace links open the default project.
  if (pathname === "/workspace" || pathname === "/workspace/") return { kind: "designer", projectId: null };
  const match = /^\/(designer|runtime)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return { kind: "invalid" };
  if (!match[2]) return { kind: match[1] as "designer" | "runtime", projectId: null };
  let projectId: string;
  try { projectId = decodeURIComponent(match[2]); } catch { return { kind: "invalid" }; }
  return projectIdPattern.test(projectId) ? { kind: match[1] as "designer" | "runtime", projectId } : { kind: "invalid" };
}

export function currentProjectId(): string | null {
  const route = parseProjectRoute(typeof window === "undefined" ? "/" : window.location.pathname);
  return route.kind === "designer" || route.kind === "runtime" ? route.projectId : null;
}

export function projectPage(kind: "designer" | "runtime", projectId = currentProjectId()): string {
  if (projectId === null) return `/${kind}`;
  if (!projectIdPattern.test(projectId)) throw new Error("Invalid project ID.");
  return `/${kind}/${encodeURIComponent(projectId)}`;
}

/** Gateway resources are shared; only authoring/runtime application resources are scoped. */
export function apiUrl(path: string, projectId = currentProjectId()): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("Use a local API path.");
  const scoped = !/^\/model\/publishing(?:\/|\?|$)/.test(path) && /^\/(?:project|queries|scripts|assets|runtime|preview|alarms|alarm-journal|history|model)(?:\/|\?|$)/.test(path);
  if (!scoped || projectId === null) return `/api${path}`;
  if (!projectIdPattern.test(projectId)) throw new Error("Invalid project ID.");
  return `/api/projects/${encodeURIComponent(projectId)}${path}`;
}

export function projectStorageKey(key: string, projectId = currentProjectId()): string {
  return projectId ? `${key}.project.${projectId}` : key;
}

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const preview = preparePreviewRequest(path, signal);
  try {
  const response = await authenticatedFetch(apiUrl(preview.path), {
    signal: preview.signal,
    method,
    headers:
      { ...preview.headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await response.text();
  preview.assertCurrent();
  // A 401 already invalidated the session; still return its useful sign-in error.
  if (response.status !== 401) assertAuthResponseCurrent(response);
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = data as {
      message?: string;
      error?: string;
      detail?: string;
      aiProviderError?: unknown;
    } | null;
    throw new ApiError(
      error?.message ||
        error?.error ||
        error?.detail ||
        (response.status === 403 ? "You do not have permission to perform this action." : response.status === 401 ? "Sign in to continue." : `Request failed (${response.status}). ${raw.slice(0, 160)}`),
      response.status,
      readAiProviderError(error?.aiProviderError),
    );
  }
  if (data === null && raw)
    throw new Error(
      "The gateway returned an unexpected response. Check that the gateway is running.",
    );
  validateApiPayload(path, data);
  return data as T;
  } finally { preview.finish(); }
}

export function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}
export function resolvePath(
  path: string,
  parameters: RuntimeParameters,
): string {
  return path.replace(/\{([^{}]+)\}/g, (whole, key: string) =>
    Object.hasOwn(parameters, key) ? String(parameters[key]) : whole,
  );
}
export function displayValue(value: unknown): string {
  if (value == null) return "—";
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value)
  )
    return "Precision limit";
  if (typeof value === "number")
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
export function scriptFailureMessage(stderr: string): string {
  const text=stderr.trim();
  if (!text.startsWith("Traceback (most recent call last):")) return text || "The action failed.";
  const last=text.split(/\r?\n/).filter(line=>line.trim()).at(-1) || "The action failed.";
  return last.replace(/^[A-Za-z_][\w.]*:\s*/, "");
}


const apiDocumentRecord = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item);
const apiDocumentText = (item: unknown) => typeof item === "string" && item.length <= 65536;
const apiDocumentFinite = (item: unknown) => typeof item === "number" && Number.isFinite(item);
const invalidApiDocument = (): never => { throw new Error("The gateway returned an invalid application document. Retry or ask an administrator to inspect the project."); };

function validatePublicationDocument(document: Record<string, unknown>): void {
  if (typeof document.published !== "boolean" || document.revision !== undefined && (!apiDocumentFinite(document.revision) || !Number.isInteger(document.revision))
    || document.published && (typeof document.publishedAt !== "string" || !Number.isFinite(Date.parse(document.publishedAt)))) invalidApiDocument();
}

function validateApiView(item: unknown): Record<string, unknown> {
  if (!apiDocumentRecord(item) || !apiDocumentText(item.id) || !apiDocumentText(item.name) || !apiDocumentFinite(item.width) || !apiDocumentFinite(item.height)
    || (item.width as number) <= 0 || (item.height as number) <= 0 || !Array.isArray(item.components) || item.components.length > 10000) invalidApiDocument();
  return item as Record<string, unknown>;
}

function validateApiViewComponents(view: Record<string, unknown>): void {
  const componentIds = new Set<string>();
  for (const control of view.components as unknown[]) {
    if (!apiDocumentRecord(control) || !apiDocumentText(control.id) || !apiDocumentText(control.type) || !apiDocumentRecord(control.props)
      || ![control.x, control.y, control.width, control.height].every(apiDocumentFinite) || (control.width as number) <= 0 || (control.height as number) <= 0) invalidApiDocument();
    const component = control as Record<string, unknown>;
    if (componentIds.has(component.id as string)) invalidApiDocument();
    componentIds.add(component.id as string);
  }
}

function validateApiProjectMetadata(document: Record<string, unknown>): void {
  if (document.navigation !== undefined) {
    const navigation = document.navigation;
    if (!apiDocumentRecord(navigation) || !apiDocumentText(navigation.startupScreenId) || !["menu", "none"].includes(String(navigation.mode))
      || !Array.isArray(navigation.items) || !navigation.items.every(item => apiDocumentRecord(item) && apiDocumentText(item.screenId) && apiDocumentText(item.label))) invalidApiDocument();
  }
  if (document.styles !== undefined && (!Array.isArray(document.styles) || !document.styles.every(item => apiDocumentRecord(item) && apiDocumentText(item.id) && apiDocumentRecord(item.properties)))) invalidApiDocument();
  if (document.commands !== undefined && !Array.isArray(document.commands)) invalidApiDocument();
  if (document.localization !== undefined) {
    const catalog = document.localization;
    if (!apiDocumentRecord(catalog) || !apiDocumentText(catalog.defaultLocale) || !Array.isArray(catalog.locales) || !catalog.locales.every(apiDocumentText)
      || !apiDocumentRecord(catalog.messages) || !Object.values(catalog.messages).every(translations => apiDocumentRecord(translations) && Object.values(translations).every(apiDocumentText))) invalidApiDocument();
  }
}

function validateApiDocumentTree(document: Record<string, unknown>): void {
  let nodes = 0;
  const inspect = (item: unknown, depth: number): void => {
    if (++nodes > 1000000 || depth > 64) invalidApiDocument();
    if (Array.isArray(item)) { item.forEach(child => inspect(child, depth + 1)); return; }
    if (apiDocumentRecord(item)) for (const [key, child] of Object.entries(item)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) invalidApiDocument();
      inspect(child, depth + 1);
    }
  };
  inspect(document, 0);
}

/** Validate render-critical API documents before they can replace a working view. */
export function validateApiPayload(path: string, value: unknown): void {
  const route = path.split("?")[0];
  if (!/(?:^|\/)(?:project|publication)$/.test(route)) return;
  if (!apiDocumentRecord(value)) invalidApiDocument();
  const document = value as Record<string, unknown>;
  if (route.endsWith("/publication")) { validatePublicationDocument(document); return; }
  if (!apiDocumentText(document.id) || !apiDocumentText(document.name) || !apiDocumentFinite(document.revision) || !Number.isInteger(document.revision)
    || !apiDocumentRecord(document.parameters) || !Object.values(document.parameters).every(item => typeof item === "string")
    || !Array.isArray(document.screens) || document.screens.length > 4096) invalidApiDocument();
  if (document.templates !== undefined && (!Array.isArray(document.templates) || document.templates.length > 4096)) invalidApiDocument();
  const documents = [...document.screens as unknown[], ...(document.templates as unknown[] | undefined ?? [])], ids = new Set<string>();
  for (const [documentIndex, item] of documents.entries()) {
    const view = validateApiView(item);
    const viewKey = `${documentIndex < (document.screens as unknown[]).length ? "screen" : "template"}:${view.id}`;
    if (ids.has(viewKey)) invalidApiDocument();
    ids.add(viewKey);
    validateApiViewComponents(view);
  }
  validateApiProjectMetadata(document);
  validateApiDocumentTree(document);
}

const tagIndexes = new WeakMap<import("./types").Tag[], Map<string, import("./types").Tag>>();
/** Tag arrays are immutable snapshots; build one index for all consumers of a frame. */
export function tagByPath(tags: import("./types").Tag[], path: string): import("./types").Tag | undefined {
  let index = tagIndexes.get(tags);
  if (!index) { index = new Map(tags.map(tag => [tag.path, tag])); tagIndexes.set(tags, index); }
  return index.get(path);
}
