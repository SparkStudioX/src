export type PreviewMode = "read-only" | "live-actions";
export interface PreviewSession { token: string; mode: PreviewMode; expiresAt: string }
let context: { session: PreviewSession | null; generation: number } | null = null;
let generation = 0;
const requests = new Set<AbortController>();

/** Browser event code has this origin's privileges; read-only never starts it. */
export function requirePreviewScriptPermission(): void {
  if (!previewScriptsAllowed())
    throw new Error("Live read-only Preview does not execute authored browser scripts. Explicitly enable Live actions to run this event.");
}
export function previewScriptsAllowed(): boolean {
  return !context || Boolean(context.session?.mode === "live-actions" && Date.parse(context.session.expiresAt) > Date.now());
}

/** Null means authoring; an active context with no session deliberately fails closed. */
export function setPreviewRequestContext(session: PreviewSession | null, active = true): void {
  generation++;
  for (const controller of requests) controller.abort();
  requests.clear();
  context = active ? { session, generation } : null;
}

export function preparePreviewRequest(path: string, signal?: AbortSignal) {
  const current = context;
  if (!current || path === "/preview/sessions") return { path, signal, headers: {} as Record<string, string>, finish() {}, assertCurrent() {} };
  if (!current.session || Date.parse(current.session.expiresAt) <= Date.now())
    throw new Error("The Designer preview session is unavailable or expired. Exit and reopen Preview.");
  const mapped = /^\/queries\/[^/]+\/execute$/.test(path) ? `/preview${path}`
    : path === "/scripts/run" ? "/preview/scripts/run" : path;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  requests.add(controller);
  return {
    path: mapped, signal: controller.signal,
    headers: { "X-SPARK-PREVIEW": current.session.token },
    finish() { requests.delete(controller); signal?.removeEventListener("abort", abort); },
    assertCurrent() {
      if (context !== current) throw new Error("The preview communication mode changed. Retry in the current preview.");
    },
  };
}
