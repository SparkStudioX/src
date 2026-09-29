import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isInput, isNumericInput, stateInputError } from "./inputs";
import { stateKeyValid } from "./applicationStateModel";
import type { CanvasComponent, InputStateBinding, RuntimeStateValues } from "./types";

export function inputStateBindingDraftError(component: CanvasComponent, binding: InputStateBinding, state?: RuntimeStateValues, allowScreen = false): string | null {
  if (!stateKeyValid(binding.key)) return "Choose a declared state name with 1–64 letters, digits or underscores.";
  const candidate = { ...component, props: { ...component.props, stateBinding: binding } };
  const problem = stateInputError(candidate, state);
  // Template authors may name a property on a future containing screen. Only
  // that missing declaration is deferred; malformed or conflicting bindings
  // and an incompatible value already available in preview remain errors.
  return allowScreen && binding.scope === "screen" && problem === `Screen state '${binding.key}' is unavailable in this form.` ? null : problem;
}

/** A direct, typed value source; no reverse expression or equipment write. */
export function InputStateBindingEditor({ component, state, allowUnresolvedScreenState = false, onChange }: {
  component: CanvasComponent; state?: RuntimeStateValues; allowUnresolvedScreenState?: boolean;
  onChange: (patch: CanvasComponent["props"]) => void;
}) {
  const [draft, setDraft] = useState<InputStateBinding | null>(null);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => { if (draft && dialog.current && !dialog.current.open) dialog.current.showModal(); }, [Boolean(draft)]);
  if (!isInput(component.type) || component.type === "passwordInput") return null;
  const binding = component.props.stateBinding;
  const type = isNumericInput(component.type) ? "number" : component.type === "checkbox" || component.type === "toggle" ? "boolean" : "string";
  const compatibleKeys = (scope: InputStateBinding["scope"]) => Object.entries(state?.[scope] ?? {}).filter(([, value]) => typeof value === type).map(([key]) => key);
  const problem = binding ? inputStateBindingDraftError(component, binding, state, allowUnresolvedScreenState) : null;
  const close = () => { setDraft(null); setError(""); };
  const apply = () => {
    if (!draft) return;
    const problem = inputStateBindingDraftError(component, draft, state, allowUnresolvedScreenState);
    if (problem) { setError(problem); return; }
    onChange({ stateBinding: { ...draft } }); close();
  };
  return <div className="property-sheet-group" aria-label="Input value source">
    <h4>Data</h4>
    <div className={`property-sheet-row${binding ? " is-bound" : ""}`} data-property="inputValue">
      <label htmlFor={`${id}-source`}>Value</label>
      <div className="property-sheet-value"><input id={`${id}-source`} readOnly value={binding ? `${binding.scope}.${binding.key}` : "Local form value"} /></div>
      <button type="button" className="property-bind-button" aria-label={`${binding ? "Edit" : "Add"} Value binding`} title="Bind this input to browser application state" onClick={() => {
        setError(""); setDraft(binding ? { ...binding } : { scope: "session", key: compatibleKeys("session")[0] ?? "" });
      }}>ƒx</button>
      {binding && <small className={problem ? "property-sheet-error" : "property-sheet-expression"}>{problem || "Two-way · accepted edits update state"}</small>}
    </div>
    <p className="binding-note">{binding ? "State supplies the value; the local default is inactive. Inputs using the same state property stay synchronized." : "The form starts from its configured default or tag source. Use ƒx to synchronize with a session or screen property."}</p>
    {draft && createPortal(<dialog ref={dialog} className="property-binding-dialog" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); close(); }} onClose={close} onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); apply(); }
    }}>
      <div className="binding-dialog-heading"><div><h2 id={`${id}-title`}>Bind input value</h2><p>{component.props.text || component.id} · {type === "string" ? "Text" : type === "number" ? "Number" : "Boolean"}</p></div><button type="button" aria-label="Close value binding editor" onClick={close}>×</button></div>
      <div className="binding-dialog-body">
        <label>Source<select aria-label="Value binding scope" value={draft.scope} onChange={event => {
          const scope = event.target.value as InputStateBinding["scope"]; setError(""); setDraft({ scope, key: compatibleKeys(scope)[0] ?? "" });
        }}><option value="session">Session state</option><option value="screen">Screen state</option></select></label>
        <label>State property<input autoFocus aria-label="Value binding state property" list={`${id}-keys`} maxLength={64} value={draft.key} onChange={event => { setError(""); setDraft({ ...draft, key: event.target.value }); }} /></label>
        <datalist id={`${id}-keys`}>{compatibleKeys(draft.scope).map(key => <option key={key} value={key} />)}</datalist>
        <p className="binding-note">{draft.scope === "session" ? "Declare session properties in Project settings. Their values are shared by this project's screens and popups in one browser tab." : allowUnresolvedScreenState ? "Enter a property declared by every screen or popup using this template. Publication checks each placement's type and default value." : "Declare screen properties in this screen's property sheet. Each screen and popup opening has its own state."}</p>
        <p className="binding-note">Accepted edits update the state property immediately. Invalid entries remain in this input until corrected or the source changes. State updates and resets refresh bound inputs without firing their change/commit handlers. This binding does not write a tag or database.</p>
        <div className="binding-preview" role="status"><strong>Direction</strong><output>Two-way · input ↔ {draft.scope}.{draft.key || "…"}</output></div>
        {error && <p className="binding-apply-error" role="alert">{error}</p>}
      </div>
      <div className="binding-dialog-footer">{binding && <button type="button" className="button binding-remove" onClick={() => { onChange({ stateBinding: undefined }); close(); }}>Remove binding</button>}<button type="button" className="button" onClick={close}>Cancel</button><button type="button" className="button primary" onClick={apply}>Apply</button></div>
    </dialog>, document.body)}
  </div>;
}
