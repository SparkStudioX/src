export type ProjectPaneSizes = [number, number, number];
export type ProjectPaneDivider = 0 | 1;

export const DEFAULT_PROJECT_PANES: ProjectPaneSizes = [0.38, 0.26, 0.36];
export const MIN_PROJECT_PANES: ProjectPaneSizes = [112, 84, 84];
export const PROJECT_PANE_SEPARATOR_HEIGHT = 7;

export function restoreProjectPanes(value: unknown): ProjectPaneSizes {
  if (!Array.isArray(value) || value.length !== 3 || value.some(item => typeof item !== "number" || !Number.isFinite(item) || item <= 0)) {
    return [...DEFAULT_PROJECT_PANES];
  }
  const largest = Math.max(...value);
  const scaled = value.map(item => item / largest);
  const total = scaled.reduce((sum, item) => sum + item, 0);
  return scaled.map(item => item / total) as ProjectPaneSizes;
}

/** Keep each list usable. Short windows scroll the entire stack instead of hiding a pane. */
export function fitProjectPanes(preferences: ProjectPaneSizes, containerHeight: number): ProjectPaneSizes {
  const weights = restoreProjectPanes(preferences);
  const minimumTotal = MIN_PROJECT_PANES.reduce((sum, item) => sum + item, 0);
  let remaining = Math.max(minimumTotal, (Number.isFinite(containerHeight) ? containerHeight : 0) - 2 * PROJECT_PANE_SEPARATOR_HEIGHT);
  let pending = [0, 1, 2];
  const result: ProjectPaneSizes = [0, 0, 0];
  while (pending.length) {
    const weightTotal = pending.reduce((sum, index) => sum + weights[index], 0);
    const constrained = pending.filter(index => remaining * weights[index] / weightTotal < MIN_PROJECT_PANES[index]);
    if (!constrained.length) {
      for (const index of pending) result[index] = remaining * weights[index] / weightTotal;
      break;
    }
    for (const index of constrained) {
      result[index] = MIN_PROJECT_PANES[index];
      remaining -= result[index];
    }
    pending = pending.filter(index => !constrained.includes(index));
  }
  return result;
}

/** A divider changes only its neighboring panes and never changes their combined height. */
export function moveProjectPaneDivider(heights: ProjectPaneSizes, divider: ProjectPaneDivider, delta: number): ProjectPaneSizes {
  const result: ProjectPaneSizes = [...heights];
  if (!Number.isFinite(delta)) return result;
  const next = divider + 1;
  const movement = Math.max(MIN_PROJECT_PANES[divider] - heights[divider], Math.min(heights[next] - MIN_PROJECT_PANES[next], delta));
  result[divider] += movement;
  result[next] -= movement;
  return result;
}

export function projectPaneKeyDelta(key: string, shift: boolean): number | null {
  const step = shift ? 32 : 8;
  if (key === "ArrowUp") return -step;
  if (key === "ArrowDown") return step;
  if (key === "Home") return -Number.MAX_VALUE;
  if (key === "End") return Number.MAX_VALUE;
  return null;
}

export type DesignerPaneWidths = [number, number];
export type DesignerPaneSide = 0 | 1;
export const DEFAULT_DESIGNER_PANES: DesignerPaneWidths = [244, 280];
export const MIN_DESIGNER_PANES: DesignerPaneWidths = [180, 220];
export const MAX_DESIGNER_PANES: DesignerPaneWidths = [480, 640];
export const MIN_DESIGNER_CANVAS = 320;
export const DESIGNER_PANE_SEPARATOR_WIDTH = 7;

export function restoreDesignerPanes(value: unknown): DesignerPaneWidths {
  if (!Array.isArray(value) || value.length !== 2 || value.some(item => typeof item !== "number" || !Number.isFinite(item) || item <= 0)) return [...DEFAULT_DESIGNER_PANES];
  return value.map((width, index) => Math.max(MIN_DESIGNER_PANES[index], Math.min(MAX_DESIGNER_PANES[index], width))) as DesignerPaneWidths;
}

/** Fit saved widths around a usable canvas without overwriting the saved preference. */
export function fitDesignerPanes(preferences: DesignerPaneWidths, containerWidth: number): DesignerPaneWidths {
  const widths = restoreDesignerPanes(preferences);
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return widths;
  const minimum = MIN_DESIGNER_PANES[0] + MIN_DESIGNER_PANES[1];
  const budget = Math.max(minimum, containerWidth - MIN_DESIGNER_CANVAS - DESIGNER_PANE_SEPARATOR_WIDTH * 2);
  const total = widths[0] + widths[1];
  if (total <= budget) return widths;
  const slack = total - minimum;
  return widths.map((width, index) => MIN_DESIGNER_PANES[index] + (width - MIN_DESIGNER_PANES[index]) * (budget - minimum) / slack) as DesignerPaneWidths;
}

export function designerPaneMaximum(widths: DesignerPaneWidths, side: DesignerPaneSide, containerWidth: number): number {
  return Math.max(MIN_DESIGNER_PANES[side], Math.min(MAX_DESIGNER_PANES[side], containerWidth - MIN_DESIGNER_CANVAS - DESIGNER_PANE_SEPARATOR_WIDTH * 2 - widths[1 - side]));
}

/** Only the selected pane changes; the canvas absorbs the movement. */
export function moveDesignerPane(widths: DesignerPaneWidths, side: DesignerPaneSide, delta: number, containerWidth: number): DesignerPaneWidths {
  const result: DesignerPaneWidths = [...widths];
  if (!Number.isFinite(delta)) return result;
  result[side] = Math.max(MIN_DESIGNER_PANES[side], Math.min(designerPaneMaximum(widths, side, containerWidth), widths[side] + delta));
  return result;
}

export function designerPaneKeyDelta(key: string, shift: boolean, side: DesignerPaneSide): number | null {
  const step = (shift ? 32 : 8) * (side === 0 ? 1 : -1);
  if (key === "ArrowLeft") return -step;
  if (key === "ArrowRight") return step;
  if (key === "Home") return -Number.MAX_VALUE;
  if (key === "End") return Number.MAX_VALUE;
  return null;
}
