import type { Completion } from "@codemirror/autocomplete";
import type { CanvasComponent } from "./types";
import { isInput } from "./inputs";
import { pythonInputWritable } from "./pythonUiModel";

export type EventScriptLanguage = "python" | "javascript";
export interface EventScriptDraft { language: EventScriptLanguage; buffers: Record<EventScriptLanguage, string> }
export const pythonInputEventsAvailable = (component: CanvasComponent) => component.type !== "passwordInput";
export const pythonComponentEventRestriction = "Password change and commit handlers support JavaScript only. Other password handlers can use Python with presentation properties; password text and values remain unavailable.";
export function eventScriptDraft(script?: { language: EventScriptLanguage; code: string }, pythonAvailable = true): EventScriptDraft {
  const language = script?.language ?? (pythonAvailable ? "python" : "javascript");
  return { language, buffers: { python: "", javascript: "", [language]: script?.code ?? "" } };
}
export function selectEventLanguage(draft: EventScriptDraft, language: EventScriptLanguage): EventScriptDraft { return { ...draft, language }; }
export function editEventScript(draft: EventScriptDraft, code: string): EventScriptDraft { return { ...draft, buffers: { ...draft.buffers, [draft.language]: code } }; }
export function eventScriptValue(draft: EventScriptDraft) { return { language: draft.language, code: draft.buffers[draft.language] }; }

/** Apply never runs code. Explicit Check syntax compiles Python separately; JavaScript parses locally. */
export function eventScriptError(script: { language: EventScriptLanguage; code: string }): string | null {
  if (script.language !== "python" && script.language !== "javascript") return "Choose Python or JavaScript.";
  if (script.code.length > 65536) return "Use at most 65,536 characters.";
  if (script.language === "javascript") {
    try { new Function("event", "inputs", "parameters", "app", `"use strict"; return (async () => {\n${script.code}\n})();`); }
    catch (reason) { return `JavaScript syntax: ${reason instanceof Error ? reason.message : String(reason)}`; }
  }
  return null;
}

/** Gateway system functions shared by Python actions, events, resources and table commits. */
export const pythonSystemCompletions: Completion[] = [
  { label: "system.tag.readBlocking", type: "function", detail: "Read current gateway tags" },
  { label: "system.tag.writeBlocking", type: "function", detail: "Write configured shared gateway tags" },
  { label: "system.db.runNamedQuery", type: "function", detail: "Run a project named query" },
  { label: "system.ui.getSessionInfo", type: "function", detail: "List active operator tab sessions in this project" },
  { label: "system.ui.sendMessage", type: "function", detail: "Send a bounded payload to project operator sessions; optional sessionId targets one tab" },
  { label: "system.util.getLogger", type: "function", detail: "Create a named gateway logger" },
  { label: "system.util.sendMessage", type: "function", detail: "Enqueue a published message handler on this gateway" },
  { label: "system.util.sendRequest", type: "function", detail: "Call a published gateway message handler and return its result" },
  { label: "system.util.sendRequestAsync", type: "function", detail: "Call a published gateway message handler and return a Python Future" },
  { label: "system.util.jsonEncode", type: "function", detail: "Encode a Python value as JSON text" },
  { label: "system.util.jsonDecode", type: "function", detail: "Decode JSON text into a Python value" },
  { label: "system.date.now", type: "function", detail: "Read the gateway's current timestamp" },
];

export function pythonEventCompletions(components: CanvasComponent[], eventProperties: string[], owner?: CanvasComponent, cleanup = false): Completion[] {
  return [
    ...eventProperties.map(property => ({ label: `event.${property}`, type: "property", detail: "Event snapshot · attribute or dictionary access" })),
    ...["text", "enabled", "visible", "color", "backgroundColor", "foregroundColor", "borderColor", "borderWidth", "fontSize"].filter(property => owner?.type !== "passwordInput" || property !== "text").map(property => ({ label: `self.${property}`, type: "property", detail: cleanup ? "Captured property · cleanup is read-only" : "This component in the receiving session" })),
    ...(owner && isInput(owner.type) && owner.type !== "passwordInput" ? [{ label: "self.value", type: "property", detail: cleanup ? "Captured form value · cleanup is read-only" : pythonInputWritable(owner) ? "Read or stage a typed form value; programmatic writes do not fire input events" : "Read current form value; update its binding or source to change it" }] : []),
    { label: "self.props", type: "variable", detail: "Allowed presentation properties and non-password input value" },
    { label: "self.getSibling", type: "function", detail: "Find a component by ID in this form" },
    { label: "self.parent.getChild", type: "function", detail: "Find a component by ID in this form" },
    { label: "self.parent.custom", type: "variable", detail: "Declared screen or private template state" },
    ...components.filter(item => item.type !== "passwordInput").map(item => ({ label: `self.getSibling(${JSON.stringify(item.id)})`, type: "variable", detail: `${item.props.text || item.type} · this form` })),
    ...components.filter(item => isInput(item.type) && item.type !== "passwordInput").map(item => ({ label: `self.getSibling(${JSON.stringify(item.id)}).value`, type: "property", detail: cleanup || !pythonInputWritable(item) ? "Read captured form value; assignment unavailable" : "Read or stage a typed form value in this form" })),
    ...["getState", "setState", "getProperty", "setProperty"].map(method => ({ label: `system.ui.${method}`, type: "function", detail: "Read or stage scoped UI changes" })),
    ...pythonSystemCompletions,
    { label: "inputs", type: "variable", detail: "Form snapshot; password fields omitted" },
    { label: "parameters", type: "variable", detail: "Screen or template parameter snapshot" },
    { label: "print", type: "function", detail: "Write execution output" },
    { label: "result", type: "variable", detail: "Returned result or message" },
    ...["import", "from", "def", "return", "if", "else", "for", "True", "False", "None"].map(label => ({ label, type: "keyword" })),
  ];
}
