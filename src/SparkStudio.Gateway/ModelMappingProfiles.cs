using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Source recipes are separate from a model's field contract and precede equipment overrides.</summary>
public static class ModelMappingProfiles
{
    public static readonly string[] SourceFields = ["kind", "value", "target", "connectionId", "nodeId", "expression", "inputs", "absoluteDeadband", "queueSize", "writable"];
    public static IEnumerable<JsonObject> Objects(JsonObject value, string field) => (value[field] as JsonArray)?.OfType<JsonObject>() ?? [];
    public static string Text(JsonObject value, string field) => value[field]?.GetValue<string>() ?? "";
    public static Dictionary<string, JsonObject> Leaves(JsonObject definition, IEnumerable<JsonObject> definitions, string prefix = "", int depth = 0)
    {
        if (depth >= TagModel.MaximumNestingDepth) throw new ArgumentException("Model composition exceeds four levels.");
        var result = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var member in Objects(definition, "members"))
        {
            var path = prefix + Text(member, "path");
            if (Text(member, "kind") != "type") { result.Add(path, member); continue; }
            var nested = definitions.FirstOrDefault(item => Text(item, "id") == Text(member, "definitionId") && TagModel.Version(item) == TagModel.Version(member))
                ?? throw new ArgumentException($"Missing nested type for {path}.");
            foreach (var pair in Leaves(nested, definitions, path + "/", depth + 1)) result.Add(pair.Key, pair.Value);
        }
        return result;
    }
    public static void Validate(JsonObject model)
    {
        if (!model.ContainsKey("mappingProfiles")) return;
        var profiles = TagModel.Array(model, "mappingProfiles", 256);
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var definitions = Objects(model, "udtDefinitions").ToArray();
        foreach (var profile in profiles.OfType<JsonObject>())
        {
            TagModel.Fields(profile, "id", "definitionId", "version", "description", "bindings");
            var id = TagModel.Name(profile, "id");
            if (!ids.Add(id)) throw new ArgumentException($"Duplicate source mapping: {id}.");
            var definition = Definition(profile, definitions);
            if (profile["description"] is JsonNode description && (description is not JsonValue scalar || !scalar.TryGetValue<string>(out var text) || text.Length > 2048))
                throw new ArgumentException("Mapping description must contain at most 2,048 characters.");
            if (profile["bindings"] is not JsonObject bindings || bindings.Count is < 1 or > 128) throw new ArgumentException("A source mapping requires 1–128 field bindings.");
            var leaves = Leaves(definition, definitions);
            foreach (var pair in bindings)
            {
                if (!leaves.TryGetValue(pair.Key, out var member)) throw new ArgumentException($"Mapping {id} references missing field {pair.Key}.");
                if (pair.Value is not JsonObject binding) throw new ArgumentException("A mapping binding must be an object.");
                ValidateBinding(binding, member, definition);
            }
        }
        foreach (var instance in Objects(model, "instances")) _ = Profile(model, instance);
    }
    private static void ValidateBinding(JsonObject binding, JsonObject member, JsonObject definition)
    {
        var kind = TagDefinitionValidator.Kind(binding);
        var allowed = kind switch
        {
            "reference" => new[] { "kind", "target" }, "memory" => ["kind", "value"], "expression" => ["kind", "expression", "inputs"],
            "opcua" or "device" => ["kind", "connectionId", "nodeId", "absoluteDeadband", "queueSize"],
            _ => throw new ArgumentException("Choose reference, memory, expression, opcua or device for a source mapping.")
        };
        TagModel.Fields(binding, allowed);
        var parameters = TagModelParameters.Declarations(definition).Keys;
        foreach (var field in new[] { "target", "connectionId", "nodeId" })
            if (binding.ContainsKey(field)) _ = TagModelParameters.Placeholders(TagDefinitionValidator.Text(binding, field), parameters);
        if (kind == "reference") _ = TagDefinitionValidator.Path(ExamplePath(TagDefinitionValidator.Text(binding, "target"), parameters));
        else if (kind == "memory") ValidateMemory(binding, member, parameters);
        else if (kind == "expression")
        {
            _ = TagDefinitionValidator.Text(binding, "expression");
            if (binding["inputs"] is not JsonObject inputs) throw new ArgumentException("Expression mappings require named inputs.");
            var resolved = new JsonObject();
            foreach (var pair in inputs) resolved[pair.Key] = TagDefinitionValidator.Path(ExamplePath(pair.Value?.GetValue<string>() ?? "", parameters));
            var candidate = (JsonObject)binding.DeepClone(); candidate["inputs"] = resolved; candidate["path"] = "[default]MappingValidation/Field"; candidate["dataType"] = member["dataType"]?.DeepClone();
            _ = TagExpressions.Compile(candidate);
        }
        else
        {
            _ = TagDefinitionValidator.Text(binding, "connectionId"); _ = TagDefinitionValidator.Text(binding, "nodeId");
            _ = TagDefinitionValidator.AbsoluteDeadband(binding); _ = TagDefinitionValidator.MonitorQueueSize(binding);
            if (kind == "opcua" && !TagDefinitionValidator.Text(binding, "nodeId").Contains('{')) _ = TagDefinitionValidator.NodeIdentifier(binding);
        }
    }
    private static void ValidateMemory(JsonObject binding, JsonObject member, IEnumerable<string> parameters)
    {
        if (binding["value"] is JsonValue scalar && scalar.TryGetValue<string>(out var text) && text.Contains('{'))
        {
            var names = TagModelParameters.Placeholders(text, parameters);
            if (names.Length != 1 || text != "{" + names[0] + "}") throw new ArgumentException("Mapped memory parameters must occupy the complete value.");
        }
        else _ = TagDefinitionValidator.MemoryValue(TagDefinitionValidator.DataType(member), binding["value"]);
    }
    private static string Example(string text, IEnumerable<string> parameters)
    {
        foreach (var name in TagModelParameters.Placeholders(text, parameters)) text = text.Replace("{" + name + "}", "Example", StringComparison.Ordinal);
        return text;
    }
    private static string ExamplePath(string text, IEnumerable<string> parameters)
    {
        var rootParameter = text.StartsWith('{');
        var resolved = Example(text, parameters);
        if (text.StartsWith("./", StringComparison.Ordinal)) return "[default]MappingValidation/" + resolved[2..];
        return rootParameter ? "[default]" + resolved : resolved;
    }
    private static JsonObject Definition(JsonObject profile, IEnumerable<JsonObject> definitions) => definitions.FirstOrDefault(item => Text(item, "id") == TagModel.Name(profile, "definitionId") && TagModel.Version(item) == TagModel.Version(profile))
        ?? throw new ArgumentException($"Source mapping {Text(profile, "id")} requires an existing pinned model version.");
    private static JsonObject? Profile(JsonObject model, JsonObject instance)
    {
        if (!instance.ContainsKey("mappingProfileId")) return null;
        var id = TagModel.Name(instance, "mappingProfileId");
        var profile = Objects(model, "mappingProfiles").FirstOrDefault(item => Text(item, "id") == id)
            ?? throw new ArgumentException($"Equipment {Text(instance, "path")} references missing source mapping {id}.");
        if (Text(profile, "definitionId") != Text(instance, "definitionId") || TagModel.Version(profile) != TagModel.Version(instance))
            throw new ArgumentException($"Source mapping {id} must match the equipment's model and version.");
        return profile;
    }
    public static JsonObject Resolve(JsonObject model, JsonObject instance, string modelPath, JsonObject member)
    {
        var profile = Profile(model, instance);
        if (profile?["bindings"]?[modelPath] is not JsonObject source) return (JsonObject)member.DeepClone();
        var result = (JsonObject)member.DeepClone();
        foreach (var field in SourceFields) result.Remove(field);
        var definition = Definition(profile, Objects(model, "udtDefinitions"));
        var binding = TagModelParameters.Bind(definition, instance["parameters"] as JsonObject ?? new());
        foreach (var pair in source)
        {
            if (pair.Key == "inputs" && pair.Value is JsonObject inputs)
            {
                var resolved = new JsonObject();
                foreach (var input in inputs) resolved[input.Key] = TagModelParameters.Substitute(input.Value, binding, false, out _);
                result[pair.Key] = resolved;
            }
            else result[pair.Key] = pair.Key is "value" or "target" or "connectionId" or "nodeId"
                ? TagModelParameters.Substitute(pair.Value, binding, pair.Key == "value", out _) : pair.Value?.DeepClone();
        }
        return result;
    }
}
