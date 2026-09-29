import type { RuntimeParameters } from "./types";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Completion } from "@codemirror/autocomplete";
import { api } from "./api";
import Icon from "./Icon";
import ScriptEditor from "./ScriptEditor";
import type { CanvasComponent, InputValues } from "./types";
import "./componentEventEditor.css";

interface LibraryResource { name: string; type: string; enabled: boolean }
const systemCompletions: Completion[] = [
  { label: "system.tag.readBlocking", type: "function", detail: "Read current gateway tag values" },
  { label: "system.tag.writeBlocking", type: "function", detail: "Write configured memory tags" },
  { label: "system.db.runNamedQuery", type: "function", detail: "Execute a named query" },
  { label: "system.util.getLogger", type: "function", detail: "Create a named logger" },
  { label: "system.util.jsonEncode", type: "function" },
  { label: "system.util.jsonDecode", type: "function" },
  { label: "system.date.now", type: "function" },
  { label: "inputs", type: "variable", detail: "Current form values by field name" },
  { label: "parameters", type: "variable", detail: "Current screen or template parameters" },
  { label: "result", type: "variable", detail: "Returned result or message" },
  { label: "print", type: "function", detail: "Write to execution output" },
  ...["import", "from", "def", "return", "if", "else", "for", "True", "False", "None"].map(label => ({ label, type: "keyword" })),
];

/** A local draft applies as one canvas history entry; runtime execution stays in Preview. */
export default function ComponentEventEditor({ component, inputs, parameters, onApply, onClose }: {
  component: CanvasComponent;
  inputs: InputValues;
  parameters: RuntimeParameters;
  onApply: (script: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [code, setCode] = useState(component.props.script || "");
  const [libraries, setLibraries] = useState<LibraryResource[]>([]);
  const [libraryStatus, setLibraryStatus] = useState("Loading saved libraries…");
  const tooLong = code.length > 65536;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    let active = true;
    void api<{ resources: LibraryResource[] }>("/scripts/resources").then(result => {
      if (!active) return;
      const modules = result.resources.filter(resource => resource.type === "library");
      setLibraries(modules);
      setLibraryStatus(modules.length ? "Names from saved script resources. Publish enabled libraries before calling them." : "Create reusable modules in Scripting → Project library.");
    }).catch(() => { if (active) setLibraryStatus("Saved libraries could not be loaded. You can still edit this event."); });
    return () => { active = false; };
  }, []);
  const completions = useMemo<Completion[]>(() => [
    ...systemCompletions,
    ...libraries.map(resource => ({ label: `project.${resource.name}`, type: "namespace", detail: resource.enabled ? "Saved library · requires script publication" : "Saved library · currently disabled" })),
  ], [libraries]);
  const apply = () => { if (!tooLong) onApply(code); };

  return <dialog ref={dialog} className="component-event-dialog scripting-workspace" aria-labelledby="component-event-title" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    // Form and editor shortcuts stay inside this draft; Apply is its only canvas mutation.
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); apply(); }
  }}>
    <header className="component-event-heading">
      <div><small>COMPONENT EVENT · PYTHON 3</small><h2 id="component-event-title">{component.props.text || "Button"} · onClick</h2><p>Runs on the gateway when this button is activated in Preview or the operator application.</p></div>
      <button className="icon-button" aria-label="Close event editor" onClick={onClose}><Icon name="close" size={18} /></button>
    </header>
    <div className="component-event-body">
      <div className="component-event-code"><ScriptEditor value={code} language="python" onChange={setCode} completions={completions} onSave={apply} />
        <p className="component-event-note">Apply updates the project draft. Save and publish the project to make the event available to operators. Test by clicking the button in Preview.</p>
        {tooLong && <p role="alert" className="component-event-error">Scripts are limited to 65,536 characters.</p>}
      </div>
      <aside className="component-event-context" aria-label="Event context">
        <h3>Event context</h3><p>Form validation runs first. Python receives values and parameters; it does not receive a browser event or component object.</p>
        <h4>inputs</h4><p>Current form values, including edits made in Preview.</p><ul>{Object.keys(inputs).length ? Object.keys(inputs).map(key => <li key={key}><code>inputs[{JSON.stringify(key)}]</code><small>{typeof inputs[key]} · {String(inputs[key] ?? "null").slice(0, 80)}</small></li>) : <li>No fields on this screen.</li>}</ul>
        <h4>parameters</h4><ul>{Object.entries(parameters).length ? Object.entries(parameters).map(([key, value]) => <li key={key}><code>parameters[{JSON.stringify(key)}]</code><small>{value}</small></li>) : <li>No parameters declared.</li>}</ul>
        <h4>Result</h4><p><code>result = {"{\"message\": \"Saved\"}"}</code> returns a message to the application. Use <code>print()</code> for execution output.</p>
        <h4>System functions</h4><ul>{systemCompletions.filter(item => item.label.startsWith("system.")).map(item => <li key={item.label}><code>{item.label}</code>{item.detail && <small>{item.detail}</small>}</li>)}</ul>
        <h4>Project library</h4><p>{libraryStatus}</p><ul>{libraries.map(resource => <li key={resource.name}><code>project.{resource.name}</code>{!resource.enabled && <small>Disabled</small>}</li>)}</ul><p>Import a published module with <code>from project import module_name</code>.</p>
      </aside>
    </div>
    <footer className="component-event-footer"><span>Ctrl+S applies · Ctrl+Space completes</span><button className="button" onClick={onClose}>Cancel</button><button className="button primary" onClick={apply} disabled={tooLong}>Apply event</button></footer>
  </dialog>;
}
