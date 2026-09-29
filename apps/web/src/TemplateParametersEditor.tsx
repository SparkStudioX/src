import { useEffect, useId, useState } from "react";
import { displayValue, resolvePath } from "./api";
import { coerceTemplateParameter } from "./templateModel";
import type { PropertyBinding, RuntimeParameters, Template, TemplateParameterType } from "./types";

type Notify = (message: string, error?: boolean) => void;
type DeclarationDraft = { original?: string; name: string; type: TemplateParameterType; value: string };
const typeLabels: Record<TemplateParameterType, string> = { string: "Text", number: "Number", boolean: "Boolean" };
const ownEntry = <T,>(entries: Record<string, T> | undefined, key: string): T | undefined => entries && Object.hasOwn(entries, key) ? entries[key] : undefined;

function nameError(name: string, parameters: Record<string, string>, original?: string): string | undefined {
  if (name === original) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) return "Use 1–64 letters, digits, or underscores, starting with a letter or underscore.";
  if (["__proto__", "constructor", "prototype"].includes(name)) return "That parameter name is reserved.";
  if (Object.hasOwn(parameters, name)) return `A parameter named '${name}' already exists.`;
  return undefined;
}

function previewValue(name: string, value: string, type: TemplateParameterType, parent: RuntimeParameters): { text: string; error?: string } {
  try {
    const resolved = coerceTemplateParameter(name, resolvePath(value, parent), type);
    return { text: `${typeLabels[type]} · ${displayValue(resolved)}` };
  } catch (error) {
    return { text: "Invalid value", error: error instanceof Error ? error.message : "Enter a valid parameter value." };
  }
}

/** Text storage preserves single-pass parent references for every declared type. */
function ParameterValueInput({ label, value, type, onChange, disabled = false }: {
  label: string; value: string; type: TemplateParameterType; onChange: (value: string) => void; disabled?: boolean;
}) {
  const listId = useId();
  const [referenceMode, setReferenceMode] = useState(value.includes("{") || type === "boolean" && value !== "true" && value !== "false");
  useEffect(() => { if (value.includes("{")) setReferenceMode(true); }, [value]);
  const reference = referenceMode || value.includes("{");
  return <div className="template-parameter-value-input">
    {type === "string"
      ? <textarea rows={2} aria-label={label} value={value} disabled={disabled} placeholder="Text value"
          onChange={event => onChange(event.target.value)} />
      : type === "boolean" && !reference
      ? <select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
          {value !== "true" && value !== "false" && <option value={value}>Choose a value…</option>}
          <option value="false">False</option><option value="true">True</option>
        </select>
      : <input aria-label={label} value={value} disabled={disabled}
          inputMode={type === "number" && !reference ? "decimal" : undefined}
          placeholder={reference ? "{parentParameter}" : type === "number" ? "0" : "Text value"}
          list={type === "boolean" ? listId : undefined} onChange={event => onChange(event.target.value)} />}
    {type === "boolean" && <datalist id={listId}><option value="true" /><option value="false" /></datalist>}
    {type !== "string" && <label className="template-parameter-reference"><input type="checkbox" checked={reference}
      disabled={disabled} aria-label={`${label} uses parent reference`} onChange={event => {
        setReferenceMode(event.target.checked);
        if (!event.target.checked && value.includes("{")) onChange(type === "boolean" ? "false" : "0");
      }} />Parent reference</label>}
  </div>;
}

export function TemplateParametersEditor({ template, parentParameters, onChange, notify }: {
  template: Template; parentParameters: RuntimeParameters; onChange: (patch: Partial<Template>) => void; notify: Notify;
}) {
  const [draft, setDraft] = useState<DeclarationDraft | null>(null);
  const helpId = useId();
  const parameters = template.parameters || {};
  const preview = draft ? previewValue(draft.name || "parameter", draft.value, draft.type, parentParameters) : undefined;
  const validation = draft ? (draft.original === undefined && Object.keys(parameters).length >= 64 ? "A template can declare at most 64 parameters." : nameError(draft.name, parameters, draft.original)) || preview?.error : undefined;
  function apply() {
    if (!draft) return;
    if (validation) { notify(validation, true); return; }
    const entries = Object.entries(parameters);
    const nextParameters = Object.fromEntries(draft.original === undefined
      ? [...entries, [draft.name, draft.value]]
      : entries.map(([key, value]) => [key === draft.original ? draft.name : key, key === draft.original ? draft.value : value]));
    const nextTypes = Object.fromEntries([...Object.entries(template.parameterTypes || {}).filter(([key]) => key !== draft.original && key !== draft.name),
      ...(draft.type === "string" ? [] : [[draft.name, draft.type]])]);
    onChange({ parameters: nextParameters, parameterTypes: nextTypes });
    setDraft(null);
  }
  return <section className="document-property-group template-parameters" aria-label="Template parameter defaults">
    <h3>Parameters</h3>
    <p id={helpId} className="document-property-help">Declare the values each instance can override. Text is the default type for existing parameters. Use <code>{"{parentParameter}"}</code> to read the parent context once before conversion.</p>
    <div className="template-parameter-columns" aria-hidden="true"><span>Name / type</span><span>Default value</span><span /></div>
    {Object.entries(parameters).map(([name, value]) => {
      const type = ownEntry(template.parameterTypes, name) || "string";
      const resolved = previewValue(name, value, type, parentParameters);
      return <div className="template-parameter-definition" key={name}>
        <div><strong>{name}</strong><small>{typeLabels[type]}</small></div>
        <div><code>{value || "(empty)"}</code><small className={resolved.error ? "template-parameter-error" : undefined}>{resolved.error || resolved.text}</small></div>
        <button type="button" className="button small" aria-label={`Edit template parameter ${name}`} onClick={() => setDraft({ original: name, name, type, value })}>Edit</button>
      </div>;
    })}
    {!Object.keys(parameters).length && <p className="document-property-empty">No parameters defined.</p>}
    {!draft && <button type="button" className="button small template-parameter-add" onClick={() => setDraft({ name: "", type: "string", value: "" })}>Add parameter</button>}
    {draft && <div className="template-parameter-draft" role="group" aria-label={draft.original ? `Edit parameter ${draft.original}` : "Add template parameter"}
      onKeyDown={event => {
        event.stopPropagation();
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); apply(); }
        if (event.key === "Escape") { event.preventDefault(); setDraft(null); }
      }}>
      <label>Name<input aria-label="Template parameter name" aria-describedby={helpId} value={draft.name} maxLength={64} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>Type<select aria-label="Template parameter type" value={draft.type} onChange={event => setDraft({ ...draft, type: event.target.value as TemplateParameterType })}>
        <option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option>
      </select></label>
      <div className="template-parameter-draft-value"><span>Default value</span><ParameterValueInput key={`${draft.original ?? "new"}:${draft.type}`} label="Template parameter default value" value={draft.value} type={draft.type} onChange={value => setDraft({ ...draft, value })} /></div>
      <p className={validation ? "template-parameter-error" : "document-property-help"} role={validation ? "alert" : "status"}>{validation || preview?.text}</p>
      <p className="document-property-help">Number values use decimal notation without spaces. Boolean values are exactly <code>true</code> or <code>false</code>. Changes apply together and can be undone.</p>
      <div className="template-parameter-actions">
        <button type="button" className="button small primary" onClick={apply}>Apply parameter</button>
        <button type="button" className="button small" onClick={() => setDraft(null)}>Cancel</button>
        {draft.original !== undefined && <button type="button" className="button small danger subtle" onClick={() => {
          onChange({ parameters: Object.fromEntries(Object.entries(parameters).filter(([key]) => key !== draft.original)),
            parameterTypes: Object.fromEntries(Object.entries(template.parameterTypes || {}).filter(([key]) => key !== draft.original)) });
          setDraft(null);
        }}>Delete parameter</button>}
      </div>
    </div>}
  </section>;
}

function OverrideRow({ name, defaultValue, type, override, parentParameters, onChange, notify, binding, bindingValue, bindingError, onEditBinding }: {
  name: string; defaultValue: string; type: TemplateParameterType; override?: string; parentParameters: RuntimeParameters;
  onChange: (value: string | undefined) => void; notify: Notify;
  binding?: PropertyBinding; bindingValue?: string | number | boolean; bindingError?: string; onEditBinding?: () => void;
}) {
  const [draft, setDraft] = useState(override ?? defaultValue);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setDraft(override ?? defaultValue); setEditing(false); }, [override, defaultValue, type, binding]);
  const resolved = previewValue(name, editing ? draft : override ?? defaultValue, type, parentParameters);
  const defaultPreview = previewValue(name, defaultValue, type, parentParameters);
  function apply() {
    if (resolved.error) { notify(resolved.error, true); return; }
    onChange(draft); setEditing(false);
  }
  return <div className={`template-parameter-override${binding ? " is-bound" : ""}`} aria-label={`Template parameter ${name} override`}>
    <div className="template-parameter-override-header"><strong>{name}</strong><span>{typeLabels[type]}</span>
      <select aria-label={`Parameter ${name} value source`} disabled={Boolean(binding)} value={binding ? "binding" : editing || override !== undefined ? "override" : "default"} onChange={event => {
        if (event.target.value === "default") { setEditing(false); setDraft(defaultValue); onChange(undefined); }
        else { setDraft(override ?? defaultValue); setEditing(true); }
      }}><option value="default">Use default</option><option value="override">Override</option>{binding && <option value="binding">Binding</option>}</select>
      {onEditBinding && <button type="button" className="property-bind-button" aria-label={`${binding ? "Edit" : "Add"} parameter ${name} binding`} title={binding ? `${binding.expression}\nEdit or remove binding` : `Bind parameter ${name}`} onClick={onEditBinding}>ƒx</button>}
    </div>
    <p className="document-property-help">Default: <code>{defaultValue || "(empty)"}</code>{!defaultPreview.error && ` → ${defaultPreview.text}`}</p>
    {!binding && (editing || override !== undefined) && <div onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (editing) apply(); }
      if (event.key === "Escape") { event.preventDefault(); setDraft(override ?? defaultValue); setEditing(false); }
    }}>
      <ParameterValueInput label={`Parameter ${name} override value`} value={editing ? draft : override ?? defaultValue} type={type} onChange={value => { setDraft(value); setEditing(true); }} />
      {editing && <div className="template-parameter-actions"><button type="button" className="button small" onClick={apply}>Apply override</button>
        <button type="button" className="button small" onClick={() => { setDraft(override ?? defaultValue); setEditing(false); }}>Cancel</button></div>}
    </div>}
    {binding ? <>
      <code className="template-parameter-binding-expression">{binding.expression}</code>
      <p className={bindingError ? "template-parameter-error" : "document-property-help"} role={bindingError ? "alert" : "status"}>{bindingError || `${typeLabels[type]} · ${displayValue(bindingValue)}`}</p>
    </> : <p className={resolved.error ? "template-parameter-error" : "document-property-help"} role={resolved.error ? "alert" : "status"}>{resolved.error || resolved.text}</p>}
  </div>;
}

export function TemplateParameterOverrides({ template, parameters, parentParameters, onChange, notify, bindings = {}, bindingValues = {}, bindingErrors = {}, onEditBinding, onRemoveBinding }: {
  template?: Template; parameters: Record<string, string>; parentParameters: RuntimeParameters;
  onChange: (parameters: Record<string, string>) => void; notify: Notify;
  bindings?: Record<string, PropertyBinding>; bindingValues?: RuntimeParameters; bindingErrors?: Record<string, string>;
  onEditBinding?: (name: string) => void; onRemoveBinding?: (name: string) => void;
}) {
  function update(name: string, value: string | undefined) {
    onChange(Object.fromEntries([...Object.entries(parameters).filter(([key]) => key !== name), ...(value === undefined ? [] : [[name, value]])]));
  }
  const unknown = [...new Set([...Object.keys(parameters), ...Object.keys(bindings)])].filter(key => !Object.hasOwn(template?.parameters || {}, key));
  return <section className="template-parameter-overrides" aria-label="Template parameter overrides">
    <p className="template-property-note">Choose a value for each instance, or inherit the shared default. {onEditBinding && <>Use ƒx to bind a value from the containing form. </>}Parent references use <code>{"{parameter}"}</code>; repeater row values take precedence over these overrides.</p>
    {template && Object.entries(template.parameters).map(([name, defaultValue]) => <OverrideRow key={`${template.id}:${name}`} name={name} defaultValue={defaultValue}
      type={ownEntry(template.parameterTypes, name) || "string"} override={ownEntry(parameters, name)} parentParameters={parentParameters} notify={notify} onChange={value => update(name, value)}
      binding={ownEntry(bindings, name)} bindingValue={ownEntry(bindingValues, name)} bindingError={ownEntry(bindingErrors, name)} onEditBinding={onEditBinding ? () => onEditBinding(name) : undefined} />)}
    {!template && <p className="document-property-empty">Choose a template to edit its parameters.</p>}
    {template && !Object.keys(template.parameters).length && <p className="document-property-empty">This template has no parameters.</p>}
    {unknown.map(name => <div className="template-parameter-unknown" key={name}><span role="alert">Undeclared parameter: <strong>{name}</strong></span>
      {Object.hasOwn(parameters, name) && <button className="button small" type="button" aria-label={`Remove undeclared parameter ${name}`} onClick={() => update(name, undefined)}>Remove override</button>}
      {Object.hasOwn(bindings, name) && onRemoveBinding && <button className="button small" type="button" aria-label={`Remove undeclared parameter ${name} binding`} onClick={() => onRemoveBinding(name)}>Remove binding</button>}</div>)}
  </section>;
}
