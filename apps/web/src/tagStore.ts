import type { Tag, RuntimeParameters } from "./types";

export interface TagDelta { upserts: Tag[]; removed: string[] }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function validateTagSamples(value: unknown): Tag[] {
  if (!Array.isArray(value) || value.length > 100000) throw new Error("Invalid gateway tag snapshot.");
  const paths = new Set<string>();
  for (const item of value) {
    if (!record(item) || typeof item.path !== "string" || !item.path || item.path.length > 1024 || typeof item.dataType !== "string"
      || typeof item.quality !== "string" || typeof item.timestamp !== "string" || !Number.isFinite(Date.parse(item.timestamp))
      || item.source !== undefined && typeof item.source !== "string" || !Object.hasOwn(item, "value") || paths.has(item.path)) throw new Error("Invalid gateway tag sample.");
    paths.add(item.path);
  }
  return value as Tag[];
}
export function validateTagDelta(value: unknown): TagDelta {
  if (!record(value) || !Array.isArray(value.removed) || value.removed.length > 100000
    || !value.removed.every(path => typeof path === "string" && path.length > 0 && path.length <= 1024)) throw new Error("Invalid gateway tag delta.");
  const upserts = validateTagSamples(value.upserts);
  const removed = new Set(value.removed);
  if (removed.size !== value.removed.length || upserts.some(item => removed.has(item.path))) throw new Error("Conflicting gateway tag delta.");
  return { upserts, removed: value.removed as string[] };
}
const equal = (a: Tag, b: Tag) => a === b || a.path === b.path && a.timestamp === b.timestamp && a.quality === b.quality && a.dataType === b.dataType && a.source === b.source && JSON.stringify(a.value) === JSON.stringify(b.value);
/** Immutable samples indexed once per frame, with notifications only for affected paths. */
export class TagSnapshotStore {
  private index = new Map<string, Tag>();
  private snapshot: Tag[] = [];
  private listeners = new Set<{ paths: ReadonlySet<string> | null; notify: () => void }>();
  private catalogListeners = new Set<() => void>();
  private catalog: string[] = [];
  values = () => this.snapshot;
  paths = () => this.catalog;
  get = (path: string) => this.index.get(path);
  subscribe = (paths: ReadonlySet<string> | null, notify: () => void) => {
    const listener = { paths, notify }; this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  subscribeCatalog = (notify: () => void) => { this.catalogListeners.add(notify); return () => { this.catalogListeners.delete(notify); }; };
  replace = (value: unknown) => {
    const samples = validateTagSamples(value), next = new Set(samples.map(item => item.path));
    this.apply({ upserts: samples, removed: this.catalog.filter(path => !next.has(path)) });
  };
  delta = (value: unknown) => this.apply(validateTagDelta(value));
  private apply(delta: TagDelta) {
    const changed = new Set<string>(); let membership = false;
    for (const path of delta.removed) if (this.index.delete(path)) { changed.add(path); membership = true; }
    for (const sample of delta.upserts) {
      const old = this.index.get(sample.path);
      if (!old || !equal(old, sample)) {
        this.index.set(sample.path, sample); changed.add(sample.path); if (!old) membership = true;
      }
    }
    if (!changed.size) return;
    if (membership) this.catalog = [...this.index.keys()].sort();
    this.snapshot = this.catalog.map(path => this.index.get(path)!);
    if (membership) for (const notify of this.catalogListeners) notify();
    for (const listener of this.listeners) if (listener.paths === null || [...changed].some(path => listener.paths!.has(path))) listener.notify();
  }
}

/** Include indirect placeholders and nested template references without watching unrelated paths. */
export function tagDependencyPaths(document: unknown, _parameters: RuntimeParameters, available: readonly string[]): ReadonlySet<string> | null {
  const patterns = new Set<string>(); let dynamic = false;
  const inspect = (value: unknown, depth = 0) => {
    if (depth > 48 || value === null) return;
    if (Array.isArray(value)) { value.forEach(child => inspect(child, depth + 1)); return; }
    if (!record(value)) return;
    if (record(value.bindings) && Object.hasOwn(value.bindings, "tagPath") || record(value.queryBindings) && Object.hasOwn(value.queryBindings, "tagPath")) dynamic = true;
    for (const [key, child] of Object.entries(value)) {
      if ((key === "tagPath" || key === "path" && value.kind === "tag") && typeof child === "string") patterns.add(child);
      else inspect(child, depth + 1);
    }
  };
  inspect(document);
  if (dynamic) return null; // A computed tag address can depend on arbitrary state/query output.
  const result = new Set<string>();
  for (const pattern of patterns) {
    // Nested rows can override parent parameters, so include all catalog matches.
    const resolved = pattern;
    if (!resolved.includes("{")) { result.add(resolved); continue; }
    const matcher = new RegExp(`^${resolved.split(/(\{[^{}]+\})/g).map(part => part.startsWith("{") ? ".+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("")}$`);
    available.forEach(path => { if (matcher.test(path)) result.add(path); });
  }
  return result;
}

const indexed = new WeakMap<Tag[], Map<string, Tag>>();
export function tagByPath(tags: Tag[], path: string): Tag | undefined {
  let index = indexed.get(tags);
  if (!index) { index = new Map(tags.map(tag => [tag.path, tag])); indexed.set(tags, index); }
  return index.get(path);
}
