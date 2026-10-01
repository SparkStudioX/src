import { useEffect, useRef, useState } from "react";
import { api, scriptFailureMessage } from "./api";
import Icon from "./Icon";
import { TableBatchEditor } from "./TableBatchEditor";
import { isInput, validateInputs } from "./inputs";
import { resolveTableSelection, tableRowIdentity } from "./tableSelection";
import { tablePage } from "./tableModel";
import { validateDataset } from "./datasets";
import { formatTableCell, resolveTableColumns, validateTableColumns } from "./tableColumns";
import { parseTableEditValue, tableEditRowIdentity, validateTableEditDefinition } from "./tableEditing";
import type { TableSort } from "./tableModel";
import type { CanvasComponent, Dataset, InputValue, NamedQuery, QueryResult, RuntimeParameters, ScriptResult, TableEditIntent, TableColumnDefinition, TableEditDefinition } from "./types";
import "./queryTable.css";

type ViewState = { key: string; filter: string; sort: TableSort; page: number };
type DataState = { key: string; result: QueryResult | null; error: string };
type CellDraft = { key: string | number; version: number; column: string; value: string | boolean; result: QueryResult; busy: boolean; blocked?: string };
type QueryTableProps = {
  data?: Dataset;
  queryId: string; title: string; parameters: RuntimeParameters; queryScope?: "designer" | "runtime";
  publishedAt?: string; communicationLost?: boolean; selectionFields?: Record<string, string>; rowKey?: string; selectionMode?: "single" | "multiple";
  pageSize?: number; tableColumns?: TableColumnDefinition[]; components?: CanvasComponent[]; onSelect?: (fieldKey: string, value: InputValue) => void;
  tableEdit?: TableEditDefinition; onTableEdit?: (edit: TableEditIntent) => Promise<ScriptResult>;
};

export function QueryTable(props: QueryTableProps) {
  if (props.data !== undefined) {
    try { validateDataset(props.data); }
    catch (error) { return <div className="render-table" role="status">{error instanceof Error ? error.message : "Invalid table dataset."}</div>; }
  }
  // A new source/context owns new request and selection state, including when a
  // connection or parameter returns to a previously seen value before it loads.
  const context = JSON.stringify([props.queryScope ?? "designer", props.queryId,
    props.queryScope === "runtime" ? props.publishedAt : undefined, props.parameters, props.tableEdit, props.tableColumns, props.rowKey, props.pageSize, props.selectionMode, props.selectionFields, props.data]);
  return <QueryTableSession key={context} {...props} tableEdit={props.data === undefined ? props.tableEdit : undefined} onTableEdit={props.data === undefined ? props.onTableEdit : undefined} />;
}

function QueryTableSession({ data: suppliedData, queryId, title, parameters, queryScope = "designer", publishedAt, communicationLost = false,
  selectionFields, selectionMode = "single", rowKey, pageSize = 25, tableColumns, tableEdit, onTableEdit, components = [], onSelect,
}: QueryTableProps) {
  // The keyed session resets when supplied data changes. Supplied rows never
  // acquire named-query write provenance, even when a query is also configured.
  const supplied = useRef<QueryResult | null>(suppliedData === undefined ? null : { ...suppliedData, durationMs: 0 }).current;
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<DataState>({ key: "", result: null, error: "" });
  const [view, setView] = useState<ViewState>({ key: "", filter: "", sort: null, page: 0 });
  const [selected, setSelected] = useState<{ key: string; value: string | number } | null>(null);
  const [selectionError, setSelectionError] = useState<{ key: string; message: string } | null>(null);
  const [metadata, setMetadata] = useState<{ key: string; names: string[]; error: string } | null>(null);
  const [draft, setDraft] = useState<CellDraft | null>(null);
  const [multipleKeys, setMultipleKeys] = useState<(string | number)[]>([]);
  const [batch, setBatch] = useState<{ result: QueryResult; keys: (string | number)[] } | null>(null);
  const multiple = selectionMode === "multiple" || Boolean(tableEdit?.batch);
  const [editStatus, setEditStatus] = useState<{ error: boolean; message: string } | null>(null);
  const mounted = useRef(true), operation = useRef(0), saving = useRef(false);
  const publication = queryScope === "runtime" ? publishedAt : undefined;
  const sourceKey = JSON.stringify([queryScope, queryId, publication]);
  const metadataKey = JSON.stringify([sourceKey, refresh]);
  const parameterKey = JSON.stringify(parameters);
  const contextKey = JSON.stringify([sourceKey, parameterKey, communicationLost]);
  const selectionKey = JSON.stringify([contextKey, rowKey, selectionFields]);
  const viewKey = JSON.stringify([sourceKey, parameterKey, pageSize, tableColumns]);
  const fetchKey = JSON.stringify([contextKey, refresh]);
  const currentView = view.key === viewKey ? view : { key: viewKey, filter: "", sort: null, page: 0 };
  const latestResult = supplied ?? (data.key === fetchKey ? data.result : null);
  // Keep the edited cell and its neighboring rows stable while newer results
  // independently check the captured row version. Never overwrite typed text.
  const result = draft?.result ?? batch?.result ?? latestResult;
  const error = data.key === fetchKey ? data.error : "";
  const metadataError = metadata?.key === metadataKey ? metadata.error : "";
  const sizeValid = Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 100;
  const columnDefinitionError = validateTableColumns(tableColumns);
  const resolved = result ? resolveTableColumns(tableColumns, result.columns) : { columns: [], error: null };
  const columnError = columnDefinitionError || resolved.error;
  const columns = resolved.columns;
  const configured = Boolean(tableColumns?.length);
  const projection = tablePage(result, currentView.filter, currentView.sort, currentView.page, sizeValid ? pageSize : 25, configured ? {
    columns: columns.map(column => column.key),
    cellText: (row, key) => formatTableCell(row[key], columns.find(column => column.key === key)!).text,
  } : undefined);
  const canSelect = Boolean(!multiple && !batch && !draft && !columnError && onSelect && selectionFields && Object.keys(selectionFields).length);
  const formattedRows = projection.rows.map(row => columns.map(column => formatTableCell(row[column.key], column)));
  const formatErrors = formattedRows.reduce((count, cells) => count + cells.filter(cell => cell.error).length, 0);
  const fixedWidth = columns.length > 0 && columns.every(column => column.width !== undefined);
  const minimumWidth = columns.reduce((sum, column) => sum + (column.width ?? 120), multiple ? 44 : 0);
  const selectedKey = selected?.key === selectionKey && result?.rows.some(row => rowKey && row[rowKey] === selected.value) ? selected.value : undefined;
  const stableRowKeys = Boolean(rowKey && result?.rows.length && resolveTableSelection(result.rows, result.rows[0], rowKey, {}).ok);
  function updateView(patch: Partial<Omit<ViewState, "key">>) { if (!draft && !batch) setView({ ...currentView, ...patch }); }
  const { editColumns, editingColumn, parsedEdit, editingError, liveConflict, editBlock, canSave } = resolveEditingState();

  function resolveEditingState() {
    const editDefinitionError = tableEdit === undefined ? null : validateTableEditDefinition(tableEdit, rowKey ?? "", queryScope === "runtime");
    const editColumns = tableEdit && !editDefinitionError ? tableEdit.columns : [];
    const editingColumn = draft ? editColumns.find(column => column.key === draft.column) : undefined;
    const parsedEdit = draft && editingColumn ? parseTableEditValue(draft.value, editingColumn) : { error: "The editable column is unavailable." };
    const missingEditSource = tableEdit && result && !editDefinitionError
      ? [rowKey ?? "", tableEdit.versionColumn, ...editColumns.map(column => column.key)].find(key => !result.columns.includes(key)) : undefined;
    const rowIdentityError = tableEdit && !editDefinitionError && result?.rows.length ? tableEditRowIdentity(result.rows, result.rows[0], rowKey, tableEdit.versionColumn).error : undefined;
    const missingRowSource = result?.rows.some(row => editColumns.some(column => !Object.hasOwn(row, column.key)));
    const editingError = editDefinitionError || (missingEditSource === undefined ? null : `Editing requires source column "${missingEditSource}" in the query result.`) || rowIdentityError || (missingRowSource ? "Every query row must contain each editable source column." : undefined);
    let liveConflict: string | undefined;
    if (draft && tableEdit && latestResult) {
      const row = latestResult.rows.find(row => rowKey && Object.hasOwn(row, rowKey) && row[rowKey] === draft.key);
      const identity = row ? tableEditRowIdentity(latestResult.rows, row, rowKey ?? "", tableEdit.versionColumn) : undefined;
      if (!row) liveConflict = "This row is no longer in the query result. Reload current data before editing again.";
      else if (identity?.error) liveConflict = identity.error;
      else if (identity?.version !== draft.version) liveConflict = "This row changed while you were editing. Reload current data before editing again.";
      else if (editColumns.some(column => !latestResult.columns.includes(column.key)) || latestResult.rows.some(item => editColumns.some(column => !Object.hasOwn(item, column.key)))) liveConflict = "An editable column is no longer available in every row. Reload current data before editing again.";
    }
    const editBlock = draft?.blocked || liveConflict || editingError || (communicationLost ? "Communication lost. Your edit is retained until data is available." : !latestResult || metadataError || error ? "Current data could not be verified. Your edit is retained while the query recovers." : !onTableEdit && !draft?.busy ? "Editing is unavailable in this session." : undefined);
    const canSave = Boolean(draft && !draft.busy && !saving.current && !editBlock && !parsedEdit.error && parsedEdit.value !== undefined && onTableEdit && queryScope === "runtime");


    return { editColumns, editingColumn, parsedEdit, editingError, liveConflict, editBlock, canSave };
  }

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current++; }; }, []);
  useEffect(() => {
    if (liveConflict) setDraft(previous => previous && !previous.blocked ? { ...previous, blocked: liveConflict } : previous);
  }, [liveConflict]);

  useEffect(() => {
    const refreshTable = () => setRefresh(value => value + 1);
    window.addEventListener("sparkstudio:refresh-data", refreshTable);
    window.addEventListener("sparkstudio:refresh-queries", refreshTable);
    return () => {
      window.removeEventListener("sparkstudio:refresh-data", refreshTable);
      window.removeEventListener("sparkstudio:refresh-queries", refreshTable);
    };
  }, []);
  useEffect(() => { setSelected(null); setMultipleKeys([]); setSelectionError(null); }, [selectionKey]);
  // Commit the reset so returning to an earlier configuration cannot revive its
  // previous filter, sort or page while leaving unrelated form inputs intact.
  useEffect(() => {
    setView(previous => previous.key === viewKey ? previous : { key: viewKey, filter: "", sort: null, page: 0 });
  }, [viewKey]);
  // Clamp a page after a refreshed result shrinks; subsequent growth cannot jump it back.
  useEffect(() => {
    if (result && currentView.page !== projection.page) setView(previous => previous.key === viewKey ? { ...previous, page: projection.page } : previous);
  }, [result, currentView.page, projection.page, viewKey]);
  useEffect(() => {
    let stopped = false;
    if (supplied || !queryId) return;
    void api<Pick<NamedQuery, "id" | "kind" | "parameters">[]>(
      `${queryScope === "runtime" ? "/runtime" : ""}/queries${publication === undefined ? "" : `?publishedAt=${encodeURIComponent(publication)}`}`,
    ).then(queries => {
      if (stopped) return;
      const definition = queries.find(query => query.id === queryId);
      if (!definition || definition.kind === "update") throw new Error("The named query is not available as a read query in this application.");
      setMetadata({ key: metadataKey, names: definition.parameters.map(parameter => parameter.name), error: "" });
    }).catch(reason => {
      if (!stopped) setMetadata({ key: metadataKey, names: [], error: reason instanceof Error ? reason.message : String(reason) });
    });
    return () => { stopped = true; };
  }, [supplied, queryId, queryScope, metadataKey, publication]);
  useEffect(() => {
    if (supplied || !queryId || communicationLost || metadata?.key !== metadataKey || metadata.error) return;
    let stopped = false, generation = 0;
    const context = JSON.parse(parameterKey) as RuntimeParameters;
    const queryParameters = Object.fromEntries(metadata.names.filter(name => Object.hasOwn(context, name)).map(name => [name, context[name]]));
    const run = () => {
      const request = ++generation;
      void api<QueryResult>(`${queryScope === "runtime" ? "/runtime" : ""}/queries/${encodeURIComponent(queryId)}/execute`, "POST",
        { parameters: queryParameters, ...(publication === undefined ? {} : { publishedAt: publication }) })
        .then(result => { if (!stopped && request === generation) setData({ key: fetchKey, result, error: "" }); })
        .catch(reason => { if (!stopped && request === generation) setData({ key: fetchKey, result: null, error: reason instanceof Error ? reason.message : String(reason) }); });
    };
    run();
    const interval = setInterval(run, 10000);
    return () => { stopped = true; generation++; clearInterval(interval); };
  }, [supplied, queryId, parameterKey, queryScope, publication, communicationLost, metadata, metadataKey, fetchKey]);

  useEffect(() => {
    if (latestResult && !batch) setMultipleKeys(previous => previous.filter(key => latestResult.rows.some(row => rowKey && row[rowKey] === key)));
  }, [latestResult, rowKey, batch]);
  function toggleRow(row: Record<string, unknown>) {
    if (!multiple || batch || draft || communicationLost || !result || !stableRowKeys || !sizeValid || columnError) return;
    const identity = resolveTableSelection(result.rows, row, rowKey, {});
    if (!identity.ok) { setSelectionError({ key: selectionKey, message: identity.error }); return; }
    setMultipleKeys(previous => previous.includes(identity.key) ? previous.filter(key => key !== identity.key) : previous.length < 100 ? [...previous, identity.key] : previous);
  }
  function startBatch() {
    if (!tableEdit?.batch || !onTableEdit || queryScope !== "runtime" || communicationLost || !latestResult || editingError || columnError || !sizeValid || !multipleKeys.length || batch || draft) return;
    if (multipleKeys.some(key => !latestResult.rows.some(row => row[rowKey!] === key))) { setMultipleKeys([]); return; }
    setBatch({ result: latestResult, keys: [...multipleKeys] });
  }
  function closeBatch(reload: boolean) {
    setBatch(null);
    if (reload) { setMultipleKeys([]); setData({ key: "", result: null, error: "" }); setRefresh(value => value + 1); }
  }
  function startEdit(row: Record<string, unknown>, key: string) {
    if (tableEdit?.batch || batch || draft || saving.current || !onTableEdit || queryScope !== "runtime" || communicationLost || !latestResult || columnError || editingError || !sizeValid || !tableEdit) return;
    const column = editColumns.find(column => column.key === key);
    if (!column || !Object.hasOwn(row, key)) { setEditStatus({ error: true, message: "The editable source column is unavailable." }); return; }
    const identity = tableEditRowIdentity(latestResult.rows, row, rowKey, tableEdit.versionColumn);
    if (identity.error || identity.key === undefined || identity.version === undefined) { setEditStatus({ error: true, message: identity.error || "The row cannot be identified safely." }); return; }
    const value = row[key];
    // A null or mismatched Boolean begins unselected. Choosing a value is
    // explicit; opening the editor never invents false, zero or a write.
    const initial = column.type === "boolean" ? typeof value === "boolean" ? value : ""
      : value === null || value === undefined ? "" : typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
    setDraft({ key: identity.key, version: identity.version, column: key, value: initial, result: latestResult, busy: false });
    setEditStatus(null); setSelectionError(null);
  }
  function cancelEdit(reload = false) {
    if (saving.current || draft?.busy) return;
    const mustReload = reload || Boolean(draft?.blocked || liveConflict);
    operation.current++; setDraft(null); setEditStatus(null);
    // Discarding a failed attempt cannot make its old snapshot editable again.
    // Both Cancel and explicit reload require a newly verified query result.
    if (mustReload) { setData({ key: "", result: null, error: "" }); setSelected(null); setRefresh(value => value + 1); }
  }
  async function saveEdit() {
    if (!canSave || !draft || !onTableEdit || parsedEdit.value === undefined || saving.current) return;
    const attempted = draft, run = ++operation.current;
    saving.current = true; setDraft({ ...draft, busy: true }); setEditStatus(null);
    try {
      const outcome = await onTableEdit({ key: draft.key, version: draft.version, column: draft.column, value: parsedEdit.value });
      if (!mounted.current || run !== operation.current) return;
      if (!outcome.success) {
        setDraft(previous => previous && ({ ...previous, busy: false, blocked: `${scriptFailureMessage(outcome.stderr || "The gateway script rejected this edit.")} Reload current data before another attempt.` }));
        return;
      }
      setDraft(null); setSelected(null);
      setEditStatus({ error: false, message: `Saved ${attempted.column}.` });
      setRefresh(value => value + 1);
    } catch (reason) {
      if (!mounted.current || run !== operation.current) return;
      const detail = reason instanceof Error ? reason.message : String(reason);
      setDraft(previous => previous && ({ ...previous, busy: false, blocked: `Save could not be confirmed: ${detail}. Reload current data before another attempt.` }));
    } finally {
      if (mounted.current && run === operation.current) saving.current = false;
    }
  }

  function selectRow(row: Record<string, unknown>) {
    if (batch || draft || !canSelect || !onSelect || !selectionFields || communicationLost || !result || !sizeValid) return;
    const selection = resolveTableSelection(result.rows, row, rowKey, selectionFields, (field, value) => {
      const targets = components.filter(item => isInput(item.type) && (item.props.fieldKey || item.id) === field);
      if (targets.length !== 1) return `Mapped field ${field} must name one input in this form.`;
      return validateInputs({ id: "selection", name: "Selection", width: 1, height: 1, components: targets }, { [field]: value }, parameters);
    });
    if (!selection.ok) { setSelectionError({ key: selectionKey, message: selection.error }); return; }
    setSelectionError(null); setSelected({ key: selectionKey, value: selection.key });
    for (const [field, value] of selection.changes) onSelect(field, value);
  }
  const unavailable = communicationLost || (!supplied && !queryId) || Boolean(metadataError || error || columnError) || !result || !sizeValid;
  // Pure render helpers share this hook owner, preserving child keys and edit lifetimes.
  function renderTableRows(result: QueryResult) {
    return (<div className="data-table-wrap">
      <table className={`data-table${configured ? " configured-columns" : ""}`} aria-label={title}
        style={configured ? { minWidth: minimumWidth, width: fixedWidth ? minimumWidth : "100%" } : undefined}>
        <colgroup>{multiple && <col style={{ width: 44 }} />}{columns.map(column => <col key={column.key} style={{ width: column.width }} />)}</colgroup>
        <thead><tr>{multiple && <th scope="col">Select</th>}{columns.map(column => <th key={column.key} style={{ textAlign: column.align }} aria-sort={currentView.sort?.column === column.key ? currentView.sort.descending ? "descending" : "ascending" : "none"}>
          <button type="button" className="table-sort" title={column.label} disabled={Boolean(draft || batch)} onClick={() => updateView({ sort: { column: column.key, descending: currentView.sort?.column === column.key && !currentView.sort.descending }, page: 0 })}>
            {column.label}{currentView.sort?.column === column.key ? currentView.sort.descending ? " ↓" : " ↑" : ""}
          </button></th>)}</tr></thead>
        <tbody>{projection.rows.map((row, index) => <tr key={stableRowKeys ? tableRowIdentity(row[rowKey!]) : projection.start + index}
          tabIndex={canSelect || multiple && stableRowKeys ? 0 : undefined} aria-selected={multiple ? multipleKeys.includes(row[rowKey!] as string | number) : canSelect ? selectedKey !== undefined && row[rowKey!] === selectedKey : undefined}
          className={canSelect || multiple ? "selectable-row" : undefined} onClick={() => multiple ? toggleRow(row) : selectRow(row)}
          onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (multiple) toggleRow(row); else selectRow(row); } }}>
          {multiple && <td><input type="checkbox" aria-label={`Select row ${String(row[rowKey!])} (${typeof row[rowKey!]})`} checked={multipleKeys.includes(row[rowKey!] as string | number)} disabled={Boolean(batch || draft) || communicationLost || !stableRowKeys || !sizeValid || (!multipleKeys.includes(row[rowKey!] as string | number) && multipleKeys.length >= 100)} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onChange={() => toggleRow(row)} /></td>}
          {columns.map((column, columnIndex) => {
            const cell = formattedRows[index][columnIndex];
            const editable = editColumns.find(item => item.key === column.key);
            const active = draft && rowKey && row[rowKey] === draft.key && column.key === draft.column;
            const identity = editable && rowKey && tableEdit ? { key: editingError ? undefined : row[rowKey] as string | number, error: editingError } : undefined;
            const editLabel = `Edit ${column.label} for row ${identity?.key ?? "unavailable"}`;
            return <td key={column.key} style={{ textAlign: column.align }} className={active ? "table-cell-editing" : cell.error ? "table-cell-error" : undefined}
              title={active ? undefined : cell.error || cell.text} aria-label={cell.error && !active ? `${column.label}: ${cell.error}` : undefined}>
              {active && draft && editingColumn ? <div className="table-cell-editor" onClick={event => event.stopPropagation()} onKeyDown={event => {
                event.stopPropagation();
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") { event.preventDefault(); cancelEdit(); }
                if (event.key === "Enter" && (event.target as HTMLElement).tagName !== "BUTTON") { event.preventDefault(); void saveEdit(); }
              }}>
                <label><span className="table-editor-label">{column.label} · row {String(draft.key)}</span>
                  {editingColumn.type === "boolean" ? <select autoFocus aria-label={`New ${column.label}`} disabled={draft.busy || !onTableEdit} value={typeof draft.value === "boolean" ? String(draft.value) : ""}
                    onChange={event => { if (saving.current || !onTableEdit) return; const value = event.target.value; setDraft(previous => previous && ({ ...previous, value: value === "true" ? true : value === "false" ? false : "" })); }}>
                    <option value="" disabled>Choose a value…</option><option value="true">True</option><option value="false">False</option>
                  </select> : <input autoFocus type="text" inputMode={editingColumn.type === "number" ? "decimal" : undefined} aria-label={`New ${column.label}`} aria-invalid={Boolean(parsedEdit.error)}
                    disabled={draft.busy || !onTableEdit} value={String(draft.value)} maxLength={editingColumn.type === "string" ? editingColumn.maxLength ?? 4096 : undefined}
                    onChange={event => { if (!saving.current && onTableEdit) setDraft(previous => previous && ({ ...previous, value: event.target.value })); }} />}
                </label>
                {parsedEdit.error && <span className="table-edit-validation" role="alert">{parsedEdit.error}</span>}
                <div className="table-cell-edit-actions"><button type="button" disabled={!canSave} onClick={() => void saveEdit()}>{draft.busy ? "Saving…" : "Save"}</button><button type="button" disabled={draft.busy} onClick={() => cancelEdit()}>Cancel</button></div>
              </div> : <><span>{cell.text}</span>{editable && !tableEdit?.batch && queryScope === "runtime" && onTableEdit && <button type="button" className="table-cell-edit" aria-label={editLabel}
                disabled={Boolean(draft || batch) || communicationLost || Boolean(identity?.error || editingError || columnError) || !sizeValid || !latestResult}
                title={identity?.error || editingError || "Edit this value"} onClick={event => { event.stopPropagation(); startEdit(row, column.key); }}
                onKeyDown={event => event.stopPropagation()}>Edit</button>}</>}
            </td>;
          })}
        </tr>)}</tbody>
      </table>
      {!projection.filtered && <div className="widget-empty">{result.rows.length ? "No rows match this filter." : "No rows returned."}</div>}
    </div>);
  }

  function renderSelectionToolbar() {
    return (<div className="table-selection-toolbar"><span role="status">{multipleKeys.length} / 100 rows selected</span><button type="button" className="button small" disabled={Boolean(batch || draft) || unavailable || !stableRowKeys} onClick={() => setMultipleKeys(previous => [...new Set([...previous, ...projection.rows.map(row => row[rowKey!] as string | number)])].slice(0, 100))}>Select page</button><button type="button" className="button small" disabled={Boolean(batch || draft) || !multipleKeys.length} onClick={() => setMultipleKeys([])}>Clear selection</button>
      {tableEdit?.batch && <button type="button" className="button small" disabled={Boolean(batch || draft) || unavailable || Boolean(editingError) || !multipleKeys.length || queryScope !== "runtime" || !onTableEdit} onClick={startBatch}>Edit selected rows</button>}
      {result?.rows.length && !stableRowKeys ? <span role="alert">Multiple selection requires unique text or safe integer row keys.</span> : null}
    </div>);
  }

  function renderTablePagination() {
    return (<div className="table-pagination" aria-label={`Paging ${title}`}>
      <span aria-live="polite">{unavailable ? "Rows unavailable" : `${projection.start}–${projection.end} of ${projection.filtered}${currentView.filter ? ` matches (${projection.total} loaded)` : " loaded"}`}</span>
      <div className="table-pagination-actions">
        <button type="button" aria-label={`Previous page of ${title}`} disabled={Boolean(draft || batch) || unavailable || projection.page === 0} onClick={() => updateView({ page: projection.page - 1 })}>Previous</button>
        <span>Page {projection.page + 1} of {projection.pages}</span>
        <button type="button" aria-label={`Next page of ${title}`} disabled={Boolean(draft || batch) || unavailable || projection.page + 1 === projection.pages} onClick={() => updateView({ page: projection.page + 1 })}>Next</button>
      </div>
    </div>);
  }

  function renderTable() {
    return (<div className="render-table">
      <div className="table-title">
        <strong>{title}</strong><span>{result?.rows.length ?? 0} loaded</span>
        <input className="table-filter" aria-label={`Filter ${title}`} placeholder="Filter rows…" value={currentView.filter} disabled={Boolean(draft || batch)}
          onChange={event => updateView({ filter: event.target.value, page: 0 })} />
        <button type="button" className="icon-button" title={`Refresh ${title}`} disabled={Boolean(supplied || draft || batch) || communicationLost || !queryId}
          onClick={() => { if (draft || batch) return; setSelectionError(null); setEditStatus(null); setRefresh(value => value + 1); }}><Icon name="refresh" size={14} /></button>
      </div>
      {multiple && renderSelectionToolbar()}
      {renderBatchEditStatus()}
      {batch && tableEdit?.batch && rowKey && <TableBatchEditor snapshot={batch.result} keys={batch.keys} rowKey={rowKey} definition={tableEdit} current={latestResult} unavailable={communicationLost ? "Communication lost. Changes are retained until data is available." : metadataError || error || editingError || undefined} onApply={queryScope === "runtime" ? onTableEdit : undefined} onClose={closeBatch} />}
      {selectionError?.key === selectionKey && <div className="inline-error" role="alert">{selectionError.message}</div>}
      {editStatus && <div className={`table-edit-status${editStatus.error ? " error-text" : ""}`} role={editStatus.error ? "alert" : "status"}>{editStatus.message}</div>}
      {tableEdit && !tableEdit.batch && !draft && <div className={`table-edit-status${editingError ? " error-text" : ""}`} role={editingError ? "alert" : "status"}>{editingError || (queryScope !== "runtime" ? "Cell editing is available in the published operator application." : !onTableEdit ? "Cell editing is unavailable in this session." : "Use a cell's Edit button to change one value. Save applies the edit through the gateway.")}</div>}
      {renderCellEditStatus()}
      {columnError ? <div className="widget-empty error-text" role="alert">{columnError}</div>
        : !sizeValid ? <div className="widget-empty error-text">Table page size must be a whole number from 1 to 100.</div>
          : communicationLost && !draft ? <div className="widget-empty error-text"><Icon name="info" size={18} /> Communication lost. Query results are unavailable.</div>
            : !supplied && !queryId ? <div className="widget-empty">{queryScope === "runtime" ? "No data source is configured for this table." : "Choose a named query or supply a dataset in Properties."}</div>
              : (metadataError || error) && !draft ? <div className="widget-empty error-text">{metadataError || error}</div>
                : !result ? <div className="widget-empty">Loading query…</div>
                  : renderTableRows(result)}
      {!unavailable && formatErrors > 0 && <div className="table-format-notice" role="status">{formatErrors} {formatErrors === 1 ? "cell on this page cannot use its" : "cells on this page cannot use their"} configured format. Hover a marked cell for details.</div>}
      {renderTablePagination()}
    </div>);
  }

  function renderCellEditStatus() {
    return (draft && <div className={`table-edit-status${editBlock && !draft.busy ? " error-text" : ""}`} role={editBlock && !draft.busy ? "alert" : "status"}>
      <span>{draft.busy ? "Saving this cell…" : editBlock || "Editing one cell. Displayed rows are held while live data checks for changes."}</span>
      {(draft.blocked || liveConflict) && <button type="button" className="button small" disabled={draft.busy || communicationLost} onClick={() => cancelEdit(true)}>Reload and discard edit</button>}
    </div>);
  }

  function renderBatchEditStatus() { return (tableEdit?.batch && <div className="table-edit-status" role={editingError ? "alert" : "status"}>{editingError || (queryScope !== "runtime" ? "Atomic editing is available in the published operator application." : !onTableEdit ? "Atomic editing is unavailable in this session." : "Select rows, stage cell changes, then Apply or Cancel the complete batch.")}</div>); }

  return renderTable();
}
