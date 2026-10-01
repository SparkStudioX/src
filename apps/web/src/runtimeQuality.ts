import type { RuntimeParameters } from "./types";
import { resolvePath, tagByPath } from "./api";
import { isInput, resolveInputs, stateInputError, validateInputs } from "./inputs";
import { bindingReferenceDependencies, evaluateComponentBindings, evaluatePropertyBinding, type BindingContext } from "./propertyBindings";
import { resolveIndicatorState } from "./stateControls";
import { isProcessDisplay, resolveProcessDisplay } from "./processDisplays";
import { isDrawingComponent, resolveDrawingComponent } from "./drawingComponents";
import { instanceInputKey, isTemplateInstance, templateParameters, templateExpansion } from "./templateModel";
import { resolveParameterBindings, validateTemplateParameterBinding } from "./templateParameterBindings";
import { validateQueryPropertyBinding } from "./queryPropertyModel";
import { viewLayoutError } from "./viewContainers";
import { stateDefaults } from "./applicationStateModel";
import type { BindingTarget, CanvasComponent, InputValues, InstancePathStep, PropertyBinding, Screen, Tag, Template } from "./types";

type BindingHealth = { badCount: number; simulated: boolean; unknownCount?: number };
interface HealthScope {
  document: Screen; context: RuntimeParameters; inputs: InputValues; instanceSteps: InstancePathStep[]; ancestors: string[];
  localState?: import("./types").RuntimeStateValues; bindingContext: BindingContext;
}
const addUnknown = (health: BindingHealth, count = 1) => { health.unknownCount = (health.unknownCount ?? 0) + count; };

function unobservedQuerySource(binding: PropertyBinding, component: CanvasComponent, scope: HealthScope, strictSources = false): boolean {
  const { document, context, inputs, bindingContext } = scope;
  if (bindingContext.queryProperties) return false;
  let unknown = false;
  for (const { reference, component: containing } of bindingReferenceDependencies(binding, component, bindingContext)) {
    if (reference.kind === "custom") {
      const owner = reference.componentId === undefined || reference.componentId === containing.id ? containing : document.components.find(item => item.id === reference.componentId)!;
      const target = `customProperties.${reference.key}.value` as BindingTarget, query = owner.props.queryBindings?.[target];
      if (query) {
        const error = validateQueryPropertyBinding(query, target, owner, bindingContext); if (error) throw new Error(error);
        unknown = true;
      } else if (strictSources && !owner.props.bindings?.[target]) evaluatePropertyBinding({ expression: "source", references: { source: reference } }, containing, bindingContext);
    } else if (strictSources) {
      evaluatePropertyBinding({ expression: "source", references: { source: reference } }, containing, bindingContext);
      if (reference.kind === "input") {
        const input = document.components.find(item => isInput(item.type) && (item.props.fieldKey || item.id) === reference.key);
        if (!input) throw new Error("A source input is unavailable.");
        const error = validateInputs({ ...document, components: [input] }, inputs, context); if (error) throw new Error(error);
      }
    }
  }
  return unknown;
}

function unknownBindingTargets(component: CanvasComponent, errors: Record<string, string>, scope: HealthScope): Set<string> {
  const targets = new Set<string>();
  for (const [target, error] of Object.entries(errors)) {
    const binding = component.props.bindings?.[target as BindingTarget];
    if (binding && error === "Query property is unavailable.") try { if (unobservedQuerySource(binding, component, scope)) targets.add(target); } catch { /* Invalid definitions remain errors. */ }
  }
  return targets;
}

function healthTemplateParameters(component: CanvasComponent, template: Template | undefined, scope: HealthScope, health: BindingHealth) {
  const { document, context, localState, bindingContext } = scope;
  let boundValues: RuntimeParameters = {}, parameterError = false, parameterUnknown = false;
  try {
    if (template) for (const [name, binding] of Object.entries(component.props.parameterBindings ?? {})) {
      const error = validateTemplateParameterBinding(binding, component, document.components, context, name, template.parameterTypes?.[name] ?? "string", localState);
      if (error || !Object.hasOwn(template.parameters, name)) throw new Error(error || "A template parameter is undeclared.");
      parameterUnknown = unobservedQuerySource(binding, component, scope, true) || parameterUnknown;
    }
    if (template && !parameterUnknown) boundValues = resolveParameterBindings(component, template, bindingContext);
    if (!parameterUnknown) for (const binding of Object.values(component.props.parameterBindings ?? {}))
      if (evaluatePropertyBinding(binding, component, bindingContext).simulated) health.simulated = true;
  } catch { parameterError = true; }
  return { boundValues, parameterError, parameterUnknown };
}

function indicatorUnavailable(component: CanvasComponent, resolved: CanvasComponent, scope: HealthScope, unknownTargets: Set<string>, unknownQueries: boolean): boolean {
  return !unknownTargets.has("stateValue") && !(unknownQueries && component.props.queryBindings?.stateValue) && component.type === "multiStateIndicator" && !resolveIndicatorState({
    ...resolved.props,
    stateValue: Object.hasOwn(component.props.bindings ?? {}, "stateValue") || Object.hasOwn(component.props.queryBindings ?? {}, "stateValue")
      ? resolved.props.stateValue : resolvePath(resolved.props.stateValue ?? "", scope.context),
  }).state;
}

function inspectRenderedComponent(component: CanvasComponent, resolved: CanvasComponent, scope: HealthScope, health: BindingHealth, errors: boolean, unknownTargets: Set<string>, unknownQueries: boolean): void {
  const { bindingContext, context } = scope, path = resolved.props.tagPath;
  const unknownTagPath = unknownTargets.has("tagPath") || unknownQueries && Boolean(component.props.queryBindings?.tagPath);
  const needsTag = !unknownTagPath && (component.type === "value" || component.type === "gauge" || Boolean(path));
  // Failed dynamic paths are deliberately empty. Never consult the authored
  // fallback: that could report another machine as healthy or simulated.
  const tag = path && !unknownTagPath ? tagByPath(bindingContext.tags, component.props.queryBindings?.tagPath ? path : resolvePath(path, context)) : undefined;
  const precisionLimited = typeof tag?.value === "number" && Number.isInteger(tag.value) && !Number.isSafeInteger(tag.value);
  const stateUnavailable = indicatorUnavailable(component, resolved, scope, unknownTargets, unknownQueries);
  const processUnknown = [...unknownTargets, ...(unknownQueries ? Object.keys(component.props.queryBindings ?? {}) : [])].some(key => ["value", "min", "max", "decimals", "unit", "showValue", "showPercent", "orientation"].includes(key));
  const process = isProcessDisplay(component.type) && !processUnknown ? resolveProcessDisplay(resolved, context) : undefined;
  const processUnavailable = process && (!process.available || Boolean(process.rangeStatus));
  const drawingUnavailable = isDrawingComponent(component.type) && !unknownQueries && !unknownTargets.size && !resolveDrawingComponent(resolved).available;
  if (errors || stateUnavailable || processUnavailable || drawingUnavailable || needsTag && (bindingContext.communicationLost || !tag || !String(tag.quality).toLowerCase().startsWith("good") || precisionLimited)) health.badCount++;
  if (tag?.source === "simulated") health.simulated = true;
}

/** Summarize the same resolved forms and tag paths that the operator renders. */
export function runtimeBindingHealth(
  screen: Screen | undefined,
  templates: Template[],
  tags: Tag[],
  parameters: RuntimeParameters,
  edits: Record<string, InputValues>,
  communicationLost = false,
  state?: import("./types").RuntimeStateValues,
  queryProperties?: import("./types").QueryPropertyValues,
): BindingHealth {
  const health: BindingHealth = { badCount: 0, simulated: false };
  if (!screen) return health;
  const limitError = templateExpansion(screen.components, templates).error?.includes("expansion exceeds");
  let limitReported = false;
  const inspect = (document: Screen, context: RuntimeParameters, inputs: InputValues, instanceSteps: InstancePathStep[] = [], ancestors: string[] = [], localState = state) => {
    const localQueries = document === screen ? queryProperties : undefined;
    const bindingContext = { components: document.components, tags, parameters: context, inputs, communicationLost, state: localState, queryProperties: localQueries };
    const scope: HealthScope = { document, context, inputs, instanceSteps, ancestors, localState, bindingContext };
    for (const component of document.components) {
      // Preserve known expression/tag checks while disclosing query samples
      // that are owned by a nested form and unavailable to this summary.
      const unknownQueries = !localQueries && Object.keys(component.props.queryBindings ?? {}).length > 0;
      if (component.props.dataSource) addUnknown(health);
      const resolved = evaluateComponentBindings(component, bindingContext);
      const unknownTargets = unknownBindingTargets(component, resolved.errors, scope);
      if (unknownQueries || unknownTargets.size) addUnknown(health);
      const errors = Object.keys(resolved.errors).some(target => !unknownTargets.has(target)) || Boolean(stateInputError(component, localState));
      if (resolved.simulated) health.simulated = true;
      if (component.type === "viewContainer") {
        inspectViewContainer(component, errors, scope);
        continue;
      }
      if (isTemplateInstance(component.type)) {
        inspectTemplate(component, errors, scope);
        continue;
      }
      inspectRenderedComponent(component, resolved.component, scope, health, errors, unknownTargets, unknownQueries);
    }
  };
  function inspectViewContainer(component: CanvasComponent, errors: boolean, scope: HealthScope) {
    const graphError = viewLayoutError(component.props.viewLayout, templates) || templateExpansion([component], templates, scope.ancestors).error;
    if (errors || graphError || limitError && !limitReported) health.badCount++;
    if (limitError) limitReported = true;
    // Retained pane forms own their live edits/private state. Their values
    // are not the screen's saved input map and must not be reported as fresh.
    if (!graphError && !limitError) addUnknown(health, component.props.viewLayout?.panes.length ?? 0);
  }
  function inspectTemplate(component: CanvasComponent, errors: boolean, scope: HealthScope) {
    const { context, localState, instanceSteps, ancestors } = scope;
    const graphError = templateExpansion([component], templates, ancestors).error;
    const template = templates.find(item => item.id === component.props.templateId);
    const { boundValues, parameterError, parameterUnknown } = healthTemplateParameters(component, template, scope, health);
    if (errors || parameterError || graphError || limitError && !limitReported) health.badCount++;
    if (limitError) limitReported = true;
    // Live query rows remain outside this saved-graph summary.
    if (limitError || parameterError || graphError) return;
    if (parameterUnknown) { addUnknown(health); return; }
    if (component.props.rowsSource) { addUnknown(health); return; }
    if (!template) return;
    const rows = component.type === "repeater" ? component.props.rows ?? [] : [undefined];
    const ownsLiveForm = Object.keys(component.props.parameterBindings ?? {}).length > 0 || Object.keys(template.instanceState ?? {}).length > 0;
    if (ownsLiveForm && rows.length) addUnknown(health);
    for (const row of rows) {
      let parameters: RuntimeParameters;
      try { parameters = templateParameters(template, context, component.props.parameters, row?.parameters, boundValues); }
      catch { health.badCount++; continue; }
      // Bound forms own live edits, just like query rows. Saved scoped edits
      // are not their current inputs and must not make a stale health claim.
      if (ownsLiveForm) continue;
      const childPath = [...instanceSteps, { instanceId: component.id, ...(row ? { rowId: row.id } : {}) }];
      const childScope = instanceInputKey(screen!.id, childPath);
      let childState: import("./types").RuntimeStateValues;
      try { childState = { session: localState?.session ?? {}, screen: localState?.screen ?? {}, instance: stateDefaults(template.instanceState) }; }
      catch { health.badCount++; continue; }
      inspect(template, parameters, resolveInputs(template, tags, parameters, edits[childScope], communicationLost, childState), childPath, [...ancestors, template.id], childState);
    }
  }
  inspect(screen, parameters, resolveInputs(screen, tags, parameters, edits[screen.id], communicationLost, state));
  return health;
}
