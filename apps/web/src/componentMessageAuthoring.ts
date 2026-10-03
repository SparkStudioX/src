import type { ComponentMessageHandler, ComponentMessageScope } from "./types";
import { eventScriptError } from "./eventScriptAuthoring";

export const componentMessageScopes: ComponentMessageScope[] = ["instance", "screen", "session"];
export const componentMessageScopeDescriptions: Record<ComponentMessageScope, string> = {
  instance: "This form, template placement or repeater row only. Each nested template owns a separate instance.",
  screen: "This root screen or popup, including its nested templates and repeater rows. Other screens and popups are separate.",
  session: "This operator runtime tab and all its open popups. Other browser tabs and users are separate.",
};

export function componentMessageTypeError(value: string): string | null {
  // eslint-disable-next-line no-control-regex -- This character filter intentionally matches control characters.
  if (!value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return "Use a message type with 1–80 characters and no control characters.";
  return null;
}

/** Validate a local authoring draft without executing any handler. */
export function validateComponentMessageHandlers(handlers: ComponentMessageHandler[]): { index: number; message: string } | null {
  if (handlers.length > 16) return { index: 16, message: "A component can have at most 16 message handlers." };
  const ids = new Set<string>(), keys = new Set<string>();
  for (const [index, handler] of handlers.entries()) {
    const invalid = (message: string) => ({ index, message });
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(handler.id) || ids.has(handler.id)) return invalid("Each handler needs a unique, valid ID.");
    ids.add(handler.id);
    const typeError = componentMessageTypeError(handler.messageType);
    if (typeError) return invalid(typeError);
    if (!componentMessageScopes.includes(handler.scope)) return invalid("Choose an instance, screen or session scope.");
    const key = JSON.stringify([handler.messageType.trim(), handler.scope]);
    if (keys.has(key)) return invalid("This component already listens for that message type in this scope. Choose a different type or scope.");
    keys.add(key);
    if (!handler.code.trim() || handler.code.length > 65536) return invalid("Enter a handler with 1–65,536 characters, or remove the handler.");
    const scriptError = eventScriptError(handler);
    if (scriptError) return invalid(scriptError);
  }
  return null;
}
