import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Completion } from "@codemirror/autocomplete";
import ScriptEditor from "./ScriptEditor";
import { componentEventProperties } from "./componentEventModel";
import { isInput } from "./inputs";
import type { BindingTarget, CanvasComponent, InputValues, RuntimeParameters } from "./types";
import "./inputEvents.css";
import "./componentLifecycleEditor.css";

type EventName = "mount" | "propertyChange" | "unmount";
type EventDefinitions = NonNullable<CanvasComponent["props"]["componentEvents"]>;
const names: EventName[] = ["mount", "propertyChange", "unmount"];
const labels: Record<EventName, string> = { mount: "Mounted", propertyChange: "Property changed", unmount: "Unmounted" };
const descriptions: Record<EventName, string> = {
  mount: "Runs when this component enters Preview or the operator screen. Its initial property values establish a silent baseline; they do not generate property-change events.",
  propertyChange: "Runs when an observed value or its availability changes, including binding, script and input updates. Equal values are suppressed. These automatic events do not generate user input change/commit events.",
  unmount: "Cleanup only: runs when this component leaves its context. Its signal is already aborted; state.get reads the captured snapshot. Writes and notifications do nothing. Register resource cleanup with app.onCleanup while mounted.",
};

/** All automatic handlers are one local draft and one canvas history step. */
export default function ComponentLifecycleEditor({ component, components, inputs, parameters, instanceStateAvailable = false, onApply, onClose }: {
  component: CanvasComponent; components: CanvasComponent[]; inputs: InputValues; parameters: RuntimeParameters; instanceStateAvailable?: boolean;
  onApply: (events: EventDefinitions) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [selected, setSelected] = useState<EventName>("mount");
  const [code, setCode] = useState<Record<EventName, string>>({ mount: component.props.componentEvents?.mount?.code || "", propertyChange: component.props.componentEvents?.propertyChange?.code || "", unmount: component.props.componentEvents?.unmount?.code || "" });
  const [properties, setProperties] = useState<BindingTarget[]>(() => [...(component.props.componentEvents?.propertyChange?.properties || [])]);
  const [error, setError] = useState("");
  const allowed = componentEventProperties(component);
  const unsupported = properties.filter(property => !allowed.includes(property));
  const configured = names.filter(name => code[name].trim()).length;
  const fields = components.filter(item => isInput(item.type) && item.type !== "passwordInput");
  useEffect(() => {
    const element = dialog.current, previousFocus = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => { element?.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  const completions = useMemo<Completion[]>(() => [
    { label: "event.type", type: "property", detail: "mount, propertyChange or unmount" },
    { label: "event.componentId", type: "property", detail: "Source component ID" },
    ...["property", "value", "previousValue", "available", "previousAvailable", "error", "previousError"].map(name => ({ label: `event.${name}`, type: "property", detail: "Property-change payload only" })),
    { label: "inputs", type: "variable", detail: "Frozen form snapshot; passwords omitted" },
    { label: "parameters", type: "variable", detail: "Frozen screen or template parameter snapshot" },
    { label: "app.notify", type: "function", detail: "Local notification; unavailable during cleanup" },
    { label: "app.setInput", type: "function", detail: "Set a validated input in this form without user input events" },
    { label: "app.state.get", type: "function", detail: instanceStateAvailable ? "Read session, screen or private instance state" : "Read declared session or screen state" },
    { label: "app.state.set", type: "function", detail: "Update typed local state; unavailable during cleanup" },
    { label: "app.state.reset", type: "function", detail: "Restore declared defaults; unavailable during cleanup" },
    { label: "app.signal", type: "property", detail: "AbortSignal for canceled, timed-out or closed contexts" },
    { label: "app.onCleanup", type: "function", detail: "Register timer/listener cleanup for this component lifetime" },
  ], [instanceStateAvailable]);
  function apply() {
    const next: EventDefinitions = {};
    for (const type of names) {
      if (!code[type].trim()) continue;
      const fail = (message: string) => { setSelected(type); setError(`${labels[type]}: ${message}`); };
      if (code[type].length > 65536) { fail("use at most 65,536 characters."); return; }
      if (type === "propertyChange" && (properties.length < 1 || properties.length > 16 || new Set(properties).size !== properties.length || unsupported.length)) {
        fail("choose 1–16 unique properties supported by this component."); return;
      }
      try { new Function("event", "inputs", "parameters", "app", `"use strict"; return (async () => {\n${code[type]}\n})();`); }
      catch (reason) { fail(reason instanceof Error ? reason.message : String(reason)); return; }
      if (type === "propertyChange") next.propertyChange = { language: "javascript", code: code[type], properties: [...properties] };
      else next[type] = { language: "javascript", code: code[type] };
    }
    onApply(next);
  }
  const changeCode = (value: string) => { setError(""); setCode(previous => ({ ...previous, [selected]: value })); };
  const changeProperty = (property: BindingTarget, checked: boolean) => {
    setError(""); setProperties(previous => checked ? previous.includes(property) ? previous : [...previous, property] : previous.filter(item => item !== property));
  };
  return <dialog ref={dialog} className="input-events-dialog component-lifecycle-dialog scripting-workspace" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); apply(); }
    }}>
    <header className="input-events-heading"><div><small>COMPONENT EVENTS · BROWSER JAVASCRIPT</small><h2 id={titleId}>{component.props.text || component.id}</h2><p>Automatic local behavior in Preview and the operator application. {configured} of 3 handlers configured.</p></div><button type="button" aria-label="Close component events" onClick={onClose}>×</button></header>
    <div className="input-events-tabs" role="tablist" aria-label="Component event type">{names.map(type => <button key={type} type="button" role="tab" aria-selected={selected === type} className={selected === type ? "active" : ""} onClick={() => { setSelected(type); setError(""); }}>{labels[type]}<span>{code[type].trim() ? "Configured" : "Empty"}</span></button>)}</div>
    <div className="input-events-body">
      <section className="input-events-source" aria-label={`${selected} component script`}>
        <p className="input-events-description">{descriptions[selected]}</p>
        {selected === "propertyChange" && <fieldset className="component-event-properties"><legend>Watched properties · {properties.length}/16</legend>
          <div>{allowed.map(property => <label key={property}><input type="checkbox" aria-label={`Watch ${property}`} checked={properties.includes(property)} disabled={!properties.includes(property) && properties.length >= 16} onChange={event => changeProperty(property, event.target.checked)} />{property === "value" && isInput(component.type) ? "Input value" : property}</label>)}</div>
          {unsupported.map((property, index) => <p className="input-events-error" key={`${property}:${index}`}>Unsupported property: {property} <button type="button" className="button small" aria-label={`Remove unsupported watched property ${property}`} onClick={() => changeProperty(property, false)}>Remove</button></p>)}
          <p>Select the values to observe. Selection order is retained; removing a property does not change the order of the others.</p>
        </fieldset>}
        <ScriptEditor key={selected} value={code[selected]} language="javascript" onChange={changeCode} onSave={apply} completions={completions} />
        <p className={`component-event-count${code[selected].length > 65536 ? " is-invalid" : ""}`}>{code[selected].length.toLocaleString()} / 65,536 characters</p>
        {error && <p className="input-events-error" role="alert">{error}</p>}
        <p className="input-events-description">Leave a handler empty to remove it. Apply changes the project draft in one undo step; save and publish to deploy. Automatic events still run for hidden or disabled components and read-only operators.</p>
      </section>
      <aside className="input-events-context" aria-label="Component event context">
        <h3>Event payload</h3><pre>{selected === "propertyChange" ? `event = {\n  type: "propertyChange",\n  componentId, property,\n  value, previousValue,\n  available, previousAvailable,\n  error, previousError\n}` : `event = {\n  type: "${selected}",\n  componentId\n}`}</pre>
        <p>Property values are typed scalars. Check availability and errors before using values. Initial values establish a baseline; later programmatic changes are observed.</p>
        <h4>Local helpers</h4><p><code>app.setInput(field, value)</code> validates an input in this form. <code>app.state.get/set/reset</code> uses declared session or screen state{instanceStateAvailable && ", or this template's private instance state"}. Neither helper performs a gateway or database write.</p>
        <h4>Cancellation and cleanup</h4><p>Pass <code>app.signal</code> to abortable work. Register <code>app.onCleanup(() =&gt; clearInterval(timer))</code> to release a timer or listener when the component closes. Unmounted is cleanup only; state reads use a captured snapshot and writes/notifications do nothing.</p>
        <details className="component-event-limits"><summary>Execution limits</summary><p>Handlers run in order with a 2-second async deadline; cleanup has 1 second. Each component queues at most 32 events. Automatic events stop after 512 mount/property events in one second or 128 property changes without a quiet break. A break means 50 milliseconds with no queued or running handlers. Reopen the screen or restart Preview after fixing an event loop. Errors appear in the owner diagnostics.</p><p>Scripts are trusted JavaScript, not a sandbox. A synchronous infinite loop cannot be interrupted by these deadlines. Design handlers to finish and avoid feedback loops.</p></details>
        <h4>Form snapshot</h4><ul>{fields.length ? fields.map(item => { const key = item.props.fieldKey || item.id; return <li key={item.id}><code>{key}</code><small>{item.type} · {String(inputs[key] ?? "Unavailable").slice(0, 90)}</small></li>; }) : <li>No non-password inputs.</li>}</ul>
        <h4>Parameters</h4><ul>{Object.entries(parameters).length ? Object.entries(parameters).map(([key, value]) => <li key={key}><code>{key}</code><small>{String(value)}</small></li>) : <li>No parameters.</li>}</ul><p>Inputs and parameters are frozen snapshots. Password values are omitted.</p>
      </aside>
    </div>
    <footer className="input-events-footer"><span>Ctrl+S applies · Ctrl+Space completes</span><button type="button" className="button" onClick={onClose}>Cancel</button><button type="button" className="button primary" onClick={apply}>Apply component events</button></footer>
  </dialog>;
}
