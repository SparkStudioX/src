import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
const widthKey = "sparkstudio.model-builder-library-width";
function readWidth(): number {
  try { const saved = Number(localStorage.getItem(widthKey)); return saved >= 220 && saved <= 480 ? saved : 300; }
  catch { return 300; }
}
/** One model page: the optional data library beside a single column of fields, then machines. */
export function ModelBuilderPanels({ library, shell, instances, drawer, showLibrary, onCloseLibrary }: { library: ReactNode; shell: ReactNode; instances: ReactNode; drawer?: ReactNode; showLibrary: boolean; onCloseLibrary: () => void }) {
  const [width, setWidth] = useState(readWidth);
  useEffect(() => { try { localStorage.setItem(widthKey, String(width)); } catch { /* Storage may be unavailable. */ } }, [width]);
  return <div className={`model-builder-layout${showLibrary ? " with-library" : ""}`} style={{ "--model-library-width": `${width}px` } as CSSProperties}>
    <aside hidden={!showLibrary} className="model-builder-pane model-library-pane" aria-label="Add fields from data"><header className="model-builder-step"><div><h3>Add fields from data</h3><p>Drag tags or a folder into Fields, or select one and choose Add to model.</p></div><button type="button" className="button small" aria-label="Close data library" onClick={onCloseLibrary}>×</button></header>{library}</aside>
    <PaneResize hidden={!showLibrary} name="Data library" value={width} min={220} max={480} onChange={setWidth} />
    <div className="model-builder-main"><section className="model-builder-pane model-shell-pane">{shell}</section><section className="model-builder-pane model-instances-pane">{instances}</section></div>
    {drawer}
  </div>;
}
function PaneResize({ name, value, min, max, hidden = false, onChange }: { hidden?: boolean; name: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const drag = useRef<{ x: number; value: number } | null>(null), clamp = (next: number) => Math.max(min, Math.min(max, next));
  const begin = (event: PointerEvent) => { if (event.button !== 0) return; event.preventDefault(); drag.current = { x: event.clientX, value }; event.currentTarget.setPointerCapture(event.pointerId); };
  return <div hidden={hidden} className="model-pane-resize" role="separator" tabIndex={0} aria-label={`${name} pane width`} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} onPointerDown={begin} onPointerMove={event => { if (drag.current) onChange(clamp(drag.current.value + event.clientX - drag.current.x)); }} onPointerUp={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); onChange(clamp(value + (event.key === "ArrowLeft" ? -20 : 20))); }} />;
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
