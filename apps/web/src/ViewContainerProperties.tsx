import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import type { CanvasComponent, Template } from "./types";
import { PropertyCollectionDialog } from "./PropertyCollectionEditor";
import { defaultViewLayout, viewLayoutError, viewLayoutKinds } from "./viewContainers";
import type { ViewLayout, ViewLayoutKind, ViewPane } from "./viewContainers";
import { coerceTemplateParameter, templateExpansion, templatePlacementError } from "./templateModel";

function Row({ name, label, children }: { name: string; label: string; children: ReactNode }) {
  return <div className="property-sheet-row" data-property={`viewLayout.${name}`}><label>{label}</label><div className="property-sheet-value">{children}</div><span aria-hidden="true" /></div>;
}
export default function ViewContainerProperties({ component, templates, parentTemplateId, onChange }: {
  component: CanvasComponent; templates: Template[]; parentTemplateId?: string; onChange: (patch: Partial<CanvasComponent["props"]>) => void;
}) {
  const [draft, setDraft] = useState<ViewLayout>(() => structuredClone(component.props.viewLayout ?? defaultViewLayout("embedded", templates[0]?.id)));
  const [open, setOpen] = useState(false), [error, setError] = useState("");
  const id = useId();
  const reset = () => { setDraft(structuredClone(component.props.viewLayout ?? defaultViewLayout("embedded", templates[0]?.id))); setError(""); };
  useEffect(() => { reset(); setOpen(false); }, [component.id, component.props.viewLayout]);
  function updatePane(index: number, patch: Partial<ViewPane>) { setDraft(previous => ({ ...previous, panes: previous.panes.map((pane, at) => at === index ? { ...pane, ...patch } : pane) })); setError(""); }
  function apply() {
    try {
      const problem = viewLayoutError(draft, templates); if (problem) throw new Error(problem);
      for (const pane of draft.panes) {
        const placement = templatePlacementError(templates, parentTemplateId, pane.templateId); if (placement) throw new Error(placement);
        const template = templates.find(item => item.id === pane.templateId)!;
        for (const [name, value] of Object.entries(pane.parameters ?? {})) if (!value.includes("{")) coerceTemplateParameter(name, value, template.parameterTypes?.[name]);
      }
      const next = { ...component, props: { ...component.props, viewLayout: draft } };
      const graph = templateExpansion([next], templates, parentTemplateId ? [parentTemplateId] : []); if (graph.error) throw new Error(graph.error);
      onChange({ viewLayout: structuredClone(draft) }); setError(""); setOpen(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <section className="property-sheet-group" aria-label="View container properties"><h4>View container</h4>
    <Row name="kind" label="Layout"><select aria-label="Container layout" value={draft.kind} onChange={event => { setDraft(defaultViewLayout(event.target.value as ViewLayoutKind, draft.panes[0]?.templateId ?? templates[0]?.id)); setError(""); }}>{viewLayoutKinds.map(kind => <option key={kind} value={kind}>{({ embedded: "Embedded view", tabs: "Tabbed views", split: "Split panes", dock: "Docked panels" })[kind]}</option>)}</select></Row>
    {draft.kind === "tabs" && <Row name="initialPaneId" label="Initial tab"><select aria-label="Initial tab" value={draft.initialPaneId ?? draft.panes[0]?.id} onChange={event => setDraft({ ...draft, initialPaneId: event.target.value })}>{draft.panes.map(pane => <option key={pane.id} value={pane.id}>{pane.label}</option>)}</select></Row>}
    {draft.kind === "split" && <><Row name="orientation" label="Direction"><select aria-label="Split direction" value={draft.orientation ?? "horizontal"} onChange={event => setDraft({ ...draft, orientation: event.target.value as ViewLayout["orientation"] })}><option value="horizontal">Side by side</option><option value="vertical">Top and bottom</option></select></Row><Row name="ratio" label="Initial split (%)"><input aria-label="Initial split percent" type="number" min={10} max={90} value={draft.ratio ?? 50} onChange={event => setDraft({ ...draft, ratio: Number(event.target.value) })} /></Row></>}
    <Row name="panes" label="Panes"><div className="property-collection-value"><span>{draft.panes.length} views</span><button type="button" className="button" onClick={() => setOpen(true)}>Edit panes</button></div></Row>
    <p className="binding-note">Pane IDs keep forms independent. Changing layout kind starts a new draft. Apply saves one undo step; operator tab, size and visibility changes stay local.</p>
    {error && <p className="property-sheet-error" role="alert">{error}</p>}
    <div className="property-sheet-actions"><button type="button" className="button" onClick={apply}>Apply container</button><button type="button" className="button" onClick={reset}>Cancel</button></div>
    {open && <PropertyCollectionDialog title="Container panes" onClose={() => setOpen(false)}><p>Each pane references a shared template. Values and private state are independent and retained while its tab or dock is hidden. Parameter overrides use saved text and parent references.</p>
      {draft.panes.map((pane, index) => { const template = templates.find(item => item.id === pane.templateId); return <fieldset key={index}><legend>Pane {index + 1}</legend>
        <label htmlFor={`${id}-${index}-id`}>Stable ID</label><input id={`${id}-${index}-id`} aria-label={`Pane ${index + 1} ID`} value={pane.id} maxLength={64} onChange={event => updatePane(index, { id: event.target.value })} />
        <label>Label<input aria-label={`Pane ${index + 1} label`} value={pane.label} maxLength={120} onChange={event => updatePane(index, { label: event.target.value })} /></label>
        <label>Template<select aria-label={`Pane ${index + 1} template`} value={pane.templateId} onChange={event => updatePane(index, { templateId: event.target.value, parameters: {} })}><option value="">Choose template…</option>{templates.map(item => <option key={item.id} value={item.id} disabled={Boolean(templatePlacementError(templates, parentTemplateId, item.id))}>{item.name}</option>)}</select></label>
        {draft.kind === "dock" && <><label>Edge<select aria-label={`Pane ${index + 1} dock edge`} value={pane.edge ?? "right"} onChange={event => updatePane(index, { edge: event.target.value as ViewPane["edge"], ...(event.target.value === "center" ? { size: undefined, initiallyOpen: undefined } : {}) })}>{["center", "left", "right", "top", "bottom"].map(edge => <option key={edge} value={edge}>{edge}</option>)}</select></label>{pane.edge !== "center" && <><label>Initial size (px)<input aria-label={`Pane ${index + 1} size`} type="number" min={80} max={1600} value={pane.size ?? 220} onChange={event => updatePane(index, { size: Number(event.target.value) })} /></label><label><input aria-label={`Pane ${index + 1} initially open`} type="checkbox" checked={pane.initiallyOpen !== false} onChange={event => updatePane(index, { initiallyOpen: event.target.checked })} />Initially open</label></>}</>}
        {template && Object.entries(template.parameters).map(([name, value]) => { const overridden = Object.hasOwn(pane.parameters ?? {}, name); return <div key={name}><label><input type="checkbox" aria-label={`Pane ${index + 1} override ${name}`} checked={overridden} onChange={event => { const parameters = { ...pane.parameters }; if (event.target.checked) parameters[name] = value; else delete parameters[name]; updatePane(index, { parameters }); }} />Override {name}</label><input aria-label={`Pane ${index + 1} parameter ${name}`} disabled={!overridden} placeholder={value || "Template default"} value={overridden ? pane.parameters![name] : value} onChange={event => updatePane(index, { parameters: { ...pane.parameters, [name]: event.target.value } })} /></div>; })}
        {(draft.kind === "tabs" || draft.kind === "dock") && <button type="button" className="button" disabled={draft.panes.length <= 1} onClick={() => setDraft({ ...draft, panes: draft.panes.filter((_, at) => at !== index), ...(draft.initialPaneId === pane.id ? { initialPaneId: undefined } : {}) })}>Remove pane</button>}
      </fieldset>; })}
      {(draft.kind === "tabs" || draft.kind === "dock") && <button type="button" className="button" disabled={draft.panes.length >= (draft.kind === "dock" ? 5 : 16)} onClick={() => { let number = 1; while (draft.panes.some(pane => pane.id === `pane${number}`)) number++; const edge = (["left", "right", "top", "bottom"] as const).find(edge => !draft.panes.some(pane => pane.edge === edge)); setDraft({ ...draft, panes: [...draft.panes, { id: `pane${number}`, label: `Pane ${number}`, templateId: templates[0]?.id ?? "", ...(draft.kind === "dock" ? { edge: edge ?? "center", size: 220 } : {}) }] }); }}>Add pane</button>}
      {error && <p role="alert">{error}</p>}<div className="binding-actions"><button type="button" className="button" onClick={() => setOpen(false)}>Done editing</button><button type="button" className="button primary" onClick={apply}>Apply container</button></div>
    </PropertyCollectionDialog>}
  </section>;
}
