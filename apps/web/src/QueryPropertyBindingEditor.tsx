import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { isInput } from "./inputs";
import { BindingReferencesEditor, expressionBinding, expressionDraft, referenceRowsError, type ExpressionDraft } from "./BindingReferencesEditor";
import type { BindingContext } from "./propertyBindings";
import { loadQueryProperty, resolveQueryPropertyParameters, validateQueryPropertyBinding } from "./queryPropertyModel";
import type { BindingTarget, CanvasComponent, NamedQuery, QueryPropertyBinding } from "./types";

interface Props {
  component: CanvasComponent;
  target: BindingTarget;
  context: BindingContext;
  queries: NamedQuery[];
  allowUnresolvedScreenState?: boolean;
  onApply: (binding: QueryPropertyBinding) => void;
  onRemove?: () => void;
  onCancel: () => void;
}
const own = <T,>(map: Record<string, T> | undefined, key: string) => map && Object.hasOwn(map, key) ? map[key] : undefined;
const describe = (value: unknown) => value === undefined ? "Not run" : JSON.stringify(value);

/** A draft query never executes until Run preview. Apply commits one parent history entry. */
export function QueryPropertyBindingEditor({ component, target, context, queries, allowUnresolvedScreenState = false, onApply, onRemove, onCancel }: Props) {
  const saved = component.props.queryBindings?.[target];
  const [source, setSource] = useState<QueryPropertyBinding>(() => saved ? structuredClone(saved) : { queryId: "", column: "" });
  const [mappings, setMappings] = useState<Record<string, ExpressionDraft>>(() => Object.fromEntries(Object.entries(saved?.parameters || {}).map(([key, value]) => [key, expressionDraft(value)])));
  const [applyError, setApplyError] = useState("");
  const [preview, setPreview] = useState<{ key: string; value?: string | number | boolean; error?: string; durationMs?: number; parameters?: Record<string, unknown>; busy?: boolean } | null>(null);
  const controller = useRef<AbortController | null>(null), generation = useRef(0), currentKey = useRef("");
  const query = queries.find(item => item.id === source.queryId);
  const binding: QueryPropertyBinding = { ...source, ...(Object.keys(mappings).length ? { parameters: Object.fromEntries(Object.entries(mappings).map(([name, draft]) => [name, expressionBinding(draft)])) } : { parameters: undefined }) };
  // The dialog can replace an expression; persisted definitions never contain both modes.
  const expressionBindings = { ...component.props.bindings }; delete expressionBindings[target];
  const draftComponent = { ...component, props: { ...component.props, bindings: expressionBindings } };
  const rowError = Object.entries(mappings).map(([name, draft]) => { const error = referenceRowsError(draft.rows); return error ? `${name}: ${error}` : undefined; }).find(Boolean);
  const definitionError = rowError || validateQueryPropertyBinding(binding, target, draftComponent, context, queries, allowUnresolvedScreenState);
  const deferred = allowUnresolvedScreenState && Object.values(binding.parameters || {}).some(parameter => Object.values(parameter.references || {}).some(reference => reference.kind === "screenState" && !Object.hasOwn(context.state?.screen || {}, reference.key)));
  // Only declared mapping sources affect this read. Gateway tag samples and
  // unrelated form edits must not abort or erase an explicit preview.
  const dependencies = Object.values(binding.parameters || {}).flatMap(parameter => Object.values(parameter.references || {}).map(reference => {
    if (reference.kind === "custom") {
      const owner = reference.componentId && reference.componentId !== component.id ? context.components.find(item => item.id === reference.componentId) : component;
      return [reference, Boolean(owner), own(owner?.props.customProperties, reference.key)];
    }
    if (reference.kind === "input") return [reference, own(context.inputs, reference.key), context.components.filter(item => isInput(item.type) && (item.props.fieldKey || item.id) === reference.key)];
    if (reference.kind === "parameter") return [reference, own(context.parameters, reference.key)];
    if (reference.kind === "sessionState" || reference.kind === "screenState" || reference.kind === "instanceState") {
      const scope = reference.kind === "sessionState" ? context.state?.session : reference.kind === "screenState" ? context.state?.screen : context.state?.instance;
      return [reference, own(scope, reference.key)];
    }
    return [reference]; // Unsupported sources are reported by definitionError.
  }));
  const key = JSON.stringify([binding, target, component.id, component.type, query, definitionError, deferred, Boolean(context.communicationLost), dependencies,
    component.props.min, component.props.max, component.props.bindings?.min, component.props.bindings?.max, component.props.queryBindings?.min, component.props.queryBindings?.max]);
  currentKey.current = key;
  const visiblePreview = preview?.key === key ? preview : null;
  useEffect(() => { controller.current?.abort(); generation.current++; return () => { controller.current?.abort(); generation.current++; }; }, [key]);
  function changeSource(patch: Partial<QueryPropertyBinding>) { setApplyError(""); setSource(value => ({ ...value, ...patch })); }
  function changeMapping(name: string, draft: ExpressionDraft | undefined) {
    setApplyError(""); setMappings(values => draft ? { ...values, [name]: draft } : Object.fromEntries(Object.entries(values).filter(([key]) => key !== name)));
  }
  async function runPreview() {
    if (definitionError || deferred || context.communicationLost) return;
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    const run = ++generation.current, requestedKey = key, started = performance.now();
    setPreview({ key, busy: true });
    try {
      const parameters = resolveQueryPropertyParameters(binding, draftComponent, context);
      const value = await loadQueryProperty(binding, target, draftComponent, context, "designer", api, undefined, request.signal);
      if (!request.signal.aborted && generation.current === run && currentKey.current === requestedKey)
        setPreview({ key: requestedKey, value, parameters, durationMs: Math.round(performance.now() - started) });
    } catch (reason) {
      if (!request.signal.aborted && generation.current === run && currentKey.current === requestedKey)
        setPreview({ key: requestedKey, error: reason instanceof Error ? reason.message : "Query preview failed." });
    }
  }
  function apply() {
    if (definitionError) { setApplyError(definitionError); return; }
    onApply(binding);
  }
  const inputKeys = [...new Set(context.components.filter(item => isInput(item.type) && item.type !== "passwordInput").map(item => item.props.fieldKey || item.id))];
  const parameterNames = [...new Set([...(query?.parameters || []).map(parameter => parameter.name), ...Object.keys(mappings)])];
  return <div className="query-property-editor" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); apply(); }
  }}>
    <label>Named query<select aria-label="Property named query" value={source.queryId} onChange={event => changeSource({ queryId: event.target.value })}>
      <option value="">Choose a saved read query…</option>
      {queries.filter(item => item.kind !== "update").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      {source.queryId && (!query || query.kind === "update") && <option value={source.queryId} disabled>{query ? "Unavailable update query" : "Missing query"}: {query?.name || source.queryId}</option>}
    </select></label>
    <label>Result column<input aria-label="Property query result column" maxLength={128} value={source.column} onChange={event => changeSource({ column: event.target.value })} placeholder="total" /></label>
    <p className="binding-note">The query must return exactly one row. The selected column must contain a scalar, and its result expression must be compatible with <strong>{target}</strong>; empty results, multiple rows, null and invalid types are unavailable. Define SQL and connections in Named queries.</p>
    <label>Result expression<textarea aria-label="Property query result expression" className="binding-expression" rows={2} maxLength={2048} spellCheck={false} value={source.transform ?? "value"} onChange={event => changeSource({ transform: event.target.value })} /></label>
    <p className="binding-note">Use the single reference <code>value</code> for the selected cell. For example, <code>value &gt; 0</code> converts a numeric status to Boolean, and <code>value * 0.02</code> scales a number. The final result must match this property; other references are unavailable.</p>
    <label>Refresh<select aria-label="Property query refresh" value={source.refresh?.mode || "onChange"} onChange={event => changeSource({ refresh: event.target.value === "poll" ? { mode: "poll", intervalMs: 10000 } : { mode: "onChange" } })}>
      <option value="onChange">When parameters change</option><option value="poll">When parameters change and periodically</option>
    </select></label>
    {source.refresh?.mode === "poll" && <label>Polling interval (milliseconds)<input aria-label="Property query polling interval" type="number" min={1000} max={3600000} step={1} value={source.refresh.intervalMs ?? ""} onChange={event => changeSource({ refresh: { mode: "poll", intervalMs: event.target.value ? Number(event.target.value) : undefined } })} /></label>}
    <p className="binding-note">The application loads once and refreshes when mapped parameters change. Polling adds a bounded interval from 1 second to 1 hour. This editor runs only when you choose Run preview.</p>
    <h3>Query parameters</h3>
    {!parameterNames.length && <p className="binding-empty">{query ? "This query has no declared parameters." : "Choose a query to configure its parameters."}</p>}
    {parameterNames.map(name => {
      const declaration = query?.parameters.find(parameter => parameter.name === name), mapping = own(mappings, name);
      return <fieldset key={name} className="query-parameter-mapping"><legend>{name}{declaration ? ` · ${declaration.type || "string"}` : " · Not declared by this query"}</legend>
        <label>Value source<select aria-label={`Query parameter ${name} value source`} value={mapping ? "expression" : "default"} onChange={event => changeMapping(name, event.target.value === "default" ? undefined : expressionDraft({ expression: JSON.stringify(declaration?.defaultValue ?? ""), references: {} }))}>
          <option value="default">Query default{declaration ? `: ${describe(declaration.defaultValue)}` : " / remove mapping"}</option><option value="expression">Expression</option>
        </select></label>
        {mapping && <>
          <label>Expression<textarea aria-label={`Query parameter ${name} expression`} className="binding-expression" rows={2} maxLength={2048} spellCheck={false} value={mapping.expression} onChange={event => changeMapping(name, { ...mapping, expression: event.target.value })} /></label>
          <BindingReferencesEditor rows={mapping.rows} onChange={rows => changeMapping(name, { ...mapping, rows })} component={component} components={context.components} parameters={context.parameters} inputKeys={inputKeys} state={context.state} parameterMode allowUnresolvedScreenState={allowUnresolvedScreenState} prefix={`Query parameter ${name} `} />
        </>}
      </fieldset>;
    })}
    {parameterNames.length > 0 && <p className="binding-note">Omitted mappings use the saved query defaults. Expressions read the immediately containing form's parameters, non-password inputs, custom properties and declared state. Tags and other query results cannot be references. Values are query data, never identity or permissions.</p>}
    <div className={`binding-preview${definitionError || visiblePreview?.error ? " has-error" : ""}`} role="status" aria-live="polite">
      <strong>Query preview</strong><output>{definitionError || (deferred ? "Preview unavailable until a containing screen supplies the referenced state." : visiblePreview?.busy ? "Running query…" : visiblePreview?.error || (visiblePreview ? `${typeof visiblePreview.value} · ${describe(visiblePreview.value)}` : "Choose Run preview to read the query."))}</output>
      {visiblePreview?.parameters && <small>Mapped parameters: {JSON.stringify(visiblePreview.parameters)} · {visiblePreview.durationMs} ms</small>}
      {deferred && !definitionError && <p>Apply saves the mapping. Publication validates state declarations at each concrete placement.</p>}
      {context.communicationLost && <p>The gateway is disconnected. The definition can still be edited.</p>}
      <button type="button" className="button" disabled={Boolean(definitionError || deferred || visiblePreview?.busy || context.communicationLost)} onClick={() => void runPreview()}>Run preview</button>
    </div>
    {applyError && <p className="binding-apply-error" role="alert">{applyError}</p>}
    <div className="binding-dialog-footer query-binding-footer">{onRemove && <button type="button" className="button binding-remove" onClick={onRemove}>Remove binding</button>}<button type="button" className="button" onClick={onCancel}>Cancel</button><button type="button" className="button primary" onClick={apply}>Apply</button></div>
  </div>;
}
