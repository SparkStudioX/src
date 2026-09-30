import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import BoundComponent from "./BoundComponent";
import type { InheritedComponentAppearance } from "./BoundComponent";
import { componentGeometry, evaluateComponentBindings } from "./propertyBindings";
import { ApplicationStateProvider, useApplicationStateContext, useInstanceApplicationState } from "./applicationState";
import { resolvePath } from "./api";
import { useFormInputs } from "./inputStateBindings";
import { queryRowFormKey } from "./queryRepeater";
import { parameterBindingInputs, parameterBindingState, resolveParameterBindings } from "./templateParameterBindings";
import { useComponentEvents, usePythonComponentEvents } from "./ComponentEvents";
import type { PythonEventTransport } from "./pythonComponentEvents";
import { isPythonUnmount } from "./pythonComponentEvents";
import { QueryPropertyProvider, useQueryPropertyBindings, useQueryPropertyContext } from "./useQueryPropertyBindings";
import { useQueryRepeater } from "./useQueryRepeater";
import { useVisualStyles } from "./VisualStyleContext";
import { applyVisualStyle } from "./visualStyles";
import { useLocalization } from "./LocalizationContext";
import { localizeComponent } from "./localization";
import { applyPythonUiOverrides } from "./pythonUiModel";
import Icon from "./Icon";
import type {
  CanvasComponent,
  InputValue,
  InputValues,
  ParameterBindingState,
  InstanceAction,
  InstancePathStep,
  Tag,
  Template,
  TemplateRow,
  ResolvedTemplateRow,
  RuntimeParameters,
  ScriptResult,
  PythonUiAction,
  TableCellEdit,
} from "./types";
import {
  actionKey,
  instanceInputKey,
  isTemplateInstance,
  queryTemplateParameters,
  templateParameters,
  templateExpansion,
} from "./templateModel";
export {
  actionKey,
  componentContexts,
  instanceInputKey,
  isTemplateInstance,
  templateParameters,
  projectInputContext,
  instancePath,
  instanceRequestScope,
  templateExpansion,
} from "./templateModel";
import "./templates.css";

export interface ProjectComponentProps {
  component: CanvasComponent;
  components?: CanvasComponent[];
  templates?: Template[];
  screenId: string;
  tags: Tag[];
  parameters: RuntimeParameters;
  preview: boolean;
  queryScope?: "designer" | "runtime";
  publishedAt?: string;
  communicationLost?: boolean;
  inputs?: InputValues;
  scopedInputs?: Record<string, InputValues>;
  onInputChange?: (fieldKey: string, value: InputValue) => void;
  onAutomaticInputChange?: (fieldKey: string, value: InputValue) => void;
  onScopedInputChange?: (
    scope: string,
    fieldKey: string,
    value: InputValue,
  ) => void;
  onAutomaticScopedInputChange?: (scope: string, fieldKey: string, value: InputValue) => void;
  onNavigate: (screenId: string) => void;
  onAction?: (component: CanvasComponent, instance?: InstanceAction, uiAction?: PythonUiAction) => void;
  onPythonEvent?: PythonEventTransport;
  onTableEdit?: (component: CanvasComponent, edit: TableCellEdit, instance?: InstanceAction) => Promise<ScriptResult>;
  onOpenPopup?: (component: CanvasComponent, instance?: InstanceAction) => void;
  onClosePopup?: () => void;
  actionBusyId?: string;
  interactionLocked?: boolean;
  readOnly?: boolean;
  templateAncestors?: string[];
}

type TemplateInstanceProps = ProjectComponentProps & {
  inheritedAppearance?: InheritedComponentAppearance;
  parentPath?: InstancePathStep[];
  dynamicAncestor?: boolean;
  querySourceParameters?: RuntimeParameters;
  parentBindingInputs?: InputValues[];
  parentBindingState?: ParameterBindingState[];
};

export function ProjectComponentView(props: ProjectComponentProps) {
  if (isTemplateInstance(props.component.type))
    return <BoundTemplateInstance {...props} />;
  return (
    <BoundComponent
      {...props}
      onAction={(component, uiAction) => props.onAction?.(component, undefined, uiAction)}
      onTableEdit={props.onTableEdit ? edit => props.onTableEdit!(props.component, edit) : undefined}
      onOpenPopup={(component) => props.onOpenPopup?.(component)}
      actionBusy={props.actionBusyId === props.component.id}
    />
  );
}

/** Wrapper bindings belong to the parent form, independently of each template row. */
function BoundTemplateInstance(props: TemplateInstanceProps) {
  const applicationState = useApplicationStateContext();
  const queryProperties = useQueryPropertyContext();
  const styles = useVisualStyles();
  const localization = useLocalization();
  const localized = localizeComponent(props.component, localization.catalog, localization.locale);
  const styled = applyVisualStyle(localized.component, styles, props.inheritedAppearance);
  const authored = props.preview ? applyPythonUiOverrides(styled.component, applicationState) : styled.component;
  const result = evaluateComponentBindings(authored, {
    components: props.components ?? [props.component], tags: props.tags, parameters: props.parameters,
    inputs: props.inputs ?? {}, communicationLost: props.communicationLost, state: applicationState?.values,
    queryProperties,
  });
  const errors = Object.entries(result.errors);
  if (styled.error) errors.push(["style", styled.error]);
  const querySamples = queryProperties?.[props.component.id] ?? {};
  const queryWaiting = errors.length > 0 && errors.every(([target]) => querySamples[target as keyof typeof querySamples]?.status === "loading");
  const queryErrors = errors.filter(([target]) => Object.hasOwn(props.component.props.queryBindings ?? {}, target));
  const queryRefreshing = Object.values(querySamples).some(sample => sample?.status === "ready" && sample.refreshing);
  const python = usePythonComponentEvents({ component: props.component, components: props.components ?? [props.component], parameters: props.parameters,
    identity: JSON.stringify([props.component, props.parameters, props.publishedAt, props.preview, props.queryScope]),
    enabled: props.preview && !props.readOnly, transport: props.onPythonEvent, onAutomaticInputChange: props.onAutomaticInputChange });
  useComponentEvents({ component: props.component, evaluated: result.component, components: props.components ?? [props.component], errors: result.errors,
    parameters: props.parameters, inputs: props.inputs ?? {}, preview: props.preview, scopeKey: props.queryScope, onAutomaticInputChange: props.onAutomaticInputChange, python });
  const appearance = result.component.props;
  const visible = appearance.visible !== false;
  const enabled = appearance.enabled !== false && errors.length === 0;
  // Keep row forms mounted while hidden so an unchanged query row retains its
  // draft. The marker also removes the positioned parent from hit testing.
  const runtimeHidden = props.preview && !visible && !errors.length;
  const view = props.preview ? result.component : {
    ...result.component, x: props.component.x, y: props.component.y, width: props.component.width, height: props.component.height,
  };
  const template = props.templates?.find(item => item.id === view.props.templateId);
  const caption = appearance.bindings?.text || appearance.queryBindings?.text || Object.hasOwn(applicationState?.propertyOverrides[props.component.id] ?? {}, "text")
    ? appearance.text ?? "" : resolvePath(appearance.text || template?.name || "Template instance", props.parameters);
  const canInteract = props.preview && enabled && visible && !props.interactionLocked;
  const gate = useRef(false);
  const writeGate = useRef(false);
  gate.current = canInteract;
  writeGate.current = canInteract && !props.readOnly;
  useEffect(() => {
    gate.current = canInteract; writeGate.current = canInteract && !props.readOnly;
    return () => { gate.current = false; writeGate.current = false; };
  }, [canInteract, props.readOnly]);
  const inheritedAppearance: InheritedComponentAppearance = {};
  for (const key of ["color", "backgroundColor", "foregroundColor", "fontSize"] as const)
    if (appearance[key] !== undefined) Object.assign(inheritedAppearance, { [key]: appearance[key] });
  return <div className={`bound-component template-binding-frame${runtimeHidden ? " bound-component-hidden" : ""}${!visible ? " design-hidden" : ""}${errors.length ? " binding-failed" : ""}`}
    hidden={runtimeHidden}
    role="group" aria-label={caption} lang={localized.locale} data-component-id={props.component.id} aria-disabled={props.preview && !enabled || undefined}
    style={{
      backgroundColor: appearance.backgroundColor, color: appearance.foregroundColor,
      borderColor: appearance.borderColor, borderWidth: appearance.borderWidth,
      borderStyle: appearance.borderWidth === undefined ? undefined : "solid",
      fontSize: appearance.fontSize,
      "--template-background": appearance.backgroundColor,
    } as CSSProperties}>
    <div className="bound-component-content" inert={props.preview && (!enabled || !visible || props.interactionLocked)}>
      <TemplateInstances {...props} component={view} inheritedAppearance={inheritedAppearance}
        onAutomaticScopedInputChange={props.onAutomaticScopedInputChange ?? props.onScopedInputChange}
        interactionLocked={props.interactionLocked || !enabled || !visible}
        onAction={(leaf, instance, uiAction) => { if (writeGate.current) props.onAction?.(leaf, instance, uiAction); }}
        onTableEdit={canInteract && !props.readOnly && props.onTableEdit ? (leaf, edit, instance) => writeGate.current
          ? props.onTableEdit!(leaf, edit, instance) : Promise.reject(new Error("This template form is no longer interactive.")) : undefined}
        onOpenPopup={(leaf, instance) => { if (gate.current) props.onOpenPopup?.(leaf, instance); }}
        onNavigate={target => { if (gate.current) props.onNavigate(target); }}
        onClosePopup={() => { if (gate.current) props.onClosePopup?.(); }}
        onScopedInputChange={(scope, key, value) => { if (writeGate.current) props.onScopedInputChange?.(scope, key, value); }} />
    </div>
    {!props.preview && !visible && <span className="binding-visibility-note">Hidden in runtime</span>}
    {localized.warning && <span className="component-localization-note" role="status" title={localized.warning}>{localized.warning}</span>}
    {errors.length > 0 && <div className="component-binding-error" role="status" title={errors.map(([target, error]) => `${target}: ${error}`).join("\n")}>
      {queryWaiting ? "Loading query…" : queryErrors.length ? `Query unavailable: ${queryErrors.map(([target]) => target).join(", ")}` : `Binding error: ${errors.map(([target]) => target).join(", ")}`}
    </div>}
    {!errors.length && queryRefreshing && <div className="query-property-refreshing" role="status">Refreshing query…</div>}
  </div>;
}

function TemplateInstances(props: TemplateInstanceProps) {
  const applicationState = useApplicationStateContext();
  const {
    component, templates = [], parameters, preview, queryScope, publishedAt, communicationLost = false,
  } = props;
  const host = useRef<HTMLDivElement>(null);
  const [availableSize, setAvailableSize] = useState({ width: component.width, height: component.height });
  const template = templates.find(
    (item) => item.id === component.props.templateId,
  );
  const repeating = component.type === "repeater";
  const queryBacked = repeating && Boolean(component.props.rowsSource);
  const expansionError = templateExpansion(props.parentPath?.length ? [component] : props.components ?? [component], templates, props.templateAncestors).error;
  let boundParameters: RuntimeParameters = {}, bindingError = "", bindingInputs: InputValues = {}, bindingState: ParameterBindingState = {};
  try {
    if (template) {
      boundParameters = resolveParameterBindings(component, template, {
        components: props.components ?? [component], tags: props.tags, parameters, inputs: props.inputs ?? {}, state: applicationState?.values,
      });
      bindingInputs = parameterBindingInputs(component, props.inputs ?? {});
      bindingState = parameterBindingState(component, applicationState?.values);
    }
  } catch (reason) { bindingError = reason instanceof Error ? reason.message : String(reason); }
  const hasBindings = Object.keys(component.props.parameterBindings ?? {}).length > 0;
  const boundAncestor = hasBindings || Boolean(props.parentBindingInputs);
  // Snapshot only inputs actually used at each path step; never capture an
  // unrelated password field or confuse the caller form with the child form.
  const parentBindingInputs = [...(props.parentBindingInputs ?? (props.parentPath ?? []).map(() => ({}))), bindingInputs];
  const hasStateSource = Object.keys(bindingState).length > 0 || Boolean(props.parentBindingState);
  const parentBindingState = [...(props.parentBindingState ?? (props.parentPath ?? []).map(() => ({}))), bindingState];
  const queryRows = useQueryRepeater(repeating && !expansionError && !bindingError ? component.props.rowsSource : undefined, template,
    queryScope ?? "designer", parameters, communicationLost, publishedAt);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const resize = () => setAvailableSize({ width: element.clientWidth || component.width, height: element.clientHeight || component.height });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [component.width, component.height, template, repeating]);
  if (!template || expansionError)
    return (
      <div className="template-placeholder query-repeater-error" role="status">
        <Icon name="layers" size={27} />
        <strong>{repeating ? "Template repeater" : "Embedded template"}</strong>
        <span>
          {expansionError || (preview
            ? "The referenced template is unavailable."
            : "Choose a template in Properties.")}
        </span>
      </div>
    );
  let rowError = bindingError || (queryBacked && component.props.rows?.length
    ? "Choose saved rows or a named query, not both."
    : queryRows.error);
  const rows: (TemplateRow | ResolvedTemplateRow | undefined)[] = rowError ? [] : repeating
    ? queryBacked ? rowError ? [] : queryRows.rows : component.props.rows || []
    : [undefined];
  // Resolve the full set before rendering any child. One bad row must not leave
  // a partially actionable collection of forms on screen.
  let resolvedRows: { row: TemplateRow | ResolvedTemplateRow | undefined; context: RuntimeParameters }[] = [];
  try {
    resolvedRows = rows.map(row => ({ row, context: queryBacked
      ? queryTemplateParameters(template, parameters, component.props.parameters, row?.parameters, boundParameters)
      : templateParameters(template, parameters, component.props.parameters, row?.parameters as Record<string, string> | undefined, boundParameters) }));
  } catch (reason) { rowError = reason instanceof Error ? reason.message : String(reason); }
  const columns = repeating
    ? Math.max(1, Math.min(12, Math.trunc(component.props.columns || 1)))
    : 1;
  const gap = repeating
    ? Math.max(0, Math.min(64, component.props.gap ?? 16))
    : 0;
  const cellWidth = Math.max(
    1,
    (availableSize.width - gap * (columns - 1)) / columns,
  );
  const scale = repeating
    ? cellWidth / template.width
    : Math.min(cellWidth / template.width, availableSize.height / template.height);
  const cellHeight = template.height * scale;
  return (
    <div
      className={`template-instance-host ${repeating ? "is-repeater" : "is-template"} ${preview ? "" : "template-authoring"}`}
      ref={host}
      aria-label={
        component.props.text ||
        (repeating ? `${template.name} repeater` : template.name)
      }
    >
      {!resolvedRows.length && (
        <div className={`template-placeholder${rowError ? " query-repeater-error" : ""}`} role="status">
          <Icon name={rowError ? "info" : "layers"} size={27} />
          <strong>{rowError ? repeating ? "Rows unavailable" : "Parameters unavailable" : queryBacked ? queryRows.loading ? "Loading rows…" : "No matching rows" : "No rows configured"}</strong>
          <span>{rowError || (queryBacked ? queryRows.loading ? "Reading the configured named query." : "The query returned no records. Rows refresh automatically." : "Add saved rows in the repeater’s properties.")}</span>
        </div>
      )}
      {queryBacked && queryRows.loading && resolvedRows.length > 0 && <span className="query-repeater-refresh" role="status">Refreshing rows…</span>}
      <div
        className="template-instance-grid"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap,
          gridAutoRows: cellHeight,
        }}
      >
        {resolvedRows.map(({ row, context }) => {
          // A saved template/row has no query owner. Connection transitions must
          // not remount it just because the dormant query hook's key changed.
          const queryContext = JSON.stringify([props.screenId, component.id, component.type, props.parentPath, preview, publishedAt, queryBacked ? queryRows.key : undefined,
            component.props.parameterBindings, boundAncestor ? parentBindingInputs : undefined, hasStateSource ? parentBindingState : undefined, template.instanceState]);
          // Every descendant of a query row owns local edits too. Reusing those
          // edits after its template or effective form context changes is unsafe.
          const key = queryRowFormKey(queryContext, row ?? { id: "single", parameters: {} }, template, context);
          return <TemplateInstanceCell {...props} key={key}
            parentBindingInputs={boundAncestor ? parentBindingInputs : undefined}
            parentBindingState={hasStateSource ? parentBindingState : undefined}
            template={template} row={row} context={context} dynamic={queryBacked} scale={scale} cellHeight={cellHeight} />;
        })}
      </div>
    </div>
  );
}

/** Dynamic rows own their edits. A changed key remounts just that form, and a removed row releases it. */
function TemplateInstanceCell({ component, templates, template, row, context, dynamic, scale, cellHeight, screenId, tags,
  scopedInputs = {}, onScopedInputChange, onAutomaticScopedInputChange, communicationLost = false, preview, queryScope, publishedAt,
  onNavigate, onAction, onPythonEvent, onTableEdit, onOpenPopup, onClosePopup, actionBusyId, interactionLocked, inheritedAppearance, readOnly,
  parentPath = [], templateAncestors = [], dynamicAncestor = false,
  querySourceParameters, parentBindingInputs, parentBindingState,
}: TemplateInstanceProps & { template: Template; row?: TemplateRow | ResolvedTemplateRow; context: RuntimeParameters; dynamic: boolean; scale: number; cellHeight: number }) {
  const parentApplicationState = useApplicationStateContext();
  const [localInputs, setLocalInputs] = useState<InputValues>({});
  const path: InstancePathStep[] = [...parentPath, { instanceId: component.id, ...(row ? { rowId: row.id } : {}) }];
  const scope = instanceInputKey(screenId, path);
  const applicationState = useInstanceApplicationState(parentApplicationState, scope, template.instanceState);
  const local = dynamic || dynamicAncestor || Boolean(parentBindingInputs) || template.instanceState !== undefined;
  const queryParameters = dynamic ? context : querySourceParameters;
  const active = preview && !interactionLocked && !readOnly;
  const inputGate = useRef(false);
  const lifetime = useRef(true);
  useEffect(() => { lifetime.current = true; return () => { lifetime.current = false; }; }, []);
  inputGate.current = active;
  useEffect(() => { inputGate.current = active; return () => { inputGate.current = false; }; }, [active]);
  const form = useFormInputs({ document: template, tags, parameters: context, edits: local ? localInputs : scopedInputs[scope],
    communicationLost, state: applicationState, active, contextKey: JSON.stringify([scope, publishedAt]),
    onEdit: (key, value, automatic) => {
      if (local) setLocalInputs(previous => ({ ...previous, [key]: value }));
      else (automatic ? onAutomaticScopedInputChange : onScopedInputChange)?.(scope, key, value);
    } });
  const inputs = form.inputs;
  const queryProperties = useQueryPropertyBindings(template.components,
    { components: template.components, tags, parameters: context, inputs, communicationLost, state: applicationState?.values },
    { state: applicationState, scope: queryScope ?? "designer", publishedAt, active: preview });
  const instance: InstanceAction = {
    ...path[0], ...(path.length > 1 ? { instancePath: path } : {}), template, parameters: context, inputs,
    ...(queryParameters ? { querySourceParameters: queryParameters } : {}),
    ...(parentBindingInputs ? { bindingInputs: parentBindingInputs.map(values => ({ ...values })) } : {}),
    ...(parentBindingState ? { bindingState: structuredClone(parentBindingState) } : {}),
    isCurrent: () => lifetime.current,
  };
  return <ApplicationStateProvider value={applicationState}><QueryPropertyProvider value={queryProperties}><div className="template-instance-cell" data-instance-id={component.id} data-row-id={row?.id} data-instance-path={JSON.stringify(path)} style={{ height: cellHeight }}>
              <div
                className="template-instance-scene"
                style={{
                  width: template.width,
                  height: template.height,
                  transform: `scale(${scale})`,
                }}
              >
                {template.components.map((leaf) => (
                  <div
                    className={`template-leaf component-${leaf.type}`}
                    key={`${template.id}:${leaf.id}`}
                    style={
                      {
                        ...componentGeometry(leaf, {components:template.components, tags, parameters:context, inputs, communicationLost, state: applicationState?.values, queryProperties}, preview),
                        "--component-accent":
                          leaf.props.color || "var(--accent)",
                        "--component-foreground": leaf.props.color
                          ? "#ffffff"
                          : "var(--on-accent)",
                      } as CSSProperties
                    }
                  >
                    {isTemplateInstance(leaf.type) ? (
                      <BoundTemplateInstance component={leaf} components={template.components} templates={templates} screenId={screenId}
                        parameters={context} inputs={inputs} scopedInputs={scopedInputs} tags={tags} preview={preview}
                        onAutomaticInputChange={form.assignAutomatic}
                        parentPath={path} templateAncestors={[...templateAncestors, template.id]} dynamicAncestor={local}
                        querySourceParameters={queryParameters}
                        parentBindingInputs={parentBindingInputs}
                        parentBindingState={parentBindingState}
                        inheritedAppearance={inheritedAppearance} interactionLocked={interactionLocked} readOnly={readOnly}
                        queryScope={queryScope} publishedAt={publishedAt} communicationLost={communicationLost}
                        onScopedInputChange={onScopedInputChange} onNavigate={onNavigate} onAction={onAction}
                        onPythonEvent={onPythonEvent ? (target, invocation, nested) => onPythonEvent(target, invocation, nested ?? instance) : undefined}
                        onAutomaticScopedInputChange={onAutomaticScopedInputChange}
                        onTableEdit={onTableEdit} onOpenPopup={onOpenPopup} onClosePopup={onClosePopup} actionBusyId={actionBusyId} />
                    ) : (
                      <BoundComponent
                        component={leaf}
                        inheritedAppearance={inheritedAppearance}
                        components={template.components}
                        tags={tags}
                        parameters={context}
                        inputs={inputs}
                        preview={preview}
                        queryScope={queryScope}
                        publishedAt={publishedAt}
                        communicationLost={communicationLost}
                        onNavigate={onNavigate}
                        onInputChange={form.assign}
                        onAutomaticInputChange={form.assignAutomatic}
                        onAction={(_component, uiAction) => { if (lifetime.current && inputGate.current) onAction?.(leaf, instance, uiAction); }}
                        onPythonEvent={onPythonEvent ? (target, invocation) => (lifetime.current || isPythonUnmount(invocation.eventHandler)) && !readOnly
                          ? onPythonEvent(target, invocation, instance) : Promise.reject(new Error("This template event owner has closed.")) : undefined}
                        onTableEdit={onTableEdit ? edit => lifetime.current && inputGate.current ? onTableEdit(leaf, edit, instance)
                          : Promise.reject(new Error("This template form is no longer interactive.")) : undefined}
                        onOpenPopup={() => { if (lifetime.current) onOpenPopup?.(leaf, instance); }}
                        onClosePopup={onClosePopup}
                        actionBusy={
                          actionBusyId === actionKey(leaf.id, instance)
                        }
                        interactionLocked={interactionLocked}
                        readOnly={readOnly}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div></QueryPropertyProvider></ApplicationStateProvider>;
}
