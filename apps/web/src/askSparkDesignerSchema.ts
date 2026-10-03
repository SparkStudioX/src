import { runtimePropertyDefinitions } from "./runtimePropertyCatalog";
import { componentEventProperties, componentInteractionTypes } from "./componentEventModel";
import { componentMessageScopes, componentMessageScopeDescriptions } from "./componentMessageAuthoring";
import { pythonSystemCompletions } from "./eventScriptAuthoring";
import { tagWriteDataTypes } from "./componentActionsAuthoring";
import { isInput } from "./inputs";
import { defaultViewLayout } from "./viewContainers";
import { defaultChartProps } from "./chartModel";
import type { CanvasComponent, ComponentType } from "./types";
import type { DesignerSnapshot, ToolArgs } from "./askSparkDesignerModel";

type Schema = Record<string, unknown>;
const text = { type: "string" };
const code = { type: "string", minLength: 1, maxLength: 65_536, description: "Nonempty source code, not a script ID or action object." };
const languages = { type: "string", enum: ["javascript", "python"] };
const scopes = { type: "string", enum: componentMessageScopes };
const object = (properties: Record<string, Schema>, required = Object.keys(properties), additionalProperties: boolean | Schema = false): Schema => ({ type: "object", properties, required, additionalProperties });
const array = (items: Schema, minItems = 0, maxItems = 100): Schema => ({ type: "array", items, minItems, maxItems });
const dictionary = (values: Schema): Schema => ({ type: "object", additionalProperties: values });
const options = [{ value: "first", label: "First" }, { value: "second", label: "Second" }];
const range = { value: 25, min: 0, max: 100, decimals: 0, unit: "", showValue: true };
const drawing = { strokeColor: "#64748b", strokeWidth: 2, rotation: 0 };
const points = [{ x: 0, y: 50 }, { x: 100, y: 50 }];

/** Exhaustive at compile time; special-purpose examples name their required resources below. */
const exampleProps: Record<ComponentType, CanvasComponent["props"]> = {
  alarmStatusTable: { alarmMinimumPriority: 1 }, alarmJournalTable: { alarmMinimumPriority: 1 },
  historicalTrend: { historyPaths: [], historyMinutes: 60, historyMaxPoints: 1000 },
  chart: defaultChartProps(false), sparkline: defaultChartProps(true), equipmentCommand: { commandId: "existing_command" },
  label: { text: "Order summary", fontSize: 24, color: "#ffffff" },
  value: { text: "Value", tagPath: "[default]ExistingTag" }, gauge: { text: "Gauge", tagPath: "[default]ExistingTag", min: 0, max: 100 },
  button: { text: "Add item", action: "script", script: "result = {'message': 'Item selected.'}" },
  table: { data: { columns: ["Item", "Quantity"], rows: [{ Item: "Sample", Quantity: 1 }] }, pageSize: 25 },
  list: { options }, treeView: { options }, textInput: { defaultValue: "" },
  formattedInput: { defaultValue: "", formatMask: "AA-####", textCase: "upper" }, barcodeInput: { defaultValue: "", scanTerminator: "enter" },
  viewContainer: { viewLayout: defaultViewLayout("embedded", "existing_template") }, passwordInput: {},
  multiStateButton: { options }, multiStateIndicator: { stateValue: "ready", states: [{ value: "ready", label: "Ready", color: "#22c55e" }] },
  ledDisplay: { value: 25, decimals: 0, unit: "" }, progressBar: { ...range, orientation: "horizontal" },
  cylindricalTank: { ...range }, levelIndicator: { ...range, orientation: "vertical" }, thermometer: { ...range },
  textArea: { defaultValue: "" }, numberInput: { defaultValue: 0 }, spinner: { defaultValue: 0, step: 1 },
  slider: { defaultValue: 25, min: 0, max: 100, step: 1 }, checkbox: { defaultValue: false }, toggle: { defaultValue: false },
  select: { options }, radioGroup: { options }, dateTimeInput: { defaultValue: "" },
  template: { templateId: "existing_template", parameters: {} },
  repeater: { templateId: "existing_template", rows: [{ id: "first", parameters: {} }], columns: 1, gap: 16 },
  image: { assetId: "existing_asset", fit: "contain", alt: "Reference detail" }, computerCamera: {}, icon: { icon: "info", alt: "Information" },
  line: { ...drawing, points }, rectangle: { ...drawing, fillColor: "#1e293b", cornerRadius: 8 },
  ellipse: { ...drawing, fillColor: "none" }, polyline: { ...drawing, points },
  pipe: { ...drawing, points, strokeWidth: 12, fillColor: "#334155", flowing: false },
  equipmentSymbol: { ...drawing, fillColor: "#64748b", symbol: "pump", active: false },
};
export const designerComponentTypes = Object.keys(exampleProps) as ComponentType[];
const actionTypes = ["navigate", "script", "openPopup", "closePopup", "message", "setTagValue"];
const scriptSchema = object({ language: languages, code });
const messageSchema = object({ messageType: { ...text, minLength: 1, maxLength: 80 }, scope: scopes, payload: dictionary({}) });
const expressionBinding = object({ expression: { ...text, minLength: 1 }, references: dictionary({
  description: "Each alias uses exactly one reference format listed below.",
  oneOf: [object({ kind: { const: "tag" }, path: text }), object({ kind: { enum: ["input", "parameter", "sessionState", "screenState", "instanceState"] }, key: text }),
    object({ kind: { const: "custom" }, key: text, componentId: text }, ["kind", "key"])],
}) });
const refreshSchema = { oneOf: [object({ mode: { const: "onChange" } }), object({ mode: { const: "poll" }, intervalMs: { type: "integer", minimum: 1000, maximum: 3_600_000 } })] };
const querySource = object({ queryId: text, parameters: dictionary(expressionBinding), refresh: refreshSchema }, ["queryId"]);

function componentExample(type: ComponentType): CanvasComponent {
  return { id: `example_${type}`, type, x: 16, y: 16, width: 240, height: 80,
    props: { ...structuredClone(exampleProps[type]), ...(isInput(type) ? { fieldKey: `example_${type}` } : {}) } };
}

function eventsSchema(component: CanvasComponent) {
  const propertyChange = (language: "javascript" | "python") => object({ language: { const: language }, code,
    properties: { ...array({ enum: componentEventProperties(component, language) }, 1, 16), uniqueItems: true } });
  return {
    location: "props.componentEvents", supportedEvents: ["mount", "unmount", "propertyChange", ...componentInteractionTypes],
    schema: object({ ...Object.fromEntries(["mount", "unmount", ...componentInteractionTypes].map(name => [name, scriptSchema])),
      propertyChange: { oneOf: [propertyChange("javascript"), propertyChange("python")] } }, []),
    examples: { mount: { language: "javascript", code: 'console.log("Component mounted.");' },
      propertyChange: { language: "javascript", properties: ["visible"], code: 'console.log(event.property, event.value);' } },
    restrictions: ["There is no click or onClick event. Button activation uses props.action and its companion properties.",
      "Interaction events observe native behavior; they do not replace button actions or cancel browser events.",
      "Use exactly language and code on each handler; propertyChange additionally requires properties. Code strings alone are invalid.",
      "Unmount is cleanup: UI setters and notifications do nothing. Password values cannot be watched; Python cannot watch password text."],
  };
}

function nativeActions() {
  return {
    location: "props.action", schema: { type: "string", enum: actionTypes }, default: "navigate",
    note: "Action is a string, never an object or array. Companion fields are siblings inside props. Update actions through update_components.patch.props; set_component_section does not accept action or script.",
    variants: [
      { action: "navigate", componentTypes: ["button", "equipmentSymbol"], fields: object({ action: { const: "navigate" }, targetScreenId: text }), example: { action: "navigate", targetScreenId: "existing_screen" }, rules: "Target must be an existing regular screen. Navigation uses its saved parameter defaults." },
      { action: "script", componentTypes: ["button", "equipmentSymbol"], fields: object({ action: { const: "script" }, script: code }), example: { action: "script", script: "result = {'message': 'Item selected.'}" }, rules: "props.script is Python gateway source, not JavaScript or a script ID. A successful result.message is displayed as action feedback. It runs only when the operator activates the component." },
      { action: "openPopup", componentTypes: ["button", "equipmentSymbol"], fields: object({ action: { const: "openPopup" }, targetScreenId: text, parameters: dictionary(text) }, ["action", "targetScreenId"]), example: { action: "openPopup", targetScreenId: "existing_popup", parameters: {} }, rules: "Target must be an existing popup. Overrides name declared parameters and contain strings. A popup cannot open another popup." },
      { action: "closePopup", componentTypes: ["button", "equipmentSymbol"], fields: object({ action: { const: "closePopup" } }), example: { action: "closePopup" }, rules: "Valid only within a popup placement." },
      { action: "message", componentTypes: ["button"], fields: object({ action: { const: "message" }, message: messageSchema }), example: { action: "message", message: { messageType: "order.changed", scope: "screen", payload: { item: "Sample" } } }, rules: "Sends an exact named message to authored matching handlers. It does not show a toast. An absent receiver produces no visible notification." },
      { action: "setTagValue", componentTypes: ["button"], fields: object({ action: { const: "setTagValue" }, tagWrite: object({
        tagPath: text, dataType: { enum: tagWriteDataTypes }, value: { type: ["string", "number", "boolean"] }, valueReference: { oneOf: [
          object({ kind: { const: "property" }, property: text, componentId: text }, ["kind", "property"]),
          object({ kind: { const: "parentProperty" }, property: { enum: ["name", "width", "height"] } }),
        ] }, confirmation: { ...text, minLength: 1, maxLength: 512 },
      }, ["tagPath", "dataType"]) }), example: { action: "setTagValue", tagWrite: { tagPath: "[default]ExistingTag", dataType: "Boolean", value: true } }, rules: "Exactly one of value/valueReference is required and must match the existing writable tag type. No password sources. Live writes require published operator runtime permissions; they cannot run in Designer Preview." },
    ],
  };
}

function runtimeScripts() {
  return {
    clickToast: { nativeToastAction: false, mechanism: "Python button action result.message", propsExample: { text: "Add item", action: "script", script: "result = {'message': 'Item selected.'}" },
      requirements: "Author the Python source as a draft; do not run it to configure the button. Interactive Preview requires enabled communication/scripts and a gateway administrator. Operator runtime uses published scripts and existing action permissions. Do not call published runtime action tools to test an unsaved Designer draft. Input validation can block an action.",
      display: "Designer Preview shows its global action toast. Published operator runtime shows the action status message. This is the existing action-feedback path, not a browser toast API." },
    javascript: { globals: ["event", "inputs", "parameters", "app"], methods: ["app.notify(message)", "app.setInput(fieldKey, value)", "app.state.get(scope, key)", "app.state.set(scope, key, value)", "app.state.reset(scope, key?)", "app.sendMessage(messageType, payload, {scope})", "app.onCleanup(callback)"],
      cancellation: "app.signal", notice: "app.notify is component-event/input feedback, not the application-level click toast; do not use it to promise an operator toast. app.onCleanup is for component events, not input change/commit handlers. Unmount helpers cannot update UI.",
      example: { componentEvents: { focus: { language: "javascript", code: 'console.log("Focused", event.componentId);' } } } },
    python: { globals: ["self", "event (automatic handlers only)", "inputs", "parameters", "result"],
      systemFunctions: pythonSystemCompletions.map(({ label, detail }) => ({ name: label, description: detail })),
      localUi: ["self.text", "self.props", "self.getSibling(componentId)", "self.parent.getChild(componentId)", "self.parent.custom", "system.ui.getState(scope, key)", "system.ui.setState(scope, key, value)", "system.ui.getProperty(componentId, property)", "system.ui.setProperty(componentId, property, value)"],
      restrictions: "Only supported presentation properties and declared state are writable. Automatic events omit password values. Browser app.* is not available in Python." },
  };
}

function componentSections(component: CanvasComponent) {
  const queryBinding = object({ queryId: text, column: text, parameters: dictionary(expressionBinding), transform: text, refresh: refreshSchema }, ["queryId", "column"]);
  return {
    events: { schema: object(Object.fromEntries(["change", "commit"].map(name => [name, component.type === "passwordInput" ? object({ language: { const: "javascript" }, code }) : scriptSchema])), []), supported: isInput(component.type),
      supportedComponentTypes: designerComponentTypes.filter(isInput), example: { change: { language: "javascript", code: 'console.log(event.value);' } }, note: "Only input components accept change/commit events. Never add props.events to a button. Each handler has exactly language and code." },
    componentEvents: eventsSchema(component),
    messageHandlers: { schema: array(object({ id: { ...text, pattern: "^[A-Za-z_][A-Za-z0-9_-]{0,79}$" }, messageType: { ...text, minLength: 1, maxLength: 80 }, scope: scopes, language: languages, code }), 0, 16),
      example: [{ id: "order_listener", messageType: "order.changed", scope: "screen", language: "javascript", code: 'console.log(event.messageType, event.payload);' }],
      note: "Exactly five fields per handler. IDs and (messageType,scope) pairs must be unique within a component. Message type is trimmed and has no control characters. Scope is local to this runtime tab. Payloads are JSON objects limited to 64 KiB, 4,096 values and 16 nested levels; numbers must be finite and integers exact.", scopes: componentMessageScopeDescriptions },
    customProperties: { schema: dictionary({ oneOf: ["string", "number", "boolean"].map(type => object({ type: { const: type }, value: { type } })) }), example: { target: { type: "number", value: 0 } }, note: "Declare before binding customProperties.key.value." },
    stateBinding: { schema: object({ scope: { enum: ["session", "screen", "instance"] }, key: text }), example: { scope: "screen", key: "quantity" }, note: "Input components only. Key must exist in project.sessionState, screen.state, or template.instanceState with a compatible type." },
    dataSource: { schema: querySource, example: { queryId: "existing_read_query", parameters: {} }, note: "Named-query dataset source for table/chart/sparkline. Inspect the query and bind its declared parameters. Query parameter expressions cannot read live tags or password values." },
    tableEdit: { schema: tableEditSchema(),
      example: { versionColumn: "Version", columns: [{ key: "Quantity", type: "number", min: 0 }], script: "raise RuntimeError('Configure the validated edit implementation before use.')" }, note: "Table only; requires existing read queryId, unique rowKey and a different version column. Exactly one Python script (up to 64,000 characters) or batch definition handles edits. Implement and review the example script before use; do not add a write workflow unless requested." },
    rowsSource: { schema: object({ queryId: text, rowKey: text, parameterMap: { ...dictionary(text), maxProperties: 64 }, maxRows: { type: "integer", minimum: 1, maximum: 100 } }, ["queryId", "rowKey", "parameterMap"]), example: { queryId: "existing_read_query", rowKey: "Id", parameterMap: { title: "Title" } }, note: "Repeater only; map declared template parameter names to query column names. Replaces static rows." },
    parameterBindings: { schema: dictionary(expressionBinding), example: { title: { expression: "value", references: { value: { kind: "screenState", key: "title" } } } }, note: "Template/repeater parameters; target names and resulting types must match the referenced template declarations." },
    parameters: { schema: dictionary(text), example: { title: "Order detail" }, note: "String overrides for declared popup/template parameters; do not invent parameter keys." },
    viewLayout: { schema: viewLayoutSchema(), example: defaultViewLayout("tabs", "existing_template"), note: "viewContainer only. Every pane references an existing template. Embedded: one pane; split: two; tabs: 1–16; dock: one center and at most four unique side edges. orientation/ratio are split-only, initialPaneId tabs-only, edge/size/initiallyOpen dock-only; center panes cannot set size or initiallyOpen." },
    optionsSource: { schema: object({ queryId: text, valueColumn: text, labelColumn: text, parentColumn: text }, component.type === "treeView" ? ["queryId", "valueColumn", "labelColumn", "parentColumn"] : ["queryId", "valueColumn", "labelColumn"]), example: { queryId: "existing_read_query", valueColumn: "Id", labelColumn: "Name", ...(component.type === "treeView" ? { parentColumn: "ParentId" } : {}) }, note: "select/list/treeView only. parentColumn is required for treeView and forbidden for other types." },
    bindings: { schema: dictionary(expressionBinding), example: { text: { expression: "temperature * 1.8 + 32", references: { temperature: { kind: "tag", path: "[default]ExistingTag" } } } }, note: "Use set_binding; property keys must be supported runtime binding targets. No implicit variables outside references." },
    queryBindings: { schema: dictionary(queryBinding), example: { text: { queryId: "existing_read_query", column: "Value" } }, note: "Use set_binding with kind=query. Expression and query bindings cannot coexist on the same property. Query parameter expressions cannot read live tags or password values." },
  };
}

function tableEditSchema(): Schema {
  const columns = array(object({ key: { ...text, minLength: 1, maxLength: 128 }, type: { enum: ["string", "number", "boolean"] }, required: { type: "boolean" },
    maxLength: { type: "integer", minimum: 1, maximum: 4096 }, min: { type: "number" }, max: { type: "number" }, integer: { type: "boolean" } }, ["key", "type"]), 1, 64);
  const common = { versionColumn: text, columns };
  return { oneOf: [object({ ...common, script: { ...code, maxLength: 64000 } }), object({ ...common, batch: object({ table: text }) })] };
}

function viewLayoutSchema(): Schema {
  return object({ kind: { enum: ["embedded", "tabs", "split", "dock"] }, panes: array(object({ id: { ...text, pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }, label: { ...text, minLength: 1, maxLength: 120 }, templateId: text,
    parameters: dictionary(text), edge: { enum: ["center", "left", "right", "top", "bottom"] }, initiallyOpen: { type: "boolean" }, size: { type: "number", minimum: 80, maximum: 1600 } }, ["id", "label", "templateId"]), 1, 16),
    initialPaneId: text, orientation: { enum: ["horizontal", "vertical"] }, ratio: { type: "number", minimum: 10, maximum: 90 } }, ["kind", "panes"]);
}

const detailNames = ["actions", "scripts", "resources", "events", "componentEvents", "messageHandlers", "customProperties", "stateBinding", "dataSource", "tableEdit", "rowsSource", "parameterBindings", "parameters", "viewLayout", "optionsSource", "bindings", "queryBindings"] as const;
type DetailName = typeof detailNames[number];

function requestedDetails(args: ToolArgs): Set<DetailName> {
  if (args.detail !== undefined && args.detail !== "compact" && args.detail !== "full") throw new Error("Schema detail must be compact or full.");
  if (args.include !== undefined && (!Array.isArray(args.include) || args.include.length > detailNames.length || args.include.some(name => !detailNames.includes(name as DetailName)))) {
    throw new Error(`Schema include must list supported details: ${detailNames.join(", ")}.`);
  }
  return new Set(args.detail === "full" ? detailNames : args.include as DetailName[] | undefined);
}

function actionSummary(type: ComponentType) {
  if (type !== "button" && type !== "equipmentSymbol") return undefined;
  return {
    location: "props.action", schema: { type: "string", enum: type === "button" ? actionTypes : actionTypes.slice(0, 4) }, default: "navigate",
    note: "Action is a string. Companion fields are sibling props, set with update_components.patch.props. There is no click/onClick component event.",
    examples: { navigate: { action: "navigate", targetScreenId: "existing_regular_screen" }, script: { action: "script", script: "result = {'message': 'Item selected.'}" } },
    script: "props.script is Python gateway source, authored as a draft without executing it. A result.message provides action feedback on activation. Interactive Preview requires enabled communication/scripts and a gateway administrator; published runtime requires action permissions. Never use published runtime tools to test an unsaved draft.",
    more: "Before authoring other actions or complex scripts, request include:[actions] or include:[scripts]. message dispatches to matching handlers; it does not itself show a toast.",
  };
}

export function designerComponentSchema(snapshot: DesignerSnapshot, args: ToolArgs) {
  if (args.type !== undefined && !designerComponentTypes.includes(args.type as ComponentType)) throw new Error(`Unsupported component type. Choose one of: ${designerComponentTypes.join(", ")}.`);
  const type = (args.type ?? "button") as ComponentType, component = componentExample(type), requested = requestedDetails(args);
  const sections = componentSections(component);
  const selectedSections = Object.fromEntries(Object.entries(sections).filter(([name]) => requested.has(name as DetailName)));
  const actions = requested.has("actions") ? nativeActions() : actionSummary(type);
  const assetResources = { assetCount: snapshot.assets.length,
    assets: snapshot.assets.slice(0, 25).map(({ id, name, width, height }) => ({ id, name, width, height })), assetsNotice: "First 25 assets; reuse an appropriate existing asset. Use assets_list only when the asset you need is not listed." };
  const existingResources = requested.has("resources") ? { ...assetResources,
    screens: snapshot.project.screens.map(({ id, name, kind }) => ({ id, name, kind: kind ?? "screen" })),
    templates: (snapshot.project.templates ?? []).map(({ id, name }) => ({ id, name })),
  } : type === "image" ? assetResources : undefined;
  return {
    supportedComponentTypes: designerComponentTypes, selectedType: type,
    component: { required: ["id", "type", "x", "y", "width", "height", "props"], optional: ["groupId"], example: component,
      coordinates: "x/y/width/height are root component fields, in canvas pixels. Props are nested under props. Components are stacked in array order; later elements appear above earlier ones.",
      identifiers: "Choose new document-scoped IDs. Groups need at least two components. Input fieldKey values must be unique identifiers within the form.",
      dependencies: "Examples use placeholders such as existing_template, existing_command, existing_read_query and [default]ExistingTag: replace them only with inspected resources. Images require a returned asset ID; templates need declared parameters; equipment commands require an existing command. No arbitrary HTML/SVG/CSS component types exist." },
    examples: (args.type ? [type] : ["label", "button", "rectangle", "textInput", "image", "table"] as ComponentType[]).map(componentExample),
    properties: runtimePropertyDefinitions.filter(item => (args.detail === "full" && !args.type) || item.components.includes("*") || item.components.includes(type)).map(({ components, ...item }) => ({ ...item, ...(args.detail === "full" ? { components } : {}), location: ["x", "y", "width", "height"].includes(item.path) ? item.path : `props.${item.path}` })),
    colors: { formats: ["#RGB", "#RGBA", "#RRGGBB", "#RRGGBBAA"], transparent: "#00000000", note: "Named CSS colors, transparent, rgba() and gradients are invalid. A color property's enum lists extra permitted values (for example fillColor:none), not a replacement for hex colors. Chart series colors require #RRGGBB." },
    ...(actions ? { actions } : {}), ...(requested.has("scripts") ? { scripts: runtimeScripts() } : {}),
    ...(type === "button" ? { overlayAppearance: {
      propsExample: { text: "Recall by number", foregroundColor: "#00000000", backgroundColor: "#00000000", borderColor: "#00000000", borderWidth: 0 },
      note: "For requested screenshot overlays, keep meaningful text so the button retains its accessible name; do not use empty or whitespace captions. Transparent foreground hides its caption and icon. The existing button shadow remains: this is not a fully invisible hotspot style. Do not invent CSS or unsupported props to remove it. Apply shared appearance to all button IDs in one update.",
    } } : {}),
    ...(Object.keys(selectedSections).length ? { sections: selectedSections } : {}),
    detailLookup: { available: detailNames, instruction: "This compact schema includes the chosen type's complete runtime property constraints and basic action guidance. Request include:[sectionName] for exact structured section formats before editing them; include:[actions] for all action variants, include:[scripts] for runtime APIs, or detail:full for the complete reference. Reuse already loaded schemas during this task." },
    sectionEditing: "set_component_section replaces the whole named section; fetch its schema using include:[sectionName]. Input change/commit use events; lifecycle/interaction handlers use componentEvents. Set bindings through set_binding. Set action/script/message/tagWrite and other props through update_components.patch.props, which shallow-merges props. One update_components call can apply a shared patch to many componentIds; include only the changed props.",
    ...(existingResources ? { existingResources } : {}),
    resourceLookup: "Image schemas include the first 25 existing asset IDs, names and dimensions for immediate reuse. Inspect additional resources only when needed: inspect_context for documents, assets_list for more assets, or include:[resources] for a resource summary. Do not create disposable test assets to probe tools.",
    validation: "Gateway authoring validation is authoritative. After a rejected edit, inspect this schema and correct the reported field; do not probe invented action/event names. Saving and publication remain separate.",
  };
}
