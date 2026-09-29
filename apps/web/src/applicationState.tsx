import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ApplicationStateStore } from "./applicationStateModel";
import type { StateContext, StateScopeHandle } from "./applicationStateModel";
import type { Project, Screen, StateDefinitions } from "./types";

export interface ApplicationStateContext extends StateContext { store: ApplicationStateStore }
const Context = createContext<ApplicationStateContext | undefined>(undefined);
export const ApplicationStateProvider = Context.Provider;
export const useApplicationStateContext = () => useContext(Context);

/** Runtime tab or Designer preview: a fresh owner is created after auth unmount. */
export function useApplicationState(project: Project | null, screen: Screen | undefined, runKey: string): ApplicationStateContext {
  const ref = useRef<ApplicationStateStore | null>(null);
  if (!ref.current) ref.current = new ApplicationStateStore();
  const store = ref.current;
  const [, update] = useState(0);
  useEffect(() => {
    store.resume();
    const unsubscribe = store.subscribe(() => update(value => value + 1));
    // StrictMode replays setup after cleanup. Refresh the provider API rather
    // than reviving helpers captured before that cleanup.
    update(value => value + 1);
    return () => { unsubscribe(); store.suspend(); };
  }, [store]);
  store.configure(runKey, project?.sessionState);
  const scope = store.activateScreen(screen?.id ?? "", screen?.state);
  return { ...store.context(scope), store };
}

/** Popup state is local to that opening; its templates share this same scope. */
export function usePopupApplicationState(parent: ApplicationStateContext | undefined, id: string, definitions?: StateDefinitions): ApplicationStateContext | undefined {
  const ref = useRef<{ parentKey: string; source: string; store: ApplicationStateStore; scope: StateScopeHandle } | null>(null);
  const source = JSON.stringify([id, definitions ?? {}]);
  if (parent && (ref.current?.parentKey !== parent.key || ref.current?.source !== source)) {
    if (ref.current) ref.current.store.closeScope(ref.current.scope);
    ref.current = { parentKey: parent.key, source, store: parent.store, scope: parent.store.createScope(id, definitions) };
  }
  if (!parent && ref.current) { ref.current.store.closeScope(ref.current.scope); ref.current = null; }
  const scope = ref.current?.scope;
  const store = parent?.store;
  useEffect(() => {
    if (!store || !scope) return;
    store.resumeScope(scope);
    return () => store.closeScope(scope);
  }, [store, scope]);
  return parent && scope ? { ...parent.store.context(scope), store: parent.store } : undefined;
}
