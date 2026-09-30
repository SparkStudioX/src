export type ComponentType =
  | "label"
  | "value"
  | "gauge"
  | "button"
  | "table"
  | "list"
  | "treeView"
  | "textInput"
  | "passwordInput"
  | "multiStateButton"
  | "multiStateIndicator"
  | "ledDisplay"
  | "progressBar"
  | "cylindricalTank"
  | "levelIndicator"
  | "thermometer"
  | "textArea"
  | "numberInput"
  | "spinner"
  | "slider"
  | "checkbox"
  | "toggle"
  | "select"
  | "radioGroup"
  | "dateTimeInput"
  | "template"
  | "repeater"
  | "image"
  | "icon"
  | "line"
  | "rectangle"
  | "ellipse"
  | "polyline"
  | "pipe"
  | "equipmentSymbol";
// Assets are stored locally by immutable content ID.
export interface Asset {
  id: string;
  name: string;
  contentType: string;
  size: number;
  width: number;
  height: number;
}
export type InputValue = string | number | boolean;
export type TemplateParameterType = "string" | "number" | "boolean";
export type ParameterValue = string | number | boolean;
export type RuntimeParameters = Record<string, ParameterValue>;
export type InputValues = Record<string, InputValue | null>;
export type StateScope = "session" | "screen" | "instance";
export interface InputStateBinding { scope: StateScope; key: string }
export type StateDefinitions = Record<string, CustomProperty>;
export interface RuntimeStateValues { session: RuntimeParameters; screen: RuntimeParameters; instance?: RuntimeParameters }
export type PythonUiProperty = "text" | "enabled" | "visible" | "color" | "backgroundColor" | "foregroundColor" | "borderColor" | "borderWidth" | "fontSize";
export type PythonUiProperties = Record<string, Partial<Record<PythonUiProperty, InputValue>>>;
export interface PythonUiSnapshot { state: RuntimeStateValues; properties: PythonUiProperties }
export type PythonUiLocalEffect = { kind: "state"; scope: StateScope; key: string; value: InputValue }
  | { kind: "property"; componentId: string; property: PythonUiProperty; value: InputValue };
export type PythonUiEffect = PythonUiLocalEffect | { kind: "input"; componentId: string; value: InputValue };
export interface PythonUiAction {
  readonly ui: PythonUiSnapshot;
  isCurrent: () => boolean;
  apply: (effects: unknown) => void;
}
/** Only explicitly referenced values from a template's containing scopes. */
export type ParameterBindingState = Partial<RuntimeStateValues>;
export interface RuntimeStateApi {
  get: (scope: StateScope, key: string) => InputValue | undefined;
  set: (scope: StateScope, key: string, value: unknown) => void;
  reset: (scope: StateScope, key?: string) => void;
}
export type InputEventType = "change" | "commit";
export interface InputEventScript {
  language: "javascript" | "python";
  code: string;
}
export type ComponentEventProperty = BindingTarget;
export interface ComponentEventScript { language: "javascript" | "python"; code: string }
export interface ComponentEvents {
  mount?: ComponentEventScript;
  unmount?: ComponentEventScript;
  propertyChange?: ComponentEventScript & { properties: ComponentEventProperty[] };
}
export type ComponentMessageScope = "instance" | "screen" | "session";
export interface ComponentMessageHandler {
  id: string;
  messageType: string;
  scope: ComponentMessageScope;
  language: "javascript" | "python";
  code: string;
}
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface ComponentMessageAction {
  messageType: string;
  scope: ComponentMessageScope;
  payload: Record<string, JsonValue>;
}
export type BindingTarget = "text" | "enabled" | "visible" | "color"
  | "x" | "y" | "width" | "height" | "fontSize"
  | "backgroundColor" | "foregroundColor" | "borderColor" | "borderWidth" | "tagPath" | "stateValue"
  | "value" | "min" | "max" | "decimals" | "unit" | "showValue" | "showPercent" | "orientation"
  | "strokeColor" | "fillColor" | "strokeWidth" | "rotation" | "flowing" | "flowReverse" | "active";
export interface DrawingPoint { x: number; y: number }
export type BindingReference =
  | { kind: "custom"; key: string; componentId?: string }
  | { kind: "input"; key: string }
  | { kind: "parameter"; key: string }
  | { kind: "sessionState"; key: string }
  | { kind: "screenState"; key: string }
  | { kind: "instanceState"; key: string }
  | { kind: "tag"; path: string };
export interface PropertyBinding {
  expression: string;
  references: Record<string, BindingReference>;
}
export interface QueryPropertyBinding {
  queryId: string;
  column: string;
  transform?: string;
  parameters?: Record<string, PropertyBinding>;
  refresh?: { mode: "onChange" | "poll"; intervalMs?: number };
}
export interface QueryPropertySample {
  status: "idle" | "loading" | "ready" | "error";
  value?: ParameterValue;
  error?: string;
  refreshing?: boolean;
}
export type QueryPropertyValues = Record<string, Partial<Record<BindingTarget, QueryPropertySample>>>;
export interface CustomProperty {
  type: "number" | "string" | "boolean";
  value: string | number | boolean;
}
export interface QueryOptionsSource {
  queryId: string;
  valueColumn: string;
  labelColumn: string;
  parentColumn?: string;
}
export interface QueryRepeaterSource {
  queryId: string;
  rowKey: string;
  parameterMap: Record<string, string>;
}
export interface TableColumnDefinition {
  key: string;
  label?: string;
  visible?: boolean;
  width?: number;
  align?: "left" | "center" | "right";
  format?: "auto" | "text" | "number" | "boolean" | "datetime";
  precision?: number;
  suffix?: string;
}
export interface TableEditColumn {
  key: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  integer?: boolean;
}
export interface TableEditDefinition {
  versionColumn: string;
  columns: TableEditColumn[];
  // Published runtime responses omit executable code.
  script?: string;
}
export interface TableCellEdit {
  key: string | number;
  version: number;
  column: string;
  value: InputValue;
}
export interface CanvasComponent {
  id: string;
  groupId?: string;
  type: ComponentType;
  x: number;
  y: number;
  width: number;
  height: number;
  props: {
    /** Optional project visual style; local values and bindings retain precedence. */
    styleId?: string;
    /** Optional reusable caption translation; input values and actions are never translated. */
    textKey?: string;
    stateBinding?: InputStateBinding;
    componentEvents?: ComponentEvents;
    messageHandlers?: ComponentMessageHandler[];
    events?: Partial<Record<InputEventType, InputEventScript>>;
    customProperties?: Record<string, CustomProperty>;
    enabled?: boolean;
    visible?: boolean;
    bindings?: Partial<Record<BindingTarget, PropertyBinding>>;
    queryBindings?: Partial<Record<BindingTarget, QueryPropertyBinding>>;
    text?: string;
    tagPath?: string;
    queryId?: string;
    selectionFields?: Record<string, string>;
    rowKey?: string;
    pageSize?: number;
    tableColumns?: TableColumnDefinition[];
    tableEdit?: TableEditDefinition;
    points?: DrawingPoint[];
    strokeColor?: string;
    fillColor?: string;
    strokeWidth?: number;
    rotation?: number;
    flowing?: boolean;
    flowReverse?: boolean;
    active?: boolean;
    symbol?: "pump" | "valve" | "motor";
    cornerRadius?: number;
    unit?: string;
    value?: number;
    decimals?: number;
    showValue?: boolean;
    showPercent?: boolean;
    orientation?: "horizontal" | "vertical";
    min?: number;
    max?: number;
    step?: number;
    color?: string;
    backgroundColor?: string;
    foregroundColor?: string;
    borderColor?: string;
    borderWidth?: number;
    fontSize?: number;
    targetScreenId?: string;
    fieldKey?: string;
    defaultValue?: InputValue;
    options?: { label: string; value: string; parentValue?: string }[];
    stateValue?: string;
    states?: { value: string; label: string; color: string }[];
    optionsSource?: QueryOptionsSource;
    action?: "navigate" | "script" | "openPopup" | "closePopup" | "message";
    message?: ComponentMessageAction;
    assetId?: string;
    fit?: "contain" | "cover" | "fill";
    alt?: string;
    icon?: string;
    script?: string;
    templateId?: string;
    parameters?: Record<string, string>;
    parameterBindings?: Record<string, PropertyBinding>;
    rows?: TemplateRow[];
    rowsSource?: QueryRepeaterSource;
    columns?: number;
    gap?: number;
    [key: string]: unknown;
  };
}
export interface Screen {
  id: string;
  name: string;
  width: number;
  height: number;
  components: CanvasComponent[];
  kind?: "screen" | "popup";
  parameters?: Record<string, string>;
  state?: StateDefinitions;
}
export interface Project {
  id: string;
  name: string;
  revision: number;
  parameters: Record<string, string>;
  screens: Screen[];
  templates?: Template[];
  navigation?: ProjectNavigationSettings;
  sessionState?: StateDefinitions;
  styles?: VisualStyle[];
  localization?: TranslationCatalog;
  authoringDefaults?: { screenWidth: number; screenHeight: number; templateWidth: number; templateHeight: number; gridSize: number };
}
export type VisualStyleProperty = "color" | "backgroundColor" | "foregroundColor" | "borderColor" | "borderWidth" | "fontSize";
export interface VisualStyle {
  id: string;
  name: string;
  properties: Partial<Pick<CanvasComponent["props"], VisualStyleProperty>>;
}
export interface TranslationCatalog {
  defaultLocale: string;
  locales: string[];
  messages: Record<string, Record<string, string>>;
}
export interface ProjectNavigationSettings {
  startupScreenId: string;
  mode: "none" | "menu";
  items: { screenId: string; label: string }[];
}
export interface Template extends Screen {
  parameters: Record<string, string>;
  parameterTypes?: Record<string, TemplateParameterType>;
  /** Private defaults; each rendered instance owns its mutable values. */
  instanceState?: StateDefinitions;
}
export interface TemplateRow {
  id: string;
  parameters: Record<string, string>;
}
export interface ResolvedTemplateRow {
  id: string;
  parameters: RuntimeParameters;
}
export interface InstancePathStep {
  instanceId: string;
  rowId?: string;
}
export interface InstanceAction {
  instanceId: string;
  rowId?: string;
  instancePath?: InstancePathStep[];
  /** Referenced parent input snapshots, one per instance boundary. */
  bindingInputs?: InputValues[];
  bindingState?: ParameterBindingState[];
  /** Local lifecycle guard; never serialized in action requests. */
  isCurrent?: () => boolean;
  querySourceParameters?: RuntimeParameters;
  template: Template;
  parameters: RuntimeParameters;
  inputs: InputValues;
}
export interface PopupOrigin {
  screenId: string;
  componentId: string;
  instanceId?: string;
  rowId?: string;
  instancePath?: InstancePathStep[];
  bindingInputs?: InputValues[];
  bindingState?: ParameterBindingState[];
}
export interface PopupState {
  id: string;
  screenId: string;
  parameters: Record<string, string>;
  rootParameters: Record<string, string>;
  origin: PopupOrigin;
  // Local source snapshot only; runtime actions send the published opener identity.
  querySourceParameters?: RuntimeParameters;
  queryRootParameters?: RuntimeParameters;
  templateParameterTypes?: Record<string, TemplateParameterType>;
  // Nested template definitions captured for local stale-source diagnostics.
  templateSourceSignature?: string;
}
export interface PopupAction {
  screen: Screen;
  component: CanvasComponent;
  parameters: Record<string, string>;
  inputs: InputValues;
  instance?: InstanceAction;
  popup: PopupState;
  uiAction?: PythonUiAction;
}
export interface Tag {
  path: string;
  value: unknown;
  dataType: string;
  quality: string;
  timestamp: string;
  source?: string;
}
export interface TagDefinition {
  path: string;
  kind?: "opcua" | "memory" | "expression";
  dataType: string;
  value?: unknown;
  connectionId?: string;
  nodeId?: string;
  publishingIntervalMs?: number;
  enabled?: boolean;
  expression?: string;
  inputs?: Record<string, string>;
}
export interface Publication {
  warnings?: string[];
  published?: boolean;
  revision?: number;
  publishedAt?: string;
}
export interface Connection {
  id: string;
  name: string;
  type: "opcua" | "sqlserver" | "sqlite";
  revision?: number;
  enabled?: boolean;
  lastTest?: { success: boolean; message: string; startedAt: string; completedAt: string; durationMs: number; revision: number; accepted: boolean };
  endpoint?: string;
  server?: string;
  database?: string;
  username?: string;
  password?: string;
  securityMode?: string;
  securityPolicy?: string;
  status?: string;
  lastError?: string;
  trustServerCertificate?: boolean;
  serverCertificateSha256?: string;
}
export interface QueryParameter {
  name: string;
  type: string;
  defaultValue: string | number | null;
}
export interface NamedQuery {
  id: string;
  name: string;
  connectionId: string;
  sql: string;
  kind?: "query" | "update";
  parameters: QueryParameter[];
}
export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  durationMs: number;
}
export interface ScriptResult {
  success: boolean;
  stdout: string;
  stderr: string;
  result?: unknown;
  durationMs: number;
  uiEffects?: PythonUiEffect[];
}
export type ScriptType = "library" | "gateway" | "client";
export type GatewayScriptEvent = "startup" | "update" | "shutdown" | "timer" | "tagChange" | "message" | "scheduled";
export interface ScriptResource {
  id: string;
  name: string;
  type: ScriptType;
  code: string;
  enabled: boolean;
  event?: GatewayScriptEvent | "screenOpen";
  intervalMs?: number;
  timeoutMs?: number;
  threading?: "dedicated" | "shared";
  delayType?: "fixedDelay" | "fixedRate";
  tagPaths?: string[];
  changeTriggers?: ("value" | "quality" | "timestamp")[];
  cron?: string;
  timeZone?: string;
  requiredPermission?: "operate" | "admin";
  parameters: Record<string, string | number | boolean | null>;
}
export interface BrowseNode {
  nodeId: string;
  displayName: string;
  isVariable: boolean;
}
export interface Health {
  status: string;
  version: string;
  pythonAvailable: boolean;
}
