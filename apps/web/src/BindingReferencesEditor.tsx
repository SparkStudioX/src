import { useId, useRef } from "react";
import type { BindingReference, CanvasComponent, RuntimeParameters, RuntimeStateValues, Tag } from "./types";

export type ReferenceRow = { id: number; name: string; reference: BindingReference };
export type ExpressionDraft = { expression: string; rows: ReferenceRow[] };
export const expressionDraft = (binding: import("./types").PropertyBinding): ExpressionDraft => ({ expression: binding.expression, rows: Object.entries(binding.references || {}).map(([name, reference], id) => ({ id, name, reference: { ...reference } })) });
export const expressionBinding = (draft: ExpressionDraft): import("./types").PropertyBinding => ({ expression: draft.expression, references: Object.fromEntries(draft.rows.map(row => [row.name, row.reference])) });
export function referenceRowsError(rows: ReferenceRow[]): string | undefined {
  if (rows.some(row => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(row.name) || ["true", "false", "null", "__proto__", "prototype", "constructor"].includes(row.name))) return "Give each reference a name of 1–64 letters, numbers, or underscores. Start with a letter or underscore; reserved names are unavailable.";
  if (new Set(rows.map(row => row.name)).size !== rows.length) return "Reference names must be unique.";
  return undefined;
}
export function BindingReferencesEditor({ rows, onChange, component, components, parameters, inputKeys, tags = [], state, parameterMode = false, allowTags = !parameterMode, allowUnresolvedScreenState = false, prefix = "" }: {
  rows: ReferenceRow[]; onChange: (rows: ReferenceRow[]) => void; component: CanvasComponent; components: CanvasComponent[]; parameters: RuntimeParameters; inputKeys: string[]; tags?: Tag[]; state?: RuntimeStateValues; parameterMode?: boolean; allowTags?: boolean; allowUnresolvedScreenState?: boolean; prefix?: string;
}) {
  const id = useId(), referenceId = useRef(0);
  referenceId.current = Math.max(referenceId.current, ...rows.map(row => row.id + 1));
  const custom = component.props.customProperties || {}, customComponents = [component, ...components.filter(item => item.id !== component.id)];
  const sessionState = state?.session || {}, screenState = state?.screen || {}, instanceState = state?.instance;
  function componentName(item: CanvasComponent) { return `${item.props.text || item.type} · ${item.id}`; }
  function referenceFor(kind: BindingReference["kind"]): BindingReference {
    if (kind === "custom") return { kind, key: Object.keys(custom)[0] || "" };
    if (kind === "input") return { kind, key: inputKeys[0] || "" };
    if (kind === "parameter") return { kind, key: Object.keys(parameters)[0] || "" };
    if (kind === "sessionState") return { kind, key: Object.keys(sessionState)[0] || "" };
    if (kind === "screenState") return { kind, key: Object.keys(screenState)[0] || "" };
    if (kind === "instanceState") return { kind, key: Object.keys(instanceState || {})[0] || "" };
    return { kind: "tag", path: tags[0]?.path || "" };
  }
  function changeRow(rowId: number, patch: Partial<ReferenceRow>) { onChange(rows.map(row => row.id === rowId ? { ...row, ...patch } : row)); }
  return <>
          <div className="binding-reference-heading"><h3>Named references</h3><button type="button" className="button" aria-label={prefix ? `${prefix}Add reference` : undefined} disabled={rows.length >= 32} onClick={() => { let name = "value"; let number = 2; while (rows.some((row) => row.name === name)) name = `value${number++}`; onChange([...rows, { id: referenceId.current++, name, reference: referenceFor(Object.keys(custom).length ? "custom" : inputKeys.length ? "input" : Object.keys(parameters).length || parameterMode ? "parameter" : "tag") }]); }}>Add reference</button></div>
          {!rows.length && <p className="binding-empty">Add a reference to use a live value in the expression.</p>}
          <div className="binding-reference-list">{rows.map((row, index) => {
            const reference = row.reference;
            const sourceComponent = reference.kind === "custom" ? customComponents.find((item) => item.id === (reference.componentId || component.id)) : undefined;
            const propertyKeys = Object.keys(sourceComponent?.props.customProperties || {});
            const listId = `${id}-ref-${row.id}`;
            const tagSuggestions: Tag[] = [];
            let matchingTags = 0;
            if (reference.kind === "tag") {
              const needle = reference.path.toLowerCase();
              for (const tag of tags) if (tag.path.toLowerCase().includes(needle)) {
                matchingTags++; if (tagSuggestions.length < 200) tagSuggestions.push(tag);
              }
            }
            return <fieldset className="binding-reference" key={row.id}><legend>Reference {index + 1}</legend>
              <div className="binding-reference-top"><label>Name<input aria-label={`${prefix}Reference ${index + 1} name`} value={row.name} maxLength={64} onChange={(event) => changeRow(row.id, { name: event.target.value })} /></label><label>Source<select aria-label={`${prefix}Reference ${index + 1} source`} value={reference.kind} onChange={(event) => changeRow(row.id, { reference: referenceFor(event.target.value as BindingReference["kind"]) })}><option value="custom">Custom property</option><option value="input">Form input</option><option value="parameter">Parameter</option><option value="sessionState">Session state</option><option value="screenState">Screen state</option>{instanceState !== undefined && <option value="instanceState">Private instance state</option>}{allowTags && <option value="tag">Tag</option>}{!allowTags && reference.kind === "tag" && <option value="tag" disabled>Unsupported: tag</option>}{instanceState === undefined && reference.kind === "instanceState" && <option value="instanceState" disabled>Unavailable: private instance state</option>}</select></label><button type="button" className="binding-remove" aria-label={`${prefix}Remove reference ${index + 1}`} onClick={() => onChange(rows.filter((item) => item.id !== row.id))}>Remove</button></div>
              {reference.kind === "custom" ? <div className="binding-reference-source"><label>Component<select aria-label={`${prefix}Reference ${index + 1} component`} value={reference.componentId || ""} onChange={(event) => { const selected = customComponents.find((item) => item.id === (event.target.value || component.id)); changeRow(row.id, { reference: { kind: "custom", ...(event.target.value ? { componentId: event.target.value } : {}), key: Object.keys(selected?.props.customProperties || {})[0] || "" } }); }}><option value="">This component</option>{components.filter((item) => item.id !== component.id).map((item) => <option key={item.id} value={item.id}>{componentName(item)}</option>)}{reference.componentId && !components.some((item) => item.id === reference.componentId) && <option value={reference.componentId}>Missing: {reference.componentId}</option>}</select></label><label>Property<select aria-label={`${prefix}Reference ${index + 1} custom property`} value={reference.key} onChange={(event) => changeRow(row.id, { reference: { ...reference, key: event.target.value } })}><option value="">Choose a property</option>{propertyKeys.map((key) => <option key={key} value={key}>{key} ({sourceComponent?.props.customProperties?.[key].type})</option>)}{reference.key && !propertyKeys.includes(reference.key) && <option value={reference.key}>Missing: {reference.key}</option>}</select></label></div>
              : reference.kind === "input" ? <label>Input key<input aria-label={`${prefix}Reference ${index + 1} input key`} list={listId} value={reference.key} onChange={(event) => changeRow(row.id, { reference: { ...reference, key: event.target.value } })} /><datalist id={listId}>{inputKeys.map((key) => <option key={key} value={key} />)}</datalist></label>
              : reference.kind === "parameter" ? <label>Parameter name<input aria-label={`${prefix}Reference ${index + 1} parameter name`} list={listId} value={reference.key} onChange={(event) => changeRow(row.id, { reference: { ...reference, key: event.target.value } })} /><datalist id={listId}>{Object.keys(parameters).map((key) => <option key={key} value={key} />)}</datalist></label>
              : reference.kind === "sessionState" || reference.kind === "screenState" || reference.kind === "instanceState" ? <>
                <label>{reference.kind === "instanceState" ? "Private instance" : reference.kind === "sessionState" ? "Session" : "Screen"} property
                  <input aria-label={`${prefix}Reference ${index + 1} state property`} list={listId} maxLength={64} value={reference.key} onChange={event => changeRow(row.id, { reference: { ...reference, key: event.target.value } })} />
                  <datalist id={listId}>{Object.entries(reference.kind === "instanceState" ? instanceState || {} : reference.kind === "sessionState" ? sessionState : screenState).map(([key, value]) => <option key={key} value={key}>{typeof value}</option>)}</datalist>
                </label>
                <p className="binding-note">{reference.kind === "instanceState" ? parameterMode ? "Declared on the containing shared template's property sheet. Each placement and repeater row owns separate private values." : "Declared on this shared template's property sheet. Every placement and repeater row owns separate private values; nested templates do not inherit them." : reference.kind === "sessionState" ? "Declared in Project settings. Shared across this project's screens in one browser tab." : allowUnresolvedScreenState ? "Enter a state property declared by every screen or popup that uses this template. Its containing screen supplies the value; publication validates each placement." : "Declared in this screen's property sheet. Each open screen or popup has its own values."}</p>
              </>
              : <label>Tag path<input aria-label={`${prefix}Reference ${index + 1} tag path`} list={listId} value={reference.path} onChange={(event) => changeRow(row.id, { reference: { ...reference, path: event.target.value } })} placeholder="[default]Area/Value" /><datalist id={listId}>{tagSuggestions.map((tag) => <option key={tag.path} value={tag.path} />)}</datalist>
                {matchingTags > tagSuggestions.length && <small className="binding-note">Showing {tagSuggestions.length} of {matchingTags.toLocaleString()} matching tags. Type more of the path to refine suggestions, or enter the full path.</small>}
              </label>}
            </fieldset>;
          })}</div>
  </>;
}
