import type { Project, ProjectNavigationSettings, Screen } from "./types";

export function navigationLabelError(label: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- This character filter intentionally matches control characters.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(label)) return "Menu labels cannot contain control characters.";
  if (!label.trim()) return "Menu labels cannot be empty.";
  if (label.length > 120) return "Menu labels must be at most 120 characters.";
  return undefined;
}

export function defaultNavigationLabel(screen: Pick<Screen, "id" | "name">): string {
  // eslint-disable-next-line no-control-regex -- This character filter intentionally matches control characters.
  const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  const label = clean(screen.name) || clean(screen.id) || "Screen";
  // The gateway limit uses UTF-16 length; retain complete code points when truncating.
  let result = "";
  for (const character of label) {
    if (result.length + character.length > 120) break;
    result += character;
  }
  return result;
}

/** Legacy projects start on their first regular screen and expose no automatic menu. */
export function projectNavigationSettings(project: Project): ProjectNavigationSettings {
  return project.navigation ?? {
    startupScreenId: project.screens.find(screen => screen.kind !== "popup")?.id || "",
    mode: "none",
    items: [],
  };
}

export function runtimeScreenId(project: Project, current = ""): string {
  const regular = new Set(project.screens.filter(screen => screen.kind !== "popup").map(screen => screen.id));
  if (regular.has(current)) return current;
  const startup = projectNavigationSettings(project).startupScreenId;
  // Invalid explicit settings are rejected by the gateway, never silently replaced here.
  return regular.has(startup) ? startup : "";
}

export function runtimeMenuItems(project: Project): ProjectNavigationSettings["items"] {
  if (project.navigation?.mode !== "menu") return [];
  const regular = new Set(project.screens.filter(screen => screen.kind !== "popup").map(screen => screen.id));
  return project.navigation.items.filter(item => regular.has(item.screenId));
}

/** Keep screen edits and their navigation cleanup in one Designer undo transaction. */
export function reconcileNavigationAfterScreenChange(previous: Project, next: Project): Project {
  if (!next.navigation) return next;
  const regular = new Set(next.screens.filter(screen => screen.kind !== "popup").map(screen => screen.id));
  const removed = new Set(previous.screens.filter(screen => screen.kind !== "popup" && !regular.has(screen.id)).map(screen => screen.id));
  if (!removed.size) return next;
  const navigation = next.navigation;
  const items = navigation.items.filter(item => !removed.has(item.screenId));
  const startupScreenId = removed.has(navigation.startupScreenId)
    ? next.screens.find(screen => screen.kind !== "popup")?.id || ""
    : navigation.startupScreenId;
  if (items.length === navigation.items.length && startupScreenId === navigation.startupScreenId) return next;
  return { ...next, navigation: { ...navigation, startupScreenId, items } };
}
