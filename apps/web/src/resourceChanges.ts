import type { CanvasComponent, NamedQuery, Project, Screen } from "./types";
import { buildProjectSearch, findProjectReferences } from "./projectSearch";
import type { ScriptSearchResource, SearchEntry, SearchReference } from "./projectSearch";
import { reconcileNavigationAfterScreenChange } from "./runtimeNavigation";

export type ResourceChangeTarget = { kind: "screen" | "template"; id: string }
  | { kind: "components"; ownerKind: "screen" | "template"; ownerId: string; ids: string[] };
export type ResourceChangeRequest = { action: "delete"; target: ResourceChangeTarget }
  | { action: "rename"; target: { kind: "screen" | "template"; id: string }; name: string };
export interface ResourceChangePlan {
  request: ResourceChangeRequest;
  label: string;
  beforeName?: string;
  afterName?: string;
  componentIds: string[];
  blockingReferences: SearchEntry[];
  retainedReferences: SearchEntry[];
  textMatches: SearchEntry[];
  notices: string[];
  errors: string[];
  /** Complete authoring snapshot, including server revision and editor drafts. */
  signature: string;
  nextProject: Project | null;
}

function snapshotSignature(project: Project, queries: NamedQuery[], scripts: ScriptSearchResource[], request: ResourceChangeRequest): string {
  // Keep the exact JSON snapshot instead of a short hash: stale previews must not
  // overwrite unrelated edits, including edits outside the selected resource.
  return JSON.stringify([project, queries, scripts, request]);
}

function document(project: Project, kind: "screen" | "template", id: string): Screen | undefined {
  return (kind === "screen" ? project.screens : project.templates ?? []).find(item => item.id === id);
}

function replaceDocument(project: Project, kind: "screen" | "template", id: string, update: (item: Screen) => Screen): Project {
  return kind === "screen"
    ? { ...project, screens: project.screens.map(item => item.id === id ? update(item) : item) }
    : { ...project, templates: (project.templates ?? []).map(item => item.id === id ? { ...item, ...update(item) } : item) };
}

const unique = (entries: SearchEntry[]): SearchEntry[] => [...new Map(entries.map(entry => [entry.id, entry])).values()];
const componentTerms = (components: CanvasComponent[]) => components.flatMap(component => [component.id,
  typeof component.props.fieldKey === "string" ? component.props.fieldKey : ""]);

/** Preview only: never changes a project, executes code, or edits text references. */
export function planResourceChange(project: Project, queries: NamedQuery[], scripts: ScriptSearchResource[], request: ResourceChangeRequest): ResourceChangePlan {
  const savedRequest = structuredClone(request);
  const target = savedRequest.target;
  const ownerKind = target.kind === "components" ? target.ownerKind : target.kind;
  const ownerId = target.kind === "components" ? target.ownerId : target.id;
  const owner = document(project, ownerKind, ownerId);
  const plan: ResourceChangePlan = {
    request: savedRequest,
    label: target.kind === "components" ? "Selected components" : `${ownerKind === "screen" ? "Screen" : "Template"} / ${owner?.name ?? ownerId}`,
    beforeName: target.kind === "components" ? undefined : owner?.name,
    componentIds: [], blockingReferences: [], retainedReferences: [], textMatches: [], notices: [], errors: [],
    signature: snapshotSignature(project, queries, scripts, savedRequest), nextProject: null,
  };
  if (!owner) {
    plan.errors.push(`The selected ${ownerKind} no longer exists. Reopen the preview from the current project.`);
    return plan;
  }

  const entries = buildProjectSearch(project, queries, scripts);
  const references: SearchReference[] = [];
  let terms: string[] = [];
  let removedIds = new Set<string>();
  let candidate: Project = project;
  const insideDeletedResource = (entry: SearchEntry): boolean => savedRequest.action === "delete"
    && entry.target.kind === ownerKind && entry.target.id === ownerId
    && (target.kind !== "components" || Boolean(entry.target.componentId && removedIds.has(entry.target.componentId)));

  if (savedRequest.action === "rename") {
    const name = savedRequest.name.trim();
    plan.afterName = name;
    if (!name) plan.errors.push("Enter a non-empty resource name.");
    if (name.length > 120) plan.errors.push("Resource names must contain at most 120 characters.");
    if (/[\u0000-\u001f\u007f-\u009f]/.test(savedRequest.name)) plan.errors.push("Resource names cannot contain control characters.");
    if (name === owner.name) plan.errors.push("The resource already has that name.");
    candidate = replaceDocument(project, ownerKind, ownerId, item => ({ ...item, name }));
    const retained = findProjectReferences(entries, { kind: ownerKind, id: ownerId });
    plan.retainedReferences = retained;
    plan.notices.push(`The stable ID “${ownerId}” is unchanged. ${retained.length} structured reference${retained.length === 1 ? " is" : "s are"} retained.`);
    if (ownerKind === "screen" && project.navigation?.items.some(item => item.screenId === ownerId))
      plan.notices.push("Existing menu labels remain unchanged; edit them separately in Project settings.");
    terms = [ownerId, owner.name];
  } else if (target.kind === "components") {
    const requested = new Set(target.ids);
    if (!requested.size) plan.errors.push("Select at least one component to delete.");
    if ([...requested].some(id => !owner.components.some(component => component.id === id)))
      plan.errors.push("Some selected components no longer exist. Reopen the preview from the current selection.");
    // Canvas groups are atomic within their document, including when only one
    // member was supplied by a layer or property-sheet command.
    const groups = new Set(owner.components.filter(component => requested.has(component.id) && component.groupId).map(component => component.groupId));
    const removed = owner.components.filter(component => requested.has(component.id) || (component.groupId && groups.has(component.groupId)));
    plan.componentIds = removed.map(component => component.id);
    removedIds = new Set(plan.componentIds);
    plan.label = `${removed.length} component${removed.length === 1 ? "" : "s"} in ${owner.name}`;
    if (removed.length > requested.size) plan.notices.push(`The selection expands to ${removed.length} components because grouped controls are deleted together.`);
    references.push(...removed.map(component => ({ kind: "component" as const, id: component.id, ownerKind, ownerId })));
    terms = componentTerms(removed);
    candidate = replaceDocument(project, ownerKind, ownerId, item => ({ ...item, components: item.components.filter(component => !removedIds.has(component.id)) }));
  } else {
    references.push({ kind: target.kind, id: target.id });
    plan.componentIds = owner.components.map(component => component.id);
    terms = [ownerId, owner.name, ...componentTerms(owner.components)];
    if (target.kind === "screen") {
      if (owner.kind !== "popup" && !project.screens.some(screen => screen.id !== ownerId && screen.kind !== "popup"))
        plan.errors.push("Keep at least one regular screen in the project. Add another screen before deleting this one.");
      candidate = reconcileNavigationAfterScreenChange(project, { ...project, screens: project.screens.filter(screen => screen.id !== ownerId) });
      if (project.navigation && candidate.navigation) {
        const removedItems = project.navigation.items.length - candidate.navigation.items.length;
        if (removedItems) plan.notices.push(`${removedItems} menu item${removedItems === 1 ? "" : "s"} pointing to this screen will be removed.`);
        if (project.navigation.startupScreenId !== candidate.navigation.startupScreenId) {
          const startup = candidate.screens.find(screen => screen.id === candidate.navigation?.startupScreenId);
          plan.notices.push(startup ? `The startup screen will become “${startup.name}” (${startup.id}).` : "No regular screen would remain for startup.");
        }
      }
    } else candidate = { ...project, templates: (project.templates ?? []).filter(template => template.id !== ownerId) };
  }

  plan.blockingReferences = unique(references.flatMap(reference => findProjectReferences(entries, reference)))
    .filter(entry => !insideDeletedResource(entry));
  // Regular-screen navigation is reconciled with this deletion. Component links
  // and invalid popup navigation still block rather than being silently changed.
  if (savedRequest.action === "delete" && target.kind === "screen" && owner.kind !== "popup")
    plan.blockingReferences = plan.blockingReferences.filter(entry => !(entry.target.kind === "project"
      && (entry.target.property === "navigation.startupScreenId" || /^navigation\.items\.\d+\.screenId$/.test(entry.target.property ?? ""))));

  const needles = [...new Set(terms.filter(Boolean).map(term => term.toLocaleLowerCase()))];
  plan.textMatches = entries.filter(entry => entry.textOnly && !insideDeletedResource(entry)
    && needles.some(term => entry.text.slice((entry.target.property?.length ?? -1) + 1).toLocaleLowerCase().includes(term)));
  plan.notices.push("Code and SQL matches are literal review hints. Dynamic references cannot be fully analyzed, and no code or SQL is changed.");
  if (!plan.errors.length && !plan.blockingReferences.length) plan.nextProject = candidate;
  return plan;
}

/** Recheck the exact preview snapshot and return one immutable project transaction. */
export function applyResourceChange(plan: ResourceChangePlan, currentProject: Project, queries: NamedQuery[], scripts: ScriptSearchResource[]): Project {
  if (snapshotSignature(currentProject, queries, scripts, plan.request) !== plan.signature)
    throw new Error("This preview is stale because the project, queries or scripts changed. Refresh the preview and review it again.");
  // Recompute instead of trusting a mutable preview result supplied by a view.
  const fresh = planResourceChange(currentProject, queries, scripts, plan.request);
  if (fresh.errors.length) throw new Error(fresh.errors.join(" "));
  if (fresh.blockingReferences.length) throw new Error("This resource is still used by structured references. Update those references before deleting it.");
  if (!fresh.nextProject) throw new Error("The resource change is not ready to apply.");
  return fresh.nextProject;
}
