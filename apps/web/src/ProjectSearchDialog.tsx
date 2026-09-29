import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import { findProjectReferences, searchProject, type SearchEntry, type SearchReference, type SearchTarget } from "./projectSearch";
import "./projectSearch.css";

const categories: { value: "all" | SearchEntry["category"]; label: string }[] = [
  { value: "all", label: "All resources" },
  { value: "screen", label: "Screens" },
  { value: "template", label: "Templates" },
  { value: "component", label: "Components" },
  { value: "property", label: "Properties" },
  { value: "binding", label: "Bindings" },
  { value: "query", label: "Named queries" },
  { value: "script", label: "Scripts" },
];
const resultLimit = 200;

function resourceReference(entry: SearchEntry): SearchReference | undefined {
  const target = entry.target;
  if (entry.category === "component" && target.componentId && (target.kind === "screen" || target.kind === "template"))
    return { kind: "component", id: target.componentId, ownerKind: target.kind, ownerId: target.id };
  if ((entry.category === "screen" || entry.category === "template" || entry.category === "query") && !target.componentId && !target.property
    && (target.kind === "screen" || target.kind === "template" || target.kind === "query"))
    return { kind: target.kind, id: target.id };
  return undefined;
}

function snippet(text: string, term: string, limit = 180) {
  const compact = text.replace(/\s+/g, " ").trim();
  const firstWord = term.trim().split(/\s+/)[0] || "";
  const match = firstWord ? compact.toLocaleLowerCase().indexOf(firstWord.toLocaleLowerCase()) : 0;
  const start = Math.max(0, match - 45);
  return `${start ? "…" : ""}${compact.slice(start, start + limit)}${compact.length > start + limit ? "…" : ""}`;
}

function Highlight({ text, term }: { text: string; term: string }) {
  const word = term.trim().split(/\s+/)[0] || "";
  const offset = word ? text.toLocaleLowerCase().indexOf(word.toLocaleLowerCase()) : -1;
  return offset < 0 ? <>{text}</> : <>{text.slice(0, offset)}<mark>{text.slice(offset, offset + word.length)}</mark>{text.slice(offset + word.length)}</>;
}

/** Search reads editor drafts and navigates to their owners; it never executes a resource. */
export default function ProjectSearch({ entries, onOpen, onClose, onReplace, scriptsLoading = false, scriptsError }: {
  entries: SearchEntry[];
  onOpen: (target: SearchTarget) => void;
  onClose: () => void;
  onReplace?: (find: string) => void;
  scriptsLoading?: boolean;
  scriptsError?: string;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [term, setTerm] = useState("");
  const [scope, setScope] = useState<"all" | SearchEntry["category"]>("all");
  const [missingOnly, setMissingOnly] = useState(false);
  const [selection, setSelection] = useState<string>();
  const [referencesTo, setReferencesTo] = useState<{ label: string; reference: SearchReference }>();

  useEffect(() => {
    const element = dialog.current, previousFocus = document.activeElement;
    element?.showModal();
    input.current?.focus();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const candidates = useMemo(() => referencesTo ? findProjectReferences(entries, referencesTo.reference) : entries, [entries, referencesTo]);
  const results = useMemo(() => searchProject(candidates, term, scope).filter(entry => !missingOnly || entry.missing), [candidates, term, scope, missingOnly]);
  const visibleResults = results.slice(0, resultLimit);
  const selected = visibleResults.find(entry => entry.id === selection) || visibleResults[0];
  const selectedReference = selected && resourceReference(selected);
  const referenceCount = selectedReference ? findProjectReferences(entries, selectedReference).length : 0;

  useEffect(() => { if (list.current) list.current.scrollTop = 0; }, [term, scope, missingOnly, referencesTo]);
  useEffect(() => {
    if (selected && list.current?.contains(document.activeElement))
      document.getElementById(`${id}-result-${visibleResults.indexOf(selected)}`)?.scrollIntoView({ block: "nearest" });
  }, [selected?.id, id]);

  const openSelected = () => { if (selected) onOpen(selected.target); };
  const showReferences = () => {
    if (!selected || !selectedReference) return;
    setReferencesTo({ label: selected.label, reference: selectedReference });
    setTerm(""); setScope("all"); setMissingOnly(false); setSelection(undefined);
    input.current?.focus();
  };
  const clearReferences = () => { setReferencesTo(undefined); setSelection(undefined); input.current?.focus(); };
  const selectRelative = (key: string) => {
    if (!visibleResults.length) return;
    const current = selected ? visibleResults.indexOf(selected) : 0;
    const next = key === "Home" ? 0 : key === "End" ? visibleResults.length - 1
      : key === "ArrowDown" ? Math.min(current + 1, visibleResults.length - 1) : Math.max(current - 1, 0);
    setSelection(visibleResults[next].id);
  };

  return createPortal(<dialog ref={dialog} className="project-search-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header className="project-search-heading">
      <div><h2 id={`${id}-title`}><Icon name="search" size={20} />Project search</h2><p id={`${id}-description`}>Find resources, property values, bindings and code in this project.</p></div>
      <button type="button" className="icon-button" aria-label="Close project search" onClick={onClose}><Icon name="close" size={18} /></button>
    </header>
    <div className="project-search-controls">
      {referencesTo && <div className="project-search-reference-path"><button type="button" onClick={clearReferences}>All resources</button><Icon name="arrow" size={13} /><span>Structured references to <strong>{referencesTo.label}</strong></span></div>}
      <div className="project-search-fields">
        <label className="project-search-term" htmlFor={`${id}-term`}><span>Search project</span><input ref={input} id={`${id}-term`} type="search" value={term} placeholder={referencesTo ? "Filter references…" : "Name, property, expression or code…"}
          onChange={event => { setTerm(event.target.value); setSelection(undefined); }} onKeyDown={event => {
            if (event.key === "ArrowDown" && selected) { event.preventDefault(); list.current?.focus(); }
            if (event.key === "Enter") { event.preventDefault(); openSelected(); }
          }} /></label>
        <label htmlFor={`${id}-scope`}><span>Look in</span><select id={`${id}-scope`} value={scope} onChange={event => { setScope(event.target.value as typeof scope); setSelection(undefined); }}>{categories.map(category => <option key={category.value} value={category.value}>{category.label}</option>)}</select></label>
      </div>
      <div className="project-search-summary"><span role="status">{results.length.toLocaleString()} {referencesTo ? "references" : "results"}{results.length > resultLimit && ` · showing first ${resultLimit}; narrow your search`}</span><label><input type="checkbox" checked={missingOnly} onChange={event => { setMissingOnly(event.target.checked); setSelection(undefined); }} />Missing references only</label></div>
      {scriptsLoading && <p className="project-search-status" role="status">Loading script resources… Other results are ready.</p>}
      {scriptsError && <p className="project-search-error" role="alert">Script resources could not be loaded: {scriptsError}</p>}
    </div>
    <div className="project-search-body">
      <div ref={list} className="project-search-results" role="listbox" aria-label={referencesTo ? "Structured reference results" : "Project search results"} tabIndex={0}
        aria-activedescendant={selected ? `${id}-result-${visibleResults.indexOf(selected)}` : undefined}
        onKeyDown={event => {
          if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) { event.preventDefault(); selectRelative(event.key); }
          if (event.key === "Enter") { event.preventDefault(); openSelected(); }
        }}>
        {visibleResults.map((entry, index) => <div id={`${id}-result-${index}`} key={entry.id} role="option" aria-selected={entry === selected} className={`project-search-result${entry === selected ? " selected" : ""}`}
          onClick={() => { setSelection(entry.id); list.current?.focus(); }} onDoubleClick={() => onOpen(entry.target)}>
          <div className="project-search-result-heading"><strong><Highlight text={entry.label} term={term} /></strong><span>{entry.category}</span></div>
          <div className="project-search-location">{entry.location}</div>
          <div className="project-search-snippet"><Highlight text={snippet(entry.text, term)} term={term} /></div>
          {(entry.missing || entry.textOnly) && <div className="project-search-badges">{entry.missing && <span className="missing">Missing reference</span>}{entry.textOnly && <span>Text match</span>}</div>}
        </div>)}
        {!results.length && <div className="project-search-empty"><Icon name="search" size={25} /><strong>{referencesTo ? "No matching structured references" : "No matching resources"}</strong><p>{referencesTo ? "Change the filters or return to all resources. References inside code are not inferred." : "Try a resource name, component ID or property value, or broaden the filters."}</p></div>}
      </div>
      <aside className="project-search-detail" aria-label="Selected result">
        {selected ? <><span className="project-search-detail-category">{selected.category}</span><h3>{selected.label}</h3><p>{selected.location}</p>
          <dl><dt>Resource</dt><dd><code>{selected.target.id}</code></dd>{selected.target.componentId && <><dt>Component</dt><dd><code>{selected.target.componentId}</code></dd></>}{selected.target.property && <><dt>Property</dt><dd><code>{selected.target.property}</code></dd></>}</dl>
          <pre>{snippet(selected.text, term, 600)}</pre>
          {selected.missing && <p className="project-search-error">The referenced {selected.reference?.kind || "resource"} is missing. Open this result to inspect its owner.</p>}
          {selected.reference && <p>References {selected.reference.kind}: <code>{selected.reference.id}</code></p>}
          {selectedReference && <button type="button" className="button project-search-used-by" onClick={showReferences}>Structured references <span>{referenceCount}</span></button>}
          {selected.textOnly && <p className="project-search-text-warning">Text matches are not verified references.</p>}
        </> : <p>Select a result to inspect it.</p>}
        <p className="project-search-reference-note">Structured references cover configured screen, template, query and component links. Code and SQL are searchable text; tag and asset availability is not checked here.</p>
      </aside>
    </div>
    <footer className="project-search-footer"><span>↑ ↓ select · Enter opens · Esc closes</span>{onReplace && <button type="button" className="button" onClick={() => onReplace(term)} title="Preview literal replacements in display text or tag paths (Ctrl+Shift+H / Cmd+Shift+H)">Replace…</button>}{selectedReference && <button type="button" className="button project-search-mobile-references" onClick={showReferences}>References ({referenceCount})</button>}<button type="button" className="button" onClick={onClose}>Close</button><button type="button" className="button primary" disabled={!selected} onClick={openSelected}>Open result<Icon name="arrow" size={15} /></button></footer>
  </dialog>, document.body);
}
