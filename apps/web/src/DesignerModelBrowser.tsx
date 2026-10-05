import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { displayValue } from "./api";
import Icon from "./Icon";
import { getModelObject, getModelTree, modelChangedEvent, modelLeaves } from "./modelApi";
import type { ModelLeaf, ModelObject, ModelTreeItem } from "./modelApi";
import type { Tag, Template } from "./types";
import { createModelFaceplate } from "./designerModel";
import "./designerModel.css";

const root = "[default]", instanceKey = "instance\n";
/** Children loaded for one expanded node: folder pages from the tree endpoint, or one instance object with its fields. */
type Branch = { loading: boolean; error?: string; items: ModelTreeItem[]; total: number; object?: ModelObject };
const goodQuality = (quality?: string) => /good/i.test(quality || "");

export function DesignerModelBrowser({ onSelect, onCreateFaceplate }: { onSelect: (path: string) => void; onCreateFaceplate?: (template: Template) => void }) {
  const [branches, setBranches] = useState<Map<string, Branch>>(new Map()), [expanded, setExpanded] = useState<Set<string>>(new Set([root]));
  const [selected, setSelected] = useState(""), [revision, setRevision] = useState(0), [error, setError] = useState("");
  const generation = useRef(0), loaded = useRef(new Set<string>());
  const patch = (path: string, next: Partial<Branch>) => setBranches(previous => new Map(previous).set(path, { loading: false, items: [], total: 0, ...previous.get(path), ...next }));
  // Created once: these use only state setters and refs, so they stay valid across renders.
  const actions = useRef<{ load: (path: string, instance: boolean, offset?: number) => Promise<void>; refresh: () => void } | null>(null);
  actions.current ??= { load: async (path: string, instance: boolean, offset = 0) => {
    const run = generation.current; patch(path, { loading: true, error: undefined });
    try {
      if (instance) { const object = await getModelObject(path); if (run === generation.current) patch(path, { loading: false, object }); return; }
      const page = await getModelTree(path, offset);
      if (run !== generation.current) return;
      setBranches(previous => { const items = [...(offset ? previous.get(path)?.items ?? [] : []), ...page.items.filter(item => item.path !== path)]; return new Map(previous).set(path, { loading: false, items, total: page.total }); });
    } catch (reason) { if (run === generation.current) patch(path, { loading: false, error: reason instanceof Error ? reason.message : "Could not load model." }); }
  },
  /** Drops every loaded branch; the open ones load again right away, closed ones when next opened. */
  refresh: () => { generation.current++; loaded.current.clear(); setBranches(new Map()); setError(""); setRevision(value => value + 1); } };
  const { load, refresh } = actions.current;
  useEffect(() => { window.addEventListener(modelChangedEvent, refresh); return () => window.removeEventListener(modelChangedEvent, refresh); }, [refresh]);
  useEffect(() => {
    for (const key of expanded) {
      if (loaded.current.has(key)) continue;
      loaded.current.add(key);
      if (key.startsWith(instanceKey)) void load(key.slice(instanceKey.length), true); else void load(key, false);
    }
  }, [expanded, revision, load]);
  const toggle = (key: string) => setExpanded(previous => { const next = new Set(previous); if (!next.delete(key)) next.add(key); return next; });
  const rootBranch = branches.get(root);
  const props = { branches, expanded, selected, onToggle: toggle, onSelect: (path: string) => { setSelected(path); onSelect(path); }, onFocus: setSelected, onMore: (path: string, offset: number) => void load(path, false, offset), onCreateFaceplate: onCreateFaceplate && ((object: ModelObject) => { try { onCreateFaceplate(createModelFaceplate(object)); } catch (reason) { setError(reason instanceof Error ? reason.message : "Cannot create faceplate."); } }) };
  return <section className="designer-model-browser" aria-label="Model tag browser">
    <div className="designer-model-toolbar"><code>{root}</code>{rootBranch?.loading && <small role="status">Loading…</small>}<button type="button" className="designer-model-refresh" aria-label="Refresh model" title="Refresh model" disabled={rootBranch?.loading} onClick={refresh}><Icon name="refresh" size={13} /></button></div>
    {error && <p role="alert" className="property-sheet-error">{error}</p>}
    <div className="designer-model-tree" role="tree" aria-label="Model" onKeyDown={treeKeys}>
      {rootBranch?.error && <p role="alert" className="property-sheet-error">{rootBranch.error}</p>}
      <BranchRows {...props} path={root} depth={0} />
      {rootBranch && !rootBranch.loading && !rootBranch.items.length && !rootBranch.error && <p className="panel-help">No readable models yet. Create models and machines in the Models workspace.</p>}
    </div>
  </section>;
}

type RowProps = { branches: Map<string, Branch>; expanded: Set<string>; selected: string; onToggle: (key: string) => void; onSelect: (path: string) => void; onFocus: (path: string) => void; onMore: (path: string, offset: number) => void; onCreateFaceplate?: (object: ModelObject) => void };
function BranchRows(props: RowProps & { path: string; depth: number }) {
  const branch = props.branches.get(props.path);
  if (!branch) return null;
  const indent = { paddingLeft: 6 + props.depth * 12 };
  return <>
    {branch.items.map(item => item.kind === "member" ? <MemberRow key={item.path} {...props} item={item} depth={props.depth} /> : <NodeRow key={item.path} {...props} item={item} depth={props.depth} />)}
    {branch.total > branch.items.length && <button type="button" className="designer-model-row more" style={indent} disabled={branch.loading} onClick={() => props.onMore(props.path, branch.items.length)}>Show more ({branch.total - branch.items.length} remaining)</button>}
    {branch.loading && props.path !== root && <p className="designer-model-note" style={indent} role="status">Loading…</p>}
    {branch.error && props.path !== root && <p className="designer-model-note error" style={indent} role="alert">{branch.error}</p>}
  </>;
}
function NodeRow(props: RowProps & { item: ModelTreeItem; depth: number }) {
  const { item } = props, instance = item.kind === "instance", key = instance ? `instance\n${item.path}` : item.path, open = props.expanded.has(key);
  const detail = instance ? `${item.definitionId ?? "Model"}${item.version ? ` v${item.version}` : ""}` : item.level || "Folder";
  const object = props.branches.get(item.path)?.object;
  return <>
    <button type="button" role="treeitem" aria-level={props.depth + 1} aria-expanded={open} aria-selected={props.selected === item.path} className={`designer-model-row ${props.selected === item.path ? "selected" : ""}`} style={{ paddingLeft: 6 + props.depth * 12 }} title={item.description || item.path} onClick={() => { props.onFocus(item.path); props.onToggle(key); }}>
      <span className="designer-model-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      <Icon name={instance ? "layers" : "folder"} size={12} />
      <span className="designer-model-name">{item.name}</span><small>{detail}</small>
    </button>
    {open && (instance ? <InstanceRows {...props} path={item.path} object={object} depth={props.depth + 1} /> : <BranchRows {...props} path={item.path} depth={props.depth + 1} />)}
  </>;
}
function InstanceRows(props: RowProps & { path: string; object?: ModelObject; depth: number }) {
  const branch = props.branches.get(props.path), indent = { paddingLeft: 6 + props.depth * 12 };
  if (!props.object) return <>{branch?.error ? <p className="designer-model-note error" style={indent} role="alert">{branch.error}</p> : <p className="designer-model-note" style={indent} role="status">Loading…</p>}</>;
  const object = props.object, leaves = modelLeaves(object.members);
  return <>
    {leaves.map(leaf => <LeafRow key={leaf.path} {...props} leaf={leaf} />)}
    {!leaves.length && <p className="designer-model-note" style={indent}>No readable fields.</p>}
    {object.restrictedMembers > 0 && <p className="designer-model-note" style={indent} role="status">{object.restrictedMembers} restricted fields hidden.</p>}
    {props.onCreateFaceplate && <button type="button" className="designer-model-row action" style={indent} disabled={object.restrictedMembers > 0} title={object.restrictedMembers > 0 ? "Some fields are restricted, so a faceplate cannot be generated." : "Create an editable faceplate template from this machine's model"} onClick={() => props.onCreateFaceplate!(object)}><Icon name="plus" size={12} />Create faceplate</button>}
  </>;
}
function LeafRow(props: RowProps & { leaf: ModelLeaf; depth: number }) {
  const { leaf } = props, unit = leaf.metadata?.unit;
  return <button type="button" role="treeitem" aria-level={props.depth + 1} aria-selected={props.selected === leaf.path} className={`designer-model-row leaf ${props.selected === leaf.path ? "selected" : ""}`} style={{ paddingLeft: 24 + props.depth * 12 }} title={`${leaf.path}${leaf.metadata?.description ? `\n${leaf.metadata.description}` : ""}\n${leaf.dataType} · ${leaf.quality}`} draggable onDragStart={event => event.dataTransfer.setData("text/spark-tag", leaf.path)} onClick={() => props.onSelect(leaf.path)}>
    <span className={`tag-quality ${goodQuality(leaf.quality) ? "" : "bad"}`} />
    <span className="designer-model-name">{leaf.modelPath}</span><span className="designer-model-value">{displayValue(leaf.value)}{unit ? ` ${unit}` : ""}</span>
  </button>;
}
function MemberRow(props: RowProps & { item: ModelTreeItem; depth: number }) {
  const { item } = props;
  return <button type="button" role="treeitem" aria-level={props.depth + 1} aria-selected={props.selected === item.path} className={`designer-model-row leaf ${props.selected === item.path ? "selected" : ""}`} style={{ paddingLeft: 24 + props.depth * 12 }} title={item.path} draggable onDragStart={event => event.dataTransfer.setData("text/spark-tag", item.path)} onClick={() => props.onSelect(item.path)}>
    <span className={`tag-quality ${goodQuality(item.quality) ? "" : "bad"}`} />
    <span className="designer-model-name">{item.name}</span><span className="designer-model-value">{item.value === undefined ? item.dataType : displayValue(item.value)}{item.unit ? ` ${item.unit}` : ""}</span>
  </button>;
}
/** Up and Down move between visible rows; Right and Left open and close a branch through its own button. */
function treeKeys(event: KeyboardEvent<HTMLDivElement>) {
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button.designer-model-row:not(:disabled)")], index = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  const row = rows[index], open = row.getAttribute("aria-expanded");
  if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus(); }
  else if ((event.key === "ArrowRight" && open === "false") || (event.key === "ArrowLeft" && open === "true")) { event.preventDefault(); row.click(); }
}

/** Raw | Model tabs shared by the Designer tag pane and the binding picker. */
export function TagBrowserTabs({ view, onView }: { view: "raw" | "model"; onView: (view: "raw" | "model") => void }) {
  return <div className="tag-browser-tabs" role="tablist" aria-label="Tag source">
    {(["raw", "model"] as const).map(item => <button key={item} type="button" role="tab" aria-selected={view === item} className={view === item ? "active" : ""} onClick={() => onView(item)}>{item === "raw" ? "Raw tags" : "Model"}</button>)}
  </div>;
}

export function TagBindingPicker({ tags, onSelect, disabled = false }: { tags: Tag[]; onSelect: (path: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false), [view, setView] = useState<"raw" | "model">("raw"), [search, setSearch] = useState("");
  const matches = tags.filter(tag => tag.path.toLowerCase().includes(search.toLowerCase()));
  return <div className="tag-binding-picker"><button type="button" className="button small" disabled={disabled} aria-expanded={open} onClick={() => setOpen(value => !value)}>Browse tags</button>{open && <section aria-label="Tag binding browser">
    <TagBrowserTabs view={view} onView={setView} />
    {view === "model" ? <DesignerModelBrowser onSelect={path => { onSelect(path); setOpen(false); }} /> : <><input aria-label="Filter binding tags" value={search} onChange={event => setSearch(event.target.value)} /><div className="designer-model-items">{matches.slice(0, 100).map(tag => <button type="button" className="designer-model-item" key={tag.path} onClick={() => { onSelect(tag.path); setOpen(false); }}>{tag.path}<small>{tag.dataType} · {tag.quality}</small></button>)}</div><small>Showing {Math.min(100, matches.length)} of {matches.length} tags.</small></>}
  </section>}</div>;
}
