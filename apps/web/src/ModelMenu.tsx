import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import Icon from "./Icon";
import "./modelMenu.css";

const openedEvent = "sparkstudio:model-menu-opened";
type PopoverProps = { label: string; icon?: string; iconOnly?: boolean; primary?: boolean; small?: boolean; disabled?: boolean; title?: string; role?: "menu" | "dialog"; children: (close: () => void) => ReactNode };

/** Shared dismissal and focus behavior for model actions and searchable pickers. */
export function ModelPopover({ label, icon, iconOnly, primary, small, disabled, title, role = "menu", children }: PopoverProps) {
  const [open, setOpen] = useState(false), id = useId();
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), last = useRef(false);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    const dismissOther = (event: Event) => { if ((event as CustomEvent<string>).detail !== id) setOpen(false); };
    document.addEventListener(openedEvent, dismissOther);
    return () => document.removeEventListener(openedEvent, dismissOther);
  }, [id]);
  useEffect(() => {
    if (!open) return;
    document.dispatchEvent(new CustomEvent(openedEvent, { detail: id }));
    const items = panel.current?.querySelectorAll<HTMLElement>(role === "menu" ? '[role="menuitem"]:not(:disabled)' : 'input:not(:disabled),button:not(:disabled)');
    items?.[last.current ? items.length - 1 : 0]?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, id, role]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <div ref={root} className="model-dropdown" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <button type="button" ref={trigger} className={`button${small ? " small" : ""}${primary ? " primary" : ""}${iconOnly ? " model-menu-icon-button" : ""}`} aria-label={label} aria-haspopup={role} aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} title={title || (iconOnly ? label : undefined)}
      onClick={() => { last.current = false; setOpen(!open); }} onKeyDown={event => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault(); last.current = event.key === "ArrowUp";
        if (open) { const items = panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'); items?.[last.current ? items.length - 1 : 0]?.focus({ preventScroll: true }); }
        else setOpen(true);
      }}>{icon && <Icon name={icon} size={16} />}{!iconOnly && <>{label}<Icon name="down" size={14} /></>}</button>
    {open && <div ref={panel} id={id} role={role} aria-label={label} className={`model-menu-panel${role === "dialog" ? " model-menu-picker" : ""}`} onKeyDown={event => {
      if (role !== "menu") return;
      const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []), current = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "ArrowDown" ? (current + 1) % items.length : event.key === "ArrowUp" ? (current - 1 + items.length) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); items[next]?.focus({ preventScroll: true }); }
    }}>{children(close)}</div>}
  </div>;
}

export type ModelMenuItem = { label: string; description?: string; icon: string; disabled?: boolean; danger?: boolean; onSelect: () => void };
export default function ModelMenu({ items, ...props }: Omit<PopoverProps, "children" | "role"> & { items: ModelMenuItem[] }) {
  return <ModelPopover {...props}>{close => items.map(item => <button key={item.label} type="button" role="menuitem" tabIndex={-1} disabled={item.disabled} className={item.danger ? "danger" : undefined}
    onPointerMove={event => { if (event.pointerType !== "touch" && !item.disabled && document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true }); }}
    onClick={() => { close(); item.onSelect(); }}><Icon name={item.icon} size={18} /><span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span></button>)}</ModelPopover>;
}
