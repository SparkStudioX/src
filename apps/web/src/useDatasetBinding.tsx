import { useEffect, useRef, useState } from "react";
import { currentProjectId } from "./api";
import { useApplicationStateContext } from "./applicationState";
import { ComponentEventCoordinator } from "./componentEventModel";
import { QueryPropertyCoordinator, queryPropertyRequestKey } from "./queryPropertyCoordinator";
import type { QueryPropertyRequest } from "./queryPropertyCoordinator";
import type { BindingContext } from "./propertyBindings";
import { resolveDatasetParameters, validateDataset } from "./datasets";
import { sharedQueryCoordinator } from "./useQueryPropertyBindings";
import type { CanvasComponent, DatasetSample } from "./types";

/** A dataset belongs to the same live form owner as its inputs and private state. */
export function useDatasetBinding(component: CanvasComponent, context: BindingContext, options: {
  scope: "designer" | "runtime"; publishedAt?: string; active: boolean;
}): DatasetSample {
  const state = useApplicationStateContext();
  const fallback = useRef<QueryPropertyCoordinator | null>(null);
  if (!fallback.current) fallback.current = new QueryPropertyCoordinator(new ComponentEventCoordinator());
  const owner = state?.store;
  const coordinator = sharedQueryCoordinator(owner, fallback.current);
  const [, update] = useState(0);
  let request: QueryPropertyRequest | undefined, error = "";
  const source = component.props.dataSource;
  try {
    if (source) request = { queryId: source.queryId, parameters: resolveDatasetParameters(source, component, context), scope: options.scope,
      projectId: currentProjectId(), ...(options.scope === "runtime" ? { publishedAt: options.publishedAt } : {}) };
  } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  const active = options.active && !context.communicationLost && state?.isCurrent?.() !== false;
  const key = JSON.stringify([state?.key, active, request, error, source?.refresh]);
  useEffect(() => {
    if (!active || error || !request) return;
    let live = true;
    const stop = coordinator!.subscribe(request, () => { if (live) update(value => value + 1); }, source?.refresh?.mode === "poll" ? source.refresh.intervalMs : undefined);
    return () => { live = false; stop(); };
  }, [coordinator, key]);
  if (!source) {
    try { return component.props.data === undefined ? { status: "idle" } : { status: "ready", data: validateDataset(component.props.data) }; }
    catch (reason) { return { status: "error", error: reason instanceof Error ? reason.message : String(reason) }; }
  }
  if (!options.active) return { status: "idle" };
  if (!active) return { status: "error", error: "Dataset context is unavailable or disconnected." };
  if (error || !request) return { status: "error", error };
  const requestKey = queryPropertyRequestKey(request), sample = coordinator.peek(requestKey), capacity = coordinator.capacityError(requestKey);
  if (sample?.error || capacity) return { status: "error", error: sample?.error || capacity };
  if (!sample?.result) return { status: "loading" };
  try { return { status: "ready", data: validateDataset(sample.result), refreshing: sample.loading }; }
  catch (reason) { return { status: "error", error: reason instanceof Error ? reason.message : String(reason) }; }
}
