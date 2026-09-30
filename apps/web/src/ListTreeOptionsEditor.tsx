import { useEffect, useRef, useState } from "react";
import { validateListTreeOptions } from "./listTreeModel";
import type { CanvasComponent } from "./types";
import { PropertyCollectionDialog } from "./PropertyCollectionEditor";
import "./listTreeOptionsEditor.css";

type Option = NonNullable<CanvasComponent["props"]["options"]>[number];
type Row = Option & { id: number; parentId: number | null };
type Draft = { rows: Row[]; defaultId: number | null; missingDefault: string };
type Notify = (message: string, error?: boolean) => void;

/** Draft row IDs preserve parent links and the selected default while values are renamed. */
export function ListTreeOptionsEditor({ component, onChange, notify }: {
  component: CanvasComponent; onChange: (patch: CanvasComponent["props"]) => void; notify: Notify;
}) {
  const tree = component.type === "treeView";
  const source = component.props.options || [];
  const [draft, setDraft] = useState<Draft | null>(null);
  const nextId = useRef(0);
  function edit() {
    const rows: Row[] = source.map(option => ({ ...option, id: nextId.current++, parentId: null }));
    if (tree) for (const row of rows) row.parentId = row.parentValue ? rows.find(item => item.value === row.parentValue)?.id ?? -1 : null;
    const defaultValue = String(component.props.defaultValue ?? source[0]?.value ?? "");
    setDraft({ rows, defaultId: rows.find(row => row.value === defaultValue)?.id ?? null, missingDefault: defaultValue });
  }
  function options(): Option[] {
    return (draft?.rows || []).map(row => ({ value: row.value, label: row.label,
      ...(tree && row.parentId !== null ? { parentValue: draft!.rows.find(parent => parent.id === row.parentId)?.value ?? row.parentValue ?? "" } : {}) }));
  }
  function validation(): string | undefined {
    if (!draft) return undefined;
    const missingParent = tree ? draft.rows.findIndex(row => row.parentId !== null && !draft.rows.some(parent => parent.id === row.parentId)) : -1;
    if (missingParent >= 0) return `Option ${missingParent + 1} needs an existing parent, or choose Root.`;
    try { validateListTreeOptions(tree ? "treeView" : "list", options()); }
    catch (error) { return error instanceof Error ? error.message : "Review the option definitions."; }
    if (draft.defaultId === null || !draft.rows.some(row => row.id === draft.defaultId)) return "Choose a default selection from the current options.";
    return undefined;
  }
  const error = validation();
  function apply() {
    if (!draft) return;
    if (error) { notify(error, true); return; }
    onChange({ options: validateListTreeOptions(tree ? "treeView" : "list", options()), defaultValue: draft.rows.find(row => row.id === draft.defaultId)!.value });
    setDraft(null);
  }
  function updateRow(id: number, patch: Partial<Row>) {
    if (!draft) return;
    setDraft({ ...draft, rows: draft.rows.map(row => row.id === id ? { ...row, ...patch }
      : patch.value !== undefined && row.parentId === id ? { ...row, parentValue: patch.value } : row) });
  }
  const label = tree ? "Tree options" : "List options";
  const help = (tree ? "Define up to 100 choices with parent links, at most 16 levels deep. Roots have no parent. " : "Define up to 100 choices in display order. ") + "Selecting a choice stages its exact value in this form.";
  return <section className="property-sheet-group property-collection-group" aria-label={label}><h4>{label}</h4>
    <div className="property-sheet-row" data-property="options"><label title={help}>Options</label><div className="property-sheet-value property-collection-value"><span>{source.length} defined</span><button type="button" className="button small" onClick={edit}>Edit options</button></div><span aria-hidden="true" /></div>
    <div className="property-sheet-row" data-property="defaultValue"><label>Default selection</label><div className="property-sheet-value"><span className="property-sheet-summary">{source.find(row => row.value === String(component.props.defaultValue ?? source[0]?.value ?? ""))?.label ?? "Unavailable"}</span></div><span aria-hidden="true" /></div>
    {!source.length && <p className="list-tree-error" role="alert">Add at least one option.</p>}
    {draft && <PropertyCollectionDialog title={label} onClose={() => setDraft(null)}><p className="list-tree-help">{help}</p><div className="list-tree-draft" role="group" aria-label={`Edit ${tree ? "tree" : "list"} options`} onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); apply(); }
      if (event.key === "Escape") { event.preventDefault(); setDraft(null); }
    }}>
      {draft.rows.map((row, index) => <div className="list-tree-option-row" key={row.id}>
        <div className="list-tree-heading"><strong>Option {index + 1}</strong><button type="button" className="button small subtle" disabled={draft.rows.length <= 1}
          aria-label={`Remove option ${index + 1}`} onClick={() => setDraft({ ...draft, rows: draft.rows.filter(item => item.id !== row.id) })}>Remove</button></div>
        <label>Value<input aria-label={`Option ${index + 1} value`} value={row.value} maxLength={4096} onChange={event => updateRow(row.id, { value: event.target.value })} /></label>
        <label>Label<input aria-label={`Option ${index + 1} label`} value={row.label} maxLength={200} onChange={event => updateRow(row.id, { label: event.target.value })} /></label>
        {tree && <label>Parent<select aria-label={`Option ${index + 1} parent`} value={row.parentId === null ? "" : String(row.parentId)} onChange={event => {
          const parentId = event.target.value === "" ? null : Number(event.target.value);
          updateRow(row.id, { parentId, parentValue: parentId === null ? undefined : draft.rows.find(parent => parent.id === parentId)?.value });
        }}><option value="">Root — no parent</option>
          {row.parentId !== null && (row.parentId === row.id || !draft.rows.some(parent => parent.id === row.parentId)) && <option value={row.parentId}>Missing or invalid parent: {row.parentValue}</option>}
          {draft.rows.filter(parent => parent.id !== row.id).map(parent => <option key={parent.id} value={parent.id}>{parent.label || "Untitled"} · {parent.value}</option>)}
        </select></label>}
      </div>)}
      <button type="button" className="button small" disabled={draft.rows.length >= 100} onClick={() => {
        let number = draft.rows.length + 1;
        while (draft.rows.some(row => row.value === `option${number}`)) number++;
        const row: Row = { id: nextId.current++, value: `option${number}`, label: `Option ${number}`, parentId: null };
        setDraft({ ...draft, rows: [...draft.rows, row], defaultId: draft.rows.length ? draft.defaultId : row.id });
      }}>Add option</button>
      <label className="list-tree-default">Default selection<select aria-label="Default option" value={draft.defaultId === null ? "" : String(draft.defaultId)} onChange={event => setDraft({ ...draft, defaultId: event.target.value === "" ? null : Number(event.target.value) })}>
        {(draft.defaultId === null || !draft.rows.some(row => row.id === draft.defaultId)) && <option value={draft.defaultId === null ? "" : draft.defaultId}>Choose an option{draft.missingDefault ? ` · ${draft.missingDefault}` : ""}…</option>}
        {draft.rows.map(row => <option key={row.id} value={row.id}>{row.label || "Untitled"} · {row.value}</option>)}
      </select></label>
      {error && <p className="list-tree-error" role="alert">{error}</p>}
      <div className="list-tree-actions"><button type="button" className="button small primary" onClick={apply}>Apply options</button><button type="button" className="button small" onClick={() => setDraft(null)}>Cancel</button></div>
    </div></PropertyCollectionDialog>}
  </section>;
}

/** The page size changes only after an exact integer passes validation. */
export function TablePageSizeEditor({ value = 25, onChange, notify }: { value?: number; onChange: (value: number) => void; notify: Notify }) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState("");
  useEffect(() => { setDraft(String(value)); setError(""); }, [value]);
  function commit() {
    const next = Number(draft);
    if (!draft.trim() || !Number.isInteger(next) || next < 1 || next > 100) {
      const message = "Rows per page must be a whole number from 1 to 100."; setError(message); notify(message, true); return;
    }
    setError(""); if (next !== value) onChange(next);
  }
  return <div className="table-page-size-editor"><input type="number" aria-label="Table rows per page" min={1} max={100} step={1} value={draft} aria-invalid={Boolean(error)}
    onChange={event => { setDraft(event.target.value); setError(""); }} onBlur={commit} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); event.currentTarget.blur(); }
      if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDraft(String(value)); setError(""); }
    }} />{error && <p className="list-tree-error" role="alert">{error}</p>}</div>;
}
