import type { CanvasComponent } from "./types";

export type IndicatorState = { value: string; label: string; color: string };
const hexColor = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Unknown and malformed state maps never retain a previously displayed state. */
export function resolveIndicatorState(props: CanvasComponent["props"]): {
  state?: IndicatorState; diagnostic?: string;
} {
  const states = props.states;
  if (!Array.isArray(states) || states.length < 1 || states.length > 32 ||
      states.some(state => !state || Object.keys(state).length !== 3 || !["value", "label", "color"].every(key => Object.hasOwn(state, key)) ||
        typeof state.value !== "string" || !state.value.trim() || state.value.length > 128 ||
        typeof state.label !== "string" || !state.label.trim() || state.label.length > 128 ||
        typeof state.color !== "string" || state.color.trim() !== state.color || !hexColor.test(state.color)) ||
      new Set(states.map(state => state.value)).size !== states.length)
    return { diagnostic: "Configure 1–32 unique states with labels and colors." };
  if (typeof props.stateValue !== "string" || props.stateValue.length > 4096) return { diagnostic: "State unavailable" };
  const state = states.find(item => item.value === props.stateValue);
  return state ? { state } : { diagnostic: "Unknown state" };
}
