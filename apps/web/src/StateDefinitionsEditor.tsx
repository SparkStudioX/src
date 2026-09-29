import { useId, useRef, useState } from "react";
import { stateDefinitionsError } from "./applicationStateModel";
import type { CustomProperty, StateDefinitions, StateScope } from "./types";
import "./stateDefinitions.css";

type StateRow = { id: number; name: string; type: CustomProperty["type"]; value: string };
const labels: Record<CustomProperty["type"], string> = { string: "Text", number: "Number", boolean: "Boolean" };

/** Keep a whole declaration edit local until Apply creates one history entry. */
export function StateDefinitionsEditor({ scope, definitions = {}, references = {}, onChange }: {
  scope: StateScope; definitions?: StateDefinitions; references?: Record<string, string[]>; onChange: (definitions: StateDefinitions) => void;
}) {
  const [draft, setDraft] = useState<StateRow[] | null>(null);
  const [applyError, setApplyError] = useState("");
  const rowId = useRef(0);
  const draftSource = useRef("");
  const helpId = useId();
  const title = scope === "instance" ? "Private instance state" : scope === "session" ? "Session state" : "Screen state";
  const sourceError = stateDefinitionsError(definitions);
  const entries = sourceError ? [] : Object.entries(definitions);

  function begin() {
    if (sourceError) return;
    draftSource.current = JSON.stringify(definitions);
    setApplyError("");
    setDraft(entries.map(([name, entry]) => ({ id: rowId.current++, name, type: entry.type, value: String(entry.value) })));
  }
  function update(rows: StateRow[]) { setApplyError(""); setDraft(rows); }
  function changeRow(id: number, patch: Partial<StateRow>) {
    if (draft) update(draft.map(row => row.id === id ? { ...row, ...patch } : row));
  }
  function parse(): { definitions?: StateDefinitions; error?: string } {
    if (!draft) return {};
    if (new Set(draft.map(row => row.name)).size !== draft.length) return { error: "Each state property needs a unique name." };
    for (const row of draft) {
      if (row.type === "number" && !row.value.trim()) return { error: `Enter a numeric default for '${row.name || "new property"}'.` };
      if (row.type === "boolean" && row.value !== "true" && row.value !== "false") return { error: `Choose True or False for '${row.name || "new property"}'.` };
    }
    const next = Object.fromEntries(draft.map(row => [row.name, {
      type: row.type, value: row.type === "number" ? Number(row.value) : row.type === "boolean" ? row.value === "true" : row.value,
    }])) as StateDefinitions;
    const error = stateDefinitionsError(next);
    if (error) return { error };
    for (const [name, uses] of Object.entries(references)) {
      if (uses.length && Object.hasOwn(definitions, name) && (!Object.hasOwn(next, name) || next[name].type !== definitions[name].type))
        return { error: `Update bindings that use '${name}' before renaming, removing, or changing its type: ${uses.join(", ")}.` };
    }
    return { definitions: next };
  }
  const parsed = parse();
  function apply() {
    if (!draft) return;
    if (JSON.stringify(definitions) !== draftSource.current) { setApplyError("These declarations changed while you were editing. Cancel and reopen the editor to keep the current changes."); return; }
    if (parsed.error || !parsed.definitions) { setApplyError(parsed.error || "Review these state defaults."); return; }
    if (JSON.stringify(parsed.definitions) !== JSON.stringify(definitions)) onChange(parsed.definitions);
    setDraft(null); setApplyError("");
  }
  function cancel() { setDraft(null); setApplyError(""); }

  return <section className="document-property-group state-definitions" aria-label={`${title} defaults`}>
    <h3>{title}</h3>
    <p id={helpId} className="document-property-help">{scope === "instance"
      ? "Each template placement and repeater row owns separate values. They reset when its bound context changes or it closes. Nested templates have their own state; their parent's private values are not inherited. Only these defaults are saved."
      : scope === "session"
      ? "Values are shared by this project's screens and popups in one browser tab. They survive screen navigation and reset when the application reloads or the user changes."
      : "Values belong to each open screen or popup. They reset when you leave the screen or close the popup. Templates use their containing screen's state."} Define typed defaults here, read them with fx bindings, and update them from browser scripts.</p>
    {!draft && <>
      <div className="state-definition-summary">
        {entries.map(([name, entry]) => <div className="state-definition-summary-row" key={name}>
          <div><strong>{name}</strong><small>{labels[entry.type]}</small></div><code>{typeof entry.value === "string" ? JSON.stringify(entry.value) : String(entry.value)}</code>
        </div>)}
        {!entries.length && <p className="document-property-empty">No state properties defined.</p>}
      </div>
      {sourceError && <p className="state-definition-error" role="alert">{sourceError}</p>}
      <button type="button" className="button small state-definitions-edit" disabled={Boolean(sourceError)} onClick={begin}>Edit {scope} state ({entries.length})</button>
    </>}
    {draft && <div className="state-definitions-draft" role="group" aria-label={`Edit ${scope} state`} onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); apply(); }
      if (event.key === "Escape") { event.preventDefault(); cancel(); }
    }}>
      <div className="state-definition-rows">
        {draft.map((row, index) => <fieldset key={row.id} className="state-definition-row">
          <legend>Property {index + 1}</legend>
          <label>Name<input aria-label={`${title} property ${index + 1} name`} aria-describedby={helpId} maxLength={64} value={row.name} placeholder="selectedArea" onChange={event => changeRow(row.id, { name: event.target.value })} /></label>
          <label>Type<select aria-label={`${title} property ${index + 1} type`} value={row.type} onChange={event => changeRow(row.id, { type: event.target.value as CustomProperty["type"] })}>
            <option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option>
          </select></label>
          <label className="state-definition-value">Default value{row.type === "boolean"
            ? <select aria-label={`${title} property ${index + 1} default value`} value={row.value} onChange={event => changeRow(row.id, { value: event.target.value })}>
                {row.value !== "true" && row.value !== "false" && <option value={row.value}>Choose a value…</option>}
                <option value="false">False</option><option value="true">True</option>
              </select>
            : row.type === "string" ? <textarea aria-label={`${title} property ${index + 1} default value`} rows={2} maxLength={4096} value={row.value} onChange={event => changeRow(row.id, { value: event.target.value })} />
            : <input aria-label={`${title} property ${index + 1} default value`} inputMode="decimal" value={row.value} onChange={event => changeRow(row.id, { value: event.target.value })} />}</label>
          <button type="button" className="button small subtle" aria-label={`Remove ${scope} state property ${index + 1}`} onClick={() => update(draft.filter(item => item.id !== row.id))}>Remove</button>
          {Object.hasOwn(references, row.name) && references[row.name].length > 0 && <p className="document-property-help">Used by {references[row.name].join(", ")}.</p>}
        </fieldset>)}
      </div>
      <button type="button" className="button small" disabled={draft.length >= 64} onClick={() => {
        if (draft.length < 64) update([...draft, { id: rowId.current++, name: "", type: "string", value: "" }]);
      }}>Add property</button>
      <p className="document-property-help">Use up to 64 names, each 1–64 letters, digits, or underscores, starting with a letter or underscore. Names are case sensitive. Renaming or removing a property requires updating its bindings and scripts.</p>
      {(applyError || parsed.error) && <p className="state-definition-error" role="alert">{applyError || parsed.error}</p>}
      <div className="state-definition-actions"><button type="button" className="button small primary" disabled={Boolean(parsed.error)} onClick={apply}>Apply {scope} state</button><button type="button" className="button small" onClick={cancel}>Cancel</button></div>
    </div>}
  </section>;
}
