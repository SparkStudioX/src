import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ComponentView } from "./Components";
import { evaluateComponentBindings } from "./propertyBindings";
import { initialInput, isInput, stateInputError } from "./inputs";
import { InputEventLifecycle } from "./inputEvents";
import { useApplicationStateContext } from "./applicationState";
import type { ComponentProps } from "react";
import type { CanvasComponent } from "./types";
import "./boundComponent.css";
import "./inputEvents.css";

export type BoundComponentProps = ComponentProps<typeof ComponentView> & {
  components?: CanvasComponent[];
  inheritedAppearance?: InheritedComponentAppearance;
};
export type InheritedComponentAppearance = Pick<CanvasComponent["props"], "color" | "backgroundColor" | "foregroundColor" | "fontSize">;

/** Evaluate in the current form scope; retain the authored component for actions. */
export default function BoundComponent({ components, inheritedAppearance, ...props }: BoundComponentProps) {
  const applicationState = useApplicationStateContext();
  const [eventStatus, setEventStatus] = useState<{ message: string; error: boolean } | null>(null);
  const lifecycle = useRef<InputEventLifecycle | null>(null);
  if (!lifecycle.current) lifecycle.current = new InputEventLifecycle();
  const scope = components ?? [props.component];
  const inherited = { ...inheritedAppearance };
  // An explicit leaf color also wins over a container's foreground default.
  if (props.component.props.color !== undefined || props.component.props.bindings?.color) delete inherited.foregroundColor;
  // Clearing an authored style leaves an explicit undefined in the editor until
  // saving. Treat that exactly like an absent style when applying defaults.
  const defaults = Object.fromEntries(Object.entries(inherited).filter(([key]) => props.component.props[key as keyof InheritedComponentAppearance] === undefined));
  const component = inheritedAppearance ? { ...props.component, props: { ...props.component.props, ...defaults } } : props.component;
  const result = evaluateComponentBindings(component, {
    components: scope,
    tags: props.tags,
    parameters: props.parameters,
    inputs: props.inputs ?? {},
    communicationLost: props.communicationLost,
    state: applicationState?.values,
  });
  const errors = Object.entries(result.errors);
  const stateError = stateInputError(props.component, applicationState?.values);
  if (stateError) errors.push(["value", stateError]);
  const visible = result.component.props.visible !== false;
  const enabled = result.component.props.enabled !== false && errors.length === 0;
  const fieldKey = props.component.props.fieldKey || props.component.id;
  const currentInput = props.inputs && Object.hasOwn(props.inputs, fieldKey)
    ? props.inputs[fieldKey]
    : initialInput(props.component, props.tags, props.parameters, props.communicationLost, applicationState?.values);
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
    notify: (message) => setEventStatus({ message, error: false }),
    error: (message) => setEventStatus({ message, error: true }),
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
    className={`bound-component${!visible ? " design-hidden" : ""}${errors.length ? " binding-failed" : ""}${background !== undefined ? " has-custom-background" : ""}${foreground !== undefined ? " has-custom-foreground" : ""}${fontSize !== undefined ? " has-custom-font" : ""}`}
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
    aria-disabled={props.preview && !enabled || undefined}
  >
    <div className="bound-component-content" inert={props.preview && !enabled}>
      <ComponentView {...props}
        component={result.component}
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
        onAction={() => { if (enabled && visible && !props.readOnly) props.onAction?.(props.component); }}
        onTableEdit={props.preview && enabled && visible && !props.interactionLocked && !props.readOnly ? props.onTableEdit : undefined}
        onOpenPopup={() => { if (enabled && visible) props.onOpenPopup?.(props.component); }}
      />
    </div>
    {!props.preview && !visible && <span className="binding-visibility-note">Hidden in runtime</span>}
    {props.preview && eventStatus && <div className={`component-input-event-status${eventStatus.error ? " error" : ""}`} role={eventStatus.error ? "alert" : "status"} title={eventStatus.message}>{eventStatus.message}</div>}
    {errors.length > 0 && <div className="component-binding-error" role="status" title={errors.map(([target, error]) => `${target}: ${error}`).join("\n")}>
      Binding error: {errors.map(([target]) => target).join(", ")}
    </div>}
  </div>;
}
