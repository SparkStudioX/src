import { resolvePath } from "./api";
import type { CanvasComponent, RuntimeParameters } from "./types";

export const processDisplayTypes = ["ledDisplay", "progressBar", "cylindricalTank", "levelIndicator", "thermometer"] as const;
export function isProcessDisplay(type: string): boolean { return (processDisplayTypes as readonly string[]).includes(type); }

export interface ProcessDisplayValue {
  available: true;
  value: number;
  formatted: string;
  unit: string;
  decimals: number;
  showValue: boolean;
  showPercent: boolean;
  orientation: "horizontal" | "vertical";
  min?: number;
  max?: number;
  ratio?: number;
  /** Percentage describes the clamped fill, not an off-scale measurement. */
  percent?: string;
  rangeStatus?: "below" | "above";
}
export type ProcessDisplayResult = ProcessDisplayValue | { available: false; diagnostic: string };
const exactNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));

/** Pure presentation model. A failed binding must never fall back to a static default. */
export function resolveProcessDisplay(component: CanvasComponent, parameters: RuntimeParameters = {}): ProcessDisplayResult {
  if (!isProcessDisplay(component.type)) return { available: false, diagnostic: "Unsupported process display." };
  const props = component.props;
  const read = (key: string, fallback: unknown, label: string): unknown => {
    if (Object.hasOwn(props.bindings ?? {}, key) && props[key] === undefined) throw new Error(`${label} binding is unavailable.`);
    return props[key] === undefined ? fallback : props[key];
  };
  const number = (key: string, fallback: number, label: string): number => {
    const value = read(key, fallback, label);
    if (!exactNumber(value)) throw new Error(`${label} requires an exact finite number.`);
    return value;
  };
  const boolean = (key: string, fallback: boolean, label: string): boolean => {
    const value = read(key, fallback, label);
    if (typeof value !== "boolean") throw new Error(`${label} requires true or false.`);
    return value;
  };
  try {
    const value = number("value", 0, "Value");
    const decimals = number("decimals", 1, "Decimal places");
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) throw new Error("Decimal places must be an integer from 0 to 6.");
    const rawUnit = read("unit", "", "Unit");
    if (typeof rawUnit !== "string") throw new Error("Unit must be text up to 32 characters.");
    const unit = Object.hasOwn(props.bindings ?? {}, "unit") ? rawUnit : resolvePath(rawUnit, parameters);
    if (rawUnit.length > 32 || unit.length > 32) throw new Error("Unit must be text up to 32 characters.");
    const formatted = (Object.is(value, -0) ? 0 : value).toFixed(decimals);
    if (component.type === "ledDisplay") return { available: true, value, formatted, decimals, unit, showValue: true, showPercent: false, orientation: "horizontal" };
    const min = number("min", 0, "Minimum"), max = number("max", 100, "Maximum");
    if (min >= max) throw new Error("Minimum must be less than maximum.");
    const showValue = boolean("showValue", true, "Show value"), showPercent = boolean("showPercent", false, "Show percentage");
    const oriented = component.type === "progressBar" || component.type === "levelIndicator";
    const orientation = oriented ? read("orientation", component.type === "progressBar" ? "horizontal" : "vertical", "Orientation") : "vertical";
    if (orientation !== "horizontal" && orientation !== "vertical") throw new Error("Orientation must be horizontal or vertical.");
    const rangeStatus = value < min ? "below" : value > max ? "above" : undefined;
    // Compare before dividing, so extreme valid values cannot overflow an off-scale ratio.
    const ratio = value <= min ? 0 : value >= max ? 1 : (value - min) / (max - min);
    return { available: true, value, formatted, unit, decimals, min, max, ratio, percent: `${(ratio * 100).toFixed(decimals)}%`,
      showValue, showPercent, orientation, ...(rangeStatus ? { rangeStatus } : {}) };
  } catch (reason) { return { available: false, diagnostic: reason instanceof Error ? reason.message : String(reason) }; }
}
