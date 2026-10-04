using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Authored UNS types remain immutable; every instance and composition explicitly pins a version.</summary>
public static class TagModel
{
    public const int FormatVersion = 3;
    public const int MaximumTags = 10_000;
    public const int MaximumDefinitions = 256;
    public const int MaximumInstances = 2000;
    public const int MaximumHierarchyNodes = 2048;
    public const int MaximumNestingDepth = 4;
    public static JsonObject Empty() => new()
    {
        ["format"] = "sparkstudio.tags", ["version"] = FormatVersion, ["tags"] = new JsonArray(),
        ["provider"] = new JsonObject { ["name"] = "default", ["enabled"] = true },
        ["scanGroups"] = new JsonArray(), ["udtDefinitions"] = new JsonArray(), ["instances"] = new JsonArray(), ["hierarchy"] = new JsonArray()
    };
    public static JsonObject RequireCurrentFormat(JsonNode? value)
    {
        if (value is not JsonObject model || model["format"] is not JsonValue format || !format.TryGetValue<string>(out var name) || name != "sparkstudio.tags"
            || model["version"] is not JsonValue version || !version.TryGetValue<int>(out var number) || number != FormatVersion)
            throw new ArgumentException("Only the current SparkStudio tag model format is supported.");
        return model;
    }
    public static string Name(JsonObject value, string key)
    {
        var name = TagDefinitionValidator.Text(value, key);
        if (!TagModelParameterContract.Name.IsMatch(name))
            throw new ArgumentException($"{key} must start with a letter and contain at most 64 letters, digits, underscores or hyphens.");
        return name;
    }
    public static int Version(JsonObject value)
    {
        if (value["version"] is not JsonValue scalar || !scalar.TryGetValue<int>(out var version) || version is < 1 or > 1000000)
            throw new ArgumentException("UDT version must be an integer from 1 through 1000000.");
        return version;
    }
    public static string DefinitionKey(JsonObject value) => Name(value, "id") + "@" + Version(value);
    public static void Fields(JsonObject value, params string[] allowed)
    {
        var invalid = value.FirstOrDefault(pair => !allowed.Contains(pair.Key, StringComparer.Ordinal));
        if (invalid.Key is not null) throw new ArgumentException($"Unsupported tag model field: {invalid.Key}.");
    }
    public static JsonArray Array(JsonObject model, string key, int maximum)
    {
        if (model[key] is not JsonArray array || array.Count > maximum || array.Any(item => item is not JsonObject))
            throw new ArgumentException($"{key} must contain at most {maximum} objects.");
        return array;
    }
    public static string MemberPath(string path)
    {
        TagDefinitionValidator.Path("[default]UdtMember/" + path);
        if (path.Length > 256) throw new ArgumentException("UDT member paths are limited to 256 characters.");
        return path;
    }
    public static void ValidateTagFields(JsonObject value)
    {
        string[] common = ["path", "kind", "dataType", "enabled", "publishingIntervalMs", "scanGroup"];
        var kind = TagDefinitionValidator.Kind(value);
        var sourceFields = kind switch {
            "memory" => new[] { "value" }, "expression" => ["expression", "inputs"], "reference" => ["target"],
            "device" => ["connectionId", "nodeId", "absoluteDeadband", "queueSize", "writable"],
            "opcua" => ["connectionId", "nodeId", "absoluteDeadband", "queueSize"],
            _ => throw new ArgumentException("kind must be opcua, device, memory, expression or reference.") };
        var invalid = value.FirstOrDefault(field => !common.Contains(field.Key, StringComparer.Ordinal) && !TagModelMetadata.Fields.Contains(field.Key, StringComparer.Ordinal)
            && !sourceFields.Contains(field.Key, StringComparer.Ordinal));
        if (invalid.Key is not null)
            throw new ArgumentException($"Field {invalid.Key[..Math.Min(128, invalid.Key.Length)]} is incompatible with the {kind} source for {TagDefinitionValidator.Text(value, "path")}. Remove that source field or select a matching source mapping.");
        TagModelMetadata.Validate(value);
    }
    public static JsonObject ConcreteMember(JsonObject member, string root)
    {
        var result = (JsonObject)member.DeepClone();
        result["path"] = root + "/" + MemberPath(TagDefinitionValidator.Text(member, "path"));
        if (result["inputs"] is JsonObject inputs)
            foreach (var pair in inputs.ToArray())
            {
                var text = pair.Value is JsonValue scalar && scalar.TryGetValue<string>(out var input) ? input : throw new ArgumentException("Expression inputs must be tag paths.");
                if (text.StartsWith("./", StringComparison.Ordinal)) inputs[pair.Key] = root + "/" + MemberPath(text[2..]);
            }
        if (result["target"] is JsonValue target && target.TryGetValue<string>(out var path) && path.StartsWith("./", StringComparison.Ordinal))
            result["target"] = root + "/" + MemberPath(path[2..]);
        return result;
    }
    public static JsonArray Expand(JsonObject model, Func<JsonObject, JsonObject> normalize, IEnumerable<JsonObject>? externalDefinitions = null)
        => new TagModelExpansion(model, normalize, externalDefinitions).Expand();
}
