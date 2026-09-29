import { useRef, useState } from "react";
import type { CanvasComponent } from "./types";
import "./stateControlEditor.css";

type StateRow = { id: number; value: string; label: string; color: string };
type Draft = { rows: StateRow[]; defaultValue: string };
const hexColor = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Configure local choices and display states as one undoable authoring edit. */
export function StateControlEditor({ component, onChange, notify }: {
  component: CanvasComponent; onChange: (patch: CanvasComponent["props"]) => void; notify: (message: string, error?: boolean) => void;
}) {
  const indicator = component.type === "multiStateIndicator";
  const source = indicator ? component.props.states || [] : component.props.options || [];
  const [draft, setDraft] = useState<Draft | null>(null);
  const nextId = useRef(0);
  const minimum = indicator ? 1 : 2;
  const noun = indicator ? "state" : "option";
  const label = indicator ? "Indicator states" : "Button options";
  function edit() {
    setDraft({ rows: source.map(row => ({ ...row, id: nextId.current++, color: "color" in row && typeof row.color === "string" ? row.color : "#64748b" })),
      defaultValue: String(component.props.defaultValue ?? source[0]?.value ?? "") });
  }
  function validation(): string | undefined {
    if (!draft) return undefined;
    if (draft.rows.length < minimum || draft.rows.length > 32) return `Define ${minimum}–32 ${indicator ? "states" : "options"}.`;
    const values = new Set<string>();
    for (const [index, row] of draft.rows.entries()) {
      const maxValue = indicator ? 128 : 4096;
      const maxLabel = indicator ? 128 : 200;
      if (!row.value.trim() || row.value.length > maxValue) return `${indicator ? "State" : "Option"} ${index + 1} needs a value of 1–${maxValue.toLocaleString()} characters.`;
      if (!row.label.trim() || row.label.length > maxLabel) return `${indicator ? "State" : "Option"} ${index + 1} needs a label of 1–${maxLabel} characters.`;
      if (values.has(row.value)) return `Each ${noun} must have a unique value. '${row.value}' appears more than once.`;
      values.add(row.value);
      if (indicator && !hexColor.test(row.color)) return `State ${index + 1} needs a hex color with 3, 4, 6, or 8 digits.`;
    }
    if (!indicator && !values.has(draft.defaultValue)) return "Choose a default selection from the current button options.";
    return undefined;
  }
  const error = validation();
  function apply() {
    if (!draft) return;
    if (error) { notify(error, true); return; }
    onChange(indicator
      ? { states: draft.rows.map(({ value, label, color }) => ({ value, label, color })) }
      : { options: draft.rows.map(({ value, label }) => ({ value, label })), defaultValue: draft.defaultValue });
    setDraft(null);
  }
  function changeRow(id: number, patch: Partial<StateRow>) {
    if (draft) setDraft({ ...draft, rows: draft.rows.map(row => row.id === id ? { ...row, ...patch } : row) });
  }
  return <section className="state-control-editor" aria-label={label}>
    <div className="state-control-heading"><strong>{label}</strong>{!draft && <button type="button" className="button small" onClick={edit}>Edit {indicator ? "states" : "options"}</button>}</div>
    <p className="state-control-help">{indicator
      ? "Each exact state value selects its label and color. Use the State value binding to read a tag, parameter, or form input."
      : "Segments stage a selection in this form. Input events can respond; selecting a segment does not write to a device."}</p>
    {!draft && <>
      <ul className="state-control-summary">{source.map((row, index) => <li key={`${index}:${row.value}`}>
        {indicator && "color" in row && typeof row.color === "string" && <span className="state-control-swatch" style={{ backgroundColor: row.color }} />}
        <span>{row.label}<small>{row.value}</small></span>
        {!indicator && row.value === String(component.props.defaultValue ?? source[0]?.value ?? "") && <small>Default</small>}
      </li>)}</ul>
      {!source.length && <p className="state-control-error" role="alert">No {indicator ? "states" : "options"} configured.</p>}
    </>}
    {draft && <div className="state-control-draft" role="group" aria-label={`Edit ${label.toLowerCase()}`} onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); apply(); }
      if (event.key === "Escape") { event.preventDefault(); setDraft(null); }
    }}>
      {draft.rows.map((row, index) => <div className="state-control-row" key={row.id}>
        <div className="state-control-row-heading"><strong>{indicator ? "State" : "Option"} {index + 1}</strong>
          <button type="button" className="button small subtle" aria-label={`Remove ${noun} ${index + 1}`} disabled={draft.rows.length <= minimum}
            title={draft.rows.length <= minimum ? `Keep at least ${minimum} ${indicator ? "state" : "options"}.` : undefined}
            onClick={() => setDraft({ ...draft, rows: draft.rows.filter(item => item.id !== row.id) })}>Remove</button></div>
        <label>Value<input aria-label={`${indicator ? "State" : "Option"} ${index + 1} value`} value={row.value} maxLength={indicator ? 128 : 4096} onChange={event => changeRow(row.id, { value: event.target.value })} /></label>
        <label>Label<input aria-label={`${indicator ? "State" : "Option"} ${index + 1} label`} value={row.label} maxLength={indicator ? 128 : 200} onChange={event => changeRow(row.id, { label: event.target.value })} /></label>
        {indicator && <label>Color<div className="state-control-color"><input type="color" aria-label={`State ${index + 1} color picker`} value={/^#[0-9a-fA-F]{6}$/.test(row.color) ? row.color : "#64748b"} onChange={event => changeRow(row.id, { color: event.target.value })} />
          <input aria-label={`State ${index + 1} color`} value={row.color} maxLength={9} placeholder="#64748b" onChange={event => changeRow(row.id, { color: event.target.value })} /></div></label>}
      </div>)}
      <button type="button" className="button small" disabled={draft.rows.length >= 32} onClick={() => {
        let number = draft.rows.length + 1;
        while (draft.rows.some(row => row.value === `${noun}${number}`)) number++;
        setDraft({ ...draft, rows: [...draft.rows, { id: nextId.current++, value: `${noun}${number}`, label: `${indicator ? "State" : "Option"} ${number}`, color: "#64748b" }] });
      }}>Add {noun}</button>
      {!indicator && <label className="state-control-default">Default selection<select aria-label="Button default selection" value={draft.defaultValue} onChange={event => setDraft({ ...draft, defaultValue: event.target.value })}>
        {!draft.rows.some(row => row.value === draft.defaultValue) && <option value={draft.defaultValue}>Choose an option…</option>}
        {draft.rows.map((row, index) => <option key={row.id} value={row.value}>{row.label || `Option ${index + 1}`} · {row.value}</option>)}
      </select></label>}
      {error && <p className="state-control-error" role="alert">{error}</p>}
      <div className="state-control-actions"><button type="button" className="button small primary" onClick={apply}>Apply {indicator ? "states" : "options"}</button>
        <button type="button" className="button small" onClick={() => setDraft(null)}>Cancel</button></div>
    </div>}
  </section>;
}
