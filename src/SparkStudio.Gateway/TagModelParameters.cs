using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

public static partial class TagModelParameters
{
    public sealed record Binding(JsonObject Values, HashSet<string> Defaults, bool HasDeclarations);
    public static Dictionary<string, JsonObject> Declarations(JsonObject definition)
    {
        if (!definition.ContainsKey("parameters")) return new(StringComparer.Ordinal);
        var result = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var item in TagModel.Array(definition, "parameters", 32).OfType<JsonObject>())
        {
            TagModel.Fields(item, "name", "type", "default", "required");
            var name = TagModel.Name(item, "name"); var type = TagDefinitionValidator.Text(item, "type");
            if (type is not ("String" or "Double" or "Int64" or "Boolean")) throw new ArgumentException("Model parameters require String, Double, Int64 or Boolean type.");
            if (item.ContainsKey("required") && (item["required"] is not JsonValue required || !required.TryGetValue<bool>(out _))) throw new ArgumentException("Parameter required must be a Boolean.");
            if (item.ContainsKey("default")) _ = Typed(type, item["default"]);
            if (!result.TryAdd(name, item)) throw new ArgumentException($"Duplicate model parameter: {name}.");
        }
        return result;
    }
    public static Binding Bind(JsonObject definition, JsonObject? supplied)
    {
        var declarations = Declarations(definition); supplied ??= new();
        foreach (var pair in supplied) if (!declarations.ContainsKey(pair.Key)) throw new ArgumentException($"Unknown model parameter: {pair.Key}.");
        var values = new JsonObject(); var defaults = new HashSet<string>(StringComparer.Ordinal);
        foreach (var pair in declarations)
        {
            var hasValue = supplied.TryGetPropertyValue(pair.Key, out var value);
            if (!hasValue && pair.Value.TryGetPropertyValue("default", out value)) { hasValue = true; defaults.Add(pair.Key); }
            if (!hasValue)
            {
                if (pair.Value["required"]?.GetValue<bool>() == true) throw new ArgumentException($"Required model parameter is missing: {pair.Key}.");
                continue;
            }
            values[pair.Key] = Typed(TagDefinitionValidator.Text(pair.Value, "type"), value);
        }
        return new(values, defaults, declarations.Count > 0);
    }
    private static JsonNode Typed(string type, JsonNode? value)
    {
        var result = TagDefinitionValidator.MemoryValue(type, value);
        if (type == "String" && result.GetValue<string>().Length > 4096) throw new ArgumentException("Model parameter text is limited to 4096 characters.");
        return result;
    }
    public static void ValidateValue(JsonObject declaration, JsonNode? value) => _ = Typed(TagDefinitionValidator.Text(declaration, "type"), value);
    public static string[] Placeholders(string text, IEnumerable<string> declarations)
    {
        var matches = Placeholder().Matches(text);
        if (matches.Count > TagModelParameterContract.MaximumPlaceholders || Placeholder().Replace(text, "").IndexOfAny(['{', '}']) >= 0) throw new ArgumentException($"Model fields require complete placeholders, at most {TagModelParameterContract.MaximumPlaceholders} per field.");
        var allowed = declarations.ToHashSet(StringComparer.Ordinal);
        var names = matches.Select(match => match.Groups[1].Value).ToArray();
        if (names.Any(name => !allowed.Contains(name))) throw new ArgumentException("A model field uses an undeclared parameter.");
        return names;
    }
    public static JsonNode? Substitute(JsonNode? value, Binding binding, bool wholeValue, out string provenance)
    {
        provenance = "definition";
        if (!binding.HasDeclarations) return value?.DeepClone();
        if (value is not JsonValue scalar || !scalar.TryGetValue<string>(out var text)) return value?.DeepClone();
        var names = Placeholders(text, binding.Values.Select(pair => pair.Key));
        if (names.Length == 0) return value.DeepClone();
        provenance = names.All(binding.Defaults.Contains) ? "parameter-default" : "parameter";
        foreach (var name in names)
            if (binding.Values[name] is JsonValue parameter && parameter.TryGetValue<string>(out var replacement) && (replacement.IndexOfAny(['{', '}']) >= 0 || replacement.Any(char.IsControl)))
                throw new ArgumentException("Parameter values cannot introduce placeholders or control characters into model fields.");
        if (wholeValue)
        {
            if (names.Length != 1 || text != "{" + names[0] + "}") throw new ArgumentException("A memory value or typed nested parameter requires a whole-field placeholder.");
            return binding.Values[names[0]]!.DeepClone();
        }
        return JsonValue.Create(Placeholder().Replace(text, match => Text(binding.Values[match.Groups[1].Value]!)));
    }
    private static string Text(JsonNode value)
    {
        if (value is JsonValue scalar && scalar.TryGetValue<string>(out var text)) return text;
        return value.ToJsonString();
    }
    public static JsonNode Memory(string type, JsonNode? value)
    {
        if (type != "String" && value is JsonValue scalar && scalar.TryGetValue<string>(out var text))
        {
            try { value = JsonNode.Parse(text); }
            catch (JsonException) { throw new ArgumentException($"A substituted memory value must match {type}."); }
        }
        return TagDefinitionValidator.MemoryValue(type, value);
    }
    private static Regex Placeholder() => TagModelParameterContract.Placeholder;
}
