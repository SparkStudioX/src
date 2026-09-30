import { useEffect, useRef, useState } from "react";
import { commandDefinitionError } from "./EquipmentCommand";
import type { EquipmentCommandDefinition } from "./EquipmentCommand";
import type { Project } from "./types";

export default function EquipmentCommandsEditor({ project, onApply, onClose }: { project: Project; onApply: (commands: EquipmentCommandDefinition[]) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [commands, setCommands] = useState(project.commands ?? []);
  const [selected, setSelected] = useState(commands[0]?.id ?? "");
  const [error, setError] = useState("");
  const current = commands.find(command => command.id === selected);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const patch = (fields: Partial<EquipmentCommandDefinition>) => setCommands(previous => previous.map(command => command.id === selected ? { ...command, ...fields } : command));
  function add() { let index = commands.length + 1; while (commands.some(item => item.id === `command${index}`)) index++; const id = `command${index}`; setCommands([...commands, { id, name: `Command ${index}`, dataType: "Double", tagPath: "[default]Commands/Setpoint", min: 0, max: 100, confirmation: "Apply the requested setpoint?", timeoutMs: 3000 }]); setSelected(id); }
  function apply() {
    const invalid = commandDefinitionError(commands); if (invalid) { setError(invalid); return; }
    const missing = [...project.screens, ...project.templates ?? []].flatMap(item => item.components).find(item => item.type === "equipmentCommand" && !commands.some(command => command.id === item.props.commandId));
    if (missing) { setError(`Command control ${missing.id} still references a removed command.`); return; }
    onApply(commands); onClose();
  }
  return <dialog ref={dialog} className="project-dialog command-editor" onCancel={onClose} onKeyDown={event => event.stopPropagation()} aria-labelledby="commands-title"><header><h2 id="commands-title">Equipment commands</h2></header><div className="project-dialog-body">
    <p>Declare the equipment operations this project may request. Save and publish with the application. Operators also need the separate Commands permission. Confirmation and readback are required for every execution.</p>
    <div className="command-editor-select"><select aria-label="Configured command" value={selected} onChange={event => setSelected(event.target.value)}><option value="">Select a command</option>{commands.map(command => <option key={command.id} value={command.id}>{command.name}</option>)}</select><button className="button" onClick={add}>Add command</button></div>
    {current && <div className="command-fields">
      <label>Stable ID<input value={current.id} readOnly /></label><label>Name<input value={current.name} maxLength={128} onChange={event => patch({ name: event.target.value })} /></label>
      <label>Write tag path<input value={current.tagPath} onChange={event => patch({ tagPath: event.target.value })} /></label>
      <label>Scalar type<select value={current.dataType} onChange={event => { const dataType = event.target.value as EquipmentCommandDefinition["dataType"]; patch({ dataType, ...(["String", "Boolean"].includes(dataType) ? { min: undefined, max: undefined, tolerance: undefined } : { min: 0, max: 100 }), maxLength: dataType === "String" ? 128 : undefined }); }}>{["Boolean","Int16","Int32","Int64","Float","Double","String"].map(type => <option key={type}>{type}</option>)}</select></label>
      {!["String", "Boolean"].includes(current.dataType) && <><label>Minimum<input type="number" value={current.min ?? ""} onChange={event => patch({ min: Number(event.target.value) })} /></label><label>Maximum<input type="number" value={current.max ?? ""} onChange={event => patch({ max: Number(event.target.value) })} /></label><label>Readback tolerance<input type="number" min="0" value={current.tolerance ?? 0} onChange={event => patch({ tolerance: Number(event.target.value) })} /></label></>}
      {current.dataType === "String" && <label>Maximum text length<input type="number" min="1" max="1024" value={current.maxLength ?? 128} onChange={event => patch({ maxLength: Number(event.target.value) })} /></label>}
      <label>Readback tag (blank uses write tag)<input value={current.readbackPath ?? ""} onChange={event => patch({ readbackPath: event.target.value || undefined })} /></label>
      <label>Readback timeout (ms)<input type="number" min="100" max="10000" value={current.timeoutMs ?? 3000} onChange={event => patch({ timeoutMs: Number(event.target.value) })} /></label>
      <label className="command-wide">Confirmation text<textarea value={current.confirmation} maxLength={512} onChange={event => patch({ confirmation: event.target.value })} /></label>
      <button className="button" onClick={() => { setCommands(commands.filter(item => item.id !== selected)); setSelected(""); }}>Remove command</button>
    </div>}{error && <p role="alert">{error}</p>}
  </div><footer><button className="button" onClick={onClose}>Cancel</button><button className="button primary" onClick={apply}>Apply commands</button></footer></dialog>;
}
