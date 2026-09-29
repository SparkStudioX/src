import type { RuntimeParameters } from "./types";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Completion } from "@codemirror/autocomplete";
import ScriptEditor from "./ScriptEditor";
import { isInput } from "./inputs";
import type { CanvasComponent, InputEventType, InputValues } from "./types";
import "./inputEvents.css";

export interface InputEventsEditorProps {
  component: CanvasComponent;
  components: CanvasComponent[];
  inputs: InputValues;
  parameters: RuntimeParameters;
  instanceStateAvailable?: boolean;
  onApply: (events: CanvasComponent["props"]["events"]) => void;
  onClose: () => void;
}

/** Edits both events as one draft. Code runs only after actual operator input. */
export default function InputEventsEditor({ component, components, inputs, parameters, instanceStateAvailable = false, onApply, onClose }: InputEventsEditorProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<InputEventType>("change");
  const [code, setCode] = useState<Record<InputEventType, string>>({ change: component.props.events?.change?.code || "", commit: component.props.events?.commit?.code || "" });
  const [error, setError] = useState("");
  const fields = components.filter((item) => isInput(item.type));
  const fieldKey = component.props.fieldKey || component.id;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const completions = useMemo<Completion[]>(() => [
    { label: "event.type", type: "property", detail: "change or commit" },
    { label: "event.componentId", type: "property", detail: "Source component ID" },
    { label: "event.fieldKey", type: "property", detail: "Source input field name" },
    { label: "event.value", type: "property", detail: "Current operator-entered value" },
    { label: "event.previousValue", type: "property", detail: "Previous edit or last committed value" },
    { label: "app.notify", type: "function", detail: "Show a message on this input" },
    { label: "app.setInput", type: "function", detail: "Set a validated value in this form; no event retrigger" },
    { label: "app.state.get", type: "function", detail: instanceStateAvailable ? "Read declared session, screen or private instance state" : "Read a declared session or screen state property" },
    { label: "app.state.set", type: "function", detail: "Update typed local state and its bindings" },
    { label: "app.state.reset", type: "function", detail: "Restore one property or a scope to declared defaults" },
    { label: "inputs", type: "variable", detail: "Form values when the event occurred" },
    { label: "parameters", type: "variable", detail: "Current screen or template parameters" },
    ...["const", "let", "if", "else", "return", "await", "true", "false"].map((label) => ({ label, type: "keyword" })),
  ], [instanceStateAvailable]);
  function apply() {
    const events: NonNullable<CanvasComponent["props"]["events"]> = {};
    for (const type of ["change", "commit"] as const) {
      if (!code[type].trim()) continue;
      if (code[type].length > 65536) { setSelected(type); setError(`${type}: use at most 65,536 characters.`); return; }
      try { new Function("event", "inputs", "parameters", "app", `"use strict"; return (async () => {\n${code[type]}\n})();`); }
      catch (reason) { setSelected(type); setError(`${type}: ${reason instanceof Error ? reason.message : String(reason)}`); return; }
      events[type] = { language: "javascript", code: code[type] };
    }
    onApply(events);
  }
  const setSource = (value: string) => { setError(""); setCode((prior) => ({ ...prior, [selected]: value })); };
  return <dialog ref={dialog} className="input-events-dialog scripting-workspace" aria-labelledby="input-events-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => {
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); apply(); }
  }}>
    <header className="input-events-heading"><div><small>INPUT EVENTS · BROWSER JAVASCRIPT</small><h2 id="input-events-title">{component.props.text || fieldKey}</h2><p>Respond to user edits in Preview and the operator application. Handlers run in order for this control.</p></div><button type="button" aria-label="Close input events" onClick={onClose}>×</button></header>
    <div className="input-events-tabs" role="tablist" aria-label="Input event type">{(["change", "commit"] as const).map((type) => <button key={type} type="button" role="tab" aria-selected={selected === type} className={selected === type ? "active" : ""} onClick={() => { setSelected(type); setError(""); }}>{type === "change" ? "Value changed" : "Value committed"}<span>{code[type].trim() ? "Configured" : "Empty"}</span></button>)}</div>
    <div className="input-events-body">
      <section className="input-events-source" aria-label={`${selected} event script`}>
        <p className="input-events-description">{selected === "change" ? "Runs for each changed value entered by the user. previousValue is the prior edit. Initial values, tag updates, and scripted assignments do not trigger events." : "Runs once per changed value on Enter or blur (text areas: Ctrl+Enter or blur). Choice controls and spinner buttons commit immediately; sliders commit on release. previousValue is the last committed value."}</p>
        <ScriptEditor key={selected} value={code[selected]} language="javascript" onChange={setSource} onSave={apply} completions={completions} />
        {error && <p className="input-events-error" role="alert">{error}</p>}
        <p className="input-events-description" style={{ marginTop: 12, minHeight: 0 }}>Event values reflect the user's edit, including empty or invalid numeric text; check value types before calculations. Leave an event empty to remove its handler. Apply updates this project draft; save and publish to deploy it. Browser scripts are authored by trusted project developers.</p>
      </section>
      <aside className="input-events-context" aria-label="Input event context">
        <h3>Event context</h3><pre>{`event = {\n  type: "${selected}",\n  componentId: ${JSON.stringify(component.id)},\n  fieldKey: ${JSON.stringify(fieldKey)},\n  value,\n  previousValue\n}`}</pre>
        <h4>Local form helpers</h4><p><code>app.notify(message)</code> shows a message on this control.</p><p><code>app.setInput(field, value)</code> updates a declared input in this form. The value must match its type, bounds, and options. It does not run input events.</p>
        <h4>Application state</h4><p><code>app.state.get("session", "name")</code> reads a declared state property. Use <code>set(scope, name, value)</code> to update it and <code>reset(scope, name)</code> to restore its default. Omit the name to reset the whole scope. Scope is <code>"session"</code> or <code>"screen"</code>{instanceStateAvailable && <>, or <code>"instance"</code> inside this template</>}.</p><p>Values must match their declared types. Session state is shared within this runtime tab; screen state belongs to the current screen or popup. These local values are separate from gateway tags and database data.</p>
        {instanceStateAvailable && <p><code>app.state.get("instance", "name")</code> reads private state declared on this shared template. Each placement and repeater row owns independent values. Nested templates cannot access their parent's private state. Bound-context changes and closure reset or dispose these values.</p>}
        <h4>Example</h4><pre>{`if (event.value !== event.previousValue) {\n  app.notify("Value: " + event.value);\n}`}</pre>
        <h4>Form inputs</h4><ul>{fields.length ? fields.map((item) => { const key = item.props.fieldKey || item.id; return <li key={item.id}><code>{key}</code><small>{item.type} · {String(inputs[key] ?? "Unavailable").slice(0, 90)}</small></li>; }) : <li>No fields in this form.</li>}</ul>
        <h4>Parameters</h4><ul>{Object.keys(parameters).length ? Object.entries(parameters).map(([key, value]) => <li key={key}><code>{key}</code><small>{value}</small></li>) : <li>No parameters declared.</li>}</ul>
        <p style={{ marginTop: 16 }}>Each event receives a snapshot of <code>inputs</code> and <code>parameters</code>. Use button gateway scripts for database or tag operations.</p>
      </aside>
    </div>
    <footer className="input-events-footer"><span>Ctrl+S applies · Ctrl+Space completes</span><button type="button" className="button" onClick={onClose}>Cancel</button><button type="button" className="button primary" onClick={apply}>Apply events</button></footer>
  </dialog>;
}
