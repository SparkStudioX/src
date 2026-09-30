import { useEffect, useRef, useState } from "react";
import type { HTMLAttributes, SyntheticEvent } from "react";
import { useComponentActivity } from "./ComponentActivity";
import { useApplicationStateContext } from "./applicationState";
import type { ApplicationStateContext } from "./applicationState";
import { ComponentEventCoordinator, ComponentEventLifecycle, componentEventSamples, componentInteractionEvent } from "./componentEventModel";
import type { AutomaticComponentEvent, ComponentInteractionData } from "./componentEventModel";
import { capturePythonUiAction } from "./pythonUiModel";
import { completePythonEvent, isPythonUnmount, PythonComponentEventQueue, PythonMountBarrier, withoutPasswordInputs } from "./pythonComponentEvents";
import { scriptFailureMessage } from "./api";
import type { PythonEventRunner, PythonEventTransport, EventOrigin } from "./pythonComponentEvents";
import type { CanvasComponent, ComponentInteractionEventType, InputValue, InputValues, RuntimeParameters } from "./types";
import { isInput } from "./inputs";
import type { AutomaticInputAssignment } from "./inputStateBindings";
import "./componentEvents.css";

/** Captures fresh UI revisions when a queued Python event starts, retaining its owner's lifetime. */
export function usePythonComponentEvents(options: {
  component: CanvasComponent; components: CanvasComponent[]; parameters: RuntimeParameters;
  identity: string; enabled: boolean; transport?: PythonEventTransport; onAutomaticInputChange?: AutomaticInputAssignment;
}): PythonEventRunner | undefined {
  const active = useComponentActivity(), activity = useRef(active); activity.current = active;
  const state = useApplicationStateContext();
  const queue = useRef<PythonComponentEventQueue | null>(null);
  if (!queue.current) queue.current = new PythonComponentEventQueue();
  const lifetime = useRef({ active: true, epoch: 0, identity: options.identity });
  const mountRef = useRef<{ identity: string; barrier: PythonMountBarrier } | null>(null);
  if (!mountRef.current || mountRef.current.identity !== options.identity)
    mountRef.current = { identity: options.identity, barrier: new PythonMountBarrier() };
  const mountBarrier = mountRef.current.barrier;
  if (lifetime.current.identity !== options.identity) { lifetime.current.identity = options.identity; lifetime.current.epoch++; }
  useEffect(() => { lifetime.current.active = true; return () => { lifetime.current.active = false; lifetime.current.epoch++; }; }, []);
  if (!state || !options.enabled || !options.transport) return undefined;
  // Retained render snapshots survive a parent scope retiring before React runs
  // child cleanup. The gateway validates them as reads, never as authority.
  const cleanupUi = options.component.props.componentEvents?.unmount?.language === "python"
    ? structuredClone({ state: state.values, properties: state.propertyOverrides }) : undefined;
  return async (handler, event, inputs, parameters, signal) => {
    if (!activity.current && !isPythonUnmount(handler)) throw new Error("The component's container is inactive.");
    const epoch = lifetime.current.epoch;
    const mounting = handler.family === "lifecycle" && handler.type === "mount";
    if (!mounting && !isPythonUnmount(handler) && options.component.props.componentEvents?.mount?.language === "python")
      await mountBarrier.wait(signal);
    try { return await queue.current!.run(signal, async currentSignal => {
      if (isPythonUnmount(handler)) {
        if (!cleanupUi) throw new Error("No captured Python cleanup context is available.");
        const action = { ui: cleanupUi, isCurrent: () => false, apply() { throw new Error("Unmount cannot change retired UI state."); } };
        const result = await options.transport!(options.component, { eventHandler: handler, event,
          inputs: withoutPasswordInputs(options.components, inputs), parameters, uiAction: action, signal: currentSignal });
        if (result.success) window.dispatchEvent(new Event("sparkstudio:refresh-data"));
        if (!result.success) throw new Error(scriptFailureMessage(result.stderr));
        if (result.uiEffects?.length) throw new Error("Unmount returned forbidden local UI effects.");
        return result.stdout?.trim().slice(0, 2500) ?? "";
      }
      const live = () => activity.current && !currentSignal.aborted && lifetime.current.active && lifetime.current.epoch === epoch && lifetime.current.identity === options.identity;
      const action = capturePythonUiAction(state, options.components, live, { assign: options.onAutomaticInputChange, parameters: options.parameters });
      return completePythonEvent(() => options.transport!(options.component, { eventHandler: handler, event,
        inputs: withoutPasswordInputs(options.components, inputs), parameters, uiAction: action, signal: currentSignal }), action, currentSignal,
        () => window.dispatchEvent(new Event("sparkstudio:refresh-data")));
    }); } finally { if (mounting) mountBarrier.finish(); }
  };
}

/** Automatic events use local helpers independently of user interaction gates. */
export function useComponentEvents(options: {
  component: CanvasComponent; evaluated: CanvasComponent; components: CanvasComponent[]; errors: Record<string, string>;
  parameters: RuntimeParameters; inputs: InputValues; inputValue?: InputValue | null; inputError?: string | null;
  preview: boolean; scopeKey?: string; onAutomaticInputChange?: (field: string, value: InputValue) => void;
  python?: PythonEventRunner;
  interactionEnabled?: boolean;
}) {
  const active = useComponentActivity();
  const state = useApplicationStateContext();
  const ref = useRef<ComponentEventLifecycle | null>(null);
  if (!ref.current) ref.current = new ComponentEventLifecycle();
  const fallback = useRef<ComponentEventCoordinator | null>(null);
  if (!fallback.current) fallback.current = new ComponentEventCoordinator();
  const coordinator = state?.store?.componentEvents ?? fallback.current;
  const key = JSON.stringify([state?.key, options.scopeKey, options.component.id, options.component.type,
    options.component.props.componentEvents, options.component.props.messageHandlers, options.parameters, Boolean(options.python),
    options.components.map(component => [component.id, component.type, component.props.fieldKey, component.props.stateBinding,
      component.props.min, component.props.max, component.props.options, component.props.optionsSource])]);
  const samples = componentEventSamples(options.component, options.evaluated, options.errors, options.parameters, options.inputValue, options.inputError,
    state?.propertyOverrides[options.component.id]);
  const origins = Object.fromEntries((options.component.props.componentEvents?.propertyChange?.properties ?? []).map(property => [property,
    options.component.props.bindings?.[property] || options.component.props.queryBindings?.[property] ? "binding"
      : Object.hasOwn(state?.propertyOverrides[options.component.id] ?? {}, property) ? "script" : property === "value" ? "input" : "configuration"])) as Record<string, EventOrigin>;
  const enabled = options.preview && Boolean(options.component.props.componentEvents || options.component.props.messageHandlers?.length);
  ref.current.prepare(enabled ? { key, component: options.component, components: options.components, inputs: options.inputs, parameters: options.parameters,
    state: state?.api, stateValues: state?.values, isCurrent: state?.isCurrent, setInput: options.onAutomaticInputChange, coordinator, python: options.python, origins,
    messages: state ? { bus: state.store.componentMessages, screenKey: state.screenScope.key, instanceKey: state.instanceScope?.key ?? state.screenScope.key } : undefined,
    suspended: !active, interactionEnabled: active && options.interactionEnabled === true } : undefined, samples);
  useEffect(() => { const runner = ref.current!; runner.activate(); return () => runner.deactivate(); }, []);
  // Commit on each resolved sample or source snapshot change. Handler execution
  // itself is scheduled outside React's effect stack by the lifecycle.
  useEffect(() => { ref.current!.commit(); }, [enabled, key, JSON.stringify(samples), options.inputs, state?.values, active, options.interactionEnabled]);
  return componentInteractionHandlers(options.component, active && options.interactionEnabled === true,
    event => ref.current!.interaction(key, event));
}

/** Capture observes native interactions without cancelling native focus, editing or activation. */
export function componentInteractionHandlers(component: CanvasComponent, enabled: boolean, dispatch: (event: AutomaticComponentEvent) => unknown):
  HTMLAttributes<HTMLElement> & { "data-component-event-owner": string } {
  const element = (target: EventTarget | null) => target && typeof (target as Element).closest === "function" ? target as Element : null;
  const handle = (type: ComponentInteractionEventType, event: SyntheticEvent<HTMLElement>, data: ComponentInteractionData = {}, relatedTarget?: EventTarget | null) => {
    const target = element(event.target), owner = event.currentTarget;
    if (!enabled || !target || !owner.contains(target) || target.closest("[data-component-event-owner]") !== owner ||
      target.closest("[inert], [hidden], [aria-disabled='true']")) return;
    if ((type === "focus" || type === "blur") && element(relatedTarget ?? null)?.closest("[data-component-event-owner]") === owner) return;
    dispatch(componentInteractionEvent(type, component.id, data, component.type === "passwordInput" || Boolean(target.closest("input[type='password']"))));
  };
  const hasFocusHandler = ["focus", "blur", "keyDown", "keyUp"].some(type => Object.hasOwn(component.props.componentEvents ?? {}, type));
  return {
    "data-component-event-owner": component.id,
    // Native controls retain their normal tab stops. Authored static displays
    // gain one only when the author requests focus or keyboard behavior.
    ...(enabled && hasFocusHandler && !isInput(component.type) && !["button", "equipmentCommand", "equipmentSymbol"].includes(component.type) ? { tabIndex: 0 } : {}),
    onFocusCapture: event => handle("focus", event, {}, event.relatedTarget),
    onBlurCapture: event => handle("blur", event, {}, event.relatedTarget),
    onKeyDownCapture: event => handle("keyDown", event, { ...event, isComposing: event.nativeEvent.isComposing }),
    onKeyUpCapture: event => handle("keyUp", event, { ...event, isComposing: event.nativeEvent.isComposing }),
    onDoubleClickCapture: event => handle("doubleClick", event, event),
    onPointerDownCapture: event => handle("pointerDown", event, event),
    onPointerUpCapture: event => handle("pointerUp", event, event),
  };
}

/** Owned by the application/dialog, so departing components can report cleanup failures. */
export function ComponentEventDiagnostics({ state, errorsOnly = false }: { state?: ApplicationStateContext; errorsOnly?: boolean }) {
  const inherited = useApplicationStateContext();
  const coordinator = (state ?? inherited)?.store?.componentEvents;
  const [, update] = useState(0);
  useEffect(() => coordinator?.subscribe(() => update(value => value + 1)), [coordinator]);
  const snapshot = coordinator?.snapshot();
  const diagnostics = snapshot?.diagnostics.filter(item => !errorsOnly || item.level === "error") ?? [];
  if (!snapshot?.breaker && !diagnostics.length) return null;
  return <section className="component-event-diagnostics" aria-label="Component event messages">
    {snapshot?.breaker && <div className="component-event-diagnostic breaker" role="alert"><strong>Automatic events stopped</strong><span>{snapshot.breaker}</span></div>}
    {diagnostics.map(item => <div key={item.id} className={`component-event-diagnostic ${item.level}`} role={item.level === "error" ? "alert" : "status"}>
      <strong>{item.componentId}</strong><span>{item.message}</span><button type="button" onClick={() => coordinator?.dismiss(item.id)} aria-label={`Dismiss event message from ${item.componentId}`}>Dismiss</button>
    </div>)}
  </section>;
}
