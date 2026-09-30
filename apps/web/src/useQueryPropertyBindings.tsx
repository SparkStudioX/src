import { createContext, useContext, useEffect, useRef, useState } from "react";
import { currentProjectId } from "./api";
import { ComponentEventCoordinator } from "./componentEventModel";
import type { BindingContext } from "./propertyBindings";
import { queryPropertyValue, resolveQueryPropertyParameters, transformQueryPropertyValue, validateQueryPropertyBinding } from "./queryPropertyModel";
import { QueryPropertyCoordinator, queryPropertyRequestKey } from "./queryPropertyCoordinator";
import type { QueryPropertyRequest } from "./queryPropertyCoordinator";
import type { ApplicationStateContext } from "./applicationState";
import type { BindingTarget, CanvasComponent, QueryPropertyBinding, QueryPropertyValues } from "./types";

const Context = createContext<QueryPropertyValues | undefined>(undefined);
export const QueryPropertyProvider = Context.Provider;
export const useQueryPropertyContext = () => useContext(Context);
const coordinators = new WeakMap<object, QueryPropertyCoordinator>();
export function sharedQueryCoordinator(owner: ApplicationStateContext["store"] | undefined, fallback: QueryPropertyCoordinator): QueryPropertyCoordinator {
  if (!owner) return fallback;
  let coordinator = coordinators.get(owner);
  if (!coordinator) { coordinator = new QueryPropertyCoordinator(owner.componentEvents); coordinators.set(owner, coordinator); }
  return coordinator;
}
type Descriptor = { component: CanvasComponent; target: BindingTarget; binding: QueryPropertyBinding; request?: QueryPropertyRequest; error?: string };

/** One owner per containing form keeps geometry, rendering and events in agreement. */
export function useQueryPropertyBindings(components: CanvasComponent[], context: BindingContext, options: {
  state?: ApplicationStateContext; scope: "designer" | "runtime"; publishedAt?: string; active: boolean;
}): QueryPropertyValues {
  const fallback = useRef<QueryPropertyCoordinator | null>(null);
  if (!fallback.current) fallback.current = new QueryPropertyCoordinator(new ComponentEventCoordinator());
  const owner = options.state?.store;
  const coordinator = sharedQueryCoordinator(owner, fallback.current);
  const [, update] = useState(0);
  const subscriptions = useRef<{ coordinator: QueryPropertyCoordinator; held: Map<string, () => void> } | null>(null);
  const descriptors: Descriptor[] = components.flatMap(component => Object.entries(component.props.queryBindings ?? {}).map(([key, binding]) => {
    const target = key as BindingTarget;
    let error = validateQueryPropertyBinding(binding, target, component, context), request: QueryPropertyRequest | undefined;
    if (!error && options.active) {
      try {
        const parameters = resolveQueryPropertyParameters(binding, component, context);
        request = { queryId: binding.queryId, parameters, scope: options.scope, projectId: currentProjectId(),
          ...(options.scope === "runtime" && options.publishedAt !== undefined ? { publishedAt: options.publishedAt } : {}) };
      } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    }
    return { component, target, binding, request, error };
  }));
  const current = useRef(true);
  current.current = options.active && !context.communicationLost && options.state?.isCurrent?.() !== false;
  const key = JSON.stringify([options.state?.key, options.active, context.communicationLost, descriptors.map(item => [item.component.id, item.target, item.binding, item.request, item.error])]);
  useEffect(() => {
    if (subscriptions.current?.coordinator !== coordinator) {
      subscriptions.current?.held.forEach(stop => stop());
      subscriptions.current = { coordinator: coordinator!, held: new Map() };
    }
    const held = subscriptions.current.held;
    const desired = new Map(current.current ? descriptors.flatMap(item => item.request && !item.error ? [[
      JSON.stringify([options.state?.key, item.component.id, item.target, item.request, item.binding.refresh]), item] as const] : []) : []);
    for (const [id, stop] of held) if (!desired.has(id)) { stop(); held.delete(id); }
    for (const [id, item] of desired) if (!held.has(id)) {
      let live = true;
      const stop = coordinator!.subscribe(item.request!, () => { if (live) update(value => value + 1); },
        item.binding.refresh?.mode === "poll" ? item.binding.refresh.intervalMs : undefined);
      held.set(id, () => { live = false; stop(); });
    }
  }, [coordinator, key]);
  useEffect(() => () => { subscriptions.current?.held.forEach(stop => stop()); subscriptions.current = null; }, []);
  const values: QueryPropertyValues = Object.create(null);
  for (const descriptor of descriptors) {
    const { component, target, binding, request, error } = descriptor;
    const targets = values[component.id] ??= {};
    if (!options.active) { targets[target] = { status: "idle" }; continue; }
    if (context.communicationLost) { targets[target] = { status: "error", error: "Communication lost. Query property is unavailable." }; continue; }
    if (error || !request) { targets[target] = { status: "error", error: error || "Query property is unavailable." }; continue; }
    const requestKey = queryPropertyRequestKey(request), sample = coordinator.peek(requestKey), capacity = coordinator.capacityError(requestKey);
    if (sample?.error || capacity) { targets[target] = { status: "error", error: sample?.error || capacity }; continue; }
    if (!sample?.result) { targets[target] = { status: "loading" }; continue; }
    try { targets[target] = { status: "ready", value: transformQueryPropertyValue(queryPropertyValue(sample.result, binding.column), binding.transform, target), refreshing: sample.loading }; }
    catch (reason) { targets[target] = { status: "error", error: reason instanceof Error ? reason.message : String(reason) }; }
  }
  return values;
}
