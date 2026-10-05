import { useMemo, useState } from "react";
import { definitionKey, type ModelDefinition } from "./modelWorkspace";
import { writeBuilderDrag, type BuilderDrag } from "./modelBuilderLibrary";
import { ModelPopover } from "./ModelMenu";
import Icon from "./Icon";

type Props = { types: ModelDefinition[]; savedTypes: ModelDefinition[]; selected: string; disabled?: boolean; libraryOpen: boolean; onToggleLibrary: () => void; onSelect: (key: string) => void; onAdd: (drag: BuilderDrag) => void };
/** Model page tools: version, the data library and composition. Choosing a model happens in the explorer. */
export default function ModelBuilderToolbar({ types, savedTypes, selected, disabled, libraryOpen, onToggleLibrary, onSelect, onAdd }: Props) {
  const [query, setQuery] = useState("");
  const saved = useMemo(() => new Set(savedTypes.map(definitionKey)), [savedTypes]);
  const current = types.find(type => definitionKey(type) === selected), editable = Boolean(current && !saved.has(selected) && !disabled);
  const versions = types.filter(type => type.id === current?.id).sort((a, b) => b.version - a.version);
  const latest = useMemo(() => { const index = new Map<string, ModelDefinition>(); for (const type of types) if (!index.has(type.id) || index.get(type.id)!.version < type.version) index.set(type.id, type); return [...index.values()].sort((a, b) => a.id.localeCompare(b.id)); }, [types]);
  const matches = latest.filter(type => type.id !== current?.id && type.id.toLowerCase().includes(query.toLowerCase()));
  if (!current) return null;
  return <section className="model-builder-topbar" aria-label={`${current.id} tools`}>
    <label className="model-version-control">Version<select aria-label={`${current.id} version`} value={selected} disabled={disabled} onChange={event => onSelect(event.target.value)}>{versions.map(type => { const key = definitionKey(type); return <option key={key} value={key}>v{type.version}{saved.has(key) ? " · saved" : " · draft"}</option>; })}</select></label>
    <div className="model-topbar-actions"><button type="button" className="button small" aria-pressed={libraryOpen} disabled={disabled} onClick={onToggleLibrary}><Icon name={libraryOpen ? "close" : "tag"} size={15} />{libraryOpen ? "Hide data library" : "Add fields from data"}</button>
    <ModelPopover label="Add a model inside" icon="plus" small disabled={!editable} role="dialog" title={editable ? "Reuse another model as a group of fields" : "Edit a draft version to add a model inside"}>{close => <>
      <label>Find a model<input value={query} placeholder="Search model names…" onChange={event => setQuery(event.target.value)} /></label>
        <div className="model-picker-results" aria-label="Models to add inside">{matches.slice(0, 100).map(type => { const key = definitionKey(type); return <div key={type.id}><button type="button" disabled={!editable} draggable={editable} onDragStart={event => writeBuilderDrag(event, { kind: "type", path: key })} onClick={() => { onAdd({ kind: "type", path: key }); close(); }}>{type.id}<small>v{type.version}{saved.has(key) ? "" : " · draft"}</small></button></div>; })}</div>
        {!matches.length && <p className="model-help">{latest.length > 1 ? "No matching models." : "Create another model first."}</p>}{matches.length > 100 && <p className="model-help">Showing 100 of {matches.length}. Search to narrow the list.</p>}
      </>}
    </ModelPopover></div>
  </section>;
}
