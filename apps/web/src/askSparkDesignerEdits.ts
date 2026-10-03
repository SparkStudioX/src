import type { BindingTarget, CanvasComponent, Project, Screen, Template } from "./types";
import { alignSelected, distributeSelected, duplicateSelected, groupSelected, matchSelectedSize, moveSelected, ungroupSelected } from "./canvasEditing";
import type { Alignment, Distribution, MatchingSize } from "./canvasEditing";
import { applyResourceChange, planResourceChange } from "./resourceChanges";
import type { ResourceChangeRequest } from "./resourceChanges";
import { applyBulkReplacement, planBulkReplacement } from "./bulkReplacement";
import type { BulkReplaceRequest } from "./bulkReplacement";
import { componentFor, documentFor, exactKeys, idsArg, ownerKind, record, textArg, withComponent, withDocument } from "./askSparkDesignerModel";
import type { DesignerEdit, DesignerSnapshot, ToolArgs } from "./askSparkDesignerModel";

function createDocument(snapshot: DesignerSnapshot, args: ToolArgs): Project {
  const document = record(args.document, "document") as unknown as Screen;
  if (!document.id || [...snapshot.project.screens, ...snapshot.project.templates ?? []].some(item => item.id === document.id)) throw new Error("Document ID must be new and unique.");
  if (ownerKind(args) === "screen") return { ...snapshot.project, screens: [...snapshot.project.screens, document] };
  return { ...snapshot.project, templates: [...snapshot.project.templates ?? [], { ...document, parameters: document.parameters ?? {} }] };
}
function updateDocument(snapshot: DesignerSnapshot, args: ToolArgs): Project {
  const patch = record(args.patch, "patch");
  exactKeys(patch, ["name", "width", "height", "kind", "parameters", "state", "parameterTypes", "instanceState"]);
  return withDocument(snapshot, args, document => ({ ...document, ...patch }));
}
function cloneDocument(snapshot: DesignerSnapshot, args: ToolArgs): Project {
  const document = structuredClone(documentFor(snapshot, args));
  document.id = textArg(args, "newId"); document.name = textArg(args, "name");
  // Component IDs are document-scoped. Keeping them preserves internal bindings and scripts.
  return createDocument(snapshot, { ...args, document });
}
function createComponents(snapshot: DesignerSnapshot, args: ToolArgs): Project {
  if (!Array.isArray(args.components) || !args.components.length || args.components.length > 200) throw new Error("Supply 1–200 components.");
  const components = args.components.map(item => record(item, "component") as unknown as CanvasComponent);
  return withDocument(snapshot, args, document => ({ ...document, components: [...document.components, ...components] }));
}
function updateComponents(snapshot: DesignerSnapshot, args: ToolArgs): Project {
  const ids = idsArg(args), document = documentFor(snapshot, args), patch = record(args.patch, "patch");
  exactKeys(patch, ["x", "y", "width", "height", "groupId", "props"]);
  if (ids.some(id => !document.components.some(item => item.id === id))) throw new Error("Some components no longer exist.");
  const props = patch.props === undefined ? {} : record(patch.props, "props");
  return withDocument(snapshot, args, item => ({ ...item, components: item.components.map(component => ids.includes(component.id)
    ? { ...component, ...patch, props: { ...component.props, ...props } } : component) }));
}
type Arrangement = (document: Screen, ids: string[], args: ToolArgs) => CanvasComponent[];
const arrangements: Record<string, Arrangement> = {
  align: (doc, ids, args) => alignSelected(doc.components, ids, textArg(args, "value") as Alignment),
  distribute: (doc, ids, args) => distributeSelected(doc.components, ids, textArg(args, "value") as Distribution),
  move: (doc, ids, args) => moveSelected(doc.components, ids, { x: Number(args.dx), y: Number(args.dy) }, doc, 0),
  matchSize: (doc, ids, args) => {
    const result = matchSelectedSize(doc.components, ids, textArg(args, "value") as MatchingSize, doc);
    if (result.error) throw new Error(result.error);
    return result.components;
  },
  group: (doc, ids, args) => groupSelected(doc.components, ids, textArg(args, "groupId")),
  ungroup: (doc, ids) => ungroupSelected(doc.components, ids),
  duplicate: (doc, ids) => duplicateSelected(doc.components, ids, doc).components,
  front: (doc, ids) => [...doc.components.filter(item => !ids.includes(item.id)), ...doc.components.filter(item => ids.includes(item.id))],
  back: (doc, ids) => [...doc.components.filter(item => ids.includes(item.id)), ...doc.components.filter(item => !ids.includes(item.id))],
};
function arrange(snapshot: DesignerSnapshot, args: ToolArgs): Project {
  const operation = arrangements[textArg(args, "operation")];
  if (!operation) throw new Error("Unknown arrangement operation.");
  const ids = idsArg(args);
  return withDocument(snapshot, args, document => {
    if (ids.some(id => !document.components.some(item => item.id === id))) throw new Error("Some components no longer exist.");
    return { ...document, components: operation(document, ids, args) };
  });
}
function resourceChange(snapshot: DesignerSnapshot, args: ToolArgs): Project {
  const request = record(args.request, "request") as unknown as ResourceChangeRequest;
  const plan = planResourceChange(snapshot.project, snapshot.queries, snapshot.scripts, request);
  if (plan.textMatches.length && args.acknowledgeTextReferences !== true) throw new Error("Code/SQL text references require review; inspect references and acknowledgeTextReferences explicitly.");
  return applyResourceChange(plan, snapshot.project, snapshot.queries, snapshot.scripts);
}
function setBinding(snapshot: DesignerSnapshot, args: ToolArgs): Project {
  const target = textArg(args, "property") as BindingTarget, binding = record(args.binding, "binding");
  const kind = args.kind === "query" ? "queryBindings" : "bindings", other = kind === "bindings" ? "queryBindings" : "bindings";
  return withComponent(snapshot, args, component => {
    const props = { ...component.props, [kind]: { ...component.props[kind], [target]: binding }, [other]: { ...component.props[other] } };
    delete props[other]![target];
    return { ...component, props };
  });
}
function removeBinding(snapshot: DesignerSnapshot, args: ToolArgs): Project {
  const target = textArg(args, "property") as BindingTarget;
  return withComponent(snapshot, args, component => {
    const props = { ...component.props, bindings: { ...component.props.bindings }, queryBindings: { ...component.props.queryBindings } };
    delete props.bindings[target]; delete props.queryBindings[target];
    return { ...component, props };
  });
}
function setComponentSection(snapshot: DesignerSnapshot, args: ToolArgs): Project {
  const section = textArg(args, "section");
  exactKeys({ [section]: true }, ["events", "componentEvents", "messageHandlers", "customProperties", "stateBinding", "dataSource", "tableEdit", "rowsSource", "parameterBindings", "parameters", "viewLayout", "optionsSource"]);
  componentFor(snapshot, args);
  return withComponent(snapshot, args, component => ({ ...component, props: { ...component.props, [section]: structuredClone(args.value) } }));
}
function setProjectSection(snapshot: DesignerSnapshot, args: ToolArgs): Project {
  const section = textArg(args, "section");
  exactKeys({ [section]: true }, ["parameters", "navigation", "sessionState", "styles", "localization", "authoringDefaults", "commands"]);
  return { ...snapshot.project, [section]: structuredClone(args.value) };
}
function bulkReplace(snapshot: DesignerSnapshot, args: ToolArgs): Project {
  const request = record(args.request, "request") as unknown as BulkReplaceRequest;
  const plan = planBulkReplacement(snapshot.project, request);
  return applyBulkReplacement(plan, snapshot.project, idsArg(args, "changeIds"));
}
function convertToTemplate(snapshot: DesignerSnapshot, args: ToolArgs): Project {
  const doc = documentFor(snapshot, args), ids = idsArg(args), selected = doc.components.filter(item => ids.includes(item.id));
  if (selected.length !== ids.length) throw new Error("Some components no longer exist.");
  const x = Math.min(...selected.map(item => item.x)), y = Math.min(...selected.map(item => item.y));
  const template: Template = { id: textArg(args, "templateId"), name: textArg(args, "name"), parameters: {}, width: Math.max(...selected.map(item => item.x + item.width)) - x,
    height: Math.max(...selected.map(item => item.y + item.height)) - y, components: selected.map(item => ({ ...structuredClone(item), x: item.x - x, y: item.y - y })) };
  // Original components remain until the separately reviewed replace/delete operation.
  return createDocument(snapshot, { documentKind: "template", document: template });
}
export const designerEdits: Record<string, DesignerEdit> = {
  spark_designer_create_document: createDocument, spark_designer_update_document: updateDocument, spark_designer_clone_document: cloneDocument,
  spark_designer_create_components: createComponents, spark_designer_update_components: updateComponents, spark_designer_arrange_components: arrange,
  spark_designer_change_resource: resourceChange, spark_designer_set_binding: setBinding, spark_designer_remove_binding: removeBinding,
  spark_designer_set_component_section: setComponentSection, spark_designer_set_project_section: setProjectSection,
  spark_designer_bulk_replace: bulkReplace, spark_designer_create_faceplate: convertToTemplate,
};
