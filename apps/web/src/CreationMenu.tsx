import { useEffect, useId, useRef, useState } from "react";
import Icon from "./Icon";
import "./creationMenu.css";

export interface CreationChoice<T extends string> {
  value: T;
  label: string;
  description: string;
  icon: string;
  /** Choices with a group render as headed sections in a two-column menu. */
  group?: string;
}

export default function CreationMenu<T extends string>({ label, menuLabel, choices, onSelect }: {
  label: string;
  menuLabel: string;
  choices: CreationChoice<T>[];
  onSelect: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  useEffect(() => {
    if (!open) return;
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[focusLast.current ? items.length - 1 : 0]?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  const item = (choice: CreationChoice<T>) => <button key={choice.value} type="button" role="menuitem" tabIndex={-1}
    onPointerMove={event => { if (event.pointerType !== "touch" && document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true }); }}
    onClick={() => { setOpen(false); trigger.current?.focus(); onSelect(choice.value); }}>
    <Icon name={choice.icon} size={18} /><span><strong>{choice.label}</strong><small>{choice.description}</small></span>
  </button>;
  return <div className="creation-dropdown" ref={container} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button type="button" className="button primary" ref={trigger} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => { focusLast.current = false; setOpen(!open); }}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          focusLast.current = event.key === "ArrowUp";
          if (open) {
            const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
            items?.[focusLast.current ? items.length - 1 : 0]?.focus();
          } else setOpen(true);
        } else if (event.key === "Escape" && open) {
          event.preventDefault(); event.stopPropagation(); setOpen(false);
        }
      }}>
      <Icon name="plus" size={16} />{label}<Icon name="down" size={14} />
    </button>
    {open && <div className={choices.some(choice => choice.group) ? "creation-menu grouped" : "creation-menu"} ref={menu} id={menuId} role="menu" aria-label={menuLabel} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return; }
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (current + 1) % items.length : event.key === "ArrowUp" ? (current - 1 + items.length) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); items[next]?.focus(); }
    }}>
      {groups(choices).map(([group, items]) => group
        ? <div key={group} className="creation-menu-group" role="group" aria-label={group}><h3 aria-hidden="true">{group}</h3>{items.map(item)}</div>
        : items.map(item))}
    </div>}
  </div>;
}

/** Keeps first-seen group order; ungrouped choices form one unheaded section. */
function groups<T extends string>(choices: CreationChoice<T>[]): [string, CreationChoice<T>[]][] {
  const sections = new Map<string, CreationChoice<T>[]>();
  for (const choice of choices) sections.set(choice.group ?? "", [...(sections.get(choice.group ?? "") ?? []), choice]);
  return [...sections];
}
