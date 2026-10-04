import { ModelContractFields, ModelUnitField } from "./modelContractFields";
import { useId } from "react";
import type { Connection } from "./types";
import { connectionPoints, isPointConnection } from "./sourceConnections";
import { definitionKey, modelDataTypes, modelLeaves, type ModelDefinition, type ModelMember, type ModelPackage } from "./modelWorkspace";
import { ModelMetadataFields, ModelPairs, ModelParameters, ModelParameterValues, ModelScalarField } from "./modelWorkspaceFields";

type MemberProps = { value: ModelMember; onChange: (patch: Partial<ModelMember>) => void; model: ModelPackage; connections: Connection[]; tagPaths: string[] };
export function ModelSourceFields({ value, onChange, model, connections, tagPaths }: MemberProps) {
  const id = useId();
  return <><datalist id={`${id}-tags`}>{tagPaths.map(path => <option key={path} value={path} />)}</datalist>
    {value.kind === "memory" && <ModelScalarField label="Initial value or parameter" value={value.value} type={value.dataType} onChange={next => onChange({ value: next })} />}
    {value.kind === "reference" && <label>Existing target tag<input list={`${id}-tags`} value={value.target || ""} onChange={event => onChange({ target: event.target.value })} placeholder="[default]Sources/{Device}/Speed" /><small>Mirrors the target value, quality and timestamps. No additional acquisition; read-only.</small></label>}
    {value.kind === "expression" && <><label>Expression<input value={value.expression || ""} onChange={event => onChange({ expression: event.target.value })} placeholder="speed * 60" /></label><ModelPairs label="Inputs" stringsOnly value={value.inputs} suggestions={tagPaths} onChange={inputs => onChange({ inputs: inputs as Record<string, string> })} /><small>Use ./Member for a sibling in this type, or an existing concrete tag path.</small></>}
    {(value.kind === "device" || value.kind === "opcua") && <ModelConnectionFields value={value} onChange={onChange} model={model} connections={connections} tagPaths={tagPaths} />}
    {value.kind === "type" && <ModelNestedType value={value} onChange={onChange} model={model} connections={connections} tagPaths={tagPaths} />}
  </>;
}
function ModelConnectionFields({ value, onChange, connections }: MemberProps) {
  const id = useId(), candidates = connections.filter(connection => value.kind === "opcua" ? connection.type === "opcua" : isPointConnection(connection));
  const selected = candidates.find(connection => connection.id === value.connectionId), points = connectionPoints(selected);
  return <><datalist id={id}>{candidates.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</datalist><div className="model-grid"><label>Connection ID or parameter<input list={id} value={value.connectionId || ""} onChange={event => onChange({ connectionId: event.target.value })} placeholder="{PLC}" /></label><label>{value.kind === "opcua" ? "OPC UA node ID" : "Saved point ID"}<input value={value.nodeId || ""} onChange={event => onChange({ nodeId: event.target.value })} /></label></div>
    {value.kind === "device" && <label>Choose a saved point<select value={points.some(point => point.id === value.nodeId) ? value.nodeId : ""} onChange={event => { const point = points.find(item => item.id === event.target.value); if (point) onChange({ nodeId: point.id, dataType: point.dataType, writable: point.writable === true }); }}><option value="">Select a saved connection and point…</option>{points.map(point => <option key={point.id} value={point.id}>{point.name} · {point.dataType}</option>)}</select></label>}
    <details className="model-contract-section"><summary>Connection options</summary><p>Use the connection defaults unless this field needs different filtering or buffering.</p><div className="model-grid"><label>Absolute deadband<input type="number" min={0} value={value.absoluteDeadband ?? ""} placeholder="Connection default" onChange={event => onChange({ absoluteDeadband: event.target.value === "" ? undefined : Number(event.target.value) })} /></label><label>Queue size<input type="number" min={1} max={10000} value={value.queueSize ?? ""} placeholder="Connection default" onChange={event => onChange({ queueSize: event.target.value === "" ? undefined : Number(event.target.value) })} /></label></div>
    {value.kind === "device" && <label className="model-checkbox"><input type="checkbox" checked={value.writable === true} onChange={event => onChange({ writable: event.target.checked })} />Writable source (validated against connection)</label>}</details></>;
}
function ModelNestedType({ value, onChange, model }: MemberProps) {
  const child = model.udtDefinitions.find(item => item.id === value.definitionId && item.version === value.version);
  return <><label>Pinned nested type<select value={child ? definitionKey(child) : ""} onChange={event => { const next = model.udtDefinitions.find(item => definitionKey(item) === event.target.value); if (next) onChange({ definitionId: next.id, version: next.version, parameters: {} }); }}><option value="">Choose a saved type version…</option>{model.udtDefinitions.map(item => <option key={definitionKey(item)}>{definitionKey(item)}</option>)}</select></label>
    {child && <><ModelParameterValues parameters={child.parameters || []} values={value.parameters} onChange={parameters => onChange({ parameters })} /><small>Pass an outer parameter with a complete placeholder, such as {"{Device}"}.</small><details><summary>Nested members ({modelLeaves(child, model.udtDefinitions).length})</summary><ul>{modelLeaves(child, model.udtDefinitions).map(member => <li key={member.path}>{value.path}/{member.path} · {member.dataType} {member.unit}</li>)}</ul></details></>}</>;
}
function resetMemberKind(member: ModelMember, kind: ModelMember["kind"]): ModelMember {
  const { path, description, semanticType, attributes, unit, range } = member;
  const common = { path, kind, description, semanticType, attributes, unit, range };
  if (kind === "type") return { path, kind, parameters: {} };
  return { ...common, dataType: member.dataType || "Double", ...(kind === "memory" ? { value: 0 } : {}), ...(kind === "expression" ? { expression: "", inputs: {} } : {}) };
}
function ModelMemberCard({ value, onChange, onRemove, model, connections, tagPaths }: MemberProps & { onRemove: () => void }) {
  return <details className="model-card" open><summary>{value.path || "Unnamed member"} · {value.kind}</summary><div className="model-grid"><label>Relative member path<input value={value.path} onChange={event => onChange({ path: event.target.value })} /></label><label>Member kind<select value={value.kind} onChange={event => onChange(resetMemberKind(value, event.target.value as ModelMember["kind"]))}>{["memory", "expression", "opcua", "device", "reference", "type"].map(kind => <option key={kind}>{kind}</option>)}</select></label>
    {value.kind !== "type" && <label>Data type<select value={value.dataType || "Double"} onChange={event => onChange({ dataType: event.target.value })}>{modelDataTypes.map(type => <option key={type}>{type}</option>)}</select></label>}</div>
    <ModelSourceFields value={value} onChange={onChange} model={model} connections={connections} tagPaths={tagPaths} />
    {value.kind !== "type" && <><ModelMetadataFields value={value} onChange={onChange} /><ModelUnitField value={value} onChange={onChange} /><ModelContractFields value={value} onChange={onChange} includeSemantic={false} /></>}
    {value.kind !== "type" && <div className="model-grid"><label>Scan group<select value={value.scanGroup || ""} onChange={event => onChange({ scanGroup: event.target.value || undefined })}><option value="">Default interval</option>{model.scanGroups.map(group => <option key={group.name}>{group.name}</option>)}</select></label><label>Interval (ms)<input type="number" min={100} max={60000} value={value.publishingIntervalMs ?? 1000} onChange={event => onChange({ publishingIntervalMs: Number(event.target.value) })} /></label></div>}
    <div className="model-actions"><label className="model-checkbox"><input type="checkbox" checked={value.enabled !== false} onChange={event => onChange({ enabled: event.target.checked })} />Member enabled</label><button type="button" className="button danger" onClick={onRemove}>Remove member from draft</button></div></details>;
}
export default function ModelTypeEditor({ value, onChange, model, connections, tagPaths }: { value: ModelDefinition; onChange: (definition: ModelDefinition) => void; model: ModelPackage; connections: Connection[]; tagPaths: string[] }) {
  const patch = (next: Partial<ModelDefinition>) => onChange({ ...value, ...next });
  return <section className="model-editor" aria-label="Type editor"><p>Saved versions are immutable. Preview this new version, then explicitly upgrade selected instances.</p><div className="model-grid"><label>Type ID<input value={value.id} onChange={event => patch({ id: event.target.value })} /></label><label>New version<input type="number" min={1} max={1000000} value={value.version} onChange={event => patch({ version: Number(event.target.value) })} /></label></div>
    <ModelMetadataFields value={value} onChange={patch} /><ModelParameters parameters={value.parameters || []} onChange={parameters => patch({ parameters })} />
    <section><h3>Members ({value.members.length}/128)</h3>{value.members.map((member, index) => <ModelMemberCard key={index} value={member} model={model} connections={connections} tagPaths={tagPaths} onChange={next => patch({ members: value.members.map((item, offset) => offset === index ? next.kind && next.kind !== item.kind ? next as ModelMember : { ...item, ...next } : item) })} onRemove={() => patch({ members: value.members.filter((_item, offset) => offset !== index) })} />)}<button type="button" className="button" disabled={value.members.length >= 128} onClick={() => patch({ members: [...value.members, { path: `Member${value.members.length + 1}`, kind: "reference", dataType: "Double", target: "" }] })}>Add member</button></section></section>;
}
