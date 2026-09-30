import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import "./gatewayProcessData.css";

export interface AlarmDefinition { id: string; name: string; tagPath: string; enabled: boolean; mode: "high" | "low" | "equal"; setpoint: number; deadband: number; priority: number }
export interface HistoryDefinition { tagPath: string; enabled: boolean; deadband: number; maxIntervalMs: number; retentionDays: number }
export interface ProcessDataConfiguration { revision: number; alarmRetentionDays: number; alarms: AlarmDefinition[]; history: HistoryDefinition[]; configurationError?: string | null; storageError?: string | null; replaceInvalidConfiguration?: boolean }
const numeric = (value: string) => value.trim() ? Number(value) : Number.NaN;
const integer = (value: number, minimum: number, maximum: number) => Number.isInteger(value) && value >= minimum && value <= maximum;
const pathError = (value: string) => !/^\[[^\]\s]+\].+$/.test(value) || value.length > 1024 || /[{}\x00-\x1f]/.test(value);
export function processDataError(value: ProcessDataConfiguration): string | null {
  if (!integer(value.revision, 1, Number.MAX_SAFE_INTEGER) || !integer(value.alarmRetentionDays, 1, 3650)) return "Alarm journal retention must be 1–3650 whole days.";
  if (!Array.isArray(value.alarms) || !Array.isArray(value.history) || value.alarms.length > 2000 || value.history.length > 5000) return "Use at most 2,000 alarms and 5,000 history tags.";
  const ids = new Set<string>(), paths = new Set<string>();
  for (const alarm of value.alarms) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(alarm.id) || ids.has(alarm.id)) return "Each alarm needs a unique ID of 1–64 letters, numbers, dashes or underscores.";
    ids.add(alarm.id);
    if (!alarm.name?.trim() || alarm.name.length > 200 || pathError(alarm.tagPath)) return `Alarm ${alarm.id}: enter a name and fully resolved tag path, such as [default]Workshop/Temperature.`;
    if (!["high", "low", "equal"].includes(alarm.mode) || !Number.isFinite(alarm.setpoint) || !Number.isFinite(alarm.deadband) || alarm.deadband < 0 || !integer(alarm.priority, 1, 4)) return `Alarm ${alarm.id}: use a finite setpoint, nonnegative deadband and priority 1–4.`;
  }
  for (const item of value.history) {
    if (pathError(item.tagPath) || paths.has(item.tagPath)) return "Historical tags need unique, fully resolved tag paths.";
    paths.add(item.tagPath);
    if (!Number.isFinite(item.deadband) || item.deadband < 0 || !integer(item.maxIntervalMs, 250, 86400000) || !integer(item.retentionDays, 1, 3650)) return `History ${item.tagPath}: use a nonnegative deadband, 250–86400000 ms interval and 1–3650 retention days.`;
  }
  return null;
}
function NumberField({ label, value, onChange, min, max, step = "any" }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: string }) {
  return <label>{label}<input type="number" value={Number.isFinite(value) ? value : ""} min={min} max={max} step={step} onChange={event => onChange(numeric(event.target.value))} /></label>;
}

export default function GatewayProcessData() {
  const [saved, setSaved] = useState<ProcessDataConfiguration | null>(null), [draft, setDraft] = useState<ProcessDataConfiguration | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current; setBusy(true); setError(""); setNotice("");
    try {
      const config = await api<ProcessDataConfiguration>("/gateway/process-data");
      const invalid = processDataError(config); if (invalid) throw new Error(`Saved configuration is invalid: ${invalid}`);
      if (generation.current === current) { setSaved(config); setDraft(structuredClone(config)); }
    } catch (failure) { if (generation.current === current) setError(failure instanceof Error ? failure.message : "Unable to load process data configuration."); }
    finally { if (generation.current === current) setBusy(false); }
  }, []);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  const dirty = draft !== null && JSON.stringify(saved) !== JSON.stringify(draft);
  const invalid = draft ? draft.storageError || (draft.configurationError && !draft.replaceInvalidConfiguration ? "Confirm replacement of the invalid configuration before saving this recovery draft." : processDataError(draft)) : null;
  const updateAlarm = (index: number, change: Partial<AlarmDefinition>) => setDraft(value => value && ({ ...value, alarms: value.alarms.map((item, position) => position === index ? { ...item, ...change } : item) }));
  const updateHistory = (index: number, change: Partial<HistoryDefinition>) => setDraft(value => value && ({ ...value, history: value.history.map((item, position) => position === index ? { ...item, ...change } : item) }));
  async function save() {
    if (!draft || invalid || !dirty) return; const current = ++generation.current; setBusy(true); setError(""); setNotice("");
    try {
      const config = await api<ProcessDataConfiguration>("/gateway/process-data", "PUT", draft);
      if (generation.current === current) { setSaved(config); setDraft(structuredClone(config)); setNotice("Process data configuration saved. Enabled rules apply to shared gateway tags."); }
    } catch (failure) { if (generation.current === current) setError(failure instanceof Error ? failure.message : "Unable to save. Cancel and reload if another administrator changed this configuration."); }
    finally { if (generation.current === current) setBusy(false); }
  }
  return <section className="gateway-process-data" aria-labelledby="process-data-title">
    <h2 id="process-data-title">Alarms &amp; history</h2>
    <p>Configure gateway alarm conditions and local tag history. Operator tables and trends respect each project's tag scope. Acknowledgement requires Operate permission.</p>
    <div className="process-data-actions"><button className="button" disabled={busy || dirty} onClick={() => void load()}>Reload</button><button className="button" disabled={busy || !dirty} onClick={() => { setDraft(saved && structuredClone(saved)); setError(""); setNotice("Unsaved edits discarded."); }}>Cancel changes</button><button className="button primary" disabled={busy || !dirty || Boolean(invalid)} onClick={() => void save()}>{busy ? "Working…" : "Save configuration"}</button></div>
    {error && <p className="gateway-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{dirty && invalid && <p className="gateway-error" role="alert">{invalid}</p>}
    {!draft ? <p role="status">{busy ? "Loading configuration…" : "Configuration unavailable. Choose Reload to retry."}</p> : <fieldset disabled={busy}>
      <legend>Shared gateway configuration · Revision {draft.revision}</legend>
      {draft.storageError && <p className="gateway-error" role="alert">{draft.storageError}</p>}
      {draft.configurationError && <div className="gateway-error" role="alert"><p>{draft.configurationError}</p><p>The fields below are a recovery draft, not a valid saved configuration. Review every rule before replacing it.</p><label className="process-data-check"><input type="checkbox" checked={Boolean(draft.replaceInvalidConfiguration)} onChange={event => setDraft({ ...draft, replaceInvalidConfiguration: event.target.checked })} />Archive the invalid configuration and replace it with this reviewed draft</label></div>}
      <NumberField label="Alarm journal retention (days)" value={draft.alarmRetentionDays} min={1} max={3650} step="1" onChange={alarmRetentionDays => setDraft({ ...draft, alarmRetentionDays })} />
      <h3>Alarm conditions</h3><p>High activates at or above the setpoint; low activates at or below it. Deadband avoids repeated transitions near the boundary. Equal activates at the exact setpoint. Bad-quality values do not clear an active alarm.</p>
      {draft.alarms.map((alarm, index) => <fieldset className="process-data-card" key={index}><legend>Alarm {index + 1}</legend><div className="process-data-grid">
        <label>ID<input value={alarm.id} maxLength={64} onChange={event => updateAlarm(index, { id: event.target.value })} /></label>
        <label>Name<input value={alarm.name} maxLength={200} onChange={event => updateAlarm(index, { name: event.target.value })} /></label>
        <label>Tag path<input value={alarm.tagPath} onChange={event => updateAlarm(index, { tagPath: event.target.value })} placeholder="[default]Workshop/Temperature" /></label>
        <label>Condition<select value={alarm.mode} onChange={event => updateAlarm(index, { mode: event.target.value as AlarmDefinition["mode"] })}><option value="high">High</option><option value="low">Low</option><option value="equal">Equal</option></select></label>
        <NumberField label="Setpoint" value={alarm.setpoint} onChange={setpoint => updateAlarm(index, { setpoint })} />
        <NumberField label="Deadband" value={alarm.deadband} min={0} onChange={deadband => updateAlarm(index, { deadband })} />
        <label>Priority<select value={alarm.priority} onChange={event => updateAlarm(index, { priority: Number(event.target.value) })}><option value={1}>1 · Low</option><option value={2}>2 · Medium</option><option value={3}>3 · High</option><option value={4}>4 · Critical</option></select></label>
        <label className="process-data-check"><input type="checkbox" checked={alarm.enabled} onChange={event => updateAlarm(index, { enabled: event.target.checked })} />Enabled</label>
      </div><button className="button" onClick={() => setDraft({ ...draft, alarms: draft.alarms.filter((_, position) => position !== index) })}>Remove alarm {index + 1}</button></fieldset>)}
      <button className="button" disabled={draft.alarms.length >= 2000} onClick={() => setDraft({ ...draft, alarms: [...draft.alarms, { id: `alarm-${crypto.randomUUID().slice(0, 8)}`, name: "New alarm", tagPath: "", enabled: false, mode: "high", setpoint: 100, deadband: 0, priority: 1 }] })}>Add alarm</button>
      <h3>Historical tags</h3><p>Record value changes beyond the absolute deadband, quality changes and a periodic sample at the maximum interval. Retention is applied locally. This is bounded raw history, without aggregate interpolation or redundancy.</p>
      {draft.history.map((item, index) => <fieldset className="process-data-card" key={index}><legend>Historical tag {index + 1}</legend><div className="process-data-grid">
        <label>Tag path<input value={item.tagPath} onChange={event => updateHistory(index, { tagPath: event.target.value })} placeholder="[default]Workshop/Temperature" /></label>
        <NumberField label="Deadband" value={item.deadband} min={0} onChange={deadband => updateHistory(index, { deadband })} />
        <NumberField label="Maximum interval (ms)" value={item.maxIntervalMs} min={250} max={86400000} step="1" onChange={maxIntervalMs => updateHistory(index, { maxIntervalMs })} />
        <NumberField label="Retention (days)" value={item.retentionDays} min={1} max={3650} step="1" onChange={retentionDays => updateHistory(index, { retentionDays })} />
        <label className="process-data-check"><input type="checkbox" checked={item.enabled} onChange={event => updateHistory(index, { enabled: event.target.checked })} />Enabled</label>
      </div><button className="button" onClick={() => setDraft({ ...draft, history: draft.history.filter((_, position) => position !== index) })}>Remove historical tag {index + 1}</button></fieldset>)}
      <button className="button" disabled={draft.history.length >= 5000} onClick={() => setDraft({ ...draft, history: [...draft.history, { tagPath: "", enabled: false, deadband: 0, maxIntervalMs: 60000, retentionDays: 7 }] })}>Add historical tag</button>
      <p>Removing a rule stops recording it. Previously retained journal/history rows remain until their retention policy removes them. Configuration changes take effect after Save; they do not write equipment values.</p>
    </fieldset>}
  </section>;
}
