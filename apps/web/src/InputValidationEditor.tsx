import { useState } from "react";
import { PropertyCollectionDialog } from "./PropertyCollectionEditor";
import { inputDefinitionError, textValidationTypes } from "./inputValidation";
import type { CanvasComponent, InputValidationDefinition } from "./types";

export function InputValidationEditor({ component, onChange }: { component: CanvasComponent; onChange: (patch: CanvasComponent["props"]) => void }) {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(component.props), [error, setError] = useState("");
  const rules = draft.validation ?? {};
  const update = (patch: Partial<InputValidationDefinition>) => setDraft({ ...draft, validation: { ...rules, ...patch } });
  function apply() {
    const validation = Object.fromEntries(Object.entries(draft.validation ?? {}).filter(([, value]) => value !== undefined && value !== "")) as InputValidationDefinition;
    const patch: CanvasComponent["props"] = { validation: Object.keys(validation).length ? validation : undefined,
      ...(component.type === "formattedInput" ? { formatMask: draft.formatMask || undefined, textCase: draft.textCase ?? "preserve" } : {}),
      ...(component.type === "barcodeInput" ? { scanTerminator: draft.scanTerminator ?? "enter" } : {}) };
    const problem = inputDefinitionError({ ...component, props: { ...component.props, ...patch } });
    if (problem) { setError(problem); return; }
    onChange(patch); setOpen(false);
  }
  return <section className="property-sheet-group"><h4>Validation & format</h4>
    <div className="property-sheet-row" data-property="validation"><label>Input rules</label><div className="property-sheet-value property-collection-value"><span>{component.props.validation?.required ? "Required" : "Optional"}{component.props.formatMask ? ` · ${component.props.formatMask}` : ""}</span><button className="button" type="button" onClick={() => { setDraft(structuredClone(component.props)); setError(""); setOpen(true); }}>Edit rules</button></div><span aria-hidden="true" /></div>
    {open && <PropertyCollectionDialog title="Input rules" onClose={() => setOpen(false)}>
      <label className="field"><span>Required</span><input aria-label="Input required" type="checkbox" checked={rules.required ?? false} onChange={event => update({ required: event.target.checked })} /></label>
      <p className="binding-note">Rules are checked in the browser and by the gateway before actions. Empty saved defaults are allowed so operators can complete a form. Required check boxes must be checked.</p>
      {textValidationTypes.has(component.type) && <>
        <label className="field"><span>Minimum length</span><input aria-label="Input minimum length" type="number" min={0} max={4096} value={rules.minLength ?? ""} onChange={event => update({ minLength: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
        <label className="field"><span>Maximum length</span><input aria-label="Input maximum length" type="number" min={0} max={4096} value={rules.maxLength ?? ""} onChange={event => update({ maxLength: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
        <label className="field"><span>Accepted text</span><select aria-label="Input accepted text" value={rules.format ?? "text"} onChange={event => update({ format: event.target.value as InputValidationDefinition["format"] })}><option value="text">Any text</option><option value="email">Email address</option><option value="digits">Digits only</option><option value="alphanumeric">ASCII letters and digits</option></select></label>
      </>}
      {component.type === "formattedInput" && <>
        <label className="field"><span>Format mask</span><input aria-label="Input format mask" maxLength={256} value={draft.formatMask ?? ""} onChange={event => setDraft({ ...draft, formatMask: event.target.value })} placeholder="AA-####" /></label>
        <p className="binding-note"># = digit, A = ASCII letter, * = ASCII letter or digit. Escape a literal token with a backslash. Separators are inserted on Enter or blur; unexpected characters are preserved for correction. The stored value includes separators.</p>
        <label className="field"><span>Letter case</span><select aria-label="Input letter case" value={draft.textCase ?? "preserve"} onChange={event => setDraft({ ...draft, textCase: event.target.value as CanvasComponent["props"]["textCase"] })}><option value="preserve">Preserve</option><option value="upper">ASCII uppercase</option><option value="lower">ASCII lowercase</option></select></label>
      </>}
      {component.type === "barcodeInput" && <>
        <label className="field"><span>Scan terminator</span><select aria-label="Barcode scan terminator" value={draft.scanTerminator ?? "enter"} onChange={event => setDraft({ ...draft, scanTerminator: event.target.value as "enter" | "tab" })}><option value="enter">Enter</option><option value="tab">Tab</option></select></label>
        <p className="binding-note">Use a keyboard-wedge scanner while this field has focus, or type/paste the code. Leading zeros are retained. Only the configured terminator commits a scan; Tab also moves focus. No camera or global keystroke capture is used.</p>
      </>}
      <label className="field"><span>Validation message</span><input aria-label="Input validation message" maxLength={200} value={rules.message ?? ""} onChange={event => update({ message: event.target.value })} placeholder="Use the standard error" /></label>
      {error && <p className="property-sheet-error" role="alert">{error}</p>}
      <div className="binding-actions"><button className="button" type="button" onClick={() => setOpen(false)}>Cancel</button><button className="button primary" type="button" onClick={apply}>Apply rules</button></div>
    </PropertyCollectionDialog>}
  </section>;
}
