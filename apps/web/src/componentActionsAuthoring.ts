import { eventScriptDraft, eventScriptError, eventScriptValue, pythonComponentEventRestriction, pythonInputEventsAvailable, type EventScriptDraft } from "./eventScriptAuthoring";
import { componentEventProperties, componentInteractionTypes } from "./componentEventModel";
import { componentMessageScopes, componentMessageTypeError, validateComponentMessageHandlers } from "./componentMessageAuthoring";
import { componentMessagePayload } from "./componentMessageModel";
import { isInput, isNumericInput } from "./inputs";
import { runtimeBindingTargets, runtimePropertyDefinition } from "./runtimePropertyCatalog";
import type { CanvasComponent, ComponentEventProperty, ComponentInteractionEventType, ComponentMessageHandler, ComponentMessageScope, InputValue, Screen, Tag, TagWriteDataType, TagWritePropertyReference } from "./types";
import type { EquipmentCommandDefinition } from "./EquipmentCommand";

export const tagWriteDataTypes: TagWriteDataType[] = ["Boolean", "Int16", "Int32", "Int64", "UInt16", "UInt32", "Float", "Double", "String"];
export const isTagWriteDataType = (value: string): value is TagWriteDataType => tagWriteDataTypes.includes(value as TagWriteDataType);
export const writableActionTags = (tags: Tag[]) => tags.filter(tag => (tag.source === "memory" || tag.source === "opcua" || tag.source === "device" && tag.writable === true) && isTagWriteDataType(tag.dataType));
export function tagWritePathError(path: string): string | undefined {
  if (!path.startsWith("[default]") || path.length > 512) return "Enter a concrete [default] tag path of at most 512 characters.";
  const relative = path.slice(9);
  // eslint-disable-next-line no-control-regex -- This character filter intentionally matches control characters.
  if (/[\u0000-\u001f\u007f-\u009f[\]{}\\]/.test(relative) || relative.split("/").some(segment => !segment.trim() || segment === "." || segment === "..")) return "Use a concrete tag path without empty segments, dot segments, braces or control characters.";
  return undefined;
}
export function tagWriteValue(dataType: TagWriteDataType, text: string): InputValue {
  if (!isTagWriteDataType(dataType)) throw new Error("Choose a supported tag data type.");
  if (dataType === "String") { if (text.length > 1024) throw new Error("Tag text values may contain at most 1,024 characters."); return text; }
  if (dataType === "Boolean") { if (text !== "true" && text !== "false") throw new Error("Choose true or false for a Boolean tag."); return text === "true"; }
  if (!text.trim() || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim())) throw new Error("Enter a finite numeric tag value.");
  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error("Enter a finite numeric tag value.");
  if (Number.isInteger(number) && !Number.isSafeInteger(number)) throw new Error("Whole numeric tag values must be within ±9,007,199,254,740,991 to retain exact precision.");
  if (dataType !== "Float" && dataType !== "Double") {
    if (!Number.isSafeInteger(number)) throw new Error("Integer tag values must be exact whole numbers within the supported range.");
    const bounds: Record<string, [number, number]> = { Int16: [-32768, 32767], UInt16: [0, 65535], Int32: [-2147483648, 2147483647], UInt32: [0, 4294967295], Int64: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] };
    const [minimum, maximum] = bounds[dataType];
    if (number < minimum || number > maximum) throw new Error(`Enter a value from ${minimum.toLocaleString("en-US")} to ${maximum.toLocaleString("en-US")} for ${dataType}.`);
  } else if (dataType === "Float" && !Number.isFinite(Math.fround(number))) throw new Error("Enter a value within the Float range.");
  return number;
}
export interface TagWritePropertyChoice { property: string; label: string; type: "string" | "number" | "boolean" | "scalar" }
export function tagWritePropertyChoices(component: CanvasComponent): TagWritePropertyChoice[] {
  const choices: TagWritePropertyChoice[] = [];
  if (isInput(component.type) && component.type !== "passwordInput") choices.push({ property: "value", label: "Value · current input", type: isNumericInput(component.type) ? "number" : ["checkbox", "toggle"].includes(component.type) ? "boolean" : "string" });
  for (const property of runtimeBindingTargets(component)) {
    if (choices.some(choice => choice.property === property) || component.type === "passwordInput" && ["value", "text"].includes(property)) continue;
    const definition = runtimePropertyDefinition(property, component);
    if (!definition || definition.type === "json") continue;
    // The catalog's scalar text/stateValue bindings normalize their output to
    // rendered text. Their readable component property therefore remains text.
    choices.push({ property, label: definition.label, type: ["color", "tagPath", "scalar"].includes(definition.type) ? "string" : definition.type as TagWritePropertyChoice["type"] });
  }
  return choices;
}
export const tagWritePropertyCompatible = (choice: TagWritePropertyChoice, dataType: TagWriteDataType) => choice.type === "scalar" || choice.type === (dataType === "String" ? "string" : dataType === "Boolean" ? "boolean" : "number");
export function tagWritePropertyReferenceError(reference: TagWritePropertyReference, component: CanvasComponent, components: CanvasComponent[], parent: Screen | undefined, dataType: TagWriteDataType): string | undefined {
  if (!reference || typeof reference !== "object" || typeof reference.property !== "string") return "Choose a component property for the tag value.";
  let choice: TagWritePropertyChoice | undefined;
  if (reference.kind === "parentProperty") {
    if (Object.keys(reference).some(key => !["kind", "property"].includes(key)) || !parent || !["name", "width", "height"].includes(reference.property)) return "Choose a supported property from the containing screen or template.";
    choice = { property: reference.property, label: reference.property, type: reference.property === "name" ? "string" : "number" };
  } else if (reference.kind === "property") {
    if (Object.keys(reference).some(key => !["kind", "componentId", "property"].includes(key)) || reference.componentId !== undefined && (typeof reference.componentId !== "string" || !reference.componentId || reference.componentId.length > 256)) return "Choose a component in this form.";
    const target = !reference.componentId || reference.componentId === component.id ? component : components.find(item => item.id === reference.componentId);
    if (!target) return "The value's source component is not in this form.";
    choice = tagWritePropertyChoices(target).find(item => item.property === reference.property);
    if (!choice) return "Choose an available scalar component property. Password values and structured properties cannot be written to tags.";
  } else return "Choose a supported component property source.";
  if (!tagWritePropertyCompatible(choice, dataType)) return `The selected property type does not match the ${dataType} tag. Choose a ${dataType === "String" ? "text" : dataType === "Boolean" ? "Boolean" : "numeric"} property.`;
  return undefined;
}

export type ComponentEventTab = "action" | "change" | "commit" | "mount" | "propertyChange" | "unmount" | "messages" | ComponentInteractionEventType;
export type ScriptEventTab = Exclude<ComponentEventTab, "action" | "messages">;
export const scriptEventTabs: ScriptEventTab[] = ["change", "commit", "mount", "propertyChange", "unmount", ...componentInteractionTypes];
export const eventTabLabels: Record<ComponentEventTab, string> = { action: "On click", change: "Value changed", commit: "Value committed", mount: "Mounted", propertyChange: "Property changed", unmount: "Unmounted", messages: "Messages",
  focus: "Focus gained", blur: "Focus lost", keyDown: "Key down", keyUp: "Key up", doubleClick: "Double click", pointerDown: "Pointer down", pointerUp: "Pointer up" };
export interface ComponentActionsDraft {
  scripts: Record<ScriptEventTab, EventScriptDraft>;
  properties: ComponentEventProperty[];
  handlers: ComponentMessageHandler[];
  messageScripts: Record<string, EventScriptDraft>;
  action: NonNullable<CanvasComponent["props"]["action"]> | "";
  buttonCode: string;
  notifyMessage: string;
  targetScreenId: string;
  popupTargetScreenId: string;
  popupParameters: string;
  messageType: string;
  messageScope: ComponentMessageScope;
  messagePayload: string;
  tagPath: string;
  tagDataType: TagWriteDataType;
  tagValue: string;
  tagValueSource: "fixed" | "property";
  tagPropertyComponent: string;
  tagProperty: string;
  tagConfirmationEnabled: boolean;
  tagConfirmation: string;
}
const textOrEmpty = (value: unknown): string => typeof value === "string" ? value : "";
export const hasComponentAction = (component: CanvasComponent) => component.type === "button" || component.type === "equipmentSymbol";
export function componentActionsDraft(component: CanvasComponent): ComponentActionsDraft {
  const props = component.props, inputAvailable = pythonInputEventsAvailable(component);
  const handlers = (props.messageHandlers ?? []).map(handler => ({ ...handler }));
  return {
    scripts: Object.fromEntries(scriptEventTabs.map(tab => [tab, tab === "change" || tab === "commit" ? eventScriptDraft(props.events?.[tab], inputAvailable) : eventScriptDraft(props.componentEvents?.[tab])])) as Record<ScriptEventTab, EventScriptDraft>,
    properties: [...(props.componentEvents?.propertyChange?.properties ?? [])], handlers,
    messageScripts: Object.fromEntries(handlers.map(handler => [handler.id, eventScriptDraft(handler)])),
    action: props.action ?? (component.type === "button" ? "navigate" : ""), buttonCode: props.script ?? "", notifyMessage: textOrEmpty(props.notifyMessage),
    targetScreenId: props.action === "openPopup" ? "" : props.targetScreenId ?? "",
    popupTargetScreenId: props.action === "openPopup" ? props.targetScreenId ?? "" : "",
    popupParameters: JSON.stringify(props.parameters ?? {}, null, 2),
    messageType: props.message?.messageType ?? "refresh", messageScope: props.message?.scope ?? "screen", messagePayload: JSON.stringify(props.message?.payload ?? {}, null, 2),
    tagPath: props.tagWrite?.tagPath ?? "", tagDataType: props.tagWrite?.dataType ?? "Double", tagValue: props.tagWrite?.value !== undefined ? String(props.tagWrite.value) : "0",
    tagValueSource: props.tagWrite?.valueReference ? "property" : "fixed",
    tagPropertyComponent: props.tagWrite?.valueReference?.kind === "parentProperty" ? "parent" : props.tagWrite?.valueReference?.componentId ? `component:${props.tagWrite.valueReference.componentId}` : "self",
    tagProperty: props.tagWrite?.valueReference?.property ?? "",
    tagConfirmationEnabled: Boolean(props.tagWrite?.confirmation), tagConfirmation: props.tagWrite?.confirmation ?? "Are you sure?",
  };
}
export type ComponentActionsResult = { props: CanvasComponent["props"]; error?: never; tab?: never; handlerId?: never } | { error: string; tab: ComponentEventTab; handlerId?: string; props?: never };

function applyEventScripts(component: CanvasComponent, draft: ComponentActionsDraft, props: CanvasComponent["props"]): ComponentActionsResult | undefined {
  const events: NonNullable<typeof props.events> = {}, automatic: NonNullable<typeof props.componentEvents> = {};
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
  return undefined;
}

interface ActionDraftContext {
  component: CanvasComponent; draft: ComponentActionsDraft; props: CanvasComponent["props"]; actionChanged: boolean;
  screens: Screen[]; popupAllowed: boolean; tags: Tag[]; components: CanvasComponent[]; parent?: Screen; commands: EquipmentCommandDefinition[];
}

function applyNavigationAction({ component, draft, props, actionChanged, screens, popupAllowed }: ActionDraftContext): string | undefined {
  const popup = draft.action === "openPopup", targetId = popup ? draft.popupTargetScreenId : draft.targetScreenId;
  if (popup && !popupAllowed) return "A popup cannot open another popup.";
  const target = screens.find(screen => screen.id === targetId && (popup ? screen.kind === "popup" : screen.kind !== "popup"));
  // Unconfigured new buttons can still author other events before choosing a destination.
  if (targetId && !target) return `Choose an existing ${popup ? "popup" : "destination"} screen.`;
  if (targetId !== (component.props.targetScreenId ?? "") || actionChanged) props.targetScreenId = targetId || undefined;
  if (!popup) return undefined;
  try {
    const parameters: unknown = JSON.parse(draft.popupParameters);
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) || Object.values(parameters).some(value => typeof value !== "string")) return "Popup parameters must be a JSON object with text values.";
    if (Object.keys(parameters).some(key => !Object.hasOwn(target?.parameters ?? {}, key))) return "Overrides must use parameters declared by the target popup screen.";
    if (JSON.stringify(parameters) !== JSON.stringify(component.props.parameters ?? {}) || actionChanged) props.parameters = parameters as Record<string, string>;
  } catch { return "Enter valid JSON for popup parameter overrides."; }
  return undefined;
}

function applyMessageAction({ draft, props }: ActionDraftContext): string | undefined {
  const error = componentMessageTypeError(draft.messageType);
  if (error) return error;
  if (!componentMessageScopes.includes(draft.messageScope)) return "Choose an instance, screen or session scope.";
  try {
    const payload = componentMessagePayload(JSON.parse(draft.messagePayload)) as NonNullable<typeof props.message>["payload"];
    props.message = { messageType: draft.messageType.trim(), scope: draft.messageScope, payload };
  } catch (reason) { return reason instanceof Error ? reason.message : "Enter a bounded JSON object for the message payload."; }
  return undefined;
}

function applyTagValueAction({ component, draft, props, tags, components, parent, commands }: ActionDraftContext): string | undefined {
  const path = draft.tagPath.trim(), pathError = tagWritePathError(path);
  if (pathError) return pathError;
  const known = tags.find(tag => tag.path === path);
  if (known && !writableActionTags([known]).length) return "Choose a writable memory, OPC UA or device tag with a supported data type.";
  const dataType = known && isTagWriteDataType(known.dataType) ? known.dataType : draft.tagDataType;
  const declared = commands.filter(command => command.tagPath === path);
  if (declared.length > 1) return "Multiple equipment commands target this tag. Use a declared command control instead of Set tag value.";
  if (declared.length && declared[0].dataType !== dataType) return "The tag value action must match the equipment command's declared data type.";
  const confirmation = draft.tagConfirmation.trim();
  if (draft.tagConfirmationEnabled && (!confirmation || confirmation.length > 512)) return "Enter confirmation text from 1 to 512 characters.";
  try {
    const common = { tagPath: path, dataType, ...(draft.tagConfirmationEnabled ? { confirmation } : {}) };
    if (draft.tagValueSource === "property") {
      const reference: TagWritePropertyReference = draft.tagPropertyComponent === "parent" ? { kind: "parentProperty", property: draft.tagProperty as "name" | "width" | "height" }
        : { kind: "property", ...(draft.tagPropertyComponent === "self" ? {} : { componentId: draft.tagPropertyComponent.startsWith("component:") ? draft.tagPropertyComponent.slice(10) : "" }), property: draft.tagProperty };
      const referenceError = tagWritePropertyReferenceError(reference, component, components, parent, dataType);
      if (referenceError) return referenceError;
      props.tagWrite = { ...common, valueReference: reference };
    } else if (draft.tagValueSource === "fixed") {
      const value = tagWriteValue(dataType, draft.tagValue), command = declared[0];
      if (command && typeof value === "number" && (command.min !== undefined && value < command.min || command.max !== undefined && value > command.max)) return `The value must be within the declared command's range of ${command.min} to ${command.max}.`;
      if (command && typeof value === "string" && value.length > (command.maxLength ?? 128)) return `The declared command allows at most ${command.maxLength ?? 128} text characters.`;
      props.tagWrite = { ...common, value };
    } else return "Choose a fixed value or a component property.";
  } catch (reason) { return reason instanceof Error ? reason.message : "Enter a value matching the tag data type."; }
  return undefined;
}

/** A notify button shows its fixed text in the browser; it never runs a script or calls the gateway. */
function applyNotifyAction(context: ActionDraftContext): string | undefined {
  const message = context.draft.notifyMessage.trim();
  if (!message) return "Enter the message to show.";
  if (message.length > 500 || [...message].some(character => character.charCodeAt(0) < 32 && !"\n\r\t".includes(character))) return "Messages are limited to 500 characters without control characters.";
  context.props.notifyMessage = message;
  return undefined;
}
function applyActivationAction(context: ActionDraftContext): string | undefined {
  switch (context.draft.action) {
    case "script": {
      const error = eventScriptError({ language: "python", code: context.draft.buttonCode });
      if (error) return error;
      if (!context.draft.buttonCode.trim()) return "Enter a Python action script.";
      return undefined;
    }
    case "navigate": case "openPopup": return applyNavigationAction(context);
    case "message": return applyMessageAction(context);
    case "setTagValue": return applyTagValueAction(context);
    case "notify": return applyNotifyAction(context);
    default: return undefined;
  }
}

/** Validate the complete local draft without executing code or mutating the component. */
export function applyComponentActionsDraft(component: CanvasComponent, draft: ComponentActionsDraft, screens: Screen[], popupAllowed = true, tags: Tag[] = [], components: CanvasComponent[] = [component], parent?: Screen, commands: EquipmentCommandDefinition[] = []): ComponentActionsResult {
  const props = { ...component.props }, eventError = applyEventScripts(component, draft, props);
  if (eventError) return eventError;
  // A component without an activation action may use these same props for other features.
  if (!hasComponentAction(component)) return { props };
  const actionChanged = draft.action !== (component.props.action ?? (component.type === "button" ? "navigate" : ""));
  if (component.type === "equipmentSymbol" && !["", "navigate", "openPopup"].includes(draft.action)) return { error: "Equipment symbols support navigation and popup actions.", tab: "action" };
  // Opening the editor must preserve valid saved native actions and inactive definitions.
  if (actionChanged || component.props.action !== undefined) props.action = draft.action || undefined;
  if (actionChanged) { props.targetScreenId = undefined; props.parameters = undefined; props.message = undefined; props.notifyMessage = undefined; }
  if (draft.buttonCode !== (component.props.script ?? "") || draft.action === "script") props.script = draft.buttonCode;
  const error = applyActivationAction({ component, draft, props, actionChanged, screens, popupAllowed, tags, components, parent, commands });
  if (error) return { error, tab: "action" };
  return { props };
}
