import { useMemo, useState } from "react";
import { displayValue } from "./api";
import type { Tag } from "./types";
import { definitionKey, type ModelDefinition, type ModelInstance, type ModelPackage } from "./modelWorkspace";
import { resolveModelInstance, type ModelResolvedMember } from "./modelResolution";
import { modelEquipmentReadiness, modelQualityLabel, modelReadinessContext } from "./modelReadiness";
import { moveModelInstances } from "./modelWorkspaceNamespace";
import { ModelParameterValues } from "./modelWorkspaceFields";
import { ModelOverrides } from "./modelWorkspaceInstances";
import { BuilderDialog } from "./modelBuilderPanels";
import { memberSummary } from "./modelBuilderShell";
import { modelCrumb, modelParentPath, modelPathName, modelRoot, type ModelFocus } from "./modelExplorer";
import type { ModelSourceTag } from "./modelBuilderOperations";
import type { ModelOperationTool } from "./modelOperationsPanel";

type Props = { model: ModelPackage; savedModel: ModelPackage; path: string; sourceTags: ModelSourceTag[]; liveTags: Tag[]; onChange: (model: ModelPackage) => void; onFocus: (focus: ModelFocus) => void; onOpenModel: (key: string, member?: string) => void; onTool: (tool: ModelOperationTool, path: string) => void; onAnnounce: (message: string) => void };
type Row = { member: ModelResolvedMember; value: string; quality: string; tone: "good" | "warn" | "muted" };
const kindLabel: Record<string, string> = { reference: "Linked", memory: "Value", expression: "Formula", type: "Model", opcua: "OPC UA", device: "Device" };
const pillTone: Record<string, string> = { ready: "good", issue: "warn", waiting: "muted", setup: "muted" };

function liveRow(member: ModelResolvedMember, live: Map<string, Tag>, saved: boolean): Row {
  if (member.status === "invalid") return { member, value: "—", quality: member.message || "Needs setup", tone: "warn" };
  const tag = live.get(member.concretePath);
  if (!saved || !tag) return { member, value: "—", quality: saved ? "No value yet" : "Not applied yet", tone: "muted" };
  const good = /^Good/i.test(tag.quality || "");
  return { member, value: displayValue(tag.value), quality: good ? "Good" : modelQualityLabel(tag.quality || ""), tone: good ? "good" : "warn" };
}
function ruleSummary(member: ModelResolvedMember): string[] {
  const rules: string[] = [];
  if (member.range) rules.push(`Normal range ${member.range.low} – ${member.range.high}${member.unit ? ` ${member.unit}` : ""}`);
  if (member.freshnessMs) rules.push(`Marked stale after ${member.freshnessMs / 1000} s without data`);
  if (member.enumValues?.length) rules.push(`Allowed values: ${member.enumValues.map(String).join(", ")}`);
  for (const alarm of member.alarms ?? []) rules.push(`Alarm “${alarm.name}”: ${alarm.mode === "high" ? "at or above" : alarm.mode === "low" ? "at or below" : "equals"} ${alarm.setpoint}`);
  return rules;
}

export default function ModelMachineView(props: Props) {
  const index = props.model.instances.findIndex(item => item.path === props.path), instance = props.model.instances[index];
  const [field, setField] = useState(""), [removing, setRemoving] = useState(false);
  if (!instance) return <section className="model-page-card"><h2>Machine not found</h2><p className="model-help">This machine is no longer in your draft.</p><button type="button" className="button" onClick={() => props.onFocus({ kind: "location", path: modelRoot })}>Show all equipment</button></section>;
  const pinned = props.model.udtDefinitions.find(item => item.id === instance.definitionId && item.version === instance.version);
  const change = (next: ModelInstance) => props.onChange({ ...props.model, instances: props.model.instances.map((item, at) => at === index ? next : item) });
  return <div className="model-detail-split">
    <div className="model-detail-main">
      <MachineHeader {...props} instance={instance} pinned={pinned} onRemove={() => setRemoving(true)} />
      <LiveData {...props} instance={instance} selected={field} onSelect={setField} />
      <MachineSettings {...props} instance={instance} pinned={pinned} onChangeInstance={change} />
    </div>
    {field && <FieldInspector {...props} instance={instance} path={field} onClose={() => setField("")} />}
    {removing && <BuilderDialog title={`Remove ${modelPathName(instance.path)}?`} onClose={() => setRemoving(false)}><p>This removes the machine from your draft. Its tags are removed when you apply. The model itself is kept.</p><footer><button type="button" className="button danger" onClick={() => { setRemoving(false); props.onChange({ ...props.model, instances: props.model.instances.filter((_item, at) => at !== index) }); props.onFocus({ kind: "location", path: modelParentPath(instance.path) || modelRoot }); props.onAnnounce(`Removed ${modelPathName(instance.path)} from your draft.`); }}>Remove machine</button></footer></BuilderDialog>}
  </div>;
}

function useMachineState(props: Props, instance: ModelInstance) {
  const resolution = useMemo(() => resolveModelInstance(instance, props.model.udtDefinitions, props.sourceTags, props.model.instances, props.model.mappingProfiles), [instance, props.model, props.sourceTags]);
  const readiness = useMemo(() => modelEquipmentReadiness(instance, resolution, modelReadinessContext(props.model, props.savedModel, props.liveTags)), [instance, resolution, props.model, props.savedModel, props.liveTags]);
  const saved = props.savedModel.instances.some(item => item.path === instance.path && item.definitionId === instance.definitionId && item.version === instance.version);
  return { resolution, readiness, saved };
}

function MachineHeader(props: Props & { instance: ModelInstance; pinned?: ModelDefinition; onRemove: () => void }) {
  const { instance } = props, { readiness, saved } = useMachineState(props, instance);
  const crumb = modelCrumb(instance.path);
  return <section className="model-page-card model-page-head">
    <div className="model-page-title">
      <span className="model-crumb">{crumb || "Not in a location"}</span>
      <div className="model-title-row"><h2>{modelPathName(instance.path)}</h2>{readiness && <span className={`model-state-pill ${pillTone[readiness.state]}`} title={readiness.message}>{readiness.label}</span>}{!saved && <span className="model-state-pill muted">Draft</span>}</div>
      <p className="model-help">Uses model <button type="button" className="model-chip-button" onClick={() => props.onOpenModel(`${instance.definitionId}@${instance.version}`)}>{instance.definitionId} · v{instance.version}</button>{props.pinned ? "" : " (this version is missing)"}</p>
    </div>
    <div className="model-page-actions">
      <button type="button" className="button small" disabled={!saved} title={saved ? undefined : "Apply your draft before checking live values"} onClick={() => props.onTool("live", instance.path)}>Inspect live values</button>
      <button type="button" className="button small" disabled={!saved} onClick={() => props.onTool("issues", instance.path)}>Data issues</button>
      <button type="button" className="button small danger" onClick={props.onRemove}>Remove</button>
    </div>
  </section>;
}

function LiveData(props: Props & { instance: ModelInstance; selected: string; onSelect: (path: string) => void }) {
  const { resolution, saved } = useMachineState(props, props.instance);
  const live = useMemo(() => new Map(props.liveTags.map(tag => [tag.path, tag])), [props.liveTags]);
  const rows = useMemo(() => resolution.members.map(member => liveRow(member, live, saved)), [resolution, live, saved]);
  return <section className="model-page-card model-page-table" aria-label="Live data">
    <header><h3>Live data</h3><small>{saved ? "Select a field for its details and data rules." : "Values appear after you review and apply this machine."}</small></header>
    <div className="model-table-scroll"><table className="model-data-table"><thead><tr><th>Field</th><th>Value</th><th>Quality</th><th>Comes from</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.member.path} className={props.selected === row.member.path ? "selected" : undefined}>
        <td><button type="button" className="model-row-button" onClick={() => props.onSelect(row.member.path)}>{row.member.path}</button></td>
        <td className="model-value-cell"><strong>{row.value}</strong>{row.member.unit && <small> {row.member.unit}</small>}</td>
        <td><span className={`model-state-pill ${row.tone}`}>{row.quality}</span></td>
        <td className="model-source-cell" title={memberSummary(row.member) || ""}>{memberSummary(row.member) || "—"}</td>
      </tr>)}</tbody></table></div>
    {!rows.length && <p className="model-help">This model has no fields yet.</p>}
  </section>;
}

function MachineSettings(props: Props & { instance: ModelInstance; pinned?: ModelDefinition; onChangeInstance: (next: ModelInstance) => void }) {
  const { instance, pinned, onChangeInstance } = props, [name, setName] = useState(modelPathName(instance.path)), [error, setError] = useState("");
  const versions = props.model.udtDefinitions.filter(item => item.id === instance.definitionId).sort((a, b) => b.version - a.version);
  const profiles = (props.model.mappingProfiles || []).filter(profile => profile.definitionId === instance.definitionId && profile.version === instance.version);
  const location = modelParentPath(instance.path), locations = props.model.hierarchy.map(node => node.path).sort();
  function rename() {
    const trimmed = name.trim(), next = `${location}/${trimmed}`;
    if (!trimmed || /[/\\[\]{}]/.test(trimmed)) { setError("Use a name without slashes, brackets or braces."); return; }
    if (props.model.instances.some(item => item.path === next && item !== instance)) { setError(`Another machine is already named ${trimmed} here.`); return; }
    setError(""); onChangeInstance({ ...instance, path: next }); props.onFocus({ kind: "machine", path: next });
  }
  function move(destination: string) {
    try { const next = moveModelInstances(props.model, [instance.path], destination); props.onChange(next); props.onFocus({ kind: "machine", path: `${destination}/${modelPathName(instance.path)}` }); props.onAnnounce(`Moved to ${modelPathName(destination)}. Review changed paths before applying.`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <section className="model-page-card" aria-label="Machine settings">
    <header><h3>This machine’s settings</h3><small>The model asks each machine for these values.</small></header>
    <div className="model-grid">
      <label>Name<input value={name} onChange={event => setName(event.target.value)} onBlur={() => { if (name.trim() !== modelPathName(instance.path)) rename(); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); rename(); } }} /></label>
      <label>Location<select value={locations.includes(location) ? location : ""} onChange={event => { if (event.target.value) move(event.target.value); }}>{!locations.includes(location) && <option value="">{location.replace(/^\[default\]\/?/, "") || "Top level"} (folder)</option>}{locations.map(path => <option key={path} value={path}>{path.replace(/^\[default\]\/?/, "")}</option>)}</select></label>
      <label>Model version<select value={definitionKey({ id: instance.definitionId, version: instance.version })} onChange={event => { const version = Number(event.target.value.split("@").at(-1)); onChangeInstance({ ...instance, version }); }}>{versions.map(type => <option key={type.version} value={definitionKey(type)}>v{type.version}</option>)}</select></label>
      {profiles.length > 0 && <label>How this machine connects<select value={instance.mappingProfileId || ""} onChange={event => onChangeInstance({ ...instance, mappingProfileId: event.target.value || undefined })}><option value="">Sources from the model</option>{profiles.map(profile => <option key={profile.id}>{profile.id}</option>)}</select></label>}
    </div>
    {error && <p className="model-warning" role="alert">{error}</p>}
    <label className="model-checkbox"><input type="checkbox" checked={instance.enabled !== false} onChange={event => onChangeInstance({ ...instance, enabled: event.target.checked })} />Collect data for this machine</label>
    {pinned && (pinned.parameters?.length ? <ModelParameterValues parameters={pinned.parameters} values={instance.parameters} onChange={parameters => onChangeInstance({ ...instance, parameters })} /> : <p className="model-help">This model doesn’t ask for any machine-specific values.</p>)}
    {pinned && <details className="model-advanced"><summary>Advanced: change individual fields for this machine</summary><p className="model-help">Override a source or setting when this machine differs from the model.</p><ModelOverrides value={instance} onChange={onChangeInstance} definition={pinned} definitions={props.model.udtDefinitions} /></details>}
  </section>;
}

function FieldInspector(props: Props & { instance: ModelInstance; path: string; onClose: () => void }) {
  const { resolution } = useMachineState(props, props.instance);
  const member = resolution.members.find(item => item.path === props.path);
  if (!member) return null;
  const rules = ruleSummary(member), top = member.path.split("/")[0];
  return <aside className="model-page-card model-field-inspector" aria-label={`${member.path} details`}>
    <header><h3>{member.path}</h3><button type="button" className="button small" aria-label="Close field details" onClick={props.onClose}>×</button></header>
    <dl><dt>Kind</dt><dd>{kindLabel[member.kind] || member.kind}</dd><dt>Comes from</dt><dd className="model-source-cell">{memberSummary(member) || "—"}</dd><dt>Type</dt><dd>{member.dataType || "—"}</dd><dt>Unit</dt><dd>{member.unit || "—"}</dd>{member.description && <><dt>Meaning</dt><dd>{member.description}</dd></>}</dl>
    <section><h4>Data rules</h4>{rules.length ? <ul>{rules.map(rule => <li key={rule}>{rule}</li>)}</ul> : <p className="model-help">No range, staleness or alarm rules yet.</p>}<p className="model-help">Out-of-range or stale values stay visible but are marked uncertain. Rules and alarms apply to every machine using this model.</p></section>
    <button type="button" className="button small" onClick={() => props.onOpenModel(`${props.instance.definitionId}@${props.instance.version}`, top)}>Edit field and data rules</button>
  </aside>;
}
