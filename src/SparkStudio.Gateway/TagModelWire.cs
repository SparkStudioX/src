using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Only typed Int64 fields use decimal strings beyond the browser's exact integer range.</summary>
public static class TagModelWire
{
    private const long MaximumSafeInteger = 9007199254740991L;
    public static long ParseInt64(string text)
    {
        if (!long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var number)
            || text != number.ToString(CultureInfo.InvariantCulture) || number is >= -MaximumSafeInteger and <= MaximumSafeInteger)
            throw new ArgumentException("Int64 text must be a canonical decimal integer outside the browser's safe integer range and within signed 64-bit bounds.");
        return number;
    }
    public static JsonNode? Value(string? dataType, JsonNode? value)
    {
        if (dataType != "Int64" || value is null) return value?.DeepClone();
        var scalar = JsonSerializer.SerializeToElement(value);
        if (scalar.ValueKind == JsonValueKind.Number)
        {
            var number = TagDefinitionValidator.MemoryValue("Int64", value).GetValue<long>();
            if (number is < -MaximumSafeInteger or > MaximumSafeInteger) return JsonValue.Create(number.ToString(CultureInfo.InvariantCulture));
        }
        return value.DeepClone();
    }
    public static JsonObject Parameters(JsonObject definition, JsonObject values) => MapParameters(definition, values, Value);
    public static JsonArray Definitions(JsonArray definitions)
    {
        var result = (JsonArray)definitions.DeepClone();
        foreach (var tag in result.OfType<JsonObject>()) MapMemory(tag, Value);
        return result;
    }
    public static JsonObject Package(JsonObject model) => MapPackage(model, model, Value);
    public static JsonObject NormalizePackage(JsonObject package, JsonObject saved) => MapPackage(package, saved, NormalizeValue);
    private static JsonNode? NormalizeValue(string? dataType, JsonNode? value)
    {
        if (dataType != "Int64" || value is not JsonValue scalar) return value?.DeepClone();
        if (scalar.TryGetValue<string>(out var text) && text.Contains('{')) return value.DeepClone();
        return TagDefinitionValidator.MemoryValue("Int64", value);
    }
    private static JsonObject MapPackage(JsonObject package, JsonObject saved, Func<string?, JsonNode?, JsonNode?> convert)
    {
        var result = (JsonObject)package.DeepClone();
        var types = Objects(saved, "udtDefinitions").Concat(Objects(result, "udtDefinitions"))
            .GroupBy(TagModel.DefinitionKey, StringComparer.Ordinal).ToDictionary(group => group.Key, group => group.Last(), StringComparer.Ordinal);
        foreach (var tag in Objects(result, "tags")) MapMemory(tag, convert);
        foreach (var definition in Objects(result, "udtDefinitions")) MapDefinition(definition, types, convert);
        foreach (var profile in Objects(result, "mappingProfiles")) MapBindings(profile, types, convert);
        foreach (var instance in Objects(result, "instances"))
        {
            if (!types.TryGetValue(TypeKey(instance), out var definition)) continue;
            if (instance["parameters"] is JsonObject parameters) instance["parameters"] = MapParameters(definition, parameters, convert);
            if (instance["overrides"] is not JsonObject overrides) continue;
            foreach (var pair in overrides)
                if (pair.Value is JsonObject patch)
                {
                    var dataType = LeafType(definition, pair.Key, types, 0);
                    if (patch.ContainsKey("value")) patch["value"] = convert(dataType, patch["value"]);
                    MapEnum(patch, dataType, convert);
                }
        }
        return result;
    }
    private static void MapDefinition(JsonObject definition, Dictionary<string, JsonObject> types, Func<string?, JsonNode?, JsonNode?> convert)
    {
        foreach (var parameter in Objects(definition, "parameters"))
            if (parameter.ContainsKey("default")) parameter["default"] = convert(parameter["type"]?.GetValue<string>(), parameter["default"]);
        foreach (var member in Objects(definition, "members"))
        {
            MapMemory(member, convert);
            if (TagDefinitionValidator.Kind(member) == "type" && member["parameters"] is JsonObject parameters && types.TryGetValue(TypeKey(member), out var nested))
                member["parameters"] = MapParameters(nested, parameters, convert);
        }
    }
    private static JsonObject MapParameters(JsonObject definition, JsonObject values, Func<string?, JsonNode?, JsonNode?> convert)
    {
        var result = (JsonObject)values.DeepClone();
        foreach (var parameter in Objects(definition, "parameters"))
        {
            var key = TagDefinitionValidator.Text(parameter, "name");
            if (result.ContainsKey(key)) result[key] = convert(parameter["type"]?.GetValue<string>(), result[key]);
        }
        return result;
    }
    private static void MapMemory(JsonObject member, Func<string?, JsonNode?, JsonNode?> convert)
    {
        if (TagDefinitionValidator.Kind(member) == "memory" && member.ContainsKey("value"))
            member["value"] = convert(member["dataType"]?.GetValue<string>(), member["value"]);
        MapEnum(member, member["dataType"]?.GetValue<string>(), convert);
    }
    private static void MapEnum(JsonObject member, string? dataType, Func<string?, JsonNode?, JsonNode?> convert)
    {
        if (member["enumValues"] is not JsonArray values) return;
        member["enumValues"] = new JsonArray(values.Select(value => convert(dataType, value)).ToArray());
    }
    private static void MapBindings(JsonObject profile, Dictionary<string, JsonObject> types, Func<string?, JsonNode?, JsonNode?> convert)
    {
        if (!types.TryGetValue(TypeKey(profile), out var definition) || profile["bindings"] is not JsonObject bindings) return;
        foreach (var pair in bindings)
            if (pair.Value is JsonObject patch && patch.ContainsKey("value"))
                patch["value"] = convert(LeafType(definition, pair.Key, types, 0), patch["value"]);
    }
    private static string? LeafType(JsonObject definition, string path, Dictionary<string, JsonObject> types, int depth)
    {
        if (depth >= TagModel.MaximumNestingDepth) return null;
        foreach (var member in Objects(definition, "members"))
        {
            var memberPath = TagDefinitionValidator.Text(member, "path");
            if (path == memberPath) return member["dataType"]?.GetValue<string>();
            if (TagDefinitionValidator.Kind(member) == "type" && path.StartsWith(memberPath + "/", StringComparison.Ordinal) && types.TryGetValue(TypeKey(member), out var nested))
                return LeafType(nested, path[(memberPath.Length + 1)..], types, depth + 1);
        }
        return null;
    }
    private static IEnumerable<JsonObject> Objects(JsonObject value, string key) => (value[key] as JsonArray)?.OfType<JsonObject>() ?? [];
    private static string TypeKey(JsonObject value) => TagModel.Name(value, "definitionId") + "@" + TagModel.Version(value);
}
