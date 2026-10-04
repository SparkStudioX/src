import { useMemo, useRef, useState } from "react";
import { displayValue } from "./api";
import type { Tag } from "./types";
import { modelLeaves, modelLevels, type ModelPackage, type ModelExpandedTag, type ModelHierarchy, type ModelInstance } from "./modelWorkspace";
import { ModelMetadataFields } from "./modelWorkspaceFields";

interface NamespaceNode { path: string; name: string; kind: "folder" | "hierarchy" | "instance" | "member"; level?: string; type?: string; version?: number; instance?: string; tag?: ModelExpandedTag; live?: Tag; depth: number; outside?: boolean }
const parentPath = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : path === "[default]" ? "" : "[default]";
export const modelLocationName = (path: string) => path.replace(/^\[default\]/, "").split("/").at(-1) || "";
const withinLocation = (path: string, root: string) => path === root || path.startsWith(root + "/");
const locationPrefix = (parent: string) => parent === "[default]" ? parent : parent + "/";
export function nextModelLocationLevel(model: ModelPackage, parent: string): string {
  for (let path = parent; path; path = parentPath(path)) {
    const level = model.hierarchy.find(item => item.path === path)?.level;
    if (level && level !== "Custom") return modelLevels[modelLevels.indexOf(level) + 1] || "Custom";
  }
  return "Enterprise";
}
export function renameModelLocation(model: ModelPackage, path: string, name: string): ModelPackage {
  if (model.hierarchy.filter(item => item.path === path).length !== 1) throw new Error("Select one unique location to rename.");
  name = name.trim();
  if (!name || name === "." || name === ".." || /[/\\[\]{}]/.test(name) || [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159)) throw new Error("Enter a location name without slashes, brackets, braces or control characters.");
  const destination = locationPrefix(parentPath(path)) + name;
  if (destination === path) return model;
  const occupied = [...model.hierarchy, ...model.instances, ...model.tags as { path: string }[]];
  if (occupied.some(item => !withinLocation(item.path, path) && withinLocation(item.path, destination))) throw new Error(`A location or value already exists at ${destination}. Choose another name.`);
  const renamed = <T extends { path: string }>(item: T): T => {
    if (!withinLocation(item.path, path)) return item;
    const nextPath = destination + item.path.slice(path.length);
    if (nextPath.length > 512) throw new Error("Renaming would create a path longer than 512 characters.");
    return { ...item, path: nextPath };
  };
  return { ...model, hierarchy: model.hierarchy.map(renamed), instances: model.instances.map(renamed) };
}
function hasAncestor(path: string, paths: Set<string>, self = false): boolean { for (let value = self ? path : parentPath(path); value; value = parentPath(value)) if (paths.has(value)) return true; return false; }
export function visibleModelNamespace(nodes: NamespaceNode[], expanded: Set<string>): NamespaceNode[] { return nodes.filter(node => { for (let value = parentPath(node.path); value; value = parentPath(value)) if (!expanded.has(value)) return false; return true; }); }
export function modelNamespace(model: ModelPackage, definitions: ModelExpandedTag[], tags: Tag[]): NamespaceNode[] {
  const nodes = new Map<string, NamespaceNode>(), live = new Map(tags.map(tag => [tag.path, tag]));
  const hierarchy = new Set(model.hierarchy.map(node => node.path)), outside = (path: string) => !hasAncestor(path, hierarchy);
  function add(path: string, patch: Partial<NamespaceNode>) {
    if (!path) return;
    const parent = parentPath(path); if (parent && !nodes.has(parent)) add(parent, {});
    nodes.set(path, { path, name: path.replace(/^\[default\]/, "").split("/").at(-1) || "[default]", kind: "folder", depth: path === "[default]" ? 1 : path.split("/").length + 1, ...nodes.get(path), ...patch });
  }
  for (const node of model.hierarchy) add(node.path, { kind: "hierarchy", level: node.level });
  for (const instance of model.instances) add(instance.path, { kind: "instance", type: instance.definitionId, version: instance.version, instance: instance.path, outside: outside(instance.path) });
  for (const tag of definitions) add(tag.path, { kind: "member", tag, live: live.get(tag.path), type: tag.udtDefinition, instance: tag.udtInstance, outside: tag.udtInstance ? outside(tag.udtInstance) : false });
  return [...nodes.values()].sort((a, b) => a.path.localeCompare(b.path));
}
export function filterModelNamespace(nodes: NamespaceNode[], filter: { text: string; type: string; level: string; quality: string; outside: boolean }): NamespaceNode[] {
  const levels = new Set(nodes.filter(node => node.level === filter.level).map(node => node.path));
  const matching = nodes.filter(node => (!filter.text || node.path.toLowerCase().includes(filter.text.toLowerCase())) && (!filter.type || node.type === filter.type) && (!filter.level || hasAncestor(node.path, levels, true)) && (!filter.quality || (filter.quality === "Good" ? node.live?.quality === "Good" : Boolean(node.live && node.live.quality !== "Good"))) && (!filter.outside || node.outside));
  const paths = new Set<string>(); for (const node of matching) { let path = node.path; while (path) { paths.add(path); path = parentPath(path); } }
  return nodes.filter(node => paths.has(node.path));
}
export function moveModelInstances(model: ModelPackage, paths: string[], parent: string): ModelPackage {
  if (!model.hierarchy.some(node => node.path === parent)) throw new Error("Choose a location as the destination.");
  if (!paths.length) throw new Error("Select equipment to move.");
  if (paths.some(path => !model.instances.some(instance => instance.path === path))) throw new Error("A selected instance is no longer in this draft.");
  const selected = new Set(paths), occupied = new Set(model.instances.filter(item => !selected.has(item.path)).map(item => item.path));
  const instances = model.instances.map(instance => {
    if (!selected.has(instance.path)) return instance;
    const path = parent + "/" + instance.path.replace(/^\[default\]/, "").split("/").at(-1);
    if (occupied.has(path)) throw new Error(`An instance already exists at ${path}.`);
    occupied.add(path); return { ...instance, path };
  });
  return { ...model, instances };
}
function draftNamespaceDefinitions(model: ModelPackage, definitions: ModelExpandedTag[]): ModelExpandedTag[] {
  const saved = new Map(definitions.map(tag => [tag.path, tag]));
  return model.instances.flatMap(instance => {
    const type = model.udtDefinitions.find(item => item.id === instance.definitionId && item.version === instance.version);
    return type ? modelLeaves(type, model.udtDefinitions).map(member => {
      const path = instance.path + "/" + member.path;
      return { ...member, ...saved.get(path), path, dataType: member.dataType || "Unknown", udtInstance: instance.path, udtDefinition: instance.definitionId, udtVersion: instance.version };
    }) : [];
  });
}
function LocationFields({ node, onRename, onPatch }: { node: ModelHierarchy; onRename: (name: string) => void; onPatch: (value: Partial<ModelHierarchy>) => void }) {
  const [name, setName] = useState(() => modelLocationName(node.path)), [error, setError] = useState("");
  const rename = () => { try { onRename(name); setName(name.trim()); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const changed = name !== modelLocationName(node.path);
  return <><div className="model-grid"><label>Location name<input aria-label="Location name" value={name} onChange={event => { setName(event.target.value); setError(""); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); rename(); } else if (event.key === "Escape") { event.preventDefault(); setName(modelLocationName(node.path)); setError(""); } }} /></label><label>Location kind<select aria-label="Location kind" value={node.level} onChange={event => onPatch({ level: event.target.value })}>{modelLevels.map(level => <option key={level}>{level}</option>)}</select></label></div>
    {changed && <div className="model-actions"><button type="button" className="button small" onClick={rename}>Rename location</button><button type="button" className="button small" onClick={() => { setName(modelLocationName(node.path)); setError(""); }}>Cancel rename</button></div>}
    {error && <p className="security-error" role="alert">{error}</p>}<p className="model-field-help">Rename changes this location and the paths of its locations and equipment together. Source tags stay in place. Review affected screen bindings before applying.</p></>;
}
export default function ModelNamespace({ model, definitions, tags, onChange, onInstance, onAnnounce, focusTarget }: { model: ModelPackage; definitions: ModelExpandedTag[]; tags: Tag[]; onChange: (next: ModelPackage) => void; onInstance: (instance: ModelInstance) => void; onAnnounce: (message: string) => void; focusTarget?: string }) {
  const [filter, setFilter] = useState({ text: "", type: "", level: "", quality: "", outside: false });
  const [expanded, setExpanded] = useState(new Set(["[default]"])), [selected, setSelected] = useState(focusTarget || ""), [checked, setChecked] = useState<string[]>([]);
  const [page, setPage] = useState(0), [over, setOver] = useState(""), [removing, setRemoving] = useState(false);
  const tree = useRef<HTMLDivElement>(null);
  const all = useMemo(() => modelNamespace(model, draftNamespaceDefinitions(model, definitions), tags), [model, definitions, tags]);
  const filtered = useMemo(() => filterModelNamespace(all, filter), [all, filter]);
  const searching = Boolean(filter.text || filter.type || filter.level || filter.quality || filter.outside);
  const visible = searching ? filtered : visibleModelNamespace(filtered, expanded);
  const current = all.find(item => item.path === selected), node = model.hierarchy.find(item => item.path === selected);
  const offset = Math.min(page, Math.max(0, Math.ceil(visible.length / 100) - 1)) * 100;
  const toggle = (path: string, open?: boolean) => setExpanded(previous => { const next = new Set(previous); if (open ?? !next.has(path)) next.add(path); else next.delete(path); return next; });
  const setFilters = (next: Partial<typeof filter>) => { setFilter({ ...filter, ...next }); setPage(0); };
  function patch(value: Partial<ModelHierarchy>) {
    if (!node) return;
    onChange({ ...model, hierarchy: model.hierarchy.map(item => item.path === node.path ? { ...item, ...value } : item) });
  }
  function rename(name: string) {
    if (!node) return;
    const next = renameModelLocation(model, node.path, name), destination = locationPrefix(parentPath(node.path)) + name.trim();
    const remap = (path: string) => withinLocation(path, node.path) ? destination + path.slice(node.path.length) : path;
    onChange(next); setSelected(destination); setExpanded(previous => new Set([...previous].map(remap))); setChecked(previous => previous.map(remap));
    onAnnounce("Location renamed in your draft. Review its changed paths before applying.");
  }
  function addNode() {
    const parent = node?.path || "[default]", level = nextModelLocationLevel(model, parent), base = locationPrefix(parent) + (level === "Custom" ? "Location" : level);
    const occupied = [...model.hierarchy, ...model.instances, ...model.tags as { path: string }[]];
    let path = base, suffix = 2; while (occupied.some(item => item.path === path)) path = base + suffix++;
    onChange({ ...model, hierarchy: [...model.hierarchy, { path, level }] });
    setSelected(path); toggle(parent, true); onAnnounce(`${level} added to your draft. Give it a name in Details.`);
  }
  function move(paths: string[], destination: string) {
    try { onChange(moveModelInstances(model, paths, destination)); setChecked([]); toggle(destination, true); onAnnounce(`Moved ${paths.length} equipment instance${paths.length === 1 ? "" : "s"} under ${destination}. Review changes before applying.`); }
    catch (reason) { onAnnounce(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <><div className="model-section-intro"><h2>A place for every machine</h2><p>Arrange equipment in a shared tree so everyone can find it. This is your Unified Namespace (UNS).</p></div><div className="model-namespace"><section aria-label="Namespace hierarchy"><div className="model-actions"><strong>Locations</strong><button type="button" className="button small" onClick={addNode}>Add location</button><button type="button" className="button small" disabled={!checked.length || !node} onClick={() => move(checked, node!.path)}>Move {checked.length || "selected"} here</button></div>
    <p>Group equipment by company, site or production line. Drag equipment onto a location, or select it and choose Move selected here. Moving equipment changes its tag paths; review any affected screen bindings before applying.</p>
    <label>Find equipment or location<input placeholder="Search by name or path" value={filter.text} onChange={event => setFilters({ text: event.target.value })} /></label>
    <details className="model-namespace-filters"><summary>More filters</summary><div className="model-grid"><label>Model<select value={filter.type} onChange={event => setFilters({ type: event.target.value })}><option value="">All models</option>{[...new Set(model.udtDefinitions.map(item => item.id))].map(type => <option key={type}>{type}</option>)}</select></label><label>Location kind<select value={filter.level} onChange={event => setFilters({ level: event.target.value })}><option value="">All kinds</option>{modelLevels.map(level => <option key={level}>{level}</option>)}</select></label><label>Data status<select value={filter.quality} onChange={event => setFilters({ quality: event.target.value })}><option value="">Any status</option><option>Good</option><option value="unavailable">Unavailable / uncertain</option></select></label></div>
    <label className="model-checkbox"><input type="checkbox" checked={filter.outside} onChange={event => setFilters({ outside: event.target.checked })} />Equipment without a location</label></details>
    <div className="model-tree" role="tree" aria-label="Namespace" ref={tree}>{visible.slice(offset, offset + 100).map((item, index) => <div key={item.path} role="treeitem" tabIndex={selected === item.path || !selected && index === 0 ? 0 : -1} aria-level={item.depth} aria-expanded={item.kind !== "member" ? expanded.has(item.path) : undefined} aria-selected={selected === item.path} className={`${selected === item.path ? "selected" : ""} ${over === item.path ? "model-drop-active" : ""}`} style={{ paddingLeft: `${Math.min(item.depth - 1, 8) * 12}px` }}
      draggable={item.kind === "instance"} onDragStart={event => { if (item.kind === "instance") { event.dataTransfer.setData("application/x-spark-model-instance", item.path); event.dataTransfer.effectAllowed = "move"; } }}
      onDragOver={event => { if (!event.dataTransfer.types.includes("application/x-spark-model-instance")) return; event.preventDefault(); const valid = model.hierarchy.some(value => value.path === item.path); event.dataTransfer.dropEffect = valid ? "move" : "none"; if (valid) setOver(item.path); else onAnnounce("Drop equipment onto a location."); }} onDragLeave={() => setOver("")}
      onDrop={event => { event.preventDefault(); setOver(""); const path = event.dataTransfer.getData("application/x-spark-model-instance"); if (path) move(checked.includes(path) ? checked : [path], item.path); }}
      onKeyDown={event => { if (event.target !== event.currentTarget) return; const rows = [...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') || [])]; const at = rows.indexOf(event.currentTarget); if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus(); } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); toggle(item.path, event.key === "ArrowRight"); } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(item.path); } }}>
      {item.kind !== "member" && <button type="button" tabIndex={-1} aria-label={`${expanded.has(item.path) ? "Collapse" : "Expand"} ${item.path}`} onClick={() => toggle(item.path)}>{expanded.has(item.path) ? "▾" : "▸"}</button>}
      {item.kind === "instance" && <input type="checkbox" aria-label={`Select instance ${item.path}`} checked={checked.includes(item.path)} onChange={event => setChecked(event.target.checked ? [...checked, item.path] : checked.filter(path => path !== item.path))} />}
      <button type="button" className="model-tree-label" onClick={() => { setSelected(item.path); setRemoving(false); }}><strong>{item.name}</strong><small>{item.level || item.type && `${item.type}@${item.version || item.tag?.udtVersion}` || item.kind}{item.tag?.unit ? ` · ${item.tag.unit}` : ""}</small>{item.live && <span>{displayValue(item.live.value)} · {item.live.quality}</span>}</button></div>)}</div>
    <div className="model-actions"><small>{visible.length ? `${offset + 1}–${Math.min(offset + 100, visible.length)} of ${visible.length}` : "No matching locations or equipment"}</small><button type="button" className="button small" disabled={!offset} onClick={() => setPage(Math.max(0, page - 1))}>Previous</button><button type="button" className="button small" disabled={offset + 100 >= visible.length} onClick={() => setPage(page + 1)}>Next</button></div></section>
    <aside className="model-namespace-details" aria-label="Namespace details"><h3>Details</h3>{!current && <p>Select a location to edit it, or select equipment to open its model. Start with Add location to create your company or site.</p>}{current && <><p><code>{current.path}</code></p>{current.instance && <button type="button" className="button" onClick={() => { const instance = model.instances.find(item => item.path === current.instance); if (instance) onInstance(instance); }}>Open in builder</button>}</>}
      {node && <><LocationFields key={node.path} node={node} onRename={rename} onPatch={patch} /><ModelMetadataFields value={node} onChange={patch} semantic={false} /><p>Locations organize equipment without creating new data. For example: company → site → area → line. Use Custom for another kind of location.</p><button type="button" className="button danger" onClick={() => setRemoving(true)}>Remove location</button>
      {removing && <div className="model-card" role="alert"><p>Remove {node.path} from this draft? Its equipment stays at the same paths.</p><div className="model-actions"><button type="button" className="button" onClick={() => setRemoving(false)}>Keep location</button><button type="button" className="button danger" onClick={() => { onChange({ ...model, hierarchy: model.hierarchy.filter(item => item !== node) }); setRemoving(false); onAnnounce("Location removed from your draft."); }}>Remove location</button></div></div>}</>}
      {current?.tag && <dl><dt>Field type</dt><dd>{current.tag.dataType} {current.tag.unit}</dd><dt>Value / status</dt><dd>{displayValue(current.live?.value)} · {current.live?.quality || "No current value"}</dd><dt>Timestamp</dt><dd>{current.live?.timestamp || "—"}</dd></dl>}
    </aside></div></>;
}
