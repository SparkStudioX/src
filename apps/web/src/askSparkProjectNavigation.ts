import type { AskSparkContext } from "./askSparkClient";

let navigate: ((projectId: string) => void) | undefined;
let contextGetter: (() => AskSparkContext) | undefined;
export function registerAskSparkNavigationContext(getter: () => AskSparkContext): () => void {
  contextGetter = getter;
  return () => { if (contextGetter === getter) contextGetter = undefined; };
}
export function askSparkNavigationBlocked(): boolean {
  const context = contextGetter?.();
  return Boolean(context?.unsavedChanges || context?.connectionHasUnsavedChanges);
}
export function registerAskSparkProjectNavigation(handler: (projectId: string) => void): () => void {
  navigate = handler;
  return () => { if (navigate === handler) navigate = undefined; };
}

export async function openAskSparkProject(projectId: string, current: () => AskSparkContext, signal: AbortSignal): Promise<AskSparkContext> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(projectId)) throw new Error("Choose a valid project ID.");
  signal.throwIfAborted();
  const before = current();
  if (before.projectId === projectId && before.editorAvailable === true) return before;
  if (before.unsavedChanges || before.connectionHasUnsavedChanges) throw new Error("Save or cancel the current unsaved edits before opening another project. Nothing was discarded.");
  if (!navigate) throw new Error("Project navigation is not ready. Try again after the workspace loads.");
  navigate(projectId);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const next = current();
    if (next.projectId === projectId && next.editorAvailable === true) return next;
    await pause(signal);
  }
  throw new Error("The Designer did not become ready. Check project access and the workspace's loading error before retrying.");
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener("abort", aborted); resolve(); };
    const timer = setTimeout(done, 50);
    const aborted = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); reject(signal.reason ?? new Error("Navigation cancelled.")); };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
