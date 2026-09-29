import type { QueryParameter, RuntimeParameters } from "./types";

/** Test inputs are values, never SQL text; retain exact integer/decimal strings for gateway conversion. */
export function prepareQueryTestParameters(definitions: QueryParameter[], values: RuntimeParameters): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const parameter of definitions) {
    const value = Object.hasOwn(values, parameter.name) ? values[parameter.name] : parameter.defaultValue;
    if (value === null) { result[parameter.name] = null; continue; }
    if (value === undefined) throw new Error(`Enter a test value for ${parameter.name}.`);
    const type = parameter.type.toLowerCase(), text = String(value).trim();
    const invalid = () => new Error(`Invalid test value for ${parameter.name} (${parameter.type}).`);
    if (["int", "int32", "integer", "long", "int64", "bigint"].includes(type)) {
      if (!/^[+-]?\d+$/.test(text)) throw invalid();
      const integer = BigInt(text), wide = ["long", "int64", "bigint"].includes(type);
      if (integer < (wide ? -9223372036854775808n : -2147483648n) || integer > (wide ? 9223372036854775807n : 2147483647n)) throw invalid();
      result[parameter.name] = text;
    } else if (["number", "double", "float"].includes(type)) {
      if (!text || !Number.isFinite(Number(text))) throw invalid();
      result[parameter.name] = Number(text);
    } else if (type === "decimal") {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw invalid();
      result[parameter.name] = text;
    } else if (["bool", "boolean", "bit"].includes(type)) {
      if (!["true", "false", "1", "0"].includes(text.toLowerCase())) throw invalid();
      result[parameter.name] = text.toLowerCase() === "true" || text === "1";
    } else result[parameter.name] = value;
  }
  return result;
}
