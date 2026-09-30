import { previewScriptsAllowed } from "./previewRequest";
import type { ComponentMessageScope } from "./types";

export interface MessageContext { screenKey: string; instanceKey: string }
export interface ComponentMessageReceipt { messageId: string; accepted: number }
export interface ComponentMessageOptions { scope?: ComponentMessageScope }
export type ComponentMessageSender = (messageType: string, payload?: unknown, options?: ComponentMessageOptions) => ComponentMessageReceipt;
export interface ComponentMessageEvent {
  type: "message"; messageType: string; payload: Readonly<Record<string, unknown>>;
  scope: ComponentMessageScope; messageId: string;
}
interface MessageBudget {
  accept(type: "message"): boolean;
  queued?(): () => void;
  report?(componentId: string, message: string, level?: "error" | "info"): void;
}
interface Listener {
  messageType: string; scope: ComponentMessageScope; context: Readonly<MessageContext>;
  accept: (event: ComponentMessageEvent) => boolean;
}
const scopes: ComponentMessageScope[] = ["instance", "screen", "session"];
const emptyReceipt = (): ComponentMessageReceipt => ({ messageId: "", accepted: 0 });
let busSequence = 0;

export function componentMessageTypeError(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 80 && value.trim() === value && !/\p{Cc}/u.test(value)
    ? null : "Message type must be 1–80 characters without surrounding whitespace or control characters.";
}
const freeze = <T,>(value: T): T => {
  if (value !== null && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
};

/** Validate before serialization; getters, toJSON, holes and non-JSON coercions never run. */
export function componentMessagePayload(payload: unknown): Readonly<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Message payload must be a JSON object.");
  let nodes = 0, minimumBytes = 0;
  const parents = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 16) throw new Error("Message payload is limited to 4,096 values and 16 nested levels.");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      minimumBytes += value.length + 2;
      if (minimumBytes > 65_536) throw new Error("Message payload is limited to 64 KiB of JSON.");
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
    if (typeof value !== "object") throw new Error("Message payload accepts only JSON values with finite, exact numbers.");
    if (parents.has(value)) throw new Error("Message payload cannot contain cycles.");
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) throw new Error("Message payload objects must be plain JSON objects.");
    const keys = Reflect.ownKeys(value);
    if (keys.length > 4097 || keys.some(key => typeof key !== "string")) throw new Error("Message payload has too many fields or non-JSON keys.");
    parents.add(value);
    try {
      if (array) {
        if (value.length > 4096 || keys.length !== value.length + 1) throw new Error("Message arrays must be dense JSON arrays with at most 4,096 values.");
        const result: unknown[] = [];
        for (let index = 0; index < value.length; index++) {
          const field = Object.getOwnPropertyDescriptor(value, String(index));
          if (!field || !Object.hasOwn(field, "value") || !field.enumerable) throw new Error("Message payload cannot contain accessors or sparse arrays.");
          result.push(copy(field.value, depth + 1));
        }
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const key of keys as string[]) {
        const field = Object.getOwnPropertyDescriptor(value, key)!;
        if (!Object.hasOwn(field, "value") || !field.enumerable) throw new Error("Message payload cannot contain accessors or hidden fields.");
        minimumBytes += key.length + 3;
        if (minimumBytes > 65_536) throw new Error("Message payload is limited to 64 KiB of JSON.");
        result[key] = copy(field.value, depth + 1);
      }
      return result;
    } finally { parents.delete(value); }
  };
  const serialized = JSON.stringify(copy(payload, 0));
  if (new TextEncoder().encode(serialized).length > 65_536) throw new Error("Message payload is limited to 64 KiB of JSON.");
  return freeze(JSON.parse(serialized) as Record<string, unknown>);
}

/** One tab/project run. Listener callbacks admit queued work; they never run authored code. */
export class ComponentMessageBus {
  private readonly id = ++busSequence;
  private sequence = 0;
  private epoch = 0;
  private readonly listeners = new Set<Listener>();
  private timestamps: number[] = [];
  private blocked = false;
  private readonly gatewayIds = new Set<string>();
  constructor(private readonly budget?: MessageBudget) {}
  get revision() { return this.epoch; }
  register(messageType: string, scope: ComponentMessageScope, context: MessageContext,
    accept: (event: ComponentMessageEvent) => boolean): () => void {
    const error = componentMessageTypeError(messageType); if (error) throw new Error(error);
    this.validateContext(context);
    if (!scopes.includes(scope)) throw new Error("Message scope must be instance, screen or session.");
    if (typeof accept !== "function") throw new Error("Message registration requires a queue admission callback.");
    if (this.listeners.size >= 4096) throw new Error("A project run can register at most 4,096 component message handlers.");
    const listener: Listener = { messageType, scope, context: Object.freeze({ ...context }), accept };
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  send(messageType: string, payload: unknown = {}, options: ComponentMessageOptions = {}, context: MessageContext): ComponentMessageReceipt {
    if (!previewScriptsAllowed()) return emptyReceipt();
    const error = componentMessageTypeError(messageType); if (error) throw new Error(error);
    this.validateContext(context);
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => key !== "scope"))
      throw new Error("Message options accept only scope.");
    const scope = options.scope ?? "screen";
    if (!scopes.includes(scope)) throw new Error("Message scope must be instance, screen or session.");
    const value = componentMessagePayload(payload);
    const receipt: ComponentMessageReceipt = { messageId: `component-message:${this.id}:${this.epoch}:${++this.sequence}`, accepted: 0 };
    return this.deliver(messageType, value, scope, context, receipt);
  }
  /** Called only by the authenticated runtime stream; preserves correlation and suppresses recent duplicates. */
  receiveSessionMessage(messageId: string, messageType: string, payload: unknown): ComponentMessageReceipt {
    if (!previewScriptsAllowed()) return emptyReceipt();
    if (typeof messageId !== "string" || !messageId || messageId.length > 128 || /\p{Cc}/u.test(messageId)) throw new Error("Invalid gateway message identifier.");
    const error = componentMessageTypeError(messageType); if (error) throw new Error(error);
    const value = componentMessagePayload(payload);
    const receipt = { messageId, accepted: 0 };
    if (this.gatewayIds.has(messageId)) return receipt;
    this.gatewayIds.add(messageId);
    if (this.gatewayIds.size > 512) this.gatewayIds.delete(this.gatewayIds.values().next().value!);
    return this.deliver(messageType, value, "session", undefined, receipt);
  }
  private deliver(messageType: string, value: Readonly<Record<string, unknown>>, scope: ComponentMessageScope,
    context: MessageContext | undefined, receipt: ComponentMessageReceipt): ComponentMessageReceipt {
    const now = Date.now(); this.timestamps = this.timestamps.filter(time => now - time < 1000);
    if (this.blocked || this.timestamps.length >= 512) {
      if (!this.blocked) this.budget?.report?.("messages", "Component messages stopped after 512 sends in one second. Fix the sender loop, then reopen the screen or restart Preview.");
      this.blocked = true; return receipt;
    }
    this.timestamps.push(now);
    const recipients = [...this.listeners].filter(listener => listener.messageType === messageType && listener.scope === scope &&
      (scope === "session" || scope === "screen" && listener.context.screenKey === context?.screenKey ||
        scope === "instance" && listener.context.screenKey === context?.screenKey && listener.context.instanceKey === context?.instanceKey));
    const finish = this.budget?.queued?.();
    try {
      if (recipients.length === 0) this.budget?.accept("message");
      for (const listener of recipients) {
        if (!this.listeners.has(listener)) continue;
        if (this.budget && !this.budget.accept("message")) break;
        const event = freeze<ComponentMessageEvent>({ type: "message", messageType, scope, messageId: receipt.messageId,
          payload: freeze(structuredClone(value)) });
        try { if (listener.accept(event)) receipt.accepted++; }
        catch (error) { this.budget?.report?.("messages", `Message delivery: ${error instanceof Error ? error.message : String(error)}`); }
      }
    } finally { finish?.(); }
    return receipt;
  }
  reset() { this.epoch++; this.listeners.clear(); this.timestamps = []; this.blocked = false; this.gatewayIds.clear(); }
  private validateContext(context: MessageContext) {
    if (!context || typeof context.screenKey !== "string" || !context.screenKey || typeof context.instanceKey !== "string" || !context.instanceKey)
      throw new Error("Messages require a live screen and instance context.");
  }
}

export function createComponentMessageSender(bus: ComponentMessageBus, context: MessageContext,
  isCurrent: () => boolean = () => true): ComponentMessageSender {
  const captured = Object.freeze({ ...context }), revision = bus.revision;
  return (messageType, payload = {}, options = {}) => isCurrent() && bus.revision === revision
    ? bus.send(messageType, payload, options, captured) : emptyReceipt();
}
