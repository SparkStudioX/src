import { Children, Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { DEFAULT_PROJECT_PANES, fitProjectPanes, MIN_PROJECT_PANES, moveProjectPaneDivider, PROJECT_PANE_SEPARATOR_HEIGHT, projectPaneKeyDelta, restoreProjectPanes } from "./projectPaneLayout";
import type { ProjectPaneDivider, ProjectPaneSizes } from "./projectPaneLayout";

type PaneDrag = {
  pointerId: number;
  divider: ProjectPaneDivider;
  startY: number;
  heights: ProjectPaneSizes;
  preferences: ProjectPaneSizes;
};
const paneNames = ["Screens", "Templates", "Layers"];

export default function ProjectNavigation({ storageKey, children }: { storageKey: string; children: ReactNode }) {
  const [preferences, setPreferences] = useState<ProjectPaneSizes>(() => {
    try { return restoreProjectPanes(JSON.parse(localStorage.getItem(storageKey) || "null")); }
    catch { return [...DEFAULT_PROJECT_PANES]; }
  });
  const [containerHeight, setContainerHeight] = useState(0);
  const [resizing, setResizing] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<PaneDrag | null>(null);
  const paneId = useId();
  const heights = fitProjectPanes(preferences, containerHeight);
  const panes = Children.toArray(children);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    let previousHeight = -1;
    const resize = () => {
      const height = element.clientHeight;
      if (height === previousHeight) return;
      previousHeight = height;
      // A gesture uses its starting geometry; cancel it if the window changes underneath it.
      if (drag.current) setPreferences(drag.current.preferences);
      drag.current = null;
      setResizing(false);
      setContainerHeight(height);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (resizing) return;
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); }
    catch { /* Layout preferences are optional; resizing still works without browser storage. */ }
  }, [preferences, resizing, storageKey]);

  const beginResize = (event: PointerEvent<HTMLDivElement>, divider: ProjectPaneDivider) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, divider, startY: event.clientY, heights, preferences };
    setResizing(true);
  };
  const updateResize = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    setPreferences(restoreProjectPanes(moveProjectPaneDivider(gesture.heights, gesture.divider, event.clientY - gesture.startY)));
  };
  const finishResize = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (cancel) setPreferences(gesture.preferences);
    else setPreferences(restoreProjectPanes(moveProjectPaneDivider(gesture.heights, gesture.divider, event.clientY - gesture.startY)));
    drag.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyResize = (event: KeyboardEvent<HTMLDivElement>, divider: ProjectPaneDivider) => {
    if (event.key === "Escape" && drag.current) {
      event.preventDefault();
      setPreferences(drag.current.preferences);
      drag.current = null;
      setResizing(false);
      return;
    }
    const delta = projectPaneKeyDelta(event.key, event.shiftKey);
    if (delta === null || event.ctrlKey || event.metaKey || event.altKey || drag.current) return;
    event.preventDefault();
    event.stopPropagation();
    setPreferences(restoreProjectPanes(moveProjectPaneDivider(heights, divider, delta)));
  };

  return <div className={`project-navigation${resizing ? " project-navigation-resizing" : ""}`} ref={host}>
    <div className="project-navigation-track" style={{ gridTemplateRows: heights.map(height => `${height}px`).join(` ${PROJECT_PANE_SEPARATOR_HEIGHT}px `) }}>
      {panes.map((pane, index) => <Fragment key={index}>
        <div className="project-navigation-pane" id={`${paneId}-${index}`}>{pane}</div>
        {index < 2 && <div
          className="project-pane-separator"
          role="separator"
          tabIndex={0}
          aria-label={`Resize ${paneNames[index]} and ${paneNames[index + 1]}`}
          aria-orientation="horizontal"
          aria-controls={`${paneId}-${index} ${paneId}-${index + 1}`}
          aria-valuemin={MIN_PROJECT_PANES[index]}
          aria-valuemax={Math.round(heights[index] + heights[index + 1] - MIN_PROJECT_PANES[index + 1])}
          aria-valuenow={Math.round(heights[index])}
          aria-valuetext={`${Math.round(heights[index])} pixels for ${paneNames[index]}`}
          title={`Drag to resize ${paneNames[index]} and ${paneNames[index + 1]}. Arrow keys adjust; double-click resets all panes.`}
          onPointerDown={event => beginResize(event, index as ProjectPaneDivider)}
          onPointerMove={updateResize}
          onPointerUp={event => finishResize(event)}
          onPointerCancel={event => finishResize(event, true)}
          onLostPointerCapture={event => finishResize(event, true)}
          onKeyDown={event => keyResize(event, index as ProjectPaneDivider)}
          onDoubleClick={() => setPreferences([...DEFAULT_PROJECT_PANES])}
        ><span /></div>}
      </Fragment>)}
    </div>
  </div>;
}
