export type ComponentType =
  | "alarmStatusTable"
  | "alarmJournalTable"
  | "historicalTrend"
  | "chart"
  | "sparkline"
  | "equipmentCommand"
  | "label"
  | "value"
  | "gauge"
  | "button"
  | "table"
  | "list"
  | "treeView"
  | "textInput"
  | "formattedInput"
  | "barcodeInput"
  | "viewContainer"
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
  | "computerCamera"
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
export type TagWriteDataType = "Boolean" | "Int16" | "Int32" | "Int64" | "UInt16" | "UInt32" | "Float" | "Double" | "String";
export type TagWritePropertyReference = { kind: "property"; componentId?: string; property: string }
  | { kind: "parentProperty"; property: "name" | "width" | "height" };
export type TagWriteAction = { tagPath: string; dataType: TagWriteDataType; confirmation?: string } & (
  { value: InputValue; valueReference?: never } | { value?: never; valueReference: TagWritePropertyReference });
export type TemplateParameterType = "string" | "number" | "boolean" | "model";
export interface ModelParameterRequirement { definitionId: string; minVersion?: number; maxVersion?: number }
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
export type ComponentInteractionEventType = "focus" | "blur" | "keyDown" | "keyUp" | "doubleClick" | "pointerDown" | "pointerUp";
export interface ComponentEvents {
  mount?: ComponentEventScript;
  unmount?: ComponentEventScript;
  propertyChange?: ComponentEventScript & { properties: ComponentEventProperty[] };
  focus?: ComponentEventScript;
  blur?: ComponentEventScript;
  keyDown?: ComponentEventScript;
  keyUp?: ComponentEventScript;
  doubleClick?: ComponentEventScript;
  pointerDown?: ComponentEventScript;
  pointerUp?: ComponentEventScript;
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
  | "strokeColor" | "fillColor" | "strokeWidth" | "rotation" | "flowing" | "flowReverse" | "active"
  | "step" | "points" | "symbol" | "cornerRadius" | "assetId" | "imageUrl" | "fit" | "alt" | "icon"
  | "options" | "states" | "pageSize" | "tableColumns" | "selectionMode" | "data" | "columns" | "gap"
  | "historyPaths" | "historyMinutes" | "historyMaxPoints" | "alarmMinimumPriority" | "formatMask" | "textCase" | "scanTerminator"
  | `validation.${"required" | "minLength" | "maxLength" | "format" | "message"}`
  | `chart.${"kind" | "xKey" | "endKey" | "qualityKey" | "series" | "yMin" | "yMax" | "showLegend" | "rangeSelector"}`
  | `viewLayout.${"kind" | "orientation" | "ratio"}`
  | `viewLayout.panes.${number}.${"label" | "size" | "edge"}`
  | `customProperties.${string}.value`;
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
export interface Dataset { columns: string[]; rows: Record<string, ParameterValue | null>[] }
export interface QueryDatasetSource {
  queryId: string;
  parameters?: Record<string, PropertyBinding>;
  refresh?: { mode: "onChange" | "poll"; intervalMs?: number };
}
export interface DatasetSample { status: "idle" | "loading" | "ready" | "error"; data?: Dataset; error?: string; refreshing?: boolean }
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
  maxRows?: number;
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
  batch?: { table: string };
}
export interface TableCellEdit {
  key: string | number;
  version: number;
  column: string;
  value: InputValue;
}
export type TableEditIntent = TableCellEdit | { edits: TableCellEdit[] };
export interface InputValidationDefinition {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  format?: "text" | "email" | "digits" | "alphanumeric";
  message?: string;
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
    viewLayout?: import("./viewContainers").ViewLayout;
    validation?: InputValidationDefinition;
    formatMask?: string;
    textCase?: "preserve" | "upper" | "lower";
    scanTerminator?: "enter" | "tab";
    selectionMode?: "single" | "multiple";
    chart?: import("./chartModel").ChartDefinition;
    commandId?: string;
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
    data?: Dataset;
    dataSource?: QueryDatasetSource;
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
    action?: "navigate" | "script" | "openPopup" | "closePopup" | "message" | "setTagValue";
    tagWrite?: TagWriteAction;
    message?: ComponentMessageAction;
    assetId?: string;
    /** Transient same-origin blob URL; generated bytes are never project assets. */
    imageUrl?: string;
    fit?: "contain" | "cover" | "fill";
    alt?: string;
    icon?: string;
    script?: string;
    templateId?: string;
    parameters?: Record<string, string>;
    parameterBindings?: Record<string, PropertyBinding>;
    rows?: TemplateRow[];
    historyPaths?: string[];
    historyMinutes?: number;
    historyMaxPoints?: number;
    alarmMinimumPriority?: number;
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
  commands?: import("./EquipmentCommand").EquipmentCommandDefinition[];
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
  /** Portable model requirements; gateway types and instances are never included in a project package. */
  modelParameters?: Record<string, ModelParameterRequirement>;
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
  sourceParameterScopes?: RuntimeParameters[];
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
  sourceParameterScopes?: RuntimeParameters[];
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
  writable?: boolean;
}
export interface TagDefinition {
  absoluteDeadband?: number;
  queueSize?: number;
  path: string;
  kind?: "opcua" | "device" | "memory" | "expression";
  writable?: boolean;
  dataType: string;
  value?: unknown;
  connectionId?: string;
  nodeId?: string;
  publishingIntervalMs?: number;
  enabled?: boolean;
  expression?: string;
  inputs?: Record<string, string>;
  scanGroup?: string;
  effectiveEnabled?: boolean;
  udtInstance?: string;
  udtDefinition?: string;
  udtVersion?: number;
  udtMember?: string;
  overrideFields?: string[];
}
export interface Publication {
  scriptsRevision?: number;
  complete?: boolean;
  warnings?: string[];
  published?: boolean;
  revision?: number;
  publishedAt?: string;
}
export type DeviceConnectionType = "modbus-tcp" | "ab-eip" | "siemens-s7" | "beckhoff-ads";
export type SourceConnectionType = "mtconnect" | "i3x" | "mqtt";
export type ConnectionEditorSection = "connection" | "security" | "acquisition" | "mappings" | "points" | "browse" | "schema" | "mapping-test" | "ownership" | "advanced" | "diagnostics";
export interface SourcePoint { id: string; name: string; address: string; dataType: TagWriteDataType; selector?: string | null; writable?: false; mappingId?: string | null; suggestedPath?: string | null; owned?: boolean }
export interface SourceAuthentication { mode: "none" | "basic" | "bearer" | "api-key"; username?: string | null; password?: string | null; token?: string | null; header?: string; hasPassword?: boolean; hasToken?: boolean }
export interface SourceLimits {
  documentBytes?: number; valueBytes?: number; stateBytes?: number; queueBytes?: number; queueCount?: number;
  packetBytes?: number; payloadBytes?: number; catalogCount?: number; catalogBytes?: number;
  requestTimeoutMs?: number; operationTimeoutMs?: number; connectTimeoutMs?: number;
  decodeNodes?: number; decodeBytes?: number; scriptTimeoutMs?: number; scriptResultBytes?: number;
  scriptResultDepth?: number; scriptResultMembers?: number; scriptResultLeaves?: number; workerCount?: number;
}
export interface SourceMqttMapping {
  id: string; topicFilter: string; root: string; tags: "explicit" | "review" | "automatic";
  payload: "scalar" | "script"; script?: string | null; timestampExpression?: string | null;
  dataType?: TagWriteDataType | null; qos?: number; retained?: "uncertain" | "good" | "ignore";
  staleAfterMs?: number; stripLevels?: number; structuredUpdates?: "snapshot" | "patch";
  enabled?: boolean; maximumTags?: number; pruneAfterSeconds?: number;
  ordering?: "receipt" | "sequence" | "timestamp"; sequenceExpression?: string | null;
  epochExpression?: string | null; shape?: "scalar" | "structure";
}
export interface SourceSettings {
  endpoint: string; acquisition?: "poll" | "subscribe"; intervalMs?: number; points?: SourcePoint[];
  authentication?: SourceAuthentication; tls?: { caCertificateReference?: string | null; clientCertificateReference?: string | null; clientKeyReference?: string | null; serverCertificateSha256?: string | null };
  limits?: SourceLimits;
  mtConnect?: { device?: string | null; path?: string | null; heartbeatMs?: number; count?: number; userAgent?: string };
  i3x?: { preferStream?: boolean; maxDepth?: number; reconciliationSeconds?: number; clientId?: string | null };
  mqtt?: { protocolVersion?: "3.1.1" | "5"; transport?: "tcp" | "tls" | "websocket"; clientId?: string | null; keepAliveSeconds?: number; cleanStart?: boolean; sessionExpirySeconds?: number; mappings?: SourceMqttMapping[] };
}
export interface SourceBrowseEntry { address: string; name: string; isVariable: boolean; dataType?: string | null; selector?: string | null; parent?: string | null; metadata?: Record<string, unknown> | null; mappingId?: string | null; suggestedPath?: string | null }
export interface SourceBrowsePage { entries: SourceBrowseEntry[]; continuationToken?: string | null; truncated: boolean; generation: number; bindingRevision: number }
export interface SourceImportPoint { address: string; name: string; dataType: TagWriteDataType; path: string; selector?: string | null; mappingId?: string | null }
export interface SourceImportPreview { previewToken: string; points: SourcePoint[]; tags: TagDefinition[]; totalTags: number }
export interface SourceMigrationPreview { token: string; changed: boolean; changes: { pointId: string; before: string; after: string; dataType: string; suppressed?: boolean; pruned?: boolean }[] }
export interface SourceReadValue { pointId: string; value: unknown; dataType: string; quality: string; sourceTimestamp?: string | null; receiptTimestamp?: string | null; nativeStatus?: string | null; action?: string | number }
export interface SourceScriptTestResult { success: boolean; skip: boolean; values: SourceReadValue[]; discoveries: { mappingId: string; address: string; selector?: string | null; name: string; dataType: string; suggestedPath: string; value?: unknown; quality: string; sourceTimestamp?: string | null; retained: boolean; shape: string }[]; error?: string | null; elapsedMs: number; structuredUpdates?: "snapshot" | "patch" | null }
export interface SourceOwnedPoint { pointId: string; mappingId: string; address: string; selector?: string | null; name: string; path: string; dataType: string; suppressed: boolean; pruned: boolean; lastSeen?: string }
export interface DevicePoint {
  id: string;
  name: string;
  address: string;
  dataType: TagWriteDataType;
  rawDataType?: TagWriteDataType | null;
  writable: boolean;
  byteSwap?: boolean;
  wordSwap?: boolean;
  stringLength?: number;
  scale?: number;
  offset?: number;
}
export interface DeviceSettings {
  host: string;
  port: number;
  unitId?: number;
  controllerFamily?: string;
  route?: string;
  rack?: number;
  slot?: number;
  localAmsNetId?: string;
  targetAmsNetId?: string;
  contentionDomain?: string;
  timeoutMs?: number;
  points: DevicePoint[];
}
export interface Connection {
  id: string;
  name: string;
  type: "opcua" | "sqlserver" | "sqlite" | DeviceConnectionType | SourceConnectionType;
  device?: DeviceSettings;
  source?: SourceSettings;
  sourceMigrationToken?: string;
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
  dataType?: string;
  writable?: boolean;
  browseMode?: string;
  pointId?: string;
  address?: string;
  stringLength?: number;
}
export interface Health {
  status: string;
  version: string;
  pythonAvailable: boolean;
}
