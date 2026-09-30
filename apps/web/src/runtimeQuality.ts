import type { RuntimeParameters } from "./types";
import { resolvePath } from "./api";
import { resolveInputs, stateInputError } from "./inputs";
import { evaluateComponentBindings, evaluatePropertyBinding } from "./propertyBindings";
import { resolveIndicatorState } from "./stateControls";
import { isProcessDisplay, resolveProcessDisplay } from "./processDisplays";
import { isDrawingComponent, resolveDrawingComponent } from "./drawingComponents";
import { instanceInputKey, isTemplateInstance, templateParameters, templateExpansion } from "./templateModel";
import { resolveParameterBindings } from "./templateParameterBindings";
import { viewLayoutError } from "./viewContainers";
import { stateDefaults } from "./applicationStateModel";
import type { InputValues, InstancePathStep, Screen, Tag, Template } from "./types";

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
): { badCount: number; simulated: boolean; unknownCount?: number } {
  const health: { badCount: number; simulated: boolean; unknownCount?: number } = { badCount: 0, simulated: false };
  if (!screen) return health;
  const limitError = templateExpansion(screen.components, templates).error?.includes("expansion exceeds");
  let limitReported = false;
  const inspect = (document: Screen, context: RuntimeParameters, inputs: InputValues, instanceSteps: InstancePathStep[] = [], ancestors: string[] = [], localState = state) => {
    for (const component of document.components) {
      const localQueries = document === screen ? queryProperties : undefined;
      // Preserve known expression/tag checks while disclosing query samples
      // that are owned by a nested form and unavailable to this summary.
      const unknownQueries = !localQueries && Object.keys(component.props.queryBindings ?? {}).length > 0;
      if (unknownQueries) health.unknownCount = (health.unknownCount ?? 0) + 1;
      if (component.props.dataSource) health.unknownCount = (health.unknownCount ?? 0) + 1;
      const resolved = evaluateComponentBindings(component, { components: document.components, tags, parameters: context, inputs, communicationLost, state: localState, queryProperties: localQueries });
      const errors = Object.keys(resolved.errors).length > 0 || Boolean(stateInputError(component, localState));
      if (resolved.simulated) health.simulated = true;
      if (component.type === "viewContainer") {
        const graphError = viewLayoutError(component.props.viewLayout, templates) || templateExpansion([component], templates, ancestors).error;
        if (errors || graphError || limitError && !limitReported) health.badCount++;
        if (limitError) limitReported = true;
        // Retained pane forms own their live edits/private state. Their values
        // are not the screen's saved input map and must not be reported as fresh.
        if (!graphError && !limitError) health.unknownCount = (health.unknownCount ?? 0) + (component.props.viewLayout?.panes.length ?? 0);
        continue;
      }
      if (isTemplateInstance(component.type)) {
        const graphError = templateExpansion([component], templates, ancestors).error;
        const template = templates.find(item => item.id === component.props.templateId);
        let boundValues: RuntimeParameters = {}, parameterError = false;
        try {
          if (template) boundValues = resolveParameterBindings(component, template, { components: document.components, tags, parameters: context, inputs, state: localState, communicationLost });
          for (const binding of Object.values(component.props.parameterBindings ?? {}))
            if (evaluatePropertyBinding(binding, component, { components: document.components, tags, parameters: context, inputs, state: localState, communicationLost }).simulated) health.simulated = true;
        } catch { parameterError = true; }
        if (errors || parameterError || graphError || limitError && !limitReported) health.badCount++;
        if (limitError) limitReported = true;
        // Live query rows remain outside this saved-graph summary.
        if (limitError || parameterError || graphError) continue;
        if (component.props.rowsSource) { health.unknownCount = (health.unknownCount ?? 0) + 1; continue; }
        if (!template) continue;
        const rows = component.type === "repeater" ? component.props.rows ?? [] : [undefined];
        const ownsLiveForm = Object.keys(component.props.parameterBindings ?? {}).length > 0 || Object.keys(template.instanceState ?? {}).length > 0;
        if (ownsLiveForm && rows.length) health.unknownCount = (health.unknownCount ?? 0) + 1;
        for (const row of rows) {
          let parameters: RuntimeParameters;
          try { parameters = templateParameters(template, context, component.props.parameters, row?.parameters, boundValues); }
          catch { health.badCount++; continue; }
          // Bound forms own live edits, just like query rows. Saved scoped edits
          // are not their current inputs and must not make a stale health claim.
          if (ownsLiveForm) continue;
          const childPath = [...instanceSteps, { instanceId: component.id, ...(row ? { rowId: row.id } : {}) }];
          const scope = instanceInputKey(screen.id, childPath);
          let childState: import("./types").RuntimeStateValues;
          try { childState = { session: localState?.session ?? {}, screen: localState?.screen ?? {}, instance: stateDefaults(template.instanceState) }; }
          catch { health.badCount++; continue; }
          inspect(template, parameters, resolveInputs(template, tags, parameters, edits[scope], communicationLost, childState), childPath, [...ancestors, template.id], childState);
        }
        continue;
      }
      const path = resolved.component.props.tagPath;
      const unknownTagPath = unknownQueries && Boolean(component.props.queryBindings?.tagPath);
      const needsTag = !unknownTagPath && (component.type === "value" || component.type === "gauge" || Boolean(path));
      // Failed dynamic paths are deliberately empty. Never consult the authored
      // fallback: that could report another machine as healthy or simulated.
      const tag = path && !unknownTagPath ? tags.find(item => item.path === (component.props.queryBindings?.tagPath ? path : resolvePath(path, context))) : undefined;
      const precisionLimited = typeof tag?.value === "number" && Number.isInteger(tag.value) && !Number.isSafeInteger(tag.value);
      const stateUnavailable = !(unknownQueries && component.props.queryBindings?.stateValue) && component.type === "multiStateIndicator" && !resolveIndicatorState({
        ...resolved.component.props,
        stateValue: Object.hasOwn(component.props.bindings ?? {}, "stateValue") || Object.hasOwn(component.props.queryBindings ?? {}, "stateValue")
          ? resolved.component.props.stateValue
          : resolvePath(resolved.component.props.stateValue ?? "", context),
      }).state;
      const process = isProcessDisplay(component.type) && !(unknownQueries && Object.keys(component.props.queryBindings ?? {}).some(key => ["value", "min", "max", "decimals", "unit", "showValue", "showPercent", "orientation"].includes(key))) ? resolveProcessDisplay(resolved.component, context) : undefined;
      const processUnavailable = process && (!process.available || Boolean(process.rangeStatus));
      const drawingUnavailable = isDrawingComponent(component.type) && !unknownQueries && !resolveDrawingComponent(resolved.component).available;
      if (errors || stateUnavailable || processUnavailable || drawingUnavailable || needsTag && (communicationLost || !tag || !String(tag.quality).toLowerCase().startsWith("good") || precisionLimited)) health.badCount++;
      if (tag?.source === "simulated") health.simulated = true;
    }
  };
  inspect(screen, parameters, resolveInputs(screen, tags, parameters, edits[screen.id], communicationLost, state));
  return health;
}
