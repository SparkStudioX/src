using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public static class TagModelMetadata
{
    public static readonly string[] Fields = ["unit", "unitSystem", "description", "range", "freshnessMs", "enumValues", "semanticType", "semanticId", "attributes", "alarms"];
    public static void Validate(JsonObject value, bool member = true)
    {
        Text(value, "description", 2048);
        Text(value, "semanticType", 128);
        if (member) Text(value, "unit", 128);
        if (value.ContainsKey("attributes")) ValidateAttributes(value["attributes"]);
        ValidateRange(value, member);
        ModelFieldContract.Validate(value, member);
    }
    private static void ValidateAttributes(JsonNode? node)
    {
        if (node is not JsonObject attributes || attributes.Count > 32) throw new ArgumentException("Model attributes must be a flat object of at most 32 scalar values.");
        foreach (var pair in attributes)
        {
                if (string.IsNullOrWhiteSpace(pair.Key) || pair.Key.Length > 128 || pair.Key.Any(char.IsControl)) throw new ArgumentException("Attribute names require 1–128 characters without controls.");
                var scalar = JsonSerializer.SerializeToElement(pair.Value);
                var valid = scalar.ValueKind is JsonValueKind.True or JsonValueKind.False
                    || scalar.ValueKind == JsonValueKind.String && scalar.GetString()!.Length <= 2048
                    || scalar.ValueKind == JsonValueKind.Number && scalar.TryGetDouble(out var number) && double.IsFinite(number);
                if (!valid) throw new ArgumentException("Model attributes accept bounded strings, finite numbers and Booleans only.");
        }
    }
    private static void ValidateRange(JsonObject value, bool member)
    {
        if (!value.ContainsKey("range")) return;
        if (!member || TagDefinitionValidator.DataType(value) is "String" or "Boolean") throw new ArgumentException("Model ranges apply to numeric members only.");
        if (value["range"] is not JsonObject range) throw new ArgumentException("A member range requires low and high.");
        TagModel.Fields(range, "low", "high");
        if (!Number(range["low"], out _) || !Number(range["high"], out _) || ModelFieldContract.CompareNumeric(JsonSerializer.SerializeToElement(range["low"]), JsonSerializer.SerializeToElement(range["high"])) > 0)
            throw new ArgumentException("Member range low and high must be finite numbers with low <= high.");
    }
    private static bool Number(JsonNode? node, out double value)
    {
        value = 0;
        var scalar = JsonSerializer.SerializeToElement(node);
        return scalar.ValueKind == JsonValueKind.Number && scalar.TryGetDouble(out value) && double.IsFinite(value);
    }
    private static void Text(JsonObject value, string key, int maximum)
    {
        if (!value.ContainsKey(key)) return;
        if (value[key] is not JsonValue scalar || !scalar.TryGetValue<string>(out var text) || text.Length > maximum || text.Any(character => char.IsControl(character) && character is not '\n' and not '\t'))
            throw new ArgumentException($"{key} must be text of at most {maximum} characters.");
    }
    public static void Copy(JsonObject from, JsonObject to)
    {
        Validate(from);
        foreach (var field in Fields) if (from.ContainsKey(field)) to[field] = from[field]!.DeepClone();
    }
    public static Dictionary<string, JsonObject> Hierarchy(JsonObject model)
    {
        string[] levels = ["Enterprise", "Site", "Area", "Line", "Cell", "WorkCenter", "Custom"];
        var nodes = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var node in TagModel.Array(model, "hierarchy", TagModel.MaximumHierarchyNodes).OfType<JsonObject>())
        {
            TagModel.Fields(node, "path", "level", "description", "attributes");
            var path = TagDefinitionValidator.Path(TagDefinitionValidator.Text(node, "path"));
            if (!levels.Contains(TagDefinitionValidator.Text(node, "level"), StringComparer.Ordinal)) throw new ArgumentException("Unknown hierarchy level.");
            Validate(node, false);
            if (!nodes.TryAdd(path, node)) throw new ArgumentException($"Duplicate hierarchy path: {path}.");
        }
        foreach (var pair in nodes)
            ValidateHierarchyOrder(pair.Key, TagDefinitionValidator.Text(pair.Value, "level"), nodes, levels);
        return nodes;
    }
    private static void ValidateHierarchyOrder(string path, string level, Dictionary<string, JsonObject> nodes, string[] levels)
    {
        if (level == "Custom") return;
        var ancestorPath = path;
        for (var slash = ancestorPath.LastIndexOf('/'); slash >= 0; slash = ancestorPath.LastIndexOf('/'))
        {
            ancestorPath = ancestorPath[..slash];
            if (!nodes.TryGetValue(ancestorPath, out var ancestor)) continue;
            var ancestorLevel = TagDefinitionValidator.Text(ancestor, "level");
            if (ancestorLevel == "Custom") continue;
            if (System.Array.IndexOf(levels, ancestorLevel) >= System.Array.IndexOf(levels, level))
                throw new ArgumentException($"Hierarchy node {path} ({level}) must be strictly below ancestor {ancestorPath} ({ancestorLevel}) in ISA-95 level order. Undeclared folders and Custom nodes do not reset the level order.");
            return;
        }
    }
}
