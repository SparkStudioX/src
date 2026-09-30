import { eventScriptDraft, eventScriptError, eventScriptValue, pythonComponentEventRestriction, pythonInputEventsAvailable, type EventScriptDraft } from "./eventScriptAuthoring";
import { componentEventProperties } from "./componentEventModel";
import { componentMessageScopes, componentMessageTypeError, validateComponentMessageHandlers } from "./componentMessageAuthoring";
import { componentMessagePayload } from "./componentMessageModel";
import { isInput } from "./inputs";
import type { CanvasComponent, ComponentEventProperty, ComponentMessageHandler, ComponentMessageScope, Screen } from "./types";

export type ComponentEventTab = "action" | "change" | "commit" | "mount" | "propertyChange" | "unmount" | "messages";
export type ScriptEventTab = Exclude<ComponentEventTab, "action" | "messages">;
export const scriptEventTabs: ScriptEventTab[] = ["change", "commit", "mount", "propertyChange", "unmount"];
export const eventTabLabels: Record<ComponentEventTab, string> = { action: "On click", change: "Value changed", commit: "Value committed", mount: "Mounted", propertyChange: "Property changed", unmount: "Unmounted", messages: "Messages" };
export interface ComponentActionsDraft {
  scripts: Record<ScriptEventTab, EventScriptDraft>;
  properties: ComponentEventProperty[];
  handlers: ComponentMessageHandler[];
  messageScripts: Record<string, EventScriptDraft>;
  action: NonNullable<CanvasComponent["props"]["action"]> | "";
  buttonCode: string;
  targetScreenId: string;
  popupTargetScreenId: string;
  popupParameters: string;
  messageType: string;
  messageScope: ComponentMessageScope;
  messagePayload: string;
}
export const hasComponentAction = (component: CanvasComponent) => component.type === "button" || component.type === "equipmentSymbol";
export function componentActionsDraft(component: CanvasComponent): ComponentActionsDraft {
  const props = component.props, inputAvailable = pythonInputEventsAvailable(component);
  const handlers = (props.messageHandlers ?? []).map(handler => ({ ...handler }));
  return {
    scripts: { change: eventScriptDraft(props.events?.change, inputAvailable), commit: eventScriptDraft(props.events?.commit, inputAvailable), mount: eventScriptDraft(props.componentEvents?.mount), propertyChange: eventScriptDraft(props.componentEvents?.propertyChange), unmount: eventScriptDraft(props.componentEvents?.unmount) },
    properties: [...(props.componentEvents?.propertyChange?.properties ?? [])], handlers,
    messageScripts: Object.fromEntries(handlers.map(handler => [handler.id, eventScriptDraft(handler)])),
    action: props.action ?? (component.type === "button" ? "navigate" : ""), buttonCode: props.script ?? "",
    targetScreenId: props.action === "openPopup" ? "" : props.targetScreenId ?? "",
    popupTargetScreenId: props.action === "openPopup" ? props.targetScreenId ?? "" : "",
    popupParameters: JSON.stringify(props.parameters ?? {}, null, 2),
    messageType: props.message?.messageType ?? "refresh", messageScope: props.message?.scope ?? "screen", messagePayload: JSON.stringify(props.message?.payload ?? {}, null, 2),
  };
}
export type ComponentActionsResult = { props: CanvasComponent["props"]; error?: never; tab?: never; handlerId?: never } | { error: string; tab: ComponentEventTab; handlerId?: string; props?: never };

/** Validate the complete local draft without executing code or mutating the component. */
export function applyComponentActionsDraft(component: CanvasComponent, draft: ComponentActionsDraft, screens: Screen[], popupAllowed = true): ComponentActionsResult {
  const props = { ...component.props }, events: NonNullable<typeof props.events> = {}, automatic: NonNullable<typeof props.componentEvents> = {};
  for (const tab of scriptEventTabs) {
    if ((tab === "change" || tab === "commit") && !isInput(component.type)) continue;
    const script = eventScriptValue(draft.scripts[tab]);
    if (!script.code.trim()) continue;
    const supportsPython = tab !== "change" && tab !== "commit" || pythonInputEventsAvailable(component);
    const error = script.language === "python" && !supportsPython ? pythonComponentEventRestriction : eventScriptError(script);
    if (error) return { error: `${eventTabLabels[tab]}: ${error}`, tab };
    if (tab === "propertyChange") {
      const allowedProperties = componentEventProperties(component, script.language);
      if (draft.properties.length < 1 || draft.properties.length > 16 || new Set(draft.properties).size !== draft.properties.length || draft.properties.some(property => !allowedProperties.includes(property))) return { error: "Property changed: choose 1–16 unique properties supported by this component.", tab };
      automatic.propertyChange = { ...script, properties: [...draft.properties] };
    } else if (tab === "change" || tab === "commit") events[tab] = script;
    else automatic[tab] = script;
  }
  const handlers = draft.handlers.map(handler => ({ ...handler, ...eventScriptValue(draft.messageScripts[handler.id]), messageType: handler.messageType.trim() }));
  const invalid = validateComponentMessageHandlers(handlers);
  if (invalid) return { error: invalid.message, tab: "messages", handlerId: handlers[invalid.index]?.id };
  if (isInput(component.type)) props.events = Object.keys(events).length ? events : undefined;
  props.componentEvents = Object.keys(automatic).length ? automatic : undefined;
  props.messageHandlers = handlers.length ? handlers : undefined;
  // A component without an activation action may use these same props for other features.
  if (!hasComponentAction(component)) return { props };
  const actionChanged = draft.action !== (component.props.action ?? (component.type === "button" ? "navigate" : ""));
  const actionError = (error: string): ComponentActionsResult => ({ error, tab: "action" });
  if (component.type === "equipmentSymbol" && !["", "navigate", "openPopup"].includes(draft.action)) return actionError("Equipment symbols support navigation and popup actions.");
  // Opening the editor must preserve valid saved native actions and inactive definitions.
  if (actionChanged || component.props.action !== undefined) props.action = draft.action || undefined;
  if (actionChanged) { props.targetScreenId = undefined; props.parameters = undefined; props.message = undefined; }
  if (draft.buttonCode !== (component.props.script ?? "") || draft.action === "script") props.script = draft.buttonCode;
  if (draft.action === "script") {
    const error = eventScriptError({ language: "python", code: draft.buttonCode });
    if (error) return actionError(error);
    if (!draft.buttonCode.trim()) return actionError("Enter a Python action script.");
  } else if (draft.action === "navigate" || draft.action === "openPopup") {
    const popup = draft.action === "openPopup", targetId = popup ? draft.popupTargetScreenId : draft.targetScreenId;
    if (popup && !popupAllowed) return actionError("A popup cannot open another popup.");
    const target = screens.find(screen => screen.id === targetId && (popup ? screen.kind === "popup" : screen.kind !== "popup"));
    // Unconfigured new buttons can still author other events before choosing a destination.
    if (targetId && !target) return actionError(`Choose an existing ${popup ? "popup" : "destination"} screen.`);
    if (targetId !== (component.props.targetScreenId ?? "") || actionChanged) props.targetScreenId = targetId || undefined;
    if (popup) {
      try {
        const parameters: unknown = JSON.parse(draft.popupParameters);
        if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) || Object.values(parameters).some(value => typeof value !== "string")) return actionError("Popup parameters must be a JSON object with text values.");
        if (Object.keys(parameters).some(key => !Object.hasOwn(target?.parameters ?? {}, key))) return actionError("Overrides must use parameters declared by the target popup screen.");
        if (JSON.stringify(parameters) !== JSON.stringify(component.props.parameters ?? {}) || actionChanged) props.parameters = parameters as Record<string, string>;
      } catch { return actionError("Enter valid JSON for popup parameter overrides."); }
    }
  } else if (draft.action === "message") {
    const error = componentMessageTypeError(draft.messageType);
    if (error) return actionError(error);
    if (!componentMessageScopes.includes(draft.messageScope)) return actionError("Choose an instance, screen or session scope.");
    try {
      const payload = componentMessagePayload(JSON.parse(draft.messagePayload)) as NonNullable<typeof props.message>["payload"];
      props.message = { messageType: draft.messageType.trim(), scope: draft.messageScope, payload };
    } catch (reason) { return actionError(reason instanceof Error ? reason.message : "Enter a bounded JSON object for the message payload."); }
  }
  return { props };
}
