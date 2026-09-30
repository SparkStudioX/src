import { useMemo, useSyncExternalStore } from "react";
import { TagSnapshotStore, tagDependencyPaths } from "./tagStore";
import type { RuntimeParameters } from "./types";

/** Keep full catalog available to authoring pickers, while observing only active tag dependencies. */
export function useTagSnapshot(store: TagSnapshotStore, document: unknown, parameters: RuntimeParameters, observeAll = false) {
  const catalog = useSyncExternalStore(store.subscribeCatalog, store.paths, store.paths);
  const dependencies = useMemo(() => observeAll ? null : tagDependencyPaths(document, parameters, catalog), [document, parameters, catalog, observeAll]);
  const selection = useMemo(() => {
    let previous = store.values().filter(tag => dependencies === null || dependencies.has(tag.path));
    return {
      subscribe: (notify: () => void) => store.subscribe(dependencies, notify),
      snapshot: () => {
        const next = dependencies === null ? store.values() : [...dependencies].map(path => store.get(path)).filter(tag => tag !== undefined);
        if (next.length !== previous.length || next.some((tag, index) => tag !== previous[index])) previous = next;
        return previous;
      },
    };
  }, [store, dependencies]);
  useSyncExternalStore(selection.subscribe, selection.snapshot, selection.snapshot);
  return store.values();
}
