import { evaluateComponentBindings } from "./propertyBindings";
import type { BindingContext } from "./propertyBindings";
import type { ComponentEventStatus } from "./componentEventModel";
import type { SearchEntry, SearchTarget } from "./projectSearch";
import type { BindingTarget, Project, Screen } from "./types";

export type DiagnosticCategory = "binding" | "query" | "reference" | "quality" | "browser-event";
export interface DesignerDiagnostic {
  id: string; category: DiagnosticCategory; level: "error" | "warning" | "info";
  location: string; message: string; recordedAt?: string; target?: SearchTarget;
}
export interface DesignerDiagnosticOptions {
  project: Project; document?: Screen; ownerKind: "screen" | "template";
  context: BindingContext; searchEntries?: SearchEntry[]; events?: ComponentEventStatus;
}
export interface DesignerDiagnosticSnapshot {
  capturedAt: string; documentName: string; rows: DesignerDiagnostic[]; omitted: number;
  componentsChecked: number; bindingsChecked: number; queriesNotCaptured: number; tagsChecked: number;
  referencesChecked: boolean; communicationLost: boolean;
}

/** A local diagnostic snapshot, never a query/script executor or nested-form simulation. */
export function collectDesignerDiagnostics(options: DesignerDiagnosticOptions, capturedAt = new Date().toISOString()): DesignerDiagnosticSnapshot {
  const { project, document, context, ownerKind, searchEntries, events } = options;
  const rows: DesignerDiagnostic[] = [];
  let total = 0, bindingsChecked = 0, queriesNotCaptured = 0;
  const add = (row: DesignerDiagnostic) => { total++; if (rows.length < 1000) rows.push(row); };
  const root = document ? `${ownerKind === "template" ? "Templates" : "Screens"} / ${document.name}` : "No open document";
  for (const component of document?.components ?? []) {
    const location = `${root} / ${component.id}`;
    const target: SearchTarget = { kind: ownerKind, id: document!.id, componentId: component.id };
    const evaluated = evaluateComponentBindings(component, { ...context, components: document!.components });
    bindingsChecked += Object.keys(component.props.bindings ?? {}).length;
    for (const [property, message] of Object.entries(evaluated.errors)) {
      const query = Object.hasOwn(component.props.queryBindings ?? {}, property);
      const loading = query && context.queryProperties?.[component.id]?.[property as BindingTarget]?.status === "loading";
      add({ id: JSON.stringify([ownerKind, document!.id, component.id, property]), category: query ? "query" : "binding", level: loading ? "info" : "error",
        location: `${location} · ${property}`, message: message!, target: { ...target, property: `props.${query ? "queryBindings" : "bindings"}.${property}` } });
    }
    for (const property of Object.keys(component.props.queryBindings ?? {})) {
      const sample = context.queryProperties?.[component.id]?.[property as BindingTarget];
      if (!sample || sample.status === "idle") {
        queriesNotCaptured++;
        add({ id: JSON.stringify(["query-not-captured", ownerKind, document!.id, component.id, property]), category: "query", level: "info",
          location: `${location} · ${property}`, message: "Query sample not captured in this snapshot. Inspect this component in Preview; opening Diagnostics does not run its query.",
          target: { ...target, property: `props.queryBindings.${property}` } });
      }
    }
    if (component.props.dataSource) {
      queriesNotCaptured++;
      add({ id: JSON.stringify(["dataset-not-captured", ownerKind, document!.id, component.id]), category: "query", level: "info",
        location: `${location} · Dataset`, message: "Dataset sample is owned by this form. Inspect the chart in Preview; opening Diagnostics does not execute its read query.",
        target: { ...target, property: "props.dataSource" } });
    }
  }
  for (const entry of searchEntries ?? []) if (entry.missing && entry.reference && !entry.textOnly)
    add({ id: `reference:${entry.id}`, category: "reference", level: "error", location: `${entry.location} · ${entry.label}`,
      message: `Missing ${entry.reference.kind} reference: ${entry.reference.id}`, target: { ...entry.target } });
  if (context.communicationLost) add({ id: "communication", category: "quality", level: "error", location: "Gateway connection",
    message: "Gateway communication is lost. Retained tag snapshots must not be treated as current live values." });
  for (const tag of context.tags) {
    if (/^good(?:$|[_ (])/i.test(tag.quality)) continue;
    add({ id: `tag:${tag.path}`, category: "quality", level: "warning", location: tag.path,
      message: `Quality: ${tag.quality || "Unknown"}. Source timestamp: ${tag.timestamp || "Unavailable"}. Values are omitted.` });
  }
  if (events?.breaker) add({ id: "event-breaker", category: "browser-event", level: "error", location: "Current preview event coordinator", message: events.breaker });
  for (const event of events?.diagnostics ?? []) {
    const matches = [
      ...project.screens.map(item => ({ item, kind: "screen" as const })),
      ...(project.templates ?? []).map(item => ({ item, kind: "template" as const })),
    ].filter(({ item }) => item.components.some(component => component.id === event.componentId));
    const match = matches.length === 1 ? matches[0] : undefined;
    add({ id: `event:${event.id}`, category: "browser-event", level: event.level,
      location: match ? `${match.kind === "screen" ? "Screens" : "Templates"} / ${match.item.name} / ${event.componentId}` : `${event.componentId} · owner not uniquely identified`,
      message: event.message, recordedAt: event.recordedAt,
      ...(match ? { target: { kind: match.kind, id: match.item.id, componentId: event.componentId, property: "props.componentEvents" } } : {}) });
  }
  return { capturedAt, documentName: document?.name ?? "No open document", rows, omitted: Math.max(0, total - rows.length),
    componentsChecked: document?.components.length ?? 0, bindingsChecked, queriesNotCaptured, tagsChecked: context.tags.length,
    referencesChecked: searchEntries !== undefined, communicationLost: Boolean(context.communicationLost) };
}

export function filterDesignerDiagnostics(rows: DesignerDiagnostic[], category: "all" | DiagnosticCategory, term: string, level = "all"): DesignerDiagnostic[] {
  const words = term.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return rows.filter(row => (category === "all" || row.category === category) && (level === "all" || row.level === level)
    && words.every(word => `${row.location} ${row.message}`.toLocaleLowerCase().includes(word)));
}
