import type { RuntimeParameters } from "./types";
import { resolvePath } from "./api";
import { resolveInputs, stateInputError } from "./inputs";
import { evaluateComponentBindings } from "./propertyBindings";
import { resolveIndicatorState } from "./stateControls";
import { isProcessDisplay, resolveProcessDisplay } from "./processDisplays";
import { isDrawingComponent, resolveDrawingComponent } from "./drawingComponents";
import { instanceInputKey, isTemplateInstance, templateParameters, templateExpansion } from "./templateModel";
import { resolveParameterBindings } from "./templateParameterBindings";
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
): { badCount: number; simulated: boolean } {
  const health = { badCount: 0, simulated: false };
  if (!screen) return health;
  const limitError = templateExpansion(screen.components, templates).error?.includes("expansion exceeds");
  let limitReported = false;
  const inspect = (document: Screen, context: RuntimeParameters, inputs: InputValues, instanceSteps: InstancePathStep[] = [], ancestors: string[] = [], localState = state) => {
    for (const component of document.components) {
      const resolved = evaluateComponentBindings(component, { components: document.components, tags, parameters: context, inputs, communicationLost, state: localState });
      const errors = Object.keys(resolved.errors).length > 0 || Boolean(stateInputError(component, localState));
      if (resolved.simulated) health.simulated = true;
      if (isTemplateInstance(component.type)) {
        const graphError = templateExpansion([component], templates, ancestors).error;
        const template = templates.find(item => item.id === component.props.templateId);
        let boundValues: RuntimeParameters = {}, parameterError = false;
        try {
          if (template) boundValues = resolveParameterBindings(component, template, { components: document.components, tags, parameters: context, inputs });
        } catch { parameterError = true; }
        if (errors || parameterError || graphError || limitError && !limitReported) health.badCount++;
        if (limitError) limitReported = true;
        // Live query rows remain outside this saved-graph summary.
        if (limitError || parameterError || graphError || component.props.rowsSource) continue;
        if (!template) continue;
        const rows = component.type === "repeater" ? component.props.rows ?? [] : [undefined];
        for (const row of rows) {
          let parameters: RuntimeParameters;
          try { parameters = templateParameters(template, context, component.props.parameters, row?.parameters, boundValues); }
          catch { health.badCount++; continue; }
          // Bound forms own live edits, just like query rows. Saved scoped edits
          // are not their current inputs and must not make a stale health claim.
          if (Object.keys(component.props.parameterBindings ?? {}).length || Object.keys(template.instanceState ?? {}).length) continue;
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
      const needsTag = component.type === "value" || component.type === "gauge" || Boolean(path);
      // Failed dynamic paths are deliberately empty. Never consult the authored
      // fallback: that could report another machine as healthy or simulated.
      const tag = path ? tags.find(item => item.path === resolvePath(path, context)) : undefined;
      const precisionLimited = typeof tag?.value === "number" && Number.isInteger(tag.value) && !Number.isSafeInteger(tag.value);
      const stateUnavailable = component.type === "multiStateIndicator" && !resolveIndicatorState({
        ...resolved.component.props,
        stateValue: Object.hasOwn(component.props.bindings ?? {}, "stateValue")
          ? resolved.component.props.stateValue
          : resolvePath(resolved.component.props.stateValue ?? "", context),
      }).state;
      const process = isProcessDisplay(component.type) ? resolveProcessDisplay(resolved.component, context) : undefined;
      const processUnavailable = process && (!process.available || Boolean(process.rangeStatus));
      const drawingUnavailable = isDrawingComponent(component.type) && !resolveDrawingComponent(resolved.component).available;
      if (errors || stateUnavailable || processUnavailable || drawingUnavailable || needsTag && (communicationLost || !tag || !String(tag.quality).toLowerCase().startsWith("good") || precisionLimited)) health.badCount++;
      if (tag?.source === "simulated") health.simulated = true;
    }
  };
  inspect(screen, parameters, resolveInputs(screen, tags, parameters, edits[screen.id], communicationLost, state));
  return health;
}
