import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { TagDefinition } from "./types";
import "./gatewayProcessData.css";

export interface AlarmDefinition { id: string; name: string; tagPath: string; enabled: boolean; mode: "high" | "low" | "equal"; setpoint: number; deadband: number; priority: number }
export interface HistoryDefinition { tagPath: string; enabled: boolean; deadband: number; maxIntervalMs: number; retentionDays: number }
export interface ProcessDataConfiguration { revision: number; alarmRetentionDays: number; alarms: AlarmDefinition[]; history: HistoryDefinition[]; configurationError?: string | null; storageError?: string | null; replaceInvalidConfiguration?: boolean }
export type ProcessDataSection = "alarms" | "history";
interface ConfigurationIssue { message: string; section?: ProcessDataSection; index?: number }
const numeric = (value: string) => value.trim() ? Number(value) : Number.NaN;
const integer = (value: number, minimum: number, maximum: number) => Number.isInteger(value) && value >= minimum && value <= maximum;
const pathError = (value: string) => !/^\[[^\]\s]+\].+$/.test(value) || value.length > 1024 || /[{}\x00-\x1f]/.test(value);
const pageSize = 50;
const priorityNames = ["", "Low", "Medium", "High", "Critical"];
const tagSourceName = (definition: TagDefinition) => definition.kind === "memory" ? "Memory" : definition.kind === "expression" ? "Expression" : "OPC UA";

function configurationIssue(value: ProcessDataConfiguration): ConfigurationIssue | null {
  if (!integer(value.revision, 1, Number.MAX_SAFE_INTEGER) || !integer(value.alarmRetentionDays, 1, 3650)) return { message: "Alarm journal retention must be 1–3650 whole days.", section: "alarms" };
  if (!Array.isArray(value.alarms) || !Array.isArray(value.history) || value.alarms.length > 2000 || value.history.length > 5000) return { message: "Use at most 2,000 alarms and 5,000 history tags." };
  const ids = new Set<string>(), paths = new Set<string>();
  for (const [index, alarm] of value.alarms.entries()) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(alarm.id) || ids.has(alarm.id)) return { message: "Each alarm needs a unique ID of 1–64 letters, numbers, dashes or underscores.", section: "alarms", index };
    ids.add(alarm.id);
    if (!alarm.name?.trim() || alarm.name.length > 200 || pathError(alarm.tagPath)) return { message: `Alarm ${alarm.id}: enter a name and fully resolved tag path, such as [default]Workshop/Temperature.`, section: "alarms", index };
    if (!["high", "low", "equal"].includes(alarm.mode) || !Number.isFinite(alarm.setpoint) || !Number.isFinite(alarm.deadband) || alarm.deadband < 0 || !integer(alarm.priority, 1, 4)) return { message: `Alarm ${alarm.id}: use a finite setpoint, nonnegative deadband and priority 1–4.`, section: "alarms", index };
  }
  for (const [index, item] of value.history.entries()) {
    if (pathError(item.tagPath) || paths.has(item.tagPath)) return { message: "Historical tags need unique, fully resolved tag paths.", section: "history", index };
    paths.add(item.tagPath);
    if (!Number.isFinite(item.deadband) || item.deadband < 0 || !integer(item.maxIntervalMs, 250, 86400000) || !integer(item.retentionDays, 1, 3650)) return { message: `History ${item.tagPath}: use a nonnegative deadband, 250–86400000 ms interval and 1–3650 retention days.`, section: "history", index };
  }
  return null;
}
export function processDataError(value: ProcessDataConfiguration): string | null { return configurationIssue(value)?.message ?? null; }

function NumberField({ label, value, onChange, min, max, step = "any" }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: string }) {
  return <label><span>{label}</span><input type="number" value={Number.isFinite(value) ? value : ""} min={min} max={max} step={step} onChange={event => onChange(numeric(event.target.value))} /></label>;
}

function TagPathField({ value, onChange, disabled, fieldId }: { value: string; onChange: (value: string) => void; disabled: boolean; fieldId: string }) {
  const [open, setOpen] = useState(false), [definitions, setDefinitions] = useState<TagDefinition[]>([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [search, setSearch] = useState(""), [page, setPage] = useState(0);
  const generation = useRef(0), opened = useRef(false), input = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => { opened.current = false; generation.current++; }, []);
  useEffect(() => {
    if (disabled) { opened.current = false; generation.current++; setOpen(false); setLoading(false); }
  }, [disabled]);
  function close() { opened.current = false; generation.current++; setOpen(false); setLoading(false); input.current?.focus(); }
  async function browse() {
    if (disabled) return;
    const request = ++generation.current;
    opened.current = true; setOpen(true); setLoading(true); setDefinitions([]); setError(""); setSearch(""); setPage(0);
    try {
      const configured = await api<TagDefinition[]>("/tag-definitions");
      if (!Array.isArray(configured)) throw new Error("The gateway returned an invalid tag list.");
      if (generation.current === request && opened.current) setDefinitions([...configured].sort((left, right) => left.path.localeCompare(right.path)));
    } catch (failure) {
      if (generation.current === request && opened.current) setError(failure instanceof Error ? failure.message : "Unable to browse configured gateway tags.");
    } finally { if (generation.current === request && opened.current) setLoading(false); }
  }
  const query = search.trim().toLowerCase();
  const filtered = definitions.filter(definition => !query || `${definition.path} ${definition.kind || "opcua"} ${tagSourceName(definition)} ${definition.dataType}`.toLowerCase().includes(query));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize)), currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const renderedGeneration = generation.current;
  function choose(path: string) {
    if (disabled || loading || !opened.current || generation.current !== renderedGeneration) return;
    onChange(path); close();
  }
  return <div className="process-data-tag-field process-data-wide">
    <label htmlFor={fieldId}><span>Tag path</span></label>
    <div className="process-data-tag-control"><input ref={input} id={fieldId} disabled={disabled} value={value} maxLength={1024} onChange={event => onChange(event.target.value)} placeholder="[default]Workshop/Temperature" /><button type="button" className="button" disabled={disabled || loading} aria-expanded={open} aria-controls={`${fieldId}-browser`} onClick={() => void browse()}>Browse</button></div>
    <small className="process-data-tag-hint">Enter a fully resolved path or browse configured gateway tags.</small>
    {open && <div className="process-data-tag-picker" role="region" aria-label="Configured gateway tags" id={`${fieldId}-browser`} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); close(); } }}>
      <div className="process-data-tag-picker-header"><h4>Configured tags</h4><button type="button" className="button" disabled={disabled} onClick={close}>Close tag browser</button></div>
      <label className="process-data-tag-search"><span>Search configured tags</span><input type="search" disabled={disabled || loading} value={search} placeholder="Filter by path, source or data type" onChange={event => { setSearch(event.target.value); setPage(0); }} /></label>
      {loading ? <p className="process-data-tag-status" role="status">Loading configured tags…</p> : error ? <div className="process-data-tag-error" role="alert"><p>{error}</p><button type="button" className="button" disabled={disabled} onClick={() => void browse()}>Retry tag browse</button></div> : !visible.length ? <p className="process-data-tag-status" role="status">{definitions.length ? "No configured tags match this search." : "No tags are configured on this gateway. You can still enter a tag path manually."}</p> : <ul className="process-data-tag-results">{visible.map(definition => <li key={definition.path}><button type="button" className="process-data-tag-result" disabled={disabled} aria-label={`Use tag ${definition.path}`} aria-pressed={value === definition.path} onClick={() => choose(definition.path)}><span className="process-data-tag-path">{definition.path}</span><span className="process-data-tag-type">{tagSourceName(definition)} · {definition.dataType}{definition.enabled === false || definition.effectiveEnabled === false ? " · Disabled" : ""}</span></button></li>)}</ul>}
      {!loading && !error && <div className="process-data-tag-pager"><span>{filtered.length ? `${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, filtered.length)} of ${filtered.length}` : "0 tags"}</span><div><button type="button" className="button" disabled={disabled || currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous tags</button><span>Page {currentPage + 1} of {pageCount}</span><button type="button" className="button" disabled={disabled || currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next tags</button></div></div>}
    </div>}
  </div>;
}
const clampSelection = (index: number | null, length: number) => length ? Math.min(index ?? 0, length - 1) : null;

export default function GatewayProcessData({ section = "alarms", onSectionChange }: { section?: ProcessDataSection; onSectionChange?: (section: ProcessDataSection) => void } = {}) {
  const [saved, setSaved] = useState<ProcessDataConfiguration | null>(null), [draft, setDraft] = useState<ProcessDataConfiguration | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<Record<ProcessDataSection, number | null>>({ alarms: 0, history: 0 });
  const [search, setSearch] = useState<Record<ProcessDataSection, string>>({ alarms: "", history: "" });
  const [pages, setPages] = useState<Record<ProcessDataSection, number>>({ alarms: 0, history: 0 });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const generation = useRef(0), mounted = useRef(false), pending = useRef(false);
  const load = useCallback(async (preserveSelection = false) => {
    if (!mounted.current || pending.current) return;
    pending.current = true;
    const current = ++generation.current; setBusy(true); setError(""); setNotice("");
    try {
      const config = await api<ProcessDataConfiguration>("/gateway/process-data");
      const invalid = processDataError(config); if (invalid) throw new Error(`Saved configuration is invalid: ${invalid}`);
      if (mounted.current && generation.current === current) {
        setSaved(config); setDraft(structuredClone(config));
        setSelected(value => preserveSelection
          ? { alarms: clampSelection(value.alarms, config.alarms.length), history: clampSelection(value.history, config.history.length) }
          : { alarms: config.alarms.length ? 0 : null, history: config.history.length ? 0 : null });
        setEditorEpoch(value => value + 1);
        setPages({ alarms: 0, history: 0 }); setConfirmRemove(false);
      }
    } catch (failure) { if (mounted.current && generation.current === current) setError(failure instanceof Error ? failure.message : "Unable to load process data configuration."); }
    finally { if (mounted.current && generation.current === current) { pending.current = false; setBusy(false); } }
  }, []);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; pending.current = false; generation.current++; }; }, [load]);
  useEffect(() => { setConfirmRemove(false); }, [section, selected[section]]);
  const dirty = draft !== null && JSON.stringify(saved) !== JSON.stringify(draft);
  const alarmsDirty = draft !== null && (JSON.stringify(saved?.alarms) !== JSON.stringify(draft.alarms) || saved?.alarmRetentionDays !== draft.alarmRetentionDays);
  const historyDirty = draft !== null && JSON.stringify(saved?.history) !== JSON.stringify(draft.history);
  const issue = draft ? configurationIssue(draft) : null;
  const invalid = draft ? draft.storageError || (draft.configurationError && !draft.replaceInvalidConfiguration ? "Confirm replacement of the invalid configuration before saving this recovery draft." : issue?.message) : null;
  const currentSelection = draft ? clampSelection(selected[section], draft[section].length) : null;
  const alarm = section === "alarms" && currentSelection !== null ? draft?.alarms[currentSelection] : undefined;
  const historical = section === "history" && currentSelection !== null ? draft?.history[currentSelection] : undefined;
  const query = search[section].trim().toLowerCase();
  const indices = draft ? draft[section].map((_, index) => index).filter(index => {
    const item = draft[section][index];
    return !query || ("name" in item ? `${item.name} ${item.id} ${item.tagPath}` : item.tagPath).toLowerCase().includes(query);
  }) : [];
  const pageCount = Math.max(1, Math.ceil(indices.length / pageSize)), page = Math.min(pages[section], pageCount - 1);
  const visibleIndices = indices.slice(page * pageSize, (page + 1) * pageSize);
  const updateAlarm = (index: number, change: Partial<AlarmDefinition>) => setDraft(value => value && ({ ...value, alarms: value.alarms.map((item, position) => position === index ? { ...item, ...change } : item) }));
  const updateHistory = (index: number, change: Partial<HistoryDefinition>) => setDraft(value => value && ({ ...value, history: value.history.map((item, position) => position === index ? { ...item, ...change } : item) }));
  function selectRule(target: ProcessDataSection, index: number) {
    setSelected(value => ({ ...value, [target]: index })); setConfirmRemove(false); setEditorEpoch(value => value + 1);
  }
  function showIssue() {
    if (!issue?.section || busy) return;
    const target = issue.section;
    setSearch(value => ({ ...value, [target]: "" }));
    if (issue.index !== undefined) { selectRule(target, issue.index); setPages(value => ({ ...value, [target]: Math.floor(issue.index! / pageSize) })); }
    onSectionChange?.(target);
  }
  function addRule() {
    if (!draft || busy) return;
    const index = draft[section].length;
    if (section === "alarms") {
      if (index >= 2000) return;
      setDraft({ ...draft, alarms: [...draft.alarms, { id: `alarm-${crypto.randomUUID().slice(0, 8)}`, name: "New alarm", tagPath: "", enabled: false, mode: "high", setpoint: 100, deadband: 0, priority: 1 }] });
    } else {
      if (index >= 5000) return;
      setDraft({ ...draft, history: [...draft.history, { tagPath: "", enabled: false, deadband: 0, maxIntervalMs: 60000, retentionDays: 7 }] });
    }
    selectRule(section, index); setSearch(value => ({ ...value, [section]: "" })); setPages(value => ({ ...value, [section]: Math.floor(index / pageSize) }));
    setError(""); setNotice("");
  }
  function removeRule() {
    if (!draft || busy || currentSelection === null) return;
    const index = currentSelection;
    if (section === "alarms") setDraft({ ...draft, alarms: draft.alarms.filter((_, position) => position !== index) });
    else setDraft({ ...draft, history: draft.history.filter((_, position) => position !== index) });
    setSelected(value => ({ ...value, [section]: clampSelection(index, draft[section].length - 1) })); setConfirmRemove(false); setEditorEpoch(value => value + 1);
    setNotice("Rule removed from this draft. Save configuration to apply, or Cancel changes to restore it.");
  }
  function cancel() {
    if (busy || pending.current) return;
    void load(true);
  }
  async function save() {
    if (!mounted.current || !draft || pending.current || busy || invalid || !dirty) return; pending.current = true; const current = ++generation.current; setBusy(true); setError(""); setNotice("");
    try {
      const config = await api<ProcessDataConfiguration>("/gateway/process-data", "PUT", draft);
      if (mounted.current && generation.current === current) { setSaved(config); setDraft(structuredClone(config)); setNotice("Alarms and history configuration saved. Enabled rules apply to shared gateway tags."); }
    } catch (failure) { if (mounted.current && generation.current === current) setError(failure instanceof Error ? failure.message : "Unable to save. Cancel changes to load the latest configuration."); }
    finally { if (mounted.current && generation.current === current) { pending.current = false; setBusy(false); } }
  }
  const title = section === "alarms" ? "Alarms" : "History";
  const changedSections = [alarmsDirty && "Alarms", historyDirty && "History"].filter(Boolean).join(" and ");
  // Pure render helpers share this hook owner, preserving child keys and edit lifetimes.
  function renderProcessDataWorkspace(draft: ProcessDataConfiguration) {
    return (<div className="process-data-workspace">
      <section className="panel process-data-list-panel" aria-labelledby="process-data-list-title">
        <div className="process-data-panel-heading"><div><h3 id="process-data-list-title">{section === "alarms" ? "Alarm conditions" : "Historical tags"}</h3><span>{draft[section].length} configured</span></div><button type="button" className="button primary" disabled={busy || draft[section].length >= (section === "alarms" ? 2000 : 5000)} onClick={addRule}>{section === "alarms" ? "Add alarm" : "New historical tag"}</button></div>
        <label className="process-data-search"><span>{section === "alarms" ? "Search alarms" : "Search historical tags"}</span><input type="search" disabled={busy} value={search[section]} placeholder={section === "alarms" ? "Filter by name, ID or tag path" : "Filter by tag path"} onChange={event => { setSearch(value => ({ ...value, [section]: event.target.value })); setPages(value => ({ ...value, [section]: 0 })); }} /></label>
        {visibleIndices.length ? <ul className="process-data-list">{visibleIndices.map(index => {
          const item = draft[section][index], name = "name" in item ? item.name || item.id || `Alarm ${index + 1}` : item.tagPath || `New historical tag ${index + 1}`;
          return <li key={index}><button type="button" className={`process-data-row${currentSelection === index ? " is-selected" : ""}`} disabled={busy} aria-label={section === "alarms" ? `Edit alarm ${name}` : `Edit historical tag ${name}`} aria-pressed={currentSelection === index} onClick={() => selectRule(section, index)}>
            <span className="process-data-row-title">{name}</span>{section === "alarms" && <span className="process-data-row-path">{item.tagPath || "Tag path required"}</span>}
            <span className="process-data-row-meta"><span className={`process-data-badge ${item.enabled ? "enabled" : "disabled"}`}>{item.enabled ? "Enabled" : "Disabled"}</span><span>{"mode" in item ? `${item.mode === "high" ? "High" : item.mode === "low" ? "Low" : "Equal"} · ${priorityNames[item.priority] || "Priority required"}` : `${Number.isFinite(item.maxIntervalMs) ? item.maxIntervalMs.toLocaleString() : "—"} ms · ${Number.isFinite(item.retentionDays) ? item.retentionDays : "—"} days`}</span>{issue?.section === section && issue.index === index && <span className="process-data-badge invalid">Needs attention</span>}</span>
          </button></li>;
        })}</ul> : <div className="process-data-empty">{query ? "No rules match this search. Clear the search to see all rules." : section === "alarms" ? "No alarm conditions yet. Add an alarm to configure its tag and trigger." : "No historical tags yet. Add a tag to configure sampling and retention."}</div>}
        <div className="process-data-pagination"><span>{indices.length ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, indices.length)} of ${indices.length}` : "0 results"}</span><div><button type="button" className="button" disabled={busy || page === 0} onClick={() => setPages(value => ({ ...value, [section]: page - 1 }))}>Previous</button><span>Page {page + 1} of {pageCount}</span><button type="button" className="button" disabled={busy || page >= pageCount - 1} onClick={() => setPages(value => ({ ...value, [section]: page + 1 }))}>Next</button></div></div>
      </section>
      <section className="panel process-data-editor-panel" aria-labelledby="process-data-editor-title">
        <div className="process-data-panel-heading"><div><h3 id="process-data-editor-title">{alarm ? alarm.name || "Alarm properties" : historical ? historical.tagPath.split("/").pop()?.replace(/^\[[^\]]+\]/, "") || "New historical tag" : section === "alarms" ? "Alarm properties" : "Historical tag properties"}</h3><span>{alarm || historical ? "Changes stay in this draft until you save." : "Select a rule from the list."}</span></div>{(alarm || historical) && <button type="button" className="button danger" disabled={busy || confirmRemove} onClick={() => setConfirmRemove(true)}>{section === "alarms" ? "Remove alarm" : "Remove historical tag"}</button>}</div>
        {confirmRemove && <div className="process-data-callout" role="alert"><strong>Remove this {section === "alarms" ? "alarm" : "historical tag"}?</strong><p>This removes only the selected rule from your draft. Previously recorded data remains under its retention policy.</p><div className="process-data-actions"><button type="button" className="button danger" disabled={busy} onClick={removeRule}>{section === "alarms" ? "Confirm remove alarm" : "Confirm remove history"}</button><button type="button" className="button" disabled={busy} onClick={() => setConfirmRemove(false)}>{section === "alarms" ? "Keep alarm" : "Keep history"}</button></div></div>}
        {alarm && currentSelection !== null ? <fieldset className="process-data-form-group" disabled={busy} key={`alarms-${currentSelection}`}><legend>Alarm properties</legend><div className="process-data-grid">
          <label><span>ID</span><input value={alarm.id} maxLength={64} onChange={event => updateAlarm(currentSelection, { id: event.target.value })} /><small>Unique ID, up to 64 letters, numbers, dashes or underscores.</small></label>
          <label><span>Name</span><input value={alarm.name} maxLength={200} onChange={event => updateAlarm(currentSelection, { name: event.target.value })} /></label>
          <TagPathField key={`alarms-${currentSelection}-${editorEpoch}`} fieldId={`process-data-alarm-${currentSelection}-tag-path`} value={alarm.tagPath} disabled={busy} onChange={tagPath => updateAlarm(currentSelection, { tagPath })} />
          <label><span>Condition</span><select value={alarm.mode} onChange={event => updateAlarm(currentSelection, { mode: event.target.value as AlarmDefinition["mode"] })}><option value="high">High</option><option value="low">Low</option><option value="equal">Equal</option></select></label>
          <NumberField label="Setpoint" value={alarm.setpoint} onChange={setpoint => updateAlarm(currentSelection, { setpoint })} />
          <NumberField label="Deadband" value={alarm.deadband} min={0} onChange={deadband => updateAlarm(currentSelection, { deadband })} />
          <label><span>Priority</span><select value={alarm.priority} onChange={event => updateAlarm(currentSelection, { priority: Number(event.target.value) })}>{priorityNames.slice(1).map((name, index) => <option key={name} value={index + 1}>{index + 1} · {name}</option>)}</select></label>
          <label className="process-data-check process-data-wide"><input type="checkbox" checked={alarm.enabled} onChange={event => updateAlarm(currentSelection, { enabled: event.target.checked })} /><span>Alarm enabled</span></label>
        </div><details className="process-data-callout"><summary>How alarm conditions work</summary><p>High activates at or above the setpoint; Low activates at or below it. Deadband avoids repeated transitions near the boundary. Equal activates at the exact setpoint. Bad-quality values do not clear an active alarm.</p><p>Operator alarm tables respect each project's tag scope. Acknowledgement requires Operate permission.</p></details></fieldset> : historical && currentSelection !== null ? <fieldset className="process-data-form-group" disabled={busy} key={`history-${currentSelection}`}><legend>Historical tag properties</legend><div className="process-data-grid">
          <TagPathField key={`history-${currentSelection}-${editorEpoch}`} fieldId={`process-data-history-${currentSelection}-tag-path`} value={historical.tagPath} disabled={busy} onChange={tagPath => updateHistory(currentSelection, { tagPath })} />
          <NumberField label="Deadband" value={historical.deadband} min={0} onChange={deadband => updateHistory(currentSelection, { deadband })} />
          <NumberField label="Maximum interval (ms)" value={historical.maxIntervalMs} min={250} max={86400000} step="1" onChange={maxIntervalMs => updateHistory(currentSelection, { maxIntervalMs })} />
          <NumberField label="Retention (days)" value={historical.retentionDays} min={1} max={3650} step="1" onChange={retentionDays => updateHistory(currentSelection, { retentionDays })} />
          <label className="process-data-check"><input type="checkbox" checked={historical.enabled} onChange={event => updateHistory(currentSelection, { enabled: event.target.checked })} /><span>History recording enabled</span></label>
        </div><details className="process-data-callout"><summary>How history recording works</summary><p>Record value changes beyond the absolute deadband, quality changes and a periodic sample at the maximum interval. Retention is applied locally. This is bounded raw history, without aggregate interpolation or redundancy.</p><p>Operator trends respect each project's tag scope.</p></details></fieldset> : <div className="process-data-empty">{section === "alarms" ? "Select an alarm or add a new one to edit its properties." : "Select a historical tag or add a new one to edit its properties."}</div>}
      </section>
    </div>);
  }

  return <section className="gateway-process-data management-page" aria-labelledby="process-data-title">
    <div className="process-data-heading page-heading">
      <div><h2 id="process-data-title">{title}</h2>
        <p className="process-data-description">{section === "alarms" ? "Define alarm conditions for gateway tags and choose how long to retain the alarm journal." : "Choose which gateway tags to record, their sampling intervals and local retention."}</p>
      </div>
      <div className="process-data-actions"><button type="button" className="button" disabled={busy || (!dirty && !error)} onClick={cancel}>Cancel changes</button><button type="button" className="button primary" disabled={busy || !dirty || Boolean(invalid)} onClick={() => void save()}>{busy ? "Working…" : "Save configuration"}</button></div>
    </div>
    {draft && <div className="process-data-status"><span>Revision {draft.revision}</span><span role="status">{dirty ? `Unsaved changes${changedSections ? ` in ${changedSections}` : ""}. Save configuration applies both tabs.` : "All changes saved"}</span></div>}
    {error && <div className="gateway-error process-data-load-error" role="alert"><p>{error}</p>{dirty ? <p>Your draft is retained. Cancel changes discards it and loads the latest configuration.</p> : <button type="button" className="button" disabled={busy} onClick={() => void load()}>Retry configuration</button>}</div>}{notice && <p className="process-data-notice" role="status">{notice}</p>}
    {dirty && invalid && !draft?.storageError && <div className="process-data-validation gateway-error" role="alert"><div><strong>{issue?.section && invalid === issue.message ? `${issue.section === "alarms" ? "Alarm" : "History"} configuration needs attention` : "Configuration needs attention"}</strong><p>{invalid}</p></div>{issue?.section && invalid === issue.message && (issue.section === section || onSectionChange) && <button type="button" className="button" disabled={busy} onClick={showIssue}>{issue.index === undefined ? "Show alarm settings" : "Show invalid rule"}</button>}</div>}
    {!draft ? <div className="panel process-data-empty" role="status">{busy ? "Loading configuration…" : "Configuration unavailable."}</div> : <>
      {draft.storageError && <p className="gateway-error" role="alert">{draft.storageError}</p>}
      {draft.configurationError && <div className="gateway-error process-data-callout" role="alert"><strong>Recover the configuration</strong><p>{draft.configurationError}</p><p>The fields below are a recovery draft. Review both tabs before replacing the invalid saved configuration.</p><label className="process-data-check"><input type="checkbox" disabled={busy} checked={Boolean(draft.replaceInvalidConfiguration)} onChange={event => setDraft({ ...draft, replaceInvalidConfiguration: event.target.checked })} /><span>Archive the invalid configuration and replace it with this reviewed draft</span></label></div>}
      {renderProcessDataWorkspace(draft)}
      {section === "alarms" && <section className="panel process-data-retention" aria-labelledby="process-data-retention-title"><div><h3 id="process-data-retention-title">Alarm journal</h3><p>Keep alarm transitions and acknowledgements for this many days.</p></div><fieldset disabled={busy}><NumberField label="Alarm journal retention (days)" value={draft.alarmRetentionDays} min={1} max={3650} step="1" onChange={alarmRetentionDays => setDraft({ ...draft, alarmRetentionDays })} /></fieldset></section>}
      <p className="process-data-description process-data-footer">Saving applies configuration changes to gateway tags. It does not write equipment values. Removing a rule stops recording it; previously recorded rows remain until retention removes them.</p>
    </>}
  </section>;
}
