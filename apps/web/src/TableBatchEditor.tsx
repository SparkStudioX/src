import { useEffect, useRef, useState } from "react";
import { parseTableEditValue, tableEditRowIdentity } from "./tableEditing";
import { tableRowIdentity } from "./tableSelection";
import type { QueryResult, ScriptResult, TableCellEdit, TableEditDefinition, TableEditIntent } from "./types";

type Cell = { key: string | number; version: number; column: string; text: string | boolean; included: boolean };

/** A batch captures identities and versions once. Refreshed values never replace staged text. */
export function TableBatchEditor({ snapshot, keys, rowKey, definition, current, unavailable, onApply, onClose }: {
  snapshot: QueryResult; keys: (string | number)[]; rowKey: string; definition: TableEditDefinition;
  current: QueryResult | null; unavailable?: string; onApply?: (intent: TableEditIntent) => Promise<ScriptResult>; onClose: (reload: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), mounted = useRef(true), saving = useRef(false);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState("");
  const [cells, setCells] = useState<Cell[]>(() => keys.flatMap(key => {
    const row = snapshot.rows.find(row => row[rowKey] === key)!;
    return definition.columns.map(column => ({ key, version: row[definition.versionColumn] as number, column: column.key, included: false,
      text: column.type === "boolean" ? typeof row[column.key] === "boolean" ? row[column.key] as boolean : "" : row[column.key] === null ? "" : String(row[column.key] ?? "") }));
  }));
  let conflict = "";
  if (current) for (const key of keys) {
    const row = current.rows.find(row => row[rowKey] === key);
    const identity = row && tableEditRowIdentity(current.rows, row, rowKey, definition.versionColumn);
    if (!row || identity?.error || identity?.version !== cells.find(cell => cell.key === key)?.version || definition.columns.some(column => !current.columns.includes(column.key) || !Object.hasOwn(row, column.key))) {
      conflict = "A selected row changed or left the query. Cancel and reload before preparing another batch."; break;
    }
  }
  useEffect(() => { if (conflict) setFailure(previous => previous || conflict); }, [conflict]);
  useEffect(() => { const element = dialog.current; mounted.current = true; element?.showModal(); return () => { mounted.current = false; element?.close(); }; }, []);
  const included = cells.filter(cell => cell.included);
  const parsed = included.map(cell => parseTableEditValue(cell.text, definition.columns.find(column => column.key === cell.column)!));
  const error = failure || conflict || unavailable || (!current ? "Waiting for verified current rows." : "") || (!onApply ? "Editing is unavailable in this session." : "")
    || (included.length > 100 ? "A batch can contain at most 100 cell changes." : "") || parsed.find(value => value.error)?.error;
  const valid = Boolean(!error && included.length && !busy && onApply);
  function update(index: number, patch: Partial<Cell>) { if (!saving.current) setCells(previous => previous.map((cell, item) => item === index ? { ...cell, ...patch } : cell)); }
  function cancel() { if (!saving.current) onClose(Boolean(failure || conflict)); }
  async function apply() {
    if (!valid || saving.current || !onApply) return;
    saving.current = true; setBusy(true);
    const edits: TableCellEdit[] = included.map((cell, index) => ({ key: cell.key, version: cell.version, column: cell.column, value: parsed[index].value! }));
    try {
      const result = await onApply({ edits });
      if (!mounted.current) return;
      if (result.success) { onClose(true); return; }
      setFailure("The batch was rejected. Cancel and reload before another attempt.");
    } catch (reason) {
      if (mounted.current) setFailure(`Apply could not be confirmed: ${reason instanceof Error ? reason.message : String(reason)}. Cancel and reload before another attempt.`);
    } finally { if (mounted.current) { saving.current = false; setBusy(false); } }
  }
  return <dialog ref={dialog} className="table-batch-dialog" aria-label="Edit selected rows" onCancel={event => { event.preventDefault(); cancel(); }} onKeyDown={event => event.stopPropagation()}>
    <header><h2>Edit selected rows</h2><p>{keys.length} rows · {included.length} staged cells. Apply commits all cells in one database transaction. Cancel discards the staged changes.</p></header>
    <div className="table-batch-fields">{cells.map((cell, index) => {
      const column = definition.columns.find(column => column.key === cell.column)!;
      const validation = cell.included ? parseTableEditValue(cell.text, column).error : undefined;
      return <fieldset key={`${tableRowIdentity(cell.key)}:${cell.column}`} disabled={busy || !onApply}><legend>{cell.column} · row {String(cell.key)} ({typeof cell.key}) · version {cell.version}</legend>
        <label><input type="checkbox" aria-label={`Include ${cell.column} for row ${String(cell.key)} (${typeof cell.key})`} checked={cell.included} onChange={event => update(index, { included: event.target.checked })} /> Include change</label>
        {column.type === "boolean" ? <select aria-label={`New ${cell.column} for row ${String(cell.key)} (${typeof cell.key})`} value={String(cell.text)} onChange={event => update(index, { included: true, text: event.target.value === "true" })}><option value="" disabled>Choose a value…</option><option value="true">True</option><option value="false">False</option></select>
          : <input aria-label={`New ${cell.column} for row ${String(cell.key)} (${typeof cell.key})`} inputMode={column.type === "number" ? "decimal" : undefined} aria-invalid={Boolean(validation)} value={String(cell.text)} maxLength={column.type === "string" ? column.maxLength ?? 4096 : undefined} onChange={event => update(index, { included: true, text: event.target.value })} />}
        {validation && <p role="alert">{validation}</p>}
      </fieldset>;
    })}</div>
    <footer>{error && !busy && <p role="alert">{error}</p>}<button type="button" className="button" disabled={busy} onClick={cancel}>Cancel</button><button type="button" className="button primary" disabled={!valid} onClick={() => void apply()}>{busy ? "Applying…" : "Apply all changes"}</button></footer>
  </dialog>;
}
