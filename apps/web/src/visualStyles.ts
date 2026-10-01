import type { CanvasComponent, Project, VisualStyle, VisualStyleProperty } from "./types";

export const visualStyleProperties: VisualStyleProperty[] = ["color", "backgroundColor", "foregroundColor", "borderColor", "borderWidth", "fontSize"];
export const visualStyleLabels: Record<VisualStyleProperty, string> = {
  color: "Accent", backgroundColor: "Background", foregroundColor: "Text color", borderColor: "Border color", borderWidth: "Border width", fontSize: "Font size",
};
const color = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (message: string): never => { throw new Error(message); };

/** Native controls must follow their resolved opaque surface, including in the opposite app theme. */
export function nativeControlColorScheme(background: string | undefined): "light" | "dark" | undefined {
  if (!background || !color.test(background)) return undefined;
  let hex = background.slice(1);
  if (hex.length <= 4) hex = [...hex].map(digit => digit + digit).join("");
  if (hex.length === 8 && hex.slice(6).toLowerCase() !== "ff") return undefined;
  const channels = [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  const luminance = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  return luminance > .179 ? "light" : "dark";
}

export function validateVisualStyles(styles: unknown): asserts styles is VisualStyle[] | undefined {
  if (styles === undefined) return;
  if (!Array.isArray(styles) || styles.length > 100) fail("A project can contain at most 100 visual styles.");
  const ids = new Set<string>();
  for (const style of styles as unknown[]) {
    if (!object(style) || Object.keys(style).some(key => !["id", "name", "properties"].includes(key))) fail("Every style needs only an ID, name and properties.");
    const entry = style as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.trim() !== entry.id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.id) || ids.has(entry.id)) fail("Style IDs must be unique, 1–64 letters, numbers, dashes or underscores, beginning with a letter or number.");
    ids.add(entry.id as string);
    if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.trim() !== entry.name || entry.name.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(entry.name)) fail("Style names need 1–80 characters without outer whitespace or control characters.");
    if (!object(entry.properties) || Object.keys(entry.properties).length < 1 || Object.keys(entry.properties).some(key => !visualStyleProperties.includes(key as VisualStyleProperty))) fail("Styles need at least one supported appearance property.");
    for (const [key, value] of Object.entries(entry.properties as Record<string, unknown>)) {
      if (key === "fontSize" || key === "borderWidth") {
        if (typeof value !== "number" || !Number.isFinite(value) || value < (key === "fontSize" ? 1 : 0) || value > (key === "fontSize" ? 256 : 32)) fail(`${visualStyleLabels[key]} is outside its supported range.`);
      } else if (typeof value !== "string" || value.trim() !== value || !color.test(value)) fail(`${visualStyleLabels[key as VisualStyleProperty]} must be a hexadecimal color.`);
    }
  }
}

export function styleReferences(project: Project, styleId: string) {
  return [...project.screens.map(document => ({ document, kind: "Screen" })), ...(project.templates ?? []).map(document => ({ document, kind: "Template" }))]
    .flatMap(({ document, kind }) => document.components.filter(component => component.props.styleId === styleId)
      .map(component => ({ documentId: document.id, componentId: component.id, label: `${kind}: ${document.name} / ${component.props.text || component.id}` })));
}

export function validateProjectStyles(project: Project): void {
  validateVisualStyles(project.styles);
  const ids = new Set(project.styles?.map(style => style.id));
  for (const document of [...project.screens, ...(project.templates ?? [])]) for (const component of document.components) {
    if (component.props.styleId !== undefined && (typeof component.props.styleId !== "string" || !ids.has(component.props.styleId)))
      fail(`The style assigned to ${document.name} / ${component.id} is missing. Remove the assignment before deleting a style.`);
  }
}

/** Only the catalog changes; expected snapshot prevents stale dialogs replacing a newer draft. */
export function applyStyleCatalog(current: Project, expectedSnapshot: string, styles: VisualStyle[]): Project {
  if (JSON.stringify(current) !== expectedSnapshot) fail("The project changed while this editor was open. Close it and reopen Styles to review the current draft.");
  const next = { ...current, styles: structuredClone(styles) };
  validateProjectStyles(next);
  return next;
}

/** Theme < parent appearance < assigned style < defined local property < binding (evaluated by caller). */
export function applyVisualStyle(component: CanvasComponent, styles: VisualStyle[] | undefined,
  inherited: Partial<Pick<CanvasComponent["props"], "color" | "backgroundColor" | "foregroundColor" | "fontSize">> = {}) {
  const style = component.props.styleId === undefined ? undefined : styles?.find(item => item.id === component.props.styleId);
  let error: string | undefined;
  if (component.props.styleId !== undefined && !style) error = "Assigned visual style is missing.";
  if (style) { try { validateVisualStyles([style]); } catch { error = "Assigned visual style is invalid."; } }
  const styleValues = error ? {} : style?.properties ?? {};
  const defaults = { ...inherited };
  // Accent-bearing children must not accidentally inherit a container text color.
  if (component.props.color !== undefined || styleValues.color !== undefined || component.props.bindings?.color || component.props.queryBindings?.color) delete defaults.foregroundColor;
  const properties = { ...component.props };
  for (const key of visualStyleProperties) if (properties[key] === undefined) {
    const value = styleValues[key] ?? defaults[key as keyof typeof defaults];
    if (value !== undefined) Object.assign(properties, { [key]: value });
  }
  return { component: { ...component, props: properties }, error };
}

export function visualStyleSource(component: CanvasComponent, style: VisualStyle | undefined, key: VisualStyleProperty): string {
  if (component.props.bindings?.[key] || component.props.queryBindings?.[key]) return "Binding";
  if (component.props[key] !== undefined) return "Local override";
  if (style?.properties[key] !== undefined) return style.name;
  return "Parent / theme";
}
