import { resolvePath } from "./api";
import { bindingTargets, propertyValue, supportsBindingTarget } from "./propertyBindings";
import { isInput } from "./inputs";
import { inputAssignmentError } from "./inputEvents";
import type { CanvasComponent, ComponentEventProperty, ComponentEventScript, InputValue, InputValues, RuntimeParameters, RuntimeStateApi, RuntimeStateValues } from "./types";

export function componentEventProperties(component: CanvasComponent): ComponentEventProperty[] {
  return [...new Set([...bindingTargets.filter(target => supportsBindingTarget(component.type, target)),
    ...(isInput(component.type) && component.type !== "passwordInput" ? ["value" as const] : [])])];
}
export interface ComponentPropertySample { value: InputValue | null; available: boolean; error: string }
export type ComponentPropertySamples = Partial<Record<ComponentEventProperty, ComponentPropertySample>>;
export function componentEventSamples(component: CanvasComponent, evaluated: CanvasComponent, errors: Record<string, string>,
  parameters: RuntimeParameters, input: InputValue | null | undefined, inputError?: string | null): ComponentPropertySamples {
  const samples: ComponentPropertySamples = {};
  for (const property of component.props.componentEvents?.propertyChange?.properties ?? []) {
    let value: unknown, error = errors[property] ?? "";
    if (!componentEventProperties(component).includes(property)) error = "This component does not expose the watched property.";
    if (property === "value" && isInput(component.type)) { value = input; error ||= inputError ?? ""; }
    else {
      value = propertyValue(evaluated, property);
      if (property === "enabled" || property === "visible") value ??= true;
      if (typeof value === "string" && !component.props.bindings?.[property] && ["text", "tagPath", "stateValue", "unit"].includes(property)) value = resolvePath(value, parameters);
    }
    const available = !error && (typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
    samples[property] = { value: available ? value as InputValue : null, available, error: error || (available ? "" : "The property has no available scalar value.") };
  }
  return samples;
}
const same = (a: ComponentPropertySample, b: ComponentPropertySample) => Object.is(a.value, b.value) && a.available === b.available && a.error === b.error;
const frozen = <T,>(value: T): T => {
  const copy = structuredClone(value);
  const freeze = (item: unknown) => { if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); } };
  freeze(copy); return copy;
};
export interface ComponentEventDiagnostic { id: number; componentId: string; message: string; level: "error" | "info" }
export interface ComponentEventStatus { diagnostics: ComponentEventDiagnostic[]; breaker: string }

/** One run-wide breaker; popup/instance churn cannot reset its budget. */
export class ComponentEventCoordinator {
  private timestamps: number[] = [];
  private sequence = 0;
  private listeners = new Set<() => void>();
  private clients = new Set<() => void>();
  private pending = 0;
  private burst = 0;
  private generation = 0;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private notificationQueued = false;
  private state: ComponentEventStatus = { diagnostics: [], breaker: "" };
  constructor(private readonly now: () => number = () => Date.now()) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  register(cancel: () => void) { this.clients.add(cancel); return () => { this.clients.delete(cancel); }; }
  private changed() {
    if (this.notificationQueued) return; this.notificationQueued = true;
    queueMicrotask(() => { this.notificationQueued = false; for (const listener of [...this.listeners]) listener(); });
  }
  report(componentId: string, message: string, level: "error" | "info" = "error") {
    this.state = { ...this.state, diagnostics: [...this.state.diagnostics, { id: ++this.sequence, componentId, message: message.slice(0, 2500), level }].slice(-20) };
    this.changed();
  }
  dismiss(id: number) { this.state = { ...this.state, diagnostics: this.state.diagnostics.filter(item => item.id !== id) }; this.changed(); }
  private trip(message: string): false {
    this.state = { ...this.state, breaker: message };
    for (const cancel of [...this.clients]) cancel();
    this.changed(); return false;
  }
  accept(type: "mount" | "propertyChange" = "mount"): boolean {
    if (this.state.breaker) return false;
    const now = this.now(); this.timestamps = this.timestamps.filter(time => now - time < 1000);
    if (this.timestamps.length >= 512) {
      return this.trip("Automatic component events stopped after 512 events in one second. Fix the event loop, then reopen the screen or restart Preview.");
    }
    if (type === "propertyChange" && ++this.burst > 128) return this.trip("Automatic component events stopped after 128 property changes without a quiet break. Fix the event loop, then reopen the screen or restart Preview.");
    this.timestamps.push(now); return true;
  }
  queued(): () => void {
    this.pending++; const generation = this.generation; let finished = false;
    if (this.quietTimer !== undefined) clearTimeout(this.quietTimer);
    return () => {
      if (finished || generation !== this.generation) return; finished = true; this.pending--;
      if (this.pending === 0) this.quietTimer = setTimeout(() => { if (this.pending === 0) this.burst = 0; }, 50);
    };
  }
  reset() {
    for (const cancel of [...this.clients]) cancel();
    if (this.quietTimer !== undefined) clearTimeout(this.quietTimer);
    this.generation++; this.pending = 0; this.burst = 0;
    this.timestamps = []; this.state = { diagnostics: [], breaker: "" }; this.changed();
  }
}
export interface AutomaticComponentEvent {
  type: "mount" | "propertyChange" | "unmount"; componentId: string;
  property?: ComponentEventProperty; value?: InputValue | null; previousValue?: InputValue | null;
  available?: boolean; previousAvailable?: boolean; error?: string; previousError?: string;
}
export interface ComponentEventApp {
  notify: (message: unknown) => void;
  setInput: (field: string, value: unknown) => void;
  state: RuntimeStateApi;
  signal: AbortSignal;
  onCleanup: (callback: () => unknown | Promise<unknown>) => void;
}
export interface ComponentEventContext {
  key: string; component: CanvasComponent; components: CanvasComponent[]; inputs: InputValues; parameters: RuntimeParameters;
  state?: RuntimeStateApi; stateValues?: RuntimeStateValues; isCurrent?: () => boolean;
  setInput?: (field: string, value: InputValue) => void;
  coordinator: ComponentEventCoordinator;
}
export type ComponentEventExecutor = (script: ComponentEventScript, event: AutomaticComponentEvent, inputs: InputValues,
  parameters: RuntimeParameters, app: ComponentEventApp) => unknown | Promise<unknown>;
export const executeComponentEvent: ComponentEventExecutor = (script, event, inputs, parameters, app) => {
  const execute = new Function("event", "inputs", "parameters", "app", `"use strict"; return (async () => {\n${script.code}\n})();`);
  return execute(event, inputs, parameters, app);
};
interface Invocation { active: boolean; controller: AbortController }
interface EventOwner {
  context: ComponentEventContext; baseline: ComponentPropertySamples; closed: boolean; blocked: boolean;
  queue: Promise<void>; pending: number; invocations: Set<Invocation>; cleanups: (() => unknown | Promise<unknown>)[];
  controller: AbortController;
  unregister: () => void; cleanupReading: boolean; cleanupValues?: RuntimeStateValues;
}

/** Trusted JavaScript runs serially. Dead/expired invocations lose all helper authority. */
export class ComponentEventLifecycle {
  private active = false;
  private prepared: { context: ComponentEventContext; samples: ComponentPropertySamples } | undefined;
  private owner: EventOwner | undefined;
  private retiring: EventOwner[] = [];
  private cleanupWork = Promise.resolve();
  constructor(private readonly execute: ComponentEventExecutor = executeComponentEvent,
    private readonly timeoutMs = 2000, private readonly cleanupTimeoutMs = 1000) {}
  activate() { this.active = true; }
  prepare(context: ComponentEventContext | undefined, samples: ComponentPropertySamples = {}) {
    if (this.owner && (this.owner.context.key !== context?.key || this.owner.context.coordinator !== context?.coordinator)) {
      this.retire(this.owner); this.retiring.push(this.owner); this.owner = undefined;
    }
    this.prepared = context ? { context, samples } : undefined;
  }
  commit() {
    for (const owner of this.retiring.splice(0)) this.cleanupWork = this.cleanupWork.then(() => this.cleanup(owner));
    if (!this.active || !this.prepared) return;
    const { context, samples } = this.prepared;
    if (context.isCurrent?.() === false) return;
    if (!this.owner) {
      const owner: EventOwner = { context, baseline: frozen(samples), closed: false, blocked: false, queue: Promise.resolve(), pending: 0,
        invocations: new Set(), cleanups: [], controller: new AbortController(), unregister: () => {}, cleanupReading: false };
      owner.unregister = context.coordinator.register(() => this.cancel(owner)); this.owner = owner;
      this.enqueue(owner, "mount", { type: "mount", componentId: context.component.id });
      return;
    }
    const owner = this.owner; owner.context = context;
    for (const property of context.component.props.componentEvents?.propertyChange?.properties ?? []) {
      const next = samples[property], previous = owner.baseline[property];
      if (next && previous && !same(next, previous)) this.enqueue(owner, "propertyChange", { type: "propertyChange", componentId: context.component.id,
        property, value: next.value, previousValue: previous.value, available: next.available, previousAvailable: previous.available, error: next.error, previousError: previous.error });
    }
    owner.baseline = frozen(samples);
  }
  deactivate() {
    // Retain the prepared render for React's setup-cleanup-setup replay. Its
    // previous owner is still irrevocably closed, so old helpers never revive.
    this.active = false;
    if (this.owner) { this.retire(this.owner); this.retiring.push(this.owner); this.owner = undefined; }
    for (const owner of this.retiring.splice(0)) this.cleanupWork = this.cleanupWork.then(() => this.cleanup(owner));
  }
  whenIdle() { return Promise.all([this.owner?.queue, this.cleanupWork]); }
  private cancel(owner: EventOwner) {
    owner.blocked = true;
    owner.controller.abort();
    for (const invocation of owner.invocations) { invocation.active = false; invocation.controller.abort(); }
  }
  private retire(owner: EventOwner) {
    owner.closed = true; owner.cleanupValues = owner.context.stateValues ? frozen(owner.context.stateValues) : undefined;
    owner.unregister(); this.cancel(owner);
  }
  private inputs(context: ComponentEventContext): InputValues {
    const forbidden = new Set(context.components.filter(component => component.type === "passwordInput").map(component => component.props.fieldKey || component.id));
    return frozen(Object.fromEntries(Object.entries(context.inputs).filter(([key]) => !forbidden.has(key))));
  }
  private app(owner: EventOwner, invocation: Invocation, cleanup = false): ComponentEventApp {
    const live = () => this.active && !owner.closed && !owner.blocked && invocation.active && owner.context.isCurrent?.() !== false;
    const closedRead = (scope: Parameters<RuntimeStateApi["get"]>[0], key: string) => {
      const values = owner.cleanupValues?.[scope];
      if (!values || !Object.hasOwn(values, key)) throw new Error(`${scope} state '${key}' is unavailable during cleanup.`);
      return values[key];
    };
    return {
      signal: AbortSignal.any([owner.controller.signal, invocation.controller.signal]),
      notify: message => { if (!cleanup && live()) owner.context.coordinator.report(owner.context.component.id, String(message), "info"); },
      setInput: (field, value) => {
        if (cleanup || !live()) return;
        const context = owner.context;
        if (context.components.some(component => component.type === "passwordInput" && (component.props.fieldKey || component.id) === field)) throw new Error("Automatic events cannot assign password inputs.");
        const error = inputAssignmentError(context.components, field, value, context.parameters); if (error) throw new Error(error);
        context.setInput?.(field, value as InputValue);
      },
      state: {
        get: (scope, key) => {
          if (owner.cleanupReading && (cleanup || owner.closed)) return closedRead(scope, key);
          if (!live()) return undefined;
          if (!owner.context.state) throw new Error("Application state is unavailable in this context.");
          return owner.context.state.get(scope, key);
        },
        set: (scope, key, value) => { if (!cleanup && live()) { if (!owner.context.state) throw new Error("Application state is unavailable in this context."); owner.context.state.set(scope, key, value); } },
        reset: (scope, key) => { if (!cleanup && live()) { if (!owner.context.state) throw new Error("Application state is unavailable in this context."); owner.context.state.reset(scope, key); } },
      },
      onCleanup: callback => {
        if (cleanup || !live()) return;
        if (typeof callback !== "function") throw new Error("onCleanup requires a callback.");
        if (owner.cleanups.length >= 16) throw new Error("A component can register at most 16 cleanup callbacks.");
        owner.cleanups.push(callback);
      },
    };
  }
  private async bounded(run: () => unknown | Promise<unknown>, invocation: Invocation, timeout: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.resolve().then(run), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { invocation.active = false; invocation.controller.abort(); reject(new Error(`Event timed out after ${timeout} ms; its helpers have been revoked.`)); }, timeout);
      })]);
    } catch (error) { invocation.active = false; invocation.controller.abort(); throw error; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  private enqueue(owner: EventOwner, type: "mount" | "propertyChange", event: AutomaticComponentEvent) {
    const context = owner.context, script = context.component.props.componentEvents?.[type];
    if (!script?.code.trim() || owner.blocked || owner.closed) return;
    if (script.language !== "javascript" || script.code.length > 65536) { context.coordinator.report(context.component.id, `${type}: events require JavaScript with at most 65,536 characters.`); return; }
    if (owner.pending >= 32) { context.coordinator.report(context.component.id, "Automatic event queue is full (32 events). New events were skipped."); return; }
    if (!context.coordinator.accept(type)) return;
    const finish = context.coordinator.queued();
    const inputs = this.inputs(context), parameters = frozen(context.parameters), snapshot = frozen(event);
    owner.pending++;
    owner.queue = owner.queue.then(async () => {
      // A task boundary prevents state feedback from recursively exhausting
      // React's passive-effect update depth before the shared breaker runs.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (!this.active || owner.closed || owner.blocked || owner.context.isCurrent?.() === false) return;
      const invocation = { active: true, controller: new AbortController() }; owner.invocations.add(invocation);
      try { await this.bounded(() => this.execute(script, snapshot, inputs, parameters, this.app(owner, invocation)), invocation, this.timeoutMs); }
      catch (error) { if (!owner.closed && !owner.blocked) context.coordinator.report(context.component.id, `${type}${event.property ? ` (${event.property})` : ""}: ${error instanceof Error ? error.message : String(error)}`); }
      finally { owner.invocations.delete(invocation); }
    }).finally(() => { owner.pending--; finish(); });
  }
  private async cleanup(owner: EventOwner) {
    owner.cleanupReading = true;
    const context = owner.context, script = context.component.props.componentEvents?.unmount;
    const invocation = { active: true, controller: new AbortController() }; invocation.controller.abort();
    const runs: (() => unknown | Promise<unknown>)[] = [...owner.cleanups.splice(0)];
    if (script?.code.trim()) runs.unshift(() => {
      if (script.language !== "javascript" || script.code.length > 65536) throw new Error("Cleanup requires JavaScript with at most 65,536 characters.");
      return this.execute(script, frozen({ type: "unmount", componentId: context.component.id }), this.inputs(context), frozen(context.parameters), this.app(owner, invocation, true));
    });
    try {
      await this.bounded(async () => { for (const run of runs) {
        if (!invocation.active) return;
        try { await run(); } catch (error) { context.coordinator.report(context.component.id, `unmount: ${error instanceof Error ? error.message : String(error)}`); }
      } }, invocation, this.cleanupTimeoutMs);
    } catch (error) { context.coordinator.report(context.component.id, `unmount: ${error instanceof Error ? error.message : String(error)}`); }
    finally { invocation.active = false; owner.cleanupReading = false; }
  }
}
