import { useRef, useState } from "react";
import { validateTableColumns } from "./tableColumns";
import type { CanvasComponent, TableColumnDefinition } from "./types";
import { PropertyCollectionDialog } from "./PropertyCollectionEditor";
import "./tableColumnsEditor.css";

type DraftRow = { id: number; key: string; label: string; visible: boolean; width: string;
  align: NonNullable<TableColumnDefinition["align"]>; format: NonNullable<TableColumnDefinition["format"]>; precision: string; suffix: string };
type Notify = (message: string, error?: boolean) => void;

/** Edits stay local until one validated Apply creates one project history entry. */
export function TableColumnsEditor({ component, onChange, notify }: {
  component: CanvasComponent; onChange: (patch: CanvasComponent["props"]) => void; notify: Notify;
}) {
  const source = component.props.tableColumns;
  const [draft, setDraft] = useState<DraftRow[] | null>(null);
  const nextId = useRef(0);
  const savedError = validateTableColumns(source);
  const definitions = (): TableColumnDefinition[] => (draft || []).map(row => ({
    key: row.key,
    ...(row.label === "" ? {} : { label: row.label }),
    ...(row.visible ? {} : { visible: false }),
    ...(row.width === "" ? {} : { width: Number(row.width) }),
    ...(row.align === "left" ? {} : { align: row.align }),
    ...(row.format === "auto" ? {} : { format: row.format }),
    ...(row.format !== "number" || row.precision === "" ? {} : { precision: Number(row.precision) }),
    ...(row.format !== "number" || row.suffix === "" ? {} : { suffix: row.suffix }),
  }));
  const error = draft === null ? savedError : validateTableColumns(definitions());
  const edit = () => setDraft((Array.isArray(source) ? source : []).map(column => ({ id: nextId.current++, key: column.key,
    label: column.label ?? "", visible: column.visible ?? true, width: column.width === undefined ? "" : String(column.width),
    align: column.align ?? "left", format: column.format ?? "auto", precision: column.precision === undefined ? "" : String(column.precision), suffix: column.suffix ?? "" })));
  const update = (id: number, patch: Partial<DraftRow>) => setDraft(previous => previous?.map(row => row.id === id ? { ...row, ...patch } : row) ?? null);
  const move = (index: number, direction: -1 | 1) => {
    if (!draft || index + direction < 0 || index + direction >= draft.length) return;
    const rows = [...draft]; [rows[index], rows[index + direction]] = [rows[index + direction], rows[index]]; setDraft(rows);
  };
  function apply() {
    if (draft === null) return;
    const columns = definitions(), problem = validateTableColumns(columns);
    if (problem) { notify(problem, true); return; }
    onChange({ tableColumns: columns });
    setDraft(null);
  }
  function add() {
    if (draft === null || draft.length >= 64) return;
    let number = draft.length + 1;
    while (draft.some(row => row.key === `column${number}`)) number++;
    setDraft([...draft, { id: nextId.current++, key: `column${number}`, label: "", visible: true, width: "", align: "left", format: "auto", precision: "", suffix: "" }]);
  }
  const help = "Use exact query column names as source keys. Labels change headings. Hidden and unlisted columns remain in the query data for row selection; hiding is presentation only.";
  return <section className="property-sheet-group property-collection-group" aria-label="Table columns"><h4>Table columns</h4>
    <div className="property-sheet-row" data-property="tableColumns"><label title={help}>Columns</label><div className="property-sheet-value property-collection-value"><span>{source?.length ? `${source.length} defined` : "Automatic"}</span><button type="button" className="button small" onClick={edit}>Edit columns</button></div><span aria-hidden="true" /></div>
    {draft === null && error && <p className="table-columns-error" role="alert">{error}</p>}
    {draft !== null && <PropertyCollectionDialog title="Table columns" onClose={() => setDraft(null)}><p className="table-columns-help">{help}</p><div className="table-columns-draft" role="group" aria-label="Edit table columns" onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); apply(); }
      if (event.key === "Escape") { event.preventDefault(); setDraft(null); }
    }}>
      {!draft.length && <p className="table-columns-help">Automatic columns. Add a column to choose an explicit display order.</p>}
      {draft.map((row, index) => <div className="table-column-row" key={row.id}>
        <div className="table-columns-heading"><strong>Column {index + 1}</strong><div className="table-column-order">
          <button type="button" className="button small" aria-label={`Move column ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
          <button type="button" className="button small" aria-label={`Move column ${index + 1} down`} disabled={index === draft.length - 1} onClick={() => move(index, 1)}>↓</button>
          <button type="button" className="button small" aria-label={`Remove column ${index + 1}`} onClick={() => setDraft(draft.filter(item => item.id !== row.id))}>Remove</button>
        </div></div>
        <label>Source key<input aria-label={`Column ${index + 1} source key`} value={row.key} maxLength={128} placeholder="Exact query column name" onChange={event => update(row.id, { key: event.target.value })} /></label>
        <label>Heading<input aria-label={`Column ${index + 1} heading`} value={row.label} maxLength={120} placeholder="Use source heading" onChange={event => update(row.id, { label: event.target.value })} /></label>
        <div className="table-column-grid">
          <label>Width (px)<input type="number" aria-label={`Column ${index + 1} width`} value={row.width} min={40} max={1200} step={1} placeholder="Automatic" onChange={event => update(row.id, { width: event.target.value })} /></label>
          <label>Alignment<select aria-label={`Column ${index + 1} alignment`} value={row.align} onChange={event => update(row.id, { align: event.target.value as DraftRow["align"] })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
        </div>
        <label>Format<select aria-label={`Column ${index + 1} format`} value={row.format} onChange={event => update(row.id, { format: event.target.value as DraftRow["format"] })}>
          <option value="auto">Automatic</option><option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="datetime">Date/time (UTC)</option>
        </select></label>
        {row.format === "number" && <div className="table-column-grid">
          <label>Decimal places<input type="number" aria-label={`Column ${index + 1} precision`} value={row.precision} min={0} max={10} step={1} placeholder="2" onChange={event => update(row.id, { precision: event.target.value })} /></label>
          <label>Suffix<input aria-label={`Column ${index + 1} suffix`} value={row.suffix} maxLength={32} placeholder=" e.g. °C" onChange={event => update(row.id, { suffix: event.target.value })} /></label>
        </div>}
        {row.format === "number" && <p className="table-columns-help">The suffix is literal. Include a leading space when needed.</p>}
        {row.format === "datetime" && <p className="table-columns-help">Requires an ISO timestamp with a timezone. Dates display in UTC.</p>}
        <label className="table-column-visible"><input type="checkbox" aria-label={`Column ${index + 1} visible`} checked={row.visible} onChange={event => update(row.id, { visible: event.target.checked })} />Show this column</label>
      </div>)}
      <div className="table-columns-actions"><button type="button" className="button small" disabled={draft.length >= 64} onClick={add}>Add column</button><button type="button" className="button small" disabled={!draft.length} onClick={() => setDraft([])}>Use automatic columns</button></div>
      <p className="table-columns-help">Only listed, visible columns are shown. Source keys are checked when the query returns data. Changing the named query preserves these settings.</p>
      {error && <p className="table-columns-error" role="alert">{error}</p>}
      <div className="table-columns-actions"><button type="button" className="button small primary" disabled={Boolean(error)} onClick={apply}>Apply columns</button><button type="button" className="button small" onClick={() => setDraft(null)}>Cancel</button></div>
    </div></PropertyCollectionDialog>}
  </section>;
}
