import ProcessDataComponent from "./ProcessDataComponent";
import { isProcessDataComponent } from "./processDataModel";
import type { RuntimeParameters } from "./types";
import { useEffect, useId, useRef, useState } from "react";
import { apiUrl, displayValue, resolvePath, tagByPath } from "./api";
import Icon from "./Icon";
import { QueryTable } from "./QueryTable";
export { QueryTable } from "./QueryTable";
import { querySelectionChanges } from "./queryOptions";
import { useQueryOptions } from "./useQueryOptions";
import { resolveIndicatorState } from "./stateControls";
import { isProcessDisplay } from "./processDisplays";
import ProcessDisplay from "./ProcessDisplay";
import DrawingComponent from "./DrawingComponent";
import ChartComponent from "./ChartComponent";
import EquipmentCommand from "./EquipmentCommand";
import ComputerCamera from "./ComputerCamera";
import { useAuth } from "./Auth";
import { isChart } from "./chartModel";
import { isDrawingComponent } from "./drawingComponents";
import ListTreeInput from "./ListTreeInput";
import { formatInputText, inputConstraintError, textValidationTypes } from "./inputValidation";
import { transientImageUrl } from "./imageSource";
import type {
  CanvasComponent,
  InputValue,
  InputValues,
  ScriptResult,
  TableEditIntent,
  Tag,
} from "./types";
import {
  validateInputs,
  incrementInput,
  initialInput,
  isInput,
  isNumericInput,
  isSafeNumber,
  numericInputValue,
  sliderInputValue,
} from "./inputs";
import "./media.css";
import "./controls.css";

function NativeTagButton({ caption, preview, queryScope, busy, disabled, onActivate }: {
  caption: string; preview: boolean; queryScope: "designer" | "runtime"; busy: boolean; disabled: boolean; onActivate: () => void;
}) {
  const { permissions } = useAuth();
  const permitted = queryScope !== "runtime" || permissions.commands;
  return <button className="render-button" style={{ pointerEvents: preview ? "auto" : "none" }} tabIndex={preview ? 0 : -1}
    disabled={busy || disabled || !permitted} title={!permitted ? "Commands permission is required to set a tag." : undefined}
    onClick={() => { if (preview && !busy && !disabled && permitted) onActivate(); }}>
    {busy ? "Setting…" : caption}<Icon name="tag" size={18} />
  </button>;
}

export interface ComponentViewProps {
  component: CanvasComponent;
  tags: Tag[];
  parameters: RuntimeParameters;
  preview: boolean;
  onNavigate: (screenId: string) => void;
  communicationLost?: boolean;
  queryScope?: "designer" | "runtime";
  publishedAt?: string;
  scopeComponents?: CanvasComponent[];
  inputs?: InputValues;
  onInputChange?: (fieldKey: string, value: InputValue) => void;
  onInputCommit?: (fieldKey: string, value: InputValue) => void;
  onAction?: (component: CanvasComponent) => void;
  onTableEdit?: (edit: TableEditIntent) => Promise<ScriptResult>;
  actionBusy?: boolean;
  interactionLocked?: boolean;
  readOnly?: boolean;
  /** Transient Python UI text is literal, including braces and an empty string. */
  literalText?: boolean;
  onOpenPopup?: (component: CanvasComponent) => void;
  onClosePopup?: () => void;
}

type RenderContext = ComponentViewProps & {
  props: CanvasComponent["props"];
  caption: (fallback: string) => string;
  communicationLost: boolean;
  queryScope: "designer" | "runtime";
  inputs: InputValues;
  actionBusy: boolean;
  interactionLocked: boolean;
  readOnly: boolean;
};
type ComponentControlState = ReturnType<typeof useComponentControlState>;

export function ComponentView({
  component,
  tags,
  parameters,
  preview,
  onNavigate,
  communicationLost = false,
  queryScope = "designer",
  publishedAt,
  scopeComponents,
  inputs = {},
  onInputChange,
  onInputCommit,
  onAction,
  onTableEdit,
  actionBusy = false,
  interactionLocked = false,
  readOnly = false,
  literalText = false,
  onOpenPopup,
  onClosePopup,
}: ComponentViewProps) {
  const controls = useComponentControlState();
  const { type } = component;
  const { props, caption } = resolveComponentText(component, parameters, literalText);
  const context: RenderContext = { component, tags, parameters, preview, onNavigate, communicationLost, queryScope, publishedAt, scopeComponents, inputs, onInputChange, onInputCommit, onAction, onTableEdit, actionBusy, interactionLocked, readOnly, onOpenPopup, onClosePopup, props, caption };
  if (type === "equipmentCommand") return <EquipmentCommand component={{ ...component, props }} queryScope={queryScope} publishedAt={publishedAt} communicationLost={communicationLost} interactionLocked={interactionLocked || readOnly} />;
  if (type === "computerCamera") {
    const field = props.fieldKey || component.id;
    return <ComputerCamera caption={caption("Computer camera")} value={inputs[field]} interactive={preview} disabled={interactionLocked || readOnly || props.enabled === false || props.visible === false}
      onChange={value => onInputChange?.(field, value)} onCommit={value => onInputCommit?.(field, value)} />;
  }
  if (isProcessDataComponent(type)) return <ProcessDataComponent component={{ ...component, props }} parameters={parameters} preview={preview} communicationLost={communicationLost} queryScope={queryScope} publishedAt={publishedAt} readOnly={readOnly} interactionLocked={interactionLocked} />;
  if (isChart(type)) return <ChartComponent component={{ ...component, props }} tags={tags} parameters={parameters} preview={preview} onNavigate={onNavigate} communicationLost={communicationLost} queryScope={queryScope} publishedAt={publishedAt} scopeComponents={scopeComponents} inputs={inputs} />;
  if (isProcessDisplay(type)) return <ProcessDisplay component={{ ...component, props }} parameters={parameters} />;
  if (isDrawingComponent(type)) return <DrawingComponent component={{ ...component, props }} preview={preview} interactionLocked={interactionLocked} onNavigate={onNavigate} onOpenPopup={onOpenPopup} />;
  if (type === "multiStateIndicator") return renderStateIndicator(context);
  if (type === "image") return renderImage(context, controls);
  if (type === "icon") return renderIcon(context);
  if (isInput(type)) return renderInput(context, controls);
  if (type === "label") return renderLabel(context);
  if (type === "button") return renderButton(context);
  if (type === "table") return renderTable(context);
  if (type === "gauge") return renderGauge(context);
  return renderValue(context);
}

function useComponentControlState() {
  // Preserve one owner and hook order as a saved component changes type or mode.
  const initialStatusId = useId();
  const latestInputValue = useRef<InputValue | null>(null);
  const [failedImage, setFailedImage] = useState("");
  const [commandCommit, setCommandCommit] = useState<{ value: number; sequence: number }>();
  const committedValue = useRef<string | null>(null);
  return { initialStatusId, latestInputValue, failedImage, setFailedImage, commandCommit, setCommandCommit, committedValue };
}

function resolveComponentText(component: CanvasComponent, parameters: RuntimeParameters, literalText: boolean) {
  const props = {
    ...component.props,
    text: literalText || Object.hasOwn(component.props.bindings ?? {}, "text") || Object.hasOwn(component.props.queryBindings ?? {}, "text")
      ? component.props.text ?? ""
      : resolvePath(component.props.text || "", parameters),
  };
  const caption = (fallback: string) => literalText || Object.hasOwn(component.props.bindings ?? {}, "text") || Object.hasOwn(component.props.queryBindings ?? {}, "text")
    ? props.text
    : props.text || fallback;
  return { props, caption };
}

function tagDisplayState({ tags, props, parameters, communicationLost }: RenderContext) {
  const tag = tagByPath(tags, props.queryBindings?.tagPath ? props.tagPath ?? "" : resolvePath(props.tagPath || "", parameters));
  const precisionLimited =
    typeof tag?.value === "number" &&
    Number.isInteger(tag.value) &&
    !Number.isSafeInteger(tag.value);
  const good =
    !communicationLost &&
    !precisionLimited &&
    tag &&
    String(tag.quality).toLowerCase().startsWith("good");
  const quality = communicationLost
    ? "Communication lost"
    : precisionLimited
      ? "Precision limit"
      : tag?.quality || "Tag not found";
  return { tag, precisionLimited, good, quality };
}

function renderStateIndicator(context: RenderContext) {
  const { parameters, props, caption } = context;
  const stateValue = Object.hasOwn(props.bindings ?? {}, "stateValue") || Object.hasOwn(props.queryBindings ?? {}, "stateValue")
    ? props.stateValue : resolvePath(props.stateValue ?? "", parameters);
  const { state, diagnostic } = resolveIndicatorState({ ...props, stateValue });
  return <div className={`render-state-indicator${state ? "" : " state-unavailable"}`} role="status" aria-label={props.text || "State indicator"}>
    <span className="state-indicator-caption">{caption("State")}</span>
    <div className="state-indicator-value">
      <span className="state-indicator-dot" style={{ backgroundColor: state?.color }} aria-hidden="true" />
      <strong>{state?.label || diagnostic}</strong>
    </div>
  </div>;
}

function renderImage(context: RenderContext, controls: ComponentControlState) {
  const { parameters, preview, queryScope, props } = context;
  const { failedImage, setFailedImage } = controls;
  const assetId = props.assetId || "";
  const generated = props.imageUrl !== "" && (props.imageUrl !== undefined
    || Object.hasOwn(props.bindings ?? {}, "imageUrl") || Object.hasOwn(props.queryBindings ?? {}, "imageUrl"));
  const imageUrl = generated ? transientImageUrl(props.imageUrl, typeof window === "undefined" ? undefined : window.location.origin)
    : /^[a-f0-9]{64}$/.test(assetId) ? apiUrl(`${queryScope === "runtime" ? "/runtime" : ""}/assets/${assetId}`) : null;
  return imageUrl && failedImage !== imageUrl ? (
    <figure className="render-image">
      <img
        key={imageUrl}
        src={imageUrl}
        alt={props.bindings?.alt || props.queryBindings?.alt ? props.alt || "" : resolvePath(props.alt || "", parameters)}
        style={{ objectFit: props.fit || "contain" }}
        draggable={false}
        onError={() => setFailedImage(imageUrl)}
      />
      {props.text && <figcaption>{props.text}</figcaption>}
    </figure>
  ) : (
    <div className="media-placeholder">
      <Icon name="monitor" size={28} />
      <span>
        {generated && !imageUrl
          ? "Generated image needs a local browser blob URL"
          : failedImage === imageUrl && imageUrl
            ? "Image unavailable"
            : preview
              ? "No image configured"
              : "Choose or upload an image in Properties"}
      </span>
    </div>
  );
}

function renderIcon(context: RenderContext) {
  const { parameters, props } = context;
  return (
    <div
      className="render-icon"
      role="img"
      aria-label={
        props.alt
          ? props.bindings?.alt || props.queryBindings?.alt ? props.alt : resolvePath(props.alt, parameters)
          : props.text || props.icon || "Icon"
      }
    >
      <Icon name={props.icon || "spark"} />
    </div>
  );
}

function createInputInteraction(context: RenderContext, controls: ComponentControlState) {
  // Every native input shares the same draft, formatting and commit semantics.
  const { component, tags, parameters, preview, communicationLost, publishedAt, inputs, onInputChange, onInputCommit, interactionLocked, readOnly, props, caption } = context;
  const { type } = component;
  const { initialStatusId, latestInputValue, setCommandCommit, committedValue } = controls;
  const fieldKey = props.fieldKey || component.id;
  const value = Object.hasOwn(inputs, fieldKey)
    ? inputs[fieldKey]
    : initialInput(component, tags, parameters, communicationLost);
  latestInputValue.current = value;
  const constraintError = value === null ? null : inputConstraintError(component, value);
  const inputProps = {
    tabIndex: preview ? 0 : -1,
    disabled: interactionLocked || readOnly || !preview,
    "aria-label": props.text || fieldKey,
    "aria-invalid": value === null || Boolean(constraintError),
    "aria-describedby": value === null || constraintError ? initialStatusId : undefined,
  };
  const inputId = `${initialStatusId}-control`;
  const label = caption(fieldKey);
  const change = (next: InputValue) => {
    if (preview && !interactionLocked && !readOnly) {
      latestInputValue.current = next; committedValue.current = null;
      onInputChange?.(fieldKey, next);
    }
  };
  const commit = () => {
    if (preview && !interactionLocked && !readOnly && latestInputValue.current !== null) {
      if (type === "formattedInput" && typeof latestInputValue.current === "string") {
        const formatted = formatInputText(component, latestInputValue.current);
        if (formatted !== latestInputValue.current) change(formatted);
      }
      if (type === "numberInput" && props.commandId) {
        const requested = latestInputValue.current;
        if (typeof requested !== "number" || !Number.isFinite(requested) || validateInputs({ id: "setpoint", name: "Setpoint", width: 1, height: 1, components: [component] }, { [fieldKey]: requested }, parameters)) return;
        const stamp = JSON.stringify([props.commandId, publishedAt, requested]);
        if (committedValue.current === stamp) return;
        committedValue.current = stamp;
        setCommandCommit(previous => ({ value: requested, sequence: (previous?.sequence ?? 0) + 1 }));
      }
      onInputCommit?.(fieldKey, latestInputValue.current!);
    }
  };
  const changeAndCommit = (next: InputValue) => { change(next); commit(); };
  const commitKey = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (type === "barcodeInput") {
      if (event.key === (props.scanTerminator === "tab" ? "Tab" : "Enter") && !event.nativeEvent.isComposing && !event.repeat && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (event.key === "Enter") event.preventDefault();
        if (latestInputValue.current !== null && !inputConstraintError(component, latestInputValue.current)) {
          commit();
          if (preview && !interactionLocked && !readOnly) event.currentTarget.select();
        }
      }
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing && (type !== "textArea" || event.ctrlKey || event.metaKey)) { event.preventDefault(); commit(); }
  };
  return { fieldKey, value, constraintError, inputProps, inputId, initialStatusId, label, change, commit, changeAndCommit, commitKey };
}

function renderInput(context: RenderContext, controls: ComponentControlState) {
  const { component, parameters, preview, communicationLost, queryScope, publishedAt, scopeComponents, inputs, onInputChange, interactionLocked, readOnly, props } = context;
  const { type } = component;
  const { initialStatusId, commandCommit } = controls;
  const input = createInputInteraction(context, controls);
  const { value, constraintError, inputProps, label, changeAndCommit } = input;
  if (type === "list" || type === "treeView") return <ListTreeInput component={component} components={scopeComponents ?? [component]}
    label={label} value={value} inputs={inputs} parameters={parameters} queryScope={queryScope} publishedAt={publishedAt}
    communicationLost={communicationLost} disabled={inputProps.disabled} tabIndex={inputProps.tabIndex}
    onMappedChange={readOnly ? undefined : onInputChange} onChange={changeAndCommit} />;
  return (
    <div
      className={`render-input render-${type} ${value === null ? "initial-value-unavailable" : ""}`}
      style={{ pointerEvents: preview ? "auto" : "none" }}
    >
      {renderInputControl(context, input, controls)}
      {type === "numberInput" && props.commandId && <EquipmentCommand key={JSON.stringify([component.id, props.commandId, publishedAt, queryScope])} component={{ ...component, props }} publishedAt={publishedAt} queryScope={queryScope} communicationLost={communicationLost} interactionLocked={interactionLocked || readOnly || !preview} commit={commandCommit} />}
      {constraintError && <small className="input-validation-error" id={initialStatusId} role="status">{constraintError}</small>}
      {value === null && !props.optionsSource && (
        <small
          className="input-initial-status"
          id={initialStatusId}
          role="status"
        >
          <Icon name="info" size={11} />
          Initial value unavailable
        </small>
      )}
    </div>
  );
}

type InputInteraction = ReturnType<typeof createInputInteraction>;

function renderInputControl(context: RenderContext, input: InputInteraction, controls: ComponentControlState) {
  // Pure renderers retain the native event tree and do not introduce new owners.
  switch (context.component.type) {
    case "checkbox":
    case "toggle": return renderBooleanInput(context, input);
    case "radioGroup":
    case "multiStateButton": return renderChoiceInput(context, input);
    case "slider": return renderSliderInput(context, input, controls);
    case "spinner": return renderSpinnerInput(context, input);
    case "select":
      if (context.props.optionsSource) return renderQuerySelectInput(context, input);
      break;
  }
  return <label><span>{input.label}</span>{renderTextOrSelectInput(context, input)}</label>;
}

function renderTextOrSelectInput(context: RenderContext, input: InputInteraction) {
  if (context.component.type === "select") return renderStaticSelectInput(context, input);
  if (context.component.type === "textArea") return renderTextAreaInput(context, input);
  return renderScalarInput(context, input);
}

function renderBooleanInput(context: RenderContext, input: InputInteraction) {
  const { component: { type }, caption } = context;
  const { inputProps, value, changeAndCommit } = input;
  return (<label className="render-checkbox">
    <input
      {...inputProps}
      type="checkbox"
      role={type === "toggle" ? "switch" : undefined}
      aria-checked={type === "toggle" ? value === true : undefined}
      checked={value === true}
      ref={(element) => {
        if (element) element.indeterminate = value === null;
      }}
      onChange={(event) => changeAndCommit(event.target.checked)}
    />
    {type === "toggle" && <span className="toggle-track" aria-hidden="true"><span /></span>}
    <span className="boolean-label">{caption(type === "toggle" ? "Toggle" : "Check box")}</span>
    {type === "toggle" && <span className="toggle-state" aria-hidden="true">{value === null ? "Unknown" : value === true ? "On" : "Off"}</span>}
  </label>);
}

function renderChoiceInput(context: RenderContext, input: InputInteraction) {
  const { component: { type }, props, preview } = context;
  const { label, inputProps, initialStatusId, value, changeAndCommit } = input;
  return (<fieldset className={`radio-options${type === "multiStateButton" ? " state-options" : ""}`} disabled={inputProps.disabled} aria-describedby={inputProps["aria-describedby"]} aria-invalid={inputProps["aria-invalid"]}>
    <legend>{label}</legend>
    <div className="radio-option-list">
      {(props.options || []).map((option) => (
        <label className="radio-option" key={option.value}>
          <input
            {...inputProps}
            tabIndex={preview ? undefined : -1}
            type="radio"
            name={`${initialStatusId}-options`}
            aria-label={option.label}
            value={option.value}
            checked={value === option.value}
            onChange={() => changeAndCommit(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  </fieldset>);
}

function renderSliderInput(context: RenderContext, input: InputInteraction, controls: ComponentControlState) {
  const { component, props } = context;
  const { inputProps, inputId, value, label, change, commit } = input;
  const { latestInputValue } = controls;
  const numericProps = { step: props.step ?? 1, min: props.min, max: props.max };
  const sliderKnown = isSafeNumber(value) && value >= (props.min ?? 0) && value <= (props.max ?? 100);
  return (<div className="slider-control">
    <div className="slider-heading"><label htmlFor={inputId}>{label}</label><output htmlFor={inputId}>{sliderKnown ? value : "Choose a value"}{sliderKnown && props.unit ? ` ${props.unit}` : ""}</output></div>
    <input
      {...inputProps}
      {...numericProps}
      id={inputId}
      type="range"
      step="any"
      min={props.min ?? 0}
      max={props.max ?? 100}
      value={sliderKnown ? value : props.min ?? 0}
      className={sliderKnown ? "" : "slider-unset"}
      aria-valuetext={!sliderKnown ? "Initial value unavailable. Choose a value." : props.unit ? `${value} ${props.unit}` : undefined}
      onChange={(event) => {
        const next = sliderInputValue(component, Number(event.target.value));
        if (next !== null) change(next);
      }}
      onPointerUp={(event) => {
        if (latestInputValue.current === null) {
          const next = sliderInputValue(component, Number(event.currentTarget.value));
          if (next !== null) change(next);
        }
        commit();
      }}
      onPointerDown={(event) => event.currentTarget.setPointerCapture?.(event.pointerId)}
      onPointerCancel={commit}
      onBlur={commit}
      onKeyUp={(event) => { if (["ArrowRight", "ArrowUp", "ArrowLeft", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) commit(); }}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        let next: number | null | undefined;
        if (event.key === "ArrowRight" || event.key === "ArrowUp") next = incrementInput(component, value, 1);
        else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = incrementInput(component, value, -1);
        else if (event.key === "Home") next = props.min;
        else if (event.key === "End") next = props.max;
        else return;
        event.preventDefault();
        if (isSafeNumber(next)) change(next);
      }}
    />
    <div className="slider-limits" aria-hidden="true"><span>{props.min ?? 0}</span><span>{props.max ?? 100}</span></div>
  </div>);
}

function renderSpinnerInput(context: RenderContext, input: InputInteraction) {
  const { component, props } = context;
  const { inputProps, inputId, value, label, change, commit, changeAndCommit, commitKey } = input;
  const numericProps = { step: props.step ?? 1, min: props.min, max: props.max };
  const down = incrementInput(component, value, -1), up = incrementInput(component, value, 1);
  return (<div className="spinner-field">
    <label htmlFor={inputId}>{label}</label>
    <div className="spinner-control">
      <button type="button" disabled={inputProps.disabled || down === null || down === value} tabIndex={inputProps.tabIndex} aria-label={`Decrease ${label}`} onClick={() => { if (down !== null) changeAndCommit(down); }}><span aria-hidden="true">−</span></button>
      <input
        {...inputProps}
        {...numericProps}
        id={inputId}
        type="number"
        value={typeof value === "boolean" ? "" : value ?? ""}
        placeholder={value === null ? "Unavailable" : undefined}
        onChange={(event) => change(numericInputValue(event.target.value))}
        onBlur={commit}
        onKeyDown={commitKey}
      />
      <button type="button" disabled={inputProps.disabled || up === null || up === value} tabIndex={inputProps.tabIndex} aria-label={`Increase ${label}`} onClick={() => { if (up !== null) changeAndCommit(up); }}><span aria-hidden="true">+</span></button>
    </div>
  </div>);
}

function renderQuerySelectInput(context: RenderContext, input: InputInteraction) {
  const { component, parameters, queryScope, publishedAt, communicationLost, scopeComponents, inputs, readOnly, onInputChange } = context;
  const { label, value, inputProps, changeAndCommit } = input;
  return (<QuerySelect
    label={label}
    component={component}
    components={scopeComponents ?? [component]}
    parameters={parameters}
    queryScope={queryScope}
    publishedAt={publishedAt}
    communicationLost={communicationLost}
    value={value}
    inputs={inputs}
    inputProps={inputProps}
    onMappedChange={readOnly ? undefined : onInputChange}
    onChange={changeAndCommit}
  />);
}

function renderStaticSelectInput(context: RenderContext, input: InputInteraction) {
  const { props } = context;
  const { inputProps, value, changeAndCommit } = input;
  return (<select
    {...inputProps}
    value={value === null ? "" : String(value)}
    onChange={(event) => changeAndCommit(event.target.value)}
  >
    {value === null && (
      <option value="" disabled>
        Choose a value…
      </option>
    )}
    {(props.options || []).map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ))}
  </select>);
}

function renderTextAreaInput(context: RenderContext, input: InputInteraction) {
  const { props } = context;
  const { inputProps, value, change, commit, commitKey } = input;
  return (<textarea
    {...inputProps}
    value={value === null ? "" : String(value)}
    maxLength={props.validation?.maxLength ?? 4096}
    placeholder={value === null ? "Initial value unavailable" : undefined}
    onChange={(event) => change(event.target.value)}
    onBlur={commit}
    onKeyDown={commitKey}
  />);
}

function renderScalarInput(context: RenderContext, input: InputInteraction) {
  const { component: { type }, props } = context;
  const { inputProps, value, change, commit, commitKey } = input;
  const numeric = isNumericInput(type);
  const numericProps = { step: props.step ?? 1 };
  return (<input
    {...inputProps}
    type={numeric ? "number" : type === "dateTimeInput" ? "datetime-local" : type === "passwordInput" ? "password" : "text"}
    autoComplete={type === "passwordInput" ? "new-password" : undefined}
    spellCheck={type === "passwordInput" || type === "barcodeInput" || type === "formattedInput" ? false : undefined}
    step={numeric ? numericProps.step : type === "dateTimeInput" ? 60 : undefined}
    min={numeric ? props.min : type === "dateTimeInput" ? "0001-01-01T00:00" : undefined}
    max={numeric ? props.max : type === "dateTimeInput" ? "9999-12-31T23:59" : undefined}
    maxLength={textValidationTypes.has(type) ? props.validation?.maxLength ?? 4096 : undefined}
    value={
      typeof value === "boolean" ? String(value) : (value ?? "")
    }
    placeholder={
      value === null ? "Initial value unavailable" : type === "formattedInput" ? props.formatMask : type === "barcodeInput" ? `Scan, then ${props.scanTerminator === "tab" ? "Tab" : "Enter"}` : undefined
    }
    onChange={(event) => change(numeric ? numericInputValue(event.target.value) : event.target.value)}
    onBlur={type === "barcodeInput" ? undefined : commit}
    onKeyDown={commitKey}
  />);
}

function renderLabel(context: RenderContext) {
  const { component, props, caption } = context;
  return (
    <div
      className="render-label"
      style={{
        fontSize: props.fontSize || (component.height < 44 ? 15 : 28),
        color: props.foregroundColor || props.color || undefined,
      }}
    >
      {caption("Text")}
    </div>
  );
}

function renderButton(context: RenderContext) {
  const { component, preview, onNavigate, communicationLost, queryScope, onAction, actionBusy, interactionLocked, readOnly, onOpenPopup, onClosePopup, props, caption } = context;
  const { type } = component;
  if (type === "button" && props.action === "setTagValue")
    return <NativeTagButton caption={caption("Button")} preview={preview} queryScope={queryScope}
      busy={actionBusy} disabled={interactionLocked || communicationLost || readOnly}
      onActivate={() => onAction?.(component)} />;
  return (
    <button
      className="render-button"
      style={{ pointerEvents: preview ? "auto" : "none" }}
      tabIndex={preview ? 0 : -1}
      disabled={
        actionBusy ||
        interactionLocked ||
        (props.action === "script" && (communicationLost || readOnly)) ||
        (props.action === "message" && readOnly)
      }
      onClick={() =>
        props.action === "script" || props.action === "message"
          ? !readOnly && onAction?.(component)
          : props.action === "openPopup"
            ? onOpenPopup?.(component)
            : props.action === "closePopup"
              ? onClosePopup?.()
              : onNavigate(props.targetScreenId || "")
      }
    >
      {actionBusy ? "Running…" : caption("Button")}
      <Icon
        name={
          props.action === "script" || props.action === "message"
            ? "play"
            : props.action === "openPopup"
              ? "external"
              : props.action === "closePopup"
                ? "close"
                : "arrow"
        }
        size={18}
      />
    </button>
  );
}

function renderTable(context: RenderContext) {
  const { component, parameters, preview, communicationLost, queryScope, publishedAt, scopeComponents, onInputChange, onTableEdit, actionBusy, interactionLocked, readOnly, props, caption } = context;
  return (
    <QueryTable
      data={props.data}
      queryId={props.queryId || ""}
      title={caption("Data table")}
      parameters={parameters}
      queryScope={queryScope}
      publishedAt={publishedAt}
      communicationLost={communicationLost}
      selectionFields={props.selectionFields}
      pageSize={props.pageSize}
      tableColumns={props.tableColumns}
      selectionMode={props.selectionMode}
      tableEdit={props.tableEdit}
      onTableEdit={preview && queryScope === "runtime" && !interactionLocked && !actionBusy && !readOnly ? onTableEdit : undefined}
      components={scopeComponents ?? [component]}
      rowKey={props.rowKey}
      onSelect={preview && !interactionLocked && !readOnly ? onInputChange : undefined}
    />
  );
}

function renderGauge(context: RenderContext) {
  const { props, caption } = context;
  const { tag, precisionLimited, good, quality } = tagDisplayState(context);
  const min = props.min ?? 0,
    max = props.max ?? 100;
  const fraction =
    tag && !precisionLimited && typeof tag.value === "number" && max > min
      ? Math.max(0, Math.min(1, (tag.value - min) / (max - min)))
      : 0;
  return (
    <div className={`render-gauge ${good ? "" : "widget-bad-quality"}`}>
      <div className="widget-title">
        <span>{caption("Process value")}</span>
        <span className={`quality-dot ${good ? "" : "bad"}`} />
      </div>
      <div className="gauge-visual">
        <svg viewBox="0 0 220 128">
          <path
            className="gauge-track"
            d="M24 110a86 86 0 0 1 172 0"
            pathLength="100"
          />
          <path
            className="gauge-fill"
            d="M24 110a86 86 0 0 1 172 0"
            pathLength="100"
            strokeDasharray={`${fraction * 100} 100`}
          />
        </svg>
        <div className="gauge-number">
          <strong>{displayValue(tag?.value)}</strong>
          <span>{props.unit || ""}</span>
        </div>
      </div>
      <div className="gauge-range">
        <span>{min}</span>
        <span>{max}</span>
      </div>
      {!good && (
        <div className="quality-overlay">
          <Icon name="info" size={13} />
          {quality}
        </div>
      )}
    </div>
  );
}

function renderValue(context: RenderContext) {
  const { communicationLost, props, caption } = context;
  const { tag, good, quality } = tagDisplayState(context);
  return (
    <div className={`render-value ${good ? "" : "widget-bad-quality"}`}>
      <div className="widget-title">
        <span>{caption("Live value")}</span>
        <span className="widget-icon">
          <Icon name="activity" size={18} />
        </span>
      </div>
      <div className="value-display">
        <strong>{displayValue(tag?.value)}</strong>
        <span>{props.unit || ""}</span>
      </div>
      <div className="value-footer">
        <span className={`quality-dot ${good ? "" : "bad"}`} />
        <span>
          {communicationLost
            ? "Communication lost"
            : tag
              ? good
                ? "Live value"
                : tag.quality
              : props.tagPath
                ? "Tag not found"
                : "No tag binding"}
        </span>
        <span>
          {tag?.source?.toLowerCase().includes("sim")
            ? "SIMULATED"
            : tag?.source || ""}
        </span>
      </div>
      {!good && (
        <div className="quality-overlay">
          <Icon name="info" size={13} />
          {quality}
        </div>
      )}
    </div>
  );
}

export function QuerySelect({ label, component, components, parameters, queryScope, publishedAt, communicationLost, value, inputs, inputProps, onMappedChange, onChange }: {
  label: string;
  component: CanvasComponent;
  components: CanvasComponent[];
  parameters: RuntimeParameters;
  queryScope: "designer" | "runtime";
  publishedAt?: string;
  communicationLost: boolean;
  value: InputValue | null;
  inputs: InputValues;
  inputProps: React.SelectHTMLAttributes<HTMLSelectElement>;
  onMappedChange?: (field: string, value: InputValue) => void;
  onChange: (value: InputValue) => void;
}) {
  const state = useQueryOptions(component.props.optionsSource!, queryScope, parameters, communicationLost, publishedAt);
  const [selectionError, setSelectionError] = useState<{ key: string; message: string } | null>(null);
  const statusId = useId();
  const reloadContext = JSON.stringify([state.key, value, component.props.selectionFields, inputProps.disabled, inputs, components]);
  const latestContext = useRef(reloadContext);
  latestContext.current = reloadContext;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const chosen = typeof value === "string" ? state.options.find(option => option.value === value) : undefined;
  const placeholder = querySelectPlaceholder(state, value, Boolean(chosen));
  const unavailable = Boolean(inputProps.disabled || communicationLost || state.loading || state.error);
  const error = state.error || (selectionError?.key === state.key ? selectionError.message : "");
  const apply = (option: (typeof state.options)[number]) => {
    try {
      const changes = querySelectionChanges(option, component, components);
      for (const [field, next] of changes) onMappedChange?.(field, next);
      setSelectionError(null);
      onChange(option.value);
    } catch (reason) {
      setSelectionError({ key: state.key, message: reason instanceof Error ? reason.message : String(reason) });
    }
  };
  return <div className="query-select-content">
    <label htmlFor={`${statusId}-select`}>{label}</label>
    <select
      {...inputProps}
      id={`${statusId}-select`}
      disabled={unavailable || !state.options.length}
      aria-invalid={Boolean(error) || !chosen}
      aria-describedby={statusId}
      value={chosen ? chosen.value : ""}
      onChange={event => {
        if (unavailable) return;
        const option = state.options.find(item => item.value === event.target.value);
        if (!option) return;
        apply(option);
      }}
    >
      {(!chosen || state.loading || state.error) && <option value="" disabled>{placeholder}</option>}
      {state.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    <div className="query-select-footer"><small id={statusId} className={error ? "error-text" : "muted"} role={error ? "alert" : "status"} title={error || placeholder}>
      {error || (state.loading ? "Loading options…" : !chosen ? placeholder : `${state.options.length} choices`)}
    </small>
      {Object.keys(component.props.selectionFields ?? {}).length > 0 && <button
        type="button"
        className="button query-selection-reload"
        tabIndex={inputProps.tabIndex}
        disabled={unavailable || !chosen}
        onClick={async event => {
          event.preventDefault();
          if (unavailable || !chosen) return;
          const options = await state.refresh();
          if (!options || !mounted.current || latestContext.current !== reloadContext) return;
          const option = options.find(item => item.value === value);
          if (!option) { setSelectionError({ key: state.key, message: "This selection is no longer available. Choose another record." }); return; }
          apply(option);
        }}
      ><Icon name="refresh" size={12} /> Reload selected record</button>}</div>
  </div>;
}

function querySelectPlaceholder(state: ReturnType<typeof useQueryOptions>, value: InputValue | null, chosen: boolean): string {
  if (state.error) return "Options unavailable";
  if (state.loading) return "Loading options…";
  if (!state.options.length) return "No options returned";
  if (value !== null && value !== "" && !chosen) return "Selection no longer available";
  return "Choose a value…";
}
