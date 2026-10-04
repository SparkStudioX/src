import { useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import { displayValue } from "./api";
import type { Tag } from "./types";
import type { ModelSourceTag } from "./modelBuilderOperations";

export type BuilderDrag = { kind: "tag" | "folder" | "type" | "member"; path: string };
const dragFormats = { tag: "text/spark-tag", folder: "application/x-spark-tag-folder", type: "application/x-spark-model-type", member: "application/x-spark-model-member" };
export function writeBuilderDrag(event: DragEvent, value: BuilderDrag) { event.dataTransfer.setData(dragFormats[value.kind], value.path); event.dataTransfer.effectAllowed = value.kind === "member" ? "move" : "copy"; }
export function readBuilderDrag(event: DragEvent): BuilderDrag | undefined {
  for (const kind of ["tag", "folder", "type", "member"] as const) { const path = event.dataTransfer.getData(dragFormats[kind]); if (path) return { kind, path }; }
}
export function acceptsBuilderDrag(event: DragEvent, kinds: BuilderDrag["kind"][] = ["tag", "folder", "type", "member"]) { return kinds.some(kind => event.dataTransfer.types.includes(dragFormats[kind])); }
export const builderName = (path: string) => path.slice(Math.max(path.lastIndexOf("/"), path.indexOf("]")) + 1);
const dataTypeIcon = (type?: string) => type === "Boolean" ? "◇" : type === "String" ? "T" : /Int/.test(type || "") ? "#" : type ? "≈" : "?";
type LibraryRow = { path: string; name: string; folder: boolean; level: number };
function libraryIndex(tags: ModelSourceTag[]) {
  const children = new Map<string, Map<string, LibraryRow>>();
  const add = (parent: string, row: LibraryRow) => { if (!children.has(parent)) children.set(parent, new Map()); children.get(parent)!.set(row.path, row); };
  for (const tag of tags) {
    const parts = tag.path.replace(/^\[default\]/, "").split("/"); let parent = "[default]";
    parts.forEach((name, index) => { const path = parent + (index ? "/" : "") + name; add(parent, { path, name, folder: index < parts.length - 1, level: index + 1 }); parent = path; });
  }
  return new Map([...children].map(([path, rows]) => [path, [...rows.values()].sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name))]));
}
function visibleRows(index: Map<string, LibraryRow[]>, expanded: Set<string>, search: string, tags: ModelSourceTag[]): LibraryRow[] {
  if (search) return tags.filter(tag => tag.path.toLowerCase().includes(search.toLowerCase())).map(tag => ({ path: tag.path, name: tag.path, folder: false, level: 1 }));
  const rows: LibraryRow[] = [];
  const visit = (parent: string) => { for (const row of index.get(parent) || []) { rows.push(row); if (row.folder && expanded.has(row.path)) visit(row.path); } };
  visit("[default]"); return rows;
}
type Props = { tags: ModelSourceTag[]; values: Tag[]; selectedType: string; usedTargets: Set<string>; editable: boolean; disabled?: boolean; onAdd: (drag: BuilderDrag) => void; onFolderInstance: (folder: string) => void; onSelectFolder?: (folder: string) => void };
export default function ModelBuilderLibrary(props: Props) {
  const [query, setQuery] = useState(""), [expanded, setExpanded] = useState(new Set<string>()), [selected, setSelected] = useState(""), [scroll, setScroll] = useState(0);
  const viewport = useRef<HTMLDivElement>(null), index = useMemo(() => libraryIndex(props.tags), [props.tags]);
  const rows = useMemo(() => visibleRows(index, expanded, query, props.tags), [index, expanded, query, props.tags]);
  const sources = useMemo(() => new Map(props.tags.map(tag => [tag.path, tag])), [props.tags]);
  const values = useMemo(() => new Map(props.values.map(tag => [tag.path, tag])), [props.values]);
  const start = Math.max(0, Math.min(rows.length - 1, Math.floor(scroll / 38)) - 4), shown = rows.slice(start, start + 20), current = rows.find(row => row.path === selected);
  const editable = props.editable && !props.disabled;
  const toggle = (path: string) => setExpanded(previous => { const next = new Set(previous); if (!next.delete(path)) next.add(path); return next; });
  const select = (row: LibraryRow) => { setSelected(row.path); if (row.folder) props.onSelectFolder?.(row.path); };
  function key(event: KeyboardEvent, row: LibraryRow) {
    if (event.key === "Enter") { event.preventDefault(); if (event.ctrlKey && row.folder && props.selectedType) props.onFolderInstance(row.path); else if (editable) props.onAdd({ kind: row.folder ? "folder" : "tag", path: row.path }); }
    else if (row.folder && ["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); const open = expanded.has(row.path); if (open !== (event.key === "ArrowRight")) toggle(row.path); }
    else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault(); const direction = event.key === "ArrowUp" ? -1 : 1;
      const at = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, rows.indexOf(row) + direction));
      setSelected(rows[at].path); if (viewport.current) viewport.current.scrollTop = Math.max(0, at * 38 - 90);
      requestAnimationFrame(() => viewport.current?.querySelector<HTMLElement>(`[data-row="${at}"]`)?.focus());
    }
  }
  return <section className="model-builder-library" aria-label="Data library"><label className="model-builder-search">Find source tags<input value={query} placeholder="Search by name or path…" onChange={event => { setQuery(event.target.value); setScroll(0); if (viewport.current) viewport.current.scrollTop = 0; }} /></label>
    <div className="model-fields-heading"><h4>Available data</h4><span>{props.tags.length.toLocaleString()} tags</span></div><div className="model-builder-tree" role="tree" aria-label="Existing gateway tags" ref={viewport} onScroll={event => setScroll(event.currentTarget.scrollTop)}><div style={{ height: rows.length * 38, position: "relative" }}>
      {shown.map((row, offset) => { const tag = sources.get(row.path), live = values.get(row.path), dataType = tag?.dataType || live?.dataType || "Unknown"; return <div key={row.path} role="treeitem" aria-level={row.level} aria-selected={selected === row.path} aria-expanded={row.folder ? expanded.has(row.path) : undefined} tabIndex={selected === row.path || !shown.some(item => item.path === selected) && offset === 0 ? 0 : -1} data-row={start + offset} className={`model-library-row ${selected === row.path ? "selected" : ""}`} style={{ top: (start + offset) * 38, paddingLeft: 8 + (row.level - 1) * 13 }} draggable={!props.disabled} onDragStart={event => writeBuilderDrag(event, { kind: row.folder ? "folder" : "tag", path: row.path })} onFocus={() => select(row)} onClick={() => select(row)} onDoubleClick={() => { if (row.folder) toggle(row.path); else if (editable) props.onAdd({ kind: "tag", path: row.path }); }} onKeyDown={event => key(event, row)} title={row.path}>
        {row.folder ? <button type="button" tabIndex={-1} aria-label={`${expanded.has(row.path) ? "Collapse" : "Expand"} ${row.name}`} onClick={() => toggle(row.path)}>{expanded.has(row.path) ? "▾" : "▸"}</button> : <span className={`model-quality ${live?.quality === "Good" ? "good" : ""}`} title={live?.quality || "No live value"}>●</span>}
        {!row.folder && <span className="model-datatype-icon" title={dataType} aria-label={dataType}>{dataTypeIcon(dataType)}</span>}<span className="model-library-name">{row.name}<small>{row.folder ? "Folder" : `${dataType} · ${displayValue(live?.value)}`}</small></span>{props.usedTargets.has(row.path) && <small className="model-badge">added</small>}
      </div>; })}</div></div>
    {!rows.length && <p className="model-help">{props.tags.length ? "No tags match. Try a shorter name." : "No source tags yet. Set up a connection and add tags, or start with a manual value in your model."}</p>}<div className="model-builder-toolbar"><button type="button" className="button small" disabled={!current || !editable} onClick={() => current && props.onAdd({ kind: current.folder ? "folder" : "tag", path: current.path })}>Add to model</button><button type="button" className="button small" disabled={!current?.folder || !props.selectedType} onClick={() => current && props.onFolderInstance(current.path)}>Use for equipment</button></div><p className="model-help">{editable ? "Drag tags into the builder, or select data and choose Add to model." : "Edit a new version to add tags to this saved model."}</p>
  </section>;
}
