import type { ModelParameterRequirement, Template } from "./types";
import parameterContract from "./modelParameterContract.json";

// This contract is also embedded by the gateway's TagModelParameterContract.
export const modelParameterNamePattern = new RegExp(`^${parameterContract.nameFragment}$`);
const placeholderSource = `\\{(${parameterContract.nameFragment})\\}`;
export const wholeModelPlaceholderPattern = new RegExp(`^${placeholderSource}$`);
export function modelPlaceholderPattern(): RegExp { return new RegExp(placeholderSource, "g"); }
export function modelPlaceholderNames(text: string, declarations: Iterable<string>): string[] {
  const pattern = modelPlaceholderPattern(), matches = [...text.matchAll(pattern)];
  if (matches.length > parameterContract.maximumPlaceholders || /[{}]/.test(text.replace(pattern, ""))) throw new Error(`Model fields require complete placeholders, at most ${parameterContract.maximumPlaceholders} per field.`);
  const allowed = new Set(declarations), names = matches.map(match => match[1]);
  if (names.some(name => !allowed.has(name))) throw new Error("A model field uses an undeclared or unsupplied parameter.");
  return names;
}
export function exactModelInt64Text(value: unknown): value is string {
  if (typeof value !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(value) || value === "-0" || value.length > 20) return false;
  const integer = BigInt(value);
  return integer >= -9223372036854775808n && integer <= 9223372036854775807n;
}
export function modelParameterValueError(type: string, value: unknown): string | undefined {
  if (type === "String") return typeof value === "string" && value.length <= 4096 ? undefined : "String parameters require text of at most 4096 characters.";
  if (type === "Boolean") return typeof value === "boolean" ? undefined : "Boolean parameters require true or false.";
  if (type === "Double") return typeof value === "number" && Number.isFinite(value) ? undefined : "Double parameters require a finite number.";
  if (type !== "Int64") return "Unsupported model parameter type.";
  if (typeof value === "number" && Number.isSafeInteger(value)) return undefined;
  if (exactModelInt64Text(value) && (BigInt(value) < -9007199254740991n || BigInt(value) > 9007199254740991n)) return undefined;
  return "Int64 parameters require an exact signed 64-bit integer; large values use canonical decimal text.";
}

export function modelPathError(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("[default]") || value.length > 512 || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159 || "{}\\".includes(character)))
    return "Choose a concrete [default] model instance path of at most 512 characters.";
  const path = value.slice(9);
  if (path.includes("[") || path.includes("]") || path.split("/").some(part => !part.trim() || part === "." || part === "..")) return "Model instance paths cannot contain empty, dot or parent segments.";
  return undefined;
}
export function modelRequirementError(value: ModelParameterRequirement | undefined): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["definitionId", "minVersion", "maxVersion"].includes(key))
    || !modelParameterNamePattern.test(value.definitionId || "")) return "A Model instance parameter requires a valid type ID.";
  if ([value.minVersion, value.maxVersion].some(version => version !== undefined && (!Number.isSafeInteger(version) || version < 1 || version > 1000000))) return "Model version bounds must be whole numbers from 1 to 1000000.";
  if (value.minVersion !== undefined && value.maxVersion !== undefined && value.minVersion > value.maxVersion) return "The minimum model version cannot exceed the maximum.";
  return undefined;
}
export function validateModelParameters(template: Template): void {
  const requirements = template.modelParameters;
  if (requirements !== undefined && (!requirements || typeof requirements !== "object" || Array.isArray(requirements) || Object.keys(requirements).length > 64)) throw new Error("Model parameter requirements must be a map of at most 64 declared parameters.");
  for (const [name, type] of Object.entries(template.parameterTypes ?? {})) if (type === "model") {
    const error = modelRequirementError(requirements?.[name]); if (error) throw new Error(`Template parameter '${name}': ${error}`);
  }
  for (const name of Object.keys(requirements ?? {})) if (!Object.hasOwn(template.parameters, name) || template.parameterTypes?.[name] !== "model") throw new Error(`Model requirement '${name}' must belong to a declared Model instance parameter.`);
}
