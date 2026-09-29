import { useEffect, useState } from "react";
import { api } from "./api";
import { loadQueryRepeater } from "./queryRepeater";
import type { QueryRepeaterSource, Template, ResolvedTemplateRow, RuntimeParameters, TemplateParameterType } from "./types";

type RepeaterState = { key: string; rows: ResolvedTemplateRow[]; loading: boolean; error: string };
const offlineError = "Communication lost. Repeater rows are unavailable.";

export function useQueryRepeater(
  source: QueryRepeaterSource | undefined, template: Template | undefined,
  scope: "designer" | "runtime", parameters: RuntimeParameters, offline: boolean, publishedAt?: string,
) {
  // Declarations affect query-result validation. Geometry or label edits do not.
  const key = JSON.stringify([source ?? null, template ? { id: template.id, parameters: Object.keys(template.parameters).sort(), parameterTypes: template.parameterTypes } : null,
    scope, parameters, offline, scope === "runtime" ? publishedAt : undefined]);
  const [state, setState] = useState<RepeaterState>({ key: "", rows: [], loading: true, error: "" });
  useEffect(() => {
    const [currentSource, declaration, currentScope, currentParameters, disconnected, publication] = JSON.parse(key) as
      [QueryRepeaterSource | null, { id: string; parameters: string[]; parameterTypes?: Record<string, TemplateParameterType> } | null, "designer" | "runtime", RuntimeParameters, boolean, string | null];
    let stopped = false;
    let generation = 0;
    if (!currentSource || !declaration || disconnected) {
      setState({ key, rows: [], loading: false, error: disconnected && currentSource ? offlineError : "" });
      return;
    }
    const definition: Template = { id: declaration.id, name: "", width: 1, height: 1, components: [], parameters: Object.fromEntries(declaration.parameters.map(name => [name, ""])), parameterTypes: declaration.parameterTypes };
    const run = async () => {
      const request = ++generation;
      setState(previous => ({ key, rows: previous.key === key ? previous.rows : [], loading: true, error: "" }));
      try {
        const rows = await loadQueryRepeater(currentSource, definition, currentScope, currentParameters, api, publication ?? undefined);
        if (!stopped && request === generation) setState({ key, rows, loading: false, error: "" });
      } catch (reason) {
        if (!stopped && request === generation) setState({ key, rows: [], loading: false, error: reason instanceof Error ? reason.message : String(reason) });
      }
    };
    void run();
    const interval = window.setInterval(run, 10000);
    window.addEventListener("sparkstudio:refresh-data", run);
    window.addEventListener("sparkstudio:refresh-queries", run);
    return () => {
      stopped = true;
      generation++;
      window.clearInterval(interval);
      window.removeEventListener("sparkstudio:refresh-data", run);
      window.removeEventListener("sparkstudio:refresh-queries", run);
    };
  }, [key]);
  // An old result is hidden during render, before effect cleanup can run.
  return state.key === key ? state : { key, rows: [], loading: Boolean(source && template && !offline), error: source && offline ? offlineError : "" };
}
