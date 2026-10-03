import { useId, useRef } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import Icon from "./Icon";
import { selectLayerRange } from "./canvasEditing";
import type { CanvasComponent, ComponentType } from "./types";

interface DesignerLayersProps {
  components: readonly CanvasComponent[];
  selectedIds: string[];
  typeIcons: Record<ComponentType, string>;
  hasDocument: boolean;
  disabled: boolean;
  onSelect: (ids: string[]) => void;
  onDelete: () => void;
  onAdd: () => void;
}

const selectionHint = "Shift-click selects a range. Ctrl-click or Command-click toggles layers. Groups stay together. Press Delete to remove the selection.";

export default function DesignerLayers({ components, selectedIds, typeIcons, hasDocument, disabled, onSelect, onDelete, onAdd }: DesignerLayersProps) {
  const hintId = useId();
  const lastSelection = useRef<{ anchorId: string | null; signature: string }>({ anchorId: null, signature: "[]" });
  const selectLayer = (event: MouseEvent<HTMLButtonElement>, componentId: string) => {
    if (disabled) return;
    const signature = JSON.stringify(selectedIds);
    const anchor = lastSelection.current.signature === signature ? lastSelection.current.anchorId : selectedIds[0] ?? null;
    const next = selectLayerRange(components, selectedIds, componentId, anchor, event);
    lastSelection.current = { anchorId: next.anchorId, signature: JSON.stringify(next.selectedIds) };
    onSelect(next.selectedIds);
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || (event.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]")) return;
    if (event.altKey) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault(); event.stopPropagation();
      if (selectedIds.length) onDelete();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault(); event.stopPropagation();
      onSelect(components.map(component => component.id));
    } else if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      lastSelection.current = { anchorId: null, signature: "[]" };
      onSelect([]);
    }
  };

  return <div className="component-tree designer-layers" onKeyDown={keyboard}>
    <div className="section-heading">
      <span>LAYERS <em>{components.length}</em></span>
      <div className="designer-layer-actions">
        <button type="button" className="designer-layer-delete" disabled={disabled || !selectedIds.length} onClick={onDelete}
          title="Delete all selected layers" aria-label={`Delete selected layers (${selectedIds.length})`}>
          Delete selected{selectedIds.length > 0 && <span> ({selectedIds.length})</span>}
        </button>
        <button type="button" className="icon-button" title="Add a component" aria-label="Add a component" disabled={disabled || !hasDocument} onClick={onAdd}>
          <Icon name="plus" size={16} />
        </button>
      </div>
    </div>
    <div className="project-document-list" role="group" aria-label="Document layers" aria-describedby={hintId}>
      {components.map(component => <button type="button" key={component.id}
        className={`layer-item ${selectedIds.includes(component.id) ? "selected" : ""}`}
        aria-pressed={selectedIds.includes(component.id)} disabled={disabled}
        title={`Component ID: ${component.id}. ${selectionHint}`} onClick={event => selectLayer(event, component.id)}>
        <Icon name={typeIcons[component.type]} size={15} />
        <span>{component.props.text?.trim() || component.id}</span>
        {component.groupId && <span className="layer-group-marker" title="Member of a persistent group"><Icon name="layers" size={12} /></span>}
        {component.props.tagPath && <Icon name="link" size={12} />}
      </button>)}
      {!components.length && <p className="panel-empty">{hasDocument ? "Add a component to start building this screen." : "Open a screen or template to view its layers."}</p>}
      <p className="designer-layer-hint" id={hintId}>{selectionHint}</p>
    </div>
  </div>;
}
