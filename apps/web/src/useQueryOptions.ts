import type { RuntimeParameters } from "./types";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { loadQueryOptions } from "./queryOptions";
import type { QueryOption } from "./queryOptions";
import type { QueryOptionsSource } from "./types";

type OptionsState = { key: string; options: QueryOption[]; loading: boolean; error: string };

export function useQueryOptions(source: QueryOptionsSource, scope: "designer" | "runtime", parameters: RuntimeParameters, offline: boolean, publishedAt?: string) {
  const key = JSON.stringify([source, scope, parameters, offline, scope === "runtime" ? publishedAt : undefined]);
  const [state, setState] = useState<OptionsState>({ key: "", options: [], loading: true, error: "" });
  const refresh = useRef<{ key: string; run: () => Promise<QueryOption[] | null> } | null>(null);
  useEffect(() => {
    const [currentSource, currentScope, currentParameters, disconnected, publication] = JSON.parse(key) as [QueryOptionsSource, "designer" | "runtime", RuntimeParameters, boolean, string | null];
    let stopped = false;
    let generation = 0;
    if (disconnected) {
      setState({ key, options: [], loading: false, error: "Communication lost. Options are unavailable." });
      return;
    }
    const run = async (): Promise<QueryOption[] | null> => {
      const request = ++generation;
      setState(previous => ({ key, options: previous.key === key ? previous.options : [], loading: true, error: "" }));
      try {
        const options = await loadQueryOptions(currentSource, currentScope, currentParameters, api, publication ?? undefined);
        if (!stopped && request === generation) {
          setState({ key, options, loading: false, error: "" });
          return options;
        }
      } catch (reason) {
        if (!stopped && request === generation) setState({ key, options: [], loading: false, error: reason instanceof Error ? reason.message : String(reason) });
      }
      return null;
    };
    refresh.current = { key, run };
    void run();
    const interval = window.setInterval(run, 10000);
    window.addEventListener("sparkstudio:refresh-data", run);
    window.addEventListener("sparkstudio:refresh-queries", run);
    return () => {
      stopped = true;
      generation++;
      if (refresh.current?.key === key) refresh.current = null;
      window.clearInterval(interval);
      window.removeEventListener("sparkstudio:refresh-data", run);
      window.removeEventListener("sparkstudio:refresh-queries", run);
    };
  }, [key]);
  // An obsolete result must not remain interactive until effect cleanup runs.
  return {
    ...(state.key === key ? state : { key, options: [], loading: !offline, error: offline ? "Communication lost. Options are unavailable." : "" }),
    refresh: () => refresh.current?.key === key ? refresh.current.run() : Promise.resolve(null),
  };
}
