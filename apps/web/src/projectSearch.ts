import type { CanvasComponent, NamedQuery, Project, Screen } from "./types";

export interface SearchTarget {
  kind: "project" | "screen" | "template" | "query" | "script";
  id: string;
  componentId?: string;
  /** Authored source path; navigation opens the containing resource, never executes it. */
  property?: string;
}
export interface SearchReference {
  kind: "screen" | "template" | "query" | "asset" | "tag" | "component";
  id: string;
  /** Component identities are local to their containing screen or template. */
  ownerKind?: "screen" | "template";
  ownerId?: string;
}
export interface SearchEntry {
  id: string;
  label: string;
  location: string;
  category: "screen" | "template" | "component" | "property" | "binding" | "query" | "script";
  text: string;
  target: SearchTarget;
  reference?: SearchReference;
  missing?: boolean;
  /** Code and SQL are literal text matches, not inferred dependencies. */
  textOnly?: boolean;
}
export interface ScriptSearchResource {
  id: string;
  name: string;
  type: string;
  code: string;
  enabled?: boolean;
  event?: string;
  intervalMs?: number;
  parameters?: Record<string, string | number | boolean | null>;
}
export type SearchScope = "all" | SearchEntry["category"];
export interface SearchIndexOptions { queriesLoaded?: boolean }

const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const leafText = (value: unknown): string => value === null ? "null" : String(value);
const title = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 120);
const inputTypes = new Set(["textInput", "formattedInput", "barcodeInput", "passwordInput", "textArea", "numberInput", "spinner", "slider", "checkbox", "toggle", "select", "radioGroup", "dateTimeInput", "multiStateButton", "list", "treeView"]);

/** Build from the current authoring snapshot. No network, query, expression or script execution. */
export function buildProjectSearch(project: Project, queries: NamedQuery[], scripts: ScriptSearchResource[], options: SearchIndexOptions = {}): SearchEntry[] {
  const entries: SearchEntry[] = [];
  const screenIds = new Set(project.screens.map(screen => screen.id));
  const templateIds = new Set((project.templates ?? []).map(template => template.id));
  const queryIds = new Set(queries.map(query => query.id));
  const knownMissing = (reference: SearchReference, document?: Screen): boolean | undefined => {
    if (reference.kind === "screen") return !screenIds.has(reference.id);
    if (reference.kind === "template") return !templateIds.has(reference.id);
    if (reference.kind === "query") return options.queriesLoaded === false ? undefined : !queryIds.has(reference.id);
    if (reference.kind === "component" && document) return !document.components.some(component => component.id === reference.id);
    // Gateway tags and assets are outside this project snapshot. Indirect tag paths
    // are intentionally kept as authored and cannot be declared missing here.
    return undefined;
  };
  function add(target: SearchTarget, category: SearchEntry["category"], label: string, location: string, text: string,
    extra: Pick<SearchEntry, "reference" | "missing" | "textOnly"> = {}) {
    entries.push({ id: JSON.stringify([target.kind, target.id, target.componentId ?? null, target.property ?? null, category]),
      target, category, label, location, text, ...extra });
  }
  function walk(value: unknown, path: string[], target: SearchTarget, location: string, category: SearchEntry["category"],
    source?: { document: Screen; kind: "screen" | "template"; component?: CanvasComponent }) {
    const property = path.join(".");
    const nextTarget = { ...target, property };
    // Binding reference objects are indexed once, preserving alias and source kind.
    const bindingReferencePath = path[0] === "props" && path.at(-2) === "references"
      && ((path.length === 5 && ["bindings", "parameterBindings"].includes(path[1]))
        || (path.length === 7 && path[1] === "queryBindings" && path[3] === "parameters")
        || (path.length === 6 && path[1] === "dataSource" && path[2] === "parameters"));
    if (bindingReferencePath && record(value) && typeof value.kind === "string") {
      let reference: SearchReference | undefined;
      if (value.kind === "tag" && typeof value.path === "string" && value.path) reference = { kind: "tag", id: value.path };
      if (value.kind === "custom" && source?.component) {
        reference = { kind: "component", id: typeof value.componentId === "string" ? value.componentId : source.component.id,
          ownerKind: source.kind, ownerId: source.document.id };
      }
      if (value.kind === "input" && typeof value.key === "string" && source) {
        const owner = source.document.components.find(component => inputTypes.has(component.type) && (component.props.fieldKey || component.id) === value.key);
        if (owner) reference = { kind: "component", id: owner.id, ownerKind: source.kind, ownerId: source.document.id };
      }
      add(nextTarget, "binding", property, location, `${property} ${JSON.stringify(value)}`, reference ? { reference, missing: knownMissing(reference, source?.document) } : {});
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, String(index)], target, location, category, source));
      return;
    }
    if (record(value)) {
      for (const [key, child] of Object.entries(value)) walk(child, [...path, key], target, location, category, source);
      return;
    }
    if (value === undefined || typeof value === "function" || typeof value === "symbol") return;
    let reference: SearchReference | undefined;
    const componentProperty = path[0] === "props";
    if (typeof value === "string" && value) {
      if (componentProperty && path.length === 2) {
        const kinds: Record<string, SearchReference["kind"]> = { queryId: "query", templateId: "template", targetScreenId: "screen", assetId: "asset", tagPath: "tag" };
        if (own(kinds, path[1])) reference = { kind: kinds[path[1]], id: value };
      }
      if (componentProperty && path.at(-1) === "queryId" && ((path.length === 3 && (path[1] === "optionsSource" || path[1] === "rowsSource" || path[1] === "dataSource")) || (path.length === 4 && path[1] === "queryBindings")))
        reference = { kind: "query", id: value };
      if (componentProperty && source?.component?.type === "viewContainer" && path.length === 5 && path[1] === "viewLayout" && path[2] === "panes" && path[4] === "templateId") reference = { kind: "template", id: value };
      if (componentProperty && path.length === 3 && path[1] === "selectionFields" && source?.component
        && ["table", "select", "list", "treeView"].includes(source.component.type)) {
        const input = source.document.components.find(component => inputTypes.has(component.type) && (component.props.fieldKey || component.id) === path[2]);
        if (input) reference = { kind: "component", id: input.id, ownerKind: source.kind, ownerId: source.document.id };
      }
      if (target.kind === "project" && path[0] === "navigation" && ((path.length === 4 && path[1] === "items" && path[3] === "screenId") || (path.length === 2 && path[1] === "startupScreenId")))
        reference = { kind: "screen", id: value };
    }
    const binding = componentProperty && ["bindings", "queryBindings", "dataSource", "parameterBindings", "stateBinding"].includes(path[1]);
    const code = (target.kind === "script" && path[0] === "code") || (target.kind === "query" && path[0] === "sql")
      || (componentProperty && ((path[1] === "script" && path.length === 2) || (path[1] === "tableEdit" && path[2] === "script")
        || (["events", "componentEvents", "messageHandlers"].includes(path[1]) && path.at(-1) === "code")));
    add(nextTarget, code && componentProperty ? "script" : binding ? "binding" : category, property, location,
      `${property} ${leafText(value)}`, { ...(code ? { textOnly: true } : {}), ...(reference ? { reference, missing: knownMissing(reference, source?.document) } : {}) });
  }

  const projectTarget: SearchTarget = { kind: "project", id: project.id };
  const projectLocation = `Project / ${project.name}`;
  add(projectTarget, "property", project.name, projectLocation, `${project.id} ${project.name}`);
  for (const key of ["parameters", "sessionState", "navigation"] as const) walk(project[key], [key], projectTarget, projectLocation, "property");

  function documentEntries(document: Screen, kind: "screen" | "template") {
    const target: SearchTarget = { kind, id: document.id };
    const location = `${kind === "screen" ? "Screens" : "Templates"} / ${document.name}`;
    add(target, kind, document.name, location, `${document.id} ${document.name} ${document.kind ?? kind}`);
    const source = { document, kind };
    for (const [key, value] of Object.entries(document)) if (!["id", "name", "components"].includes(key)) walk(value, [key], target, location, "property", source);
    for (const component of document.components) {
      const label = title(typeof component.props.text === "string" ? component.props.text : "") || component.id;
      const componentTarget = { ...target, componentId: component.id };
      const componentLocation = `${location} / ${label} (${component.id})`;
      add(componentTarget, "component", label, componentLocation, `${component.id} ${component.type} ${label}`);
      for (const [key, value] of Object.entries(component)) if (key !== "id" && key !== "type")
        walk(value, [key], componentTarget, componentLocation, "property", { ...source, component });
    }
  }
  project.screens.forEach(document => documentEntries(document, "screen"));
  (project.templates ?? []).forEach(document => documentEntries(document, "template"));
  for (const query of queries) {
    const target: SearchTarget = { kind: "query", id: query.id };
    const location = `Named queries / ${query.name}`;
    add(target, "query", query.name, location, `${query.id} ${query.name}`);
    for (const [key, value] of Object.entries(query)) if (key !== "id" && key !== "name") walk(value, [key], target, location, "query");
  }
  for (const script of scripts) {
    const target: SearchTarget = { kind: "script", id: script.id };
    const location = `Scripts / ${script.type} / ${script.name}`;
    add(target, "script", script.name, location, `${script.id} ${script.name} ${script.type}`);
    for (const [key, value] of Object.entries(script)) if (key !== "id" && key !== "name") walk(value, [key], target, location, "script");
  }
  return entries;
}

/** Literal, case-insensitive AND matching. No regex interpretation or result truncation. */
export function searchProject(entries: SearchEntry[], term: string, scope: SearchScope = "all"): SearchEntry[] {
  const words = term.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => {
    if (scope !== "all" && scope !== entry.category) return false;
    const text = `${entry.label} ${entry.location} ${entry.text}`.toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
}

/** Only authored structured references count; code and SQL text never imply a dependency. */
export function findProjectReferences(entries: SearchEntry[], reference: SearchReference): SearchEntry[] {
  return entries.filter(entry => {
    const candidate = entry.reference;
    return !entry.textOnly && candidate?.kind === reference.kind && candidate.id === reference.id
      && (reference.kind !== "component" || (candidate.ownerKind === reference.ownerKind && candidate.ownerId === reference.ownerId));
  });
}
