import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import { planBulkReplacement, type BulkReplacePlan, type BulkReplaceRequest } from "./bulkReplacement";
import type { SearchTarget } from "./projectSearch";
import type { Project } from "./types";
import "./bulkReplacement.css";

interface BulkReplaceDialogProps {
  project: Project;
  initialFind?: string;
  onApply: (plan: BulkReplacePlan, selectedIds: string[]) => void;
  onClose: () => void;
  onOpenReference?: (target: SearchTarget) => void;
}

const pageSize = 100;
const number = (value: number) => value.toLocaleString();

/** Previewing reads the draft; the parent applies the selected plan as one history step. */
export default function BulkReplaceDialog({ project, initialFind = "", onApply, onClose, onOpenReference }: BulkReplaceDialogProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const resultList = useRef<HTMLDivElement>(null);
  const applying = useRef(false);
  const [request, setRequest] = useState<BulkReplaceRequest>({ find: initialFind, replace: "", matchCase: false, scope: "all", kind: "displayText" });
  const [plan, setPlan] = useState<BulkReplacePlan | null>(null);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current, previousFocus = document.activeElement;
    element?.showModal();
    findInput.current?.focus();
    findInput.current?.select();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  useEffect(() => { if (resultList.current) resultList.current.scrollTop = 0; }, [page, plan]);

  const changes = plan?.changes ?? [];
  const validChanges = useMemo(() => changes.filter(change => change.errors.length === 0), [plan]);
  const selectedChanges = useMemo(() => validChanges.filter(change => selection.has(change.id)), [validChanges, selection]);
  const occurrences = useMemo(() => changes.reduce((sum, change) => sum + change.occurrences, 0), [plan]);
  const selectedOccurrences = selectedChanges.reduce((sum, change) => sum + change.occurrences, 0);
  const pageCount = Math.max(1, Math.ceil(changes.length / pageSize));
  const pageChanges = changes.slice(page * pageSize, (page + 1) * pageSize);
  const pageSelected = pageChanges.filter(change => selection.has(change.id)).length;
  const selectedElsewhere = selectedChanges.length - pageSelected;
  const canApply = Boolean(plan) && !plan?.errors.length && selectedChanges.length > 0 && !error;

  function updateRequest(patch: Partial<BulkReplaceRequest>) {
    setRequest(current => ({ ...current, ...patch }));
    setPlan(null);
    setSelection(new Set());
    setPage(0);
    setError("");
  }

  function preview() {
    setError("");
    try {
      const next = planBulkReplacement(project, request);
      setPlan(next);
      // Large previews never preselect unseen pages. Selecting all is a separate,
      // explicit action and its exact cross-page scope is shown in the summary.
      setSelection(new Set(next.errors.length ? [] : next.changes.slice(0, pageSize).filter(change => !change.errors.length).map(change => change.id)));
      setPage(0);
    } catch (cause) {
      setPlan(null);
      setSelection(new Set());
      setError(cause instanceof Error ? cause.message : "The replacement preview could not be prepared.");
    }
  }

  function selectChange(changeId: string, checked: boolean) {
    setSelection(current => {
      const next = new Set(current);
      if (checked) next.add(changeId); else next.delete(changeId);
      return next;
    });
  }

  function apply() {
    if (!plan || !canApply || applying.current) return;
    applying.current = true;
    try {
      onApply(plan, selectedChanges.map(change => change.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The replacements could not be applied. Refresh the preview before trying again.");
    } finally {
      applying.current = false;
    }
  }

  return createPortal(<dialog ref={dialog} className="bulk-replace-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && ["s", "h"].includes(event.key.toLowerCase())) event.preventDefault();
    }}>
    <header className="bulk-replace-heading">
      <div><h2 id={`${id}-title`}>Replace in project</h2><p id={`${id}-description`}>Preview literal replacements, then choose which properties to change in this project draft.</p></div>
      <button type="button" className="icon-button" aria-label="Close replacement preview" onClick={onClose}><Icon name="close" size={18} /></button>
    </header>
    <div className="bulk-replace-controls">
      <div className="bulk-replace-fields">
        <label htmlFor={`${id}-find`}><span>Find text</span><input ref={findInput} id={`${id}-find`} value={request.find} autoComplete="off" spellCheck={false} onChange={event => updateRequest({ find: event.target.value })} /></label>
        <label htmlFor={`${id}-replace`}><span>Replace with</span><input id={`${id}-replace`} value={request.replace} autoComplete="off" spellCheck={false} placeholder="Leave empty to remove matching text" onChange={event => updateRequest({ replace: event.target.value })} /></label>
        <label htmlFor={`${id}-family`}><span>Property family</span><select id={`${id}-family`} value={request.kind} onChange={event => updateRequest({ kind: event.target.value as BulkReplaceRequest["kind"] })}><option value="displayText">Display text</option><option value="tagPaths">Tag paths</option></select></label>
        <label htmlFor={`${id}-scope`}><span>Look in</span><select id={`${id}-scope`} value={request.scope} onChange={event => updateRequest({ scope: event.target.value as BulkReplaceRequest["scope"] })}><option value="all">All screens and templates</option><option value="screens">Screens</option><option value="templates">Templates</option></select></label>
      </div>
      <div className="bulk-replace-preview-controls"><label className="bulk-replace-checkbox"><input type="checkbox" checked={request.matchCase} onChange={event => updateRequest({ matchCase: event.target.checked })} />Match case</label><span>Plain text only; no regular expressions.</span><button type="button" className="button" onClick={preview}>Preview replacements</button></div>
      <p className="bulk-replace-boundary">Resource IDs, code, SQL, expressions and input values are excluded. Indirection parameter tokens stay unchanged. Only properties in the selected family can appear in the preview.</p>
      {request.kind === "displayText" && <p className="bulk-replace-boundary">Bound text changes its saved fallback; the binding can override it at runtime.</p>}
      {request.kind === "tagPaths" && <p className="bulk-replace-tag-note">Check replacement paths against the gateway’s available tag providers and tags. This preview does not verify that a tag exists or is available.</p>}
    </div>
    {error && <div className="bulk-replace-error" role="alert"><p>{error}</p><button type="button" className="button small" onClick={preview}>Refresh preview</button></div>}
    {plan && plan.errors.length > 0 && <div className="bulk-replace-error" role="alert"><ul>{plan.errors.map((message, index) => <li key={index}>{message}</li>)}</ul></div>}
    <div className="bulk-replace-result-area">
      {!plan ? <div className="bulk-replace-empty"><strong>Preview before replacing</strong><p>Set the text and scope, then select Preview replacements. Editing these controls clears the previous preview and selection.</p></div>
        : <>
          <div className="bulk-replace-summary" role="status"><strong>{number(changes.length)} matching {changes.length === 1 ? "property" : "properties"} · {number(occurrences)} {occurrences === 1 ? "occurrence" : "occurrences"}</strong><span>{number(selectedChanges.length)} {selectedChanges.length === 1 ? "property" : "properties"} selected · {number(selectedOccurrences)} {selectedOccurrences === 1 ? "replacement" : "replacements"}{changes.length > validChanges.length && ` · ${number(changes.length - validChanges.length)} invalid and unavailable for selection`}</span></div>
          {changes.length > 0 && <div className="bulk-replace-selection">
            <div><button type="button" className="button small" disabled={!validChanges.length || Boolean(plan.errors.length)} onClick={() => setSelection(new Set(validChanges.map(change => change.id)))}>Select all {number(validChanges.length)} valid properties{pageCount > 1 ? " (all pages)" : ""}</button><button type="button" className="button small" disabled={!selection.size} onClick={() => setSelection(new Set())}>Clear selection</button></div>
            {pageCount > 1 && <p>Only valid properties on the first page are initially selected. <strong>{number(selectedElsewhere)} selected {selectedElsewhere === 1 ? "property is" : "properties are"} on other pages.</strong> Apply includes selected properties from every page.</p>}
          </div>}
          <div ref={resultList} className="bulk-replace-results" role="list" aria-label="Replacement preview">
            {pageChanges.map((change, index) => <div className={`bulk-replace-result${change.errors.length ? " invalid" : ""}`} role="listitem" key={change.id}>
              <div className="bulk-replace-result-heading"><label className="bulk-replace-checkbox"><input type="checkbox" aria-label={`Replace ${change.property} in ${change.location}`} disabled={Boolean(change.errors.length || plan.errors.length)} checked={selection.has(change.id)} onChange={event => selectChange(change.id, event.target.checked)} /><span><strong>{change.location}</strong><code>{change.property}</code></span></label><span>{number(change.occurrences)} {change.occurrences === 1 ? "occurrence" : "occurrences"}</span>
                {onOpenReference && <button type="button" className="button small" aria-label={`Open ${change.location}, ${change.property}`} onClick={() => { onClose(); onOpenReference(change.target); }}>Open<Icon name="arrow" size={12} /></button>}
              </div>
              <div className="bulk-replace-values"><div><span id={`${id}-before-${index}`}>Before</span><pre aria-labelledby={`${id}-before-${index}`}>{change.before || <em>(empty)</em>}</pre></div><div><span id={`${id}-after-${index}`}>After</span><pre aria-labelledby={`${id}-after-${index}`}>{change.after || <em>(empty)</em>}</pre></div></div>
              {change.errors.length > 0 && <ul className="bulk-replace-row-errors">{change.errors.map((message, errorIndex) => <li key={errorIndex}>{message}</li>)}</ul>}
            </div>)}
            {!changes.length && !plan.errors.length && <div className="bulk-replace-empty"><strong>No replacements found</strong><p>Try different text, a broader scope or another property family. Values that would stay unchanged are omitted.</p></div>}
          </div>
          {changes.length > 0 && <nav className="bulk-replace-pages" aria-label="Replacement result pages"><span>Showing {number(page * pageSize + 1)}–{number(Math.min((page + 1) * pageSize, changes.length))} of {number(changes.length)} properties</span><button type="button" className="button small" disabled={page === 0} onClick={() => setPage(current => current - 1)}>Previous page</button><span>Page {number(page + 1)} of {number(pageCount)}</span><button type="button" className="button small" disabled={page + 1 >= pageCount} onClick={() => setPage(current => current + 1)}>Next page</button></nav>}
        </>}
    </div>
    <footer className="bulk-replace-footer"><span>Selected replacements share one Undo step. Save and publish to update the operator application.</span><button type="button" className="button" onClick={onClose}>Cancel</button><button type="button" className="button primary" disabled={!canApply} onClick={apply}>Apply {number(selectedChanges.length)} selected {selectedChanges.length === 1 ? "property" : "properties"}</button></footer>
  </dialog>, document.body);
}
