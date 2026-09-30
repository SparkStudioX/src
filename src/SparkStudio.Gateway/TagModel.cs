using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Authored gateway tag model. UDT versions are immutable and instances explicitly pin a version.</summary>
public static class TagModel
{
    public const int MaximumTags = 10_000;

    public static JsonObject Empty() => new()
    {
        ["format"] = "sparkstudio.tags", ["version"] = 2, ["tags"] = new JsonArray(),
        ["provider"] = new JsonObject { ["name"] = "default", ["enabled"] = true },
        ["scanGroups"] = new JsonArray(), ["udtDefinitions"] = new JsonArray(), ["instances"] = new JsonArray()
    };

    public static string Name(JsonObject value, string key)
    {
        var name = TagDefinitionValidator.Text(value, key);
        if (!Regex.IsMatch(name, "^[A-Za-z][A-Za-z0-9_-]{0,63}$", RegexOptions.CultureInvariant))
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
        Fields(value, "path", "kind", "dataType", "value", "enabled", "publishingIntervalMs", "scanGroup", "connectionId", "nodeId", "absoluteDeadband", "queueSize", "expression", "inputs");
        var sourceFields = TagDefinitionValidator.Kind(value) switch { "memory" => new[] { "value" }, "expression" => new[] { "expression", "inputs" }, _ => new[] { "connectionId", "nodeId", "absoluteDeadband", "queueSize" } };
        if (value.Any(field => field.Key is not ("path" or "kind" or "dataType" or "enabled" or "publishingIntervalMs" or "scanGroup") && !sourceFields.Contains(field.Key, StringComparer.Ordinal)))
            throw new ArgumentException("Tag fields must match the selected value source.");
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
        return result;
    }

    public static JsonArray Expand(JsonObject model, Func<JsonObject, JsonObject> normalize)
    {
        // Validate cardinality before cloning and normalizing thousands of entries.
        var directTags = Array(model, "tags", MaximumTags);
        var instances = Array(model, "instances", 128);
        if (model["provider"] is not JsonObject provider) throw new ArgumentException("A default provider configuration is required.");
        Fields(provider, "name", "enabled");
        if (TagDefinitionValidator.Text(provider, "name") != "default") throw new ArgumentException("Only the default provider is supported.");
        var providerEnabled = TagDefinitionValidator.Enabled(provider);
        var groups = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var group in Array(model, "scanGroups", 32).OfType<JsonObject>())
        {
            Fields(group, "name", "publishingIntervalMs", "enabled");
            var name = Name(group, "name"); TagDefinitionValidator.PublishingInterval(group); TagDefinitionValidator.Enabled(group);
            if (!groups.TryAdd(name, group)) throw new ArgumentException($"Duplicate scan group: {name}.");
        }
        var types = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var definition in Array(model, "udtDefinitions", 128).OfType<JsonObject>())
        {
            Fields(definition, "id", "version", "members");
            var key = DefinitionKey(definition);
            if (!types.TryAdd(key, definition)) throw new ArgumentException($"Duplicate UDT definition: {key}.");
            var memberPaths = new HashSet<string>(StringComparer.Ordinal);
            var members = Array(definition, "members", 128);
            if (members.Count == 0) throw new ArgumentException("UDT definitions require at least one member.");
            var validationMembers = new List<JsonObject>();
            foreach (var member in members.OfType<JsonObject>())
            {
                ValidateTagFields(member);
                var memberPath = MemberPath(TagDefinitionValidator.Text(member, "path"));
                if (!memberPaths.Add(memberPath)) throw new ArgumentException($"Duplicate UDT member: {memberPath}.");
                if (member["scanGroup"] is not null && !groups.ContainsKey(Name(member, "scanGroup")))
                    throw new ArgumentException($"Missing scan group in {key}/{memberPath}: {Name(member, "scanGroup")}.");
                validationMembers.Add(normalize(ConcreteMember(member, "[default]UdtValidation")));
            }
            // A definition must have a valid internal graph even when no instance uses it yet.
            var external = new HashSet<string>(StringComparer.Ordinal);
            foreach (var member in members.OfType<JsonObject>().Where(member => TagDefinitionValidator.Kind(member) == "expression"))
                foreach (var input in member["inputs"]!.AsObject())
                {
                    var path = input.Value!.GetValue<string>();
                    if (path.StartsWith("./", StringComparison.Ordinal))
                    {
                        if (!memberPaths.Contains(path[2..])) throw new ArgumentException($"Missing relative UDT member input in {key}: {path}.");
                    }
                    else external.Add(path);
                }
            foreach (var path in external.Where(path => !validationMembers.Any(member => TagDefinitionValidator.Text(member, "path") == path)))
                validationMembers.Add(new JsonObject { ["path"] = path, ["kind"] = "memory", ["dataType"] = "Double", ["value"] = 0 });
            TagExpressions.Order(validationMembers.ToArray());
        }
        var expandedCount = directTags.Count;
        foreach (var instance in instances.OfType<JsonObject>())
        {
            var id = Name(instance, "definitionId"); var version = Version(instance);
            if (!types.TryGetValue(id + "@" + version, out var type)) throw new ArgumentException($"Missing UDT definition: {id}@{version}.");
            expandedCount += type["members"]!.AsArray().Count;
            if (expandedCount > MaximumTags) throw new ArgumentException($"A gateway supports at most {MaximumTags} configured tags, including UDT members.");
        }
        var output = new JsonArray(); var paths = new HashSet<string>(StringComparer.Ordinal);
        void Add(JsonObject input, JsonObject? instance = null, string? member = null, string[]? overrides = null)
        {
            ValidateTagFields(input);
            var tag = normalize(input); var path = TagDefinitionValidator.Text(tag, "path");
            if (!paths.Add(path)) throw new ArgumentException($"Tag or UDT member path conflict: {path}.");
            var enabled = TagDefinitionValidator.Enabled(tag) && providerEnabled && (instance is null || TagDefinitionValidator.Enabled(instance));
            if (tag["scanGroup"] is not null)
            {
                var name = Name(tag, "scanGroup");
                if (!groups.TryGetValue(name, out var group)) throw new ArgumentException($"Missing scan group: {name} (used by {path}).");
                tag["publishingIntervalMs"] = TagDefinitionValidator.PublishingInterval(group);
                enabled &= TagDefinitionValidator.Enabled(group);
            }
            tag["effectiveEnabled"] = enabled;
            if (instance is not null)
            {
                tag["udtInstance"] = instance["path"]!.DeepClone(); tag["udtDefinition"] = instance["definitionId"]!.DeepClone();
                tag["udtVersion"] = instance["version"]!.DeepClone(); tag["udtMember"] = member;
                tag["overrideFields"] = new JsonArray((overrides ?? []).Select(field => (JsonNode?)JsonValue.Create(field)).ToArray());
            }
            output.Add(tag);
        }
        foreach (var tag in directTags.OfType<JsonObject>()) Add(tag);
        var roots = new HashSet<string>(StringComparer.Ordinal);
        foreach (var instance in instances.OfType<JsonObject>())
        {
            Fields(instance, "path", "definitionId", "version", "enabled", "overrides");
            var root = TagDefinitionValidator.Path(TagDefinitionValidator.Text(instance, "path"));
            if (!roots.Add(root) || roots.Any(other => other != root && (root.StartsWith(other + "/", StringComparison.Ordinal) || other.StartsWith(root + "/", StringComparison.Ordinal))))
                throw new ArgumentException($"Overlapping UDT instance path: {root}.");
            var id = Name(instance, "definitionId"); var version = Version(instance); TagDefinitionValidator.Enabled(instance);
            if (!types.TryGetValue(id + "@" + version, out var type)) throw new ArgumentException($"Missing UDT definition: {id}@{version} (used by {root}).");
            if (instance["overrides"] is not JsonObject overrides) throw new ArgumentException("Instance overrides must be an object keyed by member path.");
            var members = type["members"]!.AsArray().OfType<JsonObject>().ToArray();
            foreach (var pair in overrides)
                if (!members.Any(member => TagDefinitionValidator.Text(member, "path") == pair.Key)) throw new ArgumentException($"Override references removed or missing member: {root}/{pair.Key}.");
            foreach (var member in members)
            {
                var memberPath = TagDefinitionValidator.Text(member, "path"); var authored = (JsonObject)member.DeepClone();
                var fields = System.Array.Empty<string>();
                if (overrides.TryGetPropertyValue(memberPath, out var patch))
                {
                    if (patch is not JsonObject memberOverrides) throw new ArgumentException("Member overrides must be objects.");
                    Fields(memberOverrides, "value", "enabled", "publishingIntervalMs", "scanGroup", "connectionId", "nodeId", "absoluteDeadband", "queueSize", "expression", "inputs");
                    fields = memberOverrides.Select(pair => pair.Key).ToArray();
                    foreach (var pair in memberOverrides) authored[pair.Key] = pair.Value?.DeepClone();
                }
                Add(ConcreteMember(authored, root), instance, memberPath, fields);
            }
        }
        foreach (var root in roots)
            if (output.OfType<JsonObject>().Any(tag => tag["udtInstance"] is null && (TagDefinitionValidator.Text(tag, "path") == root || TagDefinitionValidator.Text(tag, "path").StartsWith(root + "/", StringComparison.Ordinal))))
                throw new ArgumentException($"Direct tags cannot occupy UDT instance namespace: {root}.");
        TagExpressions.Order(output.OfType<JsonObject>().ToArray());
        return output;
    }
}
