import { Children, cloneElement, createContext, isValidElement, useContext, useId, type ReactNode } from "react";

export interface RuntimePropertyBindingControl {
  bound: boolean;
  summary?: string;
  error?: string;
  edit: () => void;
}

/** Authoring rows share the selected component's binding dialog through React context. */
export const RuntimePropertyBindingContext = createContext<((target: string) => RuntimePropertyBindingControl | undefined) | null>(null);

export function RuntimePropertyRow({ target, label, children, hint, title, id, className = "", designTime = false }: {
  target?: string; label: string; children: ReactNode; hint?: ReactNode; title?: string; id?: string; className?: string; designTime?: boolean;
}) {
  const generatedId = useId();
  const control = useContext(RuntimePropertyBindingContext);
  const binding = target ? control?.(target) : undefined;
  const controls = Children.map(children, child => {
    if (!isValidElement<{ id?: string; "aria-label"?: string; "aria-labelledby"?: string }>(child) || !["input", "select", "textarea"].includes(String(child.type))) return child;
    return cloneElement(child, { id: child.props.id || id || `${generatedId}-value`, ...(!child.props["aria-label"] && !child.props["aria-labelledby"] ? { "aria-labelledby": `${generatedId}-label` } : {}) });
  });
  return <div className={`property-sheet-row runtime-property-row${binding?.bound ? " is-bound" : ""}${className ? ` ${className}` : ""}`} data-property={target}>
    <label id={`${generatedId}-label`} htmlFor={id || `${generatedId}-value`} title={title}>{label}{designTime && <small className="property-design-time">Design time</small>}</label>
    <fieldset className="property-sheet-value" disabled={binding?.bound} aria-labelledby={`${generatedId}-label`}>{controls}</fieldset>
    {binding ? <button type="button" className="property-bind-button" aria-label={`${binding.bound ? "Edit" : "Add"} ${label} binding`} title={binding.bound ? `${binding.summary}\nClick to edit or remove binding` : `Bind ${label}`} onClick={binding.edit}>ƒx</button> : <span aria-hidden="true" />}
    {binding?.bound && <small className={binding.error ? "property-sheet-error" : "property-sheet-expression"} title={binding.error || binding.summary}>{binding.error || binding.summary}</small>}
    {hint && <small className="property-sheet-hint">{hint}</small>}
  </div>;
}
