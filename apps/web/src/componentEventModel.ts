import { resolvePath } from "./api";
import { previewScriptsAllowed, requirePreviewScriptPermission } from "./previewRequest";
import { bindingTargets, propertyValue, supportsBindingTarget } from "./propertyBindings";
import { isInput } from "./inputs";
import { inputAssignmentError } from "./inputEvents";
import { createComponentMessageSender, type ComponentMessageBus, type ComponentMessageSender, type MessageContext } from "./componentMessageModel";
import type { CanvasComponent, ComponentEventProperty, ComponentEventScript, ComponentInteractionEventType, InputValue, InputValues, RuntimeParameters, RuntimeStateApi, RuntimeStateValues } from "./types";
import type { EventOrigin, PythonEventRunner } from "./pythonComponentEvents";

export const componentInteractionTypes: ComponentInteractionEventType[] = ["focus", "blur", "keyDown", "keyUp", "doubleClick", "pointerDown", "pointerUp"];
export const isComponentInteraction = (type: string): type is ComponentInteractionEventType => componentInteractionTypes.includes(type as ComponentInteractionEventType);
export interface ComponentInteractionData {
  key?: string; code?: string; repeat?: boolean; isComposing?: boolean; redacted?: boolean;
  altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean;
  button?: number; buttons?: number; pointerType?: string; pointerId?: number; clientX?: number; clientY?: number;
}
/** Copies only bounded primitives. DOM targets, input values and native methods never enter scripts. */
export function componentInteractionEvent(type: ComponentInteractionEventType, componentId: string, data: ComponentInteractionData = {}, password = false): AutomaticComponentEvent {
  const event: AutomaticComponentEvent = { type, componentId, origin: "user" };
  if (type === "focus" || type === "blur") return event;
  for (const key of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) event[key] = data[key] === true;
  if (type === "keyDown" || type === "keyUp") {
    Object.assign(event, { key: password ? "" : String(data.key ?? "").slice(0, 128), code: password ? "" : String(data.code ?? "").slice(0, 64),
      repeat: data.repeat === true, isComposing: data.isComposing === true, redacted: password });
  } else {
    const bounded = (value: number | undefined, fallback: number, minimum: number, maximum: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
    Object.assign(event, { button: Math.trunc(bounded(data.button, 0, -1, 5)), buttons: Math.trunc(bounded(data.buttons, 0, 0, 63)),
      clientX: bounded(data.clientX, 0, -10_000_000, 10_000_000), clientY: bounded(data.clientY, 0, -10_000_000, 10_000_000) });
    if (type !== "doubleClick") Object.assign(event, { pointerType: ["mouse", "pen", "touch", ""].includes(data.pointerType ?? "") ? data.pointerType ?? "" : "",
      pointerId: Math.trunc(bounded(data.pointerId, 0, -1, 2_147_483_647)) });
  }
  return event;
}

export function componentEventProperties(component: CanvasComponent, language: "javascript" | "python" = "javascript"): ComponentEventProperty[] {
  return [...new Set([...bindingTargets.filter(target => supportsBindingTarget(component.type, target) && !(component.type === "passwordInput" && language === "python" && target === "text")),
    ...(isInput(component.type) && component.type !== "passwordInput" ? ["value" as const] : [])])];
}
export interface ComponentPropertySample { value: InputValue | null; available: boolean; error: string }
export type ComponentPropertySamples = Partial<Record<ComponentEventProperty, ComponentPropertySample>>;
export function componentEventSamples(component: CanvasComponent, evaluated: CanvasComponent, errors: Record<string, string>,
  parameters: RuntimeParameters, input: InputValue | null | undefined, inputError?: string | null,
  literalProperties: Readonly<Record<string, unknown>> = {}): ComponentPropertySamples {
  const samples: ComponentPropertySamples = {};
  for (const property of component.props.componentEvents?.propertyChange?.properties ?? []) {
    let value: unknown, error = errors[property] ?? "";
    if (!componentEventProperties(component, component.props.componentEvents?.propertyChange?.language).includes(property)) error = "This component does not expose the watched property.";
    if (property === "value" && isInput(component.type)) { value = input; error ||= inputError ?? ""; }
    else {
      value = propertyValue(evaluated, property);
      if (property === "enabled" || property === "visible") value ??= true;
      if (typeof value === "string" && !Object.hasOwn(literalProperties, property) && !component.props.bindings?.[property] && !component.props.queryBindings?.[property] && ["text", "tagPath", "stateValue", "unit"].includes(property)) value = resolvePath(value, parameters);
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
export interface ComponentEventDiagnostic { id: number; componentId: string; message: string; level: "error" | "info"; recordedAt: string }
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
    this.state = { ...this.state, diagnostics: [...this.state.diagnostics, { id: ++this.sequence, componentId, message: message.slice(0, 2500), level, recordedAt: new Date(this.now()).toISOString() }].slice(-20) };
    this.changed();
  }
  dismiss(id: number) { this.state = { ...this.state, diagnostics: this.state.diagnostics.filter(item => item.id !== id) }; this.changed(); }
  private trip(message: string): false {
    this.state = { ...this.state, breaker: message };
    for (const cancel of [...this.clients]) cancel();
    this.changed(); return false;
  }
  accept(type: "mount" | "propertyChange" | "message" | "input" | ComponentInteractionEventType = "mount"): boolean {
    if (this.state.breaker) return false;
    const now = this.now(); this.timestamps = this.timestamps.filter(time => now - time < 1000);
    if (this.timestamps.length >= 512) {
      return this.trip("Automatic component events stopped after 512 events in one second. Fix the event loop, then reopen the screen or restart Preview.");
    }
    if ((type === "propertyChange" || type === "message") && ++this.burst > 128) return this.trip("Automatic component events stopped after 128 property changes or messages without a quiet break. Fix the event loop, then reopen the screen or restart Preview.");
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
export interface AutomaticComponentEvent extends ComponentInteractionData {
  type: "mount" | "propertyChange" | "unmount" | "message" | ComponentInteractionEventType; componentId: string;
  property?: ComponentEventProperty; value?: InputValue | null; previousValue?: InputValue | null;
  available?: boolean; previousAvailable?: boolean; error?: string; previousError?: string;
  origin?: EventOrigin;
  messageType?: string; payload?: Readonly<Record<string, unknown>>; scope?: "instance" | "screen" | "session"; messageId?: string;
}
export interface ComponentEventApp {
  notify: (message: unknown) => void;
  setInput: (field: string, value: unknown) => void;
  state: RuntimeStateApi;
  signal: AbortSignal;
  onCleanup: (callback: () => unknown | Promise<unknown>) => void;
  sendMessage: ComponentMessageSender;
}
export interface ComponentEventContext {
  key: string; component: CanvasComponent; components: CanvasComponent[]; inputs: InputValues; parameters: RuntimeParameters;
  state?: RuntimeStateApi; stateValues?: RuntimeStateValues; isCurrent?: () => boolean;
  setInput?: (field: string, value: InputValue) => void;
  coordinator: ComponentEventCoordinator;
  messages?: MessageContext & { bus: ComponentMessageBus };
  python?: PythonEventRunner;
  origins?: Partial<Record<ComponentEventProperty, EventOrigin>>;
  interactionEnabled?: boolean;
  suspended?: boolean;
}
export type ComponentEventExecutor = (script: ComponentEventScript, event: AutomaticComponentEvent, inputs: InputValues,
  parameters: RuntimeParameters, app: ComponentEventApp) => unknown | Promise<unknown>;
export const executeComponentEvent: ComponentEventExecutor = (script, event, inputs, parameters, app) => {
  requirePreviewScriptPermission();
  if (script.language !== "javascript") throw new Error("Python events require the gateway event transport.");
  const execute = new Function("event", "inputs", "parameters", "app", `"use strict"; return (async () => {\n${script.code}\n})();`);
  return execute(event, inputs, parameters, app);
};
interface Invocation { active: boolean; controller: AbortController; activityRevision?: number; interactionRevision?: number }
interface EventOwner {
  context: ComponentEventContext; baseline: ComponentPropertySamples; closed: boolean; blocked: boolean;
  scriptsAllowed: boolean;
  queue: Promise<void>; pending: number; invocations: Set<Invocation>; cleanups: (() => unknown | Promise<unknown>)[];
  controller: AbortController;
  unregister: () => void; cleanupReading: boolean; cleanupValues?: RuntimeStateValues;
  unregisterMessages: () => void; messageSignature: string; messageRevision?: number;
  started: boolean;
  suspended: boolean; activityRevision: number; interactionEnabled: boolean; interactionRevision: number; resumePending: boolean;
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
    if (this.owner && (this.owner.context.isCurrent?.() === false || this.owner.context.key !== context?.key || this.owner.context.coordinator !== context?.coordinator ||
      this.owner.context.messages?.bus !== context?.messages?.bus || this.owner.context.messages?.screenKey !== context?.messages?.screenKey ||
      this.owner.context.messages?.instanceKey !== context?.messages?.instanceKey || this.owner.messageRevision !== context?.messages?.bus.revision ||
      this.owner.messageSignature !== JSON.stringify(context?.component.props.messageHandlers ?? []))) {
      this.retire(this.owner); this.retiring.push(this.owner); this.owner = undefined;
    }
    if (this.owner && context) {
      const owner = this.owner, suspended = context.suspended === true, interactionEnabled = context.interactionEnabled === true;
      if (owner.suspended !== suspended) {
        owner.suspended = suspended; owner.activityRevision++;
        if (suspended) {
          owner.unregisterMessages(); owner.unregisterMessages = () => {};
          owner.controller.abort();
          for (const invocation of owner.invocations) { invocation.active = false; invocation.controller.abort(); }
        } else { owner.controller = new AbortController(); owner.resumePending = true; }
      }
      if (owner.interactionEnabled !== interactionEnabled) {
        owner.interactionEnabled = interactionEnabled; owner.interactionRevision++;
        for (const invocation of owner.invocations) if (invocation.interactionRevision !== undefined) { invocation.active = false; invocation.controller.abort(); }
      }
    }
    this.prepared = context ? { context, samples } : undefined;
  }
  commit() {
    for (const owner of this.retiring.splice(0)) this.cleanupWork = this.cleanupWork.then(() => this.cleanup(owner));
    if (!this.active || !this.prepared) return;
    const { context, samples } = this.prepared;
    if (context.isCurrent?.() === false) return;
    if (!this.owner) {
      const owner: EventOwner = { context, baseline: frozen(samples), closed: false, blocked: false, scriptsAllowed: previewScriptsAllowed(), queue: this.cleanupWork, pending: 0,
        invocations: new Set(), cleanups: [], controller: new AbortController(), unregister: () => {}, cleanupReading: false,
        unregisterMessages: () => {}, messageSignature: JSON.stringify(context.component.props.messageHandlers ?? []), messageRevision: context.messages?.bus.revision, started: false,
        suspended: context.suspended === true, activityRevision: 0, interactionEnabled: context.interactionEnabled === true, interactionRevision: 0, resumePending: false };
      owner.unregister = context.coordinator.register(() => this.cancel(owner)); this.owner = owner;
      if (!owner.suspended) this.start(owner);
      // React StrictMode retires its phantom owner synchronously before this
      // microtask. It must not send a gateway cleanup for a mount that never ran.
      return;
    }
    const owner = this.owner; owner.context = context;
    if (owner.suspended) { owner.baseline = frozen(samples); return; }
    if (owner.resumePending) {
      owner.resumePending = false; owner.baseline = frozen(samples);
      if (!owner.started) this.start(owner); else this.registerMessages(owner);
      return;
    }
    for (const property of context.component.props.componentEvents?.propertyChange?.properties ?? []) {
      const next = samples[property], previous = owner.baseline[property];
      if (next && previous && !same(next, previous)) this.enqueue(owner, "propertyChange", { type: "propertyChange", componentId: context.component.id,
        property, value: next.value, previousValue: previous.value, available: next.available, previousAvailable: previous.available, error: next.error, previousError: previous.error,
        origin: context.origins?.[property] ?? "configuration" });
    }
    owner.baseline = frozen(samples);
  }
  private start(owner: EventOwner) {
    this.registerMessages(owner);
    this.enqueue(owner, "mount", { type: "mount", componentId: owner.context.component.id });
    queueMicrotask(() => { if (!owner.closed && !owner.suspended && this.active) owner.started = true; });
  }
  interaction(key: string, event: AutomaticComponentEvent): boolean {
    const owner = this.owner;
    if (!owner || !this.active || owner.closed || owner.blocked || owner.suspended || !owner.interactionEnabled ||
      key !== owner.context.key || this.prepared?.context.key !== key || owner.context.isCurrent?.() === false ||
      event.componentId !== owner.context.component.id || !isComponentInteraction(event.type) || !previewScriptsAllowed()) return false;
    return this.enqueue(owner, event.type, event);
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
    owner.unregisterMessages(); owner.unregisterMessages = () => {};
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
    const capturedCurrent = owner.context.isCurrent;
    const live = () => this.active && !owner.closed && !owner.blocked && !owner.suspended && invocation.active &&
      (invocation.activityRevision === undefined || invocation.activityRevision === owner.activityRevision) &&
      (invocation.interactionRevision === undefined || owner.interactionEnabled && invocation.interactionRevision === owner.interactionRevision) &&
      capturedCurrent?.() !== false && owner.context.isCurrent?.() !== false &&
      owner.messageRevision === owner.context.messages?.bus.revision;
    const messages = owner.context.messages;
    const sendMessage: ComponentMessageSender = messages
      ? createComponentMessageSender(messages.bus, messages, () => !cleanup && live() && owner.scriptsAllowed)
      : () => ({ messageId: "", accepted: 0 });
    const closedRead = (scope: Parameters<RuntimeStateApi["get"]>[0], key: string) => {
      const values = owner.cleanupValues?.[scope];
      if (!values || !Object.hasOwn(values, key)) throw new Error(`${scope} state '${key}' is unavailable during cleanup.`);
      return values[key];
    };
    return {
      sendMessage,
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
  private registerMessages(owner: EventOwner) {
    const context = owner.context, messages = context.messages;
    if (!messages || !owner.scriptsAllowed || owner.closed || owner.blocked || owner.suspended) return;
    const handlers = context.component.props.messageHandlers ?? [];
    if (handlers.length > 16) { context.coordinator.report(context.component.id, "A component can register at most 16 message handlers."); return; }
    const signatures = new Set<string>(), removals: (() => void)[] = [];
    try {
      for (const handler of handlers) {
        if (handler.language === "python" && !context.python) continue;
        const signature = JSON.stringify([handler.messageType, handler.scope]);
        if (signatures.has(signature)) throw new Error("A component cannot register the same message type and scope twice.");
        signatures.add(signature);
        if (!["javascript", "python"].includes(handler.language) || handler.language === "javascript" && !handler.code?.trim() || (handler.code?.length ?? 0) > 65536)
          throw new Error("Message handlers require Python or JavaScript with at most 65,536 characters.");
        const script = frozen({ language: handler.language, code: handler.code });
        removals.push(messages.bus.register(handler.messageType, handler.scope, messages, event => {
          if (!this.active || owner.closed || owner.blocked || owner.suspended || owner.context.isCurrent?.() === false ||
            owner.messageRevision !== messages.bus.revision || !previewScriptsAllowed()) return false;
          return this.enqueue(owner, "message", { ...event, componentId: context.component.id }, script, handler.id);
        }));
      }
      owner.unregisterMessages = () => { for (const remove of removals.splice(0)) remove(); };
    } catch (error) {
      for (const remove of removals) remove();
      context.coordinator.report(context.component.id, `message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private enqueue(owner: EventOwner, type: "mount" | "propertyChange" | "message" | ComponentInteractionEventType, event: AutomaticComponentEvent, suppliedScript?: ComponentEventScript, handlerId?: string): boolean {
    const context = owner.context, script = suppliedScript ?? (type === "message" ? undefined : context.component.props.componentEvents?.[type]);
    const interaction = isComponentInteraction(type), activityRevision = owner.activityRevision, interactionRevision = owner.interactionRevision;
    if (!script || script.language !== "python" && !script.code?.trim() || owner.blocked || owner.closed || owner.suspended || !owner.scriptsAllowed || interaction && !owner.interactionEnabled) return false;
    if (script.language === "python" && !context.python) return false;
    if (!["javascript", "python"].includes(script.language) || (script.code?.length ?? 0) > 65536) { context.coordinator.report(context.component.id, `${type}: use Python or JavaScript with at most 65,536 characters.`); return false; }
    if (owner.pending >= 32) { context.coordinator.report(context.component.id, "Automatic event queue is full (32 events). New events were skipped."); return false; }
    // The bus has already charged each addressed message to this same coordinator.
    if (type !== "message" && !context.coordinator.accept(type)) return false;
    const finish = context.coordinator.queued();
    const inputs = this.inputs(context), parameters = frozen(context.parameters), snapshot = frozen(event);
    owner.pending++;
    owner.queue = owner.queue.then(async () => {
      // A task boundary prevents state feedback from recursively exhausting
      // React's passive-effect update depth before the shared breaker runs.
      if (type !== "mount" || script.language !== "python") await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (!this.active || owner.closed || owner.blocked || owner.suspended || owner.activityRevision !== activityRevision ||
        interaction && (!owner.interactionEnabled || owner.interactionRevision !== interactionRevision) || context.isCurrent?.() === false || owner.context.isCurrent?.() === false ||
        owner.messageRevision !== owner.context.messages?.bus.revision || !previewScriptsAllowed()) return;
      const invocation: Invocation = { active: true, controller: new AbortController(), activityRevision, ...(interaction ? { interactionRevision } : {}) }; owner.invocations.add(invocation);
      try {
        const app = this.app(owner, invocation);
        if (script.language === "python") {
          if (!context.python) throw new Error("Python component events are unavailable in this context.");
          const output = await context.python(type === "message" ? { family: "message", handlerId: handlerId! }
            : type === "mount" ? { family: "lifecycle", type: "mount" } : isComponentInteraction(type) ? { family: "interaction", type } : { family: "propertyChange" }, snapshot, inputs, parameters, app.signal);
          if (output && !app.signal.aborted && !owner.closed && !owner.blocked && !owner.suspended && owner.activityRevision === activityRevision &&
            (!interaction || owner.interactionEnabled && owner.interactionRevision === interactionRevision) && context.isCurrent?.() !== false)
            context.coordinator.report(context.component.id, output, "info");
        } else await this.bounded(() => this.execute(script, snapshot, inputs, parameters, app), invocation, this.timeoutMs);
      }
      catch (error) { if (!owner.closed && !owner.blocked && !owner.suspended && owner.activityRevision === activityRevision &&
        (!interaction || owner.interactionEnabled && owner.interactionRevision === interactionRevision)) context.coordinator.report(context.component.id, `${type}${event.property ? ` (${event.property})` : ""}: ${error instanceof Error ? error.message : String(error)}`); }
      finally { owner.invocations.delete(invocation); }
    }).finally(() => { owner.pending--; finish(); });
    return true;
  }
  private async cleanup(owner: EventOwner) {
    // A read-only owner's unmount script stays disabled even after the outer
    // preview has closed and the transport has returned to authoring mode.
    if (!owner.scriptsAllowed) { owner.cleanups.length = 0; return; }
    // Cancelled live invocations finish before gateway cleanup starts. Their
    // signals already prohibit applying effects to this retired owner.
    await owner.queue;
    owner.cleanupReading = true;
    const context = owner.context, script = context.component.props.componentEvents?.unmount;
    const invocation = { active: true, controller: new AbortController() };
    const runs: (() => unknown | Promise<unknown>)[] = [...owner.cleanups.splice(0)];
    if (!owner.suspended && script && (script.language === "python" || script.code?.trim())) runs.unshift(async () => {
      if (!["javascript", "python"].includes(script.language) || (script.code?.length ?? 0) > 65536) throw new Error("Cleanup requires Python or JavaScript with at most 65,536 characters.");
      if (script.language === "python") {
        if (!owner.started || !context.python) return;
        const output = await context.python({ family: "lifecycle", type: "unmount" }, frozen({ type: "unmount", componentId: context.component.id }),
          this.inputs(context), frozen(context.parameters), invocation.controller.signal);
        if (output && invocation.active) context.coordinator.report(context.component.id, output, "info");
        return;
      }
      return this.execute(script, frozen({ type: "unmount", componentId: context.component.id }), this.inputs(context), frozen(context.parameters), this.app(owner, invocation, true));
    });
    try {
      await this.bounded(async () => { for (const run of runs) {
        if (!invocation.active) return;
        try { requirePreviewScriptPermission(); await run(); } catch (error) { context.coordinator.report(context.component.id, `unmount: ${error instanceof Error ? error.message : String(error)}`); }
      } }, invocation, script?.language === "python" ? Math.max(3500, this.cleanupTimeoutMs) : this.cleanupTimeoutMs);
    } catch (error) { context.coordinator.report(context.component.id, `unmount: ${error instanceof Error ? error.message : String(error)}`); }
    finally { invocation.active = false; owner.cleanupReading = false; }
  }
}
