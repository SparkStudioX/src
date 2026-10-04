import { useEffect, useMemo, useRef, useState } from "react";
import { definitionKey, type ModelDefinition } from "./modelWorkspace";
import { writeBuilderDrag, type BuilderDrag } from "./modelBuilderLibrary";

type Props = { types: ModelDefinition[]; savedTypes: ModelDefinition[]; selected: string; disabled?: boolean; onSelect: (key: string) => void; onNew: () => void; onUseStarter?: () => void; onAdd: (drag: BuilderDrag) => void };
export default function ModelBuilderToolbar({ types, savedTypes, selected, disabled, onSelect, onNew, onUseStarter, onAdd }: Props) {
  const [query, setQuery] = useState("");
  const picker = useRef<HTMLDetailsElement>(null), saved = useMemo(() => new Set(savedTypes.map(definitionKey)), [savedTypes]);
  const current = types.find(type => definitionKey(type) === selected), editable = Boolean(current && !saved.has(selected) && !disabled);
  const versions = types.filter(type => type.id === current?.id).sort((a, b) => b.version - a.version);
  const latest = useMemo(() => { const index = new Map<string, ModelDefinition>(); for (const type of types) if (!index.has(type.id) || index.get(type.id)!.version < type.version) index.set(type.id, type); return [...index.values()].sort((a, b) => a.id.localeCompare(b.id)); }, [types]);
  const matches = latest.filter(type => type.id.toLowerCase().includes(query.toLowerCase()));
  const close = () => { if (picker.current) picker.current.open = false; };
  const choose = (key: string) => { if (disabled) return; onSelect(key); close(); };
  useEffect(() => { const outside = (event: PointerEvent) => { if (picker.current?.open && event.target instanceof Node && !picker.current.contains(event.target)) picker.current.open = false; }; document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside); }, []);
  return <section className="model-builder-topbar" aria-label="Choose a model and version">
    <div className="model-picker-control"><span className="model-control-label">Your models <small>{latest.length}</small></span>
      <details ref={picker} className="model-picker" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); picker.current?.querySelector("summary")?.focus({ preventScroll: true }); } }}>
        <summary aria-label="Choose model" aria-disabled={disabled} onClick={event => { if (disabled) event.preventDefault(); }}><span>{current?.id || "Choose a model…"}</span><span aria-hidden="true">▾</span></summary>
        <div className="model-picker-popover"><label>Find a model<input value={query} placeholder="Search model names…" disabled={disabled} onChange={event => setQuery(event.target.value)} /></label>
          <div className="model-picker-results" aria-label="Matching models">{matches.slice(0, 100).map(type => { const key = definitionKey(type); return <div key={type.id}><button type="button" disabled={disabled} draggable={!disabled} onDragStart={event => writeBuilderDrag(event, { kind: "type", path: key })} onClick={() => choose(key)} aria-current={current?.id === type.id ? "true" : undefined}>{type.id}<small>v{type.version}{saved.has(key) ? "" : " · draft"}</small></button><button type="button" className="model-nest-button" disabled={!editable || current?.id === type.id} title="Add this model as fields in your current draft" aria-label={`Add ${key} inside open model`} onClick={() => { onAdd({ kind: "type", path: key }); close(); }}>＋</button></div>; })}</div>
          {!matches.length && <p className="model-help">{latest.length ? "No matching models." : "Use a starter or create a model from your data."}</p>}{matches.length > 100 && <p className="model-help">Showing 100 of {matches.length}. Search to narrow the list.</p>}
        </div>
      </details>
    </div>
    {current && <label className="model-version-control">Version<select aria-label={`${current.id} version`} value={selected} disabled={disabled} onChange={event => choose(event.target.value)}>{versions.map(type => { const key = definitionKey(type); return <option key={key} value={key}>v{type.version}{saved.has(key) ? " · saved" : " · draft"}</option>; })}</select></label>}
    <div className="model-topbar-actions"><button type="button" className="button small" disabled={disabled} onClick={onNew}>New model</button>{onUseStarter && <button type="button" className="button small" disabled={disabled} onClick={onUseStarter}>Use a starter</button>}</div>
  </section>;
}
