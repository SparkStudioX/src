import { useEffect, useState } from "react";
import { displayValue } from "./api";
import { getModelObject, getModelTree, modelChangedEvent, modelLeaves } from "./modelApi";
import type { ModelObject, ModelPage, ModelTreeItem } from "./modelApi";
import type { Tag, Template } from "./types";
import { createModelFaceplate } from "./designerModel";
import "./designerModel.css";

export function DesignerModelBrowser({ onSelect, onCreateFaceplate }: { onSelect: (path: string) => void; onCreateFaceplate?: (template: Template) => void }) {
  const [path, setPath] = useState("[default]"), [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const [page, setPage] = useState<ModelPage<ModelTreeItem> | null>(null), [object, setObject] = useState<ModelObject | null>(null);
  const [instance, setInstance] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  useEffect(() => { const refresh = () => setRevision(value => value + 1); window.addEventListener(modelChangedEvent, refresh); return () => window.removeEventListener(modelChangedEvent, refresh); }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(""); setPage(null); setObject(null);
    const load = async () => { if (instance) setObject(await getModelObject(instance, controller.signal)); else setPage(await getModelTree(path, offset, controller.signal)); };
    load().catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load model."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, offset, instance, revision]);
  const go = (next: string) => { setPath(next); setOffset(0); setInstance(""); };
  const parent = () => { if (instance) setInstance(""); else go(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "[default]"); };
  return <section className="designer-model-browser" aria-label="Model tag browser">
    <div className="designer-model-actions"><button type="button" className="button small" disabled={!instance && path === "[default]"} onClick={parent}>Up</button><button type="button" className="button small" disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh model</button></div>
    <code>{instance || path}</code>{loading && <p role="status">Loading readable model…</p>}{error && <p role="alert" className="property-sheet-error">{error}</p>}
    {page && <><div className="designer-model-items">{page.items.filter(item => item.path !== path).map(item => <button type="button" className="designer-model-item" key={item.path} title={item.description} onClick={() => item.kind === "member" ? onSelect(item.path) : item.kind === "instance" ? setInstance(item.path) : go(item.path)}>
      <strong>{item.name}</strong><small>{item.level || item.kind}{item.definitionId ? ` · ${item.definitionId} v${item.version}` : ""}{item.unit ? ` · ${item.unit}` : ""}</small>
    </button>)}</div>{!page.items.length && <p>No readable models here. Create types and instances in Tags → Model.</p>}
    <div className="designer-model-actions"><button type="button" className="button small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous</button><small>{Math.min(offset + page.items.length, page.total)} of {page.total}</small><button type="button" className="button small" disabled={offset + page.items.length >= page.total} onClick={() => setOffset(offset + page.items.length)}>Next</button></div></>}
    {object && <><p>{object.definitionId} v{object.version}{object.metadata?.description ? ` · ${object.metadata.description}` : ""}</p>{object.restrictedMembers > 0 && <p role="status">{object.restrictedMembers} restricted members omitted.</p>}
      <div className="designer-model-items">{modelLeaves(object.members).map(leaf => <button type="button" className="designer-model-item" key={leaf.path} title={leaf.metadata?.description} draggable onDragStart={event => event.dataTransfer.setData("text/spark-tag", leaf.path)} onClick={() => onSelect(leaf.path)}>
        <strong>{leaf.modelPath}</strong><small>{leaf.dataType}{leaf.metadata?.unit ? ` · ${leaf.metadata.unit}` : ""} · {leaf.quality}</small><span>{displayValue(leaf.value)}</span>{leaf.metadata?.description && <small>{leaf.metadata.description}</small>}
      </button>)}</div>
      {onCreateFaceplate && <button type="button" className="button small" disabled={object.restrictedMembers > 0} onClick={() => { try { onCreateFaceplate(createModelFaceplate(object)); } catch (reason) { setError(reason instanceof Error ? reason.message : "Cannot create faceplate."); } }}>Create faceplate from type</button>}
      <p className="panel-help">Choose a member to use its ordinary tag path. References remain read-only. Refresh to see configuration and value changes.</p></>}
  </section>;
}

export function TagBindingPicker({ tags, onSelect, disabled = false }: { tags: Tag[]; onSelect: (path: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false), [view, setView] = useState<"raw" | "model">("raw"), [search, setSearch] = useState("");
  const matches = tags.filter(tag => tag.path.toLowerCase().includes(search.toLowerCase()));
  return <div className="tag-binding-picker"><button type="button" className="button small" disabled={disabled} aria-expanded={open} onClick={() => setOpen(value => !value)}>Browse tags</button>{open && <section aria-label="Tag binding browser">
    <div className="designer-model-actions"><button type="button" className="button small" aria-pressed={view === "raw"} onClick={() => setView("raw")}>Raw tags</button><button type="button" className="button small" aria-pressed={view === "model"} onClick={() => setView("model")}>Model</button></div>
    {view === "model" ? <DesignerModelBrowser onSelect={path => { onSelect(path); setOpen(false); }} /> : <><input aria-label="Filter binding tags" value={search} onChange={event => setSearch(event.target.value)} /><div className="designer-model-items">{matches.slice(0, 100).map(tag => <button type="button" className="designer-model-item" key={tag.path} onClick={() => { onSelect(tag.path); setOpen(false); }}>{tag.path}<small>{tag.dataType} · {tag.quality}</small></button>)}</div><small>Showing {Math.min(100, matches.length)} of {matches.length} tags.</small></>}
  </section>}</div>;
}
