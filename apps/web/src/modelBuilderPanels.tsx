import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
const paneKey = "sparkstudio.model-builder-panes";
interface PaneSettings { library: number; instances: number; hideLibrary: boolean; hideInstances: boolean }
function readPanes(): PaneSettings {
  const defaults = { library: 280, instances: 420, hideLibrary: false, hideInstances: false };
  try { const saved = JSON.parse(localStorage.getItem(paneKey) || "null"); if (!saved) return defaults; return { library: Math.max(200, Math.min(460, Number(saved.library) || 280)), instances: Math.max(320, Math.min(720, Number(saved.instances) || 420)), hideLibrary: saved.hideLibrary === true, hideInstances: saved.hideInstances === true }; }
  catch { return defaults; }
}
export type ModelBuilderMode = "auto" | "fields" | "machines" | "combined";
export function ModelBuilderPanels({ library, shell, instances, drawer, mode = "auto", onModeChange }: { library: ReactNode; shell: ReactNode; instances: ReactNode; drawer?: ReactNode; mode?: ModelBuilderMode; onModeChange?: (mode: ModelBuilderMode) => void }) {
  const [panes, setPanes] = useState(readPanes), [wide, setWide] = useState(() => window.innerWidth > 1400);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem(paneKey, JSON.stringify(panes)); } catch { /* Storage may be unavailable. */ } }, [panes]);
  useEffect(() => { const element = container.current; if (!element || typeof ResizeObserver === "undefined") return; const observer = new ResizeObserver(entries => setWide(entries[0].contentRect.width > 1100)); observer.observe(element); return () => observer.disconnect(); }, []);
  const active = mode === "auto" ? wide ? "combined" : "fields" : mode === "combined" && !wide ? "fields" : mode;
  const hideLibrary = active === "machines" || panes.hideLibrary, hideShell = active === "machines", hideInstances = active === "fields" || active === "combined" && panes.hideInstances;
  return <div className="model-builder-flow" ref={container}><div className="model-flow-controls"><nav className="model-flow-steps" aria-label="Model building steps"><button type="button" className="button small" aria-pressed={active === "fields"} onClick={() => onModeChange?.("fields")}>1 · Define fields</button><button type="button" className="button small" aria-pressed={active === "machines"} onClick={() => onModeChange?.("machines")}>2 · Connect machines</button>{wide && <button type="button" className="button small" aria-pressed={active === "combined"} onClick={() => onModeChange?.("combined")}>Combined view</button>}</nav><details className="model-layout-options"><summary>Layout options</summary><div className="model-pane-toggles"><button type="button" className="button small" disabled={active === "machines"} aria-expanded={!panes.hideLibrary} onClick={() => setPanes({ ...panes, hideLibrary: !panes.hideLibrary })}>{panes.hideLibrary ? "Show" : "Hide"} data library</button>{active === "combined" && <button type="button" className="button small" aria-expanded={!panes.hideInstances} onClick={() => setPanes({ ...panes, hideInstances: !panes.hideInstances })}>{panes.hideInstances ? "Show" : "Hide"} equipment</button>}</div></details></div>
    <div className={`model-builder-layout ${hideLibrary ? "without-library" : ""} ${hideInstances ? "without-instances" : ""} ${hideShell ? "without-shell" : ""}`} style={{ "--model-library-width": `${panes.library}px`, "--model-instances-width": `${panes.instances}px` } as CSSProperties}>
      <div hidden={hideLibrary} className="model-builder-pane model-library-pane"><BuilderSectionHeading title="Choose data" description="Find the tags you want to use." />{library}</div><PaneResize hidden={hideLibrary} name="Data library" value={panes.library} min={200} max={460} onChange={library => setPanes(previous => ({ ...previous, library }))} />
      <div hidden={hideShell} className="model-builder-pane model-shell-pane"><BuilderSectionHeading title="Define fields" description="Give related values a reusable shape." />{shell}</div>
      <PaneResize hidden={hideInstances || hideShell} name="Equipment" reverse value={panes.instances} min={320} max={720} onChange={instances => setPanes(previous => ({ ...previous, instances }))} /><div hidden={hideInstances} className="model-builder-pane model-instances-pane"><BuilderSectionHeading title="Connect machines" description="Use your model for each real machine." />{instances}</div>
      {drawer}
    </div></div>;
}
function BuilderSectionHeading({ title, description }: { title: string; description: string }) {
  return <header className="model-builder-step"><div><h3>{title}</h3><p>{description}</p></div></header>;
}
function PaneResize({ name, value, min, max, reverse = false, hidden = false, onChange }: { hidden?: boolean; name: string; value: number; min: number; max: number; reverse?: boolean; onChange: (value: number) => void }) {
  const drag = useRef<{ x: number; value: number } | null>(null), clamp = (next: number) => Math.max(min, Math.min(max, next));
  const begin = (event: PointerEvent) => { if (event.button !== 0) return; event.preventDefault(); drag.current = { x: event.clientX, value }; event.currentTarget.setPointerCapture(event.pointerId); };
  return <div hidden={hidden} className={`model-pane-resize ${reverse ? "instances-resize" : "library-resize"}`} role="separator" tabIndex={0} aria-label={`${name} pane width`} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} onPointerDown={begin} onPointerMove={event => { if (drag.current) onChange(clamp(drag.current.value + (event.clientX - drag.current.x) * (reverse ? -1 : 1))); }} onPointerUp={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); onChange(clamp(value + (event.key === "ArrowLeft" ? -20 : 20) * (reverse ? -1 : 1))); }} />;
}
export function BuilderDrawer({ title, onClose, children, disabled = false }: { title: string; onClose: () => void; children: ReactNode; disabled?: boolean }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { const previous = document.activeElement; panel.current?.querySelector<HTMLElement>("button,input,select")?.focus({ preventScroll: true }); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); }; }, []);
  return createPortal(<aside className="model-workspace model-builder-drawer" ref={panel} aria-label={title} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}><header><h3>{title}</h3><button type="button" className="button small" onClick={onClose} aria-label="Close detail drawer">×</button></header><fieldset className="model-drawer-body" disabled={disabled}>{children}</fieldset></aside>, document.body);
}
export function BuilderDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement; dialog.current?.showModal(); const element = dialog.current; return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  return <dialog className="model-builder-dialog" ref={dialog} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}><header><h3>{title}</h3><button type="button" className="button small" onClick={onClose}>Cancel</button></header>{children}</dialog>;
}
