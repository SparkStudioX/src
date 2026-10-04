import { useEffect, useRef, useState } from "react";
import { collectDesignerDiagnostics, filterDesignerDiagnostics } from "./designerDiagnostics";
import { collectModelDiagnostics } from "./designerModel";
import { getModelInstances, getModelTypes, modelChangedEvent } from "./modelApi";
import type { DesignerDiagnostic } from "./designerDiagnostics";
import type { DesignerDiagnosticOptions, DiagnosticCategory } from "./designerDiagnostics";
import type { ComponentEventCoordinator } from "./componentEventModel";
import type { SearchTarget } from "./projectSearch";
import "./designerDiagnostics.css";

const categories: ["all" | DiagnosticCategory, string][] = [["all", "All categories"], ["binding", "Property bindings"], ["query", "Query properties"], ["reference", "Resource references"], ["quality", "Tag quality / connection"], ["browser-event", "Browser component events"], ["model", "Model requirements"]];
const labels = new Map(categories);
export function DesignerDiagnostics({ eventCoordinator, onOpen, onClose, ...options }: Omit<DesignerDiagnosticOptions, "events"> & {
  eventCoordinator?: ComponentEventCoordinator; onOpen: (target: SearchTarget) => void; onClose: () => void;
}) {
  const capture = () => collectDesignerDiagnostics({ ...options, events: eventCoordinator?.snapshot() });
  const [snapshot, setSnapshot] = useState(capture);
  const [modelRows, setModelRows] = useState<DesignerDiagnostic[]>([]), [modelError, setModelError] = useState(""), [modelLoading, setModelLoading] = useState(false), [modelRevision, setModelRevision] = useState(0);
  const [category, setCategory] = useState<"all" | DiagnosticCategory>("all");
  const [level, setLevel] = useState("all"), [term, setTerm] = useState(""), [page, setPage] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal(); return () => focus?.focus();
  }, []);
  useEffect(() => { const refresh = () => setModelRevision(value => value + 1); window.addEventListener(modelChangedEvent, refresh); return () => window.removeEventListener(modelChangedEvent, refresh); }, []);
  useEffect(() => {
    const controller = new AbortController(); setModelRows([]); setModelError(""); setModelLoading(false);
    if (!(options.project.templates ?? []).some(template => Object.keys(template.modelParameters ?? {}).length)) return;
    setModelLoading(true);
    Promise.all([getModelTypes(controller.signal), getModelInstances(undefined, controller.signal)]).then(([types, instances]) => setModelRows(collectModelDiagnostics(options.project, types, instances)))
      .catch(reason => { if (!controller.signal.aborted) setModelError(reason instanceof Error ? reason.message : "Model requirements could not be checked."); })
      .finally(() => { if (!controller.signal.aborted) setModelLoading(false); });
    return () => controller.abort();
  }, [options.project, modelRevision]);
  const allRows = [...snapshot.rows, ...modelRows];
  const filtered = filterDesignerDiagnostics(allRows, category, term, level);
  const pages = Math.max(1, Math.ceil(filtered.length / 50)), currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * 50, (currentPage + 1) * 50);
  const counts = { errors: allRows.filter(row => row.level === "error").length, warnings: allRows.filter(row => row.level === "warning").length };
  return <dialog ref={dialog} className="designer-diagnostics-dialog" aria-labelledby="designer-diagnostics-title" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") event.preventDefault();
  }}>
    <header><div><small>DESIGNER · LOCAL SNAPSHOT</small><h2 id="designer-diagnostics-title">Project diagnostics</h2><p>Inspect current form bindings, structured references, tag quality and retained component-event messages.</p></div><button type="button" className="button small" onClick={onClose}>Close</button></header>
    <section className="designer-diagnostics-context"><strong>{snapshot.documentName}</strong><span>Captured {new Date(snapshot.capturedAt).toLocaleTimeString()} · {counts.errors} errors · {counts.warnings} warnings</span><button type="button" className="button small" onClick={() => { setSnapshot(capture()); setModelRevision(value => value + 1); setPage(0); }}>Refresh snapshot</button></section>
    {modelLoading && <p role="status">Checking readable gateway model requirements…</p>}{modelError && <p role="alert">Model requirements were not checked: {modelError}</p>}
    <div className="designer-diagnostics-filters"><label>Category<select value={category} onChange={event => { setCategory(event.target.value as typeof category); setPage(0); }}>{categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Severity<select value={level} onChange={event => { setLevel(event.target.value); setPage(0); }}><option value="all">All severities</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Information</option></select></label>
      <label>Filter messages<input value={term} maxLength={256} onChange={event => { setTerm(event.target.value); setPage(0); }} placeholder="Component, property or message" /></label></div>
    <div className="designer-diagnostics-results" aria-label="Diagnostic results">
      {visible.length ? visible.map(row => <article className={`diagnostic-row diagnostic-${row.level}`} key={row.id}>
        <div className="diagnostic-row-heading"><strong>{labels.get(row.category)}</strong><span>{row.level}{row.recordedAt ? ` · ${new Date(row.recordedAt).toLocaleTimeString()}` : ""}</span></div>
        <code>{row.location}</code><p>{row.message}</p>{row.target && <button type="button" className="button small" onClick={() => { onClose(); onOpen(row.target!); }}>Open {row.target.componentId || row.target.id}</button>}
      </article>) : <p className="diagnostics-empty">{snapshot.rows.length ? "No messages match these filters." : "No issues were found in the checked scope. This is not a complete application health check."}</p>}
    </div>
    <footer><p>{snapshot.componentsChecked} root components · {snapshot.bindingsChecked} expression bindings · {snapshot.tagsChecked} tag snapshots. {snapshot.queriesNotCaptured} query samples not captured. {snapshot.referencesChecked ? "Structured project references checked." : "Resource references were not supplied."}</p>
      <div className="diagnostics-page"><button type="button" className="button small" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{filtered.length} messages · Page {currentPage + 1} of {pages}</span><button type="button" className="button small" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</button></div>
      {snapshot.omitted > 0 && <p>{snapshot.omitted} additional messages omitted at the 1,000-message snapshot limit.</p>}
      <details><summary>Scope and limits</summary><p>Expression evaluation uses the current root screen or template form context. Nested template, repeater-row and popup form values are not simulated. Query samples are shown only when supplied; this dialog never executes queries or scripts. Component-event messages include the current run's latest 20 retained entries and may originate in nested forms; duplicate component IDs have no owner shortcut. Python execution history, input-event notices, SQL execution logs and browser-console logs are not collected here. The collector does not copy raw tag or form values. Authored event messages appear as written; do not log secrets. No export is provided.</p></details>
    </footer>
  </dialog>;
}
