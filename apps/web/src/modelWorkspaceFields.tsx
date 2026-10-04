import { useId } from "react";
import type { ModelMetadata, ModelParameter, ModelScalar } from "./modelWorkspace";
import { modelScalar } from "./modelWorkspace";
import { ModelSemanticField } from "./modelContractFields";

export function ModelScalarField({ label, value, type = "String", onChange, placeholder }: { label: string; value: unknown; type?: string; onChange: (value: ModelScalar) => void; placeholder?: string }) {
  return <label>{label}<input value={value == null ? "" : String(value)} placeholder={placeholder || (type === "Boolean" ? "true or false" : type)} onChange={event => onChange(modelScalar(event.target.value, type))} /></label>;
}
export function ModelPairs({ label, value = {}, onChange, stringsOnly = false, suggestions = [] }: { label: string; value?: Record<string, ModelScalar>; onChange: (value: Record<string, ModelScalar>) => void; stringsOnly?: boolean; suggestions?: string[] }) {
  const id = useId();
  const change = (key: string, name: string, next: ModelScalar) => onChange(Object.fromEntries(Object.entries(value).map(([old, item]) => old === key ? [name, next] : [old, item])));
  return <fieldset className="model-pairs"><legend>{label}</legend><datalist id={id}>{suggestions.map(path => <option key={path} value={path} />)}</datalist>
    {Object.entries(value).map(([key, item], index) => <div className="model-pair" key={index}><input aria-label={`${label} name ${index + 1}`} value={key} onChange={event => change(key, event.target.value, item)} />
      {!stringsOnly && <select aria-label={`${label} type ${index + 1}`} value={typeof item} onChange={event => change(key, key, event.target.value === "boolean" ? false : event.target.value === "number" ? 0 : "")}><option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option></select>}
      <input aria-label={`${label} value ${index + 1}`} list={stringsOnly ? id : undefined} value={String(item)} onChange={event => change(key, key, modelScalar(event.target.value, typeof item === "number" ? "Double" : typeof item === "boolean" ? "Boolean" : "String"))} />
      <button type="button" className="button small" onClick={() => onChange(Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)))}>Remove</button></div>)}
    <button type="button" className="button small" disabled={Object.keys(value).length >= 32 || Object.hasOwn(value, "")} onClick={() => onChange({ ...value, "": "" })}>Add {label.toLowerCase()}</button>
  </fieldset>;
}
export function ModelMetadataFields({ value, onChange, member = false, semantic = true }: { value: ModelMetadata; onChange: (patch: Partial<ModelMetadata>) => void; member?: boolean; semantic?: boolean }) {
  return <><label>Description<input maxLength={2048} value={value.description || ""} placeholder="Add a short explanation" onChange={event => onChange({ description: event.target.value || undefined })} /></label><details className="model-metadata"><summary>Advanced metadata</summary><div className="model-grid">{semantic && <label>Meaning category<input maxLength={128} placeholder="isa95:WorkUnit" value={value.semanticType || ""} onChange={event => onChange({ semanticType: event.target.value || undefined })} /></label>}
    {member && <label>Engineering unit<input value={value.unit || ""} onChange={event => onChange({ unit: event.target.value || undefined })} /></label>}</div>
    {member && <><label className="model-checkbox"><input type="checkbox" checked={Boolean(value.range)} onChange={event => onChange({ range: event.target.checked ? { low: 0, high: 100 } : undefined })} />Numeric engineering range</label>{value.range && <div className="model-grid"><label>Low<input type="number" value={value.range.low} onChange={event => onChange({ range: { low: Number(event.target.value), high: value.range!.high } })} /></label><label>High<input type="number" value={value.range.high} onChange={event => onChange({ range: { low: value.range!.low, high: Number(event.target.value) } })} /></label></div>}</>}
    {semantic && <ModelSemanticField value={value} onChange={onChange} />}<ModelPairs label="Attributes" value={value.attributes} onChange={attributes => onChange({ attributes })} /></details></>;
}
export function ModelParameters({ parameters, onChange }: { parameters: ModelParameter[]; onChange: (parameters: ModelParameter[]) => void }) {
  const patch = (index: number, next: Partial<ModelParameter>) => onChange(parameters.map((item, offset) => offset === index ? { ...item, ...next } : item));
  return <section><h3>Parameters</h3><p>Use complete placeholders such as <code>{"{Device}"}</code> in source fields. Member names and data types stay fixed.</p>
    {parameters.map((parameter, index) => <div className="model-card" key={index}><div className="model-grid"><label>Name<input value={parameter.name} onChange={event => patch(index, { name: event.target.value })} /></label><label>Type<select value={parameter.type} onChange={event => patch(index, { type: event.target.value as ModelParameter["type"], default: undefined })}>{["String", "Double", "Int64", "Boolean"].map(type => <option key={type}>{type}</option>)}</select></label></div>
      <div className="model-actions"><label className="model-checkbox"><input type="checkbox" checked={parameter.required === true} onChange={event => patch(index, { required: event.target.checked })} />Required</label><label className="model-checkbox"><input type="checkbox" checked={parameter.default !== undefined} onChange={event => patch(index, { default: event.target.checked ? parameter.type === "String" ? "" : parameter.type === "Boolean" ? false : 0 : undefined })} />Default value</label><button type="button" className="button small" onClick={() => onChange(parameters.filter((_item, offset) => offset !== index))}>Remove parameter</button></div>
      {parameter.default !== undefined && <ModelScalarField label="Default" type={parameter.type} value={parameter.default} onChange={value => patch(index, { default: value })} />}</div>)}
    <button type="button" className="button" disabled={parameters.length >= 32} onClick={() => onChange([...parameters, { name: `Parameter${parameters.length + 1}`, type: "String", required: true }])}>Add parameter</button></section>;
}
export function ModelParameterValues({ parameters, values = {}, onChange }: { parameters: ModelParameter[]; values?: Record<string, ModelScalar>; onChange: (values: Record<string, ModelScalar>) => void }) {
  return <div className="model-grid">{parameters.map(parameter => <div key={parameter.name}><ModelScalarField label={`${parameter.name} (${parameter.type}${parameter.required ? ", required" : ""})`} value={values[parameter.name]} type={parameter.type} placeholder={parameter.default === undefined ? "No default" : `Default: ${parameter.default}`} onChange={value => onChange({ ...values, [parameter.name]: value })} /><button type="button" className="button small" disabled={!Object.hasOwn(values, parameter.name)} onClick={() => onChange(Object.fromEntries(Object.entries(values).filter(([name]) => name !== parameter.name)))}>Use default / omit</button></div>)}</div>;
}
