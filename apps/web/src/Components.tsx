import type { RuntimeParameters } from "./types";
import { useEffect, useId, useRef, useState } from "react";
import { apiUrl, displayValue, resolvePath } from "./api";
import Icon from "./Icon";
import { QueryTable } from "./QueryTable";
export { QueryTable } from "./QueryTable";
import { querySelectionChanges } from "./queryOptions";
import { useQueryOptions } from "./useQueryOptions";
import { resolveIndicatorState } from "./stateControls";
import { isProcessDisplay } from "./processDisplays";
import ProcessDisplay from "./ProcessDisplay";
import DrawingComponent from "./DrawingComponent";
import { isDrawingComponent } from "./drawingComponents";
import ListTreeInput from "./ListTreeInput";
import type {
  CanvasComponent,
  InputValue,
  InputValues,
  ScriptResult,
  TableCellEdit,
  Tag,
} from "./types";
import {
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
  onOpenPopup,
  onClosePopup,
}: {
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
  onTableEdit?: (edit: TableCellEdit) => Promise<ScriptResult>;
  actionBusy?: boolean;
  interactionLocked?: boolean;
  readOnly?: boolean;
  onOpenPopup?: (component: CanvasComponent) => void;
  onClosePopup?: () => void;
}) {
  const initialStatusId = useId();
  const latestInputValue = useRef<InputValue | null>(null);
  const [failedAsset, setFailedAsset] = useState("");
  const { type } = component;
  const props = {
    ...component.props,
    text: Object.hasOwn(component.props.bindings ?? {}, "text") || Object.hasOwn(component.props.queryBindings ?? {}, "text")
      ? component.props.text ?? ""
      : resolvePath(component.props.text || "", parameters),
  };
  const caption = (fallback: string) => Object.hasOwn(component.props.bindings ?? {}, "text") || Object.hasOwn(component.props.queryBindings ?? {}, "text")
    ? props.text
    : props.text || fallback;
  const tag = tags.find(
    (item) => item.path === (props.queryBindings?.tagPath ? props.tagPath : resolvePath(props.tagPath || "", parameters)),
  );
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
  if (isProcessDisplay(type)) return <ProcessDisplay component={{ ...component, props }} parameters={parameters} />;
  if (isDrawingComponent(type)) return <DrawingComponent component={{ ...component, props }} preview={preview} interactionLocked={interactionLocked} onNavigate={onNavigate} onOpenPopup={onOpenPopup} />;
  if (type === "multiStateIndicator") {
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
  if (type === "image") {
    const assetId = props.assetId || "";
    const valid = /^[a-f0-9]{64}$/.test(assetId);
    return valid && failedAsset !== assetId ? (
      <figure className="render-image">
        <img
          src={apiUrl(`${queryScope === "runtime" ? "/runtime" : ""}/assets/${assetId}`)}
          alt={resolvePath(props.alt || "", parameters)}
          style={{ objectFit: props.fit || "contain" }}
          draggable={false}
          onError={() => setFailedAsset(assetId)}
        />
        {props.text && <figcaption>{props.text}</figcaption>}
      </figure>
    ) : (
      <div className="media-placeholder">
        <Icon name="monitor" size={28} />
        <span>
          {failedAsset === assetId && assetId
            ? "Image unavailable"
            : preview
              ? "No image configured"
              : "Choose or upload an image in Properties"}
        </span>
      </div>
    );
  }
  if (type === "icon")
    return (
      <div
        className="render-icon"
        role="img"
        aria-label={
          props.alt
            ? resolvePath(props.alt, parameters)
            : props.text || props.icon || "Icon"
        }
      >
        <Icon name={props.icon || "spark"} />
      </div>
    );
  if (isInput(type)) {
    const fieldKey = props.fieldKey || component.id;
    const value = Object.hasOwn(inputs, fieldKey)
      ? inputs[fieldKey]
      : initialInput(component, tags, parameters, communicationLost);
    latestInputValue.current = value;
    const inputProps = {
      tabIndex: preview ? 0 : -1,
      disabled: interactionLocked || readOnly || !preview,
      "aria-label": props.text || fieldKey,
      "aria-invalid": value === null,
      "aria-describedby": value === null ? initialStatusId : undefined,
    };
    const inputId = `${initialStatusId}-control`;
    const label = caption(fieldKey);
    const change = (next: InputValue) => {
      if (preview && !interactionLocked && !readOnly) {
        latestInputValue.current = next;
        onInputChange?.(fieldKey, next);
      }
    };
    const commit = () => {
      if (preview && !interactionLocked && !readOnly && latestInputValue.current !== null) onInputCommit?.(fieldKey, latestInputValue.current);
    };
    const changeAndCommit = (next: InputValue) => { change(next); commit(); };
    const commitKey = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.nativeEvent.isComposing && (type !== "textArea" || event.ctrlKey || event.metaKey)) { event.preventDefault(); commit(); }
    };
    const numeric = isNumericInput(type);
    const numericProps = {
      step: props.step ?? 1,
      min: props.min,
      max: props.max,
    };
    const down = type === "spinner" ? incrementInput(component, value, -1) : null;
    const up = type === "spinner" ? incrementInput(component, value, 1) : null;
    const sliderKnown = isSafeNumber(value) &&
      value >= (props.min ?? 0) && value <= (props.max ?? 100);
    if (type === "list" || type === "treeView") return <ListTreeInput component={component} components={scopeComponents ?? [component]}
      label={label} value={value} inputs={inputs} parameters={parameters} queryScope={queryScope} publishedAt={publishedAt}
      communicationLost={communicationLost} disabled={inputProps.disabled} tabIndex={inputProps.tabIndex}
      onMappedChange={readOnly ? undefined : onInputChange} onChange={changeAndCommit} />;
    return (
      <div
        className={`render-input render-${type} ${value === null ? "initial-value-unavailable" : ""}`}
        style={{ pointerEvents: preview ? "auto" : "none" }}
      >
        {type === "checkbox" || type === "toggle" ? (
          <label className="render-checkbox">
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
          </label>
        ) : type === "radioGroup" || type === "multiStateButton" ? (
          <fieldset className={`radio-options${type === "multiStateButton" ? " state-options" : ""}`} disabled={inputProps.disabled} aria-describedby={inputProps["aria-describedby"]} aria-invalid={inputProps["aria-invalid"]}>
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
          </fieldset>
        ) : type === "slider" ? (
          <div className="slider-control">
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
          </div>
        ) : type === "spinner" ? (
          <div className="spinner-field">
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
          </div>
        ) : type === "select" && props.optionsSource ? (
          <QuerySelect
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
          />
        ) : (
          <label>
            <span>{label}</span>
            {type === "select" ? (
              <select
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
              </select>
            ) : type === "textArea" ? (
              <textarea
                {...inputProps}
                value={value === null ? "" : String(value)}
                maxLength={4096}
                placeholder={value === null ? "Initial value unavailable" : undefined}
                onChange={(event) => change(event.target.value)}
                onBlur={commit}
                onKeyDown={commitKey}
              />
            ) : (
              <input
                {...inputProps}
                type={numeric ? "number" : type === "dateTimeInput" ? "datetime-local" : type === "passwordInput" ? "password" : "text"}
                autoComplete={type === "passwordInput" ? "new-password" : undefined}
                spellCheck={type === "passwordInput" ? false : undefined}
                step={numeric ? numericProps.step : type === "dateTimeInput" ? 60 : undefined}
                min={numeric ? props.min : type === "dateTimeInput" ? "0001-01-01T00:00" : undefined}
                max={numeric ? props.max : type === "dateTimeInput" ? "9999-12-31T23:59" : undefined}
                maxLength={type === "textInput" || type === "passwordInput" ? 4096 : undefined}
                value={
                  typeof value === "boolean" ? String(value) : (value ?? "")
                }
                placeholder={
                  value === null ? "Initial value unavailable" : undefined
                }
                onChange={(event) => change(numeric ? numericInputValue(event.target.value) : event.target.value)}
                onBlur={commit}
                onKeyDown={commitKey}
              />
            )}
          </label>
        )}
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
  if (type === "label")
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
  if (type === "button")
    return (
      <button
        className="render-button"
        style={{ pointerEvents: preview ? "auto" : "none" }}
        tabIndex={preview ? 0 : -1}
        disabled={
          actionBusy ||
          interactionLocked ||
          (props.action === "script" && (communicationLost || readOnly))
        }
        onClick={() =>
          props.action === "script"
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
            props.action === "script"
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
  if (type === "table")
    return (
      <QueryTable
        queryId={props.queryId || ""}
        title={caption("Data table")}
        parameters={parameters}
        queryScope={queryScope}
        publishedAt={publishedAt}
        communicationLost={communicationLost}
        selectionFields={props.selectionFields}
        pageSize={props.pageSize}
        tableColumns={props.tableColumns}
      tableEdit={props.tableEdit}
      onTableEdit={preview && queryScope === "runtime" && !interactionLocked && !actionBusy && !readOnly ? onTableEdit : undefined}
        components={scopeComponents ?? [component]}
        rowKey={props.rowKey}
        onSelect={preview && !interactionLocked && !readOnly ? onInputChange : undefined}
      />
    );
  if (type === "gauge") {
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
  const placeholder = state.error ? "Options unavailable"
    : state.loading ? "Loading options…"
    : !state.options.length ? "No options returned"
    : value !== null && value !== "" && !chosen ? "Selection no longer available"
    : "Choose a value…";
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
      disabled={inputProps.disabled || communicationLost || state.loading || Boolean(state.error) || !state.options.length}
      aria-invalid={Boolean(error) || !chosen}
      aria-describedby={statusId}
      value={chosen ? chosen.value : ""}
      onChange={event => {
        if (inputProps.disabled || state.loading || state.error || communicationLost) return;
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
      disabled={inputProps.disabled || communicationLost || state.loading || Boolean(state.error) || !chosen}
      onClick={async event => {
        event.preventDefault();
        if (inputProps.disabled || communicationLost || state.loading || state.error || !chosen) return;
        const options = await state.refresh();
        if (!options || !mounted.current || latestContext.current !== reloadContext) return;
        const option = options.find(item => item.value === value);
        if (!option) { setSelectionError({ key: state.key, message: "This selection is no longer available. Choose another record." }); return; }
        apply(option);
      }}
    ><Icon name="refresh" size={12} /> Reload selected record</button>}</div>
  </div>;
}
