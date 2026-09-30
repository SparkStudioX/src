import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from "react";
import type { ViewLayout, ViewPane } from "./viewContainers";
import "./viewContainers.css";

function ResizeHandle({ label, vertical, value, min, max, onChange, disabled = false, extent, reverse = false }: {
  label: string; vertical: boolean; value: number; min: number; max: number; onChange: (value: number) => void;
  disabled?: boolean; extent: () => number; reverse?: boolean;
}) {
  const drag = useRef<{ pointer: number; start: number; value: number } | null>(null);
  const clamp = (next: number) => Math.max(min, Math.min(max, next));
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current || disabled || event.pointerId !== drag.current.pointer) return;
    const distance = (vertical ? event.clientY : event.clientX) - drag.current.start;
    onChange(clamp(drag.current.value + distance / Math.max(0.01, extent()) * (reverse ? -1 : 1)));
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const direction = event.key === (vertical ? "ArrowDown" : "ArrowRight") ? 1 : event.key === (vertical ? "ArrowUp" : "ArrowLeft") ? -1 : 0;
    if (!direction && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault(); event.stopPropagation();
    onChange(event.key === "Home" ? min : event.key === "End" ? max : clamp(value + direction * (reverse ? -1 : 1) * (event.shiftKey ? 10 : 1)));
  }
  return <div className={`view-resize-handle ${vertical ? "is-horizontal" : "is-vertical"}`} role="separator" aria-label={label}
    aria-orientation={vertical ? "horizontal" : "vertical"} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0}
    onKeyDown={key} onPointerDown={event => { if (disabled || event.button !== 0) return; event.preventDefault(); event.stopPropagation(); drag.current = { pointer: event.pointerId, start: vertical ? event.clientY : event.clientX, value }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={move} onPointerUp={event => { if (drag.current?.pointer !== event.pointerId) return; move(event); drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} />;
}

/** Layout owns only local presentation state. Form state lives in each retained pane. */
export default function ViewContainer({ layout, interactive, renderPane }: { layout: ViewLayout; interactive: boolean; renderPane: (pane: ViewPane, active: boolean) => ReactNode }) {
  const id = useId(), host = useRef<HTMLDivElement>(null);
  const signature = JSON.stringify(layout);
  const first = layout.initialPaneId ?? layout.panes[0]?.id ?? "";
  const [selected, setSelected] = useState(first), [ratio, setRatio] = useState(layout.ratio ?? 50);
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(layout.panes.map(pane => [pane.id, pane.initiallyOpen !== false])));
  const [sizes, setSizes] = useState<Record<string, number>>(() => Object.fromEntries(layout.panes.map(pane => [pane.id, pane.size ?? 220])));
  useEffect(() => { setSelected(first); setRatio(layout.ratio ?? 50); setOpen(Object.fromEntries(layout.panes.map(pane => [pane.id, pane.initiallyOpen !== false]))); setSizes(Object.fromEntries(layout.panes.map(pane => [pane.id, pane.size ?? 220]))); }, [signature]);
  const selectedId = layout.panes.some(pane => pane.id === selected) ? selected : first;
  const measuredExtent = (vertical: boolean) => { const element = host.current; return element ? vertical ? element.getBoundingClientRect().height : element.getBoundingClientRect().width : 1; };
  const viewportScale = (vertical: boolean) => measuredExtent(vertical) / Math.max(1, vertical ? host.current?.clientHeight ?? 1 : host.current?.clientWidth ?? 1);
  function selectTab(index: number) { const pane = layout.panes[(index + layout.panes.length) % layout.panes.length]; setSelected(pane.id); host.current?.querySelector<HTMLButtonElement>(`[data-tab-index="${(index + layout.panes.length) % layout.panes.length}"]`)?.focus(); }
  const dockSize = (edge: string) => { const pane = layout.panes.find(item => item.edge === edge); return pane && open[pane.id] !== false ? `min(${sizes[pane.id] ?? 220}px, 35%)` : "0px"; };
  const style: CSSProperties = layout.kind === "split" ? { gridTemplateColumns: layout.orientation === "vertical" ? "minmax(0,1fr)" : `minmax(0,${ratio}fr) 6px minmax(0,${100 - ratio}fr)`, gridTemplateRows: layout.orientation === "vertical" ? `minmax(0,${ratio}fr) 6px minmax(0,${100 - ratio}fr)` : "minmax(0,1fr)" }
    : layout.kind === "dock" ? { gridTemplateColumns: `${dockSize("left")} minmax(0,1fr) ${dockSize("right")}`, gridTemplateRows: `auto ${dockSize("top")} minmax(0,1fr) ${dockSize("bottom")}` } : {};
  return <div ref={host} className={`view-container view-container-${layout.kind}`} style={style}>
    {layout.kind === "tabs" && <div className="view-tab-list" role="tablist" aria-label="Embedded views">{layout.panes.map((pane, index) => <button key={pane.id} type="button" role="tab" id={`${id}-tab-${pane.id}`} aria-controls={`${id}-pane-${pane.id}`} aria-selected={pane.id === selectedId} tabIndex={pane.id === selectedId ? 0 : -1} disabled={!interactive} data-tab-index={index}
      onClick={() => setSelected(pane.id)} onKeyDown={event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); selectTab(event.key === "Home" ? 0 : event.key === "End" ? layout.panes.length - 1 : index + (event.key === "ArrowRight" ? 1 : -1)); }}>{pane.label}</button>)}</div>}
    {layout.kind === "dock" && <div className="view-dock-toolbar" aria-label="Dock visibility">{layout.panes.filter(pane => pane.edge !== "center").map(pane => <button key={pane.id} type="button" disabled={!interactive} aria-pressed={open[pane.id] !== false} aria-controls={`${id}-pane-${pane.id}`} onClick={() => setOpen(previous => ({ ...previous, [pane.id]: previous[pane.id] === false }))}>{pane.label}</button>)}</div>}
    {layout.panes.map((pane, index) => {
      const shown = layout.kind === "tabs" ? pane.id === selectedId : layout.kind === "dock" ? pane.edge === "center" || open[pane.id] !== false : true;
      const placement = layout.kind === "dock" ? ({ center: { gridColumn: 2, gridRow: 3 }, left: { gridColumn: 1, gridRow: 3 }, right: { gridColumn: 3, gridRow: 3 }, top: { gridColumn: "1 / -1", gridRow: 2 }, bottom: { gridColumn: "1 / -1", gridRow: 4 } }[pane.edge ?? "center"]) : layout.kind === "split" ? layout.orientation === "vertical" ? { gridColumn: 1, gridRow: index * 2 + 1 } : { gridColumn: index * 2 + 1, gridRow: 1 } : undefined;
      return <div key={pane.id} className={`view-pane ${layout.kind === "dock" ? `view-dock-${pane.edge}` : ""}`} id={`${id}-pane-${pane.id}`} role={layout.kind === "tabs" ? "tabpanel" : "region"} aria-labelledby={layout.kind === "tabs" ? `${id}-tab-${pane.id}` : undefined} aria-label={layout.kind === "tabs" ? undefined : pane.label} hidden={!shown} inert={!shown || !interactive} style={placement}>
        {layout.kind === "dock" && pane.edge !== "center" && <header><span>{pane.label}</span><button type="button" disabled={!interactive} aria-label={`Close ${pane.label} dock`} onClick={() => setOpen(previous => ({ ...previous, [pane.id]: false }))}>×</button></header>}
        <div className="view-pane-content">{renderPane(pane, shown)}</div>
        {layout.kind === "dock" && pane.edge !== "center" && <ResizeHandle label={`Resize ${pane.label} dock`} vertical={pane.edge === "top" || pane.edge === "bottom"} reverse={pane.edge === "right" || pane.edge === "bottom"} value={sizes[pane.id] ?? 220} min={80} max={1600} extent={() => viewportScale(pane.edge === "top" || pane.edge === "bottom")} disabled={!interactive} onChange={value => setSizes(previous => ({ ...previous, [pane.id]: value }))} />}
      </div>;
    })}
    {layout.kind === "split" && <div className="view-split-separator" style={layout.orientation === "vertical" ? { gridRow: 2, gridColumn: 1 } : { gridColumn: 2, gridRow: 1 }}><ResizeHandle label="Resize split panes" vertical={layout.orientation === "vertical"} value={ratio} min={10} max={90} disabled={!interactive} extent={() => measuredExtent(layout.orientation === "vertical") / 100} onChange={setRatio} /></div>}
  </div>;
}
