import { useEffect, useRef, useState } from "react";
import { currentProjectId } from "./api";
import { queryRepeaterRows, validateRepeaterSource } from "./queryRepeater";
import { useApplicationStateContext } from "./applicationState";
import { ComponentEventCoordinator } from "./componentEventModel";
import { QueryPropertyCoordinator, queryPropertyRequestKey } from "./queryPropertyCoordinator";
import { sharedQueryCoordinator } from "./useQueryPropertyBindings";
import type { QueryPropertyRequest } from "./queryPropertyCoordinator";
import type { QueryRepeaterSource, Template, ResolvedTemplateRow, RuntimeParameters } from "./types";

export function useQueryRepeater(source: QueryRepeaterSource | undefined, template: Template | undefined,
  scope: "designer" | "runtime", parameters: RuntimeParameters, offline: boolean, publishedAt?: string,
) {
  const state = useApplicationStateContext(), fallback = useRef<QueryPropertyCoordinator | null>(null);
  if (!fallback.current) fallback.current = new QueryPropertyCoordinator(new ComponentEventCoordinator());
  const coordinator = sharedQueryCoordinator(state?.store, fallback.current), [, update] = useState(0);
  const request: QueryPropertyRequest = { queryId: source?.queryId ?? "", parameters, scope, projectId: currentProjectId(), inheritParameters: true,
    ...(scope === "runtime" ? { publishedAt } : {}) };
  let error = "";
  try { if (source && template) validateRepeaterSource(source, template); }
  catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  const active = Boolean(source && template && !error && !offline && state?.isCurrent?.() !== false);
  const key = JSON.stringify([source, template?.id, template?.parameters, template?.parameterTypes, template?.modelParameters, request, offline, state?.key]);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const stop = coordinator.subscribe(request, () => { if (live) update(value => value + 1); }, 10000);
    return () => { live = false; stop(); };
  }, [coordinator, key, active]);
  let rows: ResolvedTemplateRow[] = [], loading = false;
  if (source && offline) error = "Communication lost. Repeater rows are unavailable.";
  if (active) {
    const requestKey = queryPropertyRequestKey(request), sample = coordinator.peek(requestKey);
    error = sample?.error || coordinator.capacityError(requestKey);
    loading = !sample || sample.loading;
    if (sample?.result && !error) try { rows = queryRepeaterRows(sample.result, source!, template!); }
    catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  }
  return { key, rows, loading, error };
}
