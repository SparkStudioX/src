import { authSessionRevision } from "./authSession";

type Grant = "view" | "operate" | "command";
type RuntimeContext = {
  projectId?: string | null;
  currentUserId?: unknown;
  resolveSecret?: (handle: string | undefined, purpose: string) => Promise<Record<string, string>>;
};
type Session = {
  audience: string;
  user: { id: string; username: string } | null;
  csrfToken: string | null;
  project: { id: string } | null;
  permissions: { design?: boolean; view?: boolean; operate?: boolean; commands?: boolean };
};
type Scope = { projectId: string; userId: string; assertCurrent: () => void };

function scope(context: RuntimeContext, signal?: AbortSignal): Scope {
  if (typeof context.projectId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(context.projectId)) throw new Error("Select a project before testing its published runtime.");
  if (typeof context.currentUserId !== "string" || !context.currentUserId) throw new Error("The engineering identity is unavailable. Sign in again before runtime testing.");
  const revision = authSessionRevision();
  return { projectId: context.projectId, userId: context.currentUserId, assertCurrent: () => {
    signal?.throwIfAborted();
    if (revision !== authSessionRevision()) throw new Error("The engineering session changed. Inspect the runtime state before another attempt.");
  } };
}

async function localJson(path: string, init: RequestInit, current: Scope): Promise<unknown> {
  current.assertCurrent();
  const response = await fetch(path, { ...init, credentials: "same-origin", redirect: "error", cache: "no-store" });
  const text = await response.text();
  current.assertCurrent();
  if (text.length > 65_536) throw new Error("The session response exceeds its size limit.");
  let value: unknown;
  try { value = text ? JSON.parse(text) : null; } catch { throw new Error("The gateway returned an invalid session response."); }
  if (!response.ok) throw new Error(`Runtime session request failed (${response.status}). Sign in to the operator application using this engineering account.`);
  return value;
}

async function session(audience: "engineering" | "operator", current: Scope, signal?: AbortSignal): Promise<Session> {
  const result = await localJson(`/api/auth/session?audience=${audience}&projectId=${encodeURIComponent(current.projectId)}`,
    { headers: { "X-SPARK-AUDIENCE": audience, "X-SPARK-PROJECT": current.projectId }, signal }, current) as Session | null;
  if (!result || result.audience !== audience || !result.permissions || result.user === undefined) throw new Error("The gateway returned an invalid session response.");
  return result;
}

function requireEngineering(value: Session, current: Scope): void {
  if (value.user?.id !== current.userId || value.project?.id !== current.projectId || value.permissions.design !== true)
    throw new Error("Runtime testing requires the current engineering account's design permission for this project.");
}

function requireSameOperator(value: Session, current: Scope): void {
  if (value.user && value.user.id !== current.userId)
    throw new Error("Another account is signed in to the operator application. Sign out there first; Ask Spark will not replace that session.");
}

function requireOperator(value: Session, current: Scope, grant: Grant): void {
  requireSameOperator(value, current);
  if (!value.user || !value.csrfToken) throw new Error("Sign in to the operator application with this same account using runtime_operator_sign_in before testing its published runtime.");
  const permission = grant === "command" ? "commands" : grant;
  if (value.project?.id !== current.projectId || value.permissions[permission] !== true)
    throw new Error(`The same operator account needs ${permission} permission for this project.`);
}

async function pairedSessions(current: Scope, signal?: AbortSignal): Promise<{ engineering: Session; operator: Session }> {
  const engineering = await session("engineering", current, signal);
  requireEngineering(engineering, current);
  const operator = await session("operator", current, signal);
  requireSameOperator(operator, current);
  return { engineering, operator };
}

/** Probe is read-only. Operator cookies and CSRF values never enter tool observations or global engineering auth state. */
export async function testRuntimeSession(context: RuntimeContext, signal?: AbortSignal): Promise<unknown> {
  const current = scope(context, signal), { operator } = await pairedSessions(current, signal);
  if (!operator.user) return { available: false, projectId: current.projectId, nextStep: "Use runtime_operator_sign_in to sign into the operator application as this same account." };
  requireOperator(operator, current, "view");
  return { available: true, projectId: current.projectId, audience: "operator", permissions: operator.permissions,
    scope: "Published runtime only. Designer Preview tests drafts separately." };
}

/** Explicit, separately approved sign-in prompts for only the current engineering account's password. */
export async function signInRuntime(args: Record<string, unknown>, context: RuntimeContext, signal?: AbortSignal): Promise<unknown> {
  const current = scope(context, signal), before = await pairedSessions(current, signal);
  if (before.operator.user) return testRuntimeSession(context, signal);
  if (!context.resolveSecret) throw new Error("Secure operator sign-in is unavailable. Sign in to the operator application with this same account.");
  const secret = await context.resolveSecret(typeof args.secretHandle === "string" ? args.secretHandle : undefined, "runtime-operator-sign-in");
  if (typeof secret.password !== "string" || !secret.password || secret.password.length > 4096) throw new Error("Enter the current account's password securely.");
  current.assertCurrent();
  // Repeat immediately before login: a different operator may have signed in while the private dialog was open.
  const latest = await pairedSessions(current, signal);
  if (latest.operator.user) return testRuntimeSession(context, signal);
  const result = await localJson("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-SPARK-AUDIENCE": "operator", "X-SPARK-PROJECT": current.projectId },
    body: JSON.stringify({ audience: "operator", username: latest.engineering.user!.username, password: secret.password, projectId: current.projectId }), signal }, current) as Session;
  if (result.audience !== "operator") throw new Error("The gateway returned an invalid operator sign-in response.");
  requireOperator(result, current, "view");
  return { signedIn: true, projectId: current.projectId, audience: "operator", scope: "Published runtime only" };
}

/** This helper only accepts the typed registry's project-scoped operator routes. It does not alter configureAuthSession. */
export async function runtimeAuthenticatedFetch(path: string, init: RequestInit, context: RuntimeContext, grant: Grant): Promise<Response> {
  const current = scope(context, init.signal ?? undefined);
  const prefix = `/api/projects/${encodeURIComponent(current.projectId)}/`;
  if (!path.startsWith(prefix) || !/^(?:runtime\/|alarms\/[A-Za-z0-9_.%~-]+\/ack$)/.test(path.slice(prefix.length))) throw new Error("This is not a permitted project runtime route.");
  const { operator } = await pairedSessions(current, init.signal ?? undefined);
  requireOperator(operator, current, grant);
  const headers = new Headers(init.headers);
  headers.set("X-SPARK-AUDIENCE", "operator"); headers.set("X-SPARK-PROJECT", current.projectId); headers.set("X-SPARK-CSRF", operator.csrfToken!);
  headers.set("X-SPARK-EXPECTED-USER", current.userId);
  current.assertCurrent();
  const response = await fetch(path, { ...init, headers, credentials: "same-origin", redirect: "error", cache: "no-store" });
  current.assertCurrent();
  return response;
}
