import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Completion } from "@codemirror/autocomplete";
import { api, id } from "./api";
import ScriptEditor from "./ScriptEditor";
import EventScriptLanguagePicker, { PythonEventContext } from "./EventScriptLanguage";
import { editEventScript, eventScriptDraft, eventScriptValue, pythonComponentEventRestriction, pythonInputEventsAvailable, pythonEventCompletions, selectEventLanguage, type EventScriptLanguage } from "./eventScriptAuthoring";
import { applyComponentActionsDraft, componentActionsDraft, eventTabLabels, hasComponentAction, isTagWriteDataType, tagWriteDataTypes, tagWritePropertyChoices, tagWritePropertyCompatible, tagWriteValue, writableActionTags, type ComponentActionsDraft, type ComponentEventTab, type TagWritePropertyChoice } from "./componentActionsAuthoring";
import { componentEventProperties, componentInteractionTypes, isComponentInteraction } from "./componentEventModel";
import { componentMessageScopes, componentMessageScopeDescriptions } from "./componentMessageAuthoring";
import { discoverComponentMessageReceivers } from "./componentMessageReceivers";
import MessageReceiverList from "./MessageReceiverList";
import { isInput } from "./inputs";
import type { CanvasComponent, ComponentMessageHandler, ComponentMessageScope, InputValues, Project, RuntimeParameters, Screen, Tag, TagWriteDataType } from "./types";
import type { EquipmentCommandDefinition } from "./EquipmentCommand";
import "./inputEvents.css";
import "./componentActionsEditor.css";

const descriptions: Record<ComponentEventTab, string> = {
  action: "Choose what happens when this component is activated. Action settings and every event below apply together.",
  change: "Runs for an operator edit. event.previousValue is the previous edit; numeric controls can contain empty or invalid text while editing. Initial and programmatic values do not fire input events.",
  commit: "Runs when an operator commits a value. event.previousValue is the last committed value. Checkbox, select and radio controls commit immediately; text and numeric controls commit on Enter or blur.",
  mount: "Runs when this component enters its screen, popup or template context. Initial property values establish a silent baseline.",
  propertyChange: "Runs when an observed value or its availability changes, including binding, script and input updates. Equal values are suppressed. Avoid writing back to the property that triggered this event.",
  unmount: "Cleanup when this component leaves its context. Python receives captured component, input, parameter and local-state reads; UI changes are rejected. JavaScript cleanup reads captured state and cannot update the closed UI.",
  messages: "Receive a named message in this component's form context. Each handler matches an exact message type and scope.",
  focus: "Runs when focus enters this component. Moving between controls inside the same component does not fire another focus event.",
  blur: "Runs when focus leaves this component. Native input commit behavior is preserved.",
  keyDown: "Observes a pressed key before native editing. Repeated keys include repeat=true. The handler receives a snapshot and cannot cancel browser behavior.",
  keyUp: "Observes a released key. Keyboard input, shortcuts and composition keep their native behavior.",
  doubleClick: "Observes a double click. Normal click actions still run; this handler does not cancel or replace them.",
  pointerDown: "Observes mouse, touch or pen contact. No pointer capture is added and native gestures are preserved.",
  pointerUp: "Observes pointer release delivered to this component. A release outside it is delivered only when its native control already captures the pointer.",
};
const eventFields = (tab: ComponentEventTab) => tab === "action" ? [] : tab === "messages" ? ["type", "componentId", "messageType", "payload", "scope", "messageId"] : tab === "propertyChange" ? ["type", "componentId", "property", "value", "previousValue", "available", "previousAvailable", "error", "previousError", "origin"] : tab === "change" || tab === "commit" ? ["type", "componentId", "fieldKey", "value", "previousValue", "origin"]
  : tab === "keyDown" || tab === "keyUp" ? ["type", "componentId", "origin", "key", "code", "repeat", "isComposing", "redacted", "altKey", "ctrlKey", "metaKey", "shiftKey"]
  : tab === "pointerDown" || tab === "pointerUp" || tab === "doubleClick" ? ["type", "componentId", "origin", "button", "buttons", "clientX", "clientY", ...(tab === "doubleClick" ? [] : ["pointerType", "pointerId"]), "altKey", "ctrlKey", "metaKey", "shiftKey"]
  : tab === "focus" || tab === "blur" ? ["type", "componentId", "origin"] : ["type", "componentId"];
interface LibraryResource { name: string; type: string; enabled: boolean }

/** One modal owns every action/event draft. Only Apply may mutate canvas history. */
export default function ComponentActionsEditor({ component, components, screens, inputs, parameters, tags = [], commands = [], parent, project, documentKind = "screen", instanceStateAvailable = false, popupAllowed = true, onApply, onClose }: {
  component: CanvasComponent; components: CanvasComponent[]; screens: Screen[]; inputs: InputValues; parameters: RuntimeParameters;
  tags?: Tag[];
  commands?: EquipmentCommandDefinition[];
  /** The authored screen or template containing this flat component form. */
  parent?: Screen;
  project?: Pick<Project, "screens" | "templates">;
  documentKind?: "screen" | "template";
  instanceStateAvailable?: boolean; popupAllowed?: boolean; onApply: (props: CanvasComponent["props"]) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), tagPathInput = useRef<HTMLInputElement>(null), titleId = useId();
  const [draft, setDraft] = useState(() => componentActionsDraft(component));
  const [selected, setSelected] = useState<ComponentEventTab>(hasComponentAction(component) ? "action" : isInput(component.type) ? "change" : "mount");
  const [handlerId, setHandlerId] = useState<string | null>(component.props.messageHandlers?.[0]?.id ?? null);
  const [error, setError] = useState("");
  const [libraries, setLibraries] = useState<LibraryResource[]>([]);
  const [libraryStatus, setLibraryStatus] = useState("Loading saved libraries…");
  const [tagBrowserOpen, setTagBrowserOpen] = useState(false), [tagSearch, setTagSearch] = useState("");
  const messageTypeListId = `${titleId}-message-types`;
  const receiverDiscovery = useMemo(() => discoverComponentMessageReceivers({
    project,
    document: parent ?? { id: "current-form", name: "Current form", width: 1, height: 1, components },
    documentKind,
    messageType: draft.messageType.trim(),
    scope: draft.messageScope,
    override: { componentId: component.id, handlers: draft.handlers.map(handler => ({ ...handler, messageType: handler.messageType.trim(), ...eventScriptValue(draft.messageScripts[handler.id]) })) },
  }), [project, parent, components, documentKind, draft.messageType, draft.messageScope, component.id, draft.handlers, draft.messageScripts]);
  const writableTags = useMemo(() => writableActionTags(tags).sort((a, b) => a.path.localeCompare(b.path)), [tags]);
  const matchingTag = tags.find(tag => tag.path === draft.tagPath.trim());
  const tagDataType = matchingTag && isTagWriteDataType(matchingTag.dataType) ? matchingTag.dataType : draft.tagDataType;
  const tagMatches = writableTags.filter(tag => tag.path.toLowerCase().includes(tagSearch.trim().toLowerCase()));
  const tagCommands = commands.filter(command => command.tagPath === draft.tagPath.trim());
  const tagCommand = tagCommands.length === 1 ? tagCommands[0] : undefined;
  function propertyChoices(target: string, dataType = tagDataType): TagWritePropertyChoice[] {
    const owner = target === "self" ? component : components.find(item => `component:${item.id}` === target);
    const choices: TagWritePropertyChoice[] = target === "parent" ? parent ? [
      { property: "name", label: "Name", type: "string" }, { property: "width", label: "Width", type: "number" }, { property: "height", label: "Height", type: "number" },
    ] : [] : owner ? tagWritePropertyChoices(owner) : [];
    return choices.filter(choice => tagWritePropertyCompatible(choice, dataType));
  }
  const sourceProperties = propertyChoices(draft.tagPropertyComponent);
  const pythonAvailable = selected !== "change" && selected !== "commit" || pythonInputEventsAvailable(component), cleanup = selected === "unmount";
  const inputEvent = selected === "change" || selected === "commit";
  const handler = draft.handlers.find(item => item.id === handlerId);
  const current = selected === "action" ? { language: "python" as const, code: draft.buttonCode } : selected === "messages" ? handler ? eventScriptValue(draft.messageScripts[handler.id]) : null : eventScriptValue(draft.scripts[selected]);
  const showCode = selected === "action" ? draft.action === "script" : selected !== "messages" || Boolean(handler);
  const tabs: ComponentEventTab[] = [...(hasComponentAction(component) ? ["action" as const] : []), ...(isInput(component.type) ? ["change" as const, "commit" as const] : []), ...componentInteractionTypes, "mount", "propertyChange", "unmount", "messages"];
  const allowedProperties = componentEventProperties(component, draft.scripts.propertyChange.language);
  const fields = components.filter(item => isInput(item.type) && item.type !== "passwordInput");
  const patch = (value: Partial<ComponentActionsDraft>) => { setError(""); setDraft(previous => ({ ...previous, ...value })); };
  function closeTagBrowser() {
    setTagBrowserOpen(false);
    tagPathInput.current?.focus({ preventScroll: true });
  }
  function chooseTag(tag: Tag) {
    if (!isTagWriteDataType(tag.dataType)) return;
    let value = draft.tagValue;
    try { tagWriteValue(tag.dataType, value); } catch { value = tag.dataType === "Boolean" ? "false" : tag.dataType === "String" ? "" : "0"; }
    patch({ tagPath: tag.path, tagDataType: tag.dataType, tagValue: value }); closeTagBrowser();
  }
  function changeTagType(dataType: TagWriteDataType) {
    let value = draft.tagValue;
    try { tagWriteValue(dataType, value); } catch { value = dataType === "Boolean" ? "false" : dataType === "String" ? "" : "0"; }
    patch({ tagDataType: dataType, tagValue: value });
  }
  function chooseValueSource(source: "fixed" | "property") {
    patch({ tagValueSource: source, ...(source === "property" && !draft.tagProperty ? { tagProperty: sourceProperties[0]?.property ?? "" } : {}) });
  }
  function choosePropertyComponent(target: string) { patch({ tagPropertyComponent: target, tagProperty: propertyChoices(target)[0]?.property ?? "" }); }
  useEffect(() => {
    const element = dialog.current, previousFocus = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => { element?.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  useEffect(() => {
    let active = true;
    void api<{ resources: LibraryResource[] }>("/scripts/resources").then(result => {
      if (!active) return;
      const resources = result.resources.filter(resource => resource.type === "library");
      setLibraries(resources); setLibraryStatus(resources.length ? "Import a published module with from project import module_name." : "Create reusable modules in Scripting → Project library.");
    }).catch(() => { if (active) setLibraryStatus("Saved libraries could not be loaded. You can still edit events."); });
    return () => { active = false; };
  }, []);
  const completions = useMemo<Completion[]>(() => current?.language === "python" ? [
    ...pythonEventCompletions(components, eventFields(selected), component, cleanup).filter(item => !cleanup || !["system.ui.setState", "system.ui.setProperty"].includes(item.label)).map(item => selected === "action" && item.label === "inputs" ? { ...item, detail: "Validated form values submitted by this action, including password inputs" } : item),
    ...libraries.map(resource => ({ label: `project.${resource.name}`, type: "namespace", detail: resource.enabled ? "Requires script publication" : "Saved library · disabled" })),
  ] : [
    ...eventFields(selected).map(property => ({ label: `event.${property}`, type: "property", detail: "Captured event payload" })),
    { label: "inputs", type: "variable", detail: inputEvent ? "Detached form snapshot; JavaScript input handlers include password fields" : "Frozen form snapshot; passwords omitted" },
    { label: "parameters", type: "variable", detail: "Screen or template parameter snapshot" },
    { label: "app.state.get", type: "function", detail: instanceStateAvailable ? "Read session, screen or private instance state" : "Read session or screen state" },
    { label: "app.signal", type: "property", detail: "Cancellation signal; already aborted during unmount" },
    ...(!cleanup ? ["notify", "setInput", "sendMessage", "state.set", "state.reset", ...(!inputEvent ? ["onCleanup"] : [])].map(method => ({ label: `app.${method}`, type: "function", detail: "Local browser helper" })) : []),
  ], [component, components, current?.language, selected, cleanup, inputEvent, libraries, instanceStateAvailable]);
  function changeScript(code: string) {
    setError("");
    setDraft(previous => selected === "action" ? { ...previous, buttonCode: code } : selected === "messages" && handler ? { ...previous, messageScripts: { ...previous.messageScripts, [handler.id]: editEventScript(previous.messageScripts[handler.id], code) } } : selected !== "messages" ? { ...previous, scripts: { ...previous.scripts, [selected]: editEventScript(previous.scripts[selected], code) } } : previous);
  }
  function changeLanguage(language: EventScriptLanguage) {
    setError("");
    setDraft(previous => selected === "messages" && handler ? { ...previous, messageScripts: { ...previous.messageScripts, [handler.id]: selectEventLanguage(previous.messageScripts[handler.id], language) } } : selected !== "action" && selected !== "messages" ? { ...previous, scripts: { ...previous.scripts, [selected]: selectEventLanguage(previous.scripts[selected], language) } } : previous);
  }
  function addHandler() {
    if (draft.handlers.length >= 16) return;
    let messageType = "refresh", suffix = 2;
    while (draft.handlers.some(item => item.messageType.trim() === messageType && item.scope === "screen")) messageType = `refresh-${suffix++}`;
    const item: ComponentMessageHandler = { id: id("message"), messageType, scope: "screen", language: pythonAvailable ? "python" : "javascript", code: pythonAvailable ? 'print("Received " + event.messageType)' : 'app.notify("Received " + event.messageType);' };
    patch({ handlers: [...draft.handlers, item], messageScripts: { ...draft.messageScripts, [item.id]: eventScriptDraft(item, pythonAvailable) } }); setHandlerId(item.id);
  }
  function removeHandler() {
    const index = draft.handlers.findIndex(item => item.id === handlerId), remaining = draft.handlers.filter(item => item.id !== handlerId);
    patch({ handlers: remaining }); setHandlerId(remaining[Math.min(index, remaining.length - 1)]?.id ?? null);
  }
  function updateHandler(value: Partial<ComponentMessageHandler>) { patch({ handlers: draft.handlers.map(item => item.id === handlerId ? { ...item, ...value } : item) }); }
  function apply() {
    const result = applyComponentActionsDraft(component, draft, screens, popupAllowed, tags, components, parent, commands);
    if (result.error !== undefined) { setError(result.error); setSelected(result.tab); if (result.handlerId) setHandlerId(result.handlerId); return; }
    onApply(result.props);
  }
  const configured = (tab: ComponentEventTab) => tab === "action" ? draft.action ? "Configured" : "None" : tab === "messages" ? `${draft.handlers.length} / 16` : eventScriptValue(draft.scripts[tab]).code.trim() ? "Configured" : "Empty";
  // Pure render helpers share this hook owner, preserving child keys and edit lifetimes.
  function renderTagValueAction() {
    return (<section className="component-tag-action" aria-label="Set tag value settings">
      <div className="component-tag-target"><label htmlFor={`${titleId}-tag-path`}>Set this tag</label><div className="component-tag-path"><input ref={tagPathInput} id={`${titleId}-tag-path`} aria-label="Set tag path" placeholder="[default]Area/Value" maxLength={512} spellCheck={false} value={draft.tagPath} onChange={event => patch({ tagPath: event.target.value })} /><button type="button" className="button" aria-expanded={tagBrowserOpen} aria-controls={`${titleId}-tag-browser`} onClick={() => { setTagBrowserOpen(!tagBrowserOpen); setTagSearch(""); }}>Browse</button></div></div>
      {tagBrowserOpen && <section id={`${titleId}-tag-browser`} className="component-tag-browser" aria-label="Writable tag browser" onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeTagBrowser(); }
      }}>
        <label>Find a tag<input aria-label="Find writable tag" type="search" placeholder="Search tag paths…" value={tagSearch} onChange={event => setTagSearch(event.target.value)} /></label>
        <div className="component-tag-results">{tagMatches.slice(0, 200).map(tag => <button key={tag.path} type="button" className={tag.path === draft.tagPath.trim() ? "selected" : ""} aria-label={`Select tag ${tag.path}`} onClick={() => chooseTag(tag)}><span>{tag.path}</span><small>{tag.dataType} · {tag.source === "memory" ? "Memory" : tag.source === "device" ? "Device" : "OPC UA"}</small></button>)}</div>
        <p>{tagMatches.length > 200 ? `Showing 200 of ${tagMatches.length.toLocaleString()} matching tags. Refine your search.` : tagMatches.length ? `${tagMatches.length} writable ${tagMatches.length === 1 ? "tag" : "tags"}.` : "No matching writable tags. Configure a memory, OPC UA or writable device tag in Tags, or enter its full path."}</p>
      </section>}
      <label>Value source<select aria-label="Set tag value source" value={draft.tagValueSource} onChange={event => chooseValueSource(event.target.value as "fixed" | "property")}><option value="fixed">Fixed value</option><option value="property">Component property</option></select></label>
      <div className="component-tag-value-row">{draft.tagValueSource === "property" ? <label>Component<select aria-label="Set tag source component" value={draft.tagPropertyComponent} onChange={event => choosePropertyComponent(event.target.value)}><option value="self">This component · {component.props.text || component.id}</option>{parent && <option value="parent">Parent · {parent.name}</option>}{components.filter(item => item.id !== component.id).map(item => <option key={item.id} value={`component:${item.id}`}>{item.props.text || item.type} · {item.id}</option>)}{draft.tagPropertyComponent === "parent" && !parent && <option value="parent" disabled>Unavailable parent</option>}{draft.tagPropertyComponent.startsWith("component:") && !components.some(item => `component:${item.id}` === draft.tagPropertyComponent) && <option value={draft.tagPropertyComponent} disabled>Missing component: {draft.tagPropertyComponent.slice(10)}</option>}</select></label> : <label>To this value{tagDataType === "Boolean" ? <select aria-label="Set tag Boolean value" value={draft.tagValue} onChange={event => patch({ tagValue: event.target.value })}><option value="false">False</option><option value="true">True</option>{!["true", "false"].includes(draft.tagValue) && <option value={draft.tagValue} disabled>Choose true or false</option>}</select> : <input aria-label="Set tag value" type={tagDataType === "String" ? "text" : "number"} step={tagDataType === "Float" || tagDataType === "Double" ? "any" : 1} maxLength={tagDataType === "String" ? 1024 : undefined} value={draft.tagValue} onChange={event => patch({ tagValue: event.target.value })} />}</label>}
        <label>Data type{matchingTag && isTagWriteDataType(matchingTag.dataType) ? <input aria-label="Set tag data type" value={tagDataType} readOnly /> : <select aria-label="Set tag data type" value={draft.tagDataType} onChange={event => changeTagType(event.target.value as TagWriteDataType)}>{tagWriteDataTypes.map(type => <option key={type} value={type}>{type}</option>)}</select>}</label></div>
      {draft.tagValueSource === "property" && <><label>Property<select aria-label="Set tag source property" value={draft.tagProperty} onChange={event => patch({ tagProperty: event.target.value })}><option value="">Choose a property…</option>{sourceProperties.map(choice => <option key={choice.property} value={choice.property}>{choice.label} · {choice.property}</option>)}{draft.tagProperty && !sourceProperties.some(choice => choice.property === draft.tagProperty) && <option value={draft.tagProperty} disabled>Unavailable or incompatible: {draft.tagProperty}</option>}</select></label><p>{draft.tagPropertyComponent === "parent" ? "Parent properties belong to the containing screen or shared template. This picker exposes its authored name and dimensions." : "Reads the component property at activation. Input Value uses the current validated field in this form; captions use authored or bound text before translation. Each repeater row uses its own instance."}</p></>}
      <p>{matchingTag ? "The tag supplies its data type. The gateway checks the configured tag again when this action runs." : "Enter the full tag path and choose its configured data type. The gateway verifies both before writing."}</p>
      {tagCommands.length > 1 ? <p className="input-events-error" role="alert">Multiple declared equipment commands target this tag. Choose another tag or use a declared command control.</p> : tagCommand && <aside className="component-tag-command-note" aria-label="Declared equipment command rules"><strong>Uses declared command: {tagCommand.name}</strong><p>Its bounds, readback and required confirmation take precedence over this action's settings.</p><dl>{tagCommand.min !== undefined && tagCommand.max !== undefined && <><dt>Allowed range</dt><dd>{tagCommand.min} to {tagCommand.max}</dd></>}<dt>Readback</dt><dd>{tagCommand.readbackPath || tagCommand.tagPath}</dd><dt>Confirmation</dt><dd>{tagCommand.confirmation}</dd></dl></aside>}
      <label className="component-tag-confirmation"><input aria-label="Require tag write confirmation" type="checkbox" checked={draft.tagConfirmationEnabled} onChange={event => patch({ tagConfirmationEnabled: event.target.checked })} />Require confirmation</label>
      {draft.tagConfirmationEnabled && <label>Confirmation message<input aria-label="Tag write confirmation message" maxLength={512} value={draft.tagConfirmation} onChange={event => patch({ tagConfirmation: event.target.value })} /></label>}
      <p className="component-tag-write-note">Save and publish this action, then use the operator application. Tag writes require Commands permission.</p>
    </section>);
  }

  function renderEventContext() {
    return (<aside className="input-events-context" aria-label="Action and event context">
      <h3>Component context</h3><code>{component.id}</code>
      {["template", "repeater"].includes(component.type) && <p>For this wrapper, <code>self</code> is the template placement or repeater. <code>self.parent.custom</code> belongs to the containing screen or template. It does not expose each row's private state or traverse into child forms.</p>}
      {selected !== "action" && <><h4>Event payload</h4><pre>{eventFields(selected).map(field => `event.${field}`).join("\n")}</pre><p>Python supports attribute and dictionary access. Values are typed snapshots; unavailable values are None. Numeric edits can be empty or invalid text. Event origin describes a source, not a trusted identity.</p></>}
      {isComponentInteraction(selected) && <p>Only this component receives its interaction; parent containers do not receive a child's event. Disabled, hidden and inactive panes do not run interaction handlers. Password keyboard events use empty key/code and redacted=true in both languages. Input snapshots omit passwords. Static displays gain a keyboard tab stop only when focus or keyboard handlers are configured.</p>}
      {showCode && current?.language === "python" ? <PythonEventContext cleanup={cleanup} buttonAction={selected === "action"} password={component.type === "passwordInput"} /> : showCode && <><h4>JavaScript context</h4><p><code>event</code>, <code>inputs</code> and <code>parameters</code> are snapshots. <code>app.state.get</code> reads declared session or screen state{instanceStateAvailable && ", or this template's private instance state"}.</p>{cleanup ? <p>The signal is already aborted. Use captured reads and release resources; UI setters and notifications do nothing.</p> : <p><code>app.notify</code>, <code>app.setInput</code>, <code>app.state.set/reset</code> and <code>app.sendMessage</code> affect this runtime tab. Pass <code>app.signal</code> to abortable work.{!inputEvent && <> Register timers and listeners with <code>app.onCleanup</code>.</>}</p>}{inputEvent && <p>JavaScript input handlers receive the form snapshot including password fields. Their helpers expire after timeout or context change. Use Mounted for resources that need <code>app.onCleanup</code>.</p>}<p>JavaScript is trusted browser code. Async deadlines cannot interrupt a synchronous infinite loop.</p></>}
      {selected === "action" && draft.action === "setTagValue" && <><h4>Set tag value</h4><p>Choose a writable tag and a fixed value or component property. No script is needed. A published operator application sends the typed value to the gateway; memory tag values persist, and OPC UA/device tags use their connection's reviewed write path.</p><p>Property values must match the tag's data type. General, component-specific and custom scalar properties are available; passwords and structured values are excluded. A component ID identifies another control in this form. Parent means the containing screen or template, whose name and dimensions are available.</p><p>Configured tag names and data types must match. A disabled or unavailable target reports an error. Designer Preview does not write tags.</p></>}
      {selected === "action" && draft.action !== "script" && draft.action !== "setTagValue" && <p>Native actions run when the operator activates the component. Navigation opens a destination screen; popup overrides use parameter names declared on the chosen popup. Send message delivers a fixed JSON payload to matching listeners.</p>}
      {selected === "messages" && <><h4>Message delivery</h4><p>Use a button's Send message action or <code>app.sendMessage(messageType, payload, {"{scope: 'screen'}"})</code> for local instance, screen or tab delivery. Gateway <code>system.ui.sendMessage</code> reaches only session-scope handlers across this project's active operator tabs. Listeners receive their own component, form and state context. Messages are not replayed after a listener closes.</p></>}
      <h4>Components in this form</h4><ul>{components.filter(item => item.type !== "passwordInput").map(item => <li key={item.id}><code>{item.id}</code><small>{item.props.text || item.type}</small></li>)}</ul>
      <h4>Form snapshot</h4><ul>{fields.length ? fields.map(item => { const key = item.props.fieldKey || item.id; return <li key={item.id}><code>{key}</code><small>{item.type} · {String(inputs[key] ?? "Unavailable").slice(0, 90)}</small></li>; }) : <li>No non-password inputs.</li>}</ul><p>Password values are never displayed here.</p>
      <h4>Parameters</h4><ul>{Object.entries(parameters).length ? Object.entries(parameters).map(([key, value]) => <li key={key}><code>{key}</code><small>{String(value)}</small></li>) : <li>No parameters.</li>}</ul>
      {showCode && current?.language === "python" && <><h4>Project library</h4><p>{libraryStatus}</p><ul>{libraries.map(resource => <li key={resource.name}><code>project.{resource.name}</code>{!resource.enabled && <small>Disabled</small>}</li>)}</ul></>}
    </aside>);
  }

  return <dialog ref={dialog} className="input-events-dialog component-actions-dialog scripting-workspace" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); apply(); }
  }}>
    <header className="input-events-heading"><div><small>ACTIONS &amp; EVENTS</small><h2 id={titleId}>{component.props.text?.trim() || component.id}</h2><p>Configure this component's behavior. All changes remain a draft until Apply.</p></div><button type="button" aria-label="Close actions and events" onClick={onClose}>×</button></header>
    <div className="component-actions-layout">
      <nav className="component-actions-nav" aria-label="Action and event navigation">{tabs.map(tab => <button key={tab} type="button" aria-pressed={selected === tab} className={selected === tab ? "active" : ""} onClick={() => { setSelected(tab); setError(""); }}><span>{eventTabLabels[tab]}</span><small>{configured(tab)}</small></button>)}</nav>
      <div className="input-events-body">
        <section className="input-events-source" aria-label={`${eventTabLabels[selected]} settings`}>
          <h3>{eventTabLabels[selected]}</h3><p className="input-events-description">{descriptions[selected]}</p>
          {selected === "action" && <div className="component-actions-fields">
            <label>Action<select aria-label="Click action" value={draft.action} onChange={event => patch({ action: event.target.value as ComponentActionsDraft["action"] })}>
              {component.type === "equipmentSymbol" && <option value="">None</option>}<option value="navigate">Open a screen</option><option value="openPopup" disabled={!popupAllowed}>Open a popup</option>
              {component.type === "button" && <><option value="setTagValue">Set tag value</option><option value="notify">Show a message</option><option value="script">Run Python script</option><option value="message">Send message</option><option value="closePopup">Close popup</option></>}
            </select></label>
            {draft.action === "setTagValue" && renderTagValueAction()}
            {(draft.action === "navigate" || draft.action === "openPopup") && <label>{draft.action === "openPopup" ? "Popup screen" : "Destination screen"}<select aria-label="Action destination" value={draft.action === "openPopup" ? draft.popupTargetScreenId : draft.targetScreenId} onChange={event => patch(draft.action === "openPopup" ? { popupTargetScreenId: event.target.value, popupParameters: "{}" } : { targetScreenId: event.target.value })}>
              <option value="">Select screen…</option>{screens.filter(screen => draft.action === "openPopup" ? screen.kind === "popup" : screen.kind !== "popup").map(screen => <option key={screen.id} value={screen.id}>{screen.name}</option>)}
            </select></label>}
            {draft.action === "openPopup" && <label>Popup parameter overrides · JSON text values<textarea aria-label="Popup parameter overrides" rows={6} spellCheck={false} value={draft.popupParameters} onChange={event => patch({ popupParameters: event.target.value })} /></label>}
            {draft.action === "message" && <><label>Message type<input aria-label="Button message type" list={messageTypeListId} value={draft.messageType} maxLength={80} spellCheck={false} autoComplete="off" onChange={event => patch({ messageType: event.target.value })} /></label><datalist id={messageTypeListId}>{receiverDiscovery.messageTypes.map(messageType => <option key={messageType} value={messageType} />)}</datalist><label>Message scope<select aria-label="Button message scope" value={draft.messageScope} onChange={event => patch({ messageScope: event.target.value as ComponentMessageScope })}>{componentMessageScopes.map(scope => <option key={scope} value={scope}>{scope}</option>)}</select></label><p>{componentMessageScopeDescriptions[draft.messageScope]}</p><MessageReceiverList discovery={receiverDiscovery} messageType={draft.messageType} scope={draft.messageScope} /><label>Message payload · JSON object<textarea aria-label="Button message payload" rows={8} spellCheck={false} value={draft.messagePayload} onChange={event => patch({ messagePayload: event.target.value })} /></label></>}
            <SimpleActionDetails draft={draft} onMessage={notifyMessage => patch({ notifyMessage })} />
          </div>}
          {selected === "messages" && <><div className="component-actions-handler-toolbar"><label>Handler<select aria-label="Selected message handler" disabled={!draft.handlers.length} value={handlerId ?? ""} onChange={event => { setHandlerId(event.target.value); setError(""); }}>{!draft.handlers.length && <option value="">No handlers</option>}{draft.handlers.map(item => <option key={item.id} value={item.id}>{item.messageType || "Unnamed"} · {item.scope} · {item.id}</option>)}</select></label><button type="button" className="button" disabled={draft.handlers.length >= 16} onClick={addHandler}>Add handler</button><button type="button" className="button" disabled={!handler} onClick={removeHandler}>Remove handler</button></div>
            {handler ? <div className="component-actions-fields"><label>Handler ID<input aria-label="Message handler ID" value={handler.id} readOnly /></label><label>Message type<input aria-label="Message handler type" value={handler.messageType} maxLength={80} spellCheck={false} onChange={event => updateHandler({ messageType: event.target.value })} /></label><label>Listening scope<select aria-label="Message handler scope" value={handler.scope} onChange={event => updateHandler({ scope: event.target.value as ComponentMessageScope })}>{componentMessageScopes.map(scope => <option key={scope} value={scope}>{scope}</option>)}</select></label><p>{componentMessageScopeDescriptions[handler.scope]} Message types are case-sensitive.</p></div> : <p className="input-events-description">Add a handler to respond to a named message. Removing every handler stops this component from listening after Apply.</p>}
          </>}
          {selected === "propertyChange" && <fieldset className="component-event-properties"><legend>Watched properties · {draft.properties.length}/16</legend><div>{allowedProperties.map(property => <label key={property}><input type="checkbox" aria-label={`Watch ${property}`} checked={draft.properties.includes(property)} disabled={!draft.properties.includes(property) && draft.properties.length >= 16} onChange={event => patch({ properties: event.target.checked ? [...draft.properties, property] : draft.properties.filter(item => item !== property) })} />{property === "value" && isInput(component.type) ? "Input value" : property}</label>)}</div>{draft.properties.filter(property => !allowedProperties.includes(property)).map(property => <p key={property}>Unsupported property: {property} <button type="button" className="button small" aria-label={`Remove unsupported watched property ${property}`} onClick={() => patch({ properties: draft.properties.filter(item => item !== property) })}>Remove</button></p>)}</fieldset>}
          {showCode && current && <>{selected === "action" ? <p className="input-events-description">Python 3 · gateway. Button actions validate and submit the form before execution.</p> : <EventScriptLanguagePicker language={current.language} pythonAvailable={pythonAvailable} restriction={pythonComponentEventRestriction} onChange={changeLanguage} />}
            <ScriptEditor key={`${selected}:${selected === "messages" ? handlerId : ""}`} value={current.code} language={current.language} completions={completions} onChange={changeScript} onSave={apply} />
            <p className={`component-event-count${current.code.length > 65536 ? " is-invalid" : ""}`}>{current.code.length.toLocaleString()} / 65,536 characters</p>
          </>}
          {error && <p className="input-events-error" role="alert">{error}</p>}
          <p className="input-events-description">{showCode && "Leave a handler empty to remove it. "}Apply changes all actions and events in one undo step. Save and publish to deploy.</p>
        </section>
        {renderEventContext()}
      </div>
    </div>
    <footer className="input-events-footer"><span>Ctrl+S applies all changes · Ctrl+Space completes</span><button type="button" className="button" onClick={onClose}>Cancel</button><button type="button" className="button primary" onClick={apply}>Apply actions &amp; events</button></footer>
  </dialog>;
}

/** Actions without a destination or code: Show a message needs its text; Close popup only explains itself. */
function SimpleActionDetails({ draft, onMessage }: { draft: ComponentActionsDraft; onMessage: (message: string) => void }) {
  if (draft.action === "closePopup") return <p>Closes the containing popup when activated.</p>;
  if (draft.action !== "notify") return null;
  return <><label>Message to show<textarea aria-label="Message to show" rows={3} maxLength={500} value={draft.notifyMessage} onChange={event => onMessage(event.target.value)} /></label>
    <p>Shows this text when the button is clicked, in Preview and the operator runtime. No script runs and nothing is sent to the gateway.</p></>;
}
