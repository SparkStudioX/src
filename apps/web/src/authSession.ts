export type AuthAudience = "engineering" | "operator";
export interface ProjectPermissions { view: boolean; operate: boolean; design: boolean; publish: boolean; commands?: boolean }
export const noPermissions: ProjectPermissions = { view: false, operate: false, design: false, publish: false, commands: false };
export interface GatewayCapabilities { diagnostics: boolean; configuration: boolean; backups: boolean; audit: boolean; sessions: boolean }
export const noGatewayCapabilities: GatewayCapabilities = { diagnostics: false, configuration: false, backups: false, audit: false, sessions: false };
export const authExpiredEvent = "sparkstudio:auth-expired";

let session: { audience: AuthAudience; projectId: string | null; csrfToken: string | null; key: string } = {
  audience: "engineering", projectId: null, csrfToken: null, key: "",
};
let generation = 0;
const responseGenerations = new WeakMap<Response, number>();
/** Stream callbacks must reject old credentials before React's effect cleanup runs. */
export const authSessionRevision = (): number => generation;

/** Tokens stay in memory; cookies remain managed by the gateway and browser. */
export function configureAuthSession(next: typeof session): void {
  if (JSON.stringify(next) !== JSON.stringify(session)) generation++;
  session = next;
}

export function authHeaders(method = "GET", projectId: string | null = session.projectId): Headers {
  const headers = new Headers({ "X-SPARK-AUDIENCE": session.audience });
  if (projectId) headers.set("X-SPARK-PROJECT", projectId);
  if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) && session.csrfToken)
    headers.set("X-SPARK-CSRF", session.csrfToken);
  return headers;
}

/** EventSource cannot send headers; only non-secret routing context belongs in its URL. */
export function eventStreamUrl(): string {
  const query = new URLSearchParams({ audience: session.audience });
  if (session.projectId) query.set("projectId", session.projectId);
  return `/api/events?${query}`;
}

export async function authenticatedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (typeof window !== "undefined" && new URL(url, window.location.href).origin !== window.location.origin)
    throw new Error("Authenticated requests must use this gateway's origin.");
  const started = generation;
  const headers = new Headers(init.headers);
  authHeaders(init.method).forEach((value, key) => headers.set(key, value));
  const response = await fetch(url, { ...init, headers, credentials: "same-origin", redirect: "error" });
  responseGenerations.set(response, started);
  if (started !== generation) throw new Error("The signed-in session changed. Retry after signing in.");
  if (response.status === 401 && typeof window !== "undefined")
    window.dispatchEvent(new Event(authExpiredEvent));
  return response;
}

/** A response body can finish streaming after the account has changed. */
export function assertAuthResponseCurrent(response: Response): void {
  if (responseGenerations.get(response) !== generation) throw new Error("The signed-in session changed. Retry after signing in.");
}
