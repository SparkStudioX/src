import type { Asset, CanvasComponent, NamedQuery, Project, Screen, Tag } from "./types";
import type { ScriptSearchResource } from "./projectSearch";

export interface DesignerSnapshot {
  project: Project; token: string; documentId: string; documentKind: "screen" | "template";
  selectedComponentIds: string[]; queries: NamedQuery[]; scripts: ScriptSearchResource[]; tags: Tag[]; assets: Asset[];
  unsavedChanges?: boolean;
}
export interface DesignerBridge {
  snapshot(): DesignerSnapshot;
  validate(project: Project, signal: AbortSignal): Promise<unknown>;
  commit(project: Project, expectedToken: string): void;
  select(documentId: string, kind: "screen" | "template", ids: string[]): void;
  save(expectedToken: string, signal: AbortSignal): Promise<unknown>;
  preview(signal: AbortSignal): Promise<unknown>;
  capture?(signal: AbortSignal): Promise<unknown>;
}
export type ToolArgs = Record<string, unknown>;
export type DesignerEdit = (snapshot: DesignerSnapshot, args: ToolArgs) => Project;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export function safeValue(value: unknown, depth = 0): void {
  if (depth > 30) throw new Error("Tool input is too deeply nested.");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Numbers must be finite.");
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error("Unsafe property name.");
    safeValue(child, depth + 1);
  }
}
export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  safeValue(value);
  return structuredClone(value) as Record<string, unknown>;
}
export function textArg(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new Error(`Supply ${key}.`);
  return value;
}
export function idsArg(args: ToolArgs, key = "componentIds"): string[] {
  const value = args[key];
  if (!Array.isArray(value) || !value.length || value.length > 500 || value.some(id => typeof id !== "string")) throw new Error(`Supply 1–500 ${key}.`);
  return [...new Set(value as string[])];
}
export function ownerKind(args: ToolArgs): "screen" | "template" {
  if (args.documentKind !== "screen" && args.documentKind !== "template") throw new Error("Specify documentKind: screen or template.");
  return args.documentKind;
}
export function documentFor(snapshot: DesignerSnapshot, args: ToolArgs): Screen {
  const kind = ownerKind(args), id = textArg(args, "documentId");
  const found = (kind === "screen" ? snapshot.project.screens : snapshot.project.templates ?? []).find(item => item.id === id);
  if (!found) throw new Error("Document no longer exists.");
  return found;
}
export function componentFor(snapshot: DesignerSnapshot, args: ToolArgs): CanvasComponent {
  const component = documentFor(snapshot, args).components.find(item => item.id === textArg(args, "componentId"));
  if (!component) throw new Error("Component no longer exists.");
  return component;
}
export function withDocument(snapshot: DesignerSnapshot, args: ToolArgs, update: (document: Screen) => Screen): Project {
  const document = documentFor(snapshot, args), updated = update(structuredClone(document));
  if (ownerKind(args) === "screen") return { ...snapshot.project, screens: snapshot.project.screens.map(item => item.id === document.id ? updated : item) };
  return { ...snapshot.project, templates: (snapshot.project.templates ?? []).map(item => item.id === document.id ? { ...item, ...updated } : item) };
}
export function withComponent(snapshot: DesignerSnapshot, args: ToolArgs, update: (component: CanvasComponent) => CanvasComponent): Project {
  const component = componentFor(snapshot, args);
  return withDocument(snapshot, args, document => ({ ...document, components: document.components.map(item => item.id === component.id ? update(item) : item) }));
}
export function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const invalid = Object.keys(value).filter(key => !allowed.includes(key));
  if (invalid.length) throw new Error(`Unsupported fields: ${invalid.join(", ")}.`);
}
export function redactDesigner(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDesigner);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const output = Object.fromEntries(Object.entries(source).filter(([key]) => !/password|secret|credential|apiKey|accessToken/i.test(key)).map(([key, child]) => [key, redactDesigner(child)]));
  if (source.type === "passwordInput" && output.props && typeof output.props === "object") {
    const props = output.props as Record<string, unknown>;
    delete props.value; delete props.defaultValue; delete props.text;
  }
  return output;
}
