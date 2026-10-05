import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Connection, Tag } from "./types";
import { useAskSpark } from "./askSparkContext";
import { downloadModelExport } from "./modelWorkspaceDownload";
import { modelDraftChangeSummary, modelDraftPackage } from "./modelDraft";
import { recordModelNavigationLocation, registerModelNavigationGuard } from "./modelNavigation";
import ModelOperationsPanel, { type ModelOperationTool } from "./modelOperationsPanel";
import ModelBuilder, { emptyBuilderModel } from "./modelBuilder";
import ModelWorkspaceSettings from "./modelWorkspaceSettings";
import ModelExplorer, { modelInstanceHealth, modelPathName, modelRoot, type ModelFocus, type ModelLens } from "./modelExplorer";
import ModelMachineView from "./modelMachineView";
import ModelLocationView from "./modelLocationView";
import { addModelLocation, moveModelInstances } from "./modelWorkspaceNamespace";
import { BuilderDialog } from "./modelBuilderPanels";
import { ModelDiscardConfirmation, ModelImportPanel, ModelWorkspaceReviewPanel } from "./modelWorkspacePanels";
import { useModelWorkspace } from "./useModelWorkspace";
import ModelMenu from "./ModelMenu";
import { definitionKey, modelProviderStatus, type ModelDraft, type ModelPackage } from "./modelWorkspace";
import "./accountSettings.css";
import "./modelWorkspace.css";
import "./modelExplorer.css";

type Workspace = ReturnType<typeof useModelWorkspace>;
type OperationRequest = { tool: ModelOperationTool; requestId: number; equipmentPath?: string };
type Route = { lens: ModelLens; focus: ModelFocus };

/** Old `view` values keep working: build opens the model list, namespace the plant overview and operate the tools. */
function initialRoute(): Route {
  const params = new URLSearchParams(window.location.search), view = params.get("view") || "", type = params.get("type") || "", item = params.get("item") || "";
  if (view === "settings") return { lens: "plant", focus: { kind: "settings" } };
  if (view === "operate" || view === "tools") return { lens: "plant", focus: { kind: "tools" } };
  if (type || view === "models" || view === "build") return { lens: "models", focus: { kind: "model", key: type } };
  if (item) return { lens: "plant", focus: params.get("kind") === "machine" ? { kind: "machine", path: item } : { kind: "location", path: item } };
  return { lens: "plant", focus: { kind: "home" } };
}
function routeUrl(focus: ModelFocus): URL {
  const url = new URL(window.location.href);
  for (const key of ["section", "type", "item", "kind"]) url.searchParams.delete(key);
  if (focus.kind !== "tools") url.searchParams.delete("tool");
  url.searchParams.set("workspace", "models");
  url.searchParams.set("view", focus.kind === "model" ? "models" : focus.kind === "tools" || focus.kind === "settings" ? focus.kind : "plant");
  if (focus.kind === "model" && focus.key) url.searchParams.set("type", focus.key);
  if (focus.kind === "machine" || focus.kind === "location") { url.searchParams.set("item", focus.path); url.searchParams.set("kind", focus.kind); }
  return url;
}
/** Where a review or issue link should land: a model, a machine (also for its fields), a location or data settings. */
function navigationFocus(model: ModelPackage, target: string): ModelFocus | undefined {
  const type = model.udtDefinitions.find(item => definitionKey(item) === target);
  if (type) return { kind: "model", key: definitionKey(type) };
  const instance = model.instances.find(item => target === item.path || target.startsWith(item.path + "/"));
  if (instance) return { kind: "machine", path: instance.path };
  if (model.hierarchy.some(item => item.path === target)) return { kind: "location", path: target };
  if (target === "default" || model.scanGroups.some(item => item.name === target)) return { kind: "settings" };
  return undefined;
}
const lensFor = (focus: ModelFocus, lens: ModelLens): ModelLens => focus.kind === "model" ? "models" : focus.kind === "machine" || focus.kind === "location" ? "plant" : lens;
function selectedModelKey(focus: ModelFocus, selectedType: string, model?: ModelPackage): string {
  if (focus.kind !== "model") return selectedType;
  const first = model?.udtDefinitions[0];
  return focus.key || selectedType || (first ? definitionKey(first) : "");
}
const isEmptyModel = (model?: ModelPackage) => Boolean(model && !model.udtDefinitions.length && !model.instances.length && !model.hierarchy.length);
const machineLocation = (focus: ModelFocus) => focus.kind === "location" ? focus.path : focus.kind === "machine" ? focus.path.slice(0, focus.path.lastIndexOf("/")) : modelRoot;
function latestDraftKey(model: ModelPackage, draft: ModelDraft): string {
  const candidates = draft.definition ? model.udtDefinitions.filter(item => item.id === draft.definition!.id) : [];
  return candidates.length ? definitionKey(candidates.reduce((a, b) => a.version > b.version ? a : b)) : "";
}
function downloadDraft(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  try { const link = document.createElement("a"); link.href = url; link.download = "sparkstudio-model-draft.json"; link.click(); } finally { URL.revokeObjectURL(url); }
}

function ModelRecoveryNotice({ workspace }: { workspace: Workspace }) {
  const [confirming, setConfirming] = useState(false);
  if (!workspace.recoveryWarning) return null;
  return <div className="model-notice"><p className="model-warning" role="alert">{workspace.recoveryWarning}</p>{workspace.recoveryDraft && <div className="model-actions"><button type="button" className="button" onClick={() => downloadDraft(workspace.recoveryDraft)}>Export recovered draft</button><button type="button" className="button danger" disabled={workspace.busy} onClick={() => setConfirming(true)}>Discard recovered draft</button></div>}{confirming && <ModelDiscardConfirmation title="Discard the recovered session draft?" description="This removes the saved draft that could not be restored. Export it first if you want to recover its contents. Your current workspace edits are kept." onCancel={() => setConfirming(false)} onConfirm={() => { workspace.discardRecovery(); setConfirming(false); }} />}</div>;
}

type NewActions = { fromData: () => void; fromTemplate: () => void; blank: () => void; machine: () => void; location: () => void };
function ModelHeader({ id, workspace, status, query, onQuery, locked, actions, onImport, onDiscard, onSettings, onTools }: { id: string; workspace: Workspace; status: { label: string; degraded: boolean }; query: string; onQuery: (value: string) => void; locked: boolean; actions: NewActions; onImport: () => void; onDiscard: () => void; onSettings: () => void; onTools: () => void }) {
  const { state, busy, changes } = workspace;
  async function exportSaved() { try { await downloadModelExport(); } catch (reason) { workspace.setError(reason instanceof Error ? reason.message : String(reason)); } }
  return <header className="model-ws-header page-heading">
    <div className="model-title-line"><h1 id={`${id}-title`}>Models</h1><span className={`model-status-pill ${status.degraded ? "degraded" : ""}`} title="Gateway tag status, including tags outside these models" aria-label={`Gateway tag status: ${status.label}. Includes tags outside these models.`}>{status.label}</span></div>
    <label className="model-ws-search"><input type="search" aria-label="Search machines, models and locations" value={query} placeholder="Search machines, models, locations" onChange={event => onQuery(event.target.value)} /></label>
    <div className="model-ws-actions">
      <ModelMenu label="Import / export" items={[
        { label: "Import into draft", icon: "upload", disabled: !state || busy, onSelect: onImport },
        { label: "Export saved model", icon: "download", disabled: !state || busy, onSelect: () => void exportSaved() },
        { label: "Export draft", icon: "download", disabled: !changes.length || busy, onSelect: () => { if (state) downloadDraft(JSON.stringify(modelDraftPackage(state.base, state.present), null, 2)); } }
      ]} />
      <ModelMenu label="New" icon="plus" primary disabled={locked || !state} items={[
        { label: "Model from connected data", description: "Pick tags from a machine; the model is built from them", icon: "plug", onSelect: actions.fromData },
        { label: "Model from a template", description: "Motor, pump, press, OEE and more", icon: "layers", onSelect: actions.fromTemplate },
        { label: "Blank model", description: "Name your model and add fields one at a time", icon: "plus", onSelect: actions.blank },
        { label: "Machine", description: "Use a model for a real machine", icon: "equipment-symbol", onSelect: actions.machine },
        { label: "Location", description: "Site, area, line or cell", icon: "folder", onSelect: actions.location }
      ]} />
      <ModelMenu label="Model workspace actions" icon="more" iconOnly items={[
        { label: "Undo", icon: "undo", disabled: busy || !state?.past.length, onSelect: workspace.undo },
        { label: "Redo", icon: "redo", disabled: busy || !state?.future.length, onSelect: workspace.redo },
        { label: "Check & share tools", icon: "activity", disabled: locked, onSelect: onTools },
        { label: "Data update settings", icon: "settings", disabled: locked, onSelect: onSettings },
        { label: "Discard draft", icon: "trash", danger: true, disabled: busy || !changes.length, onSelect: onDiscard }
      ]} />
    </div>
  </header>;
}

function ModelDraftBar({ workspace, locked, onDiscard }: { workspace: Workspace; locked: boolean; onDiscard: () => void }) {
  const { changes, busy, reviewOpen } = workspace;
  if (!changes.length || reviewOpen) return null;
  return <div className="model-draft-bar" role="status"><span className="model-draft-dot" aria-hidden="true" /><span className="model-draft-text"><strong>{changes.length} change{changes.length === 1 ? "" : "s"}</strong><small>{modelDraftChangeSummary(changes)} · Not live until you apply</small></span>
    <button type="button" className="button small" disabled={busy || !workspace.state?.past.length} onClick={workspace.undo}>Undo</button>
    <button type="button" className="button small" disabled={busy} onClick={onDiscard}>Discard</button>
    <button type="button" className="button small primary" disabled={busy || locked} onClick={() => void workspace.preview()}>Review &amp; apply</button></div>;
}

function ModelFirstRun({ actions, onImport }: { actions: NewActions; onImport: () => void }) {
  return <section className="model-first-run" aria-label="Start modeling">
    <h2>Describe your equipment once. Reuse it everywhere.</h2>
    <p>A model lists the values a kind of machine has, like a press’s speed and part count. Add your machines, and every screen, alarm and report can use the same names.</p>
    <div className="model-start-cards">
      <button type="button" className="model-start-card recommended" onClick={actions.fromData}><span className="model-start-badge">Recommended</span><strong>Start from connected data</strong><span>Pick values from a machine you already connect to. Similar machines can be added in one step.</span></button>
      <button type="button" className="model-start-card" onClick={actions.fromTemplate}><strong>Start from a template</strong><span>Begin with a working Motor, Pump, Press or OEE example, then link it to your data.</span></button>
      <button type="button" className="model-start-card" onClick={actions.blank}><strong>Start blank</strong><span>Name your model and add fields one at a time. Good when the data isn’t connected yet.</span></button>
    </div>
    <dl className="model-concepts"><div><dt>Models</dt><dd>The shape of a kind of machine: its fields, units and data rules.</dd></div><div><dt>Machines</dt><dd>Real equipment that uses a model, each with its own data source.</dd></div><div><dt>Locations</dt><dd>Where machines sit: site, area, line or cell.</dd></div></dl>
    <button type="button" className="button small" onClick={onImport}>Import a model file</button>
  </section>;
}

function AddMachineDialog({ model, location, onClose, onAdd }: { model: ModelPackage; location: string; onClose: () => void; onAdd: (model: ModelPackage, path: string) => void }) {
  const latest = useMemo(() => [...new Map(model.udtDefinitions.slice().sort((a, b) => a.version - b.version).map(type => [type.id, type])).values()].sort((a, b) => a.id.localeCompare(b.id)), [model.udtDefinitions]);
  const locations = useMemo(() => [...new Set([location, ...model.hierarchy.map(node => node.path)])].filter(path => path !== modelRoot).sort(), [location, model.hierarchy]);
  const [type, setType] = useState(latest[0] ? definitionKey(latest[0]) : ""), [parent, setParent] = useState(location === modelRoot ? locations[0] || "[default]Equipment" : location), [name, setName] = useState(""), [error, setError] = useState("");
  const chosen = latest.find(item => definitionKey(item) === type), suggested = chosen ? `${chosen.id}${model.instances.filter(item => item.definitionId === chosen.id).length + 1}` : "";
  function add() {
    const value = (name || suggested).trim(), path = `${parent}/${value}`;
    if (!chosen) { setError("Create a model first."); return; }
    if (!value || /[/\\[\]{}]/.test(value)) { setError("Use a name without slashes, brackets or braces."); return; }
    if (model.instances.some(item => item.path === path)) { setError(`A machine named ${value} already exists there.`); return; }
    if (model.instances.length >= 2000) { setError("The gateway supports at most 2,000 machines."); return; }
    onAdd({ ...model, instances: [...model.instances, { path, definitionId: chosen.id, version: chosen.version, enabled: true, parameters: {}, overrides: {} }] }, path);
  }
  return <BuilderDialog title="Add a machine" onClose={onClose}>
    {!latest.length ? <p>Create a model first, then add machines that use it.</p> : <>
      <label>Model<select value={type} onChange={event => setType(event.target.value)}>{latest.map(item => <option key={item.id} value={definitionKey(item)}>{item.id} · v{item.version}</option>)}</select></label>
      <label>Location<input list="model-add-machine-locations" value={parent} onChange={event => setParent(event.target.value)} /></label><datalist id="model-add-machine-locations">{locations.map(path => <option key={path} value={path} />)}</datalist>
      <label>Machine name<input value={name} placeholder={suggested} onChange={event => setName(event.target.value)} /></label>
      <p className="model-help">You’ll fill in this machine’s settings, such as its device name, on the next page.</p>
      {error && <p className="model-warning" role="alert">{error}</p>}
      <footer><button type="button" className="button primary" onClick={add}>Add machine</button></footer></>}
  </BuilderDialog>;
}

type DetailProps = { workspace: Workspace; focus: ModelFocus; selectedType: string; tags?: Tag[]; connections: Connection[]; focusTarget: string; libraryRequest: number; health: ReturnType<typeof modelInstanceHealth>;
  announce: (text: string) => void; onFocus: (focus: ModelFocus) => void; onSelectType: (key: string) => void; navigate: (path: string) => void; onContextChange: (next: { selection: string[]; resolution: string[] }) => void;
  onLockChange: (locked: boolean) => void; requestedTool?: OperationRequest; openTool: (tool: ModelOperationTool, path?: string) => void; onAddMachine: (location: string) => void; onAddLocation: (parent: string) => void };
function ModelDetail(props: DetailProps) {
  const { workspace, focus } = props, { state, data } = workspace;
  const live = props.tags ?? data.live, connections = data.connections.length ? data.connections : props.connections;
  const sourceTags = useMemo(() => { const values = new Map(live.map(tag => [tag.path, tag])); return data.definitions.map(tag => ({ ...tag, liveDataType: values.get(tag.path)?.dataType })); }, [data.definitions, live]);
  if (!state) return null;
  if (focus.kind === "machine") return <ModelMachineView model={state.present} savedModel={state.base} path={focus.path} sourceTags={sourceTags} liveTags={live} onChange={workspace.change} onFocus={props.onFocus} onOpenModel={(key, member) => props.navigate(member ? `${key}\n${member}` : key)} onTool={props.openTool} onAnnounce={props.announce} />;
  if (focus.kind === "location" || focus.kind === "home") return <ModelLocationView model={state.present} path={focus.kind === "home" ? modelRoot : focus.path} liveTags={live} health={props.health} onChange={workspace.change} onFocus={props.onFocus} onAddMachine={props.onAddMachine} onAddLocation={props.onAddLocation} onAnnounce={props.announce} />;
  if (focus.kind === "tools") return <ModelOperationsPanel model={state.present} savedModel={state.base} onChange={workspace.change} connections={connections} tagPaths={data.definitions.map(item => item.path)} onNavigate={props.navigate} onSelect={key => props.onFocus({ kind: "model", key })} onLockChange={props.onLockChange} requestedTool={props.requestedTool} />;
  if (focus.kind === "settings") return <section className="model-page-card"><ModelWorkspaceSettings model={state.present} onChange={workspace.change} /></section>;
  return <ModelBuilder model={state.present} savedModel={state.base} definitions={data.definitions} tags={live} connections={connections} selectedType={props.selectedType} onSelectType={props.onSelectType} onChange={workspace.change} fromAskSpark={state.fromAskSpark} onAnnounce={props.announce} onContextChange={props.onContextChange} focusTarget={props.focusTarget} libraryRequest={props.libraryRequest} disabled={workspace.busy} onUseStarter={() => props.openTool("start")} onReview={() => void workspace.preview()} onVerify={path => props.openTool("live", path)} hasChanges={workspace.changes.length > 0} onIssues={path => props.openTool("issues", path)} />;
}

function useModelGuards(id: string, workspace: Workspace, locked: boolean) {
  const guard = useRef({ dirty: false, blocked: false, onBlocked: () => {}, discard: () => {} });
  guard.current = { dirty: workspace.changes.length > 0, blocked: locked, onBlocked: () => workspace.setError("Finish the current request or save/discard publisher edits before leaving this workspace."), discard: () => { if (workspace.busy) return; guard.current.dirty = false; workspace.discard(); } };
  useEffect(() => registerModelNavigationGuard(id, { isDirty: () => guard.current.dirty, isBlocked: () => guard.current.blocked, onBlocked: () => guard.current.onBlocked(), discard: () => guard.current.discard() }), [id]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (guard.current.dirty || guard.current.blocked) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload); return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  return guard;
}
function useAskSparkModelContext(id: string, value: { focus: ModelFocus; selectedType: string; changes: Workspace["changes"]; builderContext: { selection: string[]; resolution: string[] } }, dirty: () => boolean, refresh: unknown[]) {
  const ask = useAskSpark(), context = useRef(value); context.current = value;
  useEffect(() => ask.registerContext(`model-workspace:${id}`, () => {
    const current = context.current;
    return { section: "models", editorAvailable: false, documentId: undefined, documentName: undefined, documentKind: undefined, selectedComponentIds: [], selectedComponentNames: [], snapshotToken: undefined, selection: undefined, screenId: undefined, screenName: undefined, templateId: undefined,
      ...(dirty() ? { unsavedChanges: true } : {}), modelView: current.focus.kind, modelType: current.selectedType, modelSelection: current.builderContext.selection.slice(0, 20), modelResolution: current.builderContext.resolution.slice(0, 20),
      modelDraftSummary: current.changes.map(item => `${item.action} ${item.kind}: ${item.key}`).slice(0, 30).join("; ").slice(0, 4000) };
  }, 30), [ask.registerContext, id]);
  useEffect(() => { ask.refreshContext(); }, refresh);
}

export default function TagModels({ onApplied, connections = [], tags, initialDraft, ownerId = "" }: { onApplied: () => void; connections?: Connection[]; tags?: Tag[]; initialDraft?: ModelDraft; ownerId?: string }) {
  const id = useId(), workspace = useModelWorkspace(ownerId, initialDraft, onApplied);
  const { state, changes, busy, data, review, reviewOpen } = workspace;
  const [route, setRoute] = useState<Route>(() => initialDraft ? { lens: "models", focus: { kind: "model", key: "" } } : initialRoute());
  const [selectedType, setSelectedType] = useState(() => new URLSearchParams(window.location.search).get("type") || "");
  const [operationLocked, setOperationLocked] = useState(false), [operationRequest, setOperationRequest] = useState<OperationRequest>();
  const [focusTarget, setFocusTarget] = useState(""), [announcement, setAnnouncement] = useState(""), [query, setQuery] = useState(""), [libraryRequest, setLibraryRequest] = useState(0);
  const [discarding, setDiscarding] = useState(false), [importing, setImporting] = useState(false), [addingMachine, setAddingMachine] = useState<string>();
  const [builderContext, setBuilderContext] = useState<{ selection: string[]; resolution: string[] }>({ selection: [], resolution: [] });
  const locked = busy || operationLocked, live = tags ?? data.live, focus = route.focus;
  const guard = useModelGuards(id, workspace, locked);
  useAskSparkModelContext(id, { focus, selectedType, changes, builderContext }, () => guard.current.dirty, [route, selectedType, builderContext, state]);
  const onContextChange = useCallback((next: { selection: string[]; resolution: string[] }) => setBuilderContext(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next), []);
  const health = useMemo(() => state ? modelInstanceHealth(state.present, state.base, live) : new Map(), [state, live]);
  const modelKey = selectedModelKey(focus, selectedType, state?.present), empty = isEmptyModel(state?.present);
  function goTo(next: ModelFocus, lens = route.lens) {
    if (operationLocked && next.kind !== focus.kind) return;
    if (next.kind !== "tools") setOperationRequest(undefined);
    workspace.setNotice(""); setAnnouncement("");
    if (next.kind === "model" && next.key) setSelectedType(next.key);
    setRoute({ lens: lensFor(next, lens), focus: next });
  }
  function openTool(tool: ModelOperationTool, equipmentPath?: string) {
    if (locked) return;
    setOperationRequest(previous => ({ tool, equipmentPath, requestId: (previous?.requestId ?? 0) + 1 })); goTo({ kind: "tools" });
  }
  function change(next: ModelPackage) { workspace.change(next); }
  function newModel(fromData: boolean) {
    if (!state || locked) return;
    const type = emptyBuilderModel(state.present); change({ ...state.present, udtDefinitions: [...state.present.udtDefinitions, type] });
    goTo({ kind: "model", key: definitionKey(type) }); if (fromData) setLibraryRequest(value => value + 1);
    setAnnouncement(fromData ? "Name your model, then drag tags or a folder from the data library into Fields." : "Name your model, then add fields.");
  }
  function addLocation(parent: string) {
    if (!state || locked) return;
    const result = addModelLocation(state.present, parent || modelRoot); change(result.model); goTo({ kind: "location", path: result.path });
    setAnnouncement(`${result.level} added to your draft. Rename it under Location details.`);
  }
  function moveMachines(paths: string[], destination: string) {
    if (!state) return;
    try { change(moveModelInstances(state.present, paths, destination)); setAnnouncement(`Moved ${paths.map(modelPathName).join(", ")} to ${modelPathName(destination)}. Review changed paths before applying.`); }
    catch (reason) { setAnnouncement(reason instanceof Error ? reason.message : String(reason)); }
  }
  const focusedLocation = machineLocation(focus);
  const actions: NewActions = { fromData: () => newModel(true), fromTemplate: () => openTool("start"), blank: () => newModel(false), machine: () => setAddingMachine(focusedLocation), location: () => addLocation(focusedLocation) };
  function navigate(path: string) {
    if (!state) return;
    const [target, member = ""] = path.split("\n");
    setOperationRequest(undefined); setFocusTarget(member || target); workspace.setReviewOpen(false);
    const next = navigationFocus(state.present, target);
    if (next) goTo(next);
  }
  useEffect(() => { const url = routeUrl({ ...focus, ...(focus.kind === "model" ? { key: modelKey } : {}) } as ModelFocus); window.history.replaceState(window.history.state, "", url); recordModelNavigationLocation(); }, [focus, modelKey]);
  useEffect(() => {
    if (!initialDraft || !state) return;
    const key = latestDraftKey(state.present, initialDraft);
    if (key) goTo({ kind: "model", key }); else setRoute({ lens: "models", focus: { kind: "model", key: "" } });
  }, [initialDraft, state?.fromAskSpark]);
  const status = modelProviderStatus(data.health, data.definitions, live);
  return <div className="management-page model-workspace model-workspace-builder model-ws" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !busy && state) { event.preventDefault(); event.stopPropagation(); if (event.shiftKey) workspace.redo(); else workspace.undo(); }
  }}>
    <ModelHeader id={id} workspace={workspace} status={status} query={query} onQuery={setQuery} locked={locked} actions={actions} onImport={() => setImporting(true)} onDiscard={() => setDiscarding(true)} onSettings={() => goTo({ kind: "settings" })} onTools={() => goTo({ kind: "tools" })} />
    {workspace.notice && <div className="model-notice" role="status">{workspace.notice}</div>}<ModelRecoveryNotice workspace={workspace} />{workspace.error && !reviewOpen && <p className="security-error" role="alert">{workspace.error}</p>}
    {!state && !workspace.error && <p role="status">Loading model library…</p>}
    {state && (empty && focus.kind !== "tools" && focus.kind !== "model" ? <ModelFirstRun actions={actions} onImport={() => setImporting(true)} /> : <div className="model-ws-body">
      <ModelExplorer model={state.present} savedModel={state.base} health={health} focus={focus.kind === "model" ? { kind: "model", key: modelKey } : focus} lens={route.lens} query={query} disabled={locked} onLens={lens => setRoute(previous => ({ ...previous, lens }))} onFocus={goTo} onMove={moveMachines} onAddLocation={() => addLocation(focusedLocation)} onNewModel={() => newModel(false)} />
      <fieldset className="model-body model-ws-detail" disabled={busy}><ModelDetail workspace={workspace} focus={focus} selectedType={modelKey} tags={tags} connections={connections} focusTarget={focusTarget} libraryRequest={libraryRequest} health={health} announce={setAnnouncement} onFocus={goTo} onSelectType={key => goTo({ kind: "model", key })} navigate={navigate} onContextChange={onContextChange} onLockChange={setOperationLocked} requestedTool={operationRequest} openTool={openTool} onAddMachine={location => setAddingMachine(location)} onAddLocation={addLocation} /></fieldset>
    </div>)}
    <div className="model-live-region" role="status" aria-live="polite">{announcement}</div>
    <ModelDraftBar workspace={workspace} locked={locked} onDiscard={() => setDiscarding(true)} />
    {reviewOpen && state && <ModelWorkspaceReviewPanel review={review} error={workspace.error} count={changes.length} busy={busy} onApply={() => void workspace.apply()} onPreview={() => void workspace.preview()} onClose={() => workspace.setReviewOpen(false)} onDiscard={() => setDiscarding(true)} onNavigate={navigate} model={state.present} />}
    {importing && <ModelImportPanel onImport={workspace.importText} onClose={() => setImporting(false)} />}{discarding && <ModelDiscardConfirmation onCancel={() => setDiscarding(false)} onConfirm={() => { guard.current.discard(); setDiscarding(false); }} />}
    {addingMachine !== undefined && state && <AddMachineDialog model={state.present} location={addingMachine} onClose={() => setAddingMachine(undefined)} onAdd={(next, path) => { change(next); setAddingMachine(undefined); goTo({ kind: "machine", path }); setAnnouncement(`Added ${modelPathName(path)} to your draft. Fill in its settings below.`); }} />}
  </div>;
}
