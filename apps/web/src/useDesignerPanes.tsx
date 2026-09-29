import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { DEFAULT_DESIGNER_PANES, MIN_DESIGNER_PANES, designerPaneKeyDelta, designerPaneMaximum, fitDesignerPanes, moveDesignerPane, restoreDesignerPanes } from "./projectPaneLayout";
import type { DesignerPaneSide, DesignerPaneWidths } from "./projectPaneLayout";

const storageKey = "sparkstudio.designerPaneWidths.v1";
type PaneDrag = { pointerId: number; side: DesignerPaneSide; startX: number; widths: DesignerPaneWidths; preferences: DesignerPaneWidths };

export function useDesignerPanes(active: boolean) {
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<PaneDrag | null>(null);
  const [preferences, setPreferences] = useState<DesignerPaneWidths>(() => {
    try { return restoreDesignerPanes(JSON.parse(localStorage.getItem(storageKey) || "null")); }
    catch { return [...DEFAULT_DESIGNER_PANES]; }
  });
  const [containerWidth, setContainerWidth] = useState(0);
  const [resizing, setResizing] = useState(false);
  const widths = fitDesignerPanes(preferences, containerWidth);

  useLayoutEffect(() => {
    if (!active || !host.current) return;
    const element = host.current;
    let previousWidth = -1;
    const resize = () => {
      const width = element.clientWidth;
      if (width === previousWidth) return;
      previousWidth = width;
      if (drag.current) setPreferences(drag.current.preferences);
      drag.current = null;
      setResizing(false);
      setContainerWidth(width);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (drag.current) setPreferences(drag.current.preferences);
      drag.current = null;
      setResizing(false);
    };
  }, [active]);

  useEffect(() => {
    if (resizing) return;
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); }
    catch { /* The layout still works when browser storage is unavailable. */ }
  }, [preferences, resizing]);

  const begin = (event: PointerEvent<HTMLDivElement>, side: DesignerPaneSide) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, side, startX: event.clientX, widths, preferences };
    setResizing(true);
  };
  const update = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    setPreferences(moveDesignerPane(gesture.widths, gesture.side, (event.clientX - gesture.startX) * (gesture.side === 0 ? 1 : -1), containerWidth));
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (cancel) setPreferences(gesture.preferences);
    else update(event);
    drag.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyResize = (event: KeyboardEvent<HTMLDivElement>, side: DesignerPaneSide) => {
    if (event.key === "Escape" && drag.current) {
      event.preventDefault();
      event.stopPropagation();
      setPreferences(drag.current.preferences);
      const pointerId = drag.current.pointerId;
      drag.current = null;
      setResizing(false);
      if (event.currentTarget.hasPointerCapture(pointerId)) event.currentTarget.releasePointerCapture(pointerId);
      return;
    }
    const delta = designerPaneKeyDelta(event.key, event.shiftKey, side);
    if (delta === null || event.ctrlKey || event.metaKey || event.altKey || drag.current) return;
    event.preventDefault();
    event.stopPropagation();
    setPreferences(moveDesignerPane(widths, side, delta, containerWidth));
  };

  const separator = (side: DesignerPaneSide) => <div
    className="designer-pane-separator"
    role="separator"
    tabIndex={0}
    aria-label={`Resize ${side === 0 ? "project" : "properties"} pane`}
    aria-orientation="vertical"
    aria-controls={side === 0 ? "designer-project-panel" : "designer-properties-panel"}
    aria-valuemin={MIN_DESIGNER_PANES[side]}
    aria-valuemax={Math.round(designerPaneMaximum(widths, side, containerWidth))}
    aria-valuenow={Math.round(widths[side])}
    aria-valuetext={`${Math.round(widths[side])} pixels wide`}
    title="Drag to resize. Arrow keys adjust; Shift adjusts faster. Double-click resets both panes."
    onPointerDown={event => begin(event, side)}
    onPointerMove={update}
    onPointerUp={event => finish(event)}
    onPointerCancel={event => finish(event, true)}
    onLostPointerCapture={event => finish(event, true)}
    onKeyDown={event => keyResize(event, side)}
    onDoubleClick={() => setPreferences([...DEFAULT_DESIGNER_PANES])}
  ><span /></div>;

  return {
    host,
    resizing,
    style: { "--designer-project-width": `${widths[0]}px`, "--designer-properties-width": `${widths[1]}px` } as CSSProperties,
    separator,
  };
}
