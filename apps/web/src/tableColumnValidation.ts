const controls = /[\u0000-\u001f\u007f-\u009f]/;
const fields = new Set(["key", "label", "visible", "width", "align", "format", "precision", "suffix"]);
const formats = new Set(["auto", "text", "number", "boolean", "datetime"]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, maximum: number, allowEmpty = false) => typeof value === "string" && value.length <= maximum && !controls.test(value) && (allowEmpty || Boolean(value.trim()));
const integer = (value: unknown, minimum: number, maximum: number) => typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;

/** Undefined and an empty array both retain automatic query-column display. */
export function validateTableColumns(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 64) return "Table columns must be an array of at most 64 definitions.";
  const keys = new Set<string>();
  let visible = 0;
  for (let index = 0; index < value.length; index++) {
    const column: unknown = value[index], prefix = `Column ${index + 1}`;
    if (!record(column) || Object.keys(column).some(key => !fields.has(key))) return `${prefix} contains an unsupported definition or property.`;
    if (!Object.hasOwn(column, "key") || !text(column.key, 128) || column.key !== (column.key as string).trim())
      return `${prefix} needs an exact source key of 1–128 characters, without outer whitespace or control characters.`;
    const key = column.key as string;
    if (keys.has(key)) return `${prefix} repeats the source key "${key}".`;
    keys.add(key);
    if (Object.hasOwn(column, "label") && !text(column.label, 120)) return `${prefix} label must contain 1–120 characters without control characters.`;
    if (Object.hasOwn(column, "visible") && typeof column.visible !== "boolean") return `${prefix} visibility must be true or false.`;
    if (!Object.hasOwn(column, "visible") || column.visible !== false) visible++;
    if (Object.hasOwn(column, "width") && !integer(column.width, 40, 1200)) return `${prefix} width must be a whole number from 40 to 1,200 pixels.`;
    if (Object.hasOwn(column, "align") && !["left", "center", "right"].includes(column.align as string)) return `${prefix} alignment must be left, center or right.`;
    if (Object.hasOwn(column, "format") && !formats.has(column.format as string)) return `${prefix} has an unsupported display format.`;
    if (Object.hasOwn(column, "precision") && (!Object.hasOwn(column, "format") || column.format !== "number" || !integer(column.precision, 0, 10))) return `${prefix} precision requires number format and a whole number from 0 to 10.`;
    if (Object.hasOwn(column, "suffix") && (!Object.hasOwn(column, "format") || column.format !== "number" || !text(column.suffix, 32, true))) return `${prefix} suffix requires number format and at most 32 characters without control characters.`;
  }
  return value.length && !visible ? "Show at least one configured column, or use automatic columns." : null;
}
