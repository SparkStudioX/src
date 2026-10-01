import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import "./propertyCollectionEditor.css";

/** Structured values keep their staged forms outside the compact property grid. */
export function PropertyCollectionDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return createPortal(<dialog ref={dialog} className="property-collection-dialog" aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><h2>{title}</h2><button type="button" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}>×</button></header>
    <div className="property-collection-body">{children}</div>
  </dialog>, document.body);
}
