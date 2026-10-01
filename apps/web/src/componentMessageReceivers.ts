import { componentMessageTypeError } from "./componentMessageModel";
import type { CanvasComponent, ComponentMessageHandler, ComponentMessageScope, Project, Screen, Template } from "./types";

export interface ComponentMessageReceiver {
  key: string;
  documentId: string;
  documentName: string;
  documentKind: "screen" | "popup" | "template";
  componentId: string;
  componentName: string;
  componentType: CanvasComponent["type"];
  handlerId: string;
  messageType: string;
  scope: ComponentMessageScope;
  language: "javascript" | "python";
  applicability: "possible" | "elsewhere" | "unplaced" | "uninspected";
  reason: string;
  locations: string[];
  repeated: boolean;
  /** Source is configured; this does not validate its syntax or execution. */
  ready: boolean;
}
export interface ComponentMessageReceiverOptions {
  project?: Pick<Project, "screens" | "templates">;
  document: Screen;
  documentKind: "screen" | "template";
  messageType: string;
  scope: ComponentMessageScope;
  override?: { componentId: string; handlers: ComponentMessageHandler[] };
}
export interface ComponentMessageReceiverDiscovery {
  receivers: ComponentMessageReceiver[];
  messageTypes: string[];
  truncated: boolean;
  notes: string[];
}

const maximumDefinitions = 4096, maximumMessageTypes = 512, maximumPlacementVisits = 20000, maximumLocations = 8, maximumTemplateDepth = 4;
const componentName = (component: CanvasComponent) => typeof component.props.text === "string" && component.props.text.trim()
  ? component.props.text.trim().slice(0, 200) : component.id;
const documentKey = (kind: "screen" | "template", id: string) => JSON.stringify([kind, id]);
interface Document { key: string; kind: "screen" | "popup" | "template"; value: Screen }
interface Placement { root: string; path: string; repeated: boolean; conditions: string[] }
interface IndexedReceiver extends Omit<ComponentMessageReceiver, "applicability" | "reason" | "locations" | "repeated"> { placements: Placement[] }

/** Inspect authored definitions only. The runtime bus remains the authority for
 * mounted listeners, active panes, publication, and delivery admission. */
export function discoverComponentMessageReceivers(options: ComponentMessageReceiverOptions): ComponentMessageReceiverDiscovery {
  const notes = ["Authored receivers are shown; only mounted listeners receive messages."];
  const screens = new Map<string, Screen>((options.project?.screens ?? []).map(value => [value.id, value]));
  const templates = new Map<string, Template>((options.project?.templates ?? []).map(value => [value.id, value]));
  if (options.documentKind === "template") templates.set(options.document.id, options.document as Template);
  else screens.set(options.document.id, options.document);
  const currentKey = documentKey(options.documentKind, options.document.id);
  // Native action Apply trims the sender value; preview that eventual value.
  // Authored receiver names still have to pass exact runtime validation.
  const selectedMessageType = options.messageType.trim();
  const documents: Document[] = [
    ...[...screens.values()].map(value => ({ key: documentKey("screen", value.id), kind: value.kind === "popup" ? "popup" as const : "screen" as const, value })),
    ...[...templates.values()].map(value => ({ key: documentKey("template", value.id), kind: "template" as const, value })),
  ].sort((left, right) => left.key.localeCompare(right.key));
  const records = new Map<string, IndexedReceiver>(), byComponent = new Map<string, IndexedReceiver[]>(), messageTypes = new Set<string>();
  let truncated = false, placementTruncated = false, skippedInvalid = false;
  for (const document of documents) for (const component of document.value.components) {
    const handlers = document.key === currentKey && component.id === options.override?.componentId
      ? options.override.handlers : component.props.messageHandlers ?? [];
    for (const handler of handlers) {
      if (componentMessageTypeError(handler.messageType)) { skippedInvalid = true; continue; }
      if (handler.scope !== options.scope) continue;
      if (messageTypes.size < maximumMessageTypes || messageTypes.has(handler.messageType)) messageTypes.add(handler.messageType);
      else truncated = true;
      if (handler.messageType !== selectedMessageType) continue;
      const key = JSON.stringify([document.key, component.id, handler.id]);
      if (records.has(key)) continue;
      if (records.size >= maximumDefinitions) { truncated = true; continue; }
      const record: IndexedReceiver = { key, documentId: document.value.id, documentName: document.value.name,
        documentKind: document.kind, componentId: component.id, componentName: componentName(component), componentType: component.type, handlerId: handler.id,
        messageType: handler.messageType, scope: handler.scope, language: handler.language,
        ready: ["javascript", "python"].includes(handler.language) && typeof handler.code === "string" && !!handler.code.trim() && handler.code.length <= 65536,
        placements: [] };
      records.set(key, record);
      const ownerKey = JSON.stringify([document.key, component.id]);
      byComponent.set(ownerKey, [...(byComponent.get(ownerKey) ?? []), record]);
    }
  }

  const containingRoots = new Set<string>();
  let visits = 0, missingTemplate = false, cycle = false;
  const walk = (document: Document, root: string, path: string, depth: number, ancestors: Set<string>, repeated = false, conditions: string[] = []) => {
    if (document.key === currentKey) containingRoots.add(root);
    for (const component of document.value.components) {
      if (++visits > maximumPlacementVisits) { truncated = true; placementTruncated = true; return; }
      const location = `${path} / ${componentName(component)}`;
      for (const record of byComponent.get(JSON.stringify([document.key, component.id])) ?? []) {
        if (!record.placements.some(placement => placement.root === root && placement.path === location))
          record.placements.push({ root, path: location, repeated, conditions });
      }
      const placements = component.type === "viewContainer" ? (component.props.viewLayout?.panes ?? []).map(pane => ({
        templateId: pane.templateId, label: `${componentName(component)} / ${pane.label}`,
        repeated: false,
        conditions: component.props.viewLayout?.kind === "tabs" ? ["Its tab must be active."]
          : component.props.viewLayout?.kind === "dock" && pane.edge !== "center" ? ["Its dock panel must be open."] : [],
      })) : component.type === "template" || component.type === "repeater" ? [{ templateId: component.props.templateId ?? "",
        label: componentName(component), repeated: component.type === "repeater", conditions: component.type === "repeater" ? ["One listener per mounted repeater row."] : [] }] : [];
      for (const placement of placements) {
        if (depth >= maximumTemplateDepth) { truncated = true; placementTruncated = true; continue; }
        const template = templates.get(placement.templateId);
        if (!template) { missingTemplate = true; continue; }
        const key = documentKey("template", template.id);
        if (ancestors.has(key)) { cycle = true; continue; }
        walk({ key, kind: "template", value: template }, root, `${path} / ${placement.label} / Template ${template.name}`, depth + 1,
          new Set([...ancestors, key]), repeated || placement.repeated, [...conditions, ...placement.conditions]);
        if (visits > maximumPlacementVisits) return;
      }
    }
  };
  // Inspect the current authoring context first so large unrelated projects do
  // not crowd out the form being edited. An unplaced template remains inspectable.
  if (options.documentKind === "template") {
    const document = documents.find(value => value.key === currentKey)!;
    walk(document, `authoring:${currentKey}`, `Template ${document.value.name}`, 1, new Set([currentKey]));
  }
  const roots = documents.filter(document => document.kind !== "template").sort((left, right) =>
    Number(right.key === currentKey) - Number(left.key === currentKey) || left.key.localeCompare(right.key));
  for (const document of roots) {
    walk(document, document.key, `${document.kind === "popup" ? "Popup" : "Screen"} ${document.value.name}`, 0, new Set([document.key]));
    if (visits > maximumPlacementVisits) break;
  }
  const receivers = [...records.values()].map(record => {
    const sourceKey = documentKey(record.documentKind === "template" ? "template" : "screen", record.documentId);
    const authoredPlacements = record.placements.filter(placement => !placement.root.startsWith("authoring:"));
    const applicable = options.scope === "instance" ? sourceKey === currentKey
      : options.scope === "screen" ? record.placements.some(placement => containingRoots.has(placement.root)) : authoredPlacements.length > 0;
    const placementUnknown = !authoredPlacements.length && placementTruncated;
    const applicability = applicable ? "possible" as const : placementUnknown ? "uninspected" as const
      : record.documentKind === "template" && !authoredPlacements.length ? "unplaced" as const : "elsewhere" as const;
    let reason = applicability === "uninspected" ? "Placements were not fully inspected; this receiver may exist beyond the inspection limit."
      : applicability === "unplaced" ? "This template has no authored placement in the project."
      : applicability === "elsewhere" ? options.scope === "instance" ? "Different form or template instance."
        : "Another root screen or popup; screen-scoped messages do not cross that boundary."
      : options.scope === "instance" ? options.documentKind === "template" ? "Same template form and placement as the sender; other instances are separate." : "Same screen or popup form as the sender."
      : options.scope === "screen" ? options.documentKind === "template" ? "Possible on a containing screen or popup that includes this template." : "This root screen or popup, including its nested templates."
      : "This runtime tab while its screen, popup or template context is mounted.";
    const placements = options.scope === "screen" && applicable ? record.placements.filter(placement => containingRoots.has(placement.root))
      : options.scope === "session" || applicability === "unplaced" || applicability === "uninspected" ? authoredPlacements : record.placements;
    const conditions = [...new Set(placements.flatMap(placement => placement.conditions))];
    if (conditions.length) reason += ` ${conditions.join(" ")}`;
    if (!record.ready) reason += " Add handler code and choose a supported language before it can run.";
    const { placements: _placements, ...definition } = record;
    return { ...definition, applicability, reason, locations: [...new Set(placements.map(placement => placement.path))].slice(0, maximumLocations),
      repeated: placements.some(placement => placement.repeated) };
  }).sort((left, right) => Number(right.applicability === "possible") - Number(left.applicability === "possible")
    || left.documentName.localeCompare(right.documentName) || left.componentName.localeCompare(right.componentName) || left.key.localeCompare(right.key));
  notes.push(options.scope === "session" ? "Session messages stay in this browser tab; another screen receives only while active, and a popup only while open."
    : options.scope === "instance" ? "Nested templates and separate repeater rows own different form instances."
    : "Each root screen and each popup has its own screen scope.");
  notes.push("Hidden or disabled components may still listen; inactive container panes do not.");
  if (cycle) notes.push("A template cycle was skipped; fix the composition before publication.");
  if (missingTemplate) notes.push("A missing template placement was skipped.");
  if (skippedInvalid) notes.push("Handlers with invalid message types are omitted until corrected.");
  if (truncated) notes.push("This authored preview reached its inspection limit; additional placements or receivers may exist.");
  return { receivers, messageTypes: [...messageTypes].sort((left, right) => left.localeCompare(right)), truncated, notes };
}
