import type { CanvasComponent, DrawingPoint } from "./types";

export const drawingTypes = ["line", "rectangle", "ellipse", "polyline", "pipe", "equipmentSymbol"] as const;
export const drawingBindingTargets = ["strokeColor", "fillColor", "strokeWidth", "rotation", "flowing", "flowReverse", "active"] as const;
export function isDrawingComponent(type: string): boolean { return (drawingTypes as readonly string[]).includes(type); }
export function supportsDrawingProperty(type: string, field: string): boolean {
  if (!isDrawingComponent(type)) return false;
  if (["strokeColor", "strokeWidth", "rotation"].includes(field)) return true;
  if (field === "fillColor") return ["rectangle", "ellipse", "pipe", "equipmentSymbol"].includes(type);
  if (field === "flowing" || field === "flowReverse") return type === "pipe";
  if (field === "active" || field === "symbol") return type === "equipmentSymbol";
  if (field === "points") return ["line", "polyline", "pipe"].includes(type);
  return field === "cornerRadius" && type === "rectangle";
}
export function drawingDefaults(type: string): CanvasComponent["props"] {
  if (!isDrawingComponent(type)) return {};
  return {
    strokeColor: "#64748b", strokeWidth: type === "pipe" ? 12 : 2, rotation: 0,
    ...(supportsDrawingProperty(type, "fillColor") ? { fillColor: type === "pipe" ? "#334155" : type === "equipmentSymbol" ? "#64748b" : "none" } : {}),
    ...(supportsDrawingProperty(type, "points") ? { points: type === "polyline" ? [{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 50, y: 0 }, { x: 100, y: 0 }] : [{ x: 0, y: 50 }, { x: 100, y: 50 }] } : {}),
    ...(type === "rectangle" ? { cornerRadius: 0 } : {}),
    ...(type === "pipe" ? { flowing: false, flowReverse: false } : {}),
    ...(type === "equipmentSymbol" ? { symbol: "pump" as const, active: false } : {}),
  };
}
const finite = (value: unknown, minimum: number, maximum: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
const color = (value: unknown) => typeof value === "string" && value.trim() === value && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const fields = [...drawingBindingTargets, "points", "symbol", "cornerRadius"];

/** A property is structural unless it has an explicitly supported scalar binding. */
export function validateDrawingProps(type: string, props: Record<string, unknown>, resolved = false): string | null {
  if (!isDrawingComponent(type)) return null;
  if (props.color !== undefined && !color(props.color)) return "Accent color must be a hex color.";
  for (const field of ["svg", "path", "d", "markup", "src", "url", "href", "script", "tagPath"])
    if (props[field] !== undefined) return "Drawing components accept typed geometry and built-in symbols, not markup, URLs or scripts.";
  for (const field of fields) {
    if (props[field] === undefined) {
      if (resolved && (object(props.bindings) && Object.hasOwn(props.bindings, field) || object(props.queryBindings) && Object.hasOwn(props.queryBindings, field))) return `${field} binding is unavailable.`;
      continue;
    }
    if (!supportsDrawingProperty(type, field)) return `${field} is not supported on ${type}.`;
    const value = props[field];
    if (field === "strokeColor" && !color(value)) return "Stroke color must be a hex color.";
    if (field === "fillColor" && value !== "none" && !color(value)) return "Fill must be a hex color or 'none'.";
    if (field === "strokeWidth" && !finite(value, 1, 32)) return "Stroke width must be a finite number from 1 to 32.";
    if (field === "rotation" && !finite(value, 0, 360)) return "Rotation must be a finite number from 0 to 360 degrees.";
    if (field === "cornerRadius" && !finite(value, 0, 50)) return "Corner radius must be a finite percentage from 0 to 50.";
    if (["flowing", "flowReverse", "active"].includes(field) && typeof value !== "boolean") return `${field} must be true or false.`;
    if (field === "symbol" && !["pump", "valve", "motor"].includes(value as string)) return "Choose a pump, valve or motor symbol.";
    if (field === "points") {
      if (!Array.isArray(value) || value.length < 2 || value.length > (type === "line" ? 2 : 64)) return type === "line" ? "A line needs exactly two points." : "A path needs 2–64 points.";
      for (let index = 0; index < value.length; index++) {
        const point: unknown = value[index];
        if (!object(point) || Object.keys(point).length !== 2 || !Object.hasOwn(point, "x") || !Object.hasOwn(point, "y") || !finite(point.x, 0, 100) || !finite(point.y, 0, 100)) return `Point ${index + 1} must contain only finite X/Y percentages from 0 to 100.`;
        if (index && point.x === value[index - 1].x && point.y === value[index - 1].y) return "Consecutive points must be different.";
      }
    }
  }
  if (props.action !== undefined && (type !== "equipmentSymbol" || !["navigate", "openPopup"].includes(props.action as string))) return "Only equipment symbols support navigation or popup actions.";
  if (props.action !== undefined && (typeof props.targetScreenId !== "string" || !props.targetScreenId.trim())) return "Choose a destination screen for this symbol.";
  return null;
}

export interface DrawingModel {
  available: boolean;
  diagnostic?: string;
  points: DrawingPoint[];
  strokeColor: string;
  fillColor: string;
  strokeWidth: number;
  rotation: number;
  flowing: boolean;
  flowReverse: boolean;
  active: boolean;
  symbol: "pump" | "valve" | "motor";
  cornerRadius: number;
}
export function resolveDrawingComponent(component: CanvasComponent): DrawingModel {
  const fallback: DrawingModel = { available: false, points: [], strokeColor: "#64748b", fillColor: "none", strokeWidth: 2, rotation: 0, flowing: false, flowReverse: false, active: false, symbol: "pump", cornerRadius: 0 };
  if (!isDrawingComponent(component.type)) return { ...fallback, diagnostic: "Unsupported drawing component." };
  const diagnostic = validateDrawingProps(component.type, component.props, true);
  if (diagnostic) return { ...fallback, diagnostic };
  if (!finite(component.width, 1, 8192) || !finite(component.height, 1, 8192)) return { ...fallback, diagnostic: "Drawing width and height must be from 1 to 8,192." };
  // Accent drives active/flow indication: missing bound accent must not imply a healthy state.
  if ((Object.hasOwn(component.props.bindings ?? {}, "color") || Object.hasOwn(component.props.queryBindings ?? {}, "color")) && component.props.color === undefined) return { ...fallback, diagnostic: "Accent color binding is unavailable." };
  const props = { ...drawingDefaults(component.type), ...Object.fromEntries(Object.entries(component.props).filter(([, value]) => value !== undefined)) };
  return { ...fallback, available: true, points: (props.points as DrawingPoint[] | undefined)?.map(point => ({ ...point })) ?? [],
    strokeColor: props.strokeColor as string, fillColor: props.fillColor as string ?? "none", strokeWidth: props.strokeWidth as number, rotation: props.rotation as number,
    flowing: props.flowing === true, flowReverse: props.flowReverse === true, active: props.active === true,
    symbol: (props.symbol as DrawingModel["symbol"] | undefined) ?? "pump", cornerRadius: props.cornerRadius as number ?? 0 };
}
