import { api } from "./api";
import { validateQueryPropertyParameters } from "./queryPropertyModel";
import type { QueryPropertyApi } from "./queryPropertyModel";
import type { ComponentEventCoordinator } from "./componentEventModel";
import type { NamedQuery, QueryResult, RuntimeParameters } from "./types";

export interface QueryPropertyRequest {
  queryId: string; parameters: RuntimeParameters; scope: "designer" | "runtime"; projectId: string | null; publishedAt?: string;
}
export interface QueryReadSample { result?: QueryResult; loading: boolean; error: string }
type Subscriber = { listener: () => void; poll?: number };
type Entry = {
  key: string; request: QueryPropertyRequest; subscribers: Set<Subscriber>; state: QueryReadSample;
  controller?: AbortController; queued: boolean; rerun: boolean; timer?: ReturnType<typeof setTimeout>; finish?: () => void;
  terminal?: boolean;
  notificationQueued?: boolean;
};
export const queryPropertyRequestKey = (request: QueryPropertyRequest) => JSON.stringify([request.projectId, request.scope, request.publishedAt,
  request.queryId, Object.entries(request.parameters).sort(([a], [b]) => a.localeCompare(b))]);

/** Shared only within one application owner. Never caches across auth sessions. */
export class QueryPropertyCoordinator {
  private entries = new Map<string, Entry>();
  private waiting = new Map<string, Entry>();
  private queue: Entry[] = [];
  private running = 0;
  private catalog = new Map<string, { controller: AbortController; promise: Promise<NamedQuery[]>; users: number; settled: boolean }>();
  private refreshListener = () => this.refresh();
  private unregister: (() => void) | undefined;
  constructor(private readonly events: ComponentEventCoordinator, private readonly request: QueryPropertyApi = api) {}
  private emit(entry: Entry) {
    if (entry.notificationQueued) return; entry.notificationQueued = true;
    queueMicrotask(() => { entry.notificationQueued = false; for (const subscriber of [...entry.subscribers]) subscriber.listener(); });
  }
  peek(key: string): QueryReadSample | undefined { return (this.entries.get(key) ?? this.waiting.get(key))?.state; }
  subscribe(request: QueryPropertyRequest, listener: () => void, poll?: number): () => void {
    const key = queryPropertyRequestKey(request), subscriber = { listener, poll };
    let entry = this.entries.get(key) ?? this.waiting.get(key);
    if (!entry) {
      entry = { key, request: structuredClone(request), subscribers: new Set(), state: { loading: true, error: "" }, queued: false, rerun: false };
      if (this.entries.size >= 128) {
        entry.state = { loading: false, error: "Query property capacity exceeded: at most 128 distinct active reads per application." };
        this.waiting.set(key, entry);
      } else this.entries.set(key, entry);
    }
    if (!this.unregister) {
      this.unregister = this.events.register(() => this.cancelAll());
      if (typeof window !== "undefined") { window.addEventListener("sparkstudio:refresh-data", this.refreshListener); window.addEventListener("sparkstudio:refresh-queries", this.refreshListener); }
    }
    entry.subscribers.add(subscriber);
    if (this.entries.has(key)) {
      if (!entry.controller && !entry.queued && !entry.state.result && !entry.terminal) this.enqueue(entry);
      else this.schedule(entry);
    }
    listener();
    const captured = entry;
    return () => {
      captured.subscribers.delete(subscriber);
      if (captured.subscribers.size) { this.schedule(captured); return; }
      this.disposeEntry(captured); this.entries.delete(key); this.waiting.delete(key); this.promote();
      if (!this.entries.size && !this.waiting.size) {
        this.unregister?.(); this.unregister = undefined;
        for (const catalog of this.catalog.values()) catalog.controller.abort(); this.catalog.clear();
        if (typeof window !== "undefined") { window.removeEventListener("sparkstudio:refresh-data", this.refreshListener); window.removeEventListener("sparkstudio:refresh-queries", this.refreshListener); }
      }
      this.pump();
    };
  }
  capacityError(key: string): string { return this.waiting.has(key) || !this.entries.has(key) && this.entries.size >= 128 ? "Query property capacity exceeded: at most 128 distinct active reads per application." : ""; }
  private promote() {
    for (const [key, entry] of this.waiting) {
      if (this.entries.size >= 128) break;
      this.waiting.delete(key); this.entries.set(key, entry); this.enqueue(entry);
    }
  }
  refresh() { for (const entry of this.entries.values()) { entry.terminal = false; this.enqueue(entry); } }
  private schedule(entry: Entry) {
    if (entry.timer) clearTimeout(entry.timer); entry.timer = undefined;
    if (entry.controller || entry.queued || entry.terminal || this.events.snapshot().breaker) return;
    const intervals = [...entry.subscribers].flatMap(subscriber => subscriber.poll === undefined ? [] : [subscriber.poll]);
    if (intervals.length) entry.timer = setTimeout(() => { entry.timer = undefined; this.enqueue(entry); }, Math.min(...intervals));
  }
  private enqueue(entry: Entry) {
    if (!entry.subscribers.size || this.entries.get(entry.key) !== entry) return;
    if (entry.timer) clearTimeout(entry.timer); entry.timer = undefined;
    const breaker = this.events.snapshot().breaker;
    if (breaker) { entry.state = { loading: false, error: breaker }; this.emit(entry); return; }
    if (entry.controller) { entry.rerun = true; return; }
    if (entry.queued) return;
    entry.queued = true; entry.finish = this.events.queued(); this.queue.push(entry);
    entry.state = { ...entry.state, loading: true, error: "" }; this.emit(entry); this.pump();
  }
  private pump() {
    while (this.running < 8 && this.queue.length) {
      const entry = this.queue.shift()!; entry.queued = false;
      if (!entry.subscribers.size || this.entries.get(entry.key) !== entry) { entry.finish?.(); entry.finish = undefined; continue; }
      void this.run(entry);
    }
  }
  private catalogRead(entry: Entry, signal: AbortSignal): Promise<NamedQuery[]> {
    const { scope, publishedAt, projectId } = entry.request, key = JSON.stringify([projectId, scope, publishedAt]);
    let catalog = this.catalog.get(key);
    if (!catalog) {
      const controller = new AbortController(), prefix = scope === "runtime" ? "/runtime" : "";
      const pending = { controller, promise: Promise.resolve([] as NamedQuery[]), users: 0, settled: false };
      pending.promise = this.request<NamedQuery[]>(`${prefix}/queries${publishedAt === undefined ? "" : `?publishedAt=${encodeURIComponent(publishedAt)}`}`, "GET", undefined, controller.signal)
        .then(value => { pending.settled = true; return value; }, error => { if (this.catalog.get(key) === pending) this.catalog.delete(key); throw error; });
      this.catalog.set(key, pending); catalog = pending;
    }
    const captured = catalog; captured.users++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = () => { if (done) return false; done = true; signal.removeEventListener("abort", abort); captured.users--;
        if (!captured.users && !captured.settled) { captured.controller.abort(); if (this.catalog.get(key) === captured) this.catalog.delete(key); } return true; };
      const abort = () => { if (finish()) reject(new Error("The query read was cancelled.")); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      captured.promise.then(value => { if (finish()) resolve(value); }, error => { if (finish()) reject(error); });
    });
  }
  private async run(entry: Entry) {
    const controller = new AbortController(); entry.controller = controller; this.running++;
    const finish = entry.finish; entry.finish = undefined;
    const timeout = setTimeout(() => controller.abort(new Error("Query property read timed out after 30 seconds.")), 30000);
    const isCurrent = () => entry.controller === controller && this.entries.get(entry.key) === entry && entry.subscribers.size > 0 && !controller.signal.aborted;
    try {
      const { queryId, parameters, scope, publishedAt } = entry.request;
      const catalog = await this.catalogRead(entry, controller.signal);
      validateQueryPropertyParameters(catalog.find(query => query.id === queryId), parameters);
      if (!isCurrent()) return;
      const result = await this.abortable(this.request<QueryResult>(`${scope === "runtime" ? "/runtime" : ""}/queries/${encodeURIComponent(queryId)}/execute`, "POST",
        { parameters, ...(publishedAt === undefined ? {} : { publishedAt }) }, controller.signal), controller.signal);
      if (isCurrent()) { entry.terminal = false; entry.state = { result, loading: false, error: "" }; this.emit(entry); }
    } catch (error) {
      if (entry.controller === controller && this.entries.get(entry.key) === entry && entry.subscribers.size) {
        entry.terminal = Boolean(error && typeof error === "object" && "status" in error && [401, 403, 409].includes(Number(error.status)));
        if (entry.terminal) entry.rerun = false;
        entry.state = { loading: false, error: controller.signal.aborted ? controller.signal.reason instanceof Error ? controller.signal.reason.message : "The query read was cancelled."
          : error instanceof Error ? error.message : String(error) }; this.emit(entry);
      }
    } finally {
      clearTimeout(timeout); this.running--;
      const current = entry.controller === controller;
      if (current) entry.controller = undefined;
      finish?.();
      if (current) {
        if (entry.rerun && !entry.terminal && entry.subscribers.size && this.entries.get(entry.key) === entry) { entry.rerun = false; this.enqueue(entry); }
        else this.schedule(entry);
      }
      this.pump();
    }
  }
  private abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("The query read was cancelled.")); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      pending.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    });
  }
  private disposeEntry(entry: Entry) {
    if (entry.timer) clearTimeout(entry.timer); entry.timer = undefined;
    entry.rerun = false; entry.controller?.abort(); entry.controller = undefined;
    entry.finish?.(); entry.finish = undefined;
    this.queue = this.queue.filter(item => item !== entry); entry.queued = false;
  }
  private cancelAll() {
    for (const entry of this.entries.values()) { this.disposeEntry(entry); entry.state = { loading: false, error: "Automatic query reads stopped. Reopen the screen or restart Preview." }; this.emit(entry); }
    for (const catalog of this.catalog.values()) catalog.controller.abort(); this.catalog.clear();
  }
}
