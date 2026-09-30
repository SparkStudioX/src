import { api, scriptFailureMessage } from "./api";
import { applyPythonUiResult, pythonUiRequest } from "./pythonUiModel";
import { instanceRequestScope } from "./templateModel";
import { requirePreviewScriptPermission } from "./previewRequest";
import type { CanvasComponent, ComponentInteractionEventType, InputValues, InstanceAction, PopupState, PythonUiAction, RuntimeParameters, ScriptResult } from "./types";

export type PythonEventHandler = { family: "input"; type: "change" | "commit" }
  | { family: "interaction"; type: ComponentInteractionEventType }
  | { family: "propertyChange" } | { family: "message"; handlerId: string }
  | { family: "lifecycle"; type: "mount" | "unmount" };
export const isPythonUnmount = (handler: PythonEventHandler) => handler.family === "lifecycle" && handler.type === "unmount";
export type EventOrigin = "user" | "binding" | "script" | "input" | "configuration";
export interface PythonEventInvocation {
  eventHandler: PythonEventHandler;
  event: object;
  inputs: InputValues;
  parameters: RuntimeParameters;
  uiAction: PythonUiAction;
  signal: AbortSignal;
}
export type PythonEventTransport = (component: CanvasComponent, invocation: PythonEventInvocation, instance?: InstanceAction) => Promise<ScriptResult>;
export type PythonEventRunner = (handler: PythonEventHandler, event: object, inputs: InputValues,
  parameters: RuntimeParameters, signal: AbortSignal) => Promise<string>;
export interface PythonEventOwner {
  scope: "runtime" | "designer";
  screenId?: string;
  templateId?: string;
  parameters: RuntimeParameters;
  publishedAt?: string;
  popupOrigin?: PopupState["origin"];
}

/** Only saved handler identities cross the wire; authored Python source stays on the gateway. */
export function pythonEventRequest(owner: PythonEventOwner, componentId: string, invocation: PythonEventInvocation, instance?: InstanceAction) {
  if (Boolean(owner.screenId) === Boolean(owner.templateId) || owner.scope === "runtime" && owner.templateId)
    throw new Error("A Python event needs exactly one live screen or Preview template owner.");
  const collection = owner.templateId ? "templates" : "screens", id = owner.templateId ?? owner.screenId!;
  return {
    path: `/${owner.scope === "runtime" ? "runtime" : "preview"}/${collection}/${encodeURIComponent(id)}/components/${encodeURIComponent(componentId)}/events`,
    body: { eventHandler: invocation.eventHandler, event: invocation.event, inputs: invocation.inputs,
      parameters: owner.parameters, ...(owner.scope === "runtime" ? { publishedAt: owner.publishedAt } : {}),
      ...(owner.popupOrigin ? { popupOrigin: owner.popupOrigin } : {}), ...instanceRequestScope(instance),
      ...(isPythonUnmount(invocation.eventHandler) ? { ui: invocation.uiAction.ui } : pythonUiRequest(invocation.uiAction)) },
  };
}

export function runSavedPythonEvent(owner: PythonEventOwner, component: CanvasComponent, invocation: PythonEventInvocation, instance?: InstanceAction) {
  requirePreviewScriptPermission();
  if (!isPythonUnmount(invocation.eventHandler) && instance?.isCurrent?.() === false || invocation.signal.aborted) throw new Error("The Python event owner has closed.");
  const request = pythonEventRequest(owner, component.id, invocation, instance);
  return api<ScriptResult>(request.path, "POST", request.body, invocation.signal);
}

export function withoutPasswordInputs(components: CanvasComponent[], values: InputValues): InputValues {
  const forbidden = new Set(components.filter(component => component.type === "passwordInput").map(component => component.props.fieldKey || component.id));
  return structuredClone(Object.fromEntries(Object.entries(values).filter(([key]) => !forbidden.has(key))));
}

/** Inputs may arrive while an earlier owner's cleanup delays the next mount. */
export class PythonMountBarrier {
  private resolve!: () => void;
  private readonly ready = new Promise<void>(resolve => { this.resolve = resolve; });
  finish() { this.resolve(); }
  async wait(signal: AbortSignal) {
    signal.throwIfAborted();
    let abort: (() => void) | undefined;
    try {
      await Promise.race([this.ready, new Promise<never>((_, reject) => {
        abort = () => reject(new Error("The Python event owner has closed before mount completed."));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
      signal.throwIfAborted();
    } finally { if (abort) signal.removeEventListener("abort", abort); }
  }
}

/** All Python event families on one component share this bounded FIFO. */
export class PythonComponentEventQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  // The gateway enforces two seconds of execution. Allow one additional second
  // for connection scheduling, response delivery and browser task scheduling.
  constructor(private readonly timeoutMs = 3000) {}
  run(signal: AbortSignal, run: (signal: AbortSignal) => Promise<string>): Promise<string> {
    if (this.pending >= 32) return Promise.reject(new Error("Python event queue is full (32 events). New events were skipped."));
    this.pending++;
    const result = this.tail.then(async () => {
      signal.throwIfAborted();
      const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        return await Promise.race([run(combined), new Promise<never>((_, reject) => {
          abort = () => reject(new Error("The Python event owner has closed."));
          combined.addEventListener("abort", abort, { once: true });
          if (combined.aborted) abort();
          timer = setTimeout(() => { reject(new Error(`Python event response timed out after ${this.timeoutMs} ms; its UI effects have been revoked.`)); controller.abort(); }, this.timeoutMs);
        })]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (abort) combined.removeEventListener("abort", abort);
      }
    });
    this.tail = result.then(() => {}, () => {}).finally(() => { this.pending--; });
    return result;
  }
}

/** Data writes are already gateway-side; local effects are atomic and lifetime checked. */
export async function completePythonEvent(invoke: () => Promise<ScriptResult>, action: PythonUiAction,
  signal: AbortSignal, refresh: () => void): Promise<string> {
  const result = await invoke();
  if (result.success) refresh();
  if (signal.aborted || !action.isCurrent()) return "";
  if (!result.success) throw new Error(scriptFailureMessage(result.stderr));
  applyPythonUiResult(action, result);
  const output = result.stdout?.trim() ?? "";
  const message = result.result && typeof result.result === "object" && "message" in result.result
    ? String(result.result.message).trim() : "";
  return (message && message !== output ? [output, message].filter(Boolean).join("\n") : output).slice(0, 2500);
}
