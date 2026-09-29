import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Project, ProjectNavigationSettings, RuntimeParameters, Screen, StateScope, Template } from "./types";
import { defaultNavigationLabel, navigationLabelError, projectNavigationSettings } from "./runtimeNavigation";
import { TemplateParametersEditor } from "./TemplateParametersEditor";
import { StateDefinitionsEditor } from "./StateDefinitionsEditor";
import "./documentProperties.css";
import "./resourceChanges.css";

type Notify = (message: string, error?: boolean) => void;
interface DocumentPropertiesProps {
  document: Screen | Template;
  isTemplate: boolean;
  onChange: (patch: Partial<Template>) => void;
  onRename?: () => void;
  parentParameters?: RuntimeParameters;
  notify: Notify;
  canChangeToPopup?: boolean;
  templates?: Template[];
}
interface ProjectPropertiesProps {
  canRename?: boolean;
  project: Project;
  onChange: (patch: Partial<Pick<Project, "name" | "parameters" | "navigation" | "sessionState">>) => void;
  notify: Notify;
}

function PropertyRow({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return <div className="document-property-row"><label htmlFor={id}>{label}</label><div className="document-property-value">{children(id)}</div></div>;
}

function DimensionInput({ id, label, value, onChange, notify }: { id: string; label: string; value: number; onChange: (value: number) => void; notify: Notify }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  function commit() {
    const next = Number(draft);
    if (!draft.trim() || !Number.isFinite(next) || next < 1 || next > 8192) {
      setDraft(String(value));
      notify(`${label} must be a number from 1 to 8,192 pixels.`, true);
    } else if (next !== value) onChange(next);
  }
  return <div className="document-dimension-input"><input id={id} aria-label={label} type="number" min={1} max={8192} step="any" value={draft}
    onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => {
      if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === "Escape") { event.preventDefault(); setDraft(String(value)); }
    }} /><span>px</span></div>;
}

function parameterNameError(name: string, parameters: Record<string, string>, original?: string): string | undefined {
  // Existing imported names remain editable as values; only new/renamed keys use
  // the identifier convention so old resources do not need a forced migration.
  if (name === original) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))
    return "Use a parameter name of 1–64 letters, digits, or underscores, starting with a letter or underscore.";
  if (["__proto__", "constructor", "prototype"].includes(name)) return "That parameter name is reserved. Choose another name.";
  if (Object.hasOwn(parameters, name)) return `A parameter named '${name}' already exists. Its value was preserved.`;
  return undefined;
}

function ParameterKey({ scope, name, parameters, onRename, notify }: { scope: string; name: string; parameters: Record<string, string>; onRename: (name: string) => void; notify: Notify }) {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  function commit() {
    const error = parameterNameError(draft, parameters, name);
    if (error) { setDraft(name); notify(error, true); }
    else if (draft !== name) onRename(draft);
  }
  return <input aria-label={`${scope} parameter ${name} name`} value={draft} title={name}
    onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => {
      if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === "Escape") { event.preventDefault(); setDraft(name); }
    }} />;
}

function ParametersSheet({ scope, parameters, onChange, notify, project = false }: { scope: string; parameters: Record<string, string>; onChange: (parameters: Record<string, string>) => void; notify: Notify; project?: boolean }) {
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const helpId = useId();
  function add() {
    const error = parameterNameError(newName, parameters);
    if (error) { notify(error, true); return; }
    onChange(Object.fromEntries([...Object.entries(parameters), [newName, newValue]]));
    setNewName(""); setNewValue("");
  }
  return <section className="document-property-group document-parameters" aria-label={`${scope} parameter defaults`}>
    <h3>Parameters</h3>
    <p id={helpId} className="document-property-help">{project
      ? <>Saved text defaults. Screens and templates can reference them with <code>{"{parameter}"}</code>.</>
      : <>Saved text defaults. Use <code>{"{projectParameter}"}</code> to follow a project parameter.</>} These definitions do not use runtime fx bindings.</p>
    <div className="document-parameter-columns" aria-hidden="true"><span>Name</span><span>Default value</span><span /></div>
    {Object.entries(parameters).map(([name, value]) => <div className="document-parameter-row" key={name}>
      <ParameterKey scope={scope} name={name} parameters={parameters} notify={notify}
        onRename={next => onChange(Object.fromEntries(Object.entries(parameters).map(([key, entry]) => [key === name ? next : key, entry])))} />
      <textarea rows={1} aria-label={`${scope} parameter ${name} default value`} value={value}
        onChange={event => onChange(Object.fromEntries(Object.entries(parameters).map(([key, entry]) => [key, key === name ? event.target.value : entry])))} />
      <button type="button" className="document-parameter-delete" aria-label={`Delete ${scope.toLowerCase()} parameter ${name}`} title={`Delete ${name}`}
        onClick={() => onChange(Object.fromEntries(Object.entries(parameters).filter(([key]) => key !== name)))}>×</button>
    </div>)}
    {!Object.keys(parameters).length && <p className="document-property-empty">No parameters defined.</p>}
    <div className="document-parameter-add">
      <div className="document-parameter-row">
        <input aria-label={`New ${scope.toLowerCase()} parameter name`} aria-describedby={helpId} placeholder="New name" value={newName} maxLength={64} onChange={event => setNewName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
        <input aria-label={`New ${scope.toLowerCase()} parameter default value`} placeholder="Default value" value={newValue} onChange={event => setNewValue(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
        <span />
      </div>
      <button type="button" className="button small" onClick={add}>Add parameter</button>
    </div>
  </section>;
}

/** Follow only the scope's structured references; scripts remain authored code. */
export function stateDefinitionReferences(documents: (Screen | Template)[], scope: StateScope, templates: Template[] = []): Record<string, string[]> {
  const references: Record<string, string[]> = Object.create(null), visited = new Set<Screen | Template>();
  const templateById = new Map(templates.map(template => [template.id, template]));
  function visit(document: Screen | Template) {
    if (visited.has(document)) return;
    visited.add(document);
    for (const component of document.components) {
      const add = (key: string, property: string) => { const label = `${document.name} / ${component.props.text || component.id} · ${property}`; if (!(references[key] ??= []).includes(label)) references[key].push(label); };
      const bindings = [...Object.entries(component.props.bindings || {}), ...Object.entries(component.props.parameterBindings || {}).map(([target, binding]) => [`parameter ${target}`, binding] as const), ...Object.entries(component.props.queryBindings || {}).flatMap(([target, source]) => Object.entries(source?.parameters || {}).map(([name, binding]) => [`query ${target} / ${name}`, binding] as const))];
      for (const [target, binding] of bindings)
        for (const reference of Object.values(binding?.references || {}))
          if (reference.kind !== "tag" && reference.kind === `${scope}State`) add(reference.key, target);
      if (component.props.stateBinding?.scope === scope) add(component.props.stateBinding.key, "Value");
      // Every nested placement shares its containing screen; private instance
      // state is replaced at each template boundary and must not be traversed.
      if (scope === "screen" && (component.type === "template" || component.type === "repeater")) {
        const child = templateById.get(component.props.templateId || "");
        if (child) visit(child);
      }
    }
  }
  documents.forEach(visit);
  return references;
}

/** Saved document properties use the caller's normal history/save pipeline. */
export function DocumentProperties({ document, isTemplate, onChange, onRename, notify, canChangeToPopup = true, parentParameters = {}, templates = [] }: DocumentPropertiesProps) {
  const scope = isTemplate ? "Template" : "Screen";
  const stateReferences = stateDefinitionReferences([document], isTemplate ? "instance" : "screen", templates);
  return <div className="document-properties" aria-label={`${scope} properties`}>
    <div className="document-property-columns" aria-hidden="true"><span>Property</span><span>Value</span></div>
    <section className="document-property-group" aria-label={`${scope} general properties`}>
      <h3>General</h3>
      <PropertyRow label="ID">{id => <input id={id} aria-label={`${scope} ID`} readOnly value={document.id} title={document.id} />}</PropertyRow>
      <PropertyRow label="Name">{id => onRename
        ? <div className="document-resource-name"><input id={id} aria-label={`${scope} name`} value={document.name} readOnly title={document.name} /><button type="button" className="button small" aria-label={`Rename ${scope.toLowerCase()}`} onClick={onRename}>Rename</button></div>
        : <input id={id} aria-label={`${scope} name`} value={document.name} onChange={event => onChange({ name: event.target.value })} />}</PropertyRow>
      <PropertyRow label="Kind">{id => isTemplate
        ? <input id={id} aria-label="Template kind" readOnly value="Shared template" />
        : <select id={id} aria-label="Screen kind" value={document.kind || "screen"} onChange={event => {
          const kind = event.target.value as "screen" | "popup";
          if (kind === "popup" && !canChangeToPopup) { notify("Keep at least one regular screen for the operator application.", true); return; }
          onChange({ kind });
        }}><option value="screen">Screen</option><option value="popup" disabled={!canChangeToPopup && document.kind !== "popup"}>Popup</option></select>}</PropertyRow>
      {!isTemplate && <p className="document-property-help">{document.kind === "popup" ? "Popups are opened by a component action." : "Screens open through navigation actions or the optional menu configured in Project settings."}
        {!canChangeToPopup && document.kind !== "popup" && " Keep at least one regular screen."}</p>}
    </section>
    <section className="document-property-group" aria-label={`${scope} layout properties`}>
      <h3>Layout</h3>
      {(["width", "height"] as const).map(key => <PropertyRow key={key} label={key === "width" ? "Width" : "Height"}>{id =>
        <DimensionInput id={id} label={`${scope} ${key}`} value={document[key]} notify={notify} onChange={value => onChange({ [key]: value })} />}</PropertyRow>)}
    </section>
    {isTemplate
      ? <TemplateParametersEditor key={document.id} template={document as Template} parentParameters={parentParameters} notify={notify} onChange={onChange} />
      : <ParametersSheet key={document.id} scope={scope} parameters={document.parameters || {}} notify={notify} onChange={parameters => onChange({ parameters })} />}
    {isTemplate
      ? <StateDefinitionsEditor key={`instance-state:${document.id}`} scope="instance" definitions={(document as Template).instanceState} references={stateReferences} onChange={instanceState => onChange({ instanceState })} />
      : <StateDefinitionsEditor key={`state:${document.id}`} scope="screen" definitions={document.state} references={stateReferences} onChange={state => onChange({ state })} />}
  </div>;
}

function MenuItemLabel({ item, onChange, notify }: { item: ProjectNavigationSettings["items"][number]; onChange: (label: string) => void; notify: Notify }) {
  const [draft, setDraft] = useState(item.label);
  useEffect(() => setDraft(item.label), [item.label]);
  function commit() {
    const error = navigationLabelError(draft);
    if (error) { setDraft(item.label); notify(error, true); return; }
    const label = draft.trim();
    setDraft(label);
    if (label !== item.label) onChange(label);
  }
  return <input aria-label={`Menu label for ${item.screenId}`} value={draft} maxLength={120} onChange={event => setDraft(event.target.value)}
    onBlur={commit} onKeyDown={event => {
      if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDraft(item.label); }
    }} />;
}

function NavigationProperties({ project, onChange, notify }: ProjectPropertiesProps) {
  const navigation = projectNavigationSettings(project);
  const screens = project.screens.filter(screen => screen.kind !== "popup");
  const available = screens.filter(screen => !navigation.items.some(item => item.screenId === screen.id));
  const [candidate, setCandidate] = useState("");
  const selectedCandidate = available.some(screen => screen.id === candidate) ? candidate : available[0]?.id || "";
  const update = (patch: Partial<ProjectNavigationSettings>) => onChange({ navigation: { ...navigation, ...patch } });
  function move(index: number, offset: number) {
    const items = [...navigation.items];
    [items[index], items[index + offset]] = [items[index + offset], items[index]];
    update({ items });
  }
  return <section className="document-property-group navigation-properties" aria-label="Operator navigation settings">
    <h3>Operator navigation</h3>
    <p className="document-property-help">The application opens one startup screen. Add navigation buttons to your screens, or enable a menu with selected destinations below.</p>
    <PropertyRow label="Startup screen">{id => <select id={id} aria-label="Startup screen" value={navigation.startupScreenId}
      onChange={event => update({ startupScreenId: event.target.value })}>
      {screens.map(screen => <option key={screen.id} value={screen.id}>{screen.name}</option>)}
    </select>}</PropertyRow>
    <PropertyRow label="Screen menu">{id => <select id={id} aria-label="Screen menu" value={navigation.mode}
      onChange={event => update({ mode: event.target.value as ProjectNavigationSettings["mode"] })}>
      <option value="none">None — use navigation actions</option><option value="menu">Show selected destinations</option>
    </select>}</PropertyRow>
    {navigation.mode === "menu" && <>
      <p className="document-property-help">Only these screens appear in the menu, in this order. Popups open through actions. Adding a screen never adds it to this menu automatically.</p>
      <ol className="navigation-menu-items" aria-label="Menu destinations">
        {navigation.items.map((item, index) => <li key={item.screenId}>
          <div className="navigation-menu-label"><span>{screens.find(screen => screen.id === item.screenId)?.name || item.screenId}</span>
            <MenuItemLabel item={item} notify={notify} onChange={label => update({ items: navigation.items.map(entry => entry.screenId === item.screenId ? { ...entry, label } : entry) })} />
          </div>
          <div className="navigation-menu-actions">
            <button type="button" disabled={index === 0} aria-label={`Move ${item.label} up`} title="Move up" onClick={() => move(index, -1)}>↑</button>
            <button type="button" disabled={index === navigation.items.length - 1} aria-label={`Move ${item.label} down`} title="Move down" onClick={() => move(index, 1)}>↓</button>
            <button type="button" aria-label={`Remove ${item.label} from menu`} title="Remove from menu" onClick={() => update({ items: navigation.items.filter(entry => entry.screenId !== item.screenId) })}>×</button>
          </div>
        </li>)}
      </ol>
      {!navigation.items.length && <p className="document-property-empty">No menu destinations yet. The menu stays hidden until you add one.</p>}
      <div className="navigation-menu-add">
        <select aria-label="Screen to add to menu" value={selectedCandidate} disabled={!available.length || navigation.items.length >= 100} onChange={event => setCandidate(event.target.value)}>
          {!available.length && <option value="">All screens already added</option>}
          {available.map(screen => <option key={screen.id} value={screen.id}>{screen.name}</option>)}
        </select>
        <button className="button small" type="button" disabled={!selectedCandidate || navigation.items.length >= 100} onClick={() => {
          const screen = screens.find(item => item.id === selectedCandidate);
          if (screen) update({ items: [...navigation.items, { screenId: screen.id, label: defaultNavigationLabel(screen) }] });
        }}>Add destination</button>
      </div>
    </>}
    {navigation.mode === "none" && navigation.items.length > 0 && <p className="document-property-help">Your {navigation.items.length} saved menu destinations are retained while the menu is hidden.</p>}
  </section>;
}

export function ProjectSettingsDialog({ project, onChange, notify, onClose, canRename = true }: ProjectPropertiesProps & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="project-dialog project-settings-dialog" ref={dialog} aria-labelledby={titleId}
    onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") event.preventDefault();
    }}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div className="eyebrow">{project.name}</div><h2 id={titleId}>Project settings</h2></header>
    <div className="project-dialog-body"><ProjectProperties project={project} onChange={onChange} notify={notify} canRename={canRename} /></div>
    <footer><span>Save and publish the project to update the operator application.</span><button type="button" className="button" onClick={onClose}>Done</button></footer>
  </dialog>;
}

/** Project metadata shares the same editable name/value sheet as documents. */
export function ProjectProperties({ project, onChange, notify, canRename = true }: ProjectPropertiesProps) {
  return <div className="document-properties" aria-label="Project properties">
    <NavigationProperties project={project} onChange={onChange} notify={notify} />
    <div className="document-property-columns" aria-hidden="true"><span>Property</span><span>Value</span></div>
    <section className="document-property-group" aria-label="Project general properties">
      <h3>General</h3>
      <PropertyRow label="ID">{id => <input id={id} aria-label="Project ID" readOnly value={project.id} title={project.id} />}</PropertyRow>
      <PropertyRow label="Name">{id => <input id={id} aria-label="Project name" maxLength={120} readOnly={!canRename} title={!canRename ? "A gateway administrator can rename this project" : undefined} value={project.name} onChange={event => { if (canRename) onChange({ name: event.target.value }); }} />}</PropertyRow>
      <PropertyRow label="Revision">{id => <input id={id} aria-label="Project revision" readOnly value={project.revision} />}</PropertyRow>
    </section>
    <ParametersSheet key={project.id} scope="Project" project parameters={project.parameters} notify={notify} onChange={parameters => onChange({ parameters })} />
    <StateDefinitionsEditor key={`session:${project.id}`} scope="session" definitions={project.sessionState} references={stateDefinitionReferences([...project.screens, ...(project.templates || [])], "session")} onChange={sessionState => onChange({ sessionState })} />
  </div>;
}
