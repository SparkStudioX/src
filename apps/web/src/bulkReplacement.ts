import type { BindingTarget, Project, PropertyBinding, Screen } from "./types";
import type { SearchTarget } from "./projectSearch";
import { navigationLabelError } from "./runtimeNavigation";
import { runtimePropertyDefinition } from "./runtimePropertyCatalog";

export interface BulkReplaceRequest {
  find: string;
  replace: string;
  matchCase: boolean;
  scope: "all" | "screens" | "templates";
  kind: "displayText" | "tagPaths";
}
export interface BulkReplacementChange {
  id: string;
  target: SearchTarget;
  location: string;
  property: string;
  before: string;
  after: string;
  occurrences: number;
  errors: string[];
}
export interface BulkReplacePlan {
  request: BulkReplaceRequest;
  /** Exact authoring snapshot, including revision and fields outside the inventory. */
  signature: string;
  changes: BulkReplacementChange[];
  errors: string[];
}

type Validator = (value: string) => string[];
type Writer = (next: Project, value: string) => void;
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const knownTypes = new Set(["alarmStatusTable", "alarmJournalTable", "historicalTrend", "viewContainer", "formattedInput", "barcodeInput", "equipmentCommand", "chart", "sparkline", "label", "value", "gauge", "button", "table", "list", "treeView", "textInput", "passwordInput", "multiStateButton",
  "multiStateIndicator", "ledDisplay", "progressBar", "cylindricalTank", "levelIndicator", "thermometer", "textArea", "numberInput", "spinner",
  "slider", "checkbox", "toggle", "select", "radioGroup", "dateTimeInput", "template", "repeater", "image", "computerCamera", "icon", "line", "rectangle", "ellipse", "polyline", "pipe", "equipmentSymbol"]);
const unitTypes = new Set(["value", "gauge", "slider", "ledDisplay", "progressBar", "cylindricalTank", "levelIndicator", "thermometer"]);
const choiceTypes = new Set(["select", "radioGroup", "multiStateButton", "list", "treeView"]);
const tagInputTypes = new Set(["textInput", "formattedInput", "barcodeInput", "multiStateButton", "list", "treeView", "textArea", "numberInput", "spinner", "slider", "checkbox", "toggle", "select", "radioGroup", "dateTimeInput"]);
const processTypes = new Set(["ledDisplay", "progressBar", "cylindricalTank", "levelIndicator", "thermometer"]);

function boundedText(label: string, maximum: number, nonblank = true, rejectControls = true): Validator {
  return value => [
    ...(nonblank && !value.trim() ? [`${label} cannot be empty.`] : []),
    ...(value.length > maximum ? [`${label} must contain at most ${maximum} characters.`] : []),
    ...(rejectControls && controls.test(value) ? [`${label} cannot contain control characters.`] : []),
  ];
}
const nameErrors = boundedText("Resource names", 120);
const pathErrors = boundedText("Tag paths", 1024);
const noErrors: Validator = () => [];

function protectedDisplayErrors(before: string): Validator {
  // Keep the same tokens resolvePath reads, including their order. These saved
  // strings can become bound fallbacks, so their references stay protected too.
  const tokens = (value: string) => [...value.matchAll(/\{([^{}]+)\}/g)].map(match => match[0]);
  return after => JSON.stringify(tokens(before)) === JSON.stringify(tokens(after)) ? []
    : ["Display parameter tokens are not changed by bulk replacement. Edit the owning property instead."];
}

function protectedPathErrors(before: string): Validator {
  const tokens = (value: string) => [...value.matchAll(/\{[^{}]*\}/g)].map(match => match[0]);
  return after => [
    ...pathErrors(after),
    ...(JSON.stringify(tokens(before)) !== JSON.stringify(tokens(after)) ? ["Indirection parameter tokens are not changed by bulk replacement. Edit the binding instead."] : []),
    ...(/[{}]/.test(after.replace(/\{[^{}]*\}/g, "")) ? ["Tag paths cannot contain unmatched or nested indirection braces."] : []),
  ];
}

function requestErrors(request: BulkReplaceRequest): string[] {
  return [
    ...(typeof request.find !== "string" || !request.find.length ? ["Enter text to find."] : request.find.length > 256 ? ["Find text must contain at most 256 characters."] : []),
    ...(typeof request.replace !== "string" || request.replace.length > 2048 ? ["Replacement text must contain at most 2048 characters."] : []),
    ...(!["all", "screens", "templates"].includes(request.scope) ? ["Choose a supported resource scope."] : []),
    ...(!["displayText", "tagPaths"].includes(request.kind) ? ["Choose display text or tag paths."] : []),
    ...(typeof request.matchCase !== "boolean" ? ["Choose whether matching is case-sensitive."] : []),
  ];
}

function build(project: Project, request: BulkReplaceRequest): { plan: BulkReplacePlan; writers: Map<string, Writer> } {
  const savedRequest = structuredClone(request);
  const plan: BulkReplacePlan = { request: savedRequest, signature: JSON.stringify([project, savedRequest]), changes: [], errors: requestErrors(savedRequest) };
  const writers = new Map<string, Writer>();
  if (plan.errors.length) return { plan, writers };
  // Escaped literals plus a replacement callback preserve regex characters and
  // dollar sequences. Unicode matching keeps indices in the original string;
  // lowercasing first would shift indices for characters such as capital I-dot.
  const expression = new RegExp(savedRequest.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), savedRequest.matchCase ? "gu" : "giu");
  // This bounds preview allocations, not the gateway's serialized project size.
  const maximumPreviewCharacters = 2 * 1024 * 1024;
  let previewCharacters = 0;
  function add(target: SearchTarget, path: (string | number)[], location: string, before: unknown, validate: Validator, write: Writer, trim = false) {
    if (plan.errors.length || typeof before !== "string") return;
    let occurrences = 0;
    let estimatedLength = before.length;
    let changesText = false;
    expression.lastIndex = 0;
    // Count against the original string before creating any expanded string.
    // A short find and a long replacement could otherwise allocate gigabytes.
    for (let match = expression.exec(before); match; match = expression.exec(before)) {
      occurrences++;
      estimatedLength += savedRequest.replace.length - match[0].length;
      changesText ||= savedRequest.replace !== match[0];
    }
    if (!occurrences) return;
    if (!changesText && (!trim || before === before.trim())) return;
    if (previewCharacters + estimatedLength > maximumPreviewCharacters) {
      plan.errors.push("The replacement preview is too large. Narrow the search or use a smaller replacement.");
      plan.changes = [];
      writers.clear();
      return;
    }
    let after = before.replace(expression, () => savedRequest.replace);
    const rawAfter = after;
    if (trim) after = after.trim();
    if (before === after) return;
    previewCharacters += after.length;
    const property = path.map(part => typeof part === "number" ? `[${part}]` : /^[A-Za-z_$][\w$]*$/.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`).join("").replace(/^\./, "");
    const id = JSON.stringify([target.kind, target.id, target.componentId ?? null, path]);
    const errors = validate(after);
    if (trim && controls.test(rawAfter) && !controls.test(after)) errors.push("Resource names cannot contain control characters.");
    plan.changes.push({ id, target: { ...target, property }, location, property, before, after, occurrences, errors });
    writers.set(id, write);
  }

  if (savedRequest.kind === "displayText" && savedRequest.scope !== "templates") {
    project.navigation?.items.forEach((item, index) => add({ kind: "project", id: project.id }, ["navigation", "items", index, "label"],
      `Project / ${project.name} / Screen menu`, item.label, value => { const error = navigationLabelError(value); return error ? [error] : []; },
      (next, value) => { next.navigation!.items[index].label = value; }));
  }
  function document(document: Screen, kind: "screen" | "template", index: number) {
    const target: SearchTarget = { kind, id: document.id };
    const location = `${kind === "screen" ? "Screens" : "Templates"} / ${document.name}`;
    const nextDocument = (next: Project) => kind === "screen" ? next.screens[index] : next.templates![index];
    if (savedRequest.kind === "displayText") add(target, ["name"], location, document.name, value => [...nameErrors(value), ...protectedDisplayErrors(document.name)(value)], (next, value) => { nextDocument(next).name = value; }, true);
    const declaredParameters = new Set([...Object.keys(project.parameters ?? {}), ...Object.keys(document.parameters ?? {})]);
    const referencePathErrors = (before: string): Validator => value => {
      const errors = protectedPathErrors(before)(value);
      for (const match of value.matchAll(/\{([^{}]+)\}/g)) {
        const key = match[1];
        if (!key.trim() || key.length > 256 || ["__proto__", "constructor", "prototype"].includes(key) || !declaredParameters.has(key))
          errors.push(`Tag path parameter “${key}” is not declared in this resource or project.`);
      }
      return errors;
    };
    document.components.forEach((component, componentIndex) => {
      if (!knownTypes.has(component.type)) return;
      const props = component.props;
      const componentTarget = { ...target, componentId: component.id };
      const componentLocation = `${location} / ${typeof props.text === "string" && props.text ? props.text : component.type} (${component.id})`;
      const nextComponent = (next: Project) => nextDocument(next).components[componentIndex];
      function property(key: "text" | "unit" | "alt" | "tagPath", validate = noErrors) {
        add(componentTarget, ["props", key], componentLocation, props[key], validate, (next, value) => { nextComponent(next).props[key] = value; });
      }
      if (savedRequest.kind === "displayText") {
        // Password controls are deliberately absent from the display inventory.
        if (component.type !== "passwordInput") property("text", protectedDisplayErrors(typeof props.text === "string" ? props.text : ""));
        if (unitTypes.has(component.type)) property("unit", processTypes.has(component.type)
          ? value => [...boundedText("Process display units", 32, false)(value), ...protectedDisplayErrors(typeof props.unit === "string" ? props.unit : "")(value)] : noErrors);
        if (component.type === "image" || component.type === "icon") property("alt", protectedDisplayErrors(typeof props.alt === "string" ? props.alt : ""));
        if (choiceTypes.has(component.type) && Array.isArray(props.options)) props.options.forEach((option, optionIndex) => {
          if (!record(option)) return;
          const optionErrors: Validator = value => {
            const errors = boundedText("Option labels", 200, true, false)(value);
            // These two older controls use .NET whitespace rules at save time;
            // U+0085 is whitespace there but not in JavaScript String.trim.
            if (["select", "radioGroup"].includes(component.type) && value.trim() && !value.replace(/\u0085/g, "").trim()) errors.push("Option labels cannot be empty.");
            return errors;
          };
          add(componentTarget, ["props", "options", optionIndex, "label"], componentLocation, option.label, optionErrors,
            (next, value) => { nextComponent(next).props.options![optionIndex].label = value; });
        });
        if (component.type === "multiStateIndicator" && Array.isArray(props.states)) props.states.forEach((state, stateIndex) => {
          if (!record(state)) return;
          add(componentTarget, ["props", "states", stateIndex, "label"], componentLocation, state.label, boundedText("State labels", 128, true, false),
            (next, value) => { nextComponent(next).props.states![stateIndex].label = value; });
        });
        if (component.type === "table" && Array.isArray(props.tableColumns)) props.tableColumns.forEach((column, columnIndex) => {
          if (!record(column)) return;
          for (const key of ["label", "suffix"] as const) add(componentTarget, ["props", "tableColumns", columnIndex, key], componentLocation, column[key],
            boundedText(key === "label" ? "Column labels" : "Column suffixes", key === "label" ? 120 : 32, key === "label"),
            (next, value) => { nextComponent(next).props.tableColumns![columnIndex][key] = value; });
        });
        return;
      }
      if ((component.type === "value" || component.type === "gauge" || tagInputTypes.has(component.type)) && typeof props.tagPath === "string") property("tagPath", protectedPathErrors(props.tagPath));
      function bindingReferences(binding: PropertyBinding | undefined, path: string[], getNext: (next: Project) => PropertyBinding) {
        if (!record(binding) || !record(binding.references)) return;
        for (const [alias, reference] of Object.entries(binding.references)) {
          if (!record(reference) || reference.kind !== "tag" || typeof reference.path !== "string") continue;
          add(componentTarget, [...path, "references", alias, "path"], componentLocation, reference.path, referencePathErrors(reference.path),
            (next, value) => { const ref = getNext(next).references[alias]; if (ref.kind === "tag") ref.path = value; });
        }
      }
      if (record(props.bindings)) for (const [key, binding] of Object.entries(props.bindings)) {
        if (runtimePropertyDefinition(key, component)) bindingReferences(binding, ["props", "bindings", key], next => nextComponent(next).props.bindings![key as BindingTarget]!);
      }
      if ((component.type === "template" || component.type === "repeater") && record(props.parameterBindings)) {
        for (const [key, binding] of Object.entries(props.parameterBindings)) bindingReferences(binding, ["props", "parameterBindings", key], next => nextComponent(next).props.parameterBindings![key]);
      }
      // Query parameters do not support live tag references. Query expressions,
      // scripts, literal custom values and arbitrary metadata are never traversed.
    });
  }
  if (savedRequest.scope !== "templates") project.screens.forEach((item, index) => document(item, "screen", index));
  if (savedRequest.scope !== "screens") (project.templates ?? []).forEach((item, index) => document(item, "template", index));
  return { plan, writers };
}

/** Preview an explicit inventory of authored display strings or tag paths. */
export function planBulkReplacement(project: Project, request: BulkReplaceRequest): BulkReplacePlan { return build(project, request).plan; }

/** Apply selected fields as one immutable edit; supplied preview rows are untrusted. */
export function applyBulkReplacement(plan: BulkReplacePlan, currentProject: Project, selectedIds: string[]): Project {
  if (plan.signature !== JSON.stringify([currentProject, plan.request])) throw new Error("The project or replacement options changed. Refresh the preview before applying replacements.");
  const fresh = build(currentProject, plan.request);
  if (fresh.plan.errors.length) throw new Error(fresh.plan.errors.join(" "));
  if (!Array.isArray(selectedIds) || !selectedIds.length) throw new Error("Select at least one replacement.");
  const selected = new Set(selectedIds);
  if (selected.size !== selectedIds.length) throw new Error("The replacement selection contains duplicate fields. Refresh the preview.");
  const byId = new Map(fresh.plan.changes.map(change => [change.id, change]));
  const changes = [...selected].map(id => {
    const change = byId.get(id);
    if (!change) throw new Error("A selected replacement is no longer available. Refresh the preview.");
    if (change.errors.length) throw new Error(`${change.location} / ${change.property}: ${change.errors.join(" ")}`);
    return change;
  });
  const next = structuredClone(currentProject);
  for (const change of changes) fresh.writers.get(change.id)!(next, change.after);
  return next;
}
