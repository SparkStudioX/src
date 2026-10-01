import { RuntimePropertyRow } from "./RuntimePropertyRow";
import { useRef, useState } from "react";
import { drawingDefaults, validateDrawingProps } from "./drawingComponents";
import type { CanvasComponent } from "./types";
import { PropertyCollectionDialog } from "./PropertyCollectionEditor";
import "./drawingEditor.css";

type PointRow = { id: number; x: string; y: string };
type Draft = { points: PointRow[]; symbol: string; cornerRadius: string };

/** Structural edits remain a local draft until Apply creates one history entry. */
export function DrawingEditor({ component, onChange, notify }: {
  component: CanvasComponent; onChange: (patch: CanvasComponent["props"]) => void; notify: (message: string, error?: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const nextId = useRef(0);
  const path = ["line", "polyline", "pipe"].includes(component.type);
  const line = component.type === "line";
  const rectangle = component.type === "rectangle";
  const equipment = component.type === "equipmentSymbol";
  if (!path && !rectangle && !equipment) return null;
  const defaults = drawingDefaults(component.type);
  const source = component.props.points ?? defaults.points ?? [];
  const title = path ? "Drawing points" : rectangle ? "Rectangle corners" : "Equipment symbol";
  function edit() {
    setDraft({ points: source.map(point => ({ id: nextId.current++, x: String(point.x), y: String(point.y) })),
      symbol: component.props.symbol ?? defaults.symbol ?? "pump", cornerRadius: String(component.props.cornerRadius ?? defaults.cornerRadius ?? 0) });
  }
  function patch(): CanvasComponent["props"] {
    if (!draft) return {};
    if (path) return { points: draft.points.map(point => ({ x: Number(point.x), y: Number(point.y) })) };
    if (rectangle) return { cornerRadius: Number(draft.cornerRadius) };
    return { symbol: draft.symbol as CanvasComponent["props"]["symbol"] };
  }
  function validation(): string | null {
    if (!draft) return validateDrawingProps(component.type, component.props);
    if (path && draft.points.some(point => !point.x.trim() || !point.y.trim())) return "Every point needs an X and Y position from 0 to 100%.";
    if (rectangle && !draft.cornerRadius.trim()) return "Corner radius needs a number from 0 to 50%.";
    return validateDrawingProps(component.type, { ...component.props, ...patch() });
  }
  const error = validation();
  function apply() {
    if (!draft) return;
    if (error) { notify(error, true); return; }
    onChange(patch()); setDraft(null);
  }
  function changePoint(id: number, field: "x" | "y", value: string) {
    if (draft) setDraft({ ...draft, points: draft.points.map(point => point.id === id ? { ...point, [field]: value } : point) });
  }
  function move(index: number, direction: -1 | 1) {
    if (!draft || index + direction < 0 || index + direction >= draft.points.length) return;
    const points = [...draft.points]; [points[index], points[index + direction]] = [points[index + direction], points[index]];
    setDraft({ ...draft, points });
  }
  function add(after: number) {
    if (!draft || line || draft.points.length >= 64) return;
    const current = draft.points[after], next = draft.points[after + 1];
    const x = Number(current.x), y = Number(current.y);
    const usable = current.x.trim() && current.y.trim() && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 100;
    const point = next && usable && next.x.trim() && next.y.trim() && Number.isFinite(Number(next.x)) && Number.isFinite(Number(next.y))
      ? { x: String((x + Number(next.x)) / 2), y: String((y + Number(next.y)) / 2) }
      : usable ? { x: String(x > 90 ? x - 10 : x + 10), y: String(y) } : { x: "50", y: "50" };
    setDraft({ ...draft, points: [...draft.points.slice(0, after + 1), { id: nextId.current++, ...point }, ...draft.points.slice(after + 1)] });
  }
  const previewPoints = draft?.points.map(point => ({ x: Number(point.x), y: Number(point.y) }));
  const previewValid = previewPoints && draft!.points.every(point => point.x.trim() && point.y.trim()) && previewPoints.every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100);
  const help = path ? "Points use positions inside the component: X runs left to right and Y runs top to bottom, from 0 to 100%. Move or resize the component on the canvas to place the whole drawing."
      : rectangle ? "Round the corners from 0 to 50% of the shorter side."
        : "Choose an authored pump, valve, or motor. Active and Accent color in the property sheet control its status appearance.";
  return <section className="property-sheet-group property-collection-group" aria-label={title}><h4>Drawing</h4>
    <RuntimePropertyRow title={help} target={path ? "points" : rectangle ? "cornerRadius" : "symbol"} label={path ? "Points" : rectangle ? "Corner radius" : "Symbol"}><span>{path ? `${source.length} points` : rectangle ? `${component.props.cornerRadius ?? defaults.cornerRadius ?? 0}%` : component.props.symbol ?? defaults.symbol ?? "pump"}</span><button type="button" className="button small" onClick={edit}>{path ? "Edit points" : rectangle ? "Edit corners" : "Choose symbol"}</button></RuntimePropertyRow>
    {!draft && error && <p className="drawing-editor-error" role="alert">{error}</p>}
    {draft && <PropertyCollectionDialog title={title} onClose={() => setDraft(null)}><p className="drawing-editor-help">{help}</p><div className="drawing-editor-draft" role="group" aria-label={`Edit ${title.toLowerCase()}`} onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); apply(); }
      if (event.key === "Escape") { event.preventDefault(); setDraft(null); }
    }}>
      {path && <>
        {previewValid && <svg className="drawing-point-preview" viewBox="-5 -5 110 110" role="img" aria-label={`Point preview with ${previewPoints.length} connected points`}>
          <rect className="drawing-point-frame" x="0" y="0" width="100" height="100" />
          <polyline points={previewPoints.map(point => `${point.x},${point.y}`).join(" ")} />
          {previewPoints.map((point, index) => <g key={draft.points[index].id}><circle cx={point.x} cy={point.y} r="2" /><text x={point.x > 90 ? point.x - 4 : point.x + 4} y={point.y < 10 ? point.y + 8 : point.y - 4} textAnchor={point.x > 90 ? "end" : "start"}>{index + 1}</text></g>)}
        </svg>}
        <p className="drawing-editor-help">{line ? "A line has exactly two endpoints." : "Use 2–64 points. Insert adds a point halfway along the next segment. Reordering changes the route."} Consecutive points must be different.</p>
        {draft.points.map((point, index) => <div className="drawing-point-row" key={point.id}>
          <div className="drawing-editor-heading"><strong>Point {index + 1}</strong>{!line && <div className="drawing-point-order">
            <button type="button" className="button small" aria-label={`Move point ${index + 1} earlier`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
            <button type="button" className="button small" aria-label={`Move point ${index + 1} later`} disabled={index === draft.points.length - 1} onClick={() => move(index, 1)}>↓</button>
            <button type="button" className="button small" aria-label={`Remove point ${index + 1}`} disabled={draft.points.length <= 2} onClick={() => setDraft({ ...draft, points: draft.points.filter(item => item.id !== point.id) })}>Remove</button>
          </div>}</div>
          <div className="drawing-point-coordinates">{(["x", "y"] as const).map(axis => <label key={axis}>{axis.toUpperCase()} (%)<input type="number" aria-label={`Point ${index + 1} ${axis.toUpperCase()}`} min={0} max={100} step="any" value={point[axis]} onChange={event => changePoint(point.id, axis, event.target.value)} /></label>)}</div>
          {!line && index < draft.points.length - 1 && <button type="button" className="button small" aria-label={`Insert point after ${index + 1}`} disabled={draft.points.length >= 64} onClick={() => add(index)}>Insert after</button>}
        </div>)}
        {!line && <button type="button" className="button small" disabled={draft.points.length >= 64} onClick={() => add(draft.points.length - 1)}>Add point</button>}
      </>}
      {rectangle && <label className="drawing-editor-field">Corner radius (%)<input type="number" aria-label="Rectangle corner radius" min={0} max={50} step="any" value={draft.cornerRadius} onChange={event => setDraft({ ...draft, cornerRadius: event.target.value })} /></label>}
      {equipment && <label className="drawing-editor-field">Symbol<select aria-label="Equipment symbol" value={draft.symbol} onChange={event => setDraft({ ...draft, symbol: event.target.value })}><option value="pump">Pump</option><option value="valve">Valve</option><option value="motor">Motor</option></select></label>}
      {error && <p className="drawing-editor-error" role="alert">{error}</p>}
      <div className="drawing-editor-actions"><button type="button" className="button small primary" disabled={Boolean(error)} onClick={apply}>{path ? "Apply points" : rectangle ? "Apply corners" : "Apply symbol"}</button><button type="button" className="button small" onClick={() => setDraft(null)}>Cancel</button></div>
    </div></PropertyCollectionDialog>}
  </section>;
}
