interface ModelNavigationGuard { isDirty: () => boolean; discard: () => void; isBlocked?: () => boolean; onBlocked?: () => void; subject?: string }
let active: { ownerId: string; guard: ModelNavigationGuard } | undefined;
let pending: (() => void) | undefined;
let bypass = false;
let activeHref = "";
const listeners = new Set<(pending: boolean) => void>();
const notify = () => listeners.forEach(listener => listener(Boolean(pending)));

/** The mounted Model workspace owns its draft; navigation never silently applies it. */
export function registerModelNavigationGuard(ownerId: string, guard: ModelNavigationGuard): () => void {
  const entry = { ownerId, guard }; active = entry; recordModelNavigationLocation();
  return () => { if (active === entry) active = undefined; };
}
export function recordModelNavigationLocation(): void { activeHref = window.location.href; }
export function modelNavigationDirty(): boolean { return !bypass && Boolean(active?.guard.isBlocked?.() || active?.guard.isDirty()); }
export function modelNavigationSubject(): string { return active?.guard.subject ?? "Models"; }
function blockNavigation(): boolean {
  if (!active?.guard.isBlocked?.()) return false;
  active.guard.onBlocked?.(); return true;
}
export function requestModelNavigation(action: () => void): void {
  if (blockNavigation()) return;
  if (!modelNavigationDirty()) { action(); return; }
  pending = action; notify();
}
export function subscribeModelNavigation(listener: (pending: boolean) => void): () => void {
  listeners.add(listener); listener(Boolean(pending)); return () => { listeners.delete(listener); };
}
export function resolveModelNavigation(discard: boolean): void {
  const action = pending; pending = undefined; notify();
  if (!discard || !action) return;
  if (blockNavigation()) return;
  active?.guard.discard();
  bypass = true;
  try { action(); } finally { bypass = false; }
}
export function clearModelNavigation(): void { active = undefined; pending = undefined; notify(); }

export function clearModelLocation(): void {
  const url = new URL(window.location.href);
  for (const key of ["workspace", "view", "type"]) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, "", url); recordModelNavigationLocation();
}
function remainsInModel(destination: URL): boolean {
  const current = new URL(activeHref || window.location.href);
  return destination.origin === current.origin && destination.pathname === current.pathname
    && destination.hash === current.hash && current.searchParams.get("workspace") === "models" && destination.searchParams.get("workspace") === "models";
}

export const workspaceNavigationEvent = "sparkstudio:workspace-navigation";
export function openModelsWorkspace(): void {
  requestModelNavigation(() => {
    const url = new URL(window.location.href);
    if (!/^\/designer\/[^/]+\/?$/.test(url.pathname) && url.pathname !== "/workspace") url.pathname = "/workspace";
    url.hash = ""; url.search = ""; url.searchParams.set("workspace", "models"); url.searchParams.set("view", "build");
    if (url.href !== window.location.href) window.history.pushState(window.history.state, "", url);
    recordModelNavigationLocation(); window.dispatchEvent(new Event(workspaceNavigationEvent));
  });
}

/** Capture before React links and the workspace router can unmount a dirty draft. */
export function installModelNavigationGuards(): () => void {
  const click = (event: MouseEvent) => {
    if (!modelNavigationDirty() || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!link || link.download || link.target && link.target !== "_self") return;
    const destination = new URL(link.href, window.location.href);
    if (!/^https?:$/.test(destination.protocol) || destination.href === window.location.href || remainsInModel(destination)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    requestModelNavigation(() => link.click());
  };
  const pop = (event: PopStateEvent) => {
    const destination = new URL(window.location.href);
    if (!modelNavigationDirty() || remainsInModel(destination)) { recordModelNavigationLocation(); return; }
    event.stopImmediatePropagation();
    // Restore the visible workspace while the decision is pending. A deliberate leave
    // reloads the requested URL, so no stale router state survives the discarded draft.
    window.history.pushState(null, "", activeHref);
    requestModelNavigation(() => window.location.assign(destination.href));
  };
  window.addEventListener("click", click, true); window.addEventListener("popstate", pop, true);
  return () => { window.removeEventListener("click", click, true); window.removeEventListener("popstate", pop, true); };
}
