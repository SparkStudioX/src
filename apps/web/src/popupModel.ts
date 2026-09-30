import { id, resolvePath } from "./api";
import { instanceRequestScope, queryTemplateParameters, templateParameters } from "./templateModel";
import { panePlacement } from "./viewContainers";
import { parameterBindingStateContext, resolveParameterBindings } from "./templateParameterBindings";
import { loadQueryRepeater } from "./queryRepeater";
import type { RepeaterApi } from "./queryRepeater";
import type {
  CanvasComponent,
  InstanceAction,
  PopupState,
  Project,
  QueryRepeaterSource,
  Screen,
  Template,
  ResolvedTemplateRow,
  RuntimeParameters,
  InstancePathStep,
  TemplateRow,
  InputValues,
  ParameterBindingState,
  StateDefinitions,
  RuntimeStateValues,
  Tag,
} from "./types";

export function screenParameters(
  screen: Screen,
  root: Record<string, string>,
): Record<string, string> {
  return {
    ...root,
    ...Object.fromEntries(
      Object.entries(screen.parameters || {}).map(([key, value]) => [
        key,
        resolvePath(value, root),
      ]),
    ),
  };
}

export function createPopup(
  project: Project,
  source: Screen,
  button: CanvasComponent,
  root: Record<string, string>,
  caller: RuntimeParameters,
  instance?: InstanceAction,
): PopupState {
  if (source.kind === "popup")
    throw new Error(
      "A popup cannot open another popup. Close it to return to your screen.",
    );
  const target = project.screens.find(
    (screen) =>
      screen.id === button.props.targetScreenId && screen.kind === "popup",
  );
  if (!target)
    throw new Error("Choose a popup screen in this button’s properties.");
  const overrides = Object.fromEntries(
    Object.entries(button.props.parameters || {}).map(([key, value]) => {
      if (!Object.hasOwn(target.parameters || {}, key))
        throw new Error(`The popup does not declare the parameter '${key}'.`);
      return [key, resolvePath(value, caller)];
    }),
  );
  const path = instance ? instance.instancePath ?? [{ instanceId: instance.instanceId, ...(instance.rowId === undefined ? {} : { rowId: instance.rowId }) }] : [];
  const container = instance && source.components.find(component => component.id === path[0]?.instanceId);
  const trace = path.length > 1 || container ? traceSource(project, source, path) : [];
  const querySource = trace.some(step => step.instance.props.rowsSource || Object.values(step.instance.props.parameterBindings ?? {}).some(binding => Object.values(binding.references).some(reference => reference.kind === "tag")));
  return {
    id: id("popup"),
    screenId: target.id,
    rootParameters: { ...root },
    parameters: { ...screenParameters(target, root), ...overrides },
    ...(querySource ? { querySourceParameters: { ...caller } } : {}),
    ...(querySource && path.length > 1 ? { queryRootParameters: { ...(instance?.querySourceParameters ?? caller) } } : {}),
    ...(instance ? { templateParameterTypes: { ...instance.template.parameterTypes } } : {}),
    ...(instance?.sourceParameterScopes ? { sourceParameterScopes: structuredClone(instance.sourceParameterScopes) } : {}),
    ...(trace.length ? { templateSourceSignature: sourceSignature(trace) } : {}),
    origin: {
      screenId: source.id,
      componentId: button.id,
      ...instanceRequestScope(instance),
      ...(instance?.bindingInputs ? { bindingInputs: instance.bindingInputs.map(values => ({ ...values })) } : {}),
      ...(instance?.bindingState ? { bindingState: structuredClone(instance.bindingState) } : {}),
    },
  };
}

export interface PopupQuerySource {
  source?: QueryRepeaterSource;
  template?: Template;
  parameters: RuntimeParameters;
  overrides?: Record<string, string>;
  rowId?: string;
  descendants?: SourceStep[];
  root?: SourceStep;
  bindingInputs?: InputValues[];
  bindingState?: ParameterBindingState[];
  error: string;
}

interface SourceStep {
  instance: CanvasComponent; template: Template; row?: TemplateRow; parentComponents: CanvasComponent[]; parentParameters: Record<string, string>;
  stateDefinitions: Partial<Record<keyof RuntimeStateValues, StateDefinitions>>;
}
function traceSource(project: Project, screen: Screen, path: InstancePathStep[]): SourceStep[] {
  if (!path.length || path.length > 4) throw new Error("The source template path is no longer available. Close this popup and open it again.");
  let scope = screen;
  const seen = new Set<string>();
  return path.map(step => {
    const authored = scope.components.find(item => item.id === step.instanceId && (item.type === "template" || item.type === "repeater" || item.type === "viewContainer"));
    const pane = authored?.type === "viewContainer" ? authored.props.viewLayout?.panes.find(pane => pane.id === step.rowId) : undefined;
    const instance = authored?.type === "viewContainer" ? pane ? panePlacement(authored, pane) : undefined : authored;
    const template = project.templates?.find(item => item.id === instance?.props.templateId);
    if (!instance || !template || seen.has(template.id)) throw new Error("The source template is no longer available. Close this popup and open it again.");
    seen.add(template.id);
    let row: TemplateRow | undefined;
    if (instance.type === "repeater") {
      if (!step.rowId) throw new Error("The source row is no longer available. Close this popup and open a current record.");
      if (!instance.props.rowsSource) {
        row = instance.props.rows?.find(item => item.id === step.rowId);
        if (!row) throw new Error("The source row is no longer available. Close this popup and open a current record.");
      }
    } else if (authored?.type !== "viewContainer" && step.rowId !== undefined) throw new Error("The source instance no longer uses this row. Close this popup and open it again.");
    const parentComponents = scope.components;
    const parentParameters = scope.parameters ?? {};
    const stateDefinitions = { session: project.sessionState ?? {}, screen: screen.state ?? {},
      ...(project.templates?.includes(scope as Template) ? { instance: (scope as Template).instanceState ?? {} } : {}) };
    scope = template;
    return { instance, template, row, parentComponents, parentParameters, stateDefinitions };
  });
}
const sourceSignature = (steps: SourceStep[]) => JSON.stringify(steps.map(({ instance, template, row, parentComponents, parentParameters, stateDefinitions }) => {
  const references = Object.values(instance.props.parameterBindings ?? {}).flatMap(binding => Object.values(binding.references ?? {}));
  const sources = parentComponents.filter(component => references.some(reference => reference.kind === "custom"
    ? component.id === (reference.componentId ?? instance.id) : reference.kind === "input" && (component.props.fieldKey || component.id) === reference.key));
  const stateSources = references.flatMap(reference => {
    if (reference.kind !== "sessionState" && reference.kind !== "screenState" && reference.kind !== "instanceState") return [];
    const scope = reference.kind === "sessionState" ? "session" : reference.kind === "screenState" ? "screen" : "instance";
    return [[scope, reference.key, stateDefinitions[scope]?.[reference.key] ?? null]];
  });
  return [instance.id, instance.type, instance.props.templateId, instance.props.parameters ?? {}, instance.props.rowsSource ?? null,
    instance.props.parameterBindings ?? {}, sources.map(component => [component.id, component.type, component.props]),
    parentParameters, template.parameters, template.parameterTypes ?? {}, template.instanceState ?? {}, row ?? null, stateSources];
}));

function validateSourceState(trace: SourceStep[], snapshots?: ParameterBindingState[]): void {
  if (snapshots != null && (!Array.isArray(snapshots) || snapshots.length !== trace.length || snapshots.length > 4))
    throw new Error("The source state binding context is no longer available. Close this popup and open it again.");
  const shared: ParameterBindingState = {};
  trace.forEach((step, index) => {
    const state = parameterBindingStateContext(step.instance, snapshots?.[index], step.stateDefinitions);
    for (const scope of ["session", "screen"] as const) for (const [key, value] of Object.entries(state[scope])) {
      const values = shared[scope] ??= {};
      if (Object.hasOwn(values, key) && values[key] !== value)
        throw new Error(`The source ${scope} state '${key}' has conflicting captured values.`);
      values[key] = value;
    }
  });
}

/** Recover the authored source using identity; captured query values remain display-only. */
export function popupQuerySource(project: Project, popup: PopupState): PopupQuerySource {
  if (popup.origin.instancePath || popup.origin.instanceId) {
    try {
      const screen = project.screens.find(item => item.id === popup.origin.screenId) ?? project.templates?.find(item => item.id === popup.origin.screenId);
      if (!screen) throw new Error("The source screen is no longer available. Close this popup and open it again.");
      const path = popup.origin.instancePath ?? [{ instanceId: popup.origin.instanceId!, ...(popup.origin.rowId === undefined ? {} : { rowId: popup.origin.rowId }) }];
      const trace = traceSource(project, screen, path);
      if (popup.templateSourceSignature !== undefined && sourceSignature(trace) !== popup.templateSourceSignature) throw new Error("The source template parameters have changed. Close this popup and open it again.");
      if (popup.origin.bindingInputs && popup.origin.bindingInputs.length !== path.length)
        throw new Error("The source binding context is no longer available. Close this popup and open it again.");
      validateSourceState(trace, popup.origin.bindingState);
      const opener = trace.at(-1)!.template.components.find(item => item.id === popup.origin.componentId);
      if (opener?.props.action !== "openPopup" || opener.props.targetScreenId !== popup.screenId) throw new Error("The source no longer opens this popup. Close it and open a current record.");
      if (!popup.querySourceParameters) {
        let context: RuntimeParameters = project.templates?.some(item => item === screen)
          ? templateParameters(screen as Template, popup.rootParameters) : screenParameters(screen, popup.rootParameters);
        for (const [index, step] of trace.entries()) {
          const bound = sourceBindings(step, context, popup.origin.bindingInputs?.[index], popup.origin.bindingState?.[index]);
          context = templateParameters(step.template, context, step.instance.props.parameters, step.row?.parameters, bound);
        }
        return { parameters: {}, error: "" };
      }
      const first = trace[0];
      if (!first.instance.props.rowsSource || !path[0].rowId) throw new Error("The source query is no longer available. Close this popup and open a current record.");
      return { source: first.instance.props.rowsSource, template: first.template, parameters: screenParameters(screen, popup.rootParameters),
        overrides: first.instance.props.parameters, rowId: path[0].rowId, root: first, bindingInputs: popup.origin.bindingInputs, bindingState: popup.origin.bindingState,
        descendants: trace.slice(1), error: "" };
    } catch (error) { return { parameters: {}, error: error instanceof Error ? error.message : "The popup source is unavailable." }; }
  }
  if (!popup.querySourceParameters) return { parameters: {}, error: "" };
  const screen = project.screens.find(item => item.id === popup.origin.screenId && item.kind !== "popup");
  const instance = screen?.components.find(item => item.id === popup.origin.instanceId && item.type === "repeater");
  const template = project.templates?.find(item => item.id === instance?.props.templateId);
  if (!screen || !instance?.props.rowsSource || !template || !popup.origin.rowId)
    return { parameters: {}, error: "The source of this popup is no longer available. Close it and open a current record." };
  return { source: instance.props.rowsSource, template, parameters: screenParameters(screen, popup.rootParameters), overrides: instance.props.parameters, rowId: popup.origin.rowId, error: "" };
}

function sourceBindings(step: SourceStep, parameters: RuntimeParameters, inputs: InputValues = {}, snapshot?: ParameterBindingState): RuntimeParameters {
  const state = parameterBindingStateContext(step.instance, snapshot, step.stateDefinitions);
  return resolveParameterBindings(step.instance, step.template, { components: step.parentComponents, tags: [], parameters, inputs, state });
}

export interface PopupSourceStatus { ready: boolean; stale: boolean; message: string }

/** A verified, unchanged row stays usable during background refresh. Changed records never silently rebind a form. */
export function popupSourceStatus(
  popup: PopupState, definition: PopupQuerySource,
  state: { rows: ResolvedTemplateRow[]; loading: boolean; error: string },
): PopupSourceStatus {
  if (definition.error) return { ready: false, stale: true, message: definition.error };
  if (!popup.querySourceParameters) return { ready: true, stale: false, message: "" };
  if (state.error) return { ready: false, stale: false, message: `Source record unavailable. ${state.error}` };
  const row = state.rows.find(item => item.id === (definition.rowId ?? popup.origin.rowId));
  if (!row && state.loading) return { ready: false, stale: false, message: "Checking the source record…" };
  if (!row || !definition.template) return { ready: false, stale: true, message: "The source record has changed or is no longer in this list. Close this popup and open a current record." };
  let current: RuntimeParameters;
  try {
    current = queryTemplateParameters(definition.template, definition.parameters, definition.overrides, row.parameters,
      definition.root ? sourceBindings(definition.root, definition.parameters, definition.bindingInputs?.[0], definition.bindingState?.[0]) : undefined);
    if (popup.queryRootParameters && !sameParameters(current, popup.queryRootParameters))
      return { ready: false, stale: true, message: "The source record has changed. Close this popup and open it again before continuing." };
    for (const [index, step] of (definition.descendants ?? []).entries()) current = templateParameters(step.template, current, step.instance.props.parameters, step.row?.parameters,
      sourceBindings(step, current, definition.bindingInputs?.[index + 1], definition.bindingState?.[index + 1]));
  }
  catch (reason) { return { ready: false, stale: true, message: `The source parameters are no longer valid. ${reason instanceof Error ? reason.message : String(reason)}` }; }
  const captured = popup.querySourceParameters;
  if (!sameParameters(current, captured))
    return { ready: false, stale: true, message: "The source record has changed. Close this popup and open it again before continuing." };
  return { ready: true, stale: false, message: "" };
}

function sameParameters(current: RuntimeParameters, captured: RuntimeParameters) {
  return Object.keys(current).length === Object.keys(captured).length &&
    Object.entries(current).every(([key, value]) => Object.hasOwn(captured, key) && captured[key] === value);
}

/** Replay every query boundary, including saved ancestors and several query levels. */
export async function validatePopupSource(project: Project, popup: PopupState, tags: Tag[], scope: "designer" | "runtime",
  request: RepeaterApi, publishedAt?: string, signal?: AbortSignal): Promise<PopupSourceStatus> {
  let definitionReady = false;
  try {
    const path = popup.origin.instancePath ?? (popup.origin.instanceId ? [{ instanceId: popup.origin.instanceId, ...(popup.origin.rowId ? { rowId: popup.origin.rowId } : {}) }] : []);
    if (!path.length) return { ready: true, stale: false, message: "" };
    const screen = project.screens.find(item => item.id === popup.origin.screenId) ?? project.templates?.find(item => item.id === popup.origin.screenId);
    if (!screen) throw new Error("The popup source screen is no longer available.");
    const trace = traceSource(project, screen, path);
    if (popup.templateSourceSignature !== undefined && sourceSignature(trace) !== popup.templateSourceSignature) throw new Error("The source template definition changed.");
    validateSourceState(trace, popup.origin.bindingState);
    if (popup.origin.bindingInputs && popup.origin.bindingInputs.length !== trace.length) throw new Error("The source input context is unavailable.");
    const opener = trace.at(-1)!.template.components.find(item => item.id === popup.origin.componentId);
    if (opener?.props.action !== "openPopup" || opener.props.targetScreenId !== popup.screenId) throw new Error("The source no longer opens this popup.");
    definitionReady = true;
    let current: RuntimeParameters = project.templates?.includes(screen as Template) ? templateParameters(screen as Template, popup.rootParameters) : screenParameters(screen, popup.rootParameters);
    for (const [index, step] of trace.entries()) {
      signal?.throwIfAborted();
      const state = parameterBindingStateContext(step.instance, popup.origin.bindingState?.[index], step.stateDefinitions);
      const bound = resolveParameterBindings(step.instance, step.template, { components: step.parentComponents, tags, parameters: current, inputs: popup.origin.bindingInputs?.[index] ?? {}, state });
      if (step.instance.props.rowsSource) {
        const rows = await loadQueryRepeater(step.instance.props.rowsSource, step.template, scope, current, request, publishedAt, signal);
        const row = rows.find(row => row.id === path[index].rowId);
        if (!row) return { ready: false, stale: true, message: "The source row is no longer available. Close this popup and open a current record." };
        current = queryTemplateParameters(step.template, current, step.instance.props.parameters, row.parameters, bound);
      } else current = templateParameters(step.template, current, step.instance.props.parameters, step.row?.parameters, bound);
      if (popup.sourceParameterScopes?.[index] && !sameParameters(current, popup.sourceParameterScopes[index]))
        return { ready: false, stale: true, message: "A source ancestor changed. Close this popup and open a current record." };
    }
    signal?.throwIfAborted();
    if (popup.querySourceParameters && !sameParameters(current, popup.querySourceParameters))
      return { ready: false, stale: true, message: "The source parameters changed. Close this popup and open a current record." };
    return { ready: true, stale: false, message: "" };
  } catch (reason) {
    signal?.throwIfAborted();
    return { ready: false, stale: !definitionReady, message: `Source unavailable. ${reason instanceof Error ? reason.message : String(reason)}` };
  }
}
