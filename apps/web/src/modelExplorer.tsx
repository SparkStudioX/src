import { useMemo, useState } from "react";
import type { DragEvent } from "react";
import type { Tag } from "./types";
import { definitionKey, type ModelDefinition, type ModelPackage } from "./modelWorkspace";
import { writeBuilderDrag } from "./modelBuilderLibrary";

export type ModelFocus = { kind: "home" } | { kind: "model"; key: string } | { kind: "machine"; path: string } | { kind: "location"; path: string } | { kind: "tools" } | { kind: "settings" };
export type ModelLens = "plant" | "models";
export type ModelHealth = "good" | "warn" | "waiting" | "draft" | "off";
export interface ModelPlantRow { path: string; name: string; kind: "location" | "folder" | "machine"; depth: number; level?: string; type?: string; version?: number; hasChildren: boolean }
export interface ModelTypeEntry { id: string; latest: ModelDefinition; versions: { key: string; version: number; draft: boolean }[]; usage: number; draft: boolean }

export const modelRoot = "[default]";
const instanceDrag = "application/x-spark-model-instance";
export const modelParentPath = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : path === modelRoot ? "" : modelRoot;
export const modelPathName = (path: string) => path === modelRoot ? "All equipment" : path.replace(/^\[default\]/, "").split("/").at(-1) || path;
export const modelCrumb = (path: string) => modelParentPath(path).replace(/^\[default\]\/?/, "").split("/").filter(Boolean).join(" › ");
export const modelHealthLabel: Record<ModelHealth, string> = { good: "Receiving good data", warn: "Needs attention", waiting: "Waiting for data", draft: "Not applied yet", off: "Turned off" };
const isGood = (quality?: string) => /^Good/i.test(quality || "");

/** Cheap per-machine status for navigation: one pass over live values, walking each tag up to its owning machine. */
export function modelInstanceHealth(model: ModelPackage, saved: ModelPackage, tags: Tag[]): Map<string, ModelHealth> {
  const savedKeys = new Set(saved.instances.map(item => `${item.path}\n${item.definitionId}\n${item.version}`));
  const machines = new Set(model.instances.map(item => item.path)), counts = new Map<string, { good: number; bad: number }>();
  for (const tag of tags) {
    for (let path = modelParentPath(tag.path); path; path = modelParentPath(path)) {
      if (!machines.has(path)) continue;
      const count = counts.get(path) ?? { good: 0, bad: 0 };
      if (isGood(tag.quality)) count.good++; else count.bad++;
      counts.set(path, count); break;
    }
  }
  const health = (path: string, key: string, enabled?: boolean): ModelHealth => {
    if (enabled === false) return "off";
    if (!savedKeys.has(key)) return "draft";
    const count = counts.get(path);
    return !count ? "waiting" : count.bad ? "warn" : "good";
  };
  return new Map(model.instances.map(item => [item.path, health(item.path, `${item.path}\n${item.definitionId}\n${item.version}`, item.enabled)]));
}

function plantNodes(model: ModelPackage): Map<string, ModelPlantRow> {
  const nodes = new Map<string, ModelPlantRow>();
  const add = (path: string, patch: Partial<ModelPlantRow>) => {
    if (!path || path === modelRoot) return;
    const parent = modelParentPath(path);
    if (parent && parent !== modelRoot && !nodes.has(parent)) add(parent, {});
    const depth = path.replace(/^\[default\]/, "").split("/").length - 1;
    nodes.set(path, { path, name: modelPathName(path), kind: "folder", depth, hasChildren: false, ...nodes.get(path), ...patch });
  };
  for (const node of model.hierarchy) add(node.path, { kind: "location", level: node.level });
  for (const instance of model.instances) add(instance.path, { kind: "machine", type: instance.definitionId, version: instance.version });
  for (const node of nodes.values()) { const parent = nodes.get(modelParentPath(node.path)); if (parent) parent.hasChildren = true; }
  return nodes;
}
const rowOrder = (a: ModelPlantRow, b: ModelPlantRow) => Number(a.kind === "machine") - Number(b.kind === "machine") || a.name.localeCompare(b.name);

/** Visible plant rows: locations first, then machines, honoring expansion unless a search is active. */
export function modelPlantRows(model: ModelPackage, expanded: Set<string>, query = ""): ModelPlantRow[] {
  const nodes = plantNodes(model), children = new Map<string, ModelPlantRow[]>();
  for (const node of nodes.values()) { const parent = modelParentPath(node.path); children.set(parent, [...children.get(parent) ?? [], node]); }
  const text = query.trim().toLowerCase(), include = new Set<string>();
  if (text) for (const node of nodes.values()) if (node.path.toLowerCase().includes(text)) for (let path = node.path; path && path !== modelRoot; path = modelParentPath(path)) include.add(path);
  const rows: ModelPlantRow[] = [];
  const visit = (parent: string) => {
    for (const node of [...children.get(parent) ?? []].sort(rowOrder)) {
      if (text && !include.has(node.path)) continue;
      rows.push(node);
      if (text || expanded.has(node.path)) visit(node.path);
    }
  };
  visit(modelRoot); return rows;
}

export function modelTypeEntries(model: ModelPackage, saved: ModelPackage, query = ""): ModelTypeEntry[] {
  const savedKeys = new Set(saved.udtDefinitions.map(definitionKey)), groups = new Map<string, ModelDefinition[]>();
  for (const type of model.udtDefinitions) groups.set(type.id, [...groups.get(type.id) ?? [], type]);
  const text = query.trim().toLowerCase();
  return [...groups.entries()].filter(([id]) => !text || id.toLowerCase().includes(text)).sort(([a], [b]) => a.localeCompare(b)).map(([id, types]) => {
    const sorted = [...types].sort((a, b) => b.version - a.version), latest = sorted[0];
    return { id, latest, usage: model.instances.filter(item => item.definitionId === id).length, draft: !savedKeys.has(definitionKey(latest)),
      versions: sorted.map(type => ({ key: definitionKey(type), version: type.version, draft: !savedKeys.has(definitionKey(type)) })) };
  });
}

type ExplorerProps = { model: ModelPackage; savedModel: ModelPackage; health: Map<string, ModelHealth>; focus: ModelFocus; lens: ModelLens; query: string; disabled?: boolean;
  onLens: (lens: ModelLens) => void; onFocus: (focus: ModelFocus) => void; onMove: (paths: string[], destination: string) => void; onAddLocation: () => void; onNewModel: () => void };
export default function ModelExplorer(props: ExplorerProps) {
  return <aside className="model-explorer" aria-label="Model explorer">
    <div className="model-lens" role="tablist" aria-label="Explorer view">
      <button type="button" role="tab" aria-selected={props.lens === "plant"} disabled={props.disabled} onClick={() => props.onLens("plant")}>Plant</button>
      <button type="button" role="tab" aria-selected={props.lens === "models"} disabled={props.disabled} onClick={() => props.onLens("models")}>Models</button>
    </div>
    {props.lens === "plant" ? <PlantTree {...props} /> : <ModelList {...props} />}
  </aside>;
}

const focusedPath = (focus: ModelFocus) => focus.kind === "machine" || focus.kind === "location" ? focus.path : "";
function initialExpansion(model: ModelPackage, focus: ModelFocus): Set<string> {
  const open = new Set(model.hierarchy.filter(node => node.path.replace(/^\[default\]/, "").split("/").length <= 3).map(node => node.path));
  for (let path = modelParentPath(focusedPath(focus)); path && path !== modelRoot; path = modelParentPath(path)) open.add(path);
  return open;
}
function PlantTree(props: ExplorerProps) {
  const [expanded, setExpanded] = useState(() => initialExpansion(props.model, props.focus)), [over, setOver] = useState("");
  const rows = useMemo(() => modelPlantRows(props.model, expanded, props.query), [props.model, expanded, props.query]);
  const toggle = (path: string) => setExpanded(previous => { const next = new Set(previous); if (!next.delete(path)) next.add(path); return next; });
  const declared = useMemo(() => new Set(props.model.hierarchy.map(node => node.path)), [props.model.hierarchy]);
  const drop = (event: DragEvent, path: string) => { event.preventDefault(); setOver(""); const machine = event.dataTransfer.getData(instanceDrag); if (machine && declared.has(path)) props.onMove([machine], path); };
  const selected = focusedPath(props.focus);
  return <>
    <button type="button" className={`model-tree-row model-tree-root${props.focus.kind === "location" && selected === modelRoot ? " selected" : ""}`} disabled={props.disabled} onClick={() => props.onFocus({ kind: "location", path: modelRoot })}><span className="model-tree-icon" aria-hidden="true">⌂</span><span className="model-tree-name">All equipment</span><small>{props.model.instances.length}</small></button>
    <div className="model-plant-tree" role="tree" aria-label="Locations and machines">
      {rows.slice(0, 500).map(row => <PlantRowItem key={row.path} row={row} selected={selected === row.path} expanded={expanded.has(row.path) || Boolean(props.query)} health={props.health.get(row.path)} over={over === row.path} disabled={props.disabled}
        onToggle={() => toggle(row.path)} onSelect={() => props.onFocus(row.kind === "machine" ? { kind: "machine", path: row.path } : { kind: "location", path: row.path })}
        onDragOver={event => { if (!declared.has(row.path) || !event.dataTransfer.types.includes(instanceDrag)) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setOver(row.path); }} onDragLeave={() => setOver("")} onDrop={event => drop(event, row.path)} />)}
      {rows.length > 500 && <p className="model-help">Showing 500 of {rows.length}. Search to narrow the list.</p>}
      {!rows.length && <p className="model-help">{props.query ? "Nothing matches your search." : "No locations or machines yet."}</p>}
    </div>
    <button type="button" className="button small model-explorer-add" disabled={props.disabled} onClick={props.onAddLocation}>＋ Add location</button>
  </>;
}
type RowProps = { row: ModelPlantRow; selected: boolean; expanded: boolean; health?: ModelHealth; over: boolean; disabled?: boolean; onToggle: () => void; onSelect: () => void; onDragOver: (event: DragEvent) => void; onDragLeave: () => void; onDrop: (event: DragEvent) => void };
function PlantRowItem({ row, selected, expanded, health, over, disabled, onToggle, onSelect, onDragOver, onDragLeave, onDrop }: RowProps) {
  const machine = row.kind === "machine";
  return <div role="treeitem" aria-level={row.depth + 1} aria-selected={selected} aria-expanded={row.hasChildren ? expanded : undefined} className={`model-tree-row${selected ? " selected" : ""}${over ? " drop-active" : ""}`} style={{ paddingLeft: 6 + Math.min(row.depth, 8) * 14 }}
    draggable={machine && !disabled} onDragStart={event => { if (!machine) return; event.dataTransfer.setData(instanceDrag, row.path); event.dataTransfer.effectAllowed = "move"; }} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
    {row.hasChildren ? <button type="button" className="model-tree-toggle" tabIndex={-1} disabled={disabled} aria-label={`${expanded ? "Collapse" : "Expand"} ${row.name}`} onClick={onToggle}>{expanded ? "▾" : "▸"}</button> : <span className="model-tree-toggle" aria-hidden="true" />}
    <button type="button" className="model-tree-label" disabled={disabled} onClick={onSelect} title={row.path}>
      {machine ? <span className={`model-dot ${health || "waiting"}`} title={modelHealthLabel[health || "waiting"]} /> : <span className="model-tree-icon" aria-hidden="true">▢</span>}
      <span className="model-tree-name">{row.name}</span><small>{machine ? `${row.type} v${row.version}` : row.level || "Folder"}</small>
    </button>
  </div>;
}
function ModelList(props: ExplorerProps) {
  const entries = useMemo(() => modelTypeEntries(props.model, props.savedModel, props.query), [props.model, props.savedModel, props.query]);
  const selected = props.focus.kind === "model" ? props.focus.key : "";
  return <>
    <div className="model-type-list" aria-label="Models">
      {entries.map(entry => <div key={entry.id} className={`model-type-item${entry.versions.some(version => version.key === selected) ? " selected" : ""}`}>
        <button type="button" className="model-type-open" disabled={props.disabled} draggable={!props.disabled} onDragStart={event => writeBuilderDrag(event, { kind: "type", path: definitionKey(entry.latest) })} onClick={() => props.onFocus({ kind: "model", key: definitionKey(entry.latest) })}>
          <strong>{entry.id}</strong><small>{entry.usage ? `Used by ${entry.usage} machine${entry.usage === 1 ? "" : "s"}` : "Not used yet"}{entry.draft ? " · draft" : ""}</small>
        </button>
        {entry.versions.length > 1 && <div className="model-version-chips" aria-label={`${entry.id} versions`}>{entry.versions.map(version => <button type="button" key={version.key} disabled={props.disabled} aria-pressed={version.key === selected} onClick={() => props.onFocus({ kind: "model", key: version.key })}>v{version.version}{version.draft ? " · draft" : ""}</button>)}</div>}
      </div>)}
      {!entries.length && <p className="model-help">{props.query ? "No models match your search." : "No models yet."}</p>}
    </div>
    <button type="button" className="button small model-explorer-add" disabled={props.disabled} onClick={props.onNewModel}>＋ New model</button>
  </>;
}
