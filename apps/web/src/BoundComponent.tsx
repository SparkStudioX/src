import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ComponentView } from "./Components";
import { evaluateComponentBindings } from "./propertyBindings";
import { initialInput, isInput, stateInputError } from "./inputs";
import { InputEventLifecycle, inputEventFormIdentity } from "./inputEvents";
import { useApplicationStateContext } from "./applicationState";
import { useComponentEvents, usePythonComponentEvents } from "./ComponentEvents";
import { useComponentActivity } from "./ComponentActivity";
import type { PythonEventTransport } from "./pythonComponentEvents";
import { useQueryPropertyContext } from "./useQueryPropertyBindings";
import { useVisualStyles } from "./VisualStyleContext";
import { applyVisualStyle, nativeControlColorScheme } from "./visualStyles";
import { useLocalization } from "./LocalizationContext";
import { localizeComponent } from "./localization";
import { applyPythonUiOverrides, capturePythonUiAction } from "./pythonUiModel";
import { componentBindingDiagnostics, renderBindingDiagnostics } from "./bindingDiagnostics";
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
type ComponentEventStatus = { message: string; error: boolean };

function componentAppearance(appearance: CanvasComponent["props"]) {
  const background = typeof appearance.backgroundColor === "string" ? appearance.backgroundColor : undefined;
  const foreground = typeof appearance.foregroundColor === "string" ? appearance.foregroundColor : undefined;
  const borderColor = typeof appearance.borderColor === "string" ? appearance.borderColor : undefined;
  const borderWidth = typeof appearance.borderWidth === "number" ? appearance.borderWidth : undefined;
  const fontSize = typeof appearance.fontSize === "number" ? appearance.fontSize : undefined;
  return {
    background, foreground, fontSize,
    style: {
      "--component-accent": appearance.color || "var(--accent)",
      "--component-foreground": appearance.color ? "#ffffff" : "var(--on-accent)",
      "--component-background": background,
      "--component-text-color": foreground,
      "--component-border-color": borderColor,
      "--component-border-width": borderWidth === undefined ? undefined : `${borderWidth}px`,
      "--component-font-size": fontSize === undefined ? undefined : `${fontSize}px`,
      backgroundColor: background,
      colorScheme: nativeControlColorScheme(background),
      color: foreground, borderColor, borderWidth,
      borderStyle: borderWidth === undefined ? undefined : "solid",
    } as CSSProperties,
  };
}

function boundComponentClassName(visible: boolean, failed: boolean, inputStatus: boolean, appearance: ReturnType<typeof componentAppearance>): string {
  return `bound-component${!visible ? " design-hidden" : ""}${failed ? " binding-failed" : ""}${inputStatus ? " has-input-event-status" : ""}${appearance.background !== undefined ? " has-custom-background" : ""}${appearance.foreground !== undefined ? " has-custom-foreground" : ""}${appearance.fontSize !== undefined ? " has-custom-font" : ""}`;
}

function boundInteractionEnabled(props: BoundComponentProps, enabled: boolean, visible: boolean): boolean {
  return props.preview && enabled && visible && !props.interactionLocked && !props.readOnly;
}

/** Evaluate in the current form scope; retain the authored component for actions. */
export default function BoundComponent({ components, inheritedAppearance, onAutomaticInputChange, onPythonEvent, ...props }: BoundComponentProps) {
  const activity = useComponentActivity();
  const applicationState = useApplicationStateContext();
  const queryProperties = useQueryPropertyContext();
  const styles = useVisualStyles();
  const localization = useLocalization();
  const [eventStatus, setEventStatus] = useState<ComponentEventStatus | null>(null);
  const lifecycle = useRef<InputEventLifecycle | null>(null);
  if (!lifecycle.current) lifecycle.current = new InputEventLifecycle();
  const scope = components ?? [props.component];
  const pythonIdentity = JSON.stringify([scope, props.parameters, props.publishedAt, props.preview, props.queryScope]);
  const uiIdentity = JSON.stringify([pythonIdentity, activity]);
  const uiLifetime = useRef({ identity: uiIdentity, epoch: 0, active: true });
  if (uiLifetime.current.identity !== uiIdentity) { uiLifetime.current.identity = uiIdentity; uiLifetime.current.epoch++; }
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
  const diagnostics = componentBindingDiagnostics(props.component, result.errors, styled.error, queryProperties);
  const { errors } = diagnostics;
  const stateError = stateInputError(props.component, applicationState?.values);
  if (stateError) errors.push(["value", stateError]);
  const visible = result.component.props.visible !== false;
  const enabled = result.component.props.enabled !== false && errors.length === 0;
  const interactionEnabled = boundInteractionEnabled(props, enabled, visible);
  const canInteract = activity && interactionEnabled;
  const fieldKey = props.component.props.fieldKey || props.component.id;
  const currentInput = props.inputs && Object.hasOwn(props.inputs, fieldKey)
    ? props.inputs[fieldKey]
    : initialInput(props.component, props.tags, props.parameters, props.communicationLost, applicationState?.values);
  const python = usePythonComponentEvents({
    component: props.component, components: scope, parameters: props.parameters,
    identity: pythonIdentity, enabled: props.preview && !props.readOnly, transport: onPythonEvent, onAutomaticInputChange
  });
  const interactionEvents = useComponentEvents({
    component: props.component, evaluated: result.component, components: scope, errors: result.errors,
    parameters: props.parameters, inputs: props.inputs ?? {}, inputValue: currentInput, inputError: stateError,
    preview: props.preview, scopeKey: props.queryScope, onAutomaticInputChange, python,
    interactionEnabled
  });
  const inputActive = canInteract && isInput(props.component.type);
  const contextKey = inputActive ? JSON.stringify([
    props.queryScope,
    applicationState?.key,
    props.component.id,
    fieldKey,
    props.component.props.events,
    props.parameters,
    inputEventFormIdentity(scope),
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
  const appearance = componentAppearance(result.component.props);
  // The frame is pure presentation; lifecycle and authority stay with this owner.
  function renderFrame() {
    return <div
      {...interactionEvents}
      className={boundComponentClassName(visible, Boolean(errors.length), Boolean(props.preview && eventStatus && isInput(props.component.type)), appearance)}
      style={appearance.style}
      data-component-id={props.component.id}
      lang={localized.locale}
      aria-disabled={props.preview && !enabled || undefined}
    >
      <div className="bound-component-content" inert={props.preview && (!enabled || !activity)}>
        <ComponentView {...props}
          component={result.component}
          literalText={props.preview && Object.hasOwn(applicationState?.propertyOverrides ?? {}, props.component.id) && Object.hasOwn(applicationState!.propertyOverrides[props.component.id], "text")}
          scopeComponents={scope}
          interactionLocked={props.interactionLocked || !enabled || !activity}
          onInputChange={(key, value) => {
            if (!canInteract) return;
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
            if (!canInteract) return;
            if (props.component.props.action !== "message") {
              try {
                const epoch = uiLifetime.current.epoch;
                const uiAction = ["script", "setTagValue"].includes(props.component.props.action ?? "") && applicationState
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
          onTableEdit={canInteract ? props.onTableEdit : undefined}
          onOpenPopup={() => { if (activity && enabled && visible) props.onOpenPopup?.(props.component); }}
        />
      </div>
      {!props.preview && !visible && <span className="binding-visibility-note">Hidden in runtime</span>}
      {localized.warning && <span className="component-localization-note" role="status" title={localized.warning}>{localized.warning}</span>}
      {props.preview && eventStatus && <div className={`component-input-event-status${eventStatus.error ? " error" : ""}`} role={eventStatus.error ? "alert" : "status"} title={eventStatus.message}>{eventStatus.message}</div>}
      {renderBindingDiagnostics(diagnostics)}
    </div>;
  }
  return renderFrame();
}
