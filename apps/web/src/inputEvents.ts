import type { RuntimeParameters, RuntimeStateApi } from "./types";
import type { ComponentMessageSender } from "./componentMessageModel";
import { previewScriptsAllowed, requirePreviewScriptPermission } from "./previewRequest";
import { isInput, validateInputs } from "./inputs";
import type { CanvasComponent, InputEventScript, InputEventType, InputValue, InputValues } from "./types";
import type { ComponentEventCoordinator } from "./componentEventModel";
import type { PythonEventRunner } from "./pythonComponentEvents";

export interface InputEventPayload {
  type: InputEventType;
  componentId: string;
  fieldKey: string;
  value: InputValue;
  previousValue: InputValue | null;
  origin: "user";
}
export interface InputEventApp {
  sendMessage: ComponentMessageSender;
  notify: (message: unknown) => void;
  setInput: (fieldKey: string, value: unknown) => void;
  state: RuntimeStateApi;
  signal: AbortSignal;
}
export interface InputEventContext {
  sendMessage?: ComponentMessageSender;
  key: string;
  component: CanvasComponent;
  components: CanvasComponent[];
  inputs: InputValues;
  parameters: RuntimeParameters;
  setInput: (fieldKey: string, value: InputValue) => void;
  notify: (message: string) => void;
  error: (message: string) => void;
  clearStatus?: () => void;
  state?: RuntimeStateApi;
  python?: PythonEventRunner;
  coordinator?: ComponentEventCoordinator;
  isCurrent?: () => boolean;
}
export type InputEventExecutor = (script: InputEventScript, event: InputEventPayload, inputs: InputValues, parameters: RuntimeParameters, app: InputEventApp) => unknown | Promise<unknown>;

/** Local form assignments follow the same value rules as submitted inputs. */
export function inputAssignmentError(components: CanvasComponent[], fieldKey: string, value: unknown, parameters: RuntimeParameters = {}): string | null {
  const component = components.find((item) => isInput(item.type) && (item.props.fieldKey || item.id) === fieldKey);
  if (!component) return `Input '${String(fieldKey)}' is not declared in this form.`;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return `Input '${fieldKey}' needs a text, number, or Boolean value.`;
  return validateInputs({ id: "event-scope", name: "Event scope", width: 1, height: 1, components: [component] }, { [fieldKey]: value }, parameters);
}

// Authors are trusted: browser event code has the page's privileges. The app
// helpers restrict form effects, but are not a JavaScript security sandbox.
export const executeInputEvent: InputEventExecutor = (script, event, inputs, parameters, app) => {
  requirePreviewScriptPermission();
  if (script.language !== "javascript") throw new Error("Python events require the gateway event transport.");
  const execute = new Function("event", "inputs", "parameters", "app", `"use strict"; return (async () => {\n${script.code}\n})();`);
  return execute(event, inputs, parameters, app);
};

/** Serializes user events, deduplicates commits, and expires stale helper effects. */
export class InputEventLifecycle {
  private active = false;
  private generation = 0;
  private context: InputEventContext | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private observedValue: InputValue | null = null;
  private currentValue: InputValue | null = null;
  private committedValue: InputValue | null = null;
  private invocations = new Set<AbortController>();

  constructor(private readonly execute: InputEventExecutor = executeInputEvent, private readonly timeoutMs = 2000) {}

  activate() { this.active = true; }
  deactivate() {
    this.active = false;
    this.invalidate();
    this.context = null;
  }
  private invalidate() {
    for (const controller of this.invocations) controller.abort();
    this.invocations.clear();
    this.generation++;
    this.pending = 0;
    this.queue = Promise.resolve();
  }
  setContext(context: InputEventContext | null, value: InputValue | null) {
    if (this.context?.isCurrent?.() === false || this.context?.key !== context?.key || Boolean(this.context) !== Boolean(context)) {
      this.invalidate();
      this.observedValue = this.currentValue = this.committedValue = value;
    } else if (!Object.is(value, this.observedValue)) {
      this.observedValue = value;
      // An acknowledgement of this control's own edit preserves the commit
      // baseline. Tag/default/script updates establish a new silent baseline.
      if (!Object.is(value, this.currentValue)) this.currentValue = this.committedValue = value;
    }
    this.context = context;
  }
  whenIdle() { return this.queue; }
  get pendingCount() { return this.pending; }

  // A compound control can assign several fields within one browser event.
  // Keep that event's snapshot current before React acknowledges the updates.
  updateInputs(patch: InputValues) {
    if (this.context) this.context = { ...this.context, inputs: { ...this.context.inputs, ...patch } };
  }

  change(value: InputValue) {
    if (!this.active || !this.context || Object.is(this.currentValue, value)) return;
    const previousValue = this.currentValue;
    this.currentValue = value;
    this.enqueue("change", value, previousValue);
  }
  commit(value: InputValue) {
    if (!this.active || !this.context) return;
    this.change(value);
    if (Object.is(this.committedValue, value)) return;
    const previousValue = this.committedValue;
    this.committedValue = value;
    this.enqueue("commit", value, previousValue);
  }

  private enqueue(type: InputEventType, value: InputValue, previousValue: InputValue | null) {
    const context = this.context;
    const script = context?.component.props.events?.[type];
    if (!context || !script || script.language !== "python" && !script.code?.trim() || !previewScriptsAllowed()) return;
    if (!["javascript", "python"].includes(script.language) || (script.code?.length ?? 0) > 65536) {
      context.error("Input events require Python or JavaScript with at most 65,536 characters.");
      return;
    }
    if (script.language === "python" && context.component.type === "passwordInput") { context.error("Password inputs cannot run automatic Python events."); return; }
    if (context.coordinator && !context.coordinator.accept("input")) return;
    if (this.pending >= 32) {
      context.error("Input event queue is full (32 events). New events were skipped; reduce long-running handlers.");
      return;
    }
    const generation = this.generation;
    const controller = new AbortController(); this.invocations.add(controller);
    const unregister = context.coordinator?.register(() => controller.abort());
    const live = () => !controller.signal.aborted && this.active && this.generation === generation && this.context?.key === context.key && context.isCurrent?.() !== false;
    const fieldKey = context.component.props.fieldKey || context.component.id;
    const event: InputEventPayload = { type, componentId: context.component.id, fieldKey, value, previousValue, origin: "user" };
    const inputs = structuredClone({ ...context.inputs, [fieldKey]: value });
    const parameters = structuredClone(context.parameters);
    this.pending++;
    const finish = context.coordinator?.queued();
    this.queue = this.queue.then(async () => {
      if (!live()) return;
      const app: InputEventApp = {
        signal: controller.signal,
        sendMessage: (messageType, payload, options) => {
          if (!live()) return { messageId: "", accepted: 0 };
          if (!context.sendMessage) throw new Error("Component messaging is unavailable in this context.");
          return context.sendMessage(messageType, payload, options);
        },
        notify: (message) => { if (live()) this.context!.notify(String(message).slice(0, 2500)); },
        state: {
          get: (scope, key) => {
            if (!live()) return undefined;
            if (!this.context!.state) throw new Error("Application state is unavailable in this context.");
            return this.context!.state.get(scope, key);
          },
          set: (scope, key, next) => {
            if (!live()) return;
            if (!this.context!.state) throw new Error("Application state is unavailable in this context.");
            this.context!.state.set(scope, key, next);
          },
          reset: (scope, key) => {
            if (!live()) return;
            if (!this.context!.state) throw new Error("Application state is unavailable in this context.");
            this.context!.state.reset(scope, key);
          },
        },
        setInput: (key, next) => {
          if (!live()) return;
          const current = this.context!;
          const error = inputAssignmentError(current.components, key, next, current.parameters);
          if (error) throw new Error(error);
          if (key === fieldKey) this.currentValue = this.committedValue = next as InputValue;
          // Deliberately bypass change/commit: programmatic assignment does not
          // recursively invoke this or another input's event handlers.
          this.updateInputs({ [key]: next as InputValue });
          current.setInput(key, next as InputValue);
        },
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (script.language === "python") {
          if (!context.python) throw new Error("Python component events are unavailable in this context.");
          const output = await context.python({ family: "input", type }, event, inputs, parameters, controller.signal);
          if (live()) {
            context.clearStatus?.();
            if (output) { context.notify(output); context.coordinator?.report(context.component.id, output, "info"); }
          }
        } else await Promise.race([Promise.resolve(this.execute(script, event, inputs, parameters, app)), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { reject(new Error(`Input event timed out after ${this.timeoutMs} ms; its helpers have been revoked.`)); controller.abort(); }, this.timeoutMs);
        })]);
      } catch (error) {
        if (this.active && this.generation === generation && context.isCurrent?.() !== false) {
          const message = `${type}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2500);
          this.context!.error(message); context.coordinator?.report(context.component.id, message);
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        this.invocations.delete(controller);
      }
    }).finally(() => { this.invocations.delete(controller); unregister?.(); finish?.(); if (this.generation === generation) this.pending--; });
  }
}
