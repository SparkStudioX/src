import type { CanvasComponent } from "./types";

/**
 * Show a message buttons only display their fixed text in the browser. Hosts call this first and skip
 * their gateway action path when it returns true; no script runs and nothing is sent to the gateway.
 */
export function showNotifyAction(component: CanvasComponent, instance: { isCurrent?: () => boolean } | undefined, show: (message: string) => void): boolean {
  if (component.props.action !== "notify") return false;
  if (instance?.isCurrent?.() !== false) show(component.props.notifyMessage || "");
  return true;
}
