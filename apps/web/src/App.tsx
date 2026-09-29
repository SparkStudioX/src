import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { api, currentProjectId, displayValue, eventStreamUrl, id, projectPage, projectStorageKey, resolvePath } from "./api";
import { useAuth } from "./Auth";
import { ApplicationStateProvider, useApplicationState, useApplicationStateContext } from "./applicationState";
import { SessionIdentity } from "./OperatorAccess";
import { AccountSettingsDialog } from "./AccountSettings";
import { ProjectImportDialog } from "./Projects";
import { exportProjectPackage } from "./projectManagement";
import Icon, { iconNames } from "./Icon";
import AssetPicker from "./Assets";
import Popup from "./Popup";
import { createPopup, screenParameters } from "./popupModel";
import type {
  CanvasComponent,
  Asset,
  ComponentType,
  Connection,
  Health,
  InputValue,
  InputValues,
  InstanceAction,
  NamedQuery,
  Project,
  PopupState,
  Publication,
  RuntimeParameters,
  Screen,
  ScriptResult,
  Tag,
  Template,
} from "./types";
import Connections from "./Connections";
import Queries from "./Queries";
const Scripts = lazy(() => import("./Scripts"));
import {
  actionKey,
  isTemplateInstance,
  ProjectComponentView,
  projectInputContext,
} from "./templates";
import { resolveTemplateParameters, templatePlacementError } from "./templateModel";
import Tags from "./Tags";
import { isInput, validateInputs } from "./inputs";
import { useFormInputs } from "./inputStateBindings";
import { alignSelected, arrangementCount, checkpoint, distributeSelected, duplicateSelected, expandGroupSelection, groupSelected, marqueeBounds, marqueeSelection, matchSelectedSize, moveSelected, parseGridSize, projectContent, resizeComponent, resizeGroup, restoreHistory, selectComponentType, selectionBounds, toggleGroupSelection, ungroupSelected } from "./canvasEditing";
import type { MatchingSize, ProjectHistory, SelectionBounds } from "./canvasEditing";
import ComponentEventEditor from "./ComponentEventEditor";
import ComponentLifecycleEditor from "./ComponentLifecycleEditor";
import { ComponentEventDiagnostics } from "./ComponentEvents";
import InputEventsEditor from "./InputEventsEditor";
import { componentGeometry } from "./propertyBindings";
import { PropertyBindingsEditor } from "./PropertyBindingsEditor";
import { QueryPropertyProvider, useQueryPropertyBindings } from "./useQueryPropertyBindings";
import { DocumentProperties, ProjectSettingsDialog } from "./DocumentProperties";
import { StateControlEditor } from "./StateControlEditor";
import { ListTreeOptionsEditor, TablePageSizeEditor } from "./ListTreeOptionsEditor";
import { TableColumnsEditor } from "./TableColumnsEditor";
import { TableEditingEditor } from "./TableEditingEditor";
import { isProcessDisplay } from "./processDisplays";
import { isDrawingComponent } from "./drawingComponents";
import { DrawingEditor } from "./DrawingEditor";
import { reconcileNavigationAfterScreenChange } from "./runtimeNavigation";
import { closeDesignerDocument, documentKey, openDesignerDocument, restoreDesignerDocuments } from "./designerDocuments";
import type { DesignerDocument, DesignerDocuments } from "./designerDocuments";
import ProjectNavigation from "./ProjectNavigation";
import ProjectSearch from "./ProjectSearchDialog";
import { buildProjectSearch } from "./projectSearch";
import type { ScriptSearchResource, SearchTarget } from "./projectSearch";
import ResourceChangeDialog from "./ResourceChangeDialog";
import { applyResourceChange, planResourceChange } from "./resourceChanges";
import type { ResourceChangeRequest } from "./resourceChanges";
import BulkReplaceDialog from "./BulkReplaceDialog";
import { applyBulkReplacement } from "./bulkReplacement";
import { useDesignerPanes } from "./useDesignerPanes";
import "./canvasEditing.css";
import { VisualStyleProvider } from "./VisualStyleContext";
import { LocalizationProvider, useLocaleSelection, LocaleSelector } from "./LocalizationContext";
import TranslationsEditor, { ComponentTranslationAssignment } from "./TranslationsEditor";
import { applyLocalizationCatalog } from "./localization";
import { DesignerDiagnostics } from "./DesignerDiagnosticsDialog";
import VisualStylesEditor, { ComponentStyleAssignment } from "./VisualStylesEditor";
import { applyStyleCatalog } from "./visualStyles";
import { usePreviewCommunication } from "./usePreviewCommunication";
import { PreviewControls } from "./PreviewControls";
import PublicationHistoryDialog from "./PublicationHistoryDialog";
import { newDocumentDimensions, projectAuthoringDefaults } from "./authoringDefaults";
import AssetLibraryDialog from "./AssetLibraryDialog";
import { applyAssetReplacement } from "./assetLibrary";
import "./designerDocuments.css";

type Workspace = "designer" | "tags" | "connections" | "queries" | "scripts";
type Toast = { message: string; error?: boolean };
const palettes: { type: ComponentType; name: string; hint: string }[] = [
  { type: "label", name: "Text", hint: "Headings & labels" },
  { type: "value", name: "Value", hint: "A live tag value" },
  { type: "gauge", name: "Gauge", hint: "Value in a range" },
  { type: "ledDisplay", name: "LED display", hint: "Show a numeric readout" },
  { type: "progressBar", name: "Progress bar", hint: "Show progress within a range" },
  { type: "cylindricalTank", name: "Cylindrical tank", hint: "Show vessel fill level" },
  { type: "levelIndicator", name: "Level indicator", hint: "Show a scaled process level" },
  { type: "thermometer", name: "Thermometer", hint: "Show a temperature range" },
  { type: "line", name: "Line", hint: "Connect two drawing points" },
  { type: "rectangle", name: "Rectangle", hint: "Draw a filled or outlined box" },
  { type: "ellipse", name: "Ellipse", hint: "Draw a filled or outlined oval" },
  { type: "polyline", name: "Polyline", hint: "Draw a route with editable points" },
  { type: "pipe", name: "Pipe", hint: "Show a route and its flow state" },
  { type: "equipmentSymbol", name: "Equipment symbol", hint: "Place a pump, valve, or motor" },
  { type: "button", name: "Button", hint: "Screen navigation" },
  { type: "table", name: "Table", hint: "Named query results" },
  { type: "image", name: "Image", hint: "Local photos & diagrams" },
  { type: "icon", name: "Icon", hint: "Built-in symbols" },
  { type: "textInput", name: "Text box", hint: "Enter text" },
  { type: "passwordInput", name: "Password field", hint: "Mask a form value" },
  { type: "numberInput", name: "Number input", hint: "Enter a numeric value" },
  { type: "checkbox", name: "Check box", hint: "Choose true or false" },
  { type: "select", name: "Dropdown", hint: "Choose an option" },
  { type: "list", name: "List", hint: "Select from visible choices" },
  { type: "treeView", name: "Tree view", hint: "Browse and select a hierarchy" },
  { type: "textArea", name: "Text area", hint: "Multiline notes" },
  { type: "spinner", name: "Spinner", hint: "Step a numeric value" },
  { type: "slider", name: "Slider", hint: "Choose a value in a range" },
  { type: "radioGroup", name: "Radio group", hint: "Choose one option" },
  { type: "dateTimeInput", name: "Date / time", hint: "Local date and time" },
  { type: "toggle", name: "Toggle", hint: "Switch a form value" },
  { type: "multiStateButton", name: "Multi-state button", hint: "Stage a choice with segments" },
  { type: "multiStateIndicator", name: "Multi-state indicator", hint: "Show a state's label and color" },
  { type: "template", name: "Template", hint: "Reuse a saved form" },
  {
    type: "repeater",
    name: "Repeater",
    hint: "Repeat a template for saved rows",
  },
];
const typeIcon: Record<ComponentType, string> = {
  label: "text",
  value: "value",
  gauge: "gauge",
  ledDisplay: "led-display",
  progressBar: "progress-bar",
  cylindricalTank: "cylindrical-tank",
  levelIndicator: "level-indicator",
  thermometer: "thermometer",
  line: "drawing-line",
  rectangle: "drawing-rectangle",
  ellipse: "drawing-ellipse",
  polyline: "drawing-polyline",
  pipe: "drawing-pipe",
  equipmentSymbol: "equipment-symbol",
  button: "button",
  table: "table",
  textInput: "text",
  passwordInput: "shield",
  numberInput: "value",
  checkbox: "check",
  select: "down",
  list: "list",
  treeView: "tree",
  textArea: "text",
  spinner: "value",
  slider: "settings",
  radioGroup: "layers",
  dateTimeInput: "clock",
  toggle: "check",
  multiStateButton: "layers",
  multiStateIndicator: "activity",
  template: "layers",
  repeater: "grid",
  image: "monitor",
  icon: "spark",
};
const acceptsInitialTag = (type: ComponentType) => type === "value" || type === "gauge" || isProcessDisplay(type) || isInput(type) && type !== "passwordInput";
function tagBindingPatch(component: CanvasComponent, path: string): CanvasComponent["props"] {
  return isProcessDisplay(component.type)
    ? { bindings: { ...component.props.bindings, value: { expression: "tagValue", references: { tagValue: { kind: "tag", path } } } } }
    : { tagPath: path };
}
const processDimensions: Partial<Record<ComponentType, { width: number; height: number }>> = {
  ledDisplay: { width: 280, height: 100 }, progressBar: { width: 340, height: 100 },
  cylindricalTank: { width: 180, height: 260 }, levelIndicator: { width: 140, height: 260 }, thermometer: { width: 140, height: 280 },
  line: { width: 240, height: 80 }, rectangle: { width: 220, height: 140 }, ellipse: { width: 180, height: 140 },
  polyline: { width: 260, height: 180 }, pipe: { width: 300, height: 100 }, equipmentSymbol: { width: 160, height: 140 },
};

function UnsavedProjectNavigation({ onStay, onDiscard }: { onStay: () => void; onDiscard: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="project-dialog" aria-labelledby="unsaved-navigation-title" aria-describedby="unsaved-navigation-description" onCancel={event => { event.preventDefault(); onStay(); }} onKeyDown={event => event.stopPropagation()}>
    <header><div className="eyebrow">UNSAVED CHANGES</div><h2 id="unsaved-navigation-title">Leave this project?</h2></header>
    <div className="project-dialog-body"><p id="unsaved-navigation-description">You have unsaved project, named-query or script edits. Switching projects will discard these edits. Stay in Designer to save your work first.</p></div>
    <footer><button className="button" autoFocus onClick={onStay}>Stay in Designer</button><button className="button project-archive-button" onClick={onDiscard}>Discard and switch</button></footer>
  </dialog>;
}

export default function App() {
  const { gatewayAdmin, permissions } = useAuth();
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace>("designer");
  const [scriptsVisited, setScriptsVisited] = useState(false);
  const [queriesVisited, setQueriesVisited] = useState(false);
  const [scriptsDirty, setScriptsDirty] = useState(false);
  const [queriesDirty, setQueriesDirty] = useState(false);
  const [packageExporting, setPackageExporting] = useState(false);
  const [projectImportOpen, setProjectImportOpen] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [stylesEditorOpen, setStylesEditorOpen] = useState(false);
  const [translationsOpen, setTranslationsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [publicationHistoryOpen, setPublicationHistoryOpen] = useState(false);
  const [assetLibraryOpen, setAssetLibraryOpen] = useState(false);
  const previewCommunication = usePreviewCommunication();
  const [searchOpen, setSearchOpen] = useState(false);
  const [bulkReplaceFind, setBulkReplaceFind] = useState<string | null>(null);
  const [searchQueries, setSearchQueries] = useState<NamedQuery[] | null>(null);
  const [searchScripts, setSearchScripts] = useState<ScriptSearchResource[]>([]);
  const [scriptsEditorReady, setScriptsEditorReady] = useState(false);
  const [searchScriptsLoading, setSearchScriptsLoading] = useState(false);
  const [searchScriptsError, setSearchScriptsError] = useState("");
  const [queryNavigation, setQueryNavigation] = useState<{ id: string; token: number }>();
  const [scriptNavigation, setScriptNavigation] = useState<{ id: string; token: number }>();
  const [searchNavigation, setSearchNavigation] = useState<SearchTarget | null>(null);
  const [searchLocation, setSearchLocation] = useState<SearchTarget | null>(null);
  const searchNavigationToken = useRef(0);
  const [resourceChangeContext, setResourceChangeContext] = useState<{ project: Project; queries: NamedQuery[]; scripts: ScriptSearchResource[]; request: ResourceChangeRequest } | null>(null);
  const [resourceChangeLoading, setResourceChangeLoading] = useState(false);
  const [resourceChangeError, setResourceChangeError] = useState("");
  const resourceChangeEpoch = useRef(0);
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null);
  const discardNavigation = useRef(false);
  useEffect(() => {
    if (workspace === "scripts") setScriptsVisited(true);
    if (workspace === "queries") setQueriesVisited(true);
  }, [workspace]);
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(() => {
    try {
      return (
        localStorage.getItem("sparkstudio.workspaceCollapsed.v1") === "true"
      );
    } catch {
      return false;
    }
  });
  const [project, setProject] = useState<Project | null>(null);
  const projectLocale = useLocaleSelection(project);
  const [tags, setTags] = useState<Tag[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [queries, setQueries] = useState<NamedQuery[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [previewPopup, setPreviewPopup] = useState<PopupState | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [documents, setDocuments] = useState<DesignerDocuments>({ open: [], active: null });
  const activeDocument = documents.open.find(document => documentKey(document) === documents.active);
  const screenId = activeDocument?.kind === "screen" ? activeDocument.id : "";
  const editingTemplateId = activeDocument?.kind === "template" ? activeDocument.id : null;
  const [selectionIds, setSelectedIds] = useState<string[]>([]);
  const setSelectedId = useCallback((value: string | null) => { setSearchLocation(null); setSelectedIds(value ? [value] : []); }, []);
  const [gridSize, setGridSize] = useState(8);
  const [gridDraft, setGridDraft] = useState("8");
  const gridProject = useRef<string | null>(null);
  useEffect(() => {
    if (project && gridProject.current !== project.id) {
      gridProject.current = project.id;
      const size = projectAuthoringDefaults(project).gridSize;
      setGridSize(size); setGridDraft(String(size));
    }
  }, [project]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publication, setPublication] = useState<Publication | null>(null);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    if (workspace !== "designer" && (preview || previewCommunication.session)) {
      setPreview(false); setPreviewPopup(null);
      void previewCommunication.stop().catch(() => {});
    }
  }, [workspace, preview, previewCommunication.session, previewCommunication.stop]);
  const designerPanes = useDesignerPanes(Boolean(project) && workspace === "designer" && !preview);
  const [previewInputs, setPreviewInputs] = useState<
    Record<string, InputValues>
  >({});
  const [previewActionBusy, setPreviewActionBusy] = useState("");
  const [leftTab, setLeftTab] = useState<"project" | "components" | "tags">("project");
  const [tagFilter, setTagFilter] = useState("");
  const [tagSelection, setTagSelection] = useState<Tag | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [loadError, setLoadError] = useState("");
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState("");
  const [history, setHistory] = useState<ProjectHistory>({ past: [], future: [] });
  const historyRef = useRef(history);
  const savedContentRef = useRef("");
  const savingRef = useRef(false);
  const [eventEditorId, setEventEditorId] = useState<string | null>(null);
  const [inputEventEditorId, setInputEventEditorId] = useState<string | null>(null);
  const [lifecycleEventEditorId, setLifecycleEventEditorId] = useState<string | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const updateHistory = useCallback((next: ProjectHistory) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  const notify = useCallback(
    (message: string, error = false) => setToast({ message, error }),
    [],
  );
  const receiveSearchScripts = useCallback((resources: ScriptSearchResource[]) => {
    setSearchScripts(resources); setSearchScriptsLoading(false); setSearchScriptsError("");
  }, []);
  const receiveScriptDraft = useCallback((resources: ScriptSearchResource[]) => {
    setScriptsEditorReady(true); receiveSearchScripts(resources);
  }, [receiveSearchScripts]);
  useEffect(() => {
    if (!searchOpen || scriptsEditorReady) return;
    let active = true;
    setSearchScriptsLoading(true); setSearchScriptsError("");
    void api<{ resources: ScriptSearchResource[] }>("/scripts/resources")
      .then(value => { if (active) setSearchScripts(value.resources); })
      .catch(reason => { if (active) { setSearchScripts([]); setSearchScriptsError(reason instanceof Error ? reason.message : String(reason)); } })
      .finally(() => { if (active) setSearchScriptsLoading(false); });
    return () => { active = false; };
  }, [searchOpen, scriptsEditorReady]);
  const searchEntries = useMemo(() => project ? buildProjectSearch(project, searchQueries ?? queries, searchScripts) : [], [project, queries, searchQueries, searchScripts]);
  const resourceChangePlan = useMemo(() => resourceChangeContext ? planResourceChange(resourceChangeContext.project, resourceChangeContext.queries, resourceChangeContext.scripts, resourceChangeContext.request) : null, [resourceChangeContext]);
  const closeResourceChange = () => { resourceChangeEpoch.current++; setResourceChangeContext(null); setResourceChangeLoading(false); setResourceChangeError(""); };
  const previewResourceChange = (request: ResourceChangeRequest) => {
    const current = projectRef.current;
    if (!current || previewActionBusy) return;
    const epoch = ++resourceChangeEpoch.current;
    const context = { project: current, queries: searchQueries ?? queries, scripts: searchScripts, request };
    setResourceChangeContext(context); setResourceChangeError("");
    if (scriptsEditorReady) { setResourceChangeLoading(false); return; }
    // Load the script inventory without mounting or executing the scripting workspace.
    setResourceChangeLoading(true);
    void api<{ resources: ScriptSearchResource[] }>("/scripts/resources")
      .then(value => {
        if (resourceChangeEpoch.current !== epoch) return;
        receiveSearchScripts(value.resources);
        setResourceChangeContext(previous => previous && ({ ...previous, scripts: value.resources }));
      })
      .catch(reason => { if (resourceChangeEpoch.current === epoch) setResourceChangeError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (resourceChangeEpoch.current === epoch) setResourceChangeLoading(false); });
  };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && project && !previewActionBusy && !document.querySelector("dialog[open]")) {
        if (event.key.toLowerCase() === "f") { event.preventDefault(); setSearchOpen(true); }
        if (event.key.toLowerCase() === "h") { event.preventDefault(); setBulkReplaceFind(""); }
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [project, previewActionBusy]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 6500);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const [nextProject, nextTags, nextConnections, nextQueries, nextHealth] =
        await Promise.all([
          api<Project>("/project"),
          api<Tag[]>("/tags"),
          gatewayAdmin ? api<Connection[]>("/connections") : Promise.resolve([]),
          api<NamedQuery[]>("/queries"),
          api<Health>("/health"),
        ]);
      setProject(nextProject);
      projectRef.current = nextProject;
      savedContentRef.current = projectContent(nextProject);
      let savedTabs: unknown;
      try { savedTabs = JSON.parse(localStorage.getItem(projectStorageKey("sparkstudio.designerTabs.v1")) || "null"); } catch { /* Start with the first screen if local preferences are unavailable. */ }
      setDocuments(restoreDesignerDocuments(nextProject, savedTabs));
      setPreviewInputs({});
      setPreviewPopup(null);
      setTags(nextTags);
      setConnections(nextConnections);
      setQueries(nextQueries);
      setHealth(nextHealth);
      setConnected(true);
      setDirty(false);
      updateHistory({ past: [], future: [] });
      setEventEditorId(null);
      setInputEventEditorId(null);
      setLifecycleEventEditorId(null);
      setSelectedId(null);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "Unable to connect to the gateway.",
      );
      setConnected(false);
    }
  }, [updateHistory, gatewayAdmin]);
  useEffect(() => {
    void load();
    void api<Publication>("/project/publication")
      .then(setPublication)
      .catch(() => {});
    void api<Asset[]>("/assets")
      .then(setAssets)
      .catch(() => {});
  }, [load]);
  useEffect(() => {
    const events = new EventSource(eventStreamUrl());
    const receive = (event: MessageEvent) => {
      try {
        const next = JSON.parse(event.data) as Tag[];
        if (Array.isArray(next)) {
          setTags(next);
          setConnected(true);
          setLastUpdate(new Date().toLocaleTimeString());
        }
      } catch {
        /* Polling recovers malformed or interrupted events. */
      }
    };
    events.addEventListener("tags", receive);
    events.onerror = () => setConnected(false);
    const polling = setInterval(() => {
      void api<Tag[]>("/tags")
        .then((next) => {
          setTags(next);
          setConnected(true);
          setLastUpdate(new Date().toLocaleTimeString());
        })
        .catch(() => setConnected(false));
    }, 4000);
    return () => {
      events.close();
      clearInterval(polling);
    };
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!discardNavigation.current && (dirty || queriesDirty || scriptsDirty)) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, queriesDirty, scriptsDirty]);
  useEffect(() => {
    if (!project) return;
    setDocuments(current => {
      const next = restoreDesignerDocuments(project, current);
      return JSON.stringify(current) === JSON.stringify(next) ? current : next;
    });
  }, [project]);
  useEffect(() => {
    if (!project) return;
    try { localStorage.setItem(projectStorageKey("sparkstudio.designerTabs.v1"), JSON.stringify(documents)); } catch { /* Editor preferences are optional. */ }
  }, [documents, project]);
  const openDocument = (document: DesignerDocument) => {
    if (previewActionBusy) return;
    setDocuments(current => openDesignerDocument(current, document));
    setSelectedId(null);
    setPreviewPopup(null);
    setToast(null);
  };
  const closeDocument = (document: DesignerDocument) => {
    if (previewActionBusy) return;
    setDocuments(current => closeDesignerDocument(current, documentKey(document)));
    if (documentKey(document) === documents.active) {
      setSelectedId(null);
      setPreviewPopup(null);
      setToast(null);
    }
  };

  const editingTemplate = project?.templates?.find(
    (item) => item.id === editingTemplateId,
  );
  const availableTemplates = (project?.templates ?? []).filter(item => !editingTemplate || !templatePlacementError(project?.templates ?? [], editingTemplate.id, item.id));
  const screen =
    editingTemplate ||
    project?.screens.find((item) => item.id === screenId);
  const applicationState = useApplicationState(project, screen,
    JSON.stringify([project?.id, project?.revision, preview, previewCommunication.session?.token, workspace === "designer"]),
    editingTemplate ? editingTemplate.instanceState ?? {} : undefined);
  const templateContext = editingTemplate && project ? resolveTemplateParameters(editingTemplate, project.parameters) : undefined;
  const editorParameterError = templateContext?.error;
  // Keep authored parameter names available to repair a broken template. This
  // fallback is authoring-only: no preview subtree or action uses this context.
  const editorParameters: RuntimeParameters = project
    ? editingTemplate
      ? templateContext?.parameters || { ...project.parameters, ...editingTemplate.parameters }
      : screen
        ? screenParameters(screen, project.parameters)
        : project.parameters
    : {};
  const selectedIds = expandGroupSelection(screen?.components || [], selectionIds);
  const inspectingSearchComponent = searchLocation !== null && searchLocation.id === screen?.id && searchLocation.kind === (editingTemplateId ? "template" : "screen") && selectionIds.length === 1 && searchLocation.componentId === selectionIds[0];
  const selectedId = inspectingSearchComponent ? selectionIds[0] : selectedIds.length === 1 ? selectedIds[0] : null;
  const selected = screen?.components.find(
    (component) => component.id === selectedId,
  );
  const selection = screen?.components.filter((component) => selectedIds.includes(component.id)) || [];
  const selectedUnitCount = arrangementCount(screen?.components || [], selectedIds);
  const selectedGroupId = selection.length > 1 && selection[0].groupId && selection.every(component => component.groupId === selection[0].groupId) ? selection[0].groupId : null;
  useEffect(() => { setSelectedIds([]); setEventEditorId(null); setInputEventEditorId(null); setLifecycleEventEditorId(null); }, [screen?.id, editingTemplateId, preview]);
  const navigateSearch = (target: SearchTarget) => {
    if (!project || previewActionBusy) return;
    setSearchOpen(false);
    setSearchNavigation(null); setSearchLocation(null);
    if (target.kind === "query") {
      setWorkspace("queries"); setQueryNavigation({ id: target.id, token: ++searchNavigationToken.current }); return;
    }
    if (target.kind === "script") {
      setWorkspace("scripts"); setScriptNavigation({ id: target.id, token: ++searchNavigationToken.current }); return;
    }
    if (target.kind === "project") { setProjectSettingsOpen(true); return; }
    const resource = (target.kind === "screen" ? project.screens : project.templates ?? []).find(item => item.id === target.id);
    if (!resource || target.componentId && !resource.components.some(item => item.id === target.componentId)) {
      notify("This search result no longer exists. Search again to use the current draft.", true); return;
    }
    setWorkspace("designer"); setPreview(false); setLeftTab("project");
    if (preview || previewCommunication.session) { setPreviewPopup(null); void previewCommunication.stop().catch(() => {}); }
    openDocument({ kind: target.kind, id: target.id });
    setSearchNavigation(target);
  };
  // Apply selection after changing documents, following the normal selection reset above.
  useEffect(() => {
    if (!searchNavigation || workspace !== "designer" || preview || !screen || screen.id !== searchNavigation.id || Boolean(editingTemplateId) !== (searchNavigation.kind === "template")) return;
    setSelectedId(searchNavigation.componentId ?? null);
    setSearchLocation(searchNavigation);
    setSearchNavigation(null);
  }, [searchNavigation, workspace, preview, screen, editingTemplateId, setSelectedId]);
  useEffect(() => {
    if (!searchLocation?.property || !selected || searchLocation.componentId !== selected.id || searchLocation.id !== screen?.id) return;
    const property = searchLocation.property.replace(/^props\./, "").replace(/^(bindings|queryBindings)\./, "").split(".")[0];
    const row = document.querySelector<HTMLElement>(`#designer-properties-panel [data-property="${CSS.escape(property)}"]`);
    row?.scrollIntoView({ block: "nearest" });
    row?.setAttribute("data-search-match", "true");
    return () => row?.removeAttribute("data-search-match");
  }, [searchLocation, selected?.id, screen?.id]);
  const previewForm = useFormInputs({ document: screen, tags, parameters: editorParameters,
    edits: screen ? previewInputs[screen.id] : undefined, communicationLost: !connected,
    state: applicationState, active: preview && !previewActionBusy && !editorParameterError,
    onEdit: (fieldKey, value) => {
      if (screen) setPreviewInputs(previous => ({ ...previous, [screen.id]: { ...previous[screen.id], [fieldKey]: value } }));
    },
  });
  const currentPreviewInputs = previewForm.inputs;
  const runPreviewAction = async (
    component: CanvasComponent,
    instance?: InstanceAction,
  ) => {
    if (instance?.isCurrent?.() === false) return;
    if (!gatewayAdmin) { notify("A gateway administrator must sign in to run draft Python code.", true); return; }
    if (!screen || !project || previewActionBusy || editorParameterError || previewCommunication.busy || !previewCommunication.session) return;
    const actionParameters = instance?.parameters || editorParameters;
    const actionInputs = instance?.inputs || currentPreviewInputs;
    const invalid = validateInputs(
      instance?.template || screen,
      actionInputs,
      actionParameters,
    );
    if (invalid) {
      notify(invalid, true);
      return;
    }
    setPreviewActionBusy(actionKey(component.id, instance));
    try {
      const execution = await api<ScriptResult>("/scripts/run", "POST", {
        code: component.props.script || "",
        parameters: actionParameters,
        inputs: actionInputs,
      });
      if (instance?.isCurrent?.() === false) return;
      const resultMessage =
        typeof execution.result === "object" &&
        execution.result !== null &&
        "message" in execution.result
          ? String((execution.result as { message: unknown }).message)
          : execution.stdout ||
            (execution.result === undefined
              ? "Action completed."
              : JSON.stringify(execution.result));
      notify(
        execution.success
          ? resultMessage.slice(0, 1500)
          : (execution.stderr || "Action failed.").slice(0, 1500),
        !execution.success,
      );
      if (execution.success) window.dispatchEvent(new Event("sparkstudio:refresh-data"));
    } catch (error) {
      if (instance?.isCurrent?.() === false) return;
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setPreviewActionBusy("");
    }
  };
  const change = useCallback(
    (updater: (current: Project) => Project, recordHistory = true) => {
      const current = projectRef.current;
      if (!current) return;
      const next = reconcileNavigationAfterScreenChange(current, updater(current));
      if (next === current) return;
      if (recordHistory) updateHistory(checkpoint(historyRef.current, current));
      else if (historyRef.current.future.length) updateHistory({ ...historyRef.current, future: [] });
      if (projectInputContext(current) !== projectInputContext(next)) {
        setPreviewInputs({});
        setPreviewPopup(null);
        setToast(null);
      }
      projectRef.current = next;
      setProject(next);
      setDirty(projectContent(next) !== savedContentRef.current);
    },
    [updateHistory],
  );
  const updateScreen = (
    updater: (current: Screen) => Screen,
    recordHistory = true,
  ) => {
    if (!screen) return;
    change(
      (current) => ({
        ...current,
        ...(editingTemplate
          ? {
              templates: (current.templates || []).map((item) =>
                item.id === editingTemplate.id
                  ? (updater(item) as Template)
                  : item,
              ),
            }
          : {
              screens: current.screens.map((item) =>
                item.id === screen.id ? updater(item) : item,
              ),
            }),
      }),
      recordHistory,
    );
  };
  const updateComponent = (
    componentId: string,
    patch: Partial<CanvasComponent>,
    recordHistory = true,
  ) => {
    updateScreen(
      (current) => ({
        ...current,
        components: current.components.map((component) =>
          component.id === componentId ? { ...component, ...patch } : component,
        ),
      }),
      recordHistory,
    );
  };
  const updateProps = (patch: CanvasComponent["props"]) => {
    if (selected)
      updateComponent(selected.id, { props: { ...selected.props, ...patch } });
  };
  const replaceComponents = (components: CanvasComponent[], recordHistory = true) => {
    const latest = editingTemplate
      ? projectRef.current?.templates?.find((item) => item.id === editingTemplate.id)
      : projectRef.current?.screens.find((item) => item.id === screen?.id);
    if (!latest || components.every((component, index) => component === latest.components[index]) && components.length === latest.components.length) return;
    updateScreen((current) => ({ ...current, components }), recordHistory);
  };
  const deleteSelection = () => {
    if (!screen || !selection.length) return;
    previewResourceChange({ action: "delete", target: { kind: "components", ownerKind: editingTemplate ? "template" : "screen", ownerId: screen.id, ids: selectedIds } });
  };
  const commitResourceChange = () => {
    if (!resourceChangePlan || resourceChangeLoading || scriptsEditorReady && (searchScriptsLoading || searchScriptsError)) return;
    try {
      const request = resourceChangePlan.request;
      change(current => applyResourceChange(resourceChangePlan, current, searchQueries ?? queries, searchScripts));
      closeResourceChange(); setSelectedId(null);
      if (request.action === "delete" && request.target.kind !== "components") closeDocument(request.target);
      notify(`${request.action === "rename" ? "Rename" : "Deletion"} applied to the draft. Undo is available; save and publish when ready.`);
    } catch (reason) {
      setResourceChangeError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const duplicateSelection = () => {
    if (!screen || !selection.length) return;
    const result = duplicateSelected(screen.components, selectedIds, screen, { offset: { x: 24, y: 24 }, createId: (component) => id(component.type) });
    replaceComponents(result.components);
    setSelectedIds(result.selectedIds);
    if (selection.some((component) => isInput(component.type))) notify("Copied fields have unique names. Review copied scripts and input references before publishing.");
  };
  const groupSelection = () => {
    if (!screen || selection.length < 2 || selectedGroupId) return;
    replaceComponents(groupSelected(screen.components, selectedIds, id("group")));
  };
  const ungroupSelection = () => {
    if (!screen || !selection.some(component => component.groupId)) return;
    replaceComponents(ungroupSelected(screen.components, selectedIds));
  };
  const matchSelectionSize = (dimension: MatchingSize) => {
    if (!screen || previewActionBusy) return;
    const result = matchSelectedSize(screen.components, selectedIds, dimension, screen);
    if (result.error) notify(result.error, true);
    else replaceComponents(result.components);
  };
  const selectType = (type: string) => {
    if (!screen || previewActionBusy) return;
    setSearchLocation(null);
    setSelectedIds(selectComponentType(screen.components, type));
  };
  const finishGridEdit = () => {
    const size = parseGridSize(gridDraft);
    if (size === null) { setGridDraft(String(gridSize)); notify("Enter a whole grid size from 0 to 128 pixels. Zero disables snapping.", true); }
    else { setGridSize(size); setGridDraft(String(size)); }
  };
  const canvasKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (preview || previewActionBusy || !screen || (event.target as HTMLElement).closest("input,textarea,select,button,[contenteditable=true]")) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === "a") {
      event.preventDefault();
      if (event.shiftKey) { if (selection[0]) selectType(selection[0].type); }
      else setSelectedIds(screen.components.map((component) => component.id));
    } else if (command && event.key.toLowerCase() === "d") {
      event.preventDefault(); duplicateSelection();
    } else if (command && event.key.toLowerCase() === "g") {
      event.preventDefault();
      if (event.shiftKey) ungroupSelection(); else groupSelection();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault(); deleteSelection();
    } else if (event.key === "Escape") {
      event.preventDefault(); setSelectedIds([]);
    } else if (!command && !event.altKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const amount = event.shiftKey ? 10 : 1;
      replaceComponents(moveSelected(screen.components, selectedIds, {
        x: event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0,
        y: event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0,
      }, screen));
    }
  };
  const save = useCallback(async () => {
    const current = projectRef.current;
    if (!current || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await api<Project>("/project", "PUT", current);
      // Retain edits made while the save request was in flight.
      const latest = projectRef.current;
      const next = latest === current || !latest ? saved : { ...latest, revision: saved.revision };
      savedContentRef.current = projectContent(saved);
      projectRef.current = next;
      setProject(next);
      setDirty(projectContent(next) !== savedContentRef.current);
      notify("Project saved to the gateway.");
    } catch (error) {
      notify(String(error instanceof Error ? error.message : error), true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [notify]);
  const publish = async () => {
    if (!permissions.publish) { notify("Your account cannot publish this project.", true); return; }
    if (!project || dirty) {
      notify(
        "Save your project before publishing it to the operator application.",
        true,
      );
      return;
    }
    setPublishing(true);
    try {
      const published = await api<Publication>("/project/publish", "POST", {
        revision: project.revision,
      });
      setPublication({ ...published, published: true });
      notify(
        `Revision ${published.revision ?? project.revision} published. ${published.warnings?.length ? published.warnings.join(" ") : "Open the operator application to use it."}`,
        Boolean(published.warnings?.length),
      );
      if (published.warnings?.length) setPublicationHistoryOpen(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setPublishing(false);
    }
  };
  const travelHistory = useCallback((direction: "undo" | "redo") => {
    const current = projectRef.current;
    if (previewActionBusy || preview || !current) return;
    const restored = restoreHistory(historyRef.current, current, direction);
    if (!restored) return;
    if (projectInputContext(current) !== projectInputContext(restored.project)) {
      setPreviewInputs({});
      setPreviewPopup(null);
    }
    updateHistory(restored.history);
    projectRef.current = restored.project;
    setProject(restored.project);
    setSelectedIds([]);
    setToast(null);
    setDirty(projectContent(restored.project) !== savedContentRef.current);
  }, [previewActionBusy, preview, updateHistory]);
  const undo = useCallback(() => travelHistory("undo"), [travelHistory]);
  const redo = useCallback(() => travelHistory("redo"), [travelHistory]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (workspace !== "designer" || eventEditorId || inputEventEditorId || lifecycleEventEditorId) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
      const editing = (event.target as HTMLElement)?.closest("input,textarea,select,[contenteditable=true]");
      if (
        !editing &&
        (event.ctrlKey || event.metaKey) &&
        ["z", "y"].includes(event.key.toLowerCase())
      ) {
        event.preventDefault();
        if (event.key.toLowerCase() === "y" || event.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [save, undo, redo, workspace, eventEditorId, inputEventEditorId, lifecycleEventEditorId]);

  const addComponent = (type: ComponentType, tagPath?: string) => {
    if (!screen) return;
    const reusable = availableTemplates[0];
    if (isTemplateInstance(type) && !reusable) {
      notify(
        editingTemplate
          ? "Create another template that can be nested here without a cycle or more than four levels."
          : "Create a template first, then add an instance to a screen.",
        true,
      );
      return;
    }
    const offset = (screen.components.length % 7) * 20;
    let fieldIndex = 1;
    while (
      screen.components.some(
        (item) => item.props.fieldKey === `${type}${fieldIndex}`,
      )
    )
      fieldIndex++;
    const component: CanvasComponent = {
      id: id(type),
      type,
      x: 40 + offset,
      y: 48 + offset,
      width: processDimensions[type]?.width ?? (
        type === "repeater"
          ? Math.min(900, screen.width - 80)
          : type === "template"
            ? reusable!.width
            : type === "table"
              ? 620
              : type === "label"
                ? 340
                : 260),
      height: processDimensions[type]?.height ?? (isTemplateInstance(type)
        ? type === "template"
          ? reusable!.height
          : 450
        : type === "table"
          ? 270
          : type === "label"
            ? 56
            : type === "treeView" ? 260
            : type === "list" ? 200
            : type === "textArea" || type === "radioGroup"
              ? 150
            : type === "button" || type === "checkbox" || type === "toggle"
              ? 52
              : isInput(type)
                ? 90
                : 170),
      props: {
        text: {
          label: "New heading",
          value: "Live value",
          gauge: "Process value",
          ledDisplay: "Numeric readout",
          progressBar: "Process progress",
          cylindricalTank: "Tank level",
          levelIndicator: "Process level",
          thermometer: "Temperature",
          line: "Line",
          rectangle: "Rectangle",
          ellipse: "Ellipse",
          polyline: "Polyline",
          pipe: "Process pipe",
          equipmentSymbol: "Pump",
          button: "Open screen",
          table: "Production data",
          image: "",
          icon: "Status icon",
          textInput: "Text input",
          passwordInput: "Password",
          numberInput: "Number input",
          checkbox: "Check box",
          select: "Choose an option",
          list: "Choose an item",
          treeView: "Choose equipment",
          textArea: "Notes",
          spinner: "Quantity",
          slider: "Setpoint",
          radioGroup: "Operating mode",
          dateTimeInput: "Scheduled time",
          toggle: "Enabled",
          multiStateButton: "Operating mode",
          multiStateIndicator: "Equipment state",
          template: reusable?.name || "Template",
          repeater: reusable?.name || "Repeater",
        }[type],
        ...(type === "image"
          ? { assetId: assets[0]?.id || "", fit: "contain", alt: "" }
          : {}),
        ...(type === "icon" ? { icon: "spark", alt: "Status" } : {}),
        ...(["line", "rectangle", "ellipse", "polyline", "pipe", "equipmentSymbol"].includes(type) ? {
          strokeColor: "#64748b", strokeWidth: type === "pipe" ? 12 : 2, rotation: 0,
          ...(["rectangle", "ellipse", "pipe", "equipmentSymbol"].includes(type) ? { fillColor: type === "pipe" ? "#334155" : type === "equipmentSymbol" ? "#64748b" : "none" } : {}),
          ...(["line", "pipe"].includes(type) ? { points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] } : {}),
          ...(type === "polyline" ? { points: [{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 50, y: 0 }, { x: 100, y: 0 }] } : {}),
          ...(type === "rectangle" ? { cornerRadius: 0 } : {}),
          ...(type === "pipe" ? { flowing: false, flowReverse: false } : {}),
          ...(type === "equipmentSymbol" ? { symbol: "pump", active: false } : {}),
        } : {}),
        ...(isTemplateInstance(type)
          ? {
              templateId: reusable!.id,
              parameters: {},
              ...(type === "repeater"
                ? {
                    rows: [
                      { id: "row1", parameters: {} },
                      { id: "row2", parameters: {} },
                    ],
                    columns: 2,
                    gap: 16,
                  }
                : {}),
            }
          : {}),
        ...(type === "value" || type === "gauge"
          ? {
              tagPath: tagPath || "[default]Line/{line}/Speed",
              unit: "",
              min: 0,
              max: 100,
            }
          : {}),
        ...(type === "table" ? { queryId: queries[0]?.id || "", pageSize: 25 } : {}),
        ...(isProcessDisplay(type) ? {
          value: 0, decimals: 1, unit: "",
          ...(type !== "ledDisplay" ? { min: 0, max: 100, showValue: true, showPercent: false } : {}),
          ...(type === "progressBar" || type === "levelIndicator" ? { orientation: type === "progressBar" ? "horizontal" : "vertical" } : {}),
        } : {}),
        ...(isInput(type)
          ? {
              fieldKey: `${type}${fieldIndex}`,
              defaultValue:
                type === "checkbox" || type === "toggle"
                  ? false
                  : ["numberInput", "spinner", "slider"].includes(type)
                    ? 0
                    : type === "treeView" ? "group1"
                    : type === "select" || type === "radioGroup" || type === "multiStateButton" || type === "list"
                      ? "option1"
                      : "",
            }
          : {}),
        ...(["numberInput", "spinner", "slider"].includes(type) ? { min: 0, max: 100, ...(["spinner", "slider"].includes(type) ? { step: 1 } : {}) } : {}),
        ...(type === "select" || type === "radioGroup" || type === "multiStateButton" || type === "list"
          ? {
              options: [
                { label: "Option 1", value: "option1" },
                { label: "Option 2", value: "option2" },
              ],
            }
          : {}),
        ...(type === "treeView" ? { options: [
          { value: "group1", label: "Equipment" },
          { value: "option1", label: "Machine 1", parentValue: "group1" },
          { value: "option2", label: "Machine 2", parentValue: "group1" },
        ] } : {}),
        ...(type === "multiStateIndicator" ? {
          stateValue: "idle",
          states: [
            { value: "idle", label: "Idle", color: "#64748b" },
            { value: "running", label: "Running", color: "#2563eb" },
            { value: "fault", label: "Fault", color: "#dc2626" },
          ],
        } : {}),
        ...(type === "button"
          ? {
              action: "navigate",
              targetScreenId:
                project?.screens.find(
                  (item) => item.id !== screen.id && item.kind !== "popup",
                )?.id ||
                project?.screens.find((item) => item.kind !== "popup")?.id ||
                "",
            }
          : {}),
      },
    };
    component.width = Math.min(component.width, screen.width);
    component.height = Math.min(component.height, screen.height);
    component.x = Math.max(0, Math.min(component.x, screen.width - component.width));
    component.y = Math.max(0, Math.min(component.y, screen.height - component.height));
    updateScreen((current) => ({
      ...current,
      components: [...current.components, component],
    }));
    setSelectedId(component.id);
  };
  const addScreen = () => {
    const next: Screen = {
      id: id("screen"),
      name: `Screen ${(project?.screens.length || 0) + 1}`,
      ...newDocumentDimensions(project || {}, "screen"),
      components: [],
    };
    change((current) => ({ ...current, screens: [...current.screens, next] }));
    openDocument({ kind: "screen", id: next.id });
    setSelectedId(null);
    setPreview(false);
    if (preview || previewCommunication.session) { setPreviewPopup(null); void previewCommunication.stop().catch(() => {}); }
  };
  const addTemplate = () => {
    const next: Template = {
      id: id("template"),
      name: `Template ${(project?.templates?.length || 0) + 1}`,
      ...newDocumentDimensions(project || {}, "template"),
      parameters:
        project?.parameters.line !== undefined ? { line: "{line}" } : {},
      components: [],
    };
    change((current) => ({
      ...current,
      templates: [...(current.templates || []), next],
    }));
    openDocument({ kind: "template", id: next.id });
    setSelectedId(null);
    setPreview(false);
    if (preview || previewCommunication.session) { setPreviewPopup(null); void previewCommunication.stop().catch(() => {}); }
    setLeftTab("project");
  };
  const openTemplate = (templateId: string) => {
    openDocument({ kind: "template", id: templateId });
    setSelectedId(null);
    setToast(null);
    setLeftTab("project");
  };
  const exportProject = async () => {
    const projectId = currentProjectId();
    if (!project || !projectId || packageExporting) return;
    if (dirty || scriptsDirty || queriesDirty || saving) {
      notify("Save your project, named queries and script resources before exporting. The package contains saved resources only.", true);
      return;
    }
    setPackageExporting(true);
    try {
      await exportProjectPackage({ id: projectId, name: project.name });
      notify("Saved project resources exported as .sparkproj. Gateway connections and data are not included.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to export this project.", true);
    } finally {
      setPackageExporting(false);
    }
  };
  const filteredTags = tags.filter((tag) =>
    tag.path.toLowerCase().includes(tagFilter.toLowerCase()),
  );
  const parameterChoices = [
    ...new Set(
      tags
        .map((tag) => tag.path.match(/\]Line\/([^/]+)\//)?.[1])
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  return (
    <LocalizationProvider catalog={project?.localization} locale={projectLocale.locale}><VisualStyleProvider styles={project?.styles}><ApplicationStateProvider value={applicationState}><div className="app-shell" onClickCapture={event => {
      if (!(dirty || queriesDirty || scriptsDirty) || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
      const destination = new URL(link.href, window.location.href);
      if (destination.origin !== window.location.origin || destination.pathname === window.location.pathname) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingNavigation(destination.href);
    }}>
      <aside
        className={`navigation ${workspaceCollapsed ? "workspace-collapsed" : ""}`}
      >
        <div className="navigation-scroll">
        <a
          className="brand"
          href="#designer"
          onClick={(event) => {
            event.preventDefault();
            setWorkspace("designer");
          }}
          aria-label="SparkStudio designer"
          title="SparkStudio designer"
        >
          <span className="brand-mark">
            <Icon name="spark" size={22} />
          </span>
          <span>
            spark<span className="brand-light">studio</span>
            <small>APPLICATION DESIGNER</small>
          </span>
        </a>
        <button
          className="workspace-toggle"
          aria-label={
            workspaceCollapsed ? "Expand workspace" : "Collapse workspace"
          }
          title={workspaceCollapsed ? "Expand workspace" : "Collapse workspace"}
          aria-expanded={!workspaceCollapsed}
          aria-controls="workspace-navigation"
          onClick={() =>
            setWorkspaceCollapsed((previous) => {
              const next = !previous;
              try {
                localStorage.setItem(
                  "sparkstudio.workspaceCollapsed.v1",
                  String(next),
                );
              } catch {
                /* Keep this session usable when browser storage is unavailable. */
              }
              return next;
            })
          }
        >
          <Icon name="arrow" size={15} />
          <span>Collapse workspace</span>
        </button>
        <a className="designer-project-link" href="/" title="All projects" aria-label="All projects"><Icon name="layers" size={17} /><span>Projects</span><Icon name="arrow" size={13} /></a>
        <div className="nav-section-label">WORKSPACE</div>
        <nav id="workspace-navigation" aria-label="Workspace">
          {(
            [
              ["designer", "design", "Designer"],
              ["tags", "tag", "Tags"],
              ["connections", "plug", "Connections"],
              ["queries", "database", "Named queries"],
              ["scripts", "code", "Scripting"],
            ] as const
          ).filter(([key]) => gatewayAdmin || key !== "tags" && key !== "connections").map(([key, icon, label]) => (
            <button
              key={key}
              className={`nav-link ${workspace === key ? "active" : ""}`}
              title={label}
              aria-label={label}
              aria-current={workspace === key ? "page" : undefined}
              onClick={() => setWorkspace(key)}
            >
              <Icon name={icon} />
              <span>{label}</span>
              {key === "designer" && <kbd>D</kbd>}
            </button>
          ))}
        </nav>
        <button className="nav-link" title="Search project (Ctrl+Shift+F)" aria-label="Search project" disabled={!project || Boolean(previewActionBusy)} onClick={() => setSearchOpen(true)}><Icon name="search" /><span>Search project</span></button>
        {gatewayAdmin && <a className="designer-project-link" href="/gateway" title="Gateway Settings" aria-label="Gateway Settings"><Icon name="settings" size={17} /><span>Gateway Settings</span></a>}
        </div>
        <div className="nav-bottom">
          <a
            className="runtime-launch-link"
            href={projectPage("runtime")}
            target="_blank"
            rel="noopener noreferrer"
            title="Open operator application"
            aria-label="Open operator application"
          >
            <Icon name="monitor" size={17} />
            <span>
              Operator application
              <small>
                {publication?.published
                  ? `Published revision ${publication.revision}`
                  : "Publish a project to get started"}
              </small>
            </span>
            <Icon name="external" size={13} />
          </a>
          <div className="local-card">
            <div className="local-card-top">
              <span className={`status-dot ${connected ? "" : "offline"}`} />
              <strong>Local gateway</strong>
              <Icon name="shield" size={15} />
            </div>
            <span>Self-hosted · local workspace</span>
            <div className="local-card-details">
              <span>{connected ? "Connected" : "Reconnecting"}</span>
              <span title={health?.version ? `Gateway build: ${health.version}` : undefined}>
                {health?.version ? `v${health.version.split("+", 1)[0]}` : "Version unavailable"}
              </span>
            </div>
          </div>
          <SessionIdentity placement="sidebar" onAccountSettings={() => setAccountSettingsOpen(true)} />
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <Icon name="arrow" size={13} />
            <strong>
              {workspace === "designer"
                ? project?.name || "Designer"
                : workspace === "tags"
                  ? "Tags"
                  : workspace === "connections"
                    ? "Connections"
                    : workspace === "queries"
                      ? "Named queries"
                      : "Scripting"}
            </strong>
            {workspace === "designer" && (
              <span className="version-pill">
                {preview ? "PREVIEW" : "DESIGN"}
              </span>
            )}
          </div>
          <div className="topbar-actions">
            {workspace === "designer" && project && (
              <>
                <span className={`save-state ${dirty ? "unsaved" : ""}`}>
                  <span className="status-dot" />
                  {dirty ? "Save before publishing" : "All changes saved"}
                </span>
                <button
                  className={`button ${preview ? "preview-active" : ""}`}
                  disabled={!screen || previewCommunication.busy || Boolean(previewActionBusy) || !preview && Boolean(editorParameterError)}
                  onClick={() => void (async () => {
                    try {
                      if (preview) { setPreview(false); await previewCommunication.stop(); }
                      else if (await previewCommunication.start("read-only")) setPreview(true);
                      setPreviewPopup(null); setPreviewInputs({}); setSelectedId(null);
                    } catch (error) { setPreview(false); await previewCommunication.stop().catch(() => {}); notify(error instanceof Error ? error.message : String(error), true); }
                  })()}
                >
                  <Icon name={preview ? "stop" : "play"} size={15} />
                  {preview ? "Exit preview" : "Preview"}
                </button>
                <button
                  className="button"
                  disabled={preview || saving || !dirty}
                  onClick={() => void save()}
                >
                  <Icon name="save" size={16} />
                  {saving ? "Saving…" : "Save project"}
                </button>
                <button
                  className="button primary"
                  disabled={preview || !permissions.publish || dirty || saving || publishing}
                  title={
                    !permissions.publish ? "Your account needs publish permission for this project" : dirty
                      ? "Save your project before publishing to operators"
                      : "Publish the saved project for operators"
                  }
                  onClick={() => void publish()}
                >
                  <Icon name="upload" size={15} />
                  {publishing ? "Publishing…" : "Publish"}
                </button>
              </>
            )}
          </div>
        </header>
        {preview && <PreviewControls session={previewCommunication.session} busy={previewCommunication.busy} gatewayAdmin={gatewayAdmin}
          onDiagnostics={() => setDiagnosticsOpen(true)}
          onChangeMode={async mode => { if (await previewCommunication.start(mode)) { setPreviewInputs({}); setPreviewPopup(null); } }}>
          <LocaleSelector catalog={project?.localization} locale={projectLocale.locale} onChange={projectLocale.setLocale} />
        </PreviewControls>}
        {preview && <ComponentEventDiagnostics state={applicationState} />}
        {loadError && (
          <div className="gateway-error">
            <Icon name="info" />
            <div>
              <strong>Cannot reach the gateway</strong>
              <p>{loadError}</p>
              <button className="button" onClick={() => void load()}>
                <Icon name="refresh" size={15} />
                Try again
              </button>
            </div>
          </div>
        )}
        {!project && !loadError && (
          <div className="loading-state">
            <span className="loading-ring" />
            <p>Connecting to your workspace…</p>
          </div>
        )}

        {project && workspace === "designer" && (
          <div ref={designerPanes.host} style={designerPanes.style} className={`designer ${preview ? "is-preview" : ""}${designerPanes.resizing ? " designer-panes-resizing" : ""}`}>
            {!preview && (
              <aside id="designer-project-panel" className="project-panel">
                <div className="panel-tabs">
                  <button
                    className={leftTab === "project" ? "active" : ""}
                    onClick={() => setLeftTab("project")}
                  >
                    <Icon name="layers" size={15} />
                    Project
                  </button>
                  <button
                    className={leftTab === "components" ? "active" : ""}
                    onClick={() => setLeftTab("components")}
                  >
                    <Icon name="grid" size={15} />
                    Components
                  </button>
                  <button className={leftTab === "tags" ? "active" : ""} onClick={() => setLeftTab("tags")}>
                    <Icon name="tag" size={15} /> Tags
                  </button>
                </div>
                {leftTab === "project" ? (
                  <>
                  <button className="project-settings-button" type="button" disabled={Boolean(previewActionBusy)} onClick={() => setProjectSettingsOpen(true)}>
                    <Icon name="settings" size={15} /> Project settings
                  </button>
                  <details className="project-tools"><summary>Project tools</summary><div>
                  <button className="project-settings-button" type="button" disabled={Boolean(previewActionBusy)} onClick={() => setStylesEditorOpen(true)}>Visual styles</button>
                  <button className="project-settings-button" type="button" disabled={Boolean(previewActionBusy)} onClick={() => setTranslationsOpen(true)}>Translations</button>
                  <button className="project-settings-button" type="button" onClick={() => setDiagnosticsOpen(true)}>Project diagnostics</button>
                  <button className="project-settings-button" type="button" disabled={Boolean(previewActionBusy)} onClick={() => setPublicationHistoryOpen(true)}>Publication history</button>
                  <button className="project-settings-button" type="button" disabled={Boolean(previewActionBusy)} onClick={() => setAssetLibraryOpen(true)}>Asset library</button>
                  </div></details>
                  <ProjectNavigation key={project.id} storageKey={projectStorageKey("sparkstudio.projectPanes.v1", project.id)}>
                    <div className="project-tree">
                      <div className="section-heading">
                        <span>
                          SCREENS <em>{project.screens.length}</em>
                        </span>
                        <button
                          className="icon-button"
                          title="Add screen"
                          aria-label="Add screen"
                          onClick={addScreen}
                        >
                          <Icon name="plus" size={16} />
                        </button>
                      </div>
                      <div className="project-document-list" aria-label="Project screens">{project.screens.map((item) => (
                        <button
                          key={item.id}
                          className={`tree-item ${screen?.id === item.id ? "selected" : ""}`}
                          onClick={() => {
                            openDocument({ kind: "screen", id: item.id });
                          }}
                        >
                          <Icon name="monitor" size={16} />
                          <span>{item.name}</span>
                          {item.kind === "popup" && (
                            <span className="popup-screen-badge">POPUP</span>
                          )}
                          {screen?.id === item.id && (
                            <span className="tiny-orange-dot" />
                          )}
                        </button>
                      ))}</div>
                      <div className="project-actions">
                        <button
                          onClick={() => void exportProject()}
                          disabled={packageExporting}
                          title="Export saved screens, templates, queries, scripts and referenced images"
                        >
                          <Icon name="download" size={13} />
                          {packageExporting ? "Exporting…" : "Export .sparkproj"}
                        </button>
                        {gatewayAdmin && <button
                          onClick={() => setProjectImportOpen(true)}
                          title="Import a package as an independent project"
                        >
                          <Icon name="upload" size={13} />
                          Import package
                        </button>}
                      </div>
                    </div>
                    <div className="template-list">
                      <div className="section-heading">
                        <span>
                          TEMPLATES <em>{project.templates?.length || 0}</em>
                        </span>
                        <button
                          className="icon-button"
                          title="Add template"
                          aria-label="Add template"
                          onClick={addTemplate}
                        >
                          <Icon name="plus" size={16} />
                        </button>
                      </div>
                      <div className="project-document-list" aria-label="Project templates">{(project.templates || []).map((item) => (
                        <button
                          key={item.id}
                          className={`tree-item ${editingTemplate?.id === item.id ? "selected" : ""}`}
                          onClick={() => openTemplate(item.id)}
                        >
                          <Icon name="layers" size={16} />
                          <span>{item.name}</span>
                          {editingTemplate?.id === item.id && (
                            <span className="tiny-orange-dot" />
                          )}
                        </button>
                      ))}
                      {!project.templates?.length && (
                        <p className="panel-empty">
                          Create reusable forms and cards, then place instances
                          on your screens.
                        </p>
                      )}
                      </div>
                    </div>
                    <div className="component-tree">
                      <div className="section-heading">
                        <span>
                          LAYERS <em>{screen?.components.length || 0}</em>
                        </span>
                        <button
                          className="icon-button"
                          title="Add a component"
                          onClick={() => setLeftTab("components")}
                        >
                          <Icon name="plus" size={16} />
                        </button>
                      </div>
                      <div className="project-document-list" aria-label="Document layers">{screen?.components.map((component) => (
                        <button
                          className={`layer-item ${selectedIds.includes(component.id) ? "selected" : ""}`}
                          key={component.id}
                          onClick={() => setSelectedId(component.id)}
                        >
                          <Icon name={typeIcon[component.type]} size={15} />
                          <span>{component.props.text || component.type}</span>
                          {component.groupId && <span className="layer-group-marker" title="Member of a persistent group"><Icon name="layers" size={12} /></span>}
                          {component.props.tagPath && (
                            <Icon name="link" size={12} />
                          )}
                        </button>
                      ))}
                      {!screen?.components.length && (
                        <p className="panel-empty">
                          {screen ? "Add a component to start building this screen." : "Open a screen or template to view its layers."}
                        </p>
                      )}
                      </div>
                    </div>
                  </ProjectNavigation>
                  </>
                ) : leftTab === "components" ? (
                  <div className="palette">
                    <div className="section-heading">
                      <span>BUILDING BLOCKS</span>
                      <span className="count-pill">
                        {palettes.length}
                      </span>
                    </div>
                    <p className="panel-description">
                      Click a component to add it to your screen.
                    </p>
                    {palettes.map((item) => (
                        <button
                          key={item.type}
                          className="palette-item"
                          disabled={
                            !screen || isTemplateInstance(item.type) &&
                            !availableTemplates.length
                          }
                          title={
                            isTemplateInstance(item.type) &&
                            !availableTemplates.length
                              ? "Create a compatible template in the Project tab first"
                              : item.hint
                          }
                          onClick={() => addComponent(item.type)}
                        >
                          <span className="palette-icon">
                            <Icon name={typeIcon[item.type]} size={20} />
                          </span>
                          <span>
                            <strong>{item.name}</strong>
                            <small>{item.hint}</small>
                          </span>
                          <Icon name="plus" size={14} />
                        </button>
                      ))}
                  </div>
                ) : null}
                {leftTab === "tags" && <div className="tag-panel standalone-tag-panel">
                  <div
                    className="tag-panel-title"
                  >
                    <Icon name="tag" size={16} />
                    <strong>Tag browser</strong>
                    <span className="count-pill">{tags.length}</span>
                  </div>
                      <label className="search-box">
                        <Icon name="search" size={15} />
                        <input
                          aria-label="Search tags"
                          placeholder="Search tags…"
                          value={tagFilter}
                          onChange={(event) => setTagFilter(event.target.value)}
                        />
                      </label>
                      <div className="tag-list">
                        {filteredTags.map((tag) => (
                          <button
                            key={tag.path}
                            draggable
                            onDragStart={(event) =>
                              event.dataTransfer.setData(
                                "text/spark-tag",
                                tag.path,
                              )
                            }
                            onClick={() => setTagSelection(tag)}
                            onDoubleClick={() =>
                              selected &&
                              (selected.type === "value" ||
                                selected.type === "gauge" || isProcessDisplay(selected.type))
                                ? updateProps(tagBindingPatch(selected, tag.path))
                                : addComponent("value", tag.path)
                            }
                            className={`tag-row ${tagSelection?.path === tag.path ? "selected" : ""}`}
                            title={`${tag.path}\nDouble-click to bind or add a value`}
                          >
                            <span
                              className={`tag-quality ${String(tag.quality).toLowerCase().includes("good") ? "" : "bad"}`}
                            />
                            <span className="tag-row-name">
                              {tag.path.replace("[default]", "")}
                            </span>
                            <span className="tag-row-value">
                              {displayValue(tag.value)}
                            </span>
                          </button>
                        ))}
                        {!filteredTags.length && (
                          <p className="panel-empty">No matching tags.</p>
                        )}
                      </div>
                      {tagSelection && (
                        <div className="tag-detail">
                          <strong>{tagSelection.path}</strong>
                          <div>
                            <span>{tagSelection.dataType}</span>
                            <span>{tagSelection.quality}</span>
                          </div>
                          <button
                            disabled={!screen}
                            onClick={() =>
                              selected && acceptsInitialTag(selected.type)
                                ? updateProps(tagBindingPatch(selected, tagSelection.path))
                                : addComponent("value", tagSelection.path)
                            }
                          >
                            <Icon name="link" size={13} />
                            {selected && acceptsInitialTag(selected.type)
                              ? "Bind to selection"
                              : "Add value to screen"}
                          </button>
                        </div>
                      )}
                      <p className="tag-hint">
                        <Icon name="info" size={12} />
                        Drag a tag onto a value to bind it.
                      </p>
                </div>}
              </aside>
            )}

            {!preview && designerPanes.separator(0)}
            <section className="canvas-workspace">
              <div className="screen-tabs">
                {documents.open.map(document => {
                  const item = (document.kind === "template" ? project.templates ?? [] : project.screens).find(item => item.id === document.id);
                  if (!item) return null;
                  const active = documentKey(document) === documents.active;
                  return <div key={documentKey(document)} className={`document-tab${active ? " active" : ""}${document.kind === "template" ? " template-tab" : ""}`}>
                    <button className="document-tab-label" aria-current={active ? "page" : undefined} disabled={Boolean(previewActionBusy)} onClick={() => openDocument(document)} title={`${document.kind === "template" ? "Template" : item.kind === "popup" ? "Popup" : "Screen"}: ${item.name}`}>
                      <Icon name={document.kind === "template" ? "layers" : item.kind === "popup" ? "external" : "monitor"} size={14} />
                      <span>{item.name}</span>
                      {document.kind === "template" && <span className="template-editor-badge">TEMPLATE</span>}
                      {active && dirty && <span className="tiny-orange-dot" />}
                    </button>
                    {!preview && <button className="document-tab-close" disabled={Boolean(previewActionBusy)} title={`Close ${item.name} tab`} aria-label={`Close ${item.name} tab`} onClick={() => closeDocument(document)}><Icon name="close" size={12} /></button>}
                  </div>;
                })}
                {!preview && (
                  <button
                    className="add-screen-tab"
                    title="Add screen"
                    onClick={addScreen}
                  >
                    <Icon name="plus" size={15} />
                  </button>
                )}
                <span className="screen-tabs-spacer" />
                <span className="screen-tabs-mode">
                  {preview
                    ? "INTERACTIVE PREVIEW"
                    : editingTemplate
                      ? "TEMPLATE EDITOR"
                      : screen ? "SCREEN EDITOR" : "NO DOCUMENT OPEN"}
                </span>
              </div>
              <div className="canvas-toolbar">
                <div className="toolbar-group">
                  {!preview && (
                    <>
                      <button
                        className="icon-button active"
                        title="Select and move components"
                      >
                        <Icon name="move" size={16} />
                      </button>
                      <span className="toolbar-divider" />
                      <button
                        className="icon-button"
                        title="Undo (Ctrl+Z)"
                        onClick={undo}
                        disabled={!history.past.length}
                      >
                        <Icon name="undo" size={16} />
                      </button>
                      <button className="icon-button" title="Redo (Ctrl+Y or Ctrl+Shift+Z)" onClick={redo} disabled={!history.future.length}>
                        <span className="redo-icon"><Icon name="undo" size={16} /></span>
                      </button>
                      <button
                        className="icon-button"
                        title="Duplicate selection (Ctrl+D)"
                        disabled={!selection.length}
                        onClick={duplicateSelection}
                      >
                        <Icon name="copy" size={16} />
                      </button>
                      <span className="toolbar-divider" />
                    </>
                  )}
                  <Icon name="monitor" size={15} />
                  <span>
                    {screen ? `${screen.width} × ${screen.height}` : "No document open"}
                  </span>
                </div>
                <div className="toolbar-group parameter-toolbar">
                  <span className="toolbar-caption">Screen context</span>
                  {Object.entries(project.parameters).map(([key, value]) => (
                    <label key={key}>
                      <span>{key}</span>
                      {key === "line" && parameterChoices.length ? (
                        <select
                          value={value}
                          disabled={Boolean(previewActionBusy)}
                          onChange={(event) =>
                            change((current) => ({
                              ...current,
                              parameters: {
                                ...current.parameters,
                                [key]: event.target.value,
                              },
                            }))
                          }
                        >
                          {[...new Set([...parameterChoices, value])].map(
                            (choice) => (
                              <option key={choice}>{choice}</option>
                            ),
                          )}
                        </select>
                      ) : (
                        <input
                          aria-label={`${key} parameter`}
                          value={value}
                          disabled={Boolean(previewActionBusy)}
                          onChange={(event) =>
                            change((current) => ({
                              ...current,
                              parameters: {
                                ...current.parameters,
                                [key]: event.target.value,
                              },
                            }))
                          }
                        />
                      )}
                    </label>
                  ))}
                </div>
              </div>
              {editingTemplate && (
                <div className="template-editor-banner">
                  <Icon name="layers" size={14} />
                  <strong>Editing shared template</strong>
                  <span>Save and publish to update every instance.</span>
                  <button
                    disabled={Boolean(previewActionBusy)}
                    onClick={() => {
                      const target = documents.open.find(item => item.kind === "screen")?.id || project.screens[0]?.id;
                      if (target) openDocument({ kind: "screen", id: target });
                    }}
                  >
                    <Icon name="arrow" size={12} /> Back to screen
                  </button>
                </div>
              )}
              {editorParameterError && <div className="template-parameter-context-error" role="alert">
                <strong>Template parameters need attention.</strong> {editorParameterError} Preview is unavailable until the default or its parent value is corrected. Select the template document to edit its parameters.
              </div>}
              {!preview && screen && (
                <div className="canvas-arrange-toolbar" aria-label="Canvas arrangement">
                  <label title="Whole design pixels from 0 to 128. Zero disables snapping; canvas bounds take precedence.">Grid <input className="canvas-grid-input" aria-label="Snap grid pixels" type="number" min={0} max={128} step={1} value={gridDraft} aria-invalid={parseGridSize(gridDraft) === null} onChange={event => {
                    setGridDraft(event.target.value);
                    const size = parseGridSize(event.target.value);
                    if (size !== null) setGridSize(size);
                  }} onBlur={finishGridEdit} onKeyDown={event => {
                    if (event.key === "Enter") { event.preventDefault(); finishGridEdit(); }
                    else if (event.key === "Escape") { event.preventDefault(); setGridDraft(String(gridSize)); }
                  }} /> px</label>
                  <select aria-label="Select components by type" value="" disabled={!screen.components.length} title="Select this component type in the current document, including its group members. Ctrl+Shift+A selects the first selected control's type." onChange={event => selectType(event.target.value)}>
                    <option value="" disabled>Select type…</option>
                    {palettes.filter(item => screen.components.some(component => component.type === item.type)).map(item => <option key={item.type} value={item.type}>{item.name}</option>)}
                  </select>
                  <button className="canvas-group-command" disabled={selection.length < 2 || Boolean(selectedGroupId)} onClick={groupSelection} title="Group selection (Ctrl+G)"><Icon name="layers" size={14} /> Group</button>
                  <button className="canvas-group-command" disabled={!selection.some(component => component.groupId)} onClick={ungroupSelection} title="Ungroup selection (Ctrl+Shift+G)">Ungroup</button>
                  <select aria-label="Align selection" value="" disabled={selectedUnitCount < 2} onChange={(event) => replaceComponents(alignSelected(screen.components, selectedIds, event.target.value as "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom"))}>
                    <option value="" disabled>Align…</option><option value="left">Left edges</option><option value="hcenter">Horizontal centers</option><option value="right">Right edges</option><option value="top">Top edges</option><option value="vcenter">Vertical centers</option><option value="bottom">Bottom edges</option>
                  </select>
                  <select aria-label="Distribute selection" value="" disabled={selectedUnitCount < 3} onChange={(event) => replaceComponents(distributeSelected(screen.components, selectedIds, event.target.value as "horizontal" | "vertical"))}>
                    <option value="" disabled>Distribute…</option><option value="horizontal">Horizontal gaps</option><option value="vertical">Vertical gaps</option>
                  </select>
                  <select aria-label="Match selected sizes" value="" disabled={selectedUnitCount < 2} title="Match the first selected object in layer order. Groups scale as one object; bound geometry remains authored." onChange={event => matchSelectionSize(event.target.value as MatchingSize)}>
                    <option value="" disabled>Match size…</option><option value="width">Same width</option><option value="height">Same height</option><option value="both">Same width and height</option>
                  </select>
                  <button disabled={!selection.length} onClick={deleteSelection} title="Delete selection"><Icon name="trash" size={14} /></button>
                  <span aria-live="polite">{selectedGroupId ? `Group · ${selection.length} controls` : selection.length ? `${selection.length} selected` : "Drag empty canvas to select · Shift-click to add"}</span>
                </div>
              )}
              {!screen && <div className="designer-empty-document">
                <Icon name="monitor" size={34} />
                <h2>No document open</h2>
                <p>Open a screen or template from Project to continue editing. Closing a tab keeps the document and your changes in this project.</p>
                <button className="button" onClick={() => setLeftTab("project")}><Icon name="layers" size={15} /> Show Project</button>
              </div>}
              {screen && (!preview || !editorParameterError) && (
                <Canvas
                  key={JSON.stringify([screen.id, preview, previewCommunication.session?.token, editingTemplate?.parameterTypes ?? null])}
                  screen={screen}
                  tags={tags}
                  parameters={editorParameters}
                  templates={project.templates || []}
                  templateAncestors={editingTemplate ? [editingTemplate.id] : []}
                  scopedInputs={previewInputs}
                  onScopedInputChange={(scope, fieldKey, value) =>
                    setPreviewInputs((previous) => ({
                      ...previous,
                      [scope]: { ...previous[scope], [fieldKey]: value },
                    }))
                  }
                  communicationLost={!connected}
                  preview={preview}
                  inputs={currentPreviewInputs}
                  onInputChange={previewForm.assign}
                  onAutomaticInputChange={previewForm.assignAutomatic}
                  onAction={(component, instance) =>
                    void runPreviewAction(component, instance)
                  }
                  onOpenPopup={(component, instance) => {
                    if (previewActionBusy || previewPopup || editorParameterError) return;
                    try {
                      setPreviewPopup(
                        createPopup(
                          project,
                          screen,
                          component,
                          project.parameters,
                          instance?.parameters || editorParameters,
                          instance,
                        ),
                      );
                      setToast(null);
                    } catch (error) {
                      notify(
                        error instanceof Error ? error.message : String(error),
                        true,
                      );
                    }
                  }}
                  onClosePopup={() =>
                    notify(
                      "There is no popup open. Open this screen from a popup button to test closing it.",
                    )
                  }
                  actionBusyId={previewActionBusy}
                  selectedIds={selectedIds}
                  gridSize={gridSize}
                  onSelect={values => { setSearchLocation(null); setSelectedIds(values); }}
                  onReplace={replaceComponents}
                  onKeyDown={canvasKeyboard}
                  onBeginMove={() => {
                    if (projectRef.current) updateHistory(checkpoint(historyRef.current, projectRef.current));
                  }}
                  onNavigate={(target) => {
                    if (previewActionBusy) return;
                    if (
                      project.screens.some(
                        (item) => item.id === target && item.kind !== "popup",
                      )
                    ) {
                      openDocument({ kind: "screen", id: target });
                    } else
                      notify(
                        "Choose a destination screen in this button’s properties.",
                        true,
                      );
                  }}
                  onBind={(componentId, path) => {
                    const component = screen.components.find(
                      (item) => item.id === componentId,
                    );
                    if (component && (component.type === "value" || component.type === "gauge" || isProcessDisplay(component.type)))
                      updateComponent(componentId, {
                        props: { ...component.props, ...tagBindingPatch(component, path) },
                      });
                  }}
                />
              )}
              <div className="canvas-bottom">
                <span>
                  <Icon name={preview ? "play" : "move"} size={13} />
                  {preview
                    ? "Preview uses current unsaved screen changes"
                    : selection.length > 1
                      ? `${selection.length} selected · Drag together · Arrows nudge · Shift+arrows move 10 px`
                    : selected
                      ? `${selected.type.charAt(0).toUpperCase() + selected.type.slice(1)} selected · Drag to move`
                      : "Select a component to edit its properties"}
                </span>
                <span>
                  <span className="status-dot" />
                  {tags.filter((tag) =>
                    tag.source?.toLowerCase().includes("sim"),
                  ).length
                    ? "Sample data is simulated"
                    : `${tags.length} tags available`}
                </span>
              </div>
            </section>

            {!preview && designerPanes.separator(1)}
            {!preview && (
              <aside id="designer-properties-panel" className={`inspector${selected ? " property-sheet-inspector" : ""}`}>
                <div className="inspector-heading">
                  <Icon name="settings" size={15} />
                  <strong>Properties</strong>
                  <span>
                    {selection.length > 1 && !selected ? "SELECTION" : selected
                      ? "COMPONENT"
                      : editingTemplate
                        ? "TEMPLATE"
                        : screen ? "SCREEN" : "NO SELECTION"}
                  </span>
                </div>
                {searchLocation?.property && searchLocation.id === screen?.id && searchLocation.componentId === selected?.id && <div className="inspector-section search-location" role="status"><small>Search location</small><code>{searchLocation.property}</code><button type="button" aria-label="Dismiss search location" onClick={() => setSearchLocation(null)}>×</button></div>}
                {inspectingSearchComponent && selection.length > 1 && <div className="inspector-section"><p>Inspecting {selected?.props.text || selectedId} within the selected group. Canvas move, duplicate and delete commands still affect the group.</p></div>}
                {selection.length > 1 && !selected ? (
                  <div className="inspector-section multi-selection-panel">
                    <h3>{selectedGroupId ? "Group" : "Selection"} · {selection.length} components</h3>
                    <p>{selectedGroupId ? "Drag any member to move the group. Drag the group's bottom-right handle to scale its component positions and sizes. Ungroup to edit individual controls." : "Drag any selected control to move the selection. Align and Distribute treat each saved group as one unit."}</p>
                    {selectedGroupId && <p>Font sizes stay authored. Layout bindings override these values in Preview.</p>}
                    <ul>{selection.map((component) => <li key={component.id}>{component.props.text || component.type}</li>)}</ul>
                    <button className="button" onClick={duplicateSelection}><Icon name="copy" size={14} /> Duplicate selection</button>
                    <button className="button" disabled={Boolean(selectedGroupId)} onClick={groupSelection}><Icon name="layers" size={14} /> Group selection</button>
                    <button className="button" disabled={!selection.some(component => component.groupId)} onClick={ungroupSelection}>Ungroup selection</button>
                    <p>Drag empty canvas to select intersecting controls; Shift/Ctrl adds to selection. Groups select, move, copy and delete together. Ctrl+G groups; Ctrl+Shift+G ungroups. Arrow keys move 1 px; Shift+arrows move 10 px. Ctrl+A selects all, Ctrl+D duplicates, Delete removes, Ctrl+Z undoes and Ctrl+Y redoes.</p>
                    <p>Distribution keeps the outside edges fixed and needs enough room for non-overlapping gaps.</p>
                  </div>
                ) : selected ? (
                  <>
                    <div className="inspector-selection">
                      <span className="palette-icon">
                        <Icon name={typeIcon[selected.type]} size={20} />
                      </span>
                      <div>
                        <strong>{selected.props.text || selected.type}</strong>
                        <small>
                          {selected.type.charAt(0).toUpperCase() +
                            selected.type.slice(1)}{" "}
                          component
                        </small>
                      </div>
                      <button
                        className="icon-button"
                        title={selection.length > 1 ? "Delete selected group" : "Delete component"}
                        aria-label={selection.length > 1 ? "Delete selected group" : "Delete component"}
                        onClick={deleteSelection}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </div>
                    <ComponentStyleAssignment component={selected} styles={project.styles} onChange={updateProps} onManage={() => setStylesEditorOpen(true)} />
                    <ComponentTranslationAssignment component={selected} catalog={project.localization} onChange={updateProps} onManage={() => setTranslationsOpen(true)} />
                    <PropertyBindingsEditor
                      key={selected.id}
                      component={selected}
                      components={screen?.components || []}
                      tags={tags}
                      parameters={editorParameters}
                      queries={queries}
                      inputs={currentPreviewInputs}
                      state={applicationState.values}
                      allowUnresolvedScreenState={Boolean(editingTemplate)}
                      communicationLost={!connected}
                      parameterTemplate={project.templates?.find(item => item.id === selected.props.templateId)}
                      notify={notify}
                      onChange={updateProps}
                      onGeometryChange={patch => updateComponent(selected.id, patch)}
                    />
                    <div className="inspector-section">
                      <h3>Component events</h3>
                      <button type="button" className="button component-lifecycle-open" onClick={() => setLifecycleEventEditorId(selected.id)}>
                        Edit lifecycle &amp; property events ({Object.values(selected.props.componentEvents || {}).filter(event => event?.code?.trim()).length})
                      </button>
                      <p className="component-lifecycle-hint">Automatic browser scripts for mounted, watched property changes and cleanup. User input events remain separate.</p>
                    </div>
                    {isDrawingComponent(selected.type) && <DrawingEditor key={`drawing:${selected.id}`} component={selected} onChange={updateProps} notify={notify} />}
                    {isTemplateInstance(selected.type) && (
                      <div className="inspector-section">
                        <h3>Reusable template</h3>
                        <Field label="Template">
                          <select
                            value={selected.props.templateId || ""}
                            onChange={(event) =>
                              updateProps({
                                templateId: event.target.value,
                                parameters: {},
                                parameterBindings: {},
                                ...(selected.type === "repeater"
                                  ? { rows: [], rowsSource: selected.props.rowsSource ? { ...selected.props.rowsSource, parameterMap: {} } : undefined }
                                  : {}),
                              })
                            }
                          >
                            <option value="">Choose template…</option>
                            {(project.templates || []).map((item) => (
                              <option key={item.id} value={item.id} disabled={Boolean(editingTemplate && templatePlacementError(project.templates || [], editingTemplate.id, item.id))}>
                                {item.name}{editingTemplate && templatePlacementError(project.templates || [], editingTemplate.id, item.id) ? " (cannot nest here)" : ""}
                              </option>
                            ))}
                          </select>
                        </Field>
                        {selected.props.templateId && (
                          <button
                            className="button template-open-button"
                            onClick={() =>
                              openTemplate(selected.props.templateId!)
                            }
                          >
                            <Icon name="layers" size={14} /> Edit shared
                            template
                          </button>
                        )}
                        {selected.type === "repeater" && (
                          <>
                            <Field label="Row source">
                              <select aria-label="Repeater row source" value={selected.props.rowsSource ? "query" : "saved"} onChange={event => updateProps({
                                rows: [], rowsSource: event.target.value === "query"
                                  ? { queryId: queries.find(query => query.kind !== "update")?.id || "", rowKey: "row_id", parameterMap: {} }
                                  : undefined,
                              })}>
                                <option value="saved">Saved rows</option>
                                <option value="query" disabled={Boolean(editingTemplate)}>Named query</option>
                              </select>
                            </Field>
                            {editingTemplate && <p className="template-property-note">Nested repeaters use saved rows. Place a named-query repeater directly on a screen, then nest forms inside its row template.</p>}
                            <div className="field-grid">
                              <Field label="Columns">
                                <input
                                  type="number"
                                  min={1}
                                  max={12}
                                  value={selected.props.columns ?? 1}
                                  onChange={(event) =>
                                    updateProps({
                                      columns: Math.max(
                                        1,
                                        Math.min(
                                          12,
                                          Math.trunc(
                                            Number(event.target.value) || 1,
                                          ),
                                        ),
                                      ),
                                    })
                                  }
                                />
                              </Field>
                              <Field label="Gap (px)">
                                <input
                                  type="number"
                                  min={0}
                                  max={64}
                                  value={selected.props.gap ?? 16}
                                  onChange={(event) =>
                                    updateProps({
                                      gap: Math.max(
                                        0,
                                        Math.min(
                                          64,
                                          Number(event.target.value) || 0,
                                        ),
                                      ),
                                    })
                                  }
                                />
                              </Field>
                            </div>
                            {selected.props.rowsSource ? <>
                              <Field label="Rows query">
                                <select aria-label="Repeater rows query" value={selected.props.rowsSource.queryId} onChange={event => updateProps({ rowsSource: { ...selected.props.rowsSource!, queryId: event.target.value } })}>
                                  <option value="">Choose query…</option>
                                  {queries.filter(query => query.kind !== "update").map(query => <option key={query.id} value={query.id}>{query.name}</option>)}
                                </select>
                              </Field>
                              <Field label="Row key column" hint="Every returned row needs a unique text key. Include its revision in the key when an older row must no longer accept actions.">
                                <input aria-label="Repeater row key column" maxLength={128} value={selected.props.rowsSource.rowKey} onChange={event => updateProps({ rowsSource: { ...selected.props.rowsSource!, rowKey: event.target.value } })} />
                              </Field>
                              <h3>Parameter columns</h3>
                              {Object.keys(project.templates?.find(item => item.id === selected.props.templateId)?.parameters || {}).map(parameter => <Field key={parameter} label={parameter} hint="Query column name; leave blank to keep the saved parameter default.">
                                <input aria-label={`Query column for ${parameter}`} maxLength={128} value={selected.props.rowsSource!.parameterMap[parameter] || ""} onChange={event => {
                                  const parameterMap = { ...selected.props.rowsSource!.parameterMap };
                                  if (event.target.value) parameterMap[parameter] = event.target.value;
                                  else delete parameterMap[parameter];
                                  updateProps({ rowsSource: { ...selected.props.rowsSource!, parameterMap } });
                                }} />
                              </Field>)}
                              <p className="template-property-note">Up to 100 rows refresh every ten seconds and after actions. Query values are literal parameter values. Changed or removed rows reset their input forms. Popups keep the selected row context and require reopening if that row changes.</p>
                            </> : <>
                            <JsonEditor
                              label="Saved rows"
                              value={selected.props.rows || []}
                              rows={12}
                              onSave={(value) => {
                                if (!Array.isArray(value) || value.length > 100)
                                  throw new Error(
                                    "Rows must be a JSON array with at most 100 entries.",
                                  );
                                const keys = new Set<string>();
                                const definition = project.templates?.find(
                                  (item) =>
                                    item.id === selected.props.templateId,
                                );
                                const rows = value.map((row) => {
                                  if (
                                    !row ||
                                    typeof row !== "object" ||
                                    typeof row.id !== "string" ||
                                    !row.id.trim() ||
                                    keys.has(row.id)
                                  )
                                    throw new Error(
                                      "Each row needs a unique, nonempty id.",
                                    );
                                  keys.add(row.id);
                                  const parameters = textParameters(
                                    row.parameters,
                                  );
                                  if (
                                    Object.keys(parameters).some(
                                      (key) =>
                                        !Object.hasOwn(
                                          definition?.parameters || {},
                                          key,
                                        ),
                                    )
                                  )
                                    throw new Error(
                                      "Row parameters must be declared by the template.",
                                    );
                                  return { id: row.id, parameters };
                                });
                                updateProps({ rows });
                              }}
                              notify={notify}
                            />
                            <p className="template-property-note">
                              Example:{" "}
                              <code>
                                {
                                  '[{"id":"row1","parameters":{"machine":"WC1"}}]'
                                }
                              </code>
                              . Each row has independent input values. Rows are
                              saved with the project.
                            </p>
                            </>}
                          </>
                        )}
                      </div>
                    )}
                    {!isTemplateInstance(selected.type) && !isProcessDisplay(selected.type) && (!isDrawingComponent(selected.type) || selected.type === "equipmentSymbol") && <div className="inspector-section">
                      <h3>Content</h3>
                      {selected.type === "multiStateIndicator" && <StateControlEditor key={selected.id} component={selected} onChange={updateProps} notify={notify} />}
                      {selected.type === "image" && (
                        <>
                          <AssetPicker
                            assets={assets}
                            selected={selected.props.assetId}
                            onSelect={(assetId) => updateProps({ assetId })}
                            onUploaded={(asset) =>
                              setAssets((previous) => [
                                ...previous.filter(
                                  (item) => item.id !== asset.id,
                                ),
                                asset,
                              ])
                            }
                            notify={notify}
                          />
                          <Field label="Image fit">
                            <select
                              value={selected.props.fit || "contain"}
                              onChange={(event) =>
                                updateProps({
                                  fit: event.target.value as
                                    "contain" | "cover" | "fill",
                                })
                              }
                            >
                              <option value="contain">
                                Contain · show entire image
                              </option>
                              <option value="cover">
                                Cover · crop to fill
                              </option>
                              <option value="fill">Stretch to fill</option>
                            </select>
                          </Field>
                        </>
                      )}
                      {selected.type === "icon" && (
                        <>
                          <div className="icon-picker-preview">
                            <Icon
                              name={selected.props.icon || "spark"}
                              size={42}
                            />
                          </div>
                          <Field label="Built-in icon">
                            <select
                              value={selected.props.icon || "spark"}
                              onChange={(event) =>
                                updateProps({ icon: event.target.value })
                              }
                            >
                              {iconNames.map((name) => (
                                <option key={name} value={name}>
                                  {name.charAt(0).toUpperCase() + name.slice(1)}
                                </option>
                              ))}
                            </select>
                          </Field>
                        </>
                      )}
                      {(selected.type === "image" ||
                        selected.type === "icon") && (
                        <Field
                          label="Accessible description"
                          hint="Describe the image or symbol. Supports {parameter} text."
                        >
                          <input
                            value={selected.props.alt || ""}
                            onChange={(event) =>
                              updateProps({ alt: event.target.value })
                            }
                          />
                        </Field>
                      )}
                      {(selected.type === "value" ||
                        selected.type === "gauge") && (
                        <Field label="Unit">
                          <input
                            placeholder="e.g. rpm, °C, units"
                            value={selected.props.unit || ""}
                            onChange={(event) =>
                              updateProps({ unit: event.target.value })
                            }
                          />
                        </Field>
                      )}
                      {(selected.type === "gauge" ||
                        ["numberInput", "spinner", "slider"].includes(selected.type)) && (
                        <div className="field-grid">
                          <Field label="Minimum">
                            <input
                              type="number"
                              value={selected.props.min ?? 0}
                              onChange={(event) =>
                                updateProps({ min: Number(event.target.value) })
                              }
                            />
                          </Field>
                          <Field label="Maximum">
                            <input
                              type="number"
                              value={selected.props.max ?? 100}
                              onChange={(event) =>
                                updateProps({ max: Number(event.target.value) })
                              }
                            />
                          </Field>
                        </div>
                      )}
                      {["numberInput", "spinner", "slider"].includes(selected.type) && (
                        <Field label="Step" hint="Increment used by the control. Actions accept any valid value in range.">
                          <input type="number" min="0.000001" step="any" value={selected.props.step ?? (selected.type === "numberInput" ? "" : 1)} placeholder="Any" onChange={(event) => updateProps({ step: event.target.value === "" ? undefined : Number(event.target.value) })} />
                        </Field>
                      )}
                      {isInput(selected.type) && (
                        <>
                          <Field
                            label="Field name"
                            hint="Available to button events as inputs['fieldName']."
                          >
                            <input
                              value={selected.props.fieldKey || ""}
                              placeholder="setpoint"
                              onChange={(event) =>
                                updateProps({ fieldKey: event.target.value })
                              }
                            />
                          </Field>
                          {selected.type === "passwordInput" ? (
                            <p className="template-property-note">Password fields always start empty. Operators enter a masked form value; no password is saved as a project default.</p>
                          ) : selected.type === "multiStateButton" ? (
                            <StateControlEditor key={selected.id} component={selected} onChange={updateProps} notify={notify} />
                          ) : (selected.type === "list" || selected.type === "treeView") && !selected.props.optionsSource ? (
                            <ListTreeOptionsEditor key={selected.id} component={selected} onChange={updateProps} notify={notify} />
                          ) : selected.type === "checkbox" || selected.type === "toggle" ? (
                            <Field label="Default value">
                              <select
                                value={String(
                                  selected.props.defaultValue === true,
                                )}
                                onChange={(event) =>
                                  updateProps({
                                    defaultValue: event.target.value === "true",
                                  })
                                }
                              >
                                <option value="false">Unchecked</option>
                                <option value="true">Checked</option>
                              </select>
                            </Field>
                          ) : selected.type === "textArea" ? (
                            <Field label="Default value"><textarea rows={4} maxLength={4096} value={String(selected.props.defaultValue ?? "")} onChange={(event) => updateProps({ defaultValue: event.target.value })} /></Field>
                          ) : (
                            <Field label="Default value">
                              <input
                                type={
                                  ["numberInput", "spinner", "slider"].includes(selected.type)
                                    ? "number"
                                    : selected.type === "dateTimeInput" ? "datetime-local" : "text"
                                }
                                step={selected.type === "dateTimeInput" ? 60 : "any"}
                                value={String(
                                  selected.props.defaultValue ?? "",
                                )}
                                onChange={(event) =>
                                  updateProps({
                                    defaultValue:
                                      ["numberInput", "spinner", "slider"].includes(selected.type)
                                        ? Number(event.target.value)
                                        : event.target.value,
                                  })
                                }
                              />
                            </Field>
                          )}
                          {selected.type === "dateTimeInput" && <p className="template-property-note">Local wall-clock time, to the minute. No timezone conversion is applied.</p>}
                          {["select", "list", "treeView"].includes(selected.type) && <Field label="Option source" hint="Named queries populate choices without changing the current selection or other edited fields on refresh.">
                            <select value={selected.props.optionsSource ? "query" : "static"} onChange={event => updateProps({
                              optionsSource: event.target.value === "query" ? { queryId: queries.find(query => query.kind !== "update")?.id || "", valueColumn: "id", labelColumn: "name", ...(selected.type === "treeView" ? { parentColumn: "parent_id" } : {}) } : undefined,
                              defaultValue: event.target.value === "query" ? "" : selected.props.options?.[0]?.value,
                              selectionFields: undefined,
                            })}>
                              <option value="static">Static options</option>
                              <option value="query">Named query</option>
                            </select>
                          </Field>}
                          {["select", "list", "treeView"].includes(selected.type) && selected.props.optionsSource && <>
                            <Field label="Options query">
                              <select value={selected.props.optionsSource.queryId} onChange={event => updateProps({ optionsSource: { ...selected.props.optionsSource!, queryId: event.target.value } })}>
                                <option value="">Select query…</option>
                                {queries.filter(query => query.kind !== "update").map(query => <option key={query.id} value={query.id}>{query.name}</option>)}
                              </select>
                            </Field>
                            <Field label="Option value column" hint="A unique, nonempty value for each choice."><input maxLength={128} value={selected.props.optionsSource.valueColumn} onChange={event => updateProps({ optionsSource: { ...selected.props.optionsSource!, valueColumn: event.target.value } })} /></Field>
                            <Field label="Option label column"><input maxLength={128} value={selected.props.optionsSource.labelColumn} onChange={event => updateProps({ optionsSource: { ...selected.props.optionsSource!, labelColumn: event.target.value } })} /></Field>
                            {selected.type === "treeView" && <Field label="Parent value column" hint="Required. Each parent must match another option value; null or empty values identify roots."><input aria-label="Tree parent column" maxLength={128} value={selected.props.optionsSource.parentColumn || ""} onChange={event => updateProps({ optionsSource: { ...selected.props.optionsSource!, parentColumn: event.target.value } })} /></Field>}
                            <p className="muted">When the operator chooses an option, fill these fields from the selected query row. Blank mappings leave fields unchanged.</p>
                            {screen?.components.filter(item => isInput(item.type) && item.id !== selected.id).map(input => {
                              const field = input.props.fieldKey || input.id;
                              return <Field key={field} label={input.props.text || field}><input maxLength={128} placeholder="Column name (optional)" value={selected.props.selectionFields?.[field] || ""} onChange={event => {
                                const mapping = { ...selected.props.selectionFields };
                                if (event.target.value) mapping[field] = event.target.value;
                                else delete mapping[field];
                                updateProps({ selectionFields: mapping });
                              }} /></Field>;
                            })}
                          </>}
                          {(selected.type === "radioGroup" || selected.type === "select" && !selected.props.optionsSource) && (
                            <Field
                              label="Options"
                              hint="One option per line: Label | value"
                            >
                              <textarea
                                key={selected.id}
                                rows={5}
                                defaultValue={(selected.props.options || [])
                                  .map(
                                    (option) =>
                                      `${option.label} | ${option.value}`,
                                  )
                                  .join("\n")}
                                onBlur={(event) =>
                                  updateProps({
                                    options: event.target.value
                                      .split("\n")
                                      .filter((line) => line.trim())
                                      .map((line) => {
                                        const [label, ...value] =
                                          line.split("|");
                                        return {
                                          label: label.trim(),
                                          value: value.length
                                            ? value.join("|").trim()
                                            : label.trim(),
                                        };
                                      }),
                                  })
                                }
                              />
                            </Field>
                          )}
                          {selected.type !== "passwordInput" && <Field
                            label="Initial value tag (optional)"
                            hint="Read a tag’s value before the operator edits this field. Submitting a button event controls writing."
                          >
                            <input
                              value={selected.props.tagPath || ""}
                              placeholder="[default]Application/Setpoint"
                              onChange={(event) =>
                                updateProps({ tagPath: event.target.value })
                              }
                            />
                          </Field>}
                        </>
                      )}
                      {isInput(selected.type) && <Field label="Input events" hint="Browser JavaScript runs on user edits and commits. Apply, then Save and Publish.">
                        <button className="button input-events-open" onClick={() => setInputEventEditorId(selected.id)}><Icon name="code" size={14} /> Edit events ({Object.keys(selected.props.events || {}).length})</button>
                      </Field>}
                      {(selected.type === "button" || selected.type === "equipmentSymbol") && (
                        <Field label="On click">
                          <select
                            value={selected.props.action || (selected.type === "equipmentSymbol" ? "" : "navigate")}
                            onChange={(event) =>
                              updateProps({
                                action: (event.target.value || undefined) as CanvasComponent["props"]["action"],
                                parameters: undefined,
                                targetScreenId: undefined,
                                ...(event.target.value === "script"
                                  ? {
                                      script:
                                        selected.props.script ||
                                        "result = {'message': 'Action completed'}",
                                    }
                                  : {}),
                              })
                            }
                          >
                            {selected.type === "equipmentSymbol" && <option value="">None</option>}
                            <option value="navigate">Open a screen</option>
                            {selected.type === "button" && <option value="script">Run Python event</option>}
                            <option
                              value="openPopup"
                              disabled={
                                !editingTemplate && screen?.kind === "popup"
                              }
                            >
                              Open a popup
                            </option>
                            {selected.type === "button" && <option value="closePopup">Close popup</option>}
                          </select>
                        </Field>
                      )}
                      {(selected.type === "button" || selected.type === "equipmentSymbol" && Boolean(selected.props.action)) &&
                        selected.props.action !== "script" &&
                        selected.props.action !== "closePopup" && (
                          <Field
                            label={
                              selected.props.action === "openPopup"
                                ? "Popup screen"
                                : "Destination screen"
                            }
                          >
                            <select
                              value={selected.props.targetScreenId || ""}
                              onChange={(event) =>
                                updateProps({
                                  targetScreenId: event.target.value,
                                  parameters: undefined,
                                })
                              }
                            >
                              <option value="">Select screen…</option>
                              {project.screens
                                .filter((item) =>
                                  selected.props.action === "openPopup"
                                    ? item.kind === "popup"
                                    : item.kind !== "popup",
                                )
                                .map((item) => (
                                  <option key={item.id} value={item.id}>
                                    {item.name}
                                  </option>
                                ))}
                            </select>
                          </Field>
                        )}
                      {(selected.type === "button" || selected.type === "equipmentSymbol") &&
                        selected.props.action === "openPopup" && (
                          <JsonEditor
                            label="Popup parameter overrides"
                            value={selected.props.parameters || {}}
                            onSave={(value) => {
                              const parameters = textParameters(value);
                              const target = project.screens.find(
                                (item) =>
                                  item.id === selected.props.targetScreenId,
                              );
                              if (
                                Object.keys(parameters).some(
                                  (key) =>
                                    !Object.hasOwn(
                                      target?.parameters || {},
                                      key,
                                    ),
                                )
                              )
                                throw new Error(
                                  "Overrides must use parameters declared by the target popup screen.",
                                );
                              updateProps({ parameters });
                            }}
                            notify={notify}
                          />
                        )}
                      {selected.type === "button" &&
                        selected.props.action === "script" && (
                          <Field
                            label="onClick event · Python"
                            hint="Use inputs['fieldName'], parameters, and system.*. Publish to approve the event for operators."
                          >
                            <button className="button component-event-open" onClick={() => setEventEditorId(selected.id)}><Icon name="code" size={15} /> Edit onClick event</button>
                            <pre className="component-event-summary">{selected.props.script?.trim() || "No script authored."}</pre>
                          </Field>
                        )}
                      {selected.type === "table" && (
                        <><Field label="Named query">
                          <select
                            value={selected.props.queryId || ""}
                            onChange={(event) =>
                              updateProps({ queryId: event.target.value })
                            }
                          >
                            <option value="">Select query…</option>
                            {queries.filter(query => query.kind !== "update").map((query) => (
                              <option key={query.id} value={query.id}>
                                {query.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Rows per page" hint="Page through the rows already loaded by the query. This does not change the query's result limit."><TablePageSizeEditor key={selected.id} value={selected.props.pageSize} onChange={pageSize => updateProps({ pageSize })} notify={notify} /></Field>
                        <TableColumnsEditor key={`${selected.id}:${JSON.stringify(selected.props.tableColumns)}`} component={selected} onChange={updateProps} notify={notify} />
                        <Field label="Unique row column" hint="A stable primary key, usually id."><input value={selected.props.rowKey || ""} onChange={event => updateProps({rowKey:event.target.value})} /></Field>
                        <TableEditingEditor key={`${selected.id}:${JSON.stringify([selected.props.queryId, selected.props.rowKey, selected.props.tableEdit])}`} component={selected} onChange={updateProps} notify={notify} />
                        <p className="muted">Select a table row to fill these form fields. Enter the source column name for each field.</p>
                        {screen?.components.filter(item => isInput(item.type)).map(input => {
                          const field=input.props.fieldKey || input.id;
                          return <Field key={field} label={input.props.text || field}><input placeholder="Column name (optional)" value={selected.props.selectionFields?.[field] || ""} onChange={event => { const mapping={...selected.props.selectionFields}; if (event.target.value) mapping[field]=event.target.value; else delete mapping[field]; updateProps({selectionFields:mapping, rowKey:selected.props.rowKey || "id"}); }} /></Field>;
                        })}</>
                      )}
                    </div>}
                    {(selected.type === "value" ||
                      selected.type === "gauge") && (
                      <div className="inspector-section">
                        <h3>
                          <Icon name="link" size={14} />
                          Tag binding<span className="mini-badge">LIVE</span>
                        </h3>
                        <Field label="Tag path" hint={selected.props.bindings?.tagPath ? "Controlled by the Tag path binding in the property sheet. Use its binding button to edit." : undefined}>
                          <textarea
                            className="binding-input"
                            disabled={Boolean(selected.props.bindings?.tagPath)}
                            rows={3}
                            value={selected.props.tagPath || ""}
                            placeholder="[default]Line/{line}/Speed"
                            onChange={(event) =>
                              updateProps({ tagPath: event.target.value })
                            }
                          />
                        </Field>
                        <div className="binding-help">
                          Use <code>{"{parameter}"}</code> for tag indirection.
                          Context values resolve the path at runtime.
                        </div>
                        <div className="resolved-binding">
                          <span>RESOLVED PATH</span>
                          <code>
                            {resolvePath(
                              selected.props.tagPath || "",
                              editorParameters,
                            ) || "No tag selected"}
                          </code>
                          <div>
                            <span
                              className={`status-dot ${tags.some((tag) => tag.path === resolvePath(selected.props.tagPath || "", editorParameters)) ? "" : "offline"}`}
                            />
                            {displayValue(
                              tags.find(
                                (tag) =>
                                  tag.path ===
                                  resolvePath(
                                    selected.props.tagPath || "",
                                    editorParameters,
                                  ),
                              )?.value,
                            )}{" "}
                            <small>{selected.props.unit || ""}</small>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="inspector-selection">
                      <span className="palette-icon">
                        <Icon name="monitor" size={20} />
                      </span>
                      <div>
                        <strong>{screen?.name || "Nothing selected"}</strong>
                        <small>
                          {editingTemplate
                            ? "Shared template settings"
                            : screen ? "Screen settings" : "Open a screen or template"}
                        </small>
                      </div>
                    </div>
                    {screen && <DocumentProperties
                      key={`${editingTemplate ? "template" : "screen"}:${screen.id}`}
                      document={screen}
                      templates={project.templates}
                      isTemplate={Boolean(editingTemplate)}
                      parentParameters={project.parameters}
                      canChangeToPopup={screen.kind === "popup" || project.screens.filter(item => item.kind !== "popup").length > 1}
                      onChange={patch => updateScreen(current => ({ ...current, ...patch }))}
                      onRename={() => previewResourceChange({ action: "rename", target: { kind: editingTemplate ? "template" : "screen", id: screen.id }, name: screen.name })}
                      notify={notify}
                    />}
                    {screen && <div className="inspector-section">
                      <button
                        className="button danger subtle"
                        disabled={
                          !screen || !editingTemplate &&
                          screen?.kind !== "popup" &&
                          project.screens.filter(
                            (item) => item.kind !== "popup",
                          ).length < 2
                        }
                        onClick={() => previewResourceChange({ action: "delete", target: { kind: editingTemplate ? "template" : "screen", id: screen.id } })}
                      >
                        <Icon name="trash" size={15} />
                        {editingTemplate ? "Delete template" : "Delete screen"}
                      </button>
                    </div>}
                    <div className="inspector-tip">
                      <span className="tip-icon">
                        <Icon name="spark" size={18} />
                      </span>
                      <strong>Make it your own</strong>
                      <p>
                        Choose a component from the palette, connect a tag, and
                        preview your application.
                      </p>
                      <button onClick={() => setLeftTab("components")}>
                        Browse components <Icon name="arrow" size={12} />
                      </button>
                    </div>
                  </>
                )}
              </aside>
            )}
          </div>
        )}
        {gatewayAdmin && project && workspace === "tags" && (
          <Tags
            connections={connections}
            tags={tags}
            onTagsChanged={() => {
              void api<Tag[]>("/tags")
                .then(setTags)
                .catch(() => {});
            }}
            notify={notify}
          />
        )}
        {gatewayAdmin && project && workspace === "connections" && (
          <Connections
            connections={connections}
            onChange={setConnections}
            onTagsChanged={() => {
              void api<Tag[]>("/tags").then(setTags);
            }}
            notify={notify}
          />
        )}
        {project && (workspace === "queries" || queriesVisited) && <div style={{ display: workspace === "queries" ? "contents" : "none" }}>
          <Queries
            queries={queries}
            canRunUpdates={gatewayAdmin}
            connections={connections}
            onChange={setQueries}
            parameters={project.parameters}
            notify={notify}
            onDirtyChange={setQueriesDirty}
            navigationRequest={queryNavigation}
            onNavigationHandled={() => setQueryNavigation(undefined)}
            onSearchResources={setSearchQueries}
          />
        </div>}
        {project && (workspace === "scripts" || scriptsVisited) && <div style={{display:workspace === "scripts" ? "contents" : "none"}}><Suspense fallback={<div className="management-page">Loading scripting workspace…</div>}>
          <Scripts
            parameters={project.parameters}
            pythonAvailable={health?.pythonAvailable || false}
            notify={notify}
            onDirtyChange={setScriptsDirty}
            navigationRequest={scriptNavigation}
            onNavigationHandled={() => setScriptNavigation(undefined)}
            onSearchResources={receiveScriptDraft}
            onSearchError={setSearchScriptsError}
            onSearchLoading={setSearchScriptsLoading}
          />
        </Suspense></div>}
        <footer className="statusbar">
          <span>
            <span className={`status-dot ${connected ? "" : "offline"}`} />
            {connected ? "Gateway connected" : "Gateway unavailable"}
          </span>
          <span>
            <Icon name="activity" size={12} />
            {tags.length} tags
          </span>
          <span>
            <Icon name="clock" size={12} />
            {lastUpdate ? `Updated ${lastUpdate}` : "Awaiting values"}
          </span>
          <span className="statusbar-spacer" />
          <span>SPARKSTUDIO</span>
          <span className="statusbar-version">EARLY PREVIEW</span>
        </footer>
      </div>
      {lifecycleEventEditorId && screen?.components.find(component => component.id === lifecycleEventEditorId) && <ComponentLifecycleEditor
        key={lifecycleEventEditorId}
        component={screen.components.find(component => component.id === lifecycleEventEditorId)!}
        components={screen.components}
        inputs={currentPreviewInputs}
        parameters={editorParameters}
        instanceStateAvailable={Boolean(editingTemplate)}
        onApply={events => {
          const component = screen.components.find(item => item.id === lifecycleEventEditorId);
          if (component && JSON.stringify(events) !== JSON.stringify(component.props.componentEvents || {})) updateComponent(component.id, { props: { ...component.props, componentEvents: Object.keys(events).length ? events : undefined } });
          setLifecycleEventEditorId(null);
        }}
        onClose={() => setLifecycleEventEditorId(null)}
      />}
      {inputEventEditorId && screen?.components.find(component => component.id === inputEventEditorId) && <InputEventsEditor
        key={inputEventEditorId}
        component={screen.components.find(component => component.id === inputEventEditorId)!}
        components={screen.components}
        inputs={currentPreviewInputs}
        parameters={editorParameters}
        instanceStateAvailable={Boolean(editingTemplate)}
        onApply={events => {
          const component = screen.components.find(item => item.id === inputEventEditorId);
          if (component && JSON.stringify(events || {}) !== JSON.stringify(component.props.events || {})) updateComponent(component.id, {props:{...component.props,events}});
          setInputEventEditorId(null);
        }}
        onClose={() => setInputEventEditorId(null)}
      />}
      {eventEditorId && screen?.components.find(component => component.id === eventEditorId) && <ComponentEventEditor
        key={eventEditorId}
        component={screen.components.find(component => component.id === eventEditorId)!}
        inputs={currentPreviewInputs}
        parameters={editorParameters}
        onApply={(script) => {
          const component = screen.components.find(item => item.id === eventEditorId);
          if (component && script !== (component.props.script || "")) updateComponent(component.id, { props: { ...component.props, script } });
          setEventEditorId(null);
        }}
        onClose={() => setEventEditorId(null)}
      />}
      {gatewayAdmin && projectImportOpen && <ProjectImportDialog onClose={() => setProjectImportOpen(false)} />}
      {accountSettingsOpen && <AccountSettingsDialog hasUnsavedChanges={dirty || queriesDirty || scriptsDirty} onClose={() => setAccountSettingsOpen(false)} />}
      {searchOpen && project && <ProjectSearch entries={searchEntries} onOpen={navigateSearch} onClose={() => setSearchOpen(false)} scriptsLoading={searchScriptsLoading} scriptsError={searchScriptsError}
        onReplace={find => { setSearchOpen(false); setBulkReplaceFind(find); }} />}
      {bulkReplaceFind !== null && project && <BulkReplaceDialog project={project} initialFind={bulkReplaceFind}
        onClose={() => setBulkReplaceFind(null)} onOpenReference={navigateSearch}
        onApply={(plan, selectedIds) => {
          if (previewActionBusy) throw new Error("Wait for the current preview action to finish before applying replacements.");
          change(current => applyBulkReplacement(plan, current, selectedIds));
          setBulkReplaceFind(null);
          notify(`${selectedIds.length} properties replaced in the draft. Undo is available; save and publish when ready.`);
        }} />}
      {resourceChangePlan && <ResourceChangeDialog plan={resourceChangePlan}
        onNameChange={name => setResourceChangeContext(previous => previous && previous.request.action === "rename" ? { ...previous, request: { ...previous.request, name } } : previous)}
        onApply={commitResourceChange} onClose={closeResourceChange} onOpenReference={navigateSearch}
        loading={resourceChangeLoading || scriptsEditorReady && searchScriptsLoading}
        loadError={resourceChangeError || (scriptsEditorReady ? searchScriptsError : "")}
        retryLabel={scriptsEditorReady && searchScriptsError ? "Open script workspace" : "Refresh preview"}
        onRetry={() => {
          if (scriptsEditorReady && searchScriptsError) { closeResourceChange(); setWorkspace("scripts"); notify("Reload script resources to check references again. Your current drafts are retained until you choose to reload.", true); }
          else if (resourceChangeContext) previewResourceChange(resourceChangeContext.request);
        }} />}
      {projectSettingsOpen && project && <ProjectSettingsDialog project={project} canRename={gatewayAdmin} notify={notify}
        onChange={patch => change(current => ({ ...current, ...patch }))} onClose={() => setProjectSettingsOpen(false)} />}
      {pendingNavigation && <UnsavedProjectNavigation onStay={() => setPendingNavigation(null)} onDiscard={() => {
        discardNavigation.current = true;
        window.location.assign(pendingNavigation);
      }} />}
      {project && previewPopup && !editorParameterError && (
        <Popup
          key={previewPopup.id}
          project={project}
          popup={previewPopup}
          tags={tags}
          communicationLost={!connected}
          queryScope="designer"
          onClose={() => {
            if (!previewActionBusy) setPreviewPopup(null);
          }}
          onBusyChange={(busy) => setPreviewActionBusy(busy ? "popup" : "")}
          onNavigate={(target) => {
            if (previewActionBusy) return;
            if (
              project.screens.some(
                (item) => item.id === target && item.kind !== "popup",
              )
            ) {
              setPreviewPopup(null);
              openDocument({ kind: "screen", id: target });
            }
          }}
          onExecute={async (action) => {
            if (previewCommunication.busy || !previewCommunication.session) throw new Error("A current preview communication session is required. Exit and reopen Preview.");
            if (action.instance?.isCurrent?.() === false) throw new Error("The template parameters changed before this action could run.");
            if (!gatewayAdmin) throw new Error("A gateway administrator must sign in to run draft Python code.");
            const result = await api<ScriptResult>("/scripts/run", "POST", {
              code: action.component.props.script || "",
              parameters: action.instance?.parameters || action.parameters,
              inputs: action.inputs,
            });
            if (action.instance?.isCurrent?.() === false) throw new Error("The template parameters changed while this action was running.");
            return result;
          }}
        />
      )}
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="status">
          <Icon name={toast.error ? "info" : "check"} size={18} />
          <span>{toast.message}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {stylesEditorOpen && project && <VisualStylesEditor project={project} onClose={() => setStylesEditorOpen(false)} onApply={(styles, expected) => {
        if (previewActionBusy) throw new Error("Wait for the active preview action to finish.");
        change(current => applyStyleCatalog(current, expected, styles)); setStylesEditorOpen(false);
      }} />}
      {publicationHistoryOpen && <PublicationHistoryDialog canPublish={permissions.publish} onClose={() => setPublicationHistoryOpen(false)} onRestored={() => notify("Operator publication restored. Designer drafts are unchanged.")} />}
      {translationsOpen && project && <TranslationsEditor project={project} onClose={() => setTranslationsOpen(false)} onApply={(catalog, expected) => {
        if (previewActionBusy) throw new Error("Wait for the active preview action to finish.");
        change(current => applyLocalizationCatalog(current, expected, catalog)); setTranslationsOpen(false);
      }} />}
      {diagnosticsOpen && project && <DesignerDiagnostics project={project} document={screen} ownerKind={editingTemplate ? "template" : "screen"}
        context={{ components: screen?.components || [], tags, parameters: editorParameters, inputs: currentPreviewInputs, state: applicationState.values, communicationLost: !connected }}
        searchEntries={searchEntries} eventCoordinator={applicationState.store.componentEvents} onOpen={navigateSearch} onClose={() => setDiagnosticsOpen(false)} />}
      {assetLibraryOpen && project && <AssetLibraryDialog project={project} assets={assets} onClose={() => setAssetLibraryOpen(false)}
        onOpenReference={use => { setAssetLibraryOpen(false); navigateSearch({ kind: use.ownerKind, id: use.ownerId, componentId: use.componentId }); }}
        onApply={(plan, ids) => {
          if (previewActionBusy) throw new Error("Wait for the active preview action to finish.");
          change(current => applyAssetReplacement(plan, current, assets, ids)); setAssetLibraryOpen(false); notify(`${ids.length} image references replaced. Undo is available; save and publish when ready.`);
        }} />}
    </div></ApplicationStateProvider></VisualStyleProvider></LocalizationProvider>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function textParameters(value: unknown): Record<string, string> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== "string")
  )
    throw new Error("Parameters must be a JSON object with text values.");
  return value as Record<string, string>;
}

function JsonEditor({
  label,
  value,
  onSave,
  notify,
  rows = 6,
}: {
  label: string;
  value: unknown;
  onSave: (value: unknown) => void;
  notify: (message: string, error?: boolean) => void;
  rows?: number;
}) {
  return (
    <Field label={label}>
      <textarea
        className="template-json-editor"
        spellCheck={false}
        rows={rows}
        key={JSON.stringify(value)}
        defaultValue={JSON.stringify(value, null, 2)}
        onBlur={(event) => {
          try {
            const next: unknown = JSON.parse(event.target.value);
            if (JSON.stringify(next) !== JSON.stringify(value)) onSave(next);
          } catch (error) {
            notify(
              error instanceof Error ? error.message : "Enter valid JSON.",
              true,
            );
          }
        }}
      />
    </Field>
  );
}

function Canvas({
  screen,
  tags,
  parameters,
  preview,
  selectedIds,
  gridSize,
  onSelect,
  onReplace,
  onKeyDown,
  onBeginMove,
  onNavigate,
  onBind,
  inputs,
  onInputChange,
  onAutomaticInputChange,
  onAction,
  onOpenPopup,
  onClosePopup,
  actionBusyId,
  templates,
  templateAncestors,
  scopedInputs,
  onScopedInputChange,
  communicationLost,
}: {
  screen: Screen;
  tags: Tag[];
  parameters: RuntimeParameters;
  preview: boolean;
  selectedIds: string[];
  gridSize: number;
  onSelect: (ids: string[]) => void;
  onReplace: (components: CanvasComponent[], recordHistory?: boolean) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onBeginMove: () => void;
  onNavigate: (screen: string) => void;
  onBind: (id: string, path: string) => void;
  inputs: InputValues;
  onInputChange: (fieldKey: string, value: InputValue) => void;
  onAutomaticInputChange: (fieldKey: string, value: InputValue) => void;
  onAction: (component: CanvasComponent, instance?: InstanceAction) => void;
  onOpenPopup: (component: CanvasComponent, instance?: InstanceAction) => void;
  onClosePopup: () => void;
  actionBusyId: string;
  templates: Template[];
  templateAncestors: string[];
  scopedInputs: Record<string, InputValues>;
  onScopedInputChange: (
    scope: string,
    fieldKey: string,
    value: InputValue,
  ) => void;
  communicationLost: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const applicationState = useApplicationStateContext();
  const queryProperties = useQueryPropertyBindings(screen.components, {
    components: screen.components, tags, parameters, inputs, communicationLost, state: applicationState?.values,
  }, { state: applicationState, scope: "designer", active: preview });
  const [scale, setScale] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [gestureBounds, setGestureBounds] = useState<SelectionBounds | null>(null);
  const [marquee, setMarquee] = useState<SelectionBounds | null>(null);
  const selectedComponents = screen.components.filter(component => selectedIds.includes(component.id));
  const selectedGroupId = selectedComponents.length > 1 && selectedComponents[0].groupId && selectedComponents.every(component => component.groupId === selectedComponents[0].groupId) ? selectedComponents[0].groupId : null;
  const groupBounds = selectedGroupId ? selectionBounds(selectedComponents) : null;
  const gestureCleanup = useRef<() => void>(() => {});
  useEffect(() => () => gestureCleanup.current(), [screen.id, preview]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const resize = () =>
      setScale(
        Math.min(1, Math.max(0.2, (host.clientWidth - 64) / screen.width)),
      );
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => observer.disconnect();
  }, [screen.width]);
  const selectArea = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (preview || event.button !== 0 || (event.target as HTMLElement).closest("[data-component-id]")) return;
    event.preventDefault();
    event.stopPropagation();
    gestureCleanup.current();
    hostRef.current?.focus({ preventScroll: true });
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const point = (x: number, y: number) => ({
      x: Math.max(0, Math.min(screen.width, (x - rect.left) / scale)),
      y: Math.max(0, Math.min(screen.height, (y - rect.top) / scale)),
    });
    const start = point(event.clientX, event.clientY);
    const existing = event.shiftKey || event.ctrlKey || event.metaKey ? selectedIds : [];
    const initial = selectedIds;
    onSelect(existing);
    let moved = false;
    element.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      if (!moved && Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) < 3) return;
      moved = true;
      const bounds = marqueeBounds(start, point(next.clientX, next.clientY));
      setMarquee(bounds);
      if (bounds) onSelect(marqueeSelection(screen.components, bounds, existing));
    };
    const end = (next?: PointerEvent) => {
      gestureCleanup.current = () => {};
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
      element.removeEventListener("lostpointercapture", end);
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      setMarquee(null);
      if (next?.type === "pointercancel") onSelect(initial);
    };
    gestureCleanup.current = end;
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
    element.addEventListener("lostpointercapture", end);
  };
  const drag = (
    event: ReactPointerEvent<HTMLDivElement>,
    component: CanvasComponent,
    resize: boolean | "group" = false,
  ) => {
    if (preview || event.button !== 0) return;
    if (
      (event.target as HTMLElement).closest("button,input,select,textarea") &&
      !resize
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    hostRef.current?.focus({ preventScroll: true });
    if (!resize && (event.shiftKey || event.ctrlKey || event.metaKey)) {
      onSelect(toggleGroupSelection(screen.components, selectedIds, component.id));
      return;
    }
    const movingIds = expandGroupSelection(screen.components, resize ? [component.id] : selectedIds.includes(component.id) ? selectedIds : [component.id]);
    const resizeBounds = resize === "group" ? selectionBounds(screen.components, movingIds) : null;
    onSelect(movingIds);
    gestureCleanup.current();
    const startX = event.clientX;
    const startY = event.clientY;
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    let moved = false;
    const move = (next: PointerEvent) => {
      const dx = (next.clientX - startX) / scale;
      const dy = (next.clientY - startY) / scale;
      if (!moved && Math.hypot(next.clientX - startX, next.clientY - startY) < 3) return;
      const nextComponents = resize === "group" && resizeBounds && component.groupId
        ? resizeGroup(screen.components, component.groupId, { width: resizeBounds.width + dx, height: resizeBounds.height + dy }, screen, gridSize)
        : resize
          ? screen.components.map((item) => item.id === component.id ? resizeComponent(component, { width: component.width + dx, height: component.height + dy }, screen, gridSize) : item)
        : moveSelected(screen.components, movingIds, { x: dx, y: dy }, screen, gridSize);
      if (!moved && !nextComponents.some((item, index) => {
        const original = screen.components[index];
        return item.x !== original.x || item.y !== original.y || item.width !== original.width || item.height !== original.height;
      })) return;
      if (!moved) { moved = true; onBeginMove(); setDragging(true); }
      setGestureBounds(selectionBounds(nextComponents, movingIds));
      onReplace(nextComponents, false);
    };
    const end = () => {
      gestureCleanup.current = () => {};
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
      element.removeEventListener("lostpointercapture", end);
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      setDragging(false);
      setGestureBounds(null);
    };
    gestureCleanup.current = end;
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
    element.addEventListener("lostpointercapture", end);
  };
  return (
    <QueryPropertyProvider value={queryProperties}><div
      className={`canvas-host ${dragging ? "dragging" : ""}`}
      ref={hostRef}
      tabIndex={preview ? -1 : 0}
      role="region"
      aria-label="Screen canvas"
      onKeyDown={(event) => { gestureCleanup.current(); onKeyDown(event); }}
      onPointerDown={(event) => { if (!preview && event.target === event.currentTarget) { onSelect([]); hostRef.current?.focus({ preventScroll: true }); } }}
    >
      <div className="canvas-page-label">
        <span>
          <Icon name="monitor" size={12} />
          {screen.name}
        </span>
        <span className="canvas-precision-readout">{!preview && gestureBounds && <span aria-hidden="true">X {Number(gestureBounds.x.toFixed(1))} · Y {Number(gestureBounds.y.toFixed(1))} · W {Number(gestureBounds.width.toFixed(1))} · H {Number(gestureBounds.height.toFixed(1))}</span>}{Math.round(scale * 100)}%</span>
      </div>
      <div
        className="canvas-scaler"
        style={{ width: screen.width * scale, height: screen.height * scale }}
      >
        <div
          className={`screen-canvas ${preview ? "runtime" : gridSize ? "snap-grid" : ""}`}
          key={`${screen.id}:${preview}`}
          onPointerDown={selectArea}
          style={{
            width: screen.width,
            height: screen.height,
            transform: `scale(${scale})`,
            "--edit-grid": `${gridSize}px`,
          } as CSSProperties}
        >
          {!screen.components.length && (
            <div className="empty-canvas">
              <Icon name="design" size={40} />
              <h2>Your next application starts here</h2>
              <p>
                Add a component from the palette to build your first screen.
              </p>
            </div>
          )}
          {screen.components.map((component) => (
            <div
              key={component.id}
              data-component-id={component.id}
              className={`canvas-component component-${component.type} ${!preview && selectedIds.includes(component.id) ? "is-selected" : ""}`}
              style={
                {
                  ...componentGeometry(component, {components:screen.components, tags, parameters, inputs, communicationLost, state: applicationState?.values, queryProperties}, preview),
                  "--component-accent":
                    component.props.color || "var(--accent)",
                  "--component-foreground": component.props.color
                    ? "#ffffff"
                    : "var(--on-accent)",
                } as CSSProperties
              }
              onClick={(event) => {
                event.stopPropagation();
              }}
              onPointerDown={(event) => drag(event, component)}
              onDragOver={(event) => {
                if (
                  !preview &&
                  (component.type === "value" || component.type === "gauge" || isProcessDisplay(component.type))
                )
                  event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const path = event.dataTransfer.getData("text/spark-tag");
                if (path && !preview && (component.type === "value" || component.type === "gauge" || isProcessDisplay(component.type))) {
                  onBind(component.id, path);
                  onSelect([component.id]);
                }
              }}
            >
              <ProjectComponentView
                component={component}
                components={screen.components}
                screenId={screen.id}
                templates={templates}
                templateAncestors={templateAncestors}
                scopedInputs={scopedInputs}
                onScopedInputChange={onScopedInputChange}
                communicationLost={communicationLost}
                tags={tags}
                parameters={parameters}
                preview={preview}
                onNavigate={onNavigate}
                inputs={inputs}
                onInputChange={onInputChange}
                onAutomaticInputChange={onAutomaticInputChange}
                onAction={onAction}
                onOpenPopup={onOpenPopup}
                onClosePopup={onClosePopup}
                actionBusyId={actionBusyId}
                interactionLocked={Boolean(actionBusyId)}
              />
              {!preview && !selectedGroupId && selectedIds.includes(component.id) && (
                <>
                  <span className="component-selection-label">
                    {component.type}
                  </span>
                  <span className="selection-corner top-left" />
                  <span className="selection-corner top-right" />
                  <span className="selection-corner bottom-left" />
                  {selectedIds.length === 1 && <div
                    className="resize-handle"
                    onPointerDown={(event) => drag(event, component, true)}
                    title="Drag to resize"
                  />}
                </>
              )}
            </div>
          ))}
          {!preview && selectedGroupId && groupBounds && <div className="canvas-group-bounds" data-group-id={selectedGroupId} style={{ left: groupBounds.x, top: groupBounds.y, width: groupBounds.width, height: groupBounds.height }}>
            <span className="component-selection-label">Group · {selectedComponents.length}</span>
            <span className="selection-corner top-left" /><span className="selection-corner top-right" /><span className="selection-corner bottom-left" />
            <div className="resize-handle group-resize-handle" title="Resize group proportionally on each axis" aria-label="Resize group" onPointerDown={event => drag(event, selectedComponents[0], "group")} />
          </div>}
          {marquee && !preview && <div className="canvas-marquee" aria-hidden="true" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} />}
          {gestureBounds && !preview && <div className="canvas-precision-guides" aria-hidden="true">
            <span className="vertical" style={{ left: gestureBounds.x }} /><span className="vertical" style={{ left: gestureBounds.x + gestureBounds.width }} />
            <span className="horizontal" style={{ top: gestureBounds.y }} /><span className="horizontal" style={{ top: gestureBounds.y + gestureBounds.height }} />
          </div>}
        </div>
      </div>
      <div className="canvas-footnote">
        {preview
          ? "LIVE APPLICATION PREVIEW"
          : `${gridSize ? `${gridSize} PX GRID` : "FREE POSITION"} · DRAG EMPTY CANVAS TO SELECT · ARROWS TO NUDGE`}
      </div>
    </div></QueryPropertyProvider>
  );
}
