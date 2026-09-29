import type { RuntimeParameters } from "./types";
import { authenticatedFetch, assertAuthResponseCurrent } from "./authSession";
import { preparePreviewRequest } from "./previewRequest";
export { authenticatedFetch, assertAuthResponseCurrent, authHeaders, eventStreamUrl } from "./authSession";
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ProjectRoute = { kind: "home" } | { kind: "security" } | { kind: "gateway" } | { kind: "designer" | "runtime"; projectId: string | null } | { kind: "invalid" };
const projectIdPattern = /^[a-z][a-z0-9-]{0,63}$/;

/** Route IDs are opaque catalog keys, never arbitrary path fragments. */
export function parseProjectRoute(pathname: string): ProjectRoute {
  if (pathname === "/" || pathname === "/projects" || pathname === "/projects/") return { kind: "home" };
  if (pathname === "/security" || pathname === "/security/") return { kind: "security" };
  if (pathname === "/gateway" || pathname === "/gateway/") return { kind: "gateway" };
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
  const scoped = /^\/(?:project|queries|scripts|assets|runtime|preview)(?:\/|\?|$)/.test(path);
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
    } | null;
    throw new ApiError(
      error?.message ||
        error?.error ||
        error?.detail ||
        (response.status === 403 ? "You do not have permission to perform this action." : response.status === 401 ? "Sign in to continue." : `Request failed (${response.status}). ${raw.slice(0, 160)}`),
      response.status,
    );
  }
  if (data === null && raw)
    throw new Error(
      "The gateway returned an unexpected response. Check that the gateway is running.",
    );
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
