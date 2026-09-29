import type { RuntimeParameters, RuntimeStateValues } from "./types";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isInput, isSafeNumber } from "./inputs";
import { evaluateComponentBindings, isGeometryTarget, processBindingTargets, propertyValue, supportsBindingTarget, validatePropertyBinding } from "./propertyBindings";
import { isProcessDisplay, resolveProcessDisplay } from "./processDisplays";
import { drawingDefaults, isDrawingComponent } from "./drawingComponents";
import { InputStateBindingEditor } from "./InputStateBindingEditor";
import { TemplateParameterOverrides } from "./TemplateParametersEditor";
import { coerceTemplateParameter } from "./templateModel";
import { resolveParameterBindings, validateTemplateParameterBinding } from "./templateParameterBindings";
import { resolvePath } from "./api";
import type { BindingTarget, CanvasComponent, InputValues, PropertyBinding, Tag, Template, NamedQuery } from "./types";
import "./propertyBindings.css";
import { BindingReferencesEditor, type ReferenceRow } from "./BindingReferencesEditor";
import { QueryPropertyBindingEditor } from "./QueryPropertyBindingEditor";

type Target = BindingTarget;
type CustomType = "number" | "string" | "boolean";

type BindingDraft = { kind: "binding"; target: Target; expression: string; rows: ReferenceRow[] } | { kind: "parameter"; target: string; expression: string; rows: ReferenceRow[] };
type CustomDraft = { kind: "custom"; originalName?: string; name: string; type: CustomType; value: string };
type Draft = BindingDraft | CustomDraft | { kind: "query"; target: Target };
const ownEntry = <T,>(entries: Record<string, T> | undefined, key: string): T | undefined => entries && Object.hasOwn(entries, key) ? entries[key] : undefined;

export interface PropertyBindingsEditorProps {
  component: CanvasComponent;
  components: CanvasComponent[];
  tags: Tag[];
  queries?: NamedQuery[];
  parameters: RuntimeParameters;
  inputs: InputValues;
  state?: RuntimeStateValues;
  allowUnresolvedScreenState?: boolean;
  communicationLost?: boolean;
  parameterTemplate?: Template;
  notify?: (message: string, error?: boolean) => void;
  onChange: (patch: CanvasComponent["props"]) => void;
  onGeometryChange: (patch: Partial<Pick<CanvasComponent, "x" | "y" | "width" | "height">>) => void;
}

const properties: { value: Target; label: string; group: string; kind: "text" | "boolean" | "color" | "number" | "orientation"; min?: number; max?: number }[] = [
  { value: "text", label: "Text", group: "General", kind: "text" },
  { value: "enabled", label: "Enabled", group: "General", kind: "boolean" },
  { value: "visible", label: "Visible", group: "General", kind: "boolean" },
  { value: "tagPath", label: "Tag path", group: "Data", kind: "text" },
  { value: "stateValue", label: "State value", group: "Data", kind: "text" },
  { value: "value", label: "Value", group: "Data", kind: "number" },
  { value: "min", label: "Minimum", group: "Data", kind: "number" },
  { value: "max", label: "Maximum", group: "Data", kind: "number" },
  { value: "decimals", label: "Decimal places", group: "Data", kind: "number", min: 0, max: 6 },
  { value: "unit", label: "Unit", group: "Data", kind: "text" },
  { value: "showValue", label: "Show value", group: "Data", kind: "boolean" },
  { value: "showPercent", label: "Show percent", group: "Data", kind: "boolean" },
  { value: "orientation", label: "Orientation", group: "Data", kind: "orientation" },
  { value: "flowing", label: "Flowing", group: "Data", kind: "boolean" },
  { value: "flowReverse", label: "Reverse flow", group: "Data", kind: "boolean" },
  { value: "active", label: "Active", group: "Data", kind: "boolean" },
  { value: "x", label: "X", group: "Layout", kind: "number", min: 0, max: 8192 },
  { value: "y", label: "Y", group: "Layout", kind: "number", min: 0, max: 8192 },
  { value: "width", label: "Width", group: "Layout", kind: "number", min: 1, max: 8192 },
  { value: "height", label: "Height", group: "Layout", kind: "number", min: 1, max: 8192 },
  { value: "fontSize", label: "Font size", group: "Appearance", kind: "number", min: 1, max: 256 },
  { value: "color", label: "Accent color", group: "Appearance", kind: "color" },
  { value: "foregroundColor", label: "Text color", group: "Appearance", kind: "color" },
  { value: "backgroundColor", label: "Background", group: "Appearance", kind: "color" },
  { value: "borderColor", label: "Border color", group: "Appearance", kind: "color" },
  { value: "borderWidth", label: "Border width", group: "Appearance", kind: "number", min: 0, max: 32 },
  { value: "strokeColor", label: "Stroke color", group: "Appearance", kind: "color" },
  { value: "fillColor", label: "Fill color", group: "Appearance", kind: "color" },
  { value: "strokeWidth", label: "Stroke width", group: "Appearance", kind: "number", min: 1, max: 32 },
  { value: "rotation", label: "Rotation", group: "Appearance", kind: "number", min: 0, max: 360 },
];
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const reserved = new Set(["true", "false", "null", "__proto__", "prototype", "constructor"]);
function validName(name: string) { return identifier.test(name) && !reserved.has(name); }
function formatValue(value: unknown): string {
  return value === undefined ? "Default" : value === null ? "Unavailable" : typeof value === "string" ? JSON.stringify(value) : String(value);
}
function componentName(component: CanvasComponent) { return `${component.props.text || component.type} · ${component.id}`; }
function processDefault(component: CanvasComponent, target: Target): string | number | boolean | undefined {
  if (isDrawingComponent(component.type)) {
    const value = drawingDefaults(component.type)[target];
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
  }
  if (!isProcessDisplay(component.type)) return undefined;
  if (target === "value" || target === "min") return 0;
  if (target === "max") return 100;
  if (target === "decimals") return 1;
  if (target === "unit") return "";
  if (target === "showValue") return true;
  if (target === "showPercent") return false;
  if (target === "orientation") return component.type === "levelIndicator" ? "vertical" : "horizontal";
  return undefined;
}

function ProcessNumberInput({ id, value, target, disabled, onChange }: { id: string; value: unknown; target: Target; disabled: boolean; onChange: (value: number | undefined) => void }) {
  const [draft, setDraft] = useState(String(value ?? ""));
  const [error, setError] = useState("");
  useEffect(() => { setDraft(String(value ?? "")); setError(""); }, [value]);
  function commit() {
    if (!draft) { onChange(undefined); return; }
    const number = Number(draft);
    if (target === "strokeWidth" && (!isSafeNumber(number) || number < 1 || number > 32) || target === "rotation" && (!isSafeNumber(number) || number < 0 || number > 360)) {
      setError(target === "strokeWidth" ? "Use a stroke width from 1 to 32 pixels." : "Use a rotation from 0 to 360 degrees."); return;
    }
    if (!isSafeNumber(number) || target === "decimals" && (!Number.isInteger(number) || number < 0 || number > 6)) {
      setError(target === "decimals" ? "Use a whole number from 0 to 6." : "Use an exact finite number; whole numbers must be within ±9,007,199,254,740,991."); return;
    }
    setError(""); if (number !== value) onChange(number);
  }
  return <><input id={id} type="number" step={target === "decimals" ? 1 : "any"} min={target === "strokeWidth" ? 1 : target === "rotation" || target === "decimals" ? 0 : undefined} max={target === "strokeWidth" ? 32 : target === "rotation" ? 360 : target === "decimals" ? 6 : undefined}
    value={draft} disabled={disabled} aria-invalid={Boolean(error)} onChange={event => { setDraft(event.target.value); setError(""); }} onBlur={commit}
    onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); event.currentTarget.blur(); }
      if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDraft(String(value ?? "")); setError(""); }
    }} />{error && <small role="alert" className="property-sheet-error">{error}</small>}</>;
}

/** Reset an open draft when selection changes, without changing the stored component. */
export function PropertyBindingsEditor(props: PropertyBindingsEditorProps) {
  return <BindingsPanel key={props.component.id} {...props} />;
}

function BindingsPanel({ component, components, tags, queries = [], parameters, inputs, state, allowUnresolvedScreenState = false, communicationLost, parameterTemplate, notify = () => {}, onChange, onGeometryChange }: PropertyBindingsEditorProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [applyError, setApplyError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const referenceId = useRef(0);
  const id = useId();
  const custom = component.props.customProperties || {};
  const bindings = component.props.bindings || {};
  const parameterBindings = component.props.parameterBindings || {};
  const queryBindings = component.props.queryBindings || {};
  const wrapper = component.type === "template" || component.type === "repeater";
  const context = { components, tags, parameters, inputs, state, communicationLost };
  const sessionState = state?.session || {};
  const screenState = state?.screen || {};
  const instanceState = state?.instance;
  const evaluated = evaluateComponentBindings(component, context);
  const inputKeys = [...new Set(components.filter((item) => isInput(item.type) && (draft?.kind !== "parameter" || item.type !== "passwordInput")).map((item) => item.props.fieldKey || item.id))];
  const customComponents = [component, ...components.filter((item) => item.id !== component.id)];
  const open = Boolean(draft);

  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [open]);

  function begin(next: Draft) { setApplyError(""); setDraft(next); }
  function changeDraft(next: Draft) { setApplyError(""); setDraft(next); }
  function close() { setDraft(null); setApplyError(""); }
  function propertyUse(name: string): string[] {
    return customComponents.flatMap((owner) => [...Object.entries(owner.props.bindings || {}), ...Object.entries(owner.props.parameterBindings || {}).map(([key, binding]) => [`parameter ${key}`, binding] as const), ...Object.entries(owner.props.queryBindings || {}).flatMap(([target, source]) => Object.entries(source?.parameters || {}).map(([name, binding]) => [`query ${target} / ${name}`, binding] as const))].filter(([, binding]) => Object.values(binding?.references || {}).some((reference) => reference.kind === "custom" && reference.key === name && (reference.componentId || owner.id) === component.id)).map(([property]) => `${owner.props.text || owner.id} · ${property}`));
  }
  function bindingFrom(draft: BindingDraft): PropertyBinding {
    return { expression: draft.expression, references: Object.fromEntries(draft.rows.map((row) => [row.name, row.reference])) };
  }
  function draftError(draft: BindingDraft): string | undefined {
    if (draft.rows.some((row) => !validName(row.name))) return "Give each reference a name of 1–64 letters, numbers, or underscores. Start with a letter or underscore; reserved names are unavailable.";
    if (new Set(draft.rows.map((row) => row.name)).size !== draft.rows.length) return "Reference names must be unique.";
    if (draft.kind === "parameter") {
      if (!parameterTemplate || !Object.hasOwn(parameterTemplate.parameters, draft.target)) return "This parameter is no longer declared by the selected template.";
      return validateTemplateParameterBinding(bindingFrom(draft), component, components, parameters, draft.target, ownEntry(parameterTemplate.parameterTypes, draft.target) || "string", state, allowUnresolvedScreenState);
    }
    const definitionError = validatePropertyBinding(bindingFrom(draft), draft.target, component);
    if (definitionError) return definitionError;
    for (const { name, reference } of draft.rows) {
      if (reference.kind === "custom") {
        const owner = customComponents.find((item) => item.id === (reference.componentId || component.id));
        if (!owner) return `Reference '${name}' must use a component in this screen or template.`;
        if (!Object.hasOwn(owner.props.customProperties || {}, reference.key)) return `Reference '${name}' must use an existing custom property on the selected component.`;
      } else if (reference.kind === "input" && !inputKeys.includes(reference.key)) {
        return `Reference '${name}' must name a form input in this screen or template.`;
      } else if (reference.kind === "parameter" && !Object.hasOwn(parameters, reference.key)) {
        return `Reference '${name}' must name a declared project, screen, or template parameter.`;
      } else if (reference.kind === "sessionState" && !Object.hasOwn(sessionState, reference.key)) {
        return `Reference '${name}' must name a declared session state property in Project settings.`;
      } else if (reference.kind === "screenState" && !Object.hasOwn(screenState, reference.key) && !allowUnresolvedScreenState) {
        return `Reference '${name}' must name a declared state property on this screen.`;
      } else if (reference.kind === "instanceState" && (!instanceState || !Object.hasOwn(instanceState, reference.key))) {
        return `Reference '${name}' must name private instance state declared on this shared template.`;
      } else if (reference.kind === "tag") {
        for (const match of reference.path.matchAll(/\{([^{}]+)\}/g)) {
          if (match[1].length > 256 || !Object.hasOwn(parameters, match[1]) || ["__proto__", "constructor", "prototype"].includes(match[1])) return `Reference '${name}' uses an undeclared or invalid tag path parameter '${match[1]}'.`;
        }
      }
    }
    return undefined;
  }
  function editBinding(target: Target, mode?: "binding" | "query") {
    if (mode === "query" || mode === undefined && queryBindings[target]) { begin({ kind: "query", target }); return; }
    const binding = bindings[target];
    const value = propertyValue(component, target) ?? processDefault(component, target) ?? (target === "tagPath" ? "[default]Equipment/Load" : target === "stateValue" ? "idle" : target === "text" ? "Ready" : target === "enabled" || target === "visible" ? true : target.toLowerCase().includes("color") ? "#2563eb" : target === "fontSize" ? 14 : 0);
    begin({ kind: "binding", target, expression: binding?.expression ?? JSON.stringify(value), rows: Object.entries(binding?.references || {}).map(([name, reference]) => ({ id: referenceId.current++, name, reference: { ...reference } })) });
  }
  function editParameterBinding(name: string) {
    if (!parameterTemplate) return;
    const binding = ownEntry(parameterBindings, name);
    let value: string | number | boolean = ownEntry(component.props.parameters, name) ?? parameterTemplate.parameters[name];
    try { value = coerceTemplateParameter(name, resolvePath(String(value), parameters), ownEntry(parameterTemplate.parameterTypes, name) || "string"); } catch { /* The dialog reports invalid live data. */ }
    begin({ kind: "parameter", target: name, expression: binding?.expression ?? JSON.stringify(value), rows: Object.entries(binding?.references || {}).map(([name, reference]) => ({ id: referenceId.current++, name, reference: { ...reference } })) });
  }
  function removeParameterBinding(name: string) { const next = { ...parameterBindings }; delete next[name]; onChange({ parameterBindings: next }); }
  function unresolvedScreenKeys(binding: PropertyBinding): string[] {
    return allowUnresolvedScreenState ? [...new Set(Object.values(binding.references).flatMap(reference => reference.kind === "screenState" && !Object.hasOwn(screenState, reference.key) ? [reference.key] : []))] : [];
  }
  function parameterResult(name: string, binding: PropertyBinding): { value?: string | number | boolean; error?: string } {
    if (!parameterTemplate) return { error: "Choose a template to resolve this parameter." };
    const type = ownEntry(parameterTemplate.parameterTypes, name) || "string";
    const error = validateTemplateParameterBinding(binding, component, components, parameters, name, type, state, allowUnresolvedScreenState);
    if (error) return { error };
    const missing = unresolvedScreenKeys(binding);
    if (missing.length) return { error: `Preview unavailable without a containing screen or popup that declares: ${missing.join(", ")}.` };
    try { return { value: resolveParameterBindings({ ...component, props: { ...component.props, parameterBindings: { [name]: binding } } }, parameterTemplate, context)[name] }; }
    catch (reason) { return { error: reason instanceof Error ? reason.message : "Parameter binding failed." }; }
  }
  function apply() {
    if (!draft || draft.kind === "query") return;
    if (draft.kind !== "custom") {
      const error = draftError(draft);
      if (error) { setApplyError(error); return; }
      const nextQueries = { ...queryBindings }; if (draft.kind === "binding") delete nextQueries[draft.target];
      onChange(draft.kind === "parameter" ? { parameterBindings: { ...parameterBindings, [draft.target]: bindingFrom(draft) } } : { bindings: { ...bindings, [draft.target]: bindingFrom(draft) }, ...(queryBindings[draft.target] ? { queryBindings: nextQueries } : {}) });
    } else {
      const name = draft.name.trim();
      if (!validName(name)) { setApplyError("Use 1–64 letters, numbers, and underscores. Start with a letter or underscore; reserved names are unavailable."); return; }
      if (draft.originalName && name !== draft.originalName && propertyUse(draft.originalName).length) { setApplyError("Update the bindings that reference this property before renaming it."); return; }
      if (name !== draft.originalName && Object.hasOwn(custom, name)) { setApplyError("A custom property already uses that name."); return; }
      if (!draft.originalName && Object.keys(custom).length >= 32) { setApplyError("A component can have up to 32 custom properties."); return; }
      if (draft.originalName && propertyUse(draft.originalName).length && custom[draft.originalName]?.type !== draft.type) { setApplyError("Update the bindings that reference this property before changing its type."); return; }
      if (draft.type === "number" && (!draft.value.trim() || !isSafeNumber(Number(draft.value)))) { setApplyError("Enter a finite number. Whole numbers must be within ±9,007,199,254,740,991 to preserve their exact value."); return; }
      if (draft.type === "string" && draft.value.length > 4096) { setApplyError("Text values can contain up to 4096 characters."); return; }
      const next = { ...custom };
      if (draft.originalName) delete next[draft.originalName];
      next[name] = { type: draft.type, value: draft.type === "number" ? Number(draft.value) : draft.type === "boolean" ? draft.value === "true" : draft.value };
      onChange({ customProperties: next });
    }
    close();
  }
  const definitionError = draft && (draft.kind === "binding" || draft.kind === "parameter") ? draftError(draft) : undefined;
  const preview = draft?.kind === "binding" && !definitionError
    ? evaluateComponentBindings({ ...component, props: { ...component.props, bindings: { ...bindings, [draft.target]: bindingFrom(draft) } } }, context)
    : undefined;
  const parameterPreview = draft?.kind === "parameter" && !definitionError ? parameterResult(draft.target, bindingFrom(draft)) : undefined;
  const deferredScreenPreview = draft?.kind === "parameter" && !definitionError && unresolvedScreenKeys(bindingFrom(draft)).length > 0;
  const previewError = draft?.kind === "binding" ? definitionError || preview?.errors[draft.target] : draft?.kind === "parameter" ? definitionError || parameterPreview?.error : undefined;
  const parameterResults = Object.fromEntries(Object.entries(parameterBindings).map(([name, binding]) => [name, parameterResult(name, binding)]));
  const processResult = isProcessDisplay(component.type) ? resolveProcessDisplay(evaluated.component, parameters) : undefined;

  return <section className="property-bindings-panel inspector-section" aria-label="Component property sheet">
    <div className="binding-section-heading"><h3>Property sheet</h3><span>{Object.keys(bindings).length + Object.keys(queryBindings).length + Object.keys(parameterBindings).length + Number(Boolean(component.props.stateBinding))} bound</span></div>
    {wrapper && <p className="binding-note">Wrapper bindings use the containing screen or popup's inputs, parameters, and components. Template parameters and repeated-row inputs stay separate. Appearance supplies defaults for child controls; each child's explicit appearance takes precedence.</p>}
    {isDrawingComponent(component.type) && <p className="binding-note">The accessible label describes this drawing to operators. Stroke width uses pixels; rotation uses degrees. Fill color accepts a hex color or <code>none</code>. {component.type === "pipe" ? "Flowing and Reverse flow show the state you bind; Accent color controls the moving flow marks." : component.type === "equipmentSymbol" ? "Active uses Accent color to show the state you bind." : ""}</p>}
    {processResult && !processResult.available && <p className="property-sheet-error" role="alert">{processResult.diagnostic}</p>}
    <div className="property-sheet-columns"><span>Property</span><span>Value</span><span>Bind</span></div>
    {["General", "Layout", "Appearance", ...(["value", "gauge", "multiStateIndicator", "pipe", "equipmentSymbol"].includes(component.type) || isProcessDisplay(component.type) ? ["Data"] : [])].map(group => <div className="property-sheet-group" key={group}>
      <h4>{group}</h4>
      {properties.filter(item => item.group === group && supportsBindingTarget(component.type, item.value)).map(item => {
        const key = item.value;
        const label = (wrapper || isDrawingComponent(component.type)) && key === "text" ? "Accessible label" : item.label;
        const queryBinding = queryBindings[key];
        const bound = Boolean(bindings[key] || queryBinding);
        const summary = queryBinding ? `Query: ${queries.find(query => query.id === queryBinding.queryId)?.name || queryBinding.queryId} · ${queryBinding.column} · ${queryBinding.refresh?.mode === "poll" ? `${queryBinding.refresh.intervalMs} ms` : "On change"}` : bindings[key]?.expression;
        const rawValue = propertyValue(bound ? evaluated.component : component, key);
        const value = bound ? rawValue : rawValue ?? processDefault(component, key);
        const staticError = !bound && item.kind === "color" && value !== undefined && !(key === "fillColor" && value === "none") && (String(value).trim() !== value || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(String(value))) ? key === "fillColor" ? "Use a hex color or 'none' for an unfilled drawing." : "Use a hex color, or clear for the default." : undefined;
        const changeValue = (value: string | number | boolean | undefined) => isGeometryTarget(key) ? onGeometryChange({ [key]: value as number }) : onChange({ [key]: value });
        const inputId = `${id}-property-${key}`;
        return <div className={`property-sheet-row${bound ? " is-bound" : ""}`} key={key} data-property={key}>
          <label htmlFor={inputId}>{label}</label>
          <div className="property-sheet-value">
            {queryBinding ? <span className="property-query-value">Query result · preview to read</span> : item.kind === "boolean" ? <input id={inputId} type="checkbox" checked={(value ?? (!bound && key !== "showPercent")) === true} disabled={bound} onChange={event => changeValue(event.target.checked)} />
              : item.kind === "orientation" ? <select id={inputId} value={typeof value === "string" ? value : ""} disabled={bound} onChange={event => changeValue(event.target.value)}>
                {!value && <option value="">Unavailable</option>}<option value="horizontal">Horizontal</option><option value="vertical">Vertical</option>
              </select>
              : item.kind === "number" && ((processBindingTargets as readonly string[]).includes(key) || key === "strokeWidth" || key === "rotation") ? <ProcessNumberInput id={inputId} value={value} target={key} disabled={bound} onChange={changeValue} />
              : item.kind === "color" ? <div className="property-sheet-color"><input type="color" aria-label={`${label} picker`} value={typeof value === "string" && /^#[a-fA-F0-9]{6}$/.test(value) ? value : "#000000"} disabled={bound} onChange={event => changeValue(event.target.value)} /><input id={inputId} value={String(value ?? "")} placeholder={key === "fillColor" ? "none or #64748b" : "Default"} disabled={bound} aria-invalid={Boolean(staticError)} onChange={event => changeValue(event.target.value || undefined)} /></div>
              : <input id={inputId} type={item.kind === "number" ? "number" : "text"} step="any" min={item.min} max={item.max} maxLength={key === "stateValue" ? 4096 : key === "unit" ? 32 : undefined} placeholder={key === "fontSize" ? "Default" : ""} value={typeof value === "number" || typeof value === "string" ? value : ""} disabled={bound} onChange={event => {
                if (item.kind === "text") changeValue(event.target.value);
                else if (!event.target.value && !isGeometryTarget(key)) changeValue(undefined);
                else if (event.target.value && Number.isFinite(Number(event.target.value))) changeValue(Math.max(item.min ?? -Infinity, Math.min(item.max ?? Infinity, Number(event.target.value))));
              }} />}
          </div>
          <button type="button" className="property-bind-button" aria-label={`${bound ? "Edit" : "Add"} ${label} binding`} title={bound ? `${summary}\nClick to edit or remove binding` : `Bind ${label}`} onClick={() => editBinding(key)}>ƒx</button>
          {bound && <small className={evaluated.errors[key] ? "property-sheet-error" : "property-sheet-expression"} title={summary}>{queryBinding ? `${summary} · Preview in the binding editor` : evaluated.errors[key] || summary}</small>}
          {staticError && <small role="alert" className="property-sheet-error">{staticError}</small>}
        </div>;
      })}
    </div>)}
    <InputStateBindingEditor key={component.id} component={component} state={state} allowUnresolvedScreenState={allowUnresolvedScreenState} onChange={onChange} />
    {wrapper && <div className="binding-template-parameters">
      <div className="binding-section-heading"><h3>Template parameters</h3></div>
      <TemplateParameterOverrides key={`${component.id}:${parameterTemplate?.id || ""}`} template={parameterTemplate}
        parameters={component.props.parameters || {}} parentParameters={parameters} onChange={parameters => onChange({ parameters })} notify={notify}
        bindings={parameterBindings} bindingValues={Object.fromEntries(Object.entries(parameterResults).filter(([, result]) => result.value !== undefined).map(([name, result]) => [name, result.value!]))}
        bindingErrors={Object.fromEntries(Object.entries(parameterResults).filter(([, result]) => result.error).map(([name, result]) => [name, result.error!]))}
        onEditBinding={editParameterBinding} onRemoveBinding={removeParameterBinding} />
    </div>}
    <div className="binding-section-heading binding-custom-heading"><h3>Custom properties</h3><button type="button" className="button" disabled={Object.keys(custom).length >= 32} onClick={() => begin({ kind: "custom", name: "", type: "number", value: "0" })}>Add property</button></div>
    <p className="binding-note">{wrapper ? "Typed values belong to this wrapper and can drive its bindings. Child controls keep their own custom properties." : "Typed values belong to this component and can drive bindings."}</p>
    <div className="binding-custom-list">
      {Object.entries(custom).map(([name, property]) => <div className="binding-custom-row" key={name}>
        <div><strong>{name}</strong><small>{property.type} · {formatValue(property.value)}</small>{propertyUse(name).length > 0 && <small title={propertyUse(name).join("\n")}>Used by {propertyUse(name).length} binding{propertyUse(name).length === 1 ? "" : "s"}</small>}</div>
        <button type="button" aria-label={`Edit custom property ${name}`} onClick={() => begin({ kind: "custom", originalName: name, name, type: property.type, value: String(property.value) })}>Edit</button>
        <button type="button" className="binding-remove" aria-label={`Remove custom property ${name}`} disabled={propertyUse(name).length > 0} title={propertyUse(name).length ? "Update bindings that use this property before removing it." : undefined} onClick={() => { if (propertyUse(name).length) return; const next = { ...custom }; delete next[name]; onChange({ customProperties: next }); }}>Remove</button>
      </div>)}
      {!Object.keys(custom).length && <p className="binding-empty">No custom properties yet.</p>}
    </div>
    {draft && createPortal(<dialog ref={dialog} className="property-binding-dialog" aria-labelledby={`${id}-dialog-title`} onCancel={(event) => { event.preventDefault(); close(); }} onClose={close} onKeyDown={(event) => {
      // Draft shortcuts must not reach canvas history or project Save. Native text undo stays intact.
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); apply(); }
    }}>
      <div className="binding-dialog-heading"><div><h2 id={`${id}-dialog-title`}>{draft.kind === "parameter" ? `Bind parameter ${draft.target}` : (draft.kind === "binding" || draft.kind === "query") ? `Bind ${draft.target}` : draft.originalName ? "Edit custom property" : "Add custom property"}</h2><p>{componentName(component)}</p></div><button type="button" aria-label="Close property editor" onClick={close}>×</button></div>
      <div className="binding-dialog-body">
        {(draft.kind === "binding" || draft.kind === "query") && <label>Binding source<select aria-label="Property binding source" value={draft.kind} onChange={event => editBinding(draft.target, event.target.value as "binding" | "query")}><option value="binding">Expression</option><option value="query">Named query</option></select></label>}
        {draft.kind === "custom" ? <>
          <label>Name<input autoFocus aria-label="Custom property name" value={draft.name} maxLength={64} disabled={Boolean(draft.originalName && propertyUse(draft.originalName).length)} onChange={(event) => changeDraft({ ...draft, name: event.target.value })} placeholder="targetCount" /></label>
          <p className="binding-note">{draft.originalName && propertyUse(draft.originalName).length ? `Name is locked because these bindings use it: ${propertyUse(draft.originalName).join(", ")}. Update those references before renaming or removing this property.` : "Names are case sensitive, with up to 64 letters, numbers, or underscores."}</p>
          <label>Type<select aria-label="Custom property type" value={draft.type} onChange={(event) => { const type = event.target.value as CustomType; changeDraft({ ...draft, type, value: type === "boolean" ? "false" : type === "number" ? "0" : "" }); }}><option value="number">Number</option><option value="string">Text</option><option value="boolean">Boolean</option></select></label>
          <label>Value{draft.type === "boolean" ? <select aria-label="Custom property value" value={draft.value} onChange={(event) => changeDraft({ ...draft, value: event.target.value })}><option value="true">True</option><option value="false">False</option></select> : <input aria-label="Custom property value" inputMode={draft.type === "number" ? "decimal" : "text"} value={draft.value} onChange={(event) => changeDraft({ ...draft, value: event.target.value })} />}</label>
        </> : draft.kind === "query" ? <QueryPropertyBindingEditor key={`${component.id}:${draft.target}`} component={component} target={draft.target} context={context} queries={queries} allowUnresolvedScreenState={allowUnresolvedScreenState} onCancel={close} onApply={binding => { const nextBindings = { ...bindings }; delete nextBindings[draft.target]; onChange({ bindings: nextBindings, queryBindings: { ...queryBindings, [draft.target]: binding } }); close(); }} onRemove={queryBindings[draft.target] ? () => { const next = { ...queryBindings }; delete next[draft.target]; onChange({ queryBindings: next }); close(); } : undefined} /> : <>
          <label htmlFor={`${id}-expression`}>Expression</label>
          <textarea autoFocus id={`${id}-expression`} className="binding-expression" spellCheck={false} rows={3} value={draft.expression} onChange={(event) => changeDraft({ ...draft, expression: event.target.value })} maxLength={2048} />
          {draft.kind === "parameter" ? <p className="binding-note">Use named references from the containing form: parameters, custom properties, inputs, session state, screen state, or the containing template's private state. Password inputs and tags are unavailable. Supports arithmetic, comparisons, <code>&amp;&amp;</code>, <code>||</code>, <code>!</code>, and expressions such as <code>ready ? 'Running' : 'Stopped'</code>. The result is converted to this parameter's {ownEntry(parameterTemplate?.parameterTypes, draft.target) || "string"} type. Saved or query row values take precedence. The selected child template does not supply its own state, parameters or inputs to this binding.</p>
          : <p className="binding-note">Use reference names below, such as <code>count &gt; 0</code> or <code>ready ? 'Running' : 'Stopped'</code>. Supports arithmetic, comparisons, <code>&amp;&amp;</code>, <code>||</code>, and <code>!</code>. Text needs quotes; Enabled and Visible require true or false. Colors use quoted hex values, such as <code>'#2563eb'</code> (3, 4, 6, or 8 hex digits). Process values and limits require numbers, decimal places require a whole number from 0 to 6, and display flags require true or false.</p>}
          {isDrawingComponent(component.type) && <p className="binding-note">Drawing fill also accepts <code>'none'</code>. Stroke width requires a number from 1 to 32, rotation from 0 to 360, and Active, Flowing, and Reverse flow require true or false.</p>}
          <BindingReferencesEditor rows={draft.rows} onChange={rows => changeDraft({ ...draft, rows })} component={component} components={components} parameters={parameters} inputKeys={inputKeys} tags={tags} state={state} parameterMode={draft.kind === "parameter"} allowUnresolvedScreenState={allowUnresolvedScreenState} />
          <div className={`binding-preview${previewError && !deferredScreenPreview ? " has-error" : ""}`} role="status" aria-live="polite"><strong>Live preview</strong><output>{previewError || formatValue(draft.kind === "parameter" ? parameterPreview?.value : preview && propertyValue(preview.component, draft.target))}</output>{!definitionError && previewError && <p>{deferredScreenPreview ? "Apply saves this binding for its containing screen or popup. Each placement must declare compatible screen state before the project can be published." : <>This expression can be saved, but its current result is invalid. Review the expression and source data. {draft.kind === "parameter" ? "The template's controls are unavailable while its parameters cannot be resolved." : "The property uses a safe fallback while evaluation fails."}</>}</p>}</div>
        </>}
        {applyError && <p className="binding-apply-error" role="alert">{applyError}</p>}
      </div>
      {draft.kind !== "query" && <div className="binding-dialog-footer">{draft.kind === "parameter" && ownEntry(parameterBindings, draft.target) && <button type="button" className="button binding-remove" onClick={() => { removeParameterBinding(draft.target); close(); }}>Remove binding</button>}{draft.kind === "binding" && bindings[draft.target] && <button type="button" className="button binding-remove" onClick={() => { const next = { ...bindings }; delete next[draft.target]; onChange({ bindings: next }); close(); }}>Remove binding</button>}<button type="button" className="button" onClick={close}>Cancel</button><button type="button" className="button primary" onClick={apply}>Apply</button></div>}
    </dialog>, document.body)}
  </section>;
}
