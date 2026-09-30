import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ComponentView } from "./Components";
import { evaluateComponentBindings } from "./propertyBindings";
import { initialInput, isInput, stateInputError } from "./inputs";
import { InputEventLifecycle } from "./inputEvents";
import { useApplicationStateContext } from "./applicationState";
import { useComponentEvents, usePythonComponentEvents } from "./ComponentEvents";
import type { PythonEventTransport } from "./pythonComponentEvents";
import { useQueryPropertyContext } from "./useQueryPropertyBindings";
import { useVisualStyles } from "./VisualStyleContext";
import { applyVisualStyle } from "./visualStyles";
import { useLocalization } from "./LocalizationContext";
import { localizeComponent } from "./localization";
import { applyPythonUiOverrides, capturePythonUiAction } from "./pythonUiModel";
import type { ComponentProps } from "react";
import type { CanvasComponent, InputValue, PythonUiAction } from "./types";
import "./boundComponent.css";
import "./inputEvents.css";

export type BoundComponentProps = Omit<ComponentProps<typeof ComponentView>, "onAction"> & {
  onAction?: (component: CanvasComponent, uiAction?: PythonUiAction) => void;
  components?: CanvasComponent[];
  inheritedAppearance?: InheritedComponentAppearance;
  onAutomaticInputChange?: (field: string, value: InputValue) => void;
  onPythonEvent?: PythonEventTransport;
};
export type InheritedComponentAppearance = Pick<CanvasComponent["props"], "color" | "backgroundColor" | "foregroundColor" | "fontSize">;

/** Evaluate in the current form scope; retain the authored component for actions. */
export default function BoundComponent({ components, inheritedAppearance, onAutomaticInputChange, onPythonEvent, ...props }: BoundComponentProps) {
  const applicationState = useApplicationStateContext();
  const queryProperties = useQueryPropertyContext();
  const styles = useVisualStyles();
  const localization = useLocalization();
  const [eventStatus, setEventStatus] = useState<{ message: string; error: boolean } | null>(null);
  const lifecycle = useRef<InputEventLifecycle | null>(null);
  if (!lifecycle.current) lifecycle.current = new InputEventLifecycle();
  const scope = components ?? [props.component];
  const uiIdentity = JSON.stringify([scope, props.parameters, props.publishedAt, props.preview, props.queryScope]);
  const uiLifetime = useRef({ identity: uiIdentity, epoch: 0, active: true });
  uiLifetime.current.identity = uiIdentity;
  useEffect(() => { uiLifetime.current.active = true; return () => { uiLifetime.current.active = false; uiLifetime.current.epoch++; }; }, []);
  const localized = localizeComponent(props.component, localization.catalog, localization.locale);
  const styled = applyVisualStyle(localized.component, styles, inheritedAppearance);
  const component = props.preview ? applyPythonUiOverrides(styled.component, applicationState) : styled.component;
  const result = evaluateComponentBindings(component, {
    components: scope,
    tags: props.tags,
    parameters: props.parameters,
    inputs: props.inputs ?? {},
    communicationLost: props.communicationLost,
    state: applicationState?.values,
    queryProperties,
  });
  const errors = Object.entries(result.errors);
  if (styled.error) errors.push(["style", styled.error]);
  const querySamples = queryProperties?.[props.component.id] ?? {};
  const queryWaiting = errors.length > 0 && errors.every(([target]) => querySamples[target as keyof typeof querySamples]?.status === "loading");
  const queryErrors = errors.filter(([target]) => Object.hasOwn(props.component.props.queryBindings ?? {}, target));
  const queryRefreshing = Object.values(querySamples).some(sample => sample?.status === "ready" && sample.refreshing);
  const stateError = stateInputError(props.component, applicationState?.values);
  if (stateError) errors.push(["value", stateError]);
  const visible = result.component.props.visible !== false;
  const enabled = result.component.props.enabled !== false && errors.length === 0;
  const fieldKey = props.component.props.fieldKey || props.component.id;
  const currentInput = props.inputs && Object.hasOwn(props.inputs, fieldKey)
    ? props.inputs[fieldKey]
    : initialInput(props.component, props.tags, props.parameters, props.communicationLost, applicationState?.values);
  const python = usePythonComponentEvents({ component: props.component, components: scope, parameters: props.parameters,
    identity: uiIdentity, enabled: props.preview && !props.readOnly, transport: onPythonEvent, onAutomaticInputChange });
  useComponentEvents({ component: props.component, evaluated: result.component, components: scope, errors: result.errors,
    parameters: props.parameters, inputs: props.inputs ?? {}, inputValue: currentInput, inputError: stateError,
    preview: props.preview, scopeKey: props.queryScope, onAutomaticInputChange, python });
  const inputActive = props.preview && enabled && visible && !props.interactionLocked && !props.readOnly && isInput(props.component.type);
  const contextKey = inputActive ? JSON.stringify([
    props.queryScope,
    applicationState?.key,
    props.component.id,
    fieldKey,
    props.component.props.events,
    props.parameters,
    scope.map((item) => [item.id, item.type, item.props.fieldKey, item.props.stateBinding, item.props.min, item.props.max, item.props.step, item.props.options, item.props.optionsSource, item.props.selectionFields]),
  ]) : "";
  // Invalidating during render prevents old asynchronous helpers from affecting
  // a new form context before React runs effect cleanup.
  lifecycle.current.setContext(inputActive ? {
    key: contextKey,
    component: props.component,
    components: scope,
    inputs: props.inputs ?? {},
    parameters: props.parameters,
    setInput: (key, value) => props.onInputChange?.(key, value),
    state: applicationState?.api,
    python,
    coordinator: applicationState?.store?.componentEvents,
    isCurrent: applicationState?.isCurrent,
    sendMessage: applicationState?.sendMessage,
    notify: (message) => setEventStatus({ message, error: false }),
    error: (message) => setEventStatus({ message, error: true }),
    clearStatus: () => setEventStatus(null),
  } : null, currentInput);
  useEffect(() => {
    const runner = lifecycle.current!;
    runner.activate();
    return () => runner.deactivate();
  }, []);
  useEffect(() => { setEventStatus(null); }, [contextKey]);
  // Keep hidden controls reachable on the authoring canvas. Runtime hides both
  // their content and focus targets; a binding failure is shown instead.
  if (props.preview && !visible && !errors.length) return <span className="bound-component-hidden" hidden />;
  const color = result.component.props.color;
  const appearance = result.component.props;
  const background = typeof appearance.backgroundColor === "string" ? appearance.backgroundColor : undefined;
  const foreground = typeof appearance.foregroundColor === "string" ? appearance.foregroundColor : undefined;
  const borderColor = typeof appearance.borderColor === "string" ? appearance.borderColor : undefined;
  const borderWidth = typeof appearance.borderWidth === "number" ? appearance.borderWidth : undefined;
  const fontSize = typeof appearance.fontSize === "number" ? appearance.fontSize : undefined;
  return <div
    className={`bound-component${!visible ? " design-hidden" : ""}${errors.length ? " binding-failed" : ""}${props.preview && eventStatus && isInput(props.component.type) ? " has-input-event-status" : ""}${background !== undefined ? " has-custom-background" : ""}${foreground !== undefined ? " has-custom-foreground" : ""}${fontSize !== undefined ? " has-custom-font" : ""}`}
    style={{
      "--component-accent": color || "var(--accent)",
      "--component-foreground": color ? "#ffffff" : "var(--on-accent)",
      "--component-background": background,
      "--component-text-color": foreground,
      "--component-border-color": borderColor,
      "--component-border-width": borderWidth === undefined ? undefined : `${borderWidth}px`,
      "--component-font-size": fontSize === undefined ? undefined : `${fontSize}px`,
      backgroundColor: background,
      color: foreground,
      borderColor,
      borderWidth,
      borderStyle: borderWidth === undefined ? undefined : "solid",
    } as CSSProperties}
    data-component-id={props.component.id}
    lang={localized.locale}
    aria-disabled={props.preview && !enabled || undefined}
  >
    <div className="bound-component-content" inert={props.preview && !enabled}>
      <ComponentView {...props}
        component={result.component}
        literalText={props.preview && Object.hasOwn(applicationState?.propertyOverrides ?? {}, props.component.id) && Object.hasOwn(applicationState!.propertyOverrides[props.component.id], "text")}
        scopeComponents={scope}
        interactionLocked={props.interactionLocked || !enabled}
        onInputChange={(key, value) => {
          if (!props.preview || !enabled || !visible || props.interactionLocked || props.readOnly) return;
          props.onInputChange?.(key, value);
          lifecycle.current!.updateInputs({ [key]: value });
          if (inputActive && key === fieldKey) lifecycle.current!.change(value);
        }}
        onInputCommit={(key, value) => {
          if (!inputActive || key !== fieldKey) return;
          lifecycle.current!.commit(value);
          props.onInputCommit?.(key, value);
        }}
        onAction={() => {
          if (!props.preview || !enabled || !visible || props.interactionLocked || props.readOnly) return;
          if (props.component.props.action !== "message") {
            try {
              const epoch = uiLifetime.current.epoch;
              const uiAction = props.component.props.action === "script" && applicationState
                ? capturePythonUiAction(applicationState, scope, () => uiLifetime.current.active && uiLifetime.current.epoch === epoch && uiLifetime.current.identity === uiIdentity,
                  { assign: onAutomaticInputChange, parameters: props.parameters })
                : undefined;
              props.onAction?.(props.component, uiAction);
            } catch (error) { setEventStatus({ message: error instanceof Error ? error.message : String(error), error: true }); }
            return;
          }
          try {
            if (!applicationState) throw new Error("Component messaging is unavailable in this context.");
            const message = props.component.props.message;
            if (!message) throw new Error("Configure a message type, scope and payload for this button.");
            applicationState.sendMessage(message.messageType, message.payload, { scope: message.scope });
            setEventStatus(null);
          } catch (error) { setEventStatus({ message: error instanceof Error ? error.message : String(error), error: true }); }
        }}
        onTableEdit={props.preview && enabled && visible && !props.interactionLocked && !props.readOnly ? props.onTableEdit : undefined}
        onOpenPopup={() => { if (enabled && visible) props.onOpenPopup?.(props.component); }}
      />
    </div>
    {!props.preview && !visible && <span className="binding-visibility-note">Hidden in runtime</span>}
    {localized.warning && <span className="component-localization-note" role="status" title={localized.warning}>{localized.warning}</span>}
    {props.preview && eventStatus && <div className={`component-input-event-status${eventStatus.error ? " error" : ""}`} role={eventStatus.error ? "alert" : "status"} title={eventStatus.message}>{eventStatus.message}</div>}
    {errors.length > 0 && <div className="component-binding-error" role="status" title={errors.map(([target, error]) => `${target}: ${error}`).join("\n")}>
      {queryWaiting ? "Loading query…" : queryErrors.length ? `Query unavailable: ${queryErrors.map(([target]) => target).join(", ")}` : `Binding error: ${errors.map(([target]) => target).join(", ")}`}
    </div>}
    {!errors.length && queryRefreshing && <div className="query-property-refreshing" role="status">Refreshing query…</div>}
  </div>;
}
