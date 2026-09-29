import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import type { SearchEntry, SearchTarget } from "./projectSearch";
import type { ResourceChangePlan } from "./resourceChanges";
import "./resourceChanges.css";

interface ResourceChangeDialogProps {
  plan: ResourceChangePlan;
  onNameChange: (name: string) => void;
  onApply: () => void;
  onClose: () => void;
  onOpenReference: (target: SearchTarget) => void;
  loading?: boolean;
  loadError?: string;
  onRetry?: () => void;
  retryLabel?: string;
}

function ReferenceList({ entries, label, onOpen, showText = false }: { entries: SearchEntry[]; label: string; onOpen: (target: SearchTarget) => void; showText?: boolean }) {
  return <ul className="resource-change-references" aria-label={label}>
    {entries.map(entry => <li key={entry.id}><button type="button" onClick={() => onOpen(entry.target)} title={`Open ${entry.location}`}>
      <span><strong>{entry.label}</strong><span>{entry.location}</span><code>{entry.target.property || entry.target.componentId || entry.target.id}</code>{showText && <span className="resource-change-text-preview">{entry.text.slice(0, 300)}{entry.text.length > 300 ? "…" : ""}</span>}</span>
      <Icon name="arrow" size={15} />
    </button></li>)}
  </ul>;
}

/** A preview is always rechecked by the caller before it enters project history. */
export default function ResourceChangeDialog({ plan, onNameChange, onApply, onClose, onOpenReference, loading = false, loadError, onRetry, retryLabel = "Retry reference check" }: ResourceChangeDialogProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [acknowledgedSignature, setAcknowledgedSignature] = useState<string | null>(null);
  const rename = plan.request.action === "rename";
  const requestIdentity = JSON.stringify(plan.request);
  // Binding the acknowledgement to the whole preview prevents a changed plan
  // from inheriting approval for the previous plan, even before effects run.
  const acknowledgementKey = `${plan.signature}\n${requestIdentity}`;
  const acknowledged = acknowledgedSignature === acknowledgementKey;
  const canApply = !loading && !loadError && !plan.errors.length && Boolean(plan.nextProject)
    && (rename || !plan.blockingReferences.length) && (!plan.textMatches.length || acknowledged);

  useEffect(() => {
    const element = dialog.current, previousFocus = document.activeElement;
    element?.showModal();
    if (nameInput.current) { nameInput.current.focus(); nameInput.current.select(); }
    else cancelButton.current?.focus();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  useEffect(() => { setAcknowledgedSignature(null); }, [acknowledgementKey]);

  function openReference(target: SearchTarget) {
    onClose();
    onOpenReference(target);
  }

  return createPortal(<dialog ref={dialog} className="resource-change-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") event.preventDefault();
    }}>
    <header className="resource-change-heading">
      <div><h2 id={`${id}-title`}>{rename ? "Rename" : "Delete"} {plan.label}</h2><p id={`${id}-description`}>Review the affected resources before changing this project draft.</p></div>
      <button type="button" className="icon-button" aria-label="Close resource change preview" onClick={onClose}><Icon name="close" size={18} /></button>
    </header>
    <div className="resource-change-body">
      {plan.request.action === "rename" && <section className="resource-change-name" aria-label="Rename resource">
        <dl><dt>Current name</dt><dd>{plan.beforeName}</dd><dt>Resource ID</dt><dd><code>{plan.request.target.id}</code></dd></dl>
        <label htmlFor={`${id}-name`}>New name</label><input ref={nameInput} id={`${id}-name`} value={plan.request.name} onChange={event => onNameChange(event.target.value)} autoComplete="off" />
        <p>The resource ID stays unchanged. Configured references continue to use that ID.</p>
      </section>}
      {!rename && <p className="resource-change-summary">{plan.componentIds.length > 0
        ? `${plan.componentIds.length} component${plan.componentIds.length === 1 ? "" : "s"} will be removed${plan.request.target.kind === "components" ? "." : " with this resource."}`
        : "This resource will be removed from the project draft."}</p>}
      <div className="resource-change-load" aria-live="polite">
        {loading && <p role="status">Checking script and query references…</p>}
        {loadError && <div className="resource-change-error" role="alert"><p>References could not be checked: {loadError}</p>{onRetry && <button type="button" className="button small" disabled={loading} onClick={onRetry}>{retryLabel}</button>}</div>}
      </div>
      {plan.errors.length > 0 && <div className="resource-change-error" role="alert"><strong>This change cannot be applied yet.</strong><ul>{plan.errors.map((error, index) => <li key={index}>{error}</li>)}</ul></div>}
      {plan.notices.length > 0 && <ul className="resource-change-notices">{plan.notices.map((notice, index) => <li key={index}>{notice}</li>)}</ul>}
      {rename && <section className="resource-change-section" aria-labelledby={`${id}-retained`}>
        <h3 id={`${id}-retained`}>Retained structured references <span>{plan.retainedReferences.length}</span></h3>
        {plan.retainedReferences.length > 0 ? <><p>These resources continue to use the unchanged resource ID.</p><ReferenceList entries={plan.retainedReferences} label="Structured references retained after rename" onOpen={openReference} /></>
          : <p>No structured references to this resource were found in this project.</p>}
      </section>}
      {!rename && <section className="resource-change-section" aria-labelledby={`${id}-references`}>
        <h3 id={`${id}-references`}>Structured references <span>{plan.blockingReferences.length}</span></h3>
        {plan.blockingReferences.length > 0 ? <><p className="resource-change-error">These remaining resources use this selection. Update or remove their references before deleting it.</p><ReferenceList entries={plan.blockingReferences} label="References blocking deletion" onOpen={openReference} /></>
          : <p>No remaining structured references were found in this project.</p>}
      </section>}
      <section className="resource-change-section" aria-labelledby={`${id}-text`}>
        <h3 id={`${id}-text`}>Code and SQL text matches <span>{plan.textMatches.length}</span></h3>
        <p>Literal matches need manual review. Computed references, external callers and dynamically constructed names cannot be fully detected. Code and SQL will not be rewritten.</p>
        {plan.textMatches.length > 0 ? <><ReferenceList entries={plan.textMatches} label="Code and SQL text matches" onOpen={openReference} showText />
          <label className="resource-change-acknowledgement"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledgedSignature(event.target.checked ? acknowledgementKey : null)} /><span>I have reviewed these text matches and will handle any affected code or SQL.</span></label></>
          : !loading && !loadError && <p className="resource-change-no-matches">No literal matches were found in the checked code and SQL.</p>}
      </section>
    </div>
    <footer className="resource-change-footer"><span>The change can be undone in the designer. Save and publish to update the operator application.</span>
      <button ref={cancelButton} type="button" className="button" onClick={onClose}>Cancel</button>
      <button type="button" className={`button ${rename ? "primary" : "danger"}`} disabled={!canApply} onClick={() => { if (canApply) onApply(); }}>{rename ? "Rename" : "Delete"}</button>
    </footer>
  </dialog>, document.body);
}
