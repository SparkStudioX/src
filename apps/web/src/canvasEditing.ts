import type { CanvasComponent, Project } from "./types";
import { isInput } from "./inputs";

export interface Point {
  x: number;
  y: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export interface SelectionBounds extends Point, CanvasSize {}
export type ComponentSelection = Iterable<string>;
export type Alignment = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
export type Distribution = "horizontal" | "vertical";
export type MatchingSize = "width" | "height" | "both";

export interface DuplicateOptions {
  offset?: Point;
  gridSize?: number;
  createId?: (original: CanvasComponent) => string;
}

export interface ProjectHistory { past: Project[]; future: Project[]; coalescing?: { key: string; at: number } }

/** Revisions identify server writes, not undoable application content. */
export function projectContent(project: Project): string {
  const { revision: _revision, ...content } = project;
  return JSON.stringify(content);
}

export function checkpoint(history: ProjectHistory, project: Project, key?: string, at = Date.now()): ProjectHistory {
  const together = key !== undefined && history.coalescing?.key === key && at >= history.coalescing.at
    && at - history.coalescing.at <= 750 && history.future.length === 0;
  return { past: together ? history.past : [...history.past.slice(-29), project], future: [], ...(key ? { coalescing: { key, at } } : {}) };
}

export function restoreHistory(history: ProjectHistory, current: Project, direction: "undo" | "redo"):
  { history: ProjectHistory; project: Project } | null {
  const source = direction === "undo" ? history.past : history.future;
  const snapshot = source[source.length - 1];
  if (!snapshot) return null;
  return {
    project: { ...snapshot, revision: current.revision },
    history: direction === "undo"
      ? { past: history.past.slice(0, -1), future: [...history.future.slice(-29), current] }
      : { past: [...history.past.slice(-29), current], future: history.future.slice(0, -1) },
  };
}

/** Normalize reverse drags and omit invalid coordinates. */
export function marqueeBounds(start: Point, end: Point): SelectionBounds | null {
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return null;
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

/** Select intersecting controls in z-order; modifier drags add to existing selection. */
export function marqueeSelection(components: readonly CanvasComponent[], bounds: SelectionBounds, existing: ComponentSelection = []): string[] {
  const selected = new Set(existing);
  if (bounds.width > 0 && bounds.height > 0 && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
    for (const component of components) {
      if (validGeometry(component) && component.x < bounds.x + bounds.width && component.x + component.width > bounds.x && component.y < bounds.y + bounds.height && component.y + component.height > bounds.y)
        selected.add(component.id);
    }
  }
  return expandGroupSelection(components, selected);
}

/** A flat group is always an atomic canvas selection within its current document. */
export function expandGroupSelection(components: readonly CanvasComponent[], selectedIds: ComponentSelection): string[] {
  const selected = new Set(selectedIds);
  const groups = new Set(components.filter(component => selected.has(component.id) && component.groupId).map(component => component.groupId!));
  return components.filter(component => selected.has(component.id) || Boolean(component.groupId && groups.has(component.groupId))).map(component => component.id);
}

export function toggleGroupSelection(components: readonly CanvasComponent[], selectedIds: ComponentSelection, componentId: string): string[] {
  const selected = new Set(expandGroupSelection(components, selectedIds));
  const members = expandGroupSelection(components, [componentId]);
  if (selected.has(componentId)) members.forEach(id => selected.delete(id));
  else members.forEach(id => selected.add(id));
  return components.filter(component => selected.has(component.id)).map(component => component.id);
}

/** Type selection is local to one document and keeps saved groups atomic. */
export function selectComponentType(components: readonly CanvasComponent[], type: string): string[] {
  return expandGroupSelection(components, components.filter(component => component.type === type).map(component => component.id));
}

/** Zero disables the grid; custom grids are whole design pixels up to 128. */
export function parseGridSize(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 && size <= 128 ? size : null;
}

export function groupSelected(components: readonly CanvasComponent[], selectedIds: ComponentSelection, groupId: string): CanvasComponent[] {
  const ids = new Set(expandGroupSelection(components, selectedIds));
  const selected = components.filter(component => ids.has(component.id));
  if (selected.length < 2 || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(groupId)) return [...components];
  if (selected[0].groupId && selected.every(component => component.groupId === selected[0].groupId)) return [...components];
  const used = new Set(components.flatMap(component => component.groupId ? [component.groupId] : []));
  const nextGroupId = uniqueName(groupId, used, 64);
  return components.map(component => ids.has(component.id) ? { ...component, groupId: nextGroupId } : component);
}

export function ungroupSelected(components: readonly CanvasComponent[], selectedIds: ComponentSelection): CanvasComponent[] {
  const ids = new Set(expandGroupSelection(components, selectedIds));
  return components.map(component => {
    if (!ids.has(component.id) || !component.groupId) return component;
    const { groupId: _groupId, ...ungrouped } = component;
    return ungrouped;
  });
}

export function deleteSelected(components: readonly CanvasComponent[], selectedIds: ComponentSelection): CanvasComponent[] {
  const ids = new Set(expandGroupSelection(components, selectedIds));
  return components.filter(component => !ids.has(component.id));
}

interface ArrangementUnit { ids: Set<string>; bounds: SelectionBounds }
function arrangementUnits(components: readonly CanvasComponent[], selectedIds: ComponentSelection): ArrangementUnit[] {
  const ids = new Set(expandGroupSelection(components, selectedIds));
  const members = new Map<string, CanvasComponent[]>();
  for (const component of components) {
    if (!ids.has(component.id)) continue;
    const key = component.groupId ? `group:${component.groupId}` : `component:${component.id}`;
    members.set(key, [...(members.get(key) ?? []), component]);
  }
  const units: ArrangementUnit[] = [];
  for (const values of members.values()) {
    const bounds = selectionBounds(values);
    if (!bounds) return [];
    units.push({ ids: new Set(values.map(component => component.id)), bounds });
  }
  return units;
}

export function arrangementCount(components: readonly CanvasComponent[], selectedIds: ComponentSelection): number {
  return arrangementUnits(components, selectedIds).length;
}

/** Match the first selected unit in layer order without moving its origin.
 * Groups scale on requested axes. Reject the whole edit if any target cannot fit,
 * rather than quietly producing different sizes or partially changing selection.
 */
export function matchSelectedSize(
  components: readonly CanvasComponent[], selectedIds: ComponentSelection,
  dimension: MatchingSize, canvas: CanvasSize,
): { components: CanvasComponent[]; error?: string } {
  const units = arrangementUnits(components, selectedIds);
  if (units.length < 2 || !validCanvas(canvas) || !["width", "height", "both"].includes(dimension)) return { components: [...components] };
  const reference = units[0].bounds;
  const sizing = new Map<string, { bounds: SelectionBounds; scaleX: number; scaleY: number; width: number; height: number; single: boolean }>();
  for (const unit of units.slice(1)) {
    const scaleX = dimension === "height" ? 1 : reference.width / unit.bounds.width;
    const scaleY = dimension === "width" ? 1 : reference.height / unit.bounds.height;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY))
      return { components: [...components], error: "The selected geometry cannot be resized safely. Correct its dimensions in the property sheet first." };
    const width = dimension === "height" ? unit.bounds.width : reference.width;
    const height = dimension === "width" ? unit.bounds.height : reference.height;
    if (unit.bounds.x < 0 || unit.bounds.y < 0 || unit.bounds.x + width > canvas.width || unit.bounds.y + height > canvas.height)
      return { components: [...components], error: "The matching size would extend beyond the canvas. Move the selected objects inward, then try again." };
    for (const component of components.filter(item => unit.ids.has(item.id))) {
      if ((scaleX !== 1 && (unit.ids.size === 1 ? width : component.width * scaleX) < 40) || (scaleY !== 1 && (unit.ids.size === 1 ? height : component.height * scaleY) < 28))
        return { components: [...components], error: "The matching size would make a control smaller than 40 × 28 pixels. Choose a larger reference object or ungroup the controls." };
      sizing.set(component.id, { bounds: unit.bounds, scaleX, scaleY, width, height, single: unit.ids.size === 1 });
    }
  }
  return { components: components.map(component => {
    const target = sizing.get(component.id);
    if (!target || target.scaleX === 1 && target.scaleY === 1) return component;
    return {
      ...component,
      x: target.bounds.x + (component.x - target.bounds.x) * target.scaleX,
      y: target.bounds.y + (component.y - target.bounds.y) * target.scaleY,
      width: target.single ? target.width : component.width * target.scaleX,
      height: target.single ? target.height : component.height * target.scaleY,
    };
  }) };
}

const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));
const validCanvas = (canvas: CanvasSize) =>
  Number.isFinite(canvas.width) && canvas.width > 0 &&
  Number.isFinite(canvas.height) && canvas.height > 0;
const validGeometry = (component: CanvasComponent) =>
  [component.x, component.y, component.width, component.height].every(Number.isFinite) &&
  component.width > 0 && component.height > 0 &&
  Number.isFinite(component.x + component.width) &&
  Number.isFinite(component.y + component.height);

/** Missing/nonpositive grid sizes disable snapping. Coordinates may be fractional. */
export function snapToGrid(value: number, gridSize = 8): number {
  if (!Number.isFinite(value) || !Number.isFinite(gridSize) || gridSize <= 0) return value;
  const snapped = Math.round(value / gridSize) * gridSize;
  return Number.isFinite(snapped) ? snapped : value;
}

/** Omit selectedIds to measure every supplied component. Invalid geometry is a no-op. */
export function selectionBounds(
  components: readonly CanvasComponent[],
  selectedIds?: ComponentSelection,
): SelectionBounds | null {
  const ids = selectedIds === undefined ? null : new Set(selectedIds);
  const selected = ids ? components.filter(component => ids.has(component.id)) : components;
  if (!selected.length || selected.some(component => !validGeometry(component))) return null;
  const x = Math.min(...selected.map(component => component.x));
  const y = Math.min(...selected.map(component => component.y));
  const right = Math.max(...selected.map(component => component.x + component.width));
  const bottom = Math.max(...selected.map(component => component.y + component.height));
  if (!Number.isFinite(right - x) || !Number.isFinite(bottom - y)) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function constrainedDelta(origin: number, span: number, limit: number, desired: number): number {
  // An oversized imported selection cannot fit: anchor it at zero, without distortion.
  return span > limit ? -origin : clamp(desired, -origin, limit - origin - span);
}

function moveDelta(bounds: SelectionBounds, desired: Point, canvas: CanvasSize, gridSize?: number): Point {
  const x = snapToGrid(bounds.x + finite(desired.x), gridSize ?? 0) - bounds.x;
  const y = snapToGrid(bounds.y + finite(desired.y), gridSize ?? 0) - bounds.y;
  return {
    x: constrainedDelta(bounds.x, bounds.width, canvas.width, x),
    y: constrainedDelta(bounds.y, bounds.height, canvas.height, y),
  };
}

/** Apply one delta to the group. Bounds take precedence over the final grid position. */
export function moveSelected(
  components: readonly CanvasComponent[],
  selectedIds: ComponentSelection,
  desiredDelta: Point,
  canvas: CanvasSize,
  gridSize?: number,
): CanvasComponent[] {
  const ids = new Set(expandGroupSelection(components, selectedIds));
  const bounds = selectionBounds(components, ids);
  if (!bounds || !validCanvas(canvas)) return [...components];
  const delta = moveDelta(bounds, desiredDelta, canvas, gridSize);
  return components.map(component => ids.has(component.id) && (delta.x !== 0 || delta.y !== 0)
    ? { ...component, x: component.x + delta.x, y: component.y + delta.y }
    : component);
}

/** Bottom/right resize to an absolute size; keep the origin unless it cannot fit the minimum. */
export function resizeComponent(
  component: CanvasComponent,
  desiredSize: CanvasSize,
  canvas: CanvasSize,
  gridSize?: number,
): CanvasComponent {
  if (!validGeometry(component) || !validCanvas(canvas)) return component;
  const minWidth = Math.min(40, canvas.width);
  const minHeight = Math.min(28, canvas.height);
  const x = clamp(component.x, 0, canvas.width - minWidth);
  const y = clamp(component.y, 0, canvas.height - minHeight);
  const width = clamp(
    snapToGrid(x + finite(desiredSize.width, component.width), gridSize ?? 0) - x,
    minWidth,
    canvas.width - x,
  );
  const height = clamp(
    snapToGrid(y + finite(desiredSize.height, component.height), gridSize ?? 0) - y,
    minHeight,
    canvas.height - y,
  );
  return { ...component, x, y, width, height };
}

/** Scale a persistent group's boxes about its top-left corner using one factor per axis. */
export function resizeGroup(
  components: readonly CanvasComponent[],
  groupId: string,
  desiredSize: CanvasSize,
  canvas: CanvasSize,
  gridSize?: number,
): CanvasComponent[] {
  const members = components.filter(component => component.groupId === groupId);
  const bounds = selectionBounds(members);
  if (members.length < 2 || !bounds || !validCanvas(canvas) || bounds.x < 0 || bounds.y < 0) return [...components];
  const minimumX = Math.max(...members.map(component => 40 / component.width));
  const minimumY = Math.max(...members.map(component => 28 / component.height));
  const maximumX = (canvas.width - bounds.x) / bounds.width;
  const maximumY = (canvas.height - bounds.y) / bounds.height;
  if (maximumX < minimumX || maximumY < minimumY) return [...components];
  const width = snapToGrid(bounds.x + finite(desiredSize.width, bounds.width), gridSize ?? 0) - bounds.x;
  const height = snapToGrid(bounds.y + finite(desiredSize.height, bounds.height), gridSize ?? 0) - bounds.y;
  const scaleX = clamp(width / bounds.width, minimumX, maximumX);
  const scaleY = clamp(height / bounds.height, minimumY, maximumY);
  if (scaleX === 1 && scaleY === 1) return [...components];
  return components.map(component => component.groupId === groupId ? {
    ...component,
    x: bounds.x + (component.x - bounds.x) * scaleX,
    y: bounds.y + (component.y - bounds.y) * scaleY,
    width: component.width * scaleX,
    height: component.height * scaleY,
  } : component);
}

export function alignSelected(
  components: readonly CanvasComponent[],
  selectedIds: ComponentSelection,
  alignment: Alignment,
): CanvasComponent[] {
  const ids = new Set(expandGroupSelection(components, selectedIds));
  const bounds = selectionBounds(components, ids);
  const units = arrangementUnits(components, ids);
  if (!bounds || units.length < 2) return [...components];
  return components.map(component => {
    if (!ids.has(component.id)) return component;
    const unit = units.find(item => item.ids.has(component.id))!.bounds;
    switch (alignment) {
      case "left": return { ...component, x: component.x + bounds.x - unit.x };
      case "hcenter": return { ...component, x: component.x + bounds.x + (bounds.width - unit.width) / 2 - unit.x };
      case "right": return { ...component, x: component.x + bounds.x + bounds.width - unit.width - unit.x };
      case "top": return { ...component, y: component.y + bounds.y - unit.y };
      case "vcenter": return { ...component, y: component.y + bounds.y + (bounds.height - unit.height) / 2 - unit.y };
      case "bottom": return { ...component, y: component.y + bounds.y + bounds.height - unit.height - unit.y };
    }
  });
}

/** Preserve spatial order and outer bounds. Overfull selections remain unchanged. */
export function distributeSelected(
  components: readonly CanvasComponent[],
  selectedIds: ComponentSelection,
  direction: Distribution,
): CanvasComponent[] {
  const ids = new Set(expandGroupSelection(components, selectedIds));
  const selected = components.filter(component => ids.has(component.id));
  const bounds = selectionBounds(selected);
  const units = arrangementUnits(components, ids);
  if (units.length < 3 || !bounds) return [...components];
  const position = direction === "horizontal" ? "x" : "y";
  const dimension = direction === "horizontal" ? "width" : "height";
  const sorted = [...units].sort((a, b) => a.bounds[position] - b.bounds[position]);
  const total = sorted.reduce((sum, unit) => sum + unit.bounds[dimension], 0);
  const space = bounds[dimension] - total;
  if (space < 0) return [...components];
  const gap = space / (sorted.length - 1);
  const positions = new Map<string, number>();
  let next = bounds[position];
  sorted.forEach((unit, index) => {
    // Pin the last edge exactly, avoiding accumulated fractional error.
    const delta = (index === sorted.length - 1 ? bounds[position] + bounds[dimension] - unit.bounds[dimension] : next) - unit.bounds[position];
    unit.ids.forEach(id => positions.set(id, delta));
    next += unit.bounds[dimension] + gap;
  });
  return components.map(component => positions.has(component.id)
    ? { ...component, [position]: component[position] + positions.get(component.id)! }
    : component);
}

function uniqueName(base: string, used: Set<string>, maximumLength = Number.POSITIVE_INFINITY): string {
  let candidate = base.slice(0, maximumLength);
  let suffix = 2;
  while (used.has(candidate)) {
    const ending = `_${suffix++}`;
    candidate = `${base.slice(0, maximumLength - ending.length)}${ending}`;
  }
  used.add(candidate);
  return candidate;
}

function fieldBase(component: CanvasComponent): string {
  const original = component.props.fieldKey || component.id || component.type;
  const clean = original.replace(/[^A-Za-z0-9_]/g, "_");
  const start = /^[A-Za-z_]/.test(clean) ? clean : `_${clean}`;
  return `${start.slice(0, 59)}_copy`;
}

/** Append deep copies in z-order; preserve internal custom-property links within copied selections. */
export function duplicateSelected(
  components: readonly CanvasComponent[],
  selectedIds: ComponentSelection,
  canvas: CanvasSize,
  options: DuplicateOptions = {},
): { components: CanvasComponent[]; selectedIds: string[] } {
  const ids = new Set(expandGroupSelection(components, selectedIds));
  const selected = components.filter(component => ids.has(component.id));
  const bounds = selectionBounds(selected);
  if (!bounds || !validCanvas(canvas)) return { components: [...components], selectedIds: [] };
  const delta = moveDelta(bounds, options.offset ?? { x: 16, y: 16 }, canvas, options.gridSize);
  const usedIds = new Set(components.map(component => component.id));
  const usedGroups = new Set(components.flatMap(component => component.groupId ? [component.groupId] : []));
  const copiedGroups = new Map<string, string>();
  const usedFields = new Set(components
    .filter(component => isInput(component.type))
    .map(component => component.props.fieldKey || component.id));
  const copies = selected.map(component => {
    const desiredId = options.createId?.(component)?.trim() || `${component.id}_copy`;
    const copy = {
      ...component,
      id: uniqueName(desiredId, usedIds),
      x: component.x + delta.x,
      y: component.y + delta.y,
      props: structuredClone(component.props),
    };
    if (isInput(component.type))
      copy.props.fieldKey = uniqueName(fieldBase(component), usedFields, 64);
    if (component.groupId) {
      if (!copiedGroups.has(component.groupId)) copiedGroups.set(component.groupId, uniqueName(`${component.groupId.slice(0, 59)}_copy`, usedGroups, 64));
      copy.groupId = copiedGroups.get(component.groupId)!;
    }
    return copy;
  });
  const copiedIds = new Map(selected.map((component, index) => [component.id, copies[index].id]));
  for (const copy of copies) {
    for (const binding of [...Object.values(copy.props.bindings || {}), ...Object.values(copy.props.parameterBindings || {})]) {
      for (const reference of Object.values(binding?.references || {})) {
        if (reference.kind === "custom" && reference.componentId && copiedIds.has(reference.componentId))
          reference.componentId = copiedIds.get(reference.componentId)!;
      }
    }
  }
  return { components: [...components, ...copies], selectedIds: copies.map(component => component.id) };
}
