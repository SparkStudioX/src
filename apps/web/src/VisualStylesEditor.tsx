import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import type { CanvasComponent, Project, VisualStyle, VisualStyleProperty } from "./types";
import { styleReferences, validateProjectStyles, validateVisualStyles, visualStyleLabels, visualStyleProperties, visualStyleSource } from "./visualStyles";
import "./visualStyles.css";

export function ComponentStyleAssignment({ component, styles = [], onChange, onManage }: {
  component: CanvasComponent; styles?: VisualStyle[]; onChange: (patch: CanvasComponent["props"]) => void; onManage: () => void;
}) {
  const fieldId = useId();
  const style = styles.find(item => item.id === component.props.styleId);
  return <div className="inspector-section visual-style-assignment">
    <h3>Visual style</h3>
    <div className="property-sheet-row" data-property="styleId"><label htmlFor={fieldId}>Assigned style</label><div className="property-sheet-value"><select id={fieldId} value={component.props.styleId ?? ""} onChange={event => onChange({ styleId: event.target.value || undefined })}>
      <option value="">None (local / theme)</option>
      {component.props.styleId && !style && <option value={component.props.styleId}>Missing style</option>}
      {styles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></div><span aria-hidden="true" /></div>
    <div className="property-sheet-row"><label>Style definitions</label><div className="property-sheet-value"><button className="button" type="button" onClick={onManage}>Manage visual styles</button></div><span aria-hidden="true" /></div>
    <div className="property-sheet-row" data-property="appearanceSources"><label>Appearance</label><div className="property-sheet-value"><details className="property-structured-editor"><summary>Appearance sources</summary>
      <p>Bindings override local values, then the assigned style, then parent or theme defaults. Clear a local override to use its style value.</p>
      <table><thead><tr><th>Property</th><th>Source / authored value</th><th /></tr></thead><tbody>
        {visualStyleProperties.map(key => <tr key={key}><th>{visualStyleLabels[key]}</th><td>{visualStyleSource(component, style, key)}<small>{component.props.bindings?.[key] || component.props.queryBindings?.[key] ? "Evaluated at runtime" : String(component.props[key] ?? style?.properties[key] ?? "Inherited")}</small></td><td>
          {component.props[key] !== undefined && <button type="button" title={`Clear local ${visualStyleLabels[key].toLowerCase()} override`} aria-label={`Clear local ${visualStyleLabels[key].toLowerCase()} override`} onClick={() => onChange({ [key]: undefined })}>Clear</button>}
        </td></tr>)}
      </tbody></table>
    </details></div><span aria-hidden="true" /></div>
  </div>;
}

export default function VisualStylesEditor({ project, onApply, onClose }: {
  project: Project; onApply: (styles: VisualStyle[], expectedSnapshot: string) => void; onClose: () => void;
}) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null);
  const snapshot = useRef(JSON.stringify(project));
  const [styles, setStyles] = useState<VisualStyle[]>(() => structuredClone(project.styles ?? []));
  const [selectedId, setSelectedId] = useState(styles[0]?.id ?? "");
  const [error, setError] = useState("");
  const selected = styles.find(item => item.id === selectedId);
  const references = selected ? styleReferences(project, selected.id) : [];
  let validation = "";
  try { validateProjectStyles({ ...project, styles }); } catch (cause) { validation = cause instanceof Error ? cause.message : "Invalid styles."; }
  let previewStyle: CSSProperties = {};
  if (selected) {
    try {
      validateVisualStyles([selected]);
      previewStyle = { backgroundColor: selected.properties.backgroundColor, color: selected.properties.foregroundColor,
        borderColor: selected.properties.borderColor, borderWidth: selected.properties.borderWidth, borderStyle: "solid", fontSize: selected.properties.fontSize,
        "--visual-preview-accent": selected.properties.color ?? "var(--accent)" } as CSSProperties;
    } catch { /* Keep invalid authored colors out of the preview; show the validation below. */ }
  }
  useEffect(() => {
    const element = dialog.current, previousFocus = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, []);
  function patchStyle(patch: Partial<VisualStyle>) { setStyles(current => current.map(style => style.id === selectedId ? { ...style, ...patch } : style)); setError(""); }
  function setProperty(key: VisualStyleProperty, value: string) {
    if (!selected) return;
    const properties = { ...selected.properties };
    if (!value) delete properties[key];
    else Object.assign(properties, { [key]: key === "fontSize" || key === "borderWidth" ? Number(value) : value });
    patchStyle({ properties });
  }
  return createPortal(<dialog ref={dialog} className="visual-styles-dialog" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && ["s", "z", "y"].includes(event.key.toLowerCase())) event.preventDefault(); }}>
    <header><div><h2 id={`${id}-title`}>Project visual styles</h2><p>Reusable appearance shared by screens, templates and their instances.</p></div><button type="button" aria-label="Close visual styles" onClick={onClose}>×</button></header>
    <div className="visual-styles-body"><nav aria-label="Visual styles">
      <button type="button" className="button" disabled={styles.length >= 100} onClick={() => { const style: VisualStyle = { id: `style-${crypto.randomUUID().slice(0, 12)}`, name: "New style", properties: { color: "#5974c7" } }; setStyles(current => [...current, style]); setSelectedId(style.id); setError(""); }}>Add style</button>
      {styles.map(style => <button key={style.id} type="button" aria-pressed={selectedId === style.id} onClick={() => setSelectedId(style.id)}>{style.name || "Unnamed style"}</button>)}
    </nav><section>
      {selected ? <>
        <label>Style name<input value={selected.name} maxLength={80} onChange={event => patchStyle({ name: event.target.value })} /></label>
        <small>Stable ID: <code>{selected.id}</code></small>
        <div className="visual-style-fields">{visualStyleProperties.map(key => <label key={key}>{visualStyleLabels[key]}
          <input type={key === "fontSize" || key === "borderWidth" ? "number" : "text"} value={selected.properties[key] ?? ""} placeholder={key === "fontSize" || key === "borderWidth" ? "Inherit" : "#RRGGBB or inherit"}
            min={key === "fontSize" ? 1 : 0} max={key === "fontSize" ? 256 : 32} step="any" maxLength={9} onChange={event => setProperty(key, event.target.value)} />
        </label>)}</div>
        <div className="visual-style-preview" style={previewStyle}><strong>Style preview</strong><p>Sample appearance; component-local overrides and bindings retain precedence.</p><span>Accent</span></div>
        <details open={references.length > 0}><summary>{references.length} component assignment{references.length === 1 ? "" : "s"}</summary><ul>{references.map(ref => <li key={`${ref.documentId}/${ref.componentId}`}>{ref.label}</li>)}</ul></details>
        <button type="button" className="button danger" disabled={references.length > 0} onClick={() => { const next = styles.filter(style => style.id !== selected.id); setStyles(next); setSelectedId(next[0]?.id ?? ""); setError(""); }}>Delete style</button>
        {references.length > 0 && <p>Remove the listed component assignments before deleting this style.</p>}
      </> : <p>Add a style, then assign it from a component’s property sheet.</p>}
    </section></div>
    <footer><p>Appearance only. Existing binding and communication errors remain visible. Save and Publish remain separate.</p>
      {(validation || error) && <p role="alert">{error || validation}</p>}
      <div><button type="button" className="button" onClick={onClose}>Cancel</button><button type="button" className="button primary" disabled={Boolean(validation || error)} onClick={() => { try { onApply(styles, snapshot.current); } catch (cause) { setError(cause instanceof Error ? cause.message : "Styles could not be applied."); } }}>Apply styles</button></div>
    </footer>
  </dialog>, document.body);
}
