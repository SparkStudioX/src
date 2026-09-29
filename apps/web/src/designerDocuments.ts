import type { Project } from "./types";

export interface DesignerDocument { kind: "screen" | "template"; id: string }
export interface DesignerDocuments { open: DesignerDocument[]; active: string | null }
export const documentKey = (document: DesignerDocument) => `${document.kind}:${document.id}`;

/** A missing preference opens the first screen; an explicitly empty tab list stays empty. */
export function restoreDesignerDocuments(project: Project, saved?: unknown): DesignerDocuments {
  const fallback = project.screens[0] ? { open: [{ kind: "screen" as const, id: project.screens[0].id }], active: `screen:${project.screens[0].id}` } : { open: [], active: null };
  if (!saved || typeof saved !== "object" || !Array.isArray((saved as DesignerDocuments).open)) return fallback;
  const state = saved as DesignerDocuments;
  const seen = new Set<string>();
  const open = state.open.filter(document => {
    if (!document || !["screen", "template"].includes(document.kind) || typeof document.id !== "string") return false;
    const exists = (document.kind === "screen" ? project.screens : project.templates ?? []).some(item => item.id === document.id);
    const key = documentKey(document);
    if (!exists || seen.has(key)) return false;
    seen.add(key); return true;
  }).map(({ kind, id }) => ({ kind, id }));
  const active = open.some(document => documentKey(document) === state.active) ? state.active : open[0] ? documentKey(open[0]) : null;
  return { open, active };
}

export function openDesignerDocument(state: DesignerDocuments, document: DesignerDocument): DesignerDocuments {
  const active = documentKey(document);
  return { open: state.open.some(item => documentKey(item) === active) ? state.open : [...state.open, document], active };
}

/** Closing is editor state only: it never mutates a saved or unsaved project resource. */
export function closeDesignerDocument(state: DesignerDocuments, key: string): DesignerDocuments {
  const index = state.open.findIndex(document => documentKey(document) === key);
  if (index < 0) return state;
  const open = state.open.filter(document => documentKey(document) !== key);
  const adjacent = open[Math.min(index, open.length - 1)];
  return { open, active: state.active !== key ? state.active : adjacent ? documentKey(adjacent) : null };
}
