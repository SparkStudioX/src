import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ApiError, resolvePath, scriptFailureMessage } from "./api";
import Icon from "./Icon";
import { validateInputs } from "./inputs";
import { useFormInputs } from "./inputStateBindings";
import { actionKey, ProjectComponentView } from "./templates";
import { componentGeometry } from "./propertyBindings";
import { ApplicationStateProvider, useApplicationStateContext, usePopupApplicationState } from "./applicationState";
import { popupQuerySource, popupSourceStatus } from "./popupModel";
import { useQueryRepeater } from "./useQueryRepeater";
import type {
  CanvasComponent,
  InputValues,
  InstanceAction,
  PopupAction,
  PopupState,
  Project,
  ScriptResult,
  Tag,
  TableCellEdit,
} from "./types";
import "./popups.css";

export default function Popup({
  project,
  popup,
  tags,
  communicationLost,
  queryScope,
  onClose,
  onNavigate,
  onExecute,
  onBusyChange,
  onStale,
  onTableEdit,
  readOnly = false,
}: {
  project: Project & { publishedAt?: string };
  popup: PopupState;
  tags: Tag[];
  communicationLost: boolean;
  queryScope: "designer" | "runtime";
  onClose: () => void;
  onNavigate: (id: string) => void;
  onExecute: (action: PopupAction) => Promise<ScriptResult>;
  onBusyChange: (busy: boolean) => void;
  onStale?: () => void;
  onTableEdit?: (component: CanvasComponent, edit: TableCellEdit, instance?: InstanceAction) => Promise<ScriptResult>;
  readOnly?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [busy, setBusy] = useState("");
  const [edits, setEdits] = useState<Record<string, InputValues>>({});
  const [feedback, setFeedback] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [scale, setScale] = useState(1);
  const [invalidSource, setInvalidSource] = useState("");
  const screen = project.screens.find((item) => item.id === popup.screenId);
  const parentApplicationState = useApplicationStateContext();
  const applicationState = usePopupApplicationState(parentApplicationState, popup.id, screen?.state);
  const source = popupQuerySource(project, popup);
  const sourceRows = useQueryRepeater(source.source, source.template, queryScope, source.parameters,
    communicationLost, queryScope === "runtime" ? project.publishedAt : undefined);
  const sourceState = popupSourceStatus(popup, source, sourceRows);
  const sourceLocked = Boolean(invalidSource) || !sourceState.ready;
  const sourceMessage = invalidSource || sourceState.message;
  useEffect(() => {
    // An old form stays invalid even if a record with the same key appears later.
    if (sourceState.stale) setInvalidSource(previous => previous || sourceState.message);
  }, [sourceState.stale, sourceState.message]);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    if (!element) return;
    element.showModal();
    const focus = requestAnimationFrame(() => {
      const control = element.querySelector<HTMLElement>(
        "input:not([disabled]),select:not([disabled]),textarea:not([disabled]),.render-button:not([disabled])",
      );
      (control || element.querySelector<HTMLElement>(".popup-close"))?.focus({
        preventScroll: true,
      });
    });
    return () => {
      cancelAnimationFrame(focus);
      element.close();
      if (previousFocus?.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!screen) return;
    const fit = () =>
      setScale(
        Math.max(
          0.15,
          Math.min(
            1,
            (window.innerWidth - 64) / screen.width,
            (window.innerHeight - 180) / screen.height,
          ),
        ),
      );
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [screen]);
  const form = useFormInputs({ document: screen, tags, parameters: popup.parameters, edits: edits.direct, communicationLost,
    state: applicationState, active: !busy && !sourceLocked && !readOnly, contextKey: popup.id,
    onEdit: (field, value) => setEdits(previous => ({ ...previous, direct: { ...previous.direct, [field]: value } })) });
  const inputs = form.inputs;
  if (!screen) return null;
  const close = () => {
    if (!busy) onClose();
  };
  const run = async (component: CanvasComponent, instance?: InstanceAction) => {
    if (busy || sourceLocked || readOnly) return;
    const values = instance?.inputs || inputs;
    const invalid = validateInputs(
      instance?.template || screen,
      values,
      instance?.parameters || popup.parameters,
    );
    if (invalid) {
      setFeedback({ success: false, message: invalid });
      return;
    }
    setBusy(actionKey(component.id, instance));
    onBusyChange(true);
    setFeedback(null);
    try {
      const execution = await onExecute({
        screen,
        component,
        parameters: popup.parameters,
        inputs: values,
        instance,
        popup,
      });
      const resultMessage =
        typeof execution.result === "object" &&
        execution.result !== null &&
        "message" in execution.result
          ? String((execution.result as { message: unknown }).message)
          : execution.stdout ||
            (execution.result === undefined
              ? "Action completed."
              : JSON.stringify(execution.result));
      setFeedback({
        success: execution.success,
        message: (execution.success
          ? resultMessage
          : scriptFailureMessage(execution.stderr)
        ).slice(0, 2500),
      });
      if (execution.success) window.dispatchEvent(new Event("sparkstudio:refresh-data"));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        onStale?.();
        if (popup.querySourceParameters) setInvalidSource("The application version changed. Close this popup and load the new version before continuing.");
        setFeedback({
          success: false,
          message:
            "The application version changed. Close this popup and load the new version before running another action.",
        });
      } else
        setFeedback({
          success: false,
          message: error instanceof Error ? error.message : String(error),
        });
    } finally {
      setBusy("");
      onBusyChange(false);
    }
  };
  const editTable = async (component: CanvasComponent, edit: TableCellEdit, instance?: InstanceAction): Promise<ScriptResult> => {
    if (busy || sourceLocked || readOnly || queryScope !== "runtime" || !onTableEdit) throw new Error("Table editing is unavailable in this popup.");
    setBusy(actionKey(component.id, instance));
    onBusyChange(true);
    try { return await onTableEdit(component, edit, instance); }
    catch (error) {
      if (active.current && error instanceof ApiError && error.status === 409) onStale?.();
      throw error;
    } finally {
      if (active.current) { setBusy(""); onBusyChange(false); }
    }
  };
  return (
    <ApplicationStateProvider value={applicationState}>
    <dialog
      className="spark-popup"
      ref={dialog}
      aria-labelledby={`popup-title-${popup.id}`}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        if (
          event.key !== "Tab" ||
          event.ctrlKey ||
          event.altKey ||
          event.metaKey
        )
          return;
        const element = event.currentTarget;
        const controls = [
          ...element.querySelectorAll<HTMLElement>(
            "a[href],button,input,select,textarea,[tabindex]",
          ),
        ].filter((control) => {
          if (
            control.tabIndex < 0 ||
            control.matches(":disabled") ||
            control.closest("[inert],[hidden]") ||
            !control.getClientRects().length
          )
            return false;
          const visibility = window.getComputedStyle(control).visibility;
          return visibility !== "hidden" && visibility !== "collapse";
        });
        if (!controls.length) {
          event.preventDefault();
          element.focus();
          return;
        }
        const activeIndex = controls.indexOf(
          element.ownerDocument.activeElement as HTMLElement,
        );
        if (
          activeIndex < 0 ||
          (event.shiftKey
            ? activeIndex === 0
            : activeIndex === controls.length - 1)
        ) {
          event.preventDefault();
          controls[event.shiftKey ? controls.length - 1 : 0].focus({
            preventScroll: true,
          });
        }
      }}
    >
      <header className="popup-header">
        <span className="popup-symbol">
          <Icon name="external" size={16} />
        </span>
        <h2 id={`popup-title-${popup.id}`}>
          {resolvePath(screen.name, popup.parameters)}
        </h2>
        <span className="popup-mode">
          {queryScope === "designer" ? "PREVIEW" : "POPUP"}
        </span>
        <button
          className="icon-button popup-close"
          aria-label="Close popup"
          title={busy ? "Wait for the action to finish" : "Close popup (Esc)"}
          disabled={Boolean(busy)}
          onClick={close}
        >
          <Icon name="close" size={19} />
        </button>
      </header>
      {sourceLocked && <div className="popup-source-status" role="status">
        <Icon name="info" size={16} />
        <span>{feedback?.success && (invalidSource || sourceState.stale)
          ? "The action completed. This source record has changed; close the popup and open a current record to continue."
          : sourceMessage}</span>
        <button type="button" disabled={Boolean(busy)} onClick={close}>Close</button>
      </div>}
      <div className="popup-viewport">
        <div
          className="popup-scaler"
          style={{ width: screen.width * scale, height: screen.height * scale }}
        >
          <div
            className="popup-scene"
            style={{
              width: screen.width,
              height: screen.height,
              transform: `scale(${scale})`,
            }}
          >
            {screen.components.map((component) => (
              <div
                className={`popup-component component-${component.type}`}
                key={component.id}
                style={
                  {
                    ...componentGeometry(component, {components:screen.components, tags, parameters:popup.parameters, inputs, communicationLost, state: applicationState?.values}),
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
                  screenId={screen.id}
                  templates={project.templates}
                  tags={tags}
                  parameters={popup.parameters}
                  inputs={inputs}
                  scopedInputs={edits}
                  preview
                  queryScope={queryScope}
                  publishedAt={queryScope === "runtime" ? project.publishedAt : undefined}
                  communicationLost={communicationLost}
                  onInputChange={form.assign}
                  onScopedInputChange={(scope, field, value) =>
                    setEdits((previous) => ({
                      ...previous,
                      [scope]: { ...previous[scope], [field]: value },
                    }))
                  }
                  onAction={(leaf, instance) => void run(leaf, instance)}
                  onTableEdit={onTableEdit && !readOnly && !sourceLocked ? editTable : undefined}
                  actionBusyId={busy}
                  interactionLocked={Boolean(busy) || sourceLocked && component.props.action !== "closePopup"}
                  readOnly={readOnly}
                  onClosePopup={close}
                  onOpenPopup={() =>
                    setFeedback({
                      success: false,
                      message: "Close this popup before opening another one.",
                    })
                  }
                  onNavigate={(target) => {
                    if (!busy) onNavigate(target);
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      {feedback && (
        <div
          className={`popup-feedback ${feedback.success ? "" : "error"}`}
          role="status"
        >
          <Icon name={feedback.success ? "check" : "info"} size={16} />
          <span>{feedback.message}</span>
        </div>
      )}
      <footer className="popup-footer">
        <span>
          <span
            className={`status-dot ${communicationLost ? "offline" : ""}`}
          />
          {communicationLost
            ? "Communication lost"
            : busy
              ? "Action running…"
              : "Changes stay in this popup until you run an action"}
        </span>
        <span>
          {screen.width} × {screen.height}
        </span>
      </footer>
    </dialog>
    </ApplicationStateProvider>
  );
}
