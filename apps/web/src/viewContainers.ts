import type { CanvasComponent, Template } from "./types";

export type ViewLayoutKind = "embedded" | "tabs" | "split" | "dock";
export type DockEdge = "center" | "left" | "right" | "top" | "bottom";
export interface ViewPane {
  id: string;
  label: string;
  templateId: string;
  parameters?: Record<string, string>;
  edge?: DockEdge;
  initiallyOpen?: boolean;
  size?: number;
}
export interface ViewLayout {
  kind: ViewLayoutKind;
  panes: ViewPane[];
  initialPaneId?: string;
  orientation?: "horizontal" | "vertical";
  ratio?: number;
}
export const viewLayoutKinds: ViewLayoutKind[] = ["embedded", "tabs", "split", "dock"];
export function defaultViewLayout(kind: ViewLayoutKind = "embedded", templateId = ""): ViewLayout {
  const pane = (id: string, label: string, edge?: DockEdge): ViewPane => ({ id, label, templateId, parameters: {}, ...(edge ? { edge } : {}) });
  return kind === "split" ? { kind, orientation: "horizontal", ratio: 50, panes: [pane("first", "First"), pane("second", "Second")] }
    : kind === "tabs" ? { kind, initialPaneId: "first", panes: [pane("first", "First"), pane("second", "Second")] }
    : kind === "dock" ? { kind, panes: [pane("main", "Main", "center"), { ...pane("details", "Details", "right"), size: 220, initiallyOpen: true }] }
    : { kind, panes: [pane("content", "Content")] };
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export function viewLayoutError(value: unknown, templates?: Template[]): string | undefined {
  if (!object(value) || !viewLayoutKinds.includes(value.kind as ViewLayoutKind) || Object.keys(value).some(key => !["kind", "panes", "initialPaneId", "orientation", "ratio"].includes(key))) return "Choose embedded, tabs, split, or dock layout.";
  if (!Array.isArray(value.panes) || value.panes.length < 1 || value.panes.length > 16) return "A container needs 1–16 panes.";
  if (value.kind === "embedded" && value.panes.length !== 1 || value.kind === "split" && value.panes.length !== 2 || value.kind === "dock" && value.panes.length > 5) return "Embedded views need one pane, split panes need two, and docks support a center plus four edges.";
  if (value.orientation !== undefined && (value.kind !== "split" || !["horizontal", "vertical"].includes(String(value.orientation)))) return "Split orientation must be horizontal or vertical.";
  if (value.ratio !== undefined && (value.kind !== "split" || typeof value.ratio !== "number" || !Number.isFinite(value.ratio) || value.ratio < 10 || value.ratio > 90)) return "The split position must be 10–90 percent.";
  const ids = new Set<string>(), edges = new Set<string>();
  for (const pane of value.panes) {
    if (!object(pane) || Object.keys(pane).some(key => !["id", "label", "templateId", "parameters", "edge", "initiallyOpen", "size"].includes(key))) return "Pane definitions contain unsupported fields.";
    if (typeof pane.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(pane.id) || ids.has(pane.id)) return "Pane IDs must be unique identifiers starting with a letter (up to 64 characters).";
    ids.add(pane.id);
    if (typeof pane.label !== "string" || !pane.label.trim() || pane.label.length > 120) return "Each pane needs a label of 1–120 characters.";
    if (typeof pane.templateId !== "string" || !pane.templateId.trim() || pane.templateId.length > 256) return "Choose a shared template for every pane.";
    const template = templates?.find(item => item.id === pane.templateId);
    if (templates && !template) return `Pane '${pane.label}' references a missing template.`;
    if (pane.parameters !== undefined && (!object(pane.parameters) || Object.keys(pane.parameters).length > 64 || Object.entries(pane.parameters).some(([key, entry]) => key.length > 256 || typeof entry !== "string" || entry.length > 4096 || template && !Object.hasOwn(template.parameters, key)))) return "Pane overrides must be text values for declared template parameters (at most 64).";
    if (value.kind === "dock") {
      if (!["center", "left", "right", "top", "bottom"].includes(String(pane.edge)) || edges.has(String(pane.edge))) return "A dock needs unique center, left, right, top, or bottom edges.";
      edges.add(String(pane.edge));
      if (pane.initiallyOpen !== undefined && (typeof pane.initiallyOpen !== "boolean" || pane.edge === "center")) return "Only side dock panes support an initial open state.";
      if (pane.size !== undefined && (pane.edge === "center" || typeof pane.size !== "number" || !Number.isFinite(pane.size) || pane.size < 80 || pane.size > 1600)) return "Side dock sizes must be 80–1,600 pixels.";
    } else if (pane.edge !== undefined || pane.initiallyOpen !== undefined || pane.size !== undefined) return "Dock edge, size and open state belong only to dock panes.";
  }
  if (value.kind === "dock" && !edges.has("center")) return "A dock needs one center pane.";
  if (value.initialPaneId !== undefined && (value.kind !== "tabs" || typeof value.initialPaneId !== "string" || !ids.has(value.initialPaneId))) return "The initial tab must name a saved pane.";
  return undefined;
}

/** Virtual placements preserve the authored container ID; rowId identifies its saved pane. */
export function panePlacement(component: CanvasComponent, pane: ViewPane): CanvasComponent {
  return { id: component.id, type: "template", x: 0, y: 0, width: component.width, height: component.height,
    props: { templateId: pane.templateId, parameters: pane.parameters ?? {} } };
}
export function templatePlacements(component: CanvasComponent): CanvasComponent[] {
  return component.type === "viewContainer" ? (component.props.viewLayout?.panes ?? []).map(pane => panePlacement(component, pane))
    : component.type === "template" || component.type === "repeater" ? [component] : [];
}
