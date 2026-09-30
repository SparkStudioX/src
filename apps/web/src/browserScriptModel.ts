import type { RuntimeStateApi } from "./types";
import type { ComponentMessageSender } from "./componentMessageModel";

export interface BrowserResource {
  id: string;
  name: string;
  code: string;
  event: "startup" | "screenOpen";
  parameters: Record<string, unknown>;
}
export interface BrowserPublication {
  applicationPublishedAt?: string;
  revision?: number;
  publishedAt?: string | null;
  resources: BrowserResource[];
}
export interface BrowserScriptContext {
  applicationPublishedAt?: string;
  sendMessage?: ComponentMessageSender;
  projectKey: string;
  screenId: string;
  screenName: string;
  notify: (message: string) => void;
  navigate: (id: string) => void;
  refresh: () => void;
  state?: RuntimeStateApi;
  scopeKey?: string;
}
export interface BrowserEvent {
  type: BrowserResource["event"];
  screenId: string;
  screenName: string;
  revision: number;
}
export interface BrowserScriptApp {
  sendMessage: ComponentMessageSender;
  notify: (message: unknown) => void;
  navigate: (id: string) => void;
  refresh: () => void;
  state: RuntimeStateApi;
}
export type BrowserExecutor = (
  resource: BrowserResource,
  event: BrowserEvent,
  parameters: Record<string, unknown>,
  app: BrowserScriptApp,
  session: Record<string, unknown>,
) => unknown | Promise<unknown>;

/** Discards stale queues and helper effects; it does not sandbox trusted JavaScript. */
export class BrowserScriptLifecycle {
  private active = false;
  private generation = 0;
  private publicationKey = "";
  private screenKey = "";
  private context: BrowserScriptContext | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly session: Record<string, unknown> = {};

  constructor(private readonly execute: BrowserExecutor) {}

  activate() { this.active = true; }
  setContext(context: BrowserScriptContext | null) {
    const previous = this.context;
    if (Boolean(previous) !== Boolean(context) || previous?.projectKey !== context?.projectKey ||
        previous?.screenId !== context?.screenId || previous?.scopeKey !== context?.scopeKey) {
      // Invalidate before effects run, including an A -> B -> A transition.
      this.generation++;
      this.screenKey = "";
      this.queue = Promise.resolve();
    }
    this.context = context;
  }
  deactivate() {
    this.active = false;
    this.generation++;
    this.publicationKey = "";
    this.screenKey = "";
    this.queue = Promise.resolve();
  }
  whenIdle() { return this.queue; }

  update(publication: BrowserPublication | null) {
    const context = this.context;
    if (!this.active || !context || publication?.revision === undefined ||
        context.applicationPublishedAt && context.applicationPublishedAt !== publication.applicationPublishedAt) return;
    const key = JSON.stringify([publication.revision, publication.publishedAt, publication.applicationPublishedAt]);
    const screenKey = JSON.stringify([key, context.projectKey, context.screenId, context.scopeKey]);
    const startup = key !== this.publicationKey;
    const screenOpen = screenKey !== this.screenKey;
    if (!startup && !screenOpen) return;
    this.publicationKey = key;
    this.screenKey = screenKey;
    const generation = ++this.generation;
    // An old asynchronous handler cannot block a new screen or publication forever.
    this.queue = Promise.resolve();
    const live = () => this.active && this.generation === generation &&
      this.context?.projectKey === context.projectKey && this.context.screenId === context.screenId &&
      this.context.scopeKey === context.scopeKey;
    const types: BrowserResource["event"][] = [...(startup ? ["startup" as const] : []), ...(screenOpen ? ["screenOpen" as const] : [])];
    for (const type of types) {
      for (const resource of publication.resources.filter(item => item.event === type)) {
        const event: BrowserEvent = { type, screenId: context.screenId, screenName: context.screenName, revision: publication.revision };
        this.queue = this.queue.then(async () => {
          if (!live()) return;
          const app: BrowserScriptApp = {
            sendMessage: (messageType, payload, options) => {
              if (!live()) return { messageId: "", accepted: 0 };
              if (!context.sendMessage) throw new Error("Component messaging is unavailable in this context.");
              return context.sendMessage(messageType, payload, options);
            },
            notify: message => { if (live()) this.context!.notify(String(message).slice(0, 2500)); },
            navigate: id => { if (live()) this.context!.navigate(id); },
            refresh: () => { if (live()) this.context!.refresh(); },
            state: {
              get: (scope, name) => {
                if (!live()) return undefined;
                if (!this.context!.state) throw new Error("Application state is unavailable in this context.");
                return this.context!.state.get(scope, name);
              },
              set: (scope, name, value) => {
                if (!live()) return;
                if (!this.context!.state) throw new Error("Application state is unavailable in this context.");
                this.context!.state.set(scope, name, value);
              },
              reset: (scope, name) => {
                if (!live()) return;
                if (!this.context!.state) throw new Error("Application state is unavailable in this context.");
                this.context!.state.reset(scope, name);
              },
            },
          };
          try {
            await this.execute(resource, event, structuredClone(resource.parameters || {}), app, this.session);
          } catch (error) {
            if (live()) this.context!.notify(`${resource.name}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2500));
          }
        });
      }
    }
  }
}
