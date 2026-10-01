import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DatasetBindingEditor } from "./DatasetBindingEditor";
import type { BindingContext } from "./propertyBindings";
import type { CanvasComponent, NamedQuery } from "./types";

export function DatasetProperties({ component, context, queries, allowUnresolvedScreenState, onChange }: {
  component: CanvasComponent; context: BindingContext; queries: NamedQuery[]; allowUnresolvedScreenState?: boolean;
  onChange: (props: Partial<CanvasComponent["props"]>) => void;
}) {
  const [open, setOpen] = useState(false), dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!open) return; const element = dialog.current; if (!element?.open) element?.showModal(); return () => element?.close(); }, [open]);
  return <div className="property-sheet-group"><h4>Dataset</h4>
    <div className={`property-sheet-row${component.props.dataSource ? " is-bound" : ""}`} data-property="dataSource"><label>Data source</label><div className="property-sheet-value">
    <span className="property-sheet-summary">{component.props.dataSource ? `Named query: ${queries.find(query => query.id === component.props.dataSource!.queryId)?.name ?? component.props.dataSource.queryId}` : "Saved dataset"}</span></div>
    <button type="button" className="property-bind-button" aria-label="Edit dataset binding" title="Bind dataset to a named query" onClick={() => setOpen(true)}>fx</button></div>
    {open && createPortal(<dialog ref={dialog} className="property-binding-dialog" aria-label="Dataset binding" onCancel={event => { event.preventDefault(); setOpen(false); }} onKeyDown={event => event.stopPropagation()}>
      <div className="binding-dialog-heading"><h2>Dataset binding</h2><button type="button" aria-label="Close dataset binding" onClick={() => setOpen(false)}>×</button></div>
      <div className="binding-dialog-body"><DatasetBindingEditor component={component} context={context} queries={queries} allowUnresolvedScreenState={allowUnresolvedScreenState}
        onApply={dataSource => { onChange({ dataSource }); setOpen(false); }} onCancel={() => setOpen(false)}
        onRemove={component.props.dataSource ? () => { onChange({ dataSource: undefined }); setOpen(false); } : undefined} /></div>
    </dialog>, document.body)}
  </div>;
}
