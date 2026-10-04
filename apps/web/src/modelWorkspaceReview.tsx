import { useMemo, useState } from "react";
import { displayValue } from "./api";
import { definitionKey } from "./modelWorkspace";
import type { ModelExpandedTag, ModelPackage, ModelPreview } from "./modelWorkspace";
import { resolveModelInstances } from "./modelResolution";
import type { ModelSourceTag } from "./modelBuilderOperations";
export function modelPreviewField(member: Record<string, unknown>, field: string): unknown { if (field.startsWith("inputs.")) return (member.inputs as Record<string, string> | undefined)?.[field.slice(7)]; return member[field]; }

export function ModelReferenceTargets({ tags = [], changedOnly = false }: { tags?: ModelExpandedTag[]; changedOnly?: boolean }) {
  const [filter, setFilter] = useState(""), [page, setPage] = useState(0);
  const references = tags.filter(tag => tag.kind === "reference"), search = filter.toLowerCase();
  const matching = references.filter(tag => tag.path.toLowerCase().includes(search) || tag.target?.toLowerCase().includes(search));
  const offset = Math.min(page, Math.max(0, Math.ceil(matching.length / 100) - 1)) * 100;
  if (!references.length) return null;
  const heading = changedOnly ? "Reference targets affected by these changes" : "Reference targets after apply";
  return <section aria-label={heading}><h4>{heading} ({references.length.toLocaleString()})</h4>
    <p>Read permission on a reference path exposes its target's value, even when that user cannot read the target path directly. Configuration administrators must review these exposures before applying.</p>
    <label>Filter reference path or target<input value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }} /></label>
    <div style={{ maxHeight: 320, overflow: "auto" }}><table className="data-table"><thead><tr><th>Reference path</th><th>Resolved target</th><th>Data type</th></tr></thead><tbody>{matching.slice(offset, offset + 100).map(tag => <tr key={tag.path}><td style={{ overflowWrap: "anywhere" }}><code>{tag.path}</code></td><td style={{ overflowWrap: "anywhere" }}><code>{tag.target || "Unresolved target"}</code></td><td>{tag.dataType}</td></tr>)}</tbody></table></div>
    <nav aria-label="Reference target pages" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><small>Showing {matching.length ? offset + 1 : 0}–{Math.min(offset + 100, matching.length)} of {matching.length} matching references · {references.length} total</small><button type="button" className="button small" disabled={!offset} onClick={() => setPage(page - 1)}>Previous reference targets</button><button type="button" className="button small" disabled={offset + 100 >= matching.length} onClick={() => setPage(page + 1)}>Next reference targets</button></nav>
    <p>{changedOnly ? "These references belong to changed fields, equipment or models. Select Show unchanged items to review all references in the resulting configuration." : "These are the references in the resulting configuration, including unchanged paths."} Targets include resolved parameters and overrides.</p></section>;
}

export interface ModelReviewRow { change: ModelPreview["changes"][number]; group: string; typeKey?: string; instancePath?: string; order: number }
export function modelReviewRows(preview: ModelPreview, model?: ModelPackage, includeUnchanged = false): ModelReviewRow[] {
  const expanded = new Map((preview.expandedTags || []).map(tag => [tag.path, tag]));
  const instances = new Map((model?.instances || []).map(instance => [instance.path, `${instance.definitionId}@${instance.version}`]));
  for (const tag of expanded.values()) if (tag.udtInstance && tag.udtDefinition) instances.set(tag.udtInstance, `${tag.udtDefinition}@${tag.udtVersion}`);
  const roots = [...new Set([...instances.keys(), ...preview.changes.filter(change => change.kind === "instances").map(change => change.path)])].sort((left, right) => right.length - left.length);
  const rows = preview.changes.filter(change => includeUnchanged || change.action !== "unchanged").map(change => {
    if (change.kind === "udtDefinitions") return { change, group: `Type ${change.path}`, typeKey: change.path, order: 0 };
    const instancePath = expanded.get(change.path)?.udtInstance || roots.find(root => change.path === root || change.path.startsWith(root + "/"));
    if (instancePath) return { change, group: `Type ${instances.get(instancePath) || "(removed)"}`, typeKey: instances.get(instancePath), instancePath, order: change.path === instancePath ? 1 : 2 };
    return { change, group: change.kind === "hierarchy" ? "Hierarchy" : change.kind === "scanGroups" ? "Scan groups" : change.kind === "provider" ? "Provider" : "Raw tags", order: 3 };
  });
  return rows.sort((left, right) => Number(!left.typeKey) - Number(!right.typeKey) || left.group.localeCompare(right.group)
    || (left.instancePath || "").localeCompare(right.instancePath || "") || left.order - right.order || left.change.path.localeCompare(right.change.path));
}
export function changedModelMembers(preview: ModelPreview): ModelExpandedTag[] {
  const paths = new Set(preview.changes.filter(change => change.action !== "unchanged").map(change => change.path));
  return (preview.expandedTags || []).filter(tag => paths.has(tag.path) || paths.has(tag.udtInstance || "") || paths.has(`${tag.udtDefinition}@${tag.udtVersion}`));
}
export interface ModelConflictTarget { path: string; label: string }
export function modelConflictTargets(preview: ModelPreview, model?: ModelPackage): ModelConflictTarget[][] {
  if (!preview.conflicts?.length) return [];
  const candidates = new Map<string, string>();
  for (const type of model?.udtDefinitions || []) candidates.set(definitionKey(type), `Open ${definitionKey(type)}`);
  for (const node of [...model?.instances || [], ...model?.hierarchy || []]) candidates.set(node.path, `Open ${node.path}`);
  for (const member of preview.expandedTags || []) if (member.udtInstance) candidates.set(member.path, `Open ${member.path}`);
  for (const change of preview.changes) candidates.set(change.path, `Open ${change.path}`);
  const sorted = [...candidates].sort(([left], [right]) => right.length - left.length);
  const states = model ? resolveModelInstances(model.instances, model.udtDefinitions, (model.tags || []) as ModelSourceTag[], model.mappingProfiles) : [];
  return (preview.conflicts || []).map(conflict => {
    const direct = sorted.filter(([path]) => conflict.includes(path));
    const paths = direct.filter(([path]) => !direct.some(([other]) => other !== path && other.startsWith(path + "/"))).slice(0, 8);
    if (!paths.length && model) for (let index = 0; index < states.length && paths.length < 8; index++) {
      const state = states[index];
      if ([...state.errors, ...state.members.flatMap(member => member.issues)].some(error => conflict.includes(error) || error.includes(conflict))) paths.push([model.instances[index].path, `Open ${model.instances[index].path}`]);
    }
    return paths.map(([path, label]) => ({ path, label }));
  });
}
function ReviewPath({ path, onNavigate }: { path: string; onNavigate?: (path: string) => void }) {
  return onNavigate ? <button type="button" className="button small" style={{ textAlign: "left", overflowWrap: "anywhere", whiteSpace: "normal" }} onClick={() => onNavigate(path)}>{path}</button> : <code>{path}</code>;
}
function ReviewConflicts({ conflicts, targets, onNavigate }: { conflicts: string[]; targets: ModelConflictTarget[][]; onNavigate?: (path: string) => void }) {
  const [page, setPage] = useState(0), [filter, setFilter] = useState("");
  const visible = conflicts.map((message, index) => ({ message, targets: targets[index] || [] })).filter(item => item.message.toLowerCase().includes(filter.toLowerCase()));
  const offset = Math.min(page, Math.max(0, Math.ceil(visible.length / 100) - 1)) * 100;
  if (!conflicts.length) return null;
  return <section className="security-error" role="alert"><h4>Resolve conflicts first ({conflicts.length.toLocaleString()})</h4>
    <label>Filter conflicts<input value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }} /></label>
    <ul>{visible.slice(offset, offset + 100).map((item, index) => <li key={offset + index}><p>{item.message}</p>{onNavigate && item.targets.map(target => <button type="button" className="button small" key={target.path} onClick={() => onNavigate(target.path)}>{target.label}</button>)}</li>)}</ul>
    <div className="model-actions"><small>Showing {visible.length ? offset + 1 : 0}–{Math.min(offset + 100, visible.length)} of {visible.length} conflicts</small><button type="button" className="button small" disabled={!offset} onClick={() => setPage(page - 1)}>Previous conflicts</button><button type="button" className="button small" disabled={offset + 100 >= visible.length} onClick={() => setPage(page + 1)}>Next conflicts</button></div></section>;
}
export default function ModelReview({ preview, model, onNavigate }: { preview: ModelPreview; model?: ModelPackage; onNavigate?: (path: string) => void }) {
  const [page, setPage] = useState(0), [memberPage, setMemberPage] = useState(0), [filter, setFilter] = useState(""), [changeFilter, setChangeFilter] = useState("");
  const [showUnchanged, setShowUnchanged] = useState(false);
  const changes = useMemo(() => modelReviewRows(preview, model, showUnchanged), [preview, model, showUnchanged]);
  const conflictTargets = useMemo(() => modelConflictTargets(preview, model), [preview, model]);
  const matching = changes.filter(row => `${row.group} ${row.instancePath || ""} ${row.change.path} ${row.change.kind} ${row.change.action}`.toLowerCase().includes(changeFilter.toLowerCase()));
  const offset = Math.min(page, Math.max(0, Math.ceil(matching.length / 100) - 1)) * 100;
  const affected = useMemo(() => changedModelMembers(preview), [preview]);
  const members = (showUnchanged ? preview.expandedTags || [] : affected).filter(tag => tag.udtInstance && tag.path.toLowerCase().includes(filter.toLowerCase()));
  const memberOffset = Math.min(memberPage, Math.max(0, Math.ceil(members.length / 100) - 1)) * 100;
  const pageRows = matching.slice(offset, offset + 100);
  return <section className="model-review" aria-label="Reviewed model changes"><ReviewConflicts conflicts={preview.conflicts || []} targets={conflictTargets} onNavigate={onNavigate} />
    <p>{preview.totalTags.toLocaleString()} / 10,000 concrete tags after apply · {changes.length.toLocaleString()} {showUnchanged ? "reviewed entries" : "changed entries"}</p>
    <label className="model-checkbox"><input type="checkbox" checked={showUnchanged} onChange={event => { setShowUnchanged(event.target.checked); setPage(0); setMemberPage(0); }} />Show unchanged items</label>
    <label>Filter changes by type, instance, member or action<input value={changeFilter} onChange={event => { setChangeFilter(event.target.value); setPage(0); }} /></label>
    <div className="model-table"><table className="data-table"><thead><tr><th>Action</th><th>Resource / path</th><th>Kind</th><th>Retained overrides</th></tr></thead><tbody>{pageRows.flatMap((row, index) => {
      const result = [], previous = pageRows[index - 1];
      if (!previous || previous.group !== row.group) result.push(<tr key={`group-${index}`}><th colSpan={4} scope="rowgroup">{row.group}</th></tr>);
      if (row.instancePath && previous?.instancePath !== row.instancePath) result.push(<tr key={`instance-${index}`}><th colSpan={4} scope="rowgroup">Instance <ReviewPath path={row.instancePath} onNavigate={onNavigate} /></th></tr>);
      result.push(<tr key={`change-${index}`}><td>{row.change.action}</td><td><ReviewPath path={row.change.path} onNavigate={onNavigate} /></td><td>{row.change.kind}</td><td>{row.change.overrideFields?.join(", ") || "—"}</td></tr>); return result;
    })}</tbody></table></div><div className="model-actions"><small>Showing {matching.length ? offset + 1 : 0}–{Math.min(offset + 100, matching.length)} of {matching.length} entries</small><button type="button" className="button small" disabled={!offset} onClick={() => setPage(page - 1)}>Previous changes</button><button type="button" className="button small" disabled={offset + 100 >= matching.length} onClick={() => setPage(page + 1)}>Next changes</button></div>
    <ModelReferenceTargets tags={showUnchanged ? preview.expandedTags : affected} changedOnly={!showUnchanged} />
    <details><summary>{showUnchanged ? "All" : "Changed"} fields and their sources ({members.length})</summary><label>Filter expanded path<input value={filter} onChange={event => { setFilter(event.target.value); setMemberPage(0); }} /></label>
      {members.slice(memberOffset, memberOffset + 100).map(member => <details className="model-card" key={member.path}><summary>{member.path} · {member.dataType} {member.unit}</summary><div className="model-table"><table className="data-table"><thead><tr><th>Field</th><th>Resolved value</th><th>Comes from</th></tr></thead><tbody>{Object.entries(member.fieldProvenance || {}).map(([field, source]) => <tr key={field}><td>{field}</td><td>{displayValue(modelPreviewField(member as unknown as Record<string, unknown>, field))}</td><td>{source}</td></tr>)}</tbody></table></div></details>)}
      <div className="model-actions"><small>{members.length ? memberOffset + 1 : 0}–{Math.min(memberOffset + 100, members.length)} of {members.length} members</small><button type="button" className="button small" disabled={!memberOffset} onClick={() => setMemberPage(memberPage - 1)}>Previous members</button><button type="button" className="button small" disabled={memberOffset + 100 >= members.length} onClick={() => setMemberPage(memberPage + 1)}>Next members</button></div></details>
    <p>Apply includes every reviewed change, including other pages. Any edit to this draft or the gateway configuration requires a fresh preview. Changes affect all projects immediately.</p></section>;
}
