import { tagDependencyPaths } from "./tagStore";
import RenderBoundary from "./RenderBoundary";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import BoundComponent from "./BoundComponent";
import { componentBindingDiagnostics, renderBindingDiagnostics } from "./bindingDiagnostics";
import type { InheritedComponentAppearance } from "./BoundComponent";
import { bindingReferenceDependencies, componentGeometry, evaluateComponentBindings } from "./propertyBindings";
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
import ViewContainer from "./ViewContainer";
import { panePlacement, viewLayoutError } from "./viewContainers";
import type { ViewPane } from "./viewContainers";
import { ComponentActivityProvider, useComponentActivity } from "./ComponentActivity";
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
  TableEditIntent,
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
  onTableEdit?: (component: CanvasComponent, edit: TableEditIntent, instance?: InstanceAction) => Promise<ScriptResult>;
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
  parentParameterScopes?: RuntimeParameters[];
};

export function ProjectComponentView(props: ProjectComponentProps) {
  const current = useRef(props); current.current = props;
  // Stable forwarding functions preserve fresh closures without invalidating every tile.
  const callbacks = useMemo(() => ({
    onNavigate: (...args: Parameters<ProjectComponentProps["onNavigate"]>) => current.current.onNavigate(...args),
    onAction: props.onAction ? (...args: Parameters<NonNullable<ProjectComponentProps["onAction"]>>) => current.current.onAction?.(...args) : undefined,
    onTableEdit: props.onTableEdit ? (...args: Parameters<NonNullable<ProjectComponentProps["onTableEdit"]>>) => current.current.onTableEdit!(...args) : undefined,
    onPythonEvent: props.onPythonEvent ? (...args: Parameters<NonNullable<ProjectComponentProps["onPythonEvent"]>>) => current.current.onPythonEvent!(...args) : undefined,
    onOpenPopup: props.onOpenPopup ? (...args: Parameters<NonNullable<ProjectComponentProps["onOpenPopup"]>>) => current.current.onOpenPopup?.(...args) : undefined,
    onClosePopup: props.onClosePopup ? () => current.current.onClosePopup?.() : undefined,
    onInputChange: props.onInputChange ? (...args: Parameters<NonNullable<ProjectComponentProps["onInputChange"]>>) => current.current.onInputChange?.(...args) : undefined,
    onScopedInputChange: props.onScopedInputChange ? (...args: Parameters<NonNullable<ProjectComponentProps["onScopedInputChange"]>>) => current.current.onScopedInputChange?.(...args) : undefined,
  }), [Boolean(props.onAction), Boolean(props.onTableEdit), Boolean(props.onPythonEvent), Boolean(props.onOpenPopup), Boolean(props.onClosePopup), Boolean(props.onInputChange), Boolean(props.onScopedInputChange)]);
  return <RenderBoundary tile label={typeof props.component.props.text === "string" ? props.component.props.text || props.component.type : props.component.type} resetKey={props.component}><MemoProjectComponent {...props} {...callbacks} /></RenderBoundary>;
}
export function projectComponentPropsEqual(previous: ProjectComponentProps, next: ProjectComponentProps) {
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof ProjectComponentProps>) {
    if (key === "tags") continue;
    // Automatic assignments carry per-invocation capture helpers; keep their identity checks.
    if (["inputs", "parameters", "scopedInputs", "templateAncestors"].includes(key)) {
      if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) return false;
    } else if (previous[key] !== next[key]) return false;
  }
  if (previous.tags === next.tags) return true;
  const props = next.component.props;
  const bindings = [...Object.values(props.bindings ?? {}), ...Object.values(props.parameterBindings ?? {}),
  ...Object.values(props.queryBindings ?? {}).flatMap(source => Object.values(source?.parameters ?? {})), ...Object.values(props.dataSource?.parameters ?? {})];
  let sources: unknown[];
  try {
    sources = bindings.filter(binding => binding !== undefined).flatMap(binding => bindingReferenceDependencies(binding, next.component,
      { components: next.components ?? [next.component] }).map(item => item.reference));
  } catch { return false; } // Re-render malformed scopes so their diagnostics remain current.
  const paths = tagDependencyPaths([next.component, sources, isTemplateInstance(next.component.type) || next.component.type === "viewContainer" ? next.templates : []], next.parameters,
    [...new Set([...previous.tags, ...next.tags].map(tag => tag.path))]);
  if (paths === null) return false;
  const before = previous.tags.filter(tag => paths.has(tag.path)), after = next.tags.filter(tag => paths.has(tag.path));
  return before.length === after.length && before.every((tag, index) => tag === after[index]);
}
const MemoProjectComponent = memo(ProjectComponentContents, projectComponentPropsEqual);

function ProjectComponentContents(props: ProjectComponentProps) {
  if (isTemplateInstance(props.component.type) || props.component.type === "viewContainer")
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
  const activity = useComponentActivity();
  const applicationState = useApplicationStateContext();
  const queryProperties = useQueryPropertyContext();
  const styles = useVisualStyles();
  const localization = useLocalization();
  const localized = localizeComponent(props.component, localization.catalog, localization.locale);
  const styled = applyVisualStyle(localized.component, styles, props.inheritedAppearance);
  const authored = props.preview ? applyPythonUiOverrides(styled.component, applicationState) : styled.component;
  const components = props.components ?? [props.component];
  const result = evaluateComponentBindings(authored, {
    components, tags: props.tags, parameters: props.parameters,
    inputs: props.inputs ?? {}, communicationLost: props.communicationLost, state: applicationState?.values,
    queryProperties,
  });
  const diagnostics = componentBindingDiagnostics(props.component, result.errors, styled.error, queryProperties);
  const { errors } = diagnostics;
  const python = usePythonComponentEvents({
    component: props.component, components, parameters: props.parameters,
    identity: JSON.stringify([props.component, props.parameters, props.publishedAt, props.preview, props.queryScope]),
    enabled: props.preview && !props.readOnly, transport: props.onPythonEvent, onAutomaticInputChange: props.onAutomaticInputChange
  });
  const interactionEvents = useComponentEvents({
    component: props.component, evaluated: result.component, components, errors: result.errors,
    parameters: props.parameters, inputs: props.inputs ?? {}, preview: props.preview, scopeKey: props.queryScope, onAutomaticInputChange: props.onAutomaticInputChange, python,
    interactionEnabled: props.preview && !props.readOnly && result.component.props.enabled !== false && result.component.props.visible !== false && errors.length === 0 && !props.interactionLocked
  });
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
  const caption = templateWrapperCaption(appearance, template, applicationState, props.component.id, props.parameters);
  const canInteract = activity && props.preview && enabled && visible && !props.interactionLocked;
  const gate = useRef(false);
  const writeGate = useRef(false);
  gate.current = canInteract;
  writeGate.current = canInteract && !props.readOnly;
  useEffect(() => {
    gate.current = canInteract; writeGate.current = canInteract && !props.readOnly;
    return () => { gate.current = false; writeGate.current = false; };
  }, [canInteract, props.readOnly]);
  const inheritedAppearance = templateInheritedAppearance(appearance);
  const InstanceContents = props.component.type === "viewContainer" ? ContainerInstances : TemplateInstances;
  // Pure presentation does not create a second owner or remount row forms.
  function renderFrame() {
    return <div {...interactionEvents} className={`bound-component template-binding-frame${runtimeHidden ? " bound-component-hidden" : ""}${!visible ? " design-hidden" : ""}${errors.length ? " binding-failed" : ""}`}
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
        <ComponentActivityProvider active={!props.preview || enabled && visible}>
          <InstanceContents {...props} component={view} inheritedAppearance={inheritedAppearance}
            onAutomaticScopedInputChange={props.onAutomaticScopedInputChange ?? props.onScopedInputChange}
            interactionLocked={props.interactionLocked || !enabled || !visible}
            onAction={(leaf, instance, uiAction) => { if (writeGate.current) props.onAction?.(leaf, instance, uiAction); }}
            onTableEdit={canInteract && !props.readOnly && props.onTableEdit ? (leaf, edit, instance) => writeGate.current
              ? props.onTableEdit!(leaf, edit, instance) : Promise.reject(new Error("This template form is no longer interactive.")) : undefined}
            onOpenPopup={(leaf, instance) => { if (gate.current) props.onOpenPopup?.(leaf, instance); }}
            onNavigate={target => { if (gate.current) props.onNavigate(target); }}
            onClosePopup={() => { if (gate.current) props.onClosePopup?.(); }}
            onScopedInputChange={(scope, key, value) => { if (writeGate.current) props.onScopedInputChange?.(scope, key, value); }} />
        </ComponentActivityProvider>
      </div>
      {!props.preview && !visible && <span className="binding-visibility-note">Hidden in runtime</span>}
      {localized.warning && <span className="component-localization-note" role="status" title={localized.warning}>{localized.warning}</span>}
      {renderBindingDiagnostics(diagnostics)}
    </div>;
  }
  return renderFrame();
}

function templateWrapperCaption(appearance: CanvasComponent["props"], template: Template | undefined, state: ReturnType<typeof useApplicationStateContext>, componentId: string, parameters: RuntimeParameters): string {
  if (appearance.bindings?.text || appearance.queryBindings?.text || Object.hasOwn(state?.propertyOverrides[componentId] ?? {}, "text")) return appearance.text ?? "";
  return resolvePath(appearance.text || template?.name || "Template instance", parameters);
}

function templateInheritedAppearance(appearance: CanvasComponent["props"]): InheritedComponentAppearance {
  const inherited: InheritedComponentAppearance = {};
  for (const key of ["color", "backgroundColor", "foregroundColor", "fontSize"] as const)
    if (appearance[key] !== undefined) Object.assign(inherited, { [key]: appearance[key] });
  return inherited;
}

function ContainerInstances(props: TemplateInstanceProps) {
  const activity = useComponentActivity();
  const layout = props.component.props.viewLayout;
  let error = viewLayoutError(layout, props.templates) || templateExpansion([props.component], props.templates ?? [], props.templateAncestors).error;
  const contexts = new Map<string, RuntimeParameters>();
  if (!error && layout) for (const pane of layout.panes) {
    const template = props.templates!.find(item => item.id === pane.templateId)!;
    try { contexts.set(pane.id, templateParameters(template, props.parameters, pane.parameters)); }
    catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  }
  if (error || !layout) return <div className="template-placeholder query-repeater-error" role="status"><strong>View container unavailable</strong><span>{error || "Configure the container panes in Properties."}</span></div>;
  return <ViewContainer layout={layout} interactive={activity && props.preview && !props.interactionLocked}
    boundProperties={[...Object.keys(props.component.props.bindings ?? {}), ...Object.keys(props.component.props.queryBindings ?? {})]}
    renderPane={(pane, active) => <ComponentActivityProvider active={active}><ContainerPane {...props} pane={pane} context={contexts.get(pane.id)!} /></ComponentActivityProvider>} />;
}

function ContainerPane(props: TemplateInstanceProps & { pane: ViewPane; context: RuntimeParameters }) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: props.component.width, height: props.component.height });
  const template = props.templates!.find(item => item.id === props.pane.templateId)!;
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const resize = () => { if (element.clientWidth && element.clientHeight) setSize({ width: element.clientWidth, height: element.clientHeight }); };
    resize(); const observer = new ResizeObserver(resize); observer.observe(element); return () => observer.disconnect();
  }, []);
  const key = JSON.stringify([props.pane.id, props.pane.templateId, props.context, template.parameters, template.parameterTypes, template.instanceState, props.publishedAt]);
  return <div className="view-pane-placement" ref={host}><TemplateInstanceCell {...props} key={key}
    component={panePlacement(props.component, props.pane)} template={template} row={{ id: props.pane.id, parameters: {} }}
    parentBindingInputs={props.parentBindingInputs ? [...props.parentBindingInputs, {}] : undefined}
    parentBindingState={props.parentBindingState ? [...props.parentBindingState, {}] : undefined}
    dynamic={false} dynamicAncestor scale={Math.min(size.width / template.width, size.height / template.height)} cellHeight={size.height} />
  </div>;
}

function TemplateInstances(props: TemplateInstanceProps) {
  const queryProperties = useQueryPropertyContext();
  const activity = useComponentActivity();
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
  const bindings = templateInstanceBindings(props, template, applicationState, queryProperties);
  const { boundParameters, bindingError, boundAncestor, parentBindingInputs, hasStateSource, parentBindingState } = bindings;
  const queryRows = useQueryRepeater(activity && repeating && !expansionError && !bindingError ? component.props.rowsSource : undefined, template,
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
  if (!template || expansionError) return renderMissingTemplate(repeating, preview, expansionError);
  const { rowError, resolvedRows } = resolvedTemplateRows(component, template, parameters, boundParameters, repeating, queryBacked, queryRows, bindingError);
  const { columns, gap, scale, cellHeight } = templateInstanceLayout(component, template, availableSize, repeating);
  function renderInstances() {
    return (
      <div
        className={`template-instance-host ${repeating ? "is-repeater" : "is-template"} ${preview ? "" : "template-authoring"}`}
        ref={host}
        aria-label={component.props.text || (repeating ? `${template!.name} repeater` : template!.name)}
      >
        {!resolvedRows.length && renderEmptyTemplate(repeating, queryBacked, queryRows.loading, rowError)}
        {queryBacked && queryRows.loading && resolvedRows.length > 0 && <span className="query-repeater-refresh" role="status">Refreshing rows…</span>}
        <div className="template-instance-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap, gridAutoRows: cellHeight }}>
          {resolvedRows.map(({ row, context }) => {
            // Saved rows have no query owner. A dormant query key must not reset their edits.
            const queryContext = JSON.stringify([props.screenId, component.id, component.type, props.parentPath, preview, publishedAt, queryBacked ? queryRows.key : undefined,
            component.props.parameterBindings, boundAncestor ? parentBindingInputs : undefined, hasStateSource ? parentBindingState : undefined, template!.instanceState]);
            const key = queryRowFormKey(queryContext, row ?? { id: "single", parameters: {} }, template!, context);
            return <TemplateInstanceCell {...props} key={key}
              parentBindingInputs={boundAncestor ? parentBindingInputs : undefined}
              parentBindingState={hasStateSource ? parentBindingState : undefined}
              template={template!} row={row} context={context} dynamic={queryBacked} scale={scale} cellHeight={cellHeight} />;
          })}
        </div>
      </div>
    );
  }
  return renderInstances();
}

function templateInstanceBindings(props: TemplateInstanceProps, template: Template | undefined, state: ReturnType<typeof useApplicationStateContext>, queryProperties: ReturnType<typeof useQueryPropertyContext>) {
  const { component, parameters, communicationLost = false } = props;
  let boundParameters: RuntimeParameters = {}, bindingError = "", bindingInputs: InputValues = {}, bindingState: ParameterBindingState = {};
  try {
    if (template) {
      boundParameters = resolveParameterBindings(component, template, {
        components: props.components ?? [component], tags: props.tags, parameters, inputs: props.inputs ?? {}, state: state?.values, communicationLost, queryProperties,
      });
      bindingInputs = parameterBindingInputs(component, props.inputs ?? {}, props.components);
      bindingState = parameterBindingState(component, state?.values, props.components);
    }
  } catch (reason) { bindingError = reason instanceof Error ? reason.message : String(reason); }
  const hasBindings = Object.keys(component.props.parameterBindings ?? {}).length > 0;
  const boundAncestor = hasBindings || Boolean(props.parentBindingInputs);
  // Snapshot only inputs actually used at each path step; never capture an
  // unrelated password field or confuse the caller form with the child form.
  const parentBindingInputs = [...(props.parentBindingInputs ?? (props.parentPath ?? []).map(() => ({}))), bindingInputs];
  const hasStateSource = Object.keys(bindingState).length > 0 || Boolean(props.parentBindingState);
  const parentBindingState = [...(props.parentBindingState ?? (props.parentPath ?? []).map(() => ({}))), bindingState];
  return { boundParameters, bindingError, boundAncestor, parentBindingInputs, hasStateSource, parentBindingState };
}

function renderMissingTemplate(repeating: boolean, preview: boolean, error: string | undefined) {
  return <div className="template-placeholder query-repeater-error" role="status">
    <Icon name="layers" size={27} />
    <strong>{repeating ? "Template repeater" : "Embedded template"}</strong>
    <span>{error || (preview ? "The referenced template is unavailable." : "Choose a template in Properties.")}</span>
  </div>;
}

function templateRows(component: CanvasComponent, repeating: boolean, queryBacked: boolean, queryRows: ReturnType<typeof useQueryRepeater>, error: string | undefined): (TemplateRow | ResolvedTemplateRow | undefined)[] {
  if (error) return [];
  if (!repeating) return [undefined];
  return queryBacked ? queryRows.rows : component.props.rows || [];
}

function resolvedTemplateRows(component: CanvasComponent, template: Template, parameters: RuntimeParameters, boundParameters: RuntimeParameters, repeating: boolean, queryBacked: boolean, queryRows: ReturnType<typeof useQueryRepeater>, bindingError: string) {
  let rowError = bindingError || (queryBacked && component.props.rows?.length
    ? "Choose saved rows or a named query, not both."
    : queryRows.error);
  const rows = templateRows(component, repeating, queryBacked, queryRows, rowError);
  // Resolve the full set before rendering any child. One bad row must not leave
  // a partially actionable collection of forms on screen.
  let resolvedRows: { row: TemplateRow | ResolvedTemplateRow | undefined; context: RuntimeParameters }[] = [];
  try {
    resolvedRows = rows.map(row => ({
      row, context: queryBacked
        ? queryTemplateParameters(template, parameters, component.props.parameters, row?.parameters, boundParameters)
        : templateParameters(template, parameters, component.props.parameters, row?.parameters as Record<string, string> | undefined, boundParameters)
    }));
  } catch (reason) { rowError = reason instanceof Error ? reason.message : String(reason); }
  return { rowError, resolvedRows };
}

function templateInstanceLayout(component: CanvasComponent, template: Template, availableSize: { width: number; height: number }, repeating: boolean) {
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
  return { columns, gap, scale, cellHeight };
}

function renderEmptyTemplate(repeating: boolean, queryBacked: boolean, loading: boolean, error: string | undefined) {
  return <div className={`template-placeholder${error ? " query-repeater-error" : ""}`} role="status">
    <Icon name={error ? "info" : "layers"} size={27} />
    <strong>{error ? repeating ? "Rows unavailable" : "Parameters unavailable" : queryBacked ? loading ? "Loading rows…" : "No matching rows" : "No rows configured"}</strong>
    <span>{error || (queryBacked ? loading ? "Reading the configured named query." : "The query returned no records. Rows refresh automatically." : "Add saved rows in the repeater’s properties.")}</span>
  </div>;
}

/** Dynamic rows own their edits. A changed key remounts just that form, and a removed row releases it. */
function TemplateInstanceCell({ component, templates, template, row, context, dynamic, scale, cellHeight, screenId, tags,
  scopedInputs = {}, onScopedInputChange, onAutomaticScopedInputChange, communicationLost = false, preview, queryScope, publishedAt,
  onNavigate, onAction, onPythonEvent, onTableEdit, onOpenPopup, onClosePopup, actionBusyId, interactionLocked, inheritedAppearance, readOnly,
  parentPath = [], templateAncestors = [], dynamicAncestor = false,
  querySourceParameters, parentBindingInputs, parentBindingState, parentParameterScopes,
}: TemplateInstanceProps & { template: Template; row?: TemplateRow | ResolvedTemplateRow; context: RuntimeParameters; dynamic: boolean; scale: number; cellHeight: number }) {
  const activity = useComponentActivity();
  const parentApplicationState = useApplicationStateContext();
  const activityLifetime = useRef({ active: activity, epoch: 0 });
  if (activityLifetime.current.active !== activity) { activityLifetime.current.active = activity; activityLifetime.current.epoch++; }
  const activityEpoch = activityLifetime.current.epoch;
  const [localInputs, setLocalInputs] = useState<InputValues>({});
  const path: InstancePathStep[] = [...parentPath, { instanceId: component.id, ...(row ? { rowId: row.id } : {}) }];
  const scope = instanceInputKey(screenId, path);
  const applicationState = useInstanceApplicationState(parentApplicationState, scope, template.instanceState);
  const local = dynamic || dynamicAncestor || Boolean(parentBindingInputs) || template.instanceState !== undefined;
  const queryParameters = dynamic ? context : querySourceParameters;
  const sourceParameterScopes = [...(parentParameterScopes ?? []), context];
  const active = activity && preview && !interactionLocked && !readOnly;
  const inputGate = useRef(false);
  const lifetime = useRef(true);
  useEffect(() => { lifetime.current = true; return () => { lifetime.current = false; }; }, []);
  inputGate.current = active;
  useEffect(() => { inputGate.current = active; return () => { inputGate.current = false; }; }, [active]);
  const form = useFormInputs({
    document: template, tags, parameters: context, edits: local ? localInputs : scopedInputs[scope],
    communicationLost, state: applicationState, active, contextKey: JSON.stringify([scope, publishedAt]),
    onEdit: (key, value, automatic) => {
      if (local) setLocalInputs(previous => ({ ...previous, [key]: value }));
      else (automatic ? onAutomaticScopedInputChange : onScopedInputChange)?.(scope, key, value);
    }
  });
  const inputs = form.inputs;
  const queryProperties = useQueryPropertyBindings(template.components,
    { components: template.components, tags, parameters: context, inputs, communicationLost, state: applicationState?.values },
    { state: applicationState, scope: queryScope ?? "designer", publishedAt, active: preview && activity });
  const instance: InstanceAction = {
    ...path[0], ...(path.length > 1 ? { instancePath: path } : {}), template, parameters: context, inputs,
    sourceParameterScopes,
    ...(queryParameters ? { querySourceParameters: queryParameters } : {}),
    ...(parentBindingInputs ? { bindingInputs: parentBindingInputs.map(values => ({ ...values })) } : {}),
    ...(parentBindingState ? { bindingState: structuredClone(parentBindingState) } : {}),
    isCurrent: () => lifetime.current && activityLifetime.current.active && activityLifetime.current.epoch === activityEpoch,
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
              ...componentGeometry(leaf, { components: template.components, tags, parameters: context, inputs, communicationLost, state: applicationState?.values, queryProperties }, preview),
              "--component-accent":
                leaf.props.color || "var(--accent)",
              "--component-foreground": leaf.props.color
                ? "#ffffff"
                : "var(--on-accent)",
            } as CSSProperties
          }
        >
          {isTemplateInstance(leaf.type) || leaf.type === "viewContainer" ? (
            <BoundTemplateInstance component={leaf} components={template.components} templates={templates} screenId={screenId}
              parameters={context} inputs={inputs} scopedInputs={scopedInputs} tags={tags} preview={preview}
              onAutomaticInputChange={form.assignAutomatic}
              parentPath={path} templateAncestors={[...templateAncestors, template.id]} dynamicAncestor={local}
              querySourceParameters={queryParameters}
              parentBindingInputs={parentBindingInputs}
              parentBindingState={parentBindingState}
              parentParameterScopes={sourceParameterScopes}
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
              onNavigate={target => { if (activity && !interactionLocked) onNavigate(target); }}
              onInputChange={form.assign}
              onAutomaticInputChange={form.assignAutomatic}
              onAction={(_component, uiAction) => { if (lifetime.current && inputGate.current) onAction?.(leaf, instance, uiAction); }}
              onPythonEvent={onPythonEvent ? (target, invocation) => (lifetime.current || isPythonUnmount(invocation.eventHandler)) && !readOnly
                ? onPythonEvent(target, invocation, instance) : Promise.reject(new Error("This template event owner has closed.")) : undefined}
              onTableEdit={onTableEdit ? edit => lifetime.current && inputGate.current ? onTableEdit(leaf, edit, instance)
                : Promise.reject(new Error("This template form is no longer interactive.")) : undefined}
              onOpenPopup={() => { if (lifetime.current && activity && !interactionLocked) onOpenPopup?.(leaf, instance); }}
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
