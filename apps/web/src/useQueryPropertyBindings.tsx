import { createContext, useContext, useEffect, useRef, useState } from "react";
import { currentProjectId } from "./api";
import { ComponentEventCoordinator } from "./componentEventModel";
import type { BindingContext } from "./propertyBindings";
import { bindingReferenceDependencies } from "./propertyBindings";
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
  const current = useRef(true);
  current.current = options.active && !context.communicationLost && options.state?.isCurrent?.() !== false;
  const values: QueryPropertyValues = Object.create(null);
  const bindingContext = { ...context, queryProperties: values };
  const descriptors: Descriptor[] = components.flatMap(component => Object.entries(component.props.queryBindings ?? {})
    .flatMap(([target, binding]) => binding ? [{ component, target: target as BindingTarget, binding }] : []));
  const identity = (component: CanvasComponent, target: BindingTarget) => JSON.stringify([component.id, target]);
  const byTarget = new Map(descriptors.map(item => [identity(item.component, item.target), item]));
  const completed = new Set<Descriptor>(), visiting = new Set<Descriptor>();
  // Read upstream custom properties before resolving dependent request keys.
  // Every returned sample belongs to this render's coordinator snapshot, so a
  // changed/failed upstream value cannot leave a stale dependent value ready.
  function resolve(descriptor: Descriptor): void {
    if (completed.has(descriptor)) return;
    const { component, target, binding } = descriptor;
    const targets = values[component.id] ??= {};
    if (!options.active) { targets[target] = { status: "idle" }; completed.add(descriptor); return; }
    if (!current.current) { targets[target] = { status: "error", error: context.communicationLost ? "Communication lost. Query property is unavailable." : "The query property context is no longer current." }; completed.add(descriptor); return; }
    if (visiting.has(descriptor) || visiting.size >= 32) {
      descriptor.error = "Custom query dependencies contain a cycle or exceed 32 levels.";
      targets[target] = { status: "error", error: descriptor.error }; completed.add(descriptor); return;
    }
    visiting.add(descriptor);
    try {
      descriptor.error = validateQueryPropertyBinding(binding, target, component, bindingContext);
      if (descriptor.error) throw new Error(descriptor.error);
      let loading = false;
      for (const expression of Object.values(binding.parameters ?? {})) {
        for (const dependency of bindingReferenceDependencies(expression, component, bindingContext)) {
          if (dependency.reference.kind !== "custom") continue;
          const ownerId = dependency.reference.componentId ?? dependency.component.id;
          const source = byTarget.get(JSON.stringify([ownerId, `customProperties.${dependency.reference.key}.value`]));
          if (!source) continue;
          resolve(source);
          const sample = values[ownerId]?.[source.target];
          if (sample?.status === "loading") loading = true;
          else if (sample?.status !== "ready") throw new Error(sample?.error || "A custom query source is unavailable.");
        }
      }
      if (loading) { targets[target] = { status: "loading" }; return; }
      const parameters = resolveQueryPropertyParameters(binding, component, bindingContext);
      descriptor.request = { queryId: binding.queryId, parameters, scope: options.scope, projectId: currentProjectId(),
        ...(options.scope === "runtime" && options.publishedAt !== undefined ? { publishedAt: options.publishedAt } : {}) };
      const requestKey = queryPropertyRequestKey(descriptor.request), sample = coordinator.peek(requestKey), capacity = coordinator.capacityError(requestKey);
      if (sample?.error || capacity) { targets[target] = { status: "error", error: sample?.error || capacity }; return; }
      if (!sample?.result) { targets[target] = { status: "loading" }; return; }
      targets[target] = { status: "ready", value: transformQueryPropertyValue(queryPropertyValue(sample.result, binding.column), binding.transform, target, component), refreshing: sample.loading };
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : String(reason);
      // Invalid result cells keep the read subscription so polling/refresh can
      // recover; only invalid dependencies or request definitions unsubscribe.
      if (!descriptor.request) descriptor.error = error;
      targets[target] = { status: "error", error };
    } finally { visiting.delete(descriptor); completed.add(descriptor); }
  }
  for (const descriptor of descriptors) resolve(descriptor);
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
  const stable = useRef<{ key: string; values: QueryPropertyValues } | null>(null);
  const valueKey = JSON.stringify(values);
  if (stable.current?.key !== valueKey) stable.current = { key: valueKey, values };
  return stable.current.values;
}
