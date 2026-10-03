import catalog from "./askSparkDesignerTools.json";
import { designerComponentSchema } from "./askSparkDesignerSchema";
import { buildProjectSearch, findProjectReferences } from "./projectSearch";
import type { SearchReference } from "./projectSearch";
import { collectDesignerDiagnostics } from "./designerDiagnostics";
import { planResourceChange } from "./resourceChanges";
import type { ResourceChangeRequest } from "./resourceChanges";
import { planBulkReplacement } from "./bulkReplacement";
import type { BulkReplaceRequest } from "./bulkReplacement";
import { designerEdits } from "./askSparkDesignerEdits";
import { designerWorkflows } from "./askSparkDesignerWorkflows";
import { documentFor, exactKeys, idsArg, ownerKind, record, redactDesigner, safeValue, textArg } from "./askSparkDesignerModel";
import type { DesignerBridge, DesignerSnapshot, ToolArgs } from "./askSparkDesignerModel";

const edits = { ...designerEdits, ...designerWorkflows };
type Reader = (snapshot: DesignerSnapshot, args: ToolArgs) => unknown;
const readers: Record<string, Reader> = {
  spark_designer_inspect_context: snapshot => ({ projectId: snapshot.project.id, name: snapshot.project.name, revision: snapshot.project.revision, snapshotToken: snapshot.token,
    documentId: snapshot.documentId, documentKind: snapshot.documentKind, selectedComponentIds: snapshot.selectedComponentIds,
    screens: snapshot.project.screens.map(({ components, ...screen }) => ({ ...screen, componentCount: components.length })),
    templates: snapshot.project.templates?.map(({ components, ...template }) => ({ ...template, componentCount: components.length })) }),
  spark_designer_get_document: (snapshot, args) => ({ snapshotToken: snapshot.token, document: documentFor(snapshot, args) }),
  spark_designer_get_project_settings: snapshot => ({ snapshotToken: snapshot.token, parameters: snapshot.project.parameters, navigation: snapshot.project.navigation,
    sessionState: snapshot.project.sessionState, styles: snapshot.project.styles, localization: snapshot.project.localization, authoringDefaults: snapshot.project.authoringDefaults, commands: snapshot.project.commands }),
  spark_designer_component_schema: designerComponentSchema,
  spark_designer_search: (snapshot, args) => {
    const query = textArg(args, "query").toLowerCase();
    return buildProjectSearch(snapshot.project, snapshot.queries, snapshot.scripts).filter(entry => JSON.stringify(entry).toLowerCase().includes(query)).slice(0, 100);
  },
  spark_designer_find_references: (snapshot, args) => findProjectReferences(buildProjectSearch(snapshot.project, snapshot.queries, snapshot.scripts), record(args.reference, "reference") as unknown as SearchReference).slice(0, 100),
  spark_designer_review_resource_change: (snapshot, args) => {
    const { nextProject: _next, signature: _signature, ...review } = planResourceChange(snapshot.project, snapshot.queries, snapshot.scripts, record(args.request, "request") as unknown as ResourceChangeRequest);
    return { ...review, snapshotToken: snapshot.token };
  },
  spark_designer_review_bulk_replace: (snapshot, args) => {
    const { signature: _signature, ...review } = planBulkReplacement(snapshot.project, record(args.request, "request") as unknown as BulkReplaceRequest);
    return { ...review, snapshotToken: snapshot.token };
  },
  spark_designer_diagnose: (snapshot, args) => {
    const document = documentFor(snapshot, args);
    return collectDesignerDiagnostics({ project: snapshot.project, document, ownerKind: ownerKind(args),
      context: { components: document.components, tags: snapshot.tags, parameters: { ...snapshot.project.parameters, ...document.parameters }, inputs: {} },
      searchEntries: buildProjectSearch(snapshot.project, snapshot.queries, snapshot.scripts) });
  },
  spark_designer_document_project: snapshot => ({ name: snapshot.project.name, revision: snapshot.project.revision, generatedFrom: "Current unsaved draft",
    documents: [...snapshot.project.screens, ...snapshot.project.templates ?? []].map(document => ({ id: document.id, name: document.name, width: document.width, height: document.height,
      components: document.components.map(component => ({ id: component.id, type: component.type, props: component.props })) })),
    queries: snapshot.queries, scripts: snapshot.scripts, assets: snapshot.assets }),
};
const bounded = (value: unknown) => {
  const redacted = redactDesigner(value), serialized = JSON.stringify(redacted);
  if (serialized.length > 180_000) throw new Error("The result is too large. Inspect a specific document or search for a resource instead.");
  return redacted;
};
const providerTools = ["spark_designer_crop_image_assets"];
export const supportsDesignerTool = (name: string): boolean => !providerTools.includes(name) && catalog.some(tool => tool.name === name);
export function designerImplementedNames(): string[] { return [...Object.keys(readers), ...Object.keys(edits), ...providerTools, "spark_designer_validate", "spark_designer_select", "spark_designer_save", "spark_designer_preview", "spark_designer_apply_edits", "spark_designer_open_document", "spark_designer_capture_canvas"]; }

interface DraftChain { batchId: string; index: number; originalToken: string; latestToken: string }
const draftChains = new WeakMap<DesignerBridge, DraftChain>();
function checkedToken(bridge: DesignerBridge, snapshot: DesignerSnapshot, args: ToolArgs, context: ToolArgs): string {
  const supplied = textArg(args, "snapshotToken");
  if (supplied === snapshot.token) return supplied;
  const chain = draftChains.get(bridge);
  if (chain && chain.batchId === context.executionBatchId && chain.index + 1 === context.executionBatchIndex
    && supplied === chain.originalToken && chain.latestToken === snapshot.token) return snapshot.token;
  throw new Error("The draft changed. Inspect the current draft before applying this operation.");
}
function rememberDraft(bridge: DesignerBridge, before: DesignerSnapshot, after: DesignerSnapshot, args: ToolArgs, context: ToolArgs) {
  if (typeof context.executionBatchId !== "string" || !Number.isInteger(context.executionBatchIndex)) { draftChains.delete(bridge); return; }
  const previous = draftChains.get(bridge), requested = textArg(args, "snapshotToken");
  const continued = previous?.batchId === context.executionBatchId && previous.index + 1 === context.executionBatchIndex && previous.latestToken === before.token;
  draftChains.set(bridge, { batchId: context.executionBatchId, index: Number(context.executionBatchIndex), originalToken: continued ? previous.originalToken : requested, latestToken: after.token });
}
function applyEdits(snapshot: DesignerSnapshot, args: ToolArgs) {
  if (!Array.isArray(args.operations) || !args.operations.length || args.operations.length > 100) throw new Error("Supply 1–100 draft edit operations.");
  let project = snapshot.project;
  for (const value of args.operations) {
    const operation = record(value, "operation"); exactKeys(operation, ["name", "arguments"]);
    const name = textArg(operation, "name"), edit = edits[name];
    if (!edit) throw new Error("Batches may contain only draft edit tools; reads, navigation, saves and nested batches are not supported.");
    const parameters = record(operation.arguments, "arguments");
    if ("snapshotToken" in parameters) throw new Error("Set snapshotToken once on the batch, not on individual operations.");
    project = edit({ ...snapshot, project }, parameters);
  }
  return project;
}
function openDocument(bridge: DesignerBridge, snapshot: DesignerSnapshot, args: ToolArgs) {
  const document = documentFor(snapshot, args), kind = ownerKind(args);
  bridge.select(document.id, kind, []);
  const current = bridge.snapshot();
  if (current.documentId !== document.id || current.documentKind !== kind) throw new Error("The document did not open. Finish the current editor action and try again.");
  return { result: { opened: true, projectId: current.project.id, documentId: document.id, documentKind: kind, snapshotToken: current.token },
    contextUpdate: { surface: "designer", editorAvailable: true, projectId: current.project.id, projectName: current.project.name, revision: current.project.revision,
      documentId: document.id, documentKind: kind, documentName: document.name, selectedComponentIds: [], section: "designer", snapshotToken: current.token, unsavedChanges: current.unsavedChanges } };
}
async function captureCanvas(bridge: DesignerBridge, snapshot: DesignerSnapshot, signal: AbortSignal) {
  if (!bridge.capture) throw new Error("Canvas capture is unavailable in this workspace.");
  const image = await bridge.capture(signal) as { data: string; mimeType: string; name: string; width: number; height: number; canvasWidth?: number; canvasHeight?: number };
  signal.throwIfAborted();
  const current = bridge.snapshot();
  if (current.token !== snapshot.token || current.documentId !== snapshot.documentId || current.documentKind !== snapshot.documentKind) throw new Error("The canvas changed during capture. Capture it again.");
  return { result: { captured: true, documentId: snapshot.documentId, documentKind: snapshot.documentKind, snapshotToken: snapshot.token, width: image.width, height: image.height, canvasWidth: image.canvasWidth, canvasHeight: image.canvasHeight },
    images: [{ data: image.data, mimeType: image.mimeType, name: image.name }] };
}

async function applyDraft(bridge: DesignerBridge, name: string, args: ToolArgs, context: ToolArgs, snapshot: DesignerSnapshot, signal: AbortSignal) {
  const expected = checkedToken(bridge, snapshot, args, context);
  const edit = name === "spark_designer_apply_edits" ? applyEdits : edits[name];
  if (!edit) throw new Error("Unknown designer tool.");
  const next = edit(snapshot, args);
  await bridge.validate(next, signal); signal.throwIfAborted();
  bridge.commit(next, expected);
  const applied = bridge.snapshot(); rememberDraft(bridge, snapshot, applied, args, context);
  return { result: { applied: true, saved: false, published: false, snapshotToken: applied.token }, summary: "Updated the designer draft. Undo is available.",
    undo: () => bridge.commit(snapshot.project, applied.token) };
}

export async function executeDesignerTool(bridge: DesignerBridge, name: string, args: ToolArgs, context: Record<string, unknown>, signal: AbortSignal) {
  signal.throwIfAborted(); safeValue(args);
  const snapshot = bridge.snapshot();
  if (!context.projectId || context.projectId !== snapshot.project.id) throw new Error("The captured project is not open in this designer. Open it and send a new message.");
  if (readers[name]) return { result: bounded(readers[name](snapshot, args)) };
  if (name === "spark_designer_validate") return { result: await bridge.validate(snapshot.project, signal) };
  if (name === "spark_designer_preview") return { result: await bridge.preview(signal) };
  if (name === "spark_designer_open_document") return openDocument(bridge, snapshot, args);
  if (name === "spark_designer_capture_canvas") return captureCanvas(bridge, snapshot, signal);
  if (name === "spark_designer_select") {
    const document = documentFor(snapshot, args), ids = idsArg(args);
    if (ids.some(id => !document.components.some(item => item.id === id))) throw new Error("Component no longer exists.");
    bridge.select(document.id, ownerKind(args), ids);
    return { result: { selected: ids } };
  }
  if (name === "spark_designer_save") {
    if (textArg(args, "snapshotToken") !== snapshot.token) throw new Error("The draft changed. Inspect the current draft before saving.");
    return { result: await bridge.save(snapshot.token, signal), summary: "Saved project draft. Publication is a separate action." };
  }
  return applyDraft(bridge, name, args, context, snapshot, signal);
}
