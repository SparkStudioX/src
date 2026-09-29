import { useEffect, useRef, useState } from "react";
import { useApplicationStateContext } from "./applicationState";
import type { ApplicationStateContext } from "./applicationState";
import { ComponentEventCoordinator, ComponentEventLifecycle, componentEventSamples } from "./componentEventModel";
import type { CanvasComponent, InputValue, InputValues, RuntimeParameters } from "./types";
import "./componentEvents.css";

/** Automatic events use local helpers independently of user interaction gates. */
export function useComponentEvents(options: {
  component: CanvasComponent; evaluated: CanvasComponent; components: CanvasComponent[]; errors: Record<string, string>;
  parameters: RuntimeParameters; inputs: InputValues; inputValue?: InputValue | null; inputError?: string | null;
  preview: boolean; scopeKey?: string; onAutomaticInputChange?: (field: string, value: InputValue) => void;
}) {
  const state = useApplicationStateContext();
  const ref = useRef<ComponentEventLifecycle | null>(null);
  if (!ref.current) ref.current = new ComponentEventLifecycle();
  const fallback = useRef<ComponentEventCoordinator | null>(null);
  if (!fallback.current) fallback.current = new ComponentEventCoordinator();
  const coordinator = state?.store?.componentEvents ?? fallback.current;
  const key = JSON.stringify([state?.key, options.scopeKey, options.component.id, options.component.type,
    options.component.props.componentEvents, options.parameters,
    options.components.map(component => [component.id, component.type, component.props.fieldKey, component.props.stateBinding,
      component.props.min, component.props.max, component.props.options, component.props.optionsSource])]);
  const samples = componentEventSamples(options.component, options.evaluated, options.errors, options.parameters, options.inputValue, options.inputError);
  const enabled = options.preview && Boolean(options.component.props.componentEvents);
  ref.current.prepare(enabled ? { key, component: options.component, components: options.components, inputs: options.inputs, parameters: options.parameters,
    state: state?.api, stateValues: state?.values, isCurrent: state?.isCurrent, setInput: options.onAutomaticInputChange, coordinator } : undefined, samples);
  useEffect(() => { const runner = ref.current!; runner.activate(); return () => runner.deactivate(); }, []);
  // Commit on each resolved sample or source snapshot change. Handler execution
  // itself is scheduled outside React's effect stack by the lifecycle.
  useEffect(() => { ref.current!.commit(); }, [enabled, key, JSON.stringify(samples), options.inputs, state?.values]);
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
