import { useMemo, useState } from "react";
import { displayValue } from "./api";
import type { Tag } from "./types";
import Icon from "./Icon";
import type { ModelHierarchy, ModelPackage } from "./modelWorkspace";
import { LocationFields, nextModelLocationLevel, renameModelLocation } from "./modelWorkspaceNamespace";
import { ModelMetadataFields } from "./modelWorkspaceFields";
import { BuilderDialog } from "./modelBuilderPanels";
import { modelCrumb, modelHealthLabel, modelParentPath, modelPathName, modelRoot, type ModelFocus, type ModelHealth } from "./modelExplorer";

type Props = { model: ModelPackage; path: string; liveTags: Tag[]; health: Map<string, ModelHealth>; onChange: (model: ModelPackage) => void; onFocus: (focus: ModelFocus) => void; onAddMachine: (location: string) => void; onAddLocation: (parent: string) => void; onAnnounce: (message: string) => void };
const within = (path: string, root: string) => root === modelRoot ? path.startsWith(modelRoot) : path === root || path.startsWith(root + "/");
const childOf = (path: string, parent: string) => modelParentPath(path) === parent;
const pageSize = 60;

function childLocations(model: ModelPackage, parent: string): { path: string; level?: string }[] {
  const found = new Map<string, string | undefined>();
  for (const node of model.hierarchy) if (childOf(node.path, parent)) found.set(node.path, node.level);
  for (const item of [...model.hierarchy, ...model.instances]) {
    for (let path = modelParentPath(item.path); path && path !== parent && path !== modelRoot; path = modelParentPath(path))
      if (childOf(path, parent) && !found.has(path)) found.set(path, undefined);
  }
  return [...found].map(([path, level]) => ({ path, level })).sort((a, b) => a.path.localeCompare(b.path));
}
function machineValues(liveTags: Tag[], paths: string[]): Map<string, Tag[]> {
  const owned = new Set(paths), values = new Map<string, Tag[]>();
  for (const tag of liveTags) for (let path = modelParentPath(tag.path); path; path = modelParentPath(path)) {
    if (!owned.has(path)) continue;
    const list = values.get(path) ?? []; if (list.length < 3) list.push(tag); values.set(path, list); break;
  }
  return values;
}

export default function ModelLocationView(props: Props) {
  const { model, path } = props, root = path === modelRoot, node = model.hierarchy.find(item => item.path === path);
  const [page, setPage] = useState(0), [removing, setRemoving] = useState(false);
  const machines = useMemo(() => model.instances.filter(item => within(item.path, path)).sort((a, b) => a.path.localeCompare(b.path)), [model.instances, path]);
  const children = useMemo(() => childLocations(model, path), [model, path]);
  const shown = machines.slice(page * pageSize, page * pageSize + pageSize);
  const values = useMemo(() => machineValues(props.liveTags, shown.map(item => item.path)), [props.liveTags, shown]);
  const attention = machines.filter(item => props.health.get(item.path) === "warn").length;
  return <div className="model-detail-main">
    <section className="model-page-card model-page-head">
      <div className="model-page-title"><span className="model-crumb">{root ? "Gateway" : modelCrumb(path) || "Top level"}</span>
        <div className="model-title-row"><h2>{modelPathName(path)}</h2>{node && <span className="model-level-badge">{node.level}</span>}{!root && !node && <span className="model-level-badge">Folder</span>}</div>
        <p className="model-help">{machines.length} machine{machines.length === 1 ? "" : "s"}{attention ? ` · ${attention} need${attention === 1 ? "s" : ""} attention` : ""}{children.length ? ` · ${children.length} location${children.length === 1 ? "" : "s"} inside` : ""}</p></div>
      <div className="model-page-actions">
        <button type="button" className="button small" onClick={() => props.onAddLocation(path)}><Icon name="plus" size={16} />Location inside</button>
        <button type="button" className="button small primary" onClick={() => props.onAddMachine(path)}><Icon name="plus" size={16} />Add machine here</button>
      </div>
    </section>
    {children.length > 0 && <section className="model-page-card" aria-label="Locations inside"><header><h3>Locations</h3></header><div className="model-location-chips">{children.map(child => <button type="button" key={child.path} className="model-location-chip" onClick={() => props.onFocus({ kind: "location", path: child.path })}><strong>{modelPathName(child.path)}</strong><small>{child.level || "Folder"} · {model.instances.filter(item => within(item.path, child.path)).length} machines</small></button>)}</div></section>}
    <section aria-label="Machines" className="model-machine-cards">
      {shown.map(machine => <button type="button" key={machine.path} className="model-machine-card" onClick={() => props.onFocus({ kind: "machine", path: machine.path })}>
        <span className="model-card-title"><strong>{modelPathName(machine.path)}</strong><span className={`model-dot ${props.health.get(machine.path) || "waiting"}`} /></span>
        <small>{machine.definitionId} v{machine.version}{root ? ` · ${modelCrumb(machine.path) || "Top level"}` : ""}</small>
        <span className="model-card-values">{(values.get(machine.path) ?? []).map(tag => <span key={tag.path}><small title={modelPathName(tag.path)}>{modelPathName(tag.path)}</small><strong title={displayValue(tag.value)}>{displayValue(tag.value)}</strong></span>)}</span>
        <small className={`model-card-note ${props.health.get(machine.path) || "waiting"}`}>{modelHealthLabel[props.health.get(machine.path) || "waiting"]}</small>
      </button>)}
      <button type="button" className="model-machine-card model-machine-add" onClick={() => props.onAddMachine(path)}><Icon name="plus" size={20} /><span>Add machine here</span></button>
    </section>
    {machines.length > pageSize && <div className="model-actions"><button type="button" className="button small" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button><small>{page * pageSize + 1}–{Math.min(machines.length, page * pageSize + pageSize)} of {machines.length}</small><button type="button" className="button small" disabled={(page + 1) * pageSize >= machines.length} onClick={() => setPage(page + 1)}>Next</button></div>}
    {node && <LocationDetails {...props} node={node} onRemove={() => setRemoving(true)} />}
    {!root && !node && <section className="model-page-card model-form-section"><p className="model-help">This folder holds machines but isn’t a declared location yet. Declare it to give it a level such as Site or Line.</p><button type="button" className="button small" onClick={() => { const level = nextModelLocationLevel(model, modelParentPath(path)); props.onChange({ ...model, hierarchy: [...model.hierarchy, { path, level }] }); props.onAnnounce(`${modelPathName(path)} is now a ${level} in your draft.`); }}>Make this a location</button></section>}
    {removing && node && <BuilderDialog title={`Remove ${modelPathName(path)}?`} onClose={() => setRemoving(false)}><p>The location is removed from your draft. Machines inside keep their current paths.</p><footer><button type="button" className="button danger" onClick={() => { setRemoving(false); props.onChange({ ...model, hierarchy: model.hierarchy.filter(item => item !== node) }); props.onFocus({ kind: "location", path: modelParentPath(path) || modelRoot }); props.onAnnounce("Location removed from your draft."); }}>Remove location</button></footer></BuilderDialog>}
  </div>;
}

function LocationDetails(props: Props & { node: ModelHierarchy; onRemove: () => void }) {
  const { model, node } = props;
  const patch = (value: Partial<ModelHierarchy>) => props.onChange({ ...model, hierarchy: model.hierarchy.map(item => item === node ? { ...item, ...value } : item) });
  function rename(name: string) {
    const next = renameModelLocation(model, node.path, name), parent = modelParentPath(node.path);
    props.onChange(next); props.onFocus({ kind: "location", path: (parent === modelRoot ? modelRoot : parent + "/") + name.trim() });
    props.onAnnounce("Location renamed in your draft. Review its changed paths before applying.");
  }
  return <details className="model-page-card model-location-details model-disclosure"><summary>Location details</summary>
    <div className="model-form-section">
    <LocationFields key={node.path} node={node} onRename={rename} onPatch={patch} />
    <ModelMetadataFields value={node} onChange={patch} semantic={false} />
    <button type="button" className="button small danger" onClick={props.onRemove}>Remove location</button>
    </div>
  </details>;
}
