import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { api, ApiError, eventStreamUrl, projectPage, resolvePath, scriptFailureMessage } from "./api";
import { useAuth } from "./Auth";
import { SessionIdentity } from "./OperatorAccess";
import { runtimePresentation } from "./operatorAccessModel";
import { ApplicationStateProvider, useApplicationState } from "./applicationState";
import { useFormInputs } from "./inputStateBindings";
import { ComponentEventDiagnostics } from "./ComponentEvents";
import {
  actionKey,
  componentContexts,
  ProjectComponentView,
} from "./templates";
import { ThemePicker } from "./Theme";
import { useBrowserScripts } from "./browserScripts";
import { componentGeometry } from "./propertyBindings";
import { QueryPropertyProvider, useQueryPropertyBindings } from "./useQueryPropertyBindings";
import { instanceRequestScope } from "./templateModel";
import { runtimeBindingHealth } from "./runtimeQuality";
import { runtimeMenuItems, runtimeScreenId } from "./runtimeNavigation";
import Icon from "./Icon";
import Popup from "./Popup";
import { createPopup, screenParameters } from "./popupModel";
import type {
  CanvasComponent,
  InputValues,
  InstanceAction,
  Project,
  PopupState,
  Publication,
  ScriptResult,
  Tag,
  TableCellEdit,
} from "./types";
import {
  inputsAfterContextChange,
  validateInputs,
} from "./inputs";

type PublishedProject = Project & { publishedAt?: string };
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function contextChoices(
  project: Project,
  tags: Tag[],
  parameters: Record<string, string>,
  key: string,
): string[] {
  const choices = new Set([parameters[key]]);
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const symbolic = { ...parameters, [key]: `{${key}}` };
  for (const item of project.screens
    .filter((screen) => screen.kind !== "popup")
    .flatMap((screen) =>
      componentContexts(
        screen.components,
        project.templates || [],
        screenParameters(screen, symbolic),
      ),
    )) {
    const path = item.component.props.tagPath
      ? resolvePath(item.component.props.tagPath, item.parameters)
      : undefined;
    if (!path?.includes(`{${key}}`)) continue;
    const marker = `{${key}}`;
    const others = Object.fromEntries(
      Object.entries(parameters).filter(([name]) => name !== key),
    );
    const parts = resolvePath(path, others).split(marker);
    if (parts.length !== 2) continue;
    const pattern = new RegExp(
      `^${escape(parts[0])}([^/]+)${escape(parts[1])}$`,
    );
    for (const tag of tags) {
      const match = tag.path.match(pattern);
      if (match) choices.add(match[1]);
    }
  }
  return [...choices]
    .filter(Boolean)
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    );
}

export default function OperatorRuntime() {
  const { permissions, gatewayAdmin } = useAuth();
  const showRuntimeControls = runtimePresentation(typeof window === "undefined" ? "" : window.location.search ?? "") === "controls";
  const canOperate = permissions.operate;
  const [project, setProject] = useState<PublishedProject | null>(null);
  const [screenId, setScreenId] = useState("");
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [tags, setTags] = useState<Tag[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [unpublished, setUnpublished] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [nextPublication, setNextPublication] = useState<Publication | null>(
    null,
  );
  const [now, setNow] = useState(new Date());
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [scale, setScale] = useState(1);
  const [inputsByScreen, setInputsByScreen] = useState<
    Record<string, InputValues>
  >({});
  const [actionBusyId, setActionBusyId] = useState("");
  const [actionStatus, setActionStatus] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const lastReceived = useRef(0);
  const currentProject = useRef<PublishedProject | null>(null);
  useEffect(() => () => { currentProject.current = null; }, []);
  const clearUnavailableProject = useCallback(() => {
    currentProject.current = null;
    setProject(null);
    setScreenId("");
    setPopup(null);
    setInputsByScreen({});
    setParameters({});
    setActionBusyId("");
    setActionStatus(null);
    setNextPublication(null);
    setNotice("");
    setUnpublished(true);
    setError("");
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const published = await api<PublishedProject>("/runtime/project");
      setProject(published);
      currentProject.current = published;
      setParameters(published.parameters);
      setInputsByScreen({});
      setActionStatus(null);
      setPopup(null);
      setScreenId(previous => runtimeScreenId(published, previous));
      setUnpublished(false);
      setNextPublication(null);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) clearUnavailableProject();
      else { setUnpublished(false); setError(errorMessage(reason)); }
    } finally {
      setLoading(false);
    }
  }, [clearUnavailableProject]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    let stopped = false;
    const receive = (next: Tag[]) => {
      if (stopped || !Array.isArray(next)) return;
      const received = new Date();
      lastReceived.current = received.getTime();
      setTags(next);
      setLastUpdate(received);
      setConnected(true);
    };
    const poll = () => {
      void api<Tag[]>("/tags")
        .then(receive)
        .catch(() => {
          if (!stopped) setConnected(false);
        });
    };
    poll();
    const events = new EventSource(eventStreamUrl());
    events.addEventListener("tags", (event) => {
      try {
        receive(JSON.parse((event as MessageEvent).data) as Tag[]);
      } catch {
        /* A later event or polling request can recover. */
      }
    });
    const polling = setInterval(poll, 4000);
    const clock = setInterval(() => {
      setNow(new Date());
      if (Date.now() - lastReceived.current > 8000) setConnected(false);
    }, 1000);
    const publicationCheck = setInterval(() => {
      void api<Publication>("/project/publication")
        .then((publication) => {
          if (!stopped && !publication.published) { clearUnavailableProject(); return; }
          if (
            !stopped &&
            publication.published &&
            currentProject.current &&
            (publication.publishedAt !== currentProject.current.publishedAt ||
              publication.revision !== currentProject.current.revision)
          )
            setNextPublication(publication);
        })
        .catch((reason) => {
          if (!stopped && reason instanceof ApiError && reason.status === 404) clearUnavailableProject();
          /* Other failures retain the view; live data status reports communications. */
        });
    }, 15000);
    return () => {
      stopped = true;
      events.close();
      clearInterval(polling);
      clearInterval(clock);
      clearInterval(publicationCheck);
    };
  }, [clearUnavailableProject]);
  useEffect(() => {
    const handleFullscreen = () =>
      setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleFullscreen);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreen);
  }, []);

  const screen = project?.screens.find(item => item.id === runtimeScreenId(project, screenId));
  const applicationState = useApplicationState(project, screen, JSON.stringify([project?.id, project?.revision, project?.publishedAt]));
  const menuItems = project ? runtimeMenuItems(project) : [];
  const activeParameters = screen
    ? screenParameters(screen, parameters)
    : parameters;
  useBrowserScripts(project, screen, setNotice, target => {
    if (actionBusyId || popup) return;
    if (project?.screens.some(item => item.id === target && item.kind !== "popup")) {
      setScreenId(target); setActionStatus(null);
    }
  }, applicationState.api, applicationState.key);
  const form = useFormInputs({ document: screen, tags, parameters: activeParameters, edits: screen ? inputsByScreen[screen.id] : undefined,
    communicationLost: !connected, state: applicationState, active: canOperate && !actionBusyId,
    onEdit: (fieldKey, value) => {
      if (screen) setInputsByScreen(previous => ({ ...previous, [screen.id]: { ...previous[screen.id], [fieldKey]: value } }));
    } });
  const currentInputs = form.inputs;
  const queryProperties = useQueryPropertyBindings(screen?.components ?? [], {
    components: screen?.components ?? [], tags, parameters: activeParameters, inputs: currentInputs,
    communicationLost: !connected, state: applicationState.values,
  }, { state: applicationState, scope: "runtime", publishedAt: project?.publishedAt, active: Boolean(project && screen) });
  const changeContext = (key: string, value: string) => {
    if (actionBusyId) return;
    const next = { ...parameters, [key]: value };
    setInputsByScreen((previous) =>
      inputsAfterContextChange(parameters, next, previous),
    );
    setParameters(next);
    setActionStatus(null);
    setPopup(null);
  };
  const runAction = async (
    component: CanvasComponent,
    instance?: InstanceAction,
  ) => {
    if (!canOperate || !screen || !project || actionBusyId || instance?.isCurrent?.() === false) return;
    const localInputs = instance?.inputs || currentInputs;
    const invalid = validateInputs(
      instance?.template || screen,
      localInputs,
      instance?.parameters || activeParameters,
    );
    if (invalid) {
      setActionStatus({ success: false, message: invalid });
      return;
    }
    setActionBusyId(actionKey(component.id, instance));
    setActionStatus(null);
    try {
      const execution = await api<ScriptResult>(
        `/runtime/screens/${encodeURIComponent(screen.id)}/components/${encodeURIComponent(component.id)}/action`,
        "POST",
        {
          parameters,
          inputs: localInputs,
          publishedAt: project.publishedAt,
          ...instanceRequestScope(instance),
        },
      );
      if (currentProject.current !== project || instance?.isCurrent?.() === false) return;
      const resultMessage =
        typeof execution.result === "object" &&
        execution.result !== null &&
        "message" in execution.result
          ? String((execution.result as { message: unknown }).message)
          : execution.stdout ||
            (execution.result === undefined
              ? "Action completed."
              : JSON.stringify(execution.result));
      setActionStatus({
        success: execution.success,
        message: (execution.success
          ? resultMessage
          : scriptFailureMessage(execution.stderr)
        ).slice(0, 2500),
      });
      if (execution.success) window.dispatchEvent(new Event("sparkstudio:refresh-data"));
    } catch (reason) {
      if (currentProject.current !== project || instance?.isCurrent?.() === false) return;
      if (reason instanceof ApiError && reason.status === 404) clearUnavailableProject();
      else if (reason instanceof ApiError && reason.status === 409) {
        setNextPublication({ published: true });
        setActionStatus({
          success: false,
          message:
            "The application version changed. Load the new version before running this action.",
        });
      } else setActionStatus({ success: false, message: errorMessage(reason) });
    } finally {
      setActionBusyId("");
    }
  };
  const editTable = async (component: CanvasComponent, edit: TableCellEdit, instance?: InstanceAction, popupContext?: PopupState): Promise<ScriptResult> => {
    const targetScreen = popupContext?.screenId || screen?.id;
    if (!canOperate || !project || !targetScreen || !popupContext && actionBusyId || instance?.isCurrent?.() === false)
      throw new Error("Table editing is unavailable in this session.");
    if (!popupContext) setActionBusyId(actionKey(component.id, instance));
    try {
      const result = await api<ScriptResult>(`/runtime/screens/${encodeURIComponent(targetScreen)}/components/${encodeURIComponent(component.id)}/table-edit`, "POST", {
        ...edit,
        parameters: popupContext?.rootParameters || parameters,
        publishedAt: project.publishedAt,
        ...(popupContext ? { popupOrigin: popupContext.origin } : {}),
        ...instanceRequestScope(instance),
      });
      if (currentProject.current !== project) throw new Error("The application changed while the edit was running. Reload its data before continuing.");
      if (instance?.isCurrent?.() === false) throw new Error("The template parameters changed while the edit was running. Reload its data before continuing.");
      if (result.success) window.dispatchEvent(new Event("sparkstudio:refresh-data"));
      return result;
    } catch (reason) {
      if (currentProject.current === project && reason instanceof ApiError && reason.status === 409)
        setNextPublication({ published: true });
      throw reason;
    } finally {
      if (!popupContext && currentProject.current === project) setActionBusyId("");
    }
  };
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !screen) return;
    const fit = () => {
      const style = window.getComputedStyle(viewport);
      const horizontalPadding =
        (parseFloat(style.paddingLeft) || 0) +
        (parseFloat(style.paddingRight) || 0);
      const verticalPadding =
        (parseFloat(style.paddingTop) || 0) +
        (parseFloat(style.paddingBottom) || 0);
      const availableWidth = Math.max(
        0,
        viewport.clientWidth - horizontalPadding,
      );
      const availableHeight = Math.max(
        0,
        viewport.clientHeight - verticalPadding,
      );
      setScale(
        Math.max(
          showRuntimeControls ? 0.2 : 0.01,
          Math.min(
            showRuntimeControls ? 1.5 : Number.POSITIVE_INFINITY,
            availableWidth / screen.width,
            availableHeight / screen.height,
          ),
        ),
      );
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [screen, loading, showRuntimeControls]);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setNotice("Fullscreen is unavailable in this browser window.");
    }
  };
  const { badCount, simulated, unknownCount } = runtimeBindingHealth(
    screen, project?.templates || [], tags, activeParameters, inputsByScreen, !connected, applicationState.values, queryProperties,
  );

  return (
    <ApplicationStateProvider value={applicationState}>
    <QueryPropertyProvider value={queryProperties}>
    <div className={`operator-app${showRuntimeControls ? "" : " operator-application-only"}`}>
      {showRuntimeControls && <header className="operator-header">
        <div className="operator-brand">
          <span className="brand-mark">
            <Icon name="spark" size={22} />
          </span>
          <div>
            <strong>{project?.name || "SparkStudio"}</strong>
            <span>OPERATIONS</span>
          </div>
        </div>
        <div className="operator-header-center">
          <ThemePicker />
          <span
            className={`operator-status ${connected ? "" : "disconnected"}`}
          >
            <span className={`status-dot ${connected ? "" : "offline"}`} />
            {connected ? "Gateway connected" : "Communication lost"}
          </span>
          <span className="operator-clock">
            {now.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
            <strong>{now.toLocaleTimeString()}</strong>
          </span>
        </div>
        <SessionIdentity operator />
        <button
          className="operator-fullscreen"
          onClick={() => void toggleFullscreen()}
          aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        >
          <Icon name={fullscreen ? "close" : "external"} size={17} />
          <span>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</span>
        </button>
      </header>}

      {showRuntimeControls && project && (
        <div className="operator-context">
          <div className="operator-screen-heading">
            <span>APPLICATION</span>
            <h1>{screen?.name || "Overview"}</h1>
          </div>
          <div className="operator-context-controls">
            {menuItems.length > 0 && <label className="operator-navigation-menu">
              <span>Go to screen</span>
              <select aria-label="Go to screen" value={menuItems.some(item => item.screenId === screen?.id) ? screen?.id : ""}
                disabled={Boolean(actionBusyId) || Boolean(popup)} onChange={event => {
                  setScreenId(event.target.value);
                  setActionStatus(null);
                }}>
                {!menuItems.some(item => item.screenId === screen?.id) && <option value="" disabled>Choose a screen…</option>}
                {menuItems.map(item => <option key={item.screenId} value={item.screenId}>{item.label}</option>)}
              </select>
            </label>}
            {Object.entries(parameters).map(([key, value]) => {
              const choices = contextChoices(project, tags, parameters, key);
              return (
                <label key={key}>
                  <span>{key.replace(/([A-Z])/g, " $1")}</span>
                  {choices.length > 1 ? (
                    <select
                      aria-label={`${key} context`}
                      value={value}
                      disabled={Boolean(actionBusyId)}
                      onChange={(event) =>
                        changeContext(key, event.target.value)
                      }
                    >
                      {choices.map((choice) => (
                        <option key={choice}>{choice}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label={`${key} context`}
                      value={value}
                      disabled={Boolean(actionBusyId)}
                      onChange={(event) =>
                        changeContext(key, event.target.value)
                      }
                    />
                  )}
                </label>
              );
            })}
          </div>
          <div className="operator-screen-health">
            <span
              className={`quality-dot ${badCount || !connected ? "bad" : unknownCount ? "neutral" : ""}`}
            />
            {!connected
              ? "Values may be stale"
              : badCount
                ? `${badCount} binding${badCount > 1 ? "s need" : " needs"} attention`
                : unknownCount
                  ? "Check live values inside reusable panels"
                  : "Live data healthy"}
          </div>
        </div>
      )}

      <div className="operator-notifications">
      {nextPublication && (
        <div className="operator-notification update">
          <Icon name="info" size={17} />
          <span>
            A new application version is available. Your current screen will
            stay open until you load it.
          </span>
          <button
            onClick={() => void load()}
            disabled={loading || Boolean(actionBusyId)}
          >
            Load new version <Icon name="refresh" size={14} />
          </button>
        </div>
      )}
      {!connected && project && (
        <div className="operator-notification connection" role="alert">
          <Icon name="info" size={18} />
          <span>
            <strong>Communication lost.</strong> Displayed values are the last
            received values and may be stale. Reconnecting automatically.
          </span>
        </div>
      )}
      {showRuntimeControls && !canOperate && project && <div className="operator-notification operator-readonly-note"><Icon name="shield" size={15} /><span>Read-only access. You can browse screens and view data. Sign in as an operator to edit forms or run actions.</span></div>}
      {notice && (
        <div className="operator-notification">
          <Icon name="info" size={16} />
          <span>{notice}</span>
          <button aria-label="Dismiss notice" onClick={() => setNotice("")}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {actionStatus && (
        <div
          className={`operator-notification action-result ${actionStatus.success ? "update" : "connection"}`}
          role={actionStatus.success ? "status" : "alert"}
        >
          <Icon name={actionStatus.success ? "check" : "info"} size={18} />
          <span>
            <strong>
              {actionStatus.success ? "Action completed. " : "Action failed. "}
            </strong>
            {actionStatus.message}
          </span>
          <button
            aria-label="Dismiss action result"
            onClick={() => setActionStatus(null)}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {project && error && <div className="operator-notification connection" role="alert">
        <Icon name="info" size={16} /><span>Unable to load the new version: {error}. Your current version remains open.</span>
      </div>}
      </div>
      {!project ? (
        <main className="operator-empty">
          {loading ? (
            <>
              <span className="loading-ring" />
              <h1>Opening your application</h1>
              <p>Loading the published screen from this gateway.</p>
            </>
          ) : unpublished ? (
            <>
              <span className="operator-empty-icon">
                <Icon name="monitor" size={36} />
              </span>
              <h1>Project unavailable</h1>
              <p>
                This project is not published, has been archived, or is no longer available.
                Ask a gateway administrator to check the project's publication and your access.
              </p>
              <button className="button" onClick={() => void load()}>
                <Icon name="refresh" size={15} />
                Check again
              </button>
            </>
          ) : (
            <>
              <span className="operator-empty-icon">
                <Icon name="info" size={36} />
              </span>
              <h1>Application unavailable</h1>
              <p>{error || "The published application could not be loaded."}</p>
              <button className="button" onClick={() => void load()}>
                <Icon name="refresh" size={15} />
                Try again
              </button>
            </>
          )}
        </main>
      ) : (
        <main className="operator-viewport" aria-label={screen?.name || "Application screen"} ref={viewportRef}>
          {screen && (
            <div
              className="operator-canvas-scaler"
              key={`${project.publishedAt}:${project.revision}:${screen.id}`}
              style={{
                width: screen.width * scale,
                height: screen.height * scale,
              }}
            >
              <div
                className="screen-canvas runtime operator-canvas"
                style={{
                  width: screen.width,
                  height: screen.height,
                  transform: `scale(${scale})`,
                }}
              >
                {screen.components.map((component) => (
                  <div
                    key={component.id}
                    className={`canvas-component component-${component.type}`}
                    style={
                      {
                        ...componentGeometry(component, { components: screen.components, tags, parameters: activeParameters, inputs: currentInputs, communicationLost: !connected, state: applicationState.values, queryProperties }),
                        "--component-accent":
                          component.props.color || "var(--accent)",
                        "--component-foreground": component.props.color
                          ? "#ffffff"
                          : "var(--on-accent)",
                      } as CSSProperties
                    }
                  >
                    <ProjectComponentView
                      component={component}
                      components={screen.components}
                      tags={tags}
                      parameters={activeParameters}
                      templates={project.templates}
                      screenId={screen.id}
                      scopedInputs={inputsByScreen}
                      onScopedInputChange={(scope, fieldKey, value) => canOperate &&
                        setInputsByScreen((previous) => ({
                          ...previous,
                          [scope]: { ...previous[scope], [fieldKey]: value },
                        }))
                      }
                      preview
                      queryScope="runtime"
                      publishedAt={project.publishedAt}
                      communicationLost={!connected}
                      inputs={currentInputs}
                      onInputChange={form.assign}
                      onAutomaticInputChange={form.assignAutomatic}
                      onAction={(component, instance) =>
                        void runAction(component, instance)
                      }
                      onTableEdit={canOperate ? editTable : undefined}
                      actionBusyId={actionBusyId}
                      interactionLocked={Boolean(actionBusyId)}
                      readOnly={!canOperate}
                      onOpenPopup={(component, instance) => {
                        if (actionBusyId || popup) return;
                        try {
                          setPopup(
                            createPopup(
                              project,
                              screen,
                              component,
                              parameters,
                              instance?.parameters || activeParameters,
                              instance,
                            ),
                          );
                          setActionStatus(null);
                        } catch (reason) {
                          setNotice(errorMessage(reason));
                        }
                      }}
                      onClosePopup={() =>
                        setNotice("There is no popup open on this screen.")
                      }
                      onNavigate={(target) => {
                        if (actionBusyId) return;
                        if (
                          project.screens.some(
                            (item) =>
                              item.id === target && item.kind !== "popup",
                          )
                        ) {
                          setScreenId(target);
                          setPopup(null);
                          setActionStatus(null);
                        } else
                          setNotice(
                            "This button’s destination is not available in the published application.",
                          );
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      )}

      {project && popup && (
        <Popup
          key={popup.id}
          project={project}
          popup={popup}
          tags={tags}
          communicationLost={!connected}
          readOnly={!canOperate}
          queryScope="runtime"
          onClose={() => {
            if (!actionBusyId) setPopup(null);
          }}
          onBusyChange={(busy) => setActionBusyId(busy ? "popup" : "")}
          onStale={() => setNextPublication({ published: true })}
          onTableEdit={canOperate ? (component, edit, instance) => editTable(component, edit, instance, popup) : undefined}
          onNavigate={(target) => {
            if (actionBusyId) return;
            if (
              project.screens.some(
                (item) => item.id === target && item.kind !== "popup",
              )
            ) {
              setPopup(null);
              setScreenId(target);
              setActionStatus(null);
            }
          }}
          onExecute={(action) =>
            canOperate ? api<ScriptResult>(
              `/runtime/screens/${encodeURIComponent(action.screen.id)}/components/${encodeURIComponent(action.component.id)}/action`,
              "POST",
              {
                parameters: action.popup.rootParameters,
                popupOrigin: action.popup.origin,
                inputs: action.inputs,
                publishedAt: project.publishedAt,
                ...instanceRequestScope(action.instance),
              },
            ) : Promise.reject(new Error("Your account has read-only access to this project."))
          }
        />
      )}
      <ComponentEventDiagnostics state={applicationState} />
      {showRuntimeControls && <footer className="operator-footer">
        {(gatewayAdmin || permissions.design) && <span className="operator-project-links"><a href={projectPage("designer")} title="Open a separate engineering session">Engineering sign-in</a></span>}
        <span>
          <Icon name="shield" size={13} />
          Operator application
        </span>
        {simulated && (
          <span className="operator-simulated">
            <span className="status-dot" />
            Sample values are simulated
          </span>
        )}
        <span className="operator-footer-spacer" />
        <span>
          {lastUpdate
            ? `Last data ${lastUpdate.toLocaleTimeString()}`
            : "Waiting for live data"}
        </span>
        {project && <span>Published revision {project.revision}</span>}
        <span className="operator-wordmark">sparkstudio</span>
      </footer>}
    </div>
    </QueryPropertyProvider></ApplicationStateProvider>
  );
}
