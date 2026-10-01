import type { CanvasComponent, InputValue } from "./types";

export const textValidationTypes = new Set(["textInput", "formattedInput", "barcodeInput", "textArea", "passwordInput"]);
type MaskPart = { literal: string } | { token: "#" | "A" | "*" };
export function parseInputMask(mask: string): MaskPart[] {
  if (!mask || mask.length > 256) throw new Error("Use a mask of 1–128 positions.");
  const parts: MaskPart[] = [];
  for (let i = 0; i < mask.length; i++) {
    let char = mask[i];
    if (char === "\\") {
      if (++i === mask.length) throw new Error("A mask escape must be followed by a literal character.");
      char = mask[i]; parts.push({ literal: char });
    } else if (char === "#" || char === "A" || char === "*") parts.push({ token: char });
    else parts.push({ literal: char });
    if (char.charCodeAt(0) < 32 || char.charCodeAt(0) > 126) throw new Error("Mask positions must use printable ASCII characters.");
  }
  if (parts.length > 128 || !parts.some(part => "token" in part)) throw new Error("Use up to 128 positions including # (digit), A (letter), or * (letter/digit).");
  return parts;
}
const matches = (token: string, value: string) => token === "#" ? /^[0-9]$/.test(value) : token === "A" ? /^[A-Za-z]$/.test(value) : /^[A-Za-z0-9]$/.test(value);
const letterCase = (value: string, mode?: string) => mode === "upper" ? value.replace(/[a-z]/g, letter => letter.toUpperCase()) : mode === "lower" ? value.replace(/[A-Z]/g, letter => letter.toLowerCase()) : value;
/** Insert mask literals at commit; never discard unexpected input or silently accept a partial scan. */
export function formatInputText(component: CanvasComponent, text: string): string {
  if (component.type !== "formattedInput") return text;
  const value = letterCase(text, component.props.textCase);
  if (!value || !component.props.formatMask) return value;
  let parts: MaskPart[];
  try { parts = parseInputMask(component.props.formatMask); } catch { return value; }
  let cursor = 0, output = "";
  for (const part of parts) {
    if ("literal" in part) { output += part.literal; if (value[cursor] === part.literal) cursor++; }
    else { if (!value[cursor] || !matches(part.token, value[cursor])) return value; output += value[cursor++]; }
  }
  return cursor === value.length ? output : value;
}
export function inputDefinitionError(component: CanvasComponent): string | null {
  const { validation, formatMask, textCase, scanTerminator } = component.props;
  if (component.type === "computerCamera") {
    if (Object.hasOwn(component.props, "tagPath") || Object.hasOwn(component.props, "optionsSource") || Object.hasOwn(component.props, "selectionFields")) return "Computer cameras capture browser photos and cannot read tags, queries or selection mappings.";
    if (component.props.defaultValue !== undefined && component.props.defaultValue !== "") return "A computer camera's saved default must be omitted or empty.";
  }
  if (formatMask !== undefined) {
    if (component.type !== "formattedInput" || typeof formatMask !== "string") return "Masks belong to formatted inputs.";
    try { parseInputMask(formatMask); } catch (reason) { return reason instanceof Error ? reason.message : String(reason); }
  }
  if (textCase !== undefined && (component.type !== "formattedInput" || !["preserve", "upper", "lower"].includes(textCase))) return "Choose a supported formatted-input letter case.";
  if (scanTerminator !== undefined && (component.type !== "barcodeInput" || !["enter", "tab"].includes(scanTerminator))) return "Choose Enter or Tab for the barcode terminator.";
  if (validation === undefined) return null;
  if (!validation || typeof validation !== "object" || Array.isArray(validation) || Object.keys(validation).some(key => !["required", "minLength", "maxLength", "format", "message"].includes(key))) return "Use a supported input validation definition.";
  if (validation.required !== undefined && typeof validation.required !== "boolean") return "Required must be Boolean.";
  for (const name of ["minLength", "maxLength"] as const) {
    const bound = validation[name];
    if (bound !== undefined && (!textValidationTypes.has(component.type) || !Number.isInteger(bound) || bound < 0 || bound > 4096)) return "Text length bounds must be whole numbers from 0 to 4096.";
  }
  if ((validation.minLength ?? 0) > (validation.maxLength ?? 4096)) return "Minimum length cannot exceed maximum length.";
  if (validation.format !== undefined && (!textValidationTypes.has(component.type) || !["text", "email", "digits", "alphanumeric"].includes(validation.format))) return "Choose a supported text validation format.";
  if (validation.message !== undefined && (typeof validation.message !== "string" || validation.message.length > 200)) return "Validation messages must be text up to 200 characters.";
  return null;
}
/** Additional constraints are checked on the gateway too; this never alters values. */
export function inputConstraintError(component: CanvasComponent, value: InputValue | null | undefined): string | null {
  const definitionError = inputDefinitionError(component); if (definitionError) return definitionError;
  const { validation = {}, formatMask } = component.props;
  const message = (fallback: string) => validation.message || fallback;
  if (validation.required && (value == null || value === false || typeof value === "string" && !value.trim())) return message("A value is required.");
  if (typeof value !== "string" || !textValidationTypes.has(component.type)) return null;
  if (value.length < (validation.minLength ?? 0)) return message(`Use at least ${validation.minLength} characters.`);
  if (value.length > (validation.maxLength ?? 4096)) return message(`Use at most ${validation.maxLength ?? 4096} characters.`);
  if (value && validation.format === "email" && (/\s/.test(value) || !/^[^@]+@[^@]+\.[^@]+$/.test(value))) return message("Enter an email address.");
  if (value && validation.format === "digits" && /[^0-9]/.test(value)) return message("Use digits only.");
  if (value && validation.format === "alphanumeric" && /[^A-Za-z0-9]/.test(value)) return message("Use ASCII letters and digits only.");
  if (value && component.type === "formattedInput") {
    if (value !== letterCase(value, component.props.textCase)) return message("The value does not match the configured letter case.");
    if (formatMask) {
      const parts = parseInputMask(formatMask);
      if (value.length !== parts.length || parts.some((part, i) => "literal" in part ? value[i] !== part.literal : !matches(part.token, value[i]))) return message(`Complete the format ${formatMask}.`);
    }
  }
  return null;
}
