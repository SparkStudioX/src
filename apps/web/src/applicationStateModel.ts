import type { InputValue, RuntimeParameters, RuntimeStateApi, RuntimeStateValues, StateDefinitions, StateScope } from "./types";
import { ComponentEventCoordinator } from "./componentEventModel";

const own = (value: object, key: string) => Object.hasOwn(value, key);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const reserved = new Set(["__proto__", "constructor", "prototype"]);
export const stateKeyValid = (key: string) => typeof key === "string" && key.trim() === key && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) && !reserved.has(key);
const scalarValid = (type: unknown, value: unknown) => typeof value === type && (type === "string" ? (value as string).length <= 4096
  : type === "boolean" || type === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));

export function stateDefinitionsError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!object(value) || Object.keys(value).length > 64) return "State needs a map of at most 64 declared values.";
  for (const [key, definition] of Object.entries(value)) {
    if (!stateKeyValid(key)) return "State names need 1–64 letters, digits or underscores, starting with a letter or underscore, and cannot use reserved names.";
    if (!object(definition) || Object.keys(definition).length !== 2 || !own(definition, "type") || !own(definition, "value") || !["string", "number", "boolean"].includes(definition.type as string)) return `State '${key}' needs only a type and default value.`;
    if (!scalarValid(definition.type, definition.value)) return `State '${key}' default must match its type: text up to 4096 characters, an exact finite number, or true/false.`;
  }
  return null;
}
export function stateDefaults(definitions?: StateDefinitions): RuntimeParameters {
  const error = stateDefinitionsError(definitions); if (error) throw new Error(error);
  return Object.fromEntries(Object.entries(definitions ?? {}).map(([key, definition]) => [key, definition.value]));
}

export interface StateScopeHandle {
  readonly key: string;
  readonly sourceKey: string;
  readonly generation: number;
  readonly definitions: StateDefinitions;
  values: RuntimeParameters;
  revisions: Record<string, number>;
}
export interface StateContext {
  key: string; values: RuntimeStateValues; api: RuntimeStateApi;
  screenScope: StateScopeHandle;
  instanceScope?: StateScopeHandle;
  ownerScopes: StateScopeHandle[];
  isCurrent: () => boolean;
  /** Internal binding stamp, including an explicit reset to an unchanged value. */
  revision: (scope: StateScope, key: string) => number | undefined;
}
interface ScopeLifetime { screenGeneration: number; epoch: number }
let storeSequence = 0;

/** One browser project run; no storage, gateway writes or user identity is held here. */
export class ApplicationStateStore {
  readonly componentEvents = new ComponentEventCoordinator();
  private readonly id = ++storeSequence;
  private generation = 0;
  private screenGeneration = 0;
  private lifetime = 0;
  private active = true;
  private sequence = 0;
  private projectKey = "";
  private definitions: StateDefinitions = {};
  private session: RuntimeParameters = {};
  private sessionRevisions: Record<string, number> = {};
  private main: StateScopeHandle | undefined;
  // React may abandon a render before its cleanup exists. Scope owners retain
  // committed handles; the store must not strongly retain discarded rows.
  private scopes = new WeakSet<StateScopeHandle>();
  private handles = new WeakMap<StateScopeHandle, ScopeLifetime>();
  private listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  suspend() { this.active = false; this.lifetime++; }
  resume() { this.active = true; }

  configure(projectKey: string, definitions?: StateDefinitions) {
    const key = JSON.stringify([projectKey, definitions ?? {}]);
    if (key === this.projectKey) return;
    const defaults = stateDefaults(definitions);
    this.projectKey = key; this.generation++; this.scopes = new WeakSet(); this.main = undefined;
    this.componentEvents.reset();
    this.definitions = structuredClone(definitions ?? {}); this.session = Object.freeze(defaults);
    this.sessionRevisions = {};
  }
  activateScreen(documentId: string, definitions?: StateDefinitions): StateScopeHandle {
    const sourceKey = JSON.stringify([documentId, definitions ?? {}]);
    if (this.main?.sourceKey === sourceKey && this.scopes.has(this.main)) return this.main;
    // Validate first so a malformed draft does not destroy the active screen.
    stateDefaults(definitions);
    this.screenGeneration++;
    this.componentEvents.reset();
    this.scopes = new WeakSet();
    this.main = this.createScope(documentId, definitions);
    return this.main;
  }
  createScope(documentId: string, definitions?: StateDefinitions): StateScopeHandle {
    const values = Object.freeze(stateDefaults(definitions));
    const scope = { key: `${this.id}:${this.generation}:${++this.sequence}`, sourceKey: JSON.stringify([documentId, definitions ?? {}]),
      generation: this.generation, definitions: structuredClone(definitions ?? {}), values, revisions: {} };
    this.handles.set(scope, { screenGeneration: this.screenGeneration, epoch: 0 });
    this.scopes.add(scope); return scope;
  }
  closeScope(scope: StateScopeHandle) {
    if (this.scopes.delete(scope)) this.handles.get(scope)!.epoch++;
  }
  // Effect setup may be repeated by React StrictMode without a new render.
  resumeScope(scope: StateScopeHandle) {
    const handle = this.handles.get(scope);
    if (handle && scope.generation === this.generation && handle.screenGeneration === this.screenGeneration && !this.scopes.has(scope)) {
      this.scopes.add(scope);
      for (const listener of [...this.listeners]) listener();
    }
  }

  context(scope: StateScopeHandle, instance?: StateScopeHandle, ancestors: StateScopeHandle[] = []): StateContext {
    const lifetime = this.lifetime;
    const ownerScopes = [...new Set([scope, ...ancestors, ...(instance ? [instance] : [])])];
    const captures = ownerScopes.map(owner => ({ owner, handle: this.handles.get(owner), epoch: this.handles.get(owner)?.epoch }));
    // Every helper, including writes to shared screen/session state, expires
    // when any owning template or popup is disposed. A child never revives it.
    const live = () => this.active && this.lifetime === lifetime && captures.every(({ owner, handle, epoch }) =>
      handle?.epoch === epoch && handle?.screenGeneration === this.screenGeneration && owner.generation === this.generation && this.scopes.has(owner));
    const local = (target: StateScope): StateScopeHandle => {
      if (target === "instance" && !instance) throw new Error("Instance state is unavailable outside a template instance.");
      return target === "instance" ? instance! : scope;
    };
    const definitions = (target: StateScope) => {
      if (target !== "session" && target !== "screen" && target !== "instance") throw new Error("State scope must be session, screen or instance.");
      return target === "session" ? this.definitions : local(target).definitions;
    };
    const declared = (target: StateScope, key: string) => {
      const values = definitions(target);
      if (!stateKeyValid(key) || !own(values, key)) throw new Error(`${target === "session" ? "Session" : target === "screen" ? "Screen" : "Instance"} state '${String(key)}' is not declared.`);
      return values[key];
    };
    const publish = (target: StateScope, values: RuntimeParameters) => {
      if (target === "session") this.session = Object.freeze(values); else local(target).values = Object.freeze(values);
      for (const listener of [...this.listeners]) listener();
    };
    const touch = (target: StateScope, keys: string[]) => {
      const revisions = target === "session" ? this.sessionRevisions : local(target).revisions;
      for (const key of keys) revisions[key] = (revisions[key] ?? 0) + 1;
    };
    const api: RuntimeStateApi = {
      get: (target, key) => { if (!live()) return undefined; declared(target, key); return (target === "session" ? this.session : local(target).values)[key]; },
      set: (target, key, value) => {
        if (!live()) return;
        const declaration = declared(target, key);
        if (!scalarValid(declaration.type, value)) throw new Error(`State '${key}' requires ${declaration.type === "number" ? "an exact finite number" : declaration.type === "boolean" ? "true or false" : "text up to 4096 characters"}.`);
        const values = target === "session" ? this.session : local(target).values;
        if (!Object.is(values[key], value)) { touch(target, [key]); publish(target, { ...values, [key]: value as InputValue }); }
      },
      reset: (target, key) => {
        if (!live()) return;
        const values = target === "session" ? this.session : local(target).values;
        const next = key === undefined ? stateDefaults(definitions(target)) : { ...values, [key]: declared(target, key).value };
        // Reset also discards invalid bound-input drafts whose last accepted
        // value already equals the default. Ordinary equal sets remain silent.
        touch(target, key === undefined ? Object.keys(next) : [key]);
        publish(target, next);
      },
    };
    return { key: instance ? `${scope.key}/${instance.key}` : scope.key, screenScope: scope, instanceScope: instance, ownerScopes, isCurrent: live,
      values: { session: this.session, screen: scope.values, ...(instance ? { instance: instance.values } : {}) }, api,
      revision: (target, key) => { if (!live()) return undefined; declared(target, key); return (target === "session" ? this.sessionRevisions : local(target).revisions)[key] ?? 0; } };
  }
}
