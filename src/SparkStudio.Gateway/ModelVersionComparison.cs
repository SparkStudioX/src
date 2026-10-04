using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public sealed record ModelVersionChange(string Path, string Kind, string Reason);
public sealed record ModelVersionUsage(string Path, int Version);
public sealed record ModelAffectedProject(string Id, string Name);
public sealed record ModelVersionImpact(string DefinitionId, int? FromVersion, int ToVersion, string Classification,
    ModelVersionChange[] Changes, ModelVersionUsage[] Usage, ModelAffectedProject[] AffectedProjects, bool RequiresReview = true);

public static class ModelVersionComparison
{
    public static ModelVersionImpact Compare(JsonObject model, JsonObject definition, int? fromVersion = null, JsonObject[]? proposedDefinitions = null)
    {
        var id = TagModel.Name(definition, "id"); var version = TagModel.Version(definition);
        ValidateDefinition(definition);
        if (proposedDefinitions is { Length: > TagModel.MaximumDefinitions }) throw new ArgumentException("A comparison accepts at most 256 proposed model definitions.");
        var proposed = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var candidate in proposedDefinitions ?? [])
        {
            if (candidate is null) throw new ArgumentException("Proposed model definitions must be objects.");
            ValidateDefinition(candidate);
            if (!proposed.TryAdd(TagModel.DefinitionKey(candidate), candidate)) throw new ArgumentException($"Duplicate proposed model version: {TagModel.DefinitionKey(candidate)}.");
        }
        proposed[TagModel.DefinitionKey(definition)] = definition;
        var definitions = ModelMappingProfiles.Objects(model, "udtDefinitions").ToArray();
        var nextTypes = definitions.Where(item => !proposed.ContainsKey(TagModel.DefinitionKey(item))).Concat(proposed.Values).ToArray();
        var next = ModelMappingProfiles.Leaves(definition, nextTypes);
        var previous = definitions.Where(item => ModelMappingProfiles.Text(item, "id") == id)
            .Where(item => fromVersion is null ? TagModel.Version(item) < version : TagModel.Version(item) == fromVersion)
            .OrderByDescending(TagModel.Version).FirstOrDefault();
        if (fromVersion is not null && previous is null) throw new ArgumentException("The source model version does not exist.");
        var usage = ModelMappingProfiles.Objects(model, "instances").Where(item => UsesType(item, id, definitions))
            .Select(item => new ModelVersionUsage(ModelMappingProfiles.Text(item, "path"), TagModel.Version(item))).ToArray();
        if (previous is null) return new(id, null, version, "initial", [], usage, []);
        var old = ModelMappingProfiles.Leaves(previous, definitions);
        var changes = new List<ModelVersionChange>();
        CompareComposition(previous, definition, changes);
        foreach (var pair in old)
        {
            if (!next.TryGetValue(pair.Key, out var member)) { changes.Add(new(pair.Key, "breaking", "Field removed; bindings to this path will stop resolving.")); continue; }
            CompareField(pair.Key, pair.Value, member, changes);
        }
        foreach (var path in next.Keys.Except(old.Keys)) changes.Add(new(path, "compatible", "Field added. Existing paths remain available."));
        CompareParameters(previous, definition, changes);
        if (changes.Count == 0 && !SameExceptVersion(previous, definition)) changes.Add(new(id, "compatible", "Model descriptions, ordering or metadata changed."));
        var classification = changes.Any(change => change.Kind == "breaking") ? "breaking" : changes.Count > 0 ? "compatible" : "unchanged";
        return new(id, TagModel.Version(previous), version, classification, changes.ToArray(), usage, []);
    }
    private static void ValidateDefinition(JsonObject definition)
    {
        TagModel.Fields(definition, "id", "version", "members", "description", "semanticType", "semanticId", "attributes", "parameters");
        _ = TagModel.DefinitionKey(definition); _ = TagModelParameters.Declarations(definition); TagModelMetadata.Validate(definition, false);
        var members = TagModel.Array(definition, "members", 128);
        if (members.Count == 0) throw new ArgumentException("A model definition needs at least one member.");
        var paths = new HashSet<string>(StringComparer.Ordinal);
        foreach (var member in members.OfType<JsonObject>())
        {
            var path = TagModel.MemberPath(TagDefinitionValidator.Text(member, "path"));
            if (!paths.Add(path)) throw new ArgumentException($"Duplicate UDT member path: {path}.");
            if (ModelMappingProfiles.Text(member, "kind") != "type") { TagModel.ValidateTagFields(member); _ = TagDefinitionValidator.DataType(member); continue; }
            TagModel.Fields(member, "path", "kind", "definitionId", "version", "parameters", "enabled");
            _ = TagModel.Name(member, "definitionId"); _ = TagModel.Version(member);
            if (member.ContainsKey("parameters") && member["parameters"] is not JsonObject) throw new ArgumentException("Nested model parameters must be an object.");
            if (member.ContainsKey("enabled") && (member["enabled"] is not JsonValue flag || !flag.TryGetValue<bool>(out _))) throw new ArgumentException("Nested model enabled must be a Boolean.");
        }
    }
    private static bool SameExceptVersion(JsonObject first, JsonObject second)
    {
        var a = (JsonObject)first.DeepClone(); var b = (JsonObject)second.DeepClone(); a.Remove("version"); b.Remove("version");
        return JsonNode.DeepEquals(a, b);
    }
    private static void CompareComposition(JsonObject previous, JsonObject definition, List<ModelVersionChange> changes)
    {
        var old = ModelMappingProfiles.Objects(previous, "members").Where(item => ModelMappingProfiles.Text(item, "kind") == "type").ToDictionary(item => ModelMappingProfiles.Text(item, "path"));
        foreach (var member in ModelMappingProfiles.Objects(definition, "members").Where(item => ModelMappingProfiles.Text(item, "kind") == "type"))
            if (old.TryGetValue(ModelMappingProfiles.Text(member, "path"), out var prior) && !JsonNode.DeepEquals(prior, member))
                changes.Add(new(ModelMappingProfiles.Text(member, "path"), "breaking", "Nested model version, parameters or enabled state changed. Review this composition upgrade."));
    }
    private static void CompareField(string path, JsonObject old, JsonObject next, List<ModelVersionChange> changes)
    {
        foreach (var field in new[] { "dataType", "kind", "unit", "unitSystem", "target", "connectionId", "nodeId", "expression", "inputs", "value", "alarms", "freshnessMs", "enabled", "scanGroup", "publishingIntervalMs" })
            if (!JsonNode.DeepEquals(old[field], next[field])) changes.Add(new(path, "breaking", $"{field} changed; review equipment behavior and consumers."));
        CompareRange(path, old["range"] as JsonObject, next["range"] as JsonObject, changes);
        CompareEnum(path, old["enumValues"] as JsonArray, next["enumValues"] as JsonArray, changes);
        foreach (var field in new[] { "description", "semanticType", "semanticId", "attributes" })
            if (!JsonNode.DeepEquals(old[field], next[field])) changes.Add(new(path, "compatible", $"{field} metadata changed."));
    }
    private static void CompareRange(string path, JsonObject? old, JsonObject? next, List<ModelVersionChange> changes)
    {
        if (JsonNode.DeepEquals(old, next)) return;
        var narrower = next is not null && (old is null || CompareBound(next, old, "low") > 0 || CompareBound(next, old, "high") < 0);
        changes.Add(new(path, narrower ? "breaking" : "compatible", narrower ? "Valid range narrowed; formerly valid readings can become uncertain." : "Valid range widened or removed."));
    }
    private static int CompareBound(JsonObject next, JsonObject old, string key) => ModelFieldContract.CompareNumeric(System.Text.Json.JsonSerializer.SerializeToElement(next[key]), System.Text.Json.JsonSerializer.SerializeToElement(old[key]));
    private static void CompareEnum(string path, JsonArray? old, JsonArray? next, List<ModelVersionChange> changes)
    {
        if (JsonNode.DeepEquals(old, next)) return;
        var removed = next is { Count: > 0 } && (old is null || old.Any(value => !next.Any(candidate => JsonNode.DeepEquals(value, candidate))));
        changes.Add(new(path, removed ? "breaking" : "compatible", removed ? "Allowed values narrowed." : "Allowed values widened; consumers with exhaustive state lists still need review."));
    }
    private static void CompareParameters(JsonObject old, JsonObject next, List<ModelVersionChange> changes)
    {
        var oldParameters = TagModelParameters.Declarations(old); var nextParameters = TagModelParameters.Declarations(next);
        foreach (var pair in oldParameters)
        {
            if (!nextParameters.TryGetValue(pair.Key, out var parameter)) changes.Add(new(pair.Key, "breaking", "Parameter removed; existing equipment arguments require review."));
            else if (!JsonNode.DeepEquals(pair.Value, parameter)) changes.Add(new(pair.Key, "breaking", "Parameter type, requirement or default changed."));
        }
        foreach (var pair in nextParameters.Where(pair => !oldParameters.ContainsKey(pair.Key)))
        {
            var required = pair.Value["required"]?.GetValue<bool>() == true && !pair.Value.ContainsKey("default");
            changes.Add(new(pair.Key, required ? "breaking" : "compatible", required ? "New parameter needs a value on each equipment entry." : "Optional parameter added."));
        }
    }
    public static bool UsesType(JsonObject item, string id, JsonObject[] definitions, int depth = 0)
    {
        if (ModelMappingProfiles.Text(item, "definitionId") == id) return true;
        if (depth >= TagModel.MaximumNestingDepth) return false;
        var definition = definitions.FirstOrDefault(value => ModelMappingProfiles.Text(value, "id") == ModelMappingProfiles.Text(item, "definitionId") && TagModel.Version(value) == TagModel.Version(item));
        return definition is not null && ModelMappingProfiles.Objects(definition, "members").Where(member => ModelMappingProfiles.Text(member, "kind") == "type").Any(member => UsesType(member, id, definitions, depth + 1));
    }
}
