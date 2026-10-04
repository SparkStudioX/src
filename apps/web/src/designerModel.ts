import { id, resolvePath } from "./api";
import { matchesModelRequirement, modelLeaves } from "./modelApi";
import type { ModelObject, ModelReadInstance } from "./modelApi";
import type { ModelDefinition } from "./modelWorkspace";
import { modelLeaves as definitionLeaves } from "./modelWorkspace";
import { resolveTemplateParameters } from "./templateModel";
import { templatePlacements } from "./viewContainers";
import type { CanvasComponent, ModelParameterRequirement, Project, Template } from "./types";
import type { DesignerDiagnostic } from "./designerDiagnostics";

/** Values remain standard tag widgets; no generated code or model-specific runtime is needed. */
export function createModelFaceplate(object: ModelObject, createId = id): Template {
  if (object.restrictedMembers) throw new Error("Creating a complete faceplate requires read access to every model member. Choose an instance you can fully read.");
  const leaves = modelLeaves(object.members);
  if (!leaves.length || leaves.length > 500) throw new Error("A faceplate needs 1–500 readable leaf members.");
  const columns = Math.max(1, Math.ceil(Math.sqrt(leaves.length))), width = columns * 256 + 16;
  return { id: createId("template"), name: `${object.definitionId} faceplate`, width, height: Math.ceil(leaves.length / columns) * 152 + 16,
    parameters: { machine: object.path }, parameterTypes: { machine: "model" }, modelParameters: { machine: { definitionId: object.definitionId } },
    components: leaves.map((leaf, index) => {
      const unit = leaf.metadata?.unit ?? "", label = leaf.modelPath.replaceAll("/", " · ");
      return { id: createId("value"), type: "value", x: 16 + index % columns * 256, y: 16 + Math.floor(index / columns) * 152, width: 240, height: 136,
        props: { text: unit.length > 32 ? `${label} (${unit})` : label, tagPath: `{machine}/${leaf.modelPath}`, unit: unit.length <= 32 ? unit : "" } };
    }) };
}

function memberPaths(component: CanvasComponent): string[] {
  const paths = typeof component.props.tagPath === "string" ? [component.props.tagPath] : [];
  for (const binding of Object.values(component.props.bindings ?? {})) for (const reference of Object.values(binding?.references ?? {})) if (reference.kind === "tag") paths.push(reference.path);
  return paths;
}
type AddDiagnostic = (template: Template, name: string, message: string, component?: CanvasComponent) => void;
function checkModelRequirement(project: Project, template: Template, name: string, requirement: ModelParameterRequirement,
  definitions: ModelDefinition[], instances: ModelReadInstance[], memberSet: (type: ModelDefinition) => Set<string>, add: AddDiagnostic) {
  const types = definitions.filter(type => matchesModelRequirement({ definitionId: type.id, version: type.version }, requirement));
  if (!types.length) { add(template, name, `Unresolved model requirement: '${requirement.definitionId}' has no readable version in the required range. Configure the gateway model; project packages do not contain gateway types.`); return; }
  let path: string;
  try { path = resolvePath(template.parameters[name], project.parameters); } catch { path = ""; }
  const instance = instances.find(item => item.path === path);
  if (path && !path.includes("{") && (!instance || !matchesModelRequirement(instance, requirement))) add(template, name, `Model parameter '${name}' default '${path}' is missing, unreadable, or incompatible with its type/version requirement.`);
  for (const component of template.components) for (const binding of memberPaths(component)) {
    const prefix = `{${name}}/`; if (!binding.startsWith(prefix)) continue;
    const member = binding.slice(prefix.length);
    for (const type of types) {
      if (!memberSet(type).has(member)) add(template, name, `Binding '${binding}' is not a readable member of ${type.id} v${type.version}. Update the binding or narrow the required version range.`, component);
    }
  }
}
function modelPlacementDiagnostics(project: Project, instances: ModelReadInstance[]): DesignerDiagnostic[] {
  const rows: DesignerDiagnostic[] = [];
  for (const document of [...project.screens, ...(project.templates ?? [])]) for (const component of document.components.flatMap(item => item.type === "viewContainer" ? templatePlacements(item) : [item])) {
    const template = project.templates?.find(item => item.id === component.props.templateId);
    if (!template || component.props.rowsSource || Object.keys(component.props.parameterBindings ?? {}).length) continue;
    for (const row of component.type === "repeater" ? component.props.rows ?? [] : [undefined]) {
      const root = { ...project.parameters, ...document.parameters };
      const resolved = resolveTemplateParameters(template, root, component.props.parameters, row?.parameters);
      for (const [name, requirement] of Object.entries(template.modelParameters ?? {})) {
        const path = resolved.parameters?.[name]; if (typeof path !== "string" || path.includes("{")) continue;
        const instance = instances.find(item => item.path === path);
        if (instance && matchesModelRequirement(instance, requirement)) continue;
        rows.push(modelPlacementDiagnostic(project, document, component, row?.id, name, path, requirement));
      }
    }
  }
  return rows;
}
function modelPlacementDiagnostic(project: Project, document: Project["screens"][number] | Template, component: CanvasComponent,
  rowId: string | undefined, name: string, path: string, requirement: ModelParameterRequirement): DesignerDiagnostic {
  return { id: `model-placement:${document.id}:${component.id}:${rowId ?? ""}:${name}`, category: "model", level: "error",
    location: `${document.name} / ${component.id}${rowId ? ` / ${rowId}` : ""}`, message: `Model parameter '${name}' selects '${path}', which is missing, unreadable or outside ${requirement.definitionId}'s required version range.`,
    target: { kind: project.screens.includes(document) ? "screen" : "template", id: document.id, componentId: component.id, property: "props.parameters" } };
}
export function collectModelDiagnostics(project: Project, definitions: ModelDefinition[], instances: ModelReadInstance[]): DesignerDiagnostic[] {
  const rows: DesignerDiagnostic[] = [];
  const members = new Map<string, Set<string>>();
  const memberSet = (type: ModelDefinition) => {
    const key = `${type.id}@${type.version}`; if (!members.has(key)) members.set(key, new Set(definitionLeaves(type, definitions).map(leaf => leaf.path)));
    return members.get(key)!;
  };
  const add: AddDiagnostic = (template, name, message, component) => rows.push({
    id: `model:${template.id}:${name}:${component?.id ?? "parameter"}:${rows.length}`, category: "model", level: "error",
    location: `Templates / ${template.name} / ${component?.id ?? name}`, message,
    target: { kind: "template", id: template.id, ...(component ? { componentId: component.id, property: "props.tagPath" } : {}) },
  });
  for (const template of project.templates ?? []) for (const [name, requirement] of Object.entries(template.modelParameters ?? {})) {
    checkModelRequirement(project, template, name, requirement, definitions, instances, memberSet, add);
  }
  return [...rows, ...modelPlacementDiagnostics(project, instances)].slice(0, 1000);
}
