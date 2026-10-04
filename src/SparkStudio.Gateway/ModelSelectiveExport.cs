using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public sealed record ModelExportSelection(string[]? DefinitionKeys = null, string[]? InstancePaths = null, bool IncludeSourceTags = true);
public sealed record ModelExternalDependency(string Kind, string Id, string Reason);
public sealed record ModelExportSummary(int Types, int Instances, int Tags, int Locations, int Mappings);
public sealed record ModelExportResult(JsonObject Package, ModelExternalDependency[] ExternalDependencies, ModelExportSummary Summary);

/// <summary>Export the transitive authored model closure; credentials and acquisition-owned resources stay external.</summary>
public sealed class ModelSelectiveExport
{
    private readonly JsonObject model;
    private readonly Dictionary<string, JsonObject> types;
    private readonly Dictionary<string, JsonObject> instances;
    private readonly Dictionary<string, JsonObject> authored;
    private readonly Dictionary<string, JsonObject> expanded;
    private readonly HashSet<string> selectedTypes = new(StringComparer.Ordinal), selectedInstances = new(StringComparer.Ordinal), selectedTags = new(StringComparer.Ordinal), examined = new(StringComparer.Ordinal);
    private readonly HashSet<ModelExternalDependency> external = [];
    private readonly Queue<string> pending = new();
    private readonly bool includeSources;
    private ModelSelectiveExport(JsonObject model, JsonArray definitions, bool includeSources)
    {
        this.model = model; this.includeSources = includeSources;
        types = ModelMappingProfiles.Objects(model, "udtDefinitions").ToDictionary(TagModel.DefinitionKey, StringComparer.Ordinal);
        instances = ModelMappingProfiles.Objects(model, "instances").ToDictionary(item => ModelMappingProfiles.Text(item, "path"), StringComparer.Ordinal);
        authored = ModelMappingProfiles.Objects(model, "tags").ToDictionary(item => ModelMappingProfiles.Text(item, "path"), StringComparer.Ordinal);
        expanded = definitions.OfType<JsonObject>().ToDictionary(item => ModelMappingProfiles.Text(item, "path"), StringComparer.Ordinal);
    }
    public static ModelExportResult Export(JsonObject model, JsonArray definitions, ModelExportSelection request)
    {
        if ((request.DefinitionKeys?.Length ?? 0) + (request.InstancePaths?.Length ?? 0) == 0) throw new ArgumentException("Select at least one model version or equipment entry to export.");
        if ((request.DefinitionKeys?.Length ?? 0) > 256 || (request.InstancePaths?.Length ?? 0) > 2000) throw new ArgumentException("The model export selection exceeds gateway limits.");
        var export = new ModelSelectiveExport(model, definitions, request.IncludeSourceTags);
        foreach (var key in request.DefinitionKeys ?? []) export.AddType(key);
        foreach (var path in request.InstancePaths ?? []) export.AddInstance(path);
        export.IncludeDependencies(); return export.Result();
    }
    private void AddType(string key)
    {
        if (!types.TryGetValue(key, out var definition)) throw new ArgumentException($"Cannot export missing model {key}.");
        if (!selectedTypes.Add(key)) return;
        foreach (var member in ModelMappingProfiles.Objects(definition, "members"))
        {
            if (ModelMappingProfiles.Text(member, "kind") == "type") AddType(ModelMappingProfiles.Text(member, "definitionId") + "@" + TagModel.Version(member));
            else QueueInputs(member, declared: true);
        }
        foreach (var profile in ModelMappingProfiles.Objects(model, "mappingProfiles").Where(item => ModelMappingProfiles.Text(item, "definitionId") + "@" + TagModel.Version(item) == key))
            foreach (var binding in profile["bindings"]!.AsObject()) if (binding.Value is JsonObject source) QueueInputs(source, declared: true);
    }
    private void AddInstance(string path)
    {
        if (!instances.TryGetValue(path, out var instance)) throw new ArgumentException($"Cannot export missing equipment {path}.");
        if (!selectedInstances.Add(path)) return;
        AddType(ModelMappingProfiles.Text(instance, "definitionId") + "@" + TagModel.Version(instance));
        foreach (var tag in expanded.Values.Where(tag => ModelMappingProfiles.Text(tag, "udtInstance") == path)) QueueInputs(tag);
    }
    private void QueueInputs(JsonObject tag, bool declared = false)
    {
        if (tag["connectionId"] is JsonValue connection && connection.TryGetValue<string>(out var id) && !id.Contains('{'))
            external.Add(new("connection", id, "Configure or map this connection on the destination gateway. Credentials are never exported."));
        foreach (var path in ModelDependencies.TagInputs(tag))
        {
            if (declared && (path.Contains('{') || path.StartsWith("./", StringComparison.Ordinal))) continue;
            pending.Enqueue(path);
        }
    }
    private void IncludeDependencies()
    {
        while (pending.TryDequeue(out var path))
        {
            if (!examined.Add(path)) continue;
            if (!includeSources) { external.Add(new("tag", path, "Source tag inclusion was disabled; provide this path on the destination.")); continue; }
            if (!expanded.TryGetValue(path, out var tag)) { external.Add(new("tag", path, "This source is not currently available.")); continue; }
            if (tag["udtInstance"] is JsonValue root && root.TryGetValue<string>(out var equipment)) { AddInstance(equipment); continue; }
            if (authored.ContainsKey(path)) { selectedTags.Add(path); QueueInputs(tag); }
            else
            {
                external.Add(new("source-owned-tag", path, "Recreate or map the owning source connection and discovery mapping before applying."));
                QueueInputs(tag);
            }
        }
    }
    private ModelExportResult Result()
    {
        var package = TagModel.Empty();
        package.Remove("provider"); // Importing one model must not change destination-wide collection settings.
        package["udtDefinitions"] = Clone(selectedTypes.Select(key => types[key]));
        package["instances"] = Clone(selectedInstances.Select(path => instances[path]));
        package["tags"] = Clone(selectedTags.Select(path => authored[path]));
        package["hierarchy"] = Clone(ModelMappingProfiles.Objects(model, "hierarchy").Where(node => selectedInstances.Any(path => path.StartsWith(ModelMappingProfiles.Text(node, "path") + "/", StringComparison.Ordinal))));
        var profiles = ModelMappingProfiles.Objects(model, "mappingProfiles").Where(profile => selectedTypes.Contains(ModelMappingProfiles.Text(profile, "definitionId") + "@" + TagModel.Version(profile))).ToArray();
        package["mappingProfiles"] = Clone(profiles);
        var usedGroups = Fields(package, "scanGroup").ToHashSet(StringComparer.Ordinal);
        package["scanGroups"] = Clone(ModelMappingProfiles.Objects(model, "scanGroups").Where(group => usedGroups.Contains(ModelMappingProfiles.Text(group, "name"))));
        return new(TagModelWire.Package(package), external.OrderBy(item => item.Kind).ThenBy(item => item.Id, StringComparer.Ordinal).ToArray(),
            new(selectedTypes.Count, selectedInstances.Count, selectedTags.Count, package["hierarchy"]!.AsArray().Count, profiles.Length));
    }
    private static IEnumerable<string> Fields(JsonNode? node, string key)
    {
        if (node is JsonObject value)
            foreach (var pair in value)
            {
                if (pair.Key == key && pair.Value is JsonValue scalar && scalar.TryGetValue<string>(out var text)) yield return text;
                else foreach (var item in Fields(pair.Value, key)) yield return item;
            }
        else if (node is JsonArray array) foreach (var child in array) foreach (var item in Fields(child, key)) yield return item;
    }
    private static JsonArray Clone(IEnumerable<JsonObject> values) => new(values.Select(value => value.DeepClone()).ToArray());
}
