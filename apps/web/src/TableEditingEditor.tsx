import { useEffect, useRef, useState } from "react";
import type { Completion } from "@codemirror/autocomplete";
import ScriptEditor from "./ScriptEditor";
import { pythonSystemCompletions } from "./eventScriptAuthoring";
import { parseTableEditValue, validateTableEditDefinition } from "./tableEditing";
import type { CanvasComponent, TableEditDefinition } from "./types";
import "./propertyCollectionEditor.css";
import "./tableEditingEditor.css";

type EditableColumn = TableEditDefinition["columns"][number];
type DraftColumn = { id: number; key: string; type: EditableColumn["type"]; required: boolean; maxLength: string; min: string; max: string; integer: boolean };
type Notify = (message: string, error?: boolean) => void;
const parsedNumber = (value: string) => {
  const parsed = parseTableEditValue(value, { key: "constraint", type: "number" });
  return typeof parsed.value === "number" ? parsed.value : Number.NaN;
};
const completions: Completion[] = [
  { label: "inputs", type: "variable", detail: "Validated edit and gateway-reconstructed source row" },
  ...["column", "value", "oldValue", "rowKey", "version", "row"].map(key => ({ label: `inputs[${JSON.stringify(key)}]`, type: "property", detail: "Validated table commit context" })),
  { label: "parameters", type: "variable", detail: "Resolved screen/template parameters" },
  { label: "result", type: "variable", detail: "Result or message returned after the handler succeeds" },
  ...pythonSystemCompletions,
  { label: "print", type: "function", detail: "Write execution output" },
  ...["if", "else", "raise", "RuntimeError", "True", "False", "None", "import", "from"].map(label => ({ label, type: "keyword" })),
];

export function TableEditingEditor({ component, onChange, notify }: {
  component: CanvasComponent; onChange: (patch: CanvasComponent["props"]) => void; notify: Notify;
}) {
  const [open, setOpen] = useState(false);
  const definition = component.props.tableEdit;
  const error = validateTableEditDefinition(definition, component.props.rowKey);
  return <section className="property-sheet-group property-collection-group" aria-label="Table inline editing"><h4>Inline editing</h4>
    <div className="property-sheet-row" data-property="tableEdit"><label title="Publish and use the operator runtime to test writes. Designer Preview never executes cell writes.">Cell editing</label><div className="property-sheet-value property-collection-value"><span>{definition ? `${definition.columns.length} editable` : "Disabled"}</span><button type="button" className="button small" onClick={() => setOpen(true)}>{definition ? definition.batch ? "Edit atomic batch" : "Edit cell handler" : "Configure editing"}</button></div><span aria-hidden="true" /></div>
    {definition && <div className="property-sheet-row" data-property="tableEdit.versionColumn"><label>Version column</label><div className="property-sheet-value"><span className="property-sheet-summary">{definition.versionColumn}</span></div><span aria-hidden="true" /></div>}
    {error && <p className="table-editing-error" role="alert">{error}</p>}
    {open && <TableEditingDialog component={component} onChange={onChange} notify={notify} onClose={() => setOpen(false)} />}
  </section>;
}

function TableEditingDialog({ component, onChange, notify, onClose }: {
  component: CanvasComponent; onChange: (patch: CanvasComponent["props"]) => void; notify: Notify; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), nextId = useRef(0);
  const saved = component.props.tableEdit;
  const [enabled, setEnabled] = useState(Boolean(saved));
  const [versionColumn, setVersionColumn] = useState(saved?.versionColumn ?? "");
  const [mode, setMode] = useState(saved?.batch ? "batch" : "script");
  const [table, setTable] = useState(saved?.batch?.table ?? "");
  const [script, setScript] = useState(saved?.script ?? "");
  const [columns, setColumns] = useState<DraftColumn[]>(() => saved?.columns.map(column => ({
    id: nextId.current++, key: column.key, type: column.type, required: column.required ?? false, integer: column.integer ?? false,
    maxLength: column.maxLength === undefined ? "" : String(column.maxLength), min: column.min === undefined ? "" : String(column.min), max: column.max === undefined ? "" : String(column.max),
  })) ?? [{ id: nextId.current++, key: "", type: "string", required: false, maxLength: "", min: "", max: "", integer: false }]);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const definition = (): TableEditDefinition => ({ versionColumn, ...(mode === "batch" ? { batch: { table } } : { script }), columns: columns.map(column => ({
    key: column.key, type: column.type,
    ...(column.type === "string" ? { ...(column.required ? { required: true } : {}), ...(column.maxLength === "" ? {} : { maxLength: parsedNumber(column.maxLength) }) } : {}),
    ...(column.type === "number" ? { ...(column.integer ? { integer: true } : {}), ...(column.min === "" ? {} : { min: parsedNumber(column.min) }), ...(column.max === "" ? {} : { max: parsedNumber(column.max) }) } : {}),
  })) });
  const error = enabled ? !component.props.queryId?.trim() ? "Choose a read named query for this table before enabling editing."
    : mode === "batch" && Object.keys(component.props.selectionFields ?? {}).length ? "Clear scalar selection mappings before enabling atomic batches." : validateTableEditDefinition(definition(), component.props.rowKey) : null;
  function apply() {
    if (error) { notify(error, true); return; }
    onChange({ tableEdit: enabled ? definition() : undefined, ...(enabled && mode === "batch" ? { selectionMode: "multiple" } : {}) }); onClose();
  }
  function update(id: number, patch: Partial<DraftColumn>) { setColumns(previous => previous.map(column => column.id === id ? { ...column, ...patch } : column)); }
  function add() {
    if (columns.length >= 64) return;
    setColumns(previous => [...previous, { id: nextId.current++, key: "", type: "string", required: false, maxLength: "", min: "", max: "", integer: false }]);
  }
  return <dialog ref={dialog} className="table-editing-dialog scripting-workspace" aria-labelledby="table-editing-title" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); apply(); }
  }}>
    <header><div><small>TABLE EDITING</small><h2 id="table-editing-title">Configure inline editing</h2><p>Changes stay in this dialog until Apply. Save and publish the project before operators can use them.</p></div><button type="button" className="button small" aria-label="Close table editing dialog" onClick={onClose}>Close</button></header>
    <div className="table-editing-toolbar"><label><input type="checkbox" aria-label="Enable table inline editing" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Enable inline editing</label><span>Query: <strong>{component.props.queryId || "Not configured"}</strong> · Row key: <strong>{component.props.rowKey || "Not configured"}</strong></span></div>
    {enabled ? <div className="table-editing-body"><section className="table-editing-fields" aria-label="Editable column definitions">
      <label>Persistence<select aria-label="Table edit persistence" value={mode} onChange={event => setMode(event.target.value)}><option value="script">Single cell · Python handler</option><option value="batch">Atomic batch · database table</option></select></label>
      {mode === "batch" && <><label>Database table<input aria-label="Atomic batch table" value={table} maxLength={128} placeholder="Exact unqualified table name" onChange={event => setTable(event.target.value)} /></label><p className="table-editing-help">Uses the read query's SQLite or SQL Server connection. Table, row key, version and editable field names must use ASCII letters, digits or underscores. Each name starts with a letter or underscore.</p></>}
      <label>Version column<input aria-label="Table edit version column" value={versionColumn} maxLength={128} placeholder="Exact source column, e.g. version" onChange={event => setVersionColumn(event.target.value)} /></label><p className="table-editing-help">Each source row needs a nonnegative integer version. The row key and version must be different columns and cannot be editable.</p>
      <div className="table-editing-heading"><h3>Editable fields</h3><span>{columns.length} / 64</span></div>
      {columns.map((column, index) => <fieldset className="table-editing-field" key={column.id}><legend>Field {index + 1}</legend><div className="table-editing-heading"><label>Source key<input aria-label={`Editable field ${index + 1} key`} value={column.key} maxLength={128} placeholder="Exact query column name" onChange={event => update(column.id, { key: event.target.value })} /></label><button type="button" className="button small" aria-label={`Remove editable field ${index + 1}`} disabled={columns.length === 1} onClick={() => setColumns(previous => previous.filter(item => item.id !== column.id))}>Remove</button></div>
        <label>Value type<select aria-label={`Editable field ${index + 1} type`} value={column.type} onChange={event => update(column.id, { type: event.target.value as EditableColumn["type"] })}><option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option></select></label>
        {column.type === "string" && <><label className="table-editing-checkbox"><input type="checkbox" aria-label={`Editable field ${index + 1} required`} checked={column.required} onChange={event => update(column.id, { required: event.target.checked })} /> Require nonblank text</label><label>Maximum length<input type="text" inputMode="numeric" aria-label={`Editable field ${index + 1} maximum length`} value={column.maxLength} placeholder="4096" onChange={event => update(column.id, { maxLength: event.target.value })} /></label></>}
        {column.type === "number" && <><div className="table-editing-range"><label>Minimum<input type="text" inputMode="decimal" aria-label={`Editable field ${index + 1} minimum`} value={column.min} placeholder="No minimum" onChange={event => update(column.id, { min: event.target.value })} /></label><label>Maximum<input type="text" inputMode="decimal" aria-label={`Editable field ${index + 1} maximum`} value={column.max} placeholder="No maximum" onChange={event => update(column.id, { max: event.target.value })} /></label></div><label className="table-editing-checkbox"><input type="checkbox" aria-label={`Editable field ${index + 1} integer`} checked={column.integer} onChange={event => update(column.id, { integer: event.target.checked })} /> Whole numbers only</label></>}
        {column.type === "boolean" && <p className="table-editing-help">Accepts true or false. No text or numeric coercion is applied.</p>}
      </fieldset>)}<button type="button" className="button" disabled={columns.length >= 64} onClick={add}>Add editable field</button><p className="table-editing-help">Submitted values cannot be null. Empty text is allowed unless required. Constraints validate the proposed value before the handler runs.</p>
    </section>{mode === "script" ? <section className="table-editing-handler" aria-label="Cell commit handler"><h3>Gateway Python handler</h3><ScriptEditor value={script} language="python" onChange={setScript} onSave={apply} completions={completions} />
      <p className="table-editing-help">Publish and use the operator runtime to test writes. There is no Run action in this editor. Scripts are limited to 64,000 characters.</p>
      <p className="table-editing-help">This commit handler receives validated <code>inputs</code> and <code>parameters</code>, with the same gateway <code>system.*</code> functions used by Python actions and events. It does not receive component <code>self</code> or an automatic <code>event</code> payload.</p>
      <details className="table-editing-context" open><summary>Validated commit context</summary><dl><dt><code>inputs["column"]</code></dt><dd>Exact editable source key.</dd><dt><code>inputs["value"]</code></dt><dd>New value after its declared type and constraints are checked.</dd><dt><code>inputs["oldValue"]</code></dt><dd>Previous source value; it may be null.</dd><dt><code>inputs["rowKey"]</code></dt><dd>Stable string or integer identity of the selected row.</dd><dt><code>inputs["version"]</code></dt><dd>Version of the gateway-reconstructed source row.</dd><dt><code>inputs["row"]</code></dt><dd>Complete source row reconstructed by the gateway, including hidden query columns.</dd></dl><p>The gateway rechecks the row before running this handler. Your named update must still compare both its key and version in the database and advance the version. Check the affected-row count and raise an error unless exactly one row changed. A prior row check alone does not make the database update atomic.</p><p><code>parameters</code> contains the resolved screen/template context. The published handler is trusted gateway code; it must validate its business rules and choose the permitted update.</p></details>
    </section> : <section className="table-editing-handler"><h3>Atomic database batch</h3><p>Operators select up to 100 rows and stage up to 100 cells. Apply validates every value against the published fields, reads current query membership and checks captured row versions inside one transaction.</p><p>All declared cells for a row update together, and the gateway advances its version once. Any missing row, stale version, constraint failure or failed update rolls back the complete batch.</p><p>All other writers must compare and advance the same version. The database table must have a unique row key. Queries must return direct keys, versions and editable columns from the declared table.</p><p>This mode runs no Python, device writes or external side effects. Database triggers remain the administrator's responsibility.</p></section>}</div> : <div className="table-editing-disabled"><p>Enable editing to declare fields and a Python commit handler.</p>{saved && <p>Applying while disabled removes this table's saved editing configuration. Cancel keeps it unchanged.</p>}</div>}
    <footer>{error ? <p className="table-editing-error" role="alert">{error}</p> : <p>Apply updates one project draft entry. Ctrl+S applies this dialog.</p>}<button type="button" className="button" onClick={onClose}>Cancel</button><button type="button" className="button primary" disabled={Boolean(error)} onClick={apply}>Apply editing</button></footer>
  </dialog>;
}
