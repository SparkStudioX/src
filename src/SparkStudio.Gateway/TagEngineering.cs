using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public static class TagEngineering
{
    public static void MapTagEngineeringEndpoints(this RouteGroupBuilder routes)
    {
        routes.MapGet("/tag-engineering/export", (ProjectStore store) => store.ExportTags()).Access("configuration");
        routes.MapPost("/tag-engineering/preview", (JsonObject package, ProjectStore store) => store.PreviewTagImport(package)).Access("configuration");
        routes.MapPost("/tag-engineering/apply", (TagImportRequest request, TagEngine tags) => tags.ApplyImport(request)).Access("configuration", audit: true);
        routes.MapGet("/tag-engineering/status", (TagEngine tags) => tags.ProviderSnapshot()).Access("configuration");
        routes.MapGet("/tag-engineering/values", (TagEngine tags) => tags.Snapshot()).Access("configuration");
    }
}

public sealed record TagImportRequest(JsonObject Package, string Revision, string PreviewToken);
public sealed record TagImportChange(string Path, string Action, string Kind, string[]? OverrideFields = null);
public sealed record TagImportPreview(string Revision, string PreviewToken, int TotalTags, TagImportChange[] Changes, string[]? Conflicts = null)
{
    public bool CanApply => Conflicts is null || Conflicts.Length == 0;
}

public sealed partial class ProjectStore
{
    private JsonObject tagModel = TagModel.Empty();
    private JsonArray? expandedTagDefinitions;
    private Dictionary<string, JsonObject>? expandedTagIndex;
    private long tagConfigurationGeneration;
    private JsonObject memoryTagState = new();
    private long memoryStateGeneration;
    private long persistedMemoryGeneration;
    private readonly object memoryFlushGate = new();
    public long TagConfigurationGeneration => gatewayStore?.TagConfigurationGeneration ?? Interlocked.Read(ref tagConfigurationGeneration);
    public long MemoryStateWriteCount { get; private set; }
    private void LoadTagModel(JsonNode? saved)
    {
        if (saved is JsonArray legacy) tagModel["tags"] = legacy.DeepClone();
        else if (saved is JsonObject model && model["version"]?.GetValue<int>() == 2) tagModel = (JsonObject)model.DeepClone();
        else if (saved is not null) throw new ArgumentException("Unsupported stored tag configuration format.");
        definitions = tagModel["tags"]!.AsArray();
        if (Load("tag-values.json") is JsonObject state && state["version"]?.GetValue<int>() == 1 && state["values"] is JsonObject savedValues)
            memoryTagState = (JsonObject)savedValues.DeepClone();
    }
    private void PersistTagModel(JsonObject next)
    {
        var expanded = TagModel.Expand(next, NormalizeTag);
        var prior = expandedTagDefinitions ?? TagModel.Expand(tagModel, NormalizeTag);
        var previous = prior.OfType<JsonObject>().ToDictionary(tag => Required(tag, "path"), StringComparer.Ordinal);
        Persist("tags.json", next);
        tagModel = next;
        definitions = next["tags"]!.AsArray();
        expandedTagDefinitions = expanded;
        expandedTagIndex = null;
        tagConfigurationGeneration++;
        var retained = expanded.OfType<JsonObject>().Where(tag => previous.TryGetValue(Required(tag, "path"), out var old) && JsonNode.DeepEquals(old, tag))
            .Select(tag => Required(tag, "path")).ToHashSet(StringComparer.Ordinal);
        foreach (var path in memoryTagState.Select(item => item.Key).Where(path => !retained.Contains(path)).ToArray())
        { memoryTagState.Remove(path); memoryStateGeneration++; }
    }
    private void ApplyMemoryState(JsonArray tags)
    {
        foreach (var tag in tags.OfType<JsonObject>().Where(tag => Optional(tag, "kind") == "memory"))
            if (memoryTagState[Required(tag, "path")] is JsonObject saved && Optional(saved, "dataType") == Optional(tag, "dataType") && Optional(saved, "configuration") == Hash(tag.ToJsonString()))
                tag["value"] = TagDefinitionValidator.MemoryValue(Required(tag, "dataType"), saved["value"]);
    }
    /// <summary>Memory state is checkpointed at most once per second; orderly stop flushes it as well.</summary>
    public void FlushMemoryValues()
    {
        if (gatewayStore is not null) { gatewayStore.FlushMemoryValues(); return; }
        lock (memoryFlushGate)
        {
            JsonObject snapshot; long generation;
            lock (gate)
            {
                if (persistedMemoryGeneration == memoryStateGeneration) return;
                generation = memoryStateGeneration;
                snapshot = new() { ["version"] = 1, ["values"] = memoryTagState.DeepClone() };
            }
            // The slow flush does not own the gateway configuration monitor.
            // Only the atomic replacement owns the configuration monitor. This
            // keeps online backup capture coherent without blocking tag writes
            // on serialization or fsync, or reversing the flush/config order.
            DurableJsonFile.Write(Path.Combine(directory, "tag-values.json"), snapshot, Json, gate);
            lock (gate) { persistedMemoryGeneration = generation; MemoryStateWriteCount++; }
        }
    }
    private JsonObject ModelWithTags(JsonArray tags)
    {
        var model = (JsonObject)tagModel.DeepClone(); model["tags"] = tags; return model;
    }
    public JsonArray GetRuntimeTagDefinitions()
    {
        var result = GetTagDefinitions();
        foreach (var tag in result.OfType<JsonObject>()) tag["enabled"] = tag["effectiveEnabled"]!.DeepClone();
        return result;
    }
    public bool DefaultTagProviderEnabled()
    {
        if (gatewayStore is not null) return gatewayStore.DefaultTagProviderEnabled();
        lock (gate) return TagDefinitionValidator.Enabled(tagModel["provider"]!.AsObject());
    }
    private JsonObject NormalizeTag(JsonObject value)
    {
        var kind = TagDefinitionValidator.Kind(value);
        if (kind is not ("opcua" or "memory" or "expression")) throw new ArgumentException("kind must be opcua, memory or expression.");
        var node = new JsonObject
        {
            ["path"] = TagDefinitionValidator.Path(TagDefinitionValidator.Text(value, "path")), ["kind"] = kind,
            ["enabled"] = TagDefinitionValidator.Enabled(value), ["publishingIntervalMs"] = TagDefinitionValidator.PublishingInterval(value)
        };
        if (value["scanGroup"] is not null) node["scanGroup"] = TagModel.Name(value, "scanGroup");
        if (kind == "opcua")
        {
            var id = TagDefinitionValidator.Text(value, "connectionId");
            var connection = connections.OfType<JsonObject>().FirstOrDefault(item => Optional(item, "id") == id)
                ?? throw new ArgumentException("An existing OPC UA connection is required.");
            if (Optional(connection, "type") != "opcua") throw new ArgumentException("Tag bindings require an OPC UA connection.");
            node["connectionId"] = id; node["nodeId"] = TagDefinitionValidator.NodeIdentifier(value);
            node["absoluteDeadband"] = TagDefinitionValidator.AbsoluteDeadband(value);
            node["queueSize"] = TagDefinitionValidator.MonitorQueueSize(value);
            if (value.ContainsKey("dataType")) node["dataType"] = TagDefinitionValidator.DataType(value);
        }
        else
        {
            node["dataType"] = TagDefinitionValidator.DataType(value);
            if (kind == "memory") node["value"] = TagDefinitionValidator.MemoryValue(Required(node, "dataType"), value["value"]);
            else
            {
                var plan = TagExpressions.Compile(value);
                node["expression"] = Required(value, "expression");
                node["inputs"] = new JsonObject(plan.Inputs.OrderBy(item => item.Key, StringComparer.Ordinal).Select(item => KeyValuePair.Create<string, JsonNode?>(item.Key, JsonValue.Create(item.Value))));
            }
        }
        return node;
    }

    public JsonObject ExportTags()
    {
        if (gatewayStore is not null) return gatewayStore.ExportTags();
        lock (gate) return (JsonObject)tagModel.DeepClone();
    }

    public TagImportPreview PreviewTagImport(JsonObject package)
    {
        if (gatewayStore is not null) return gatewayStore.PreviewTagImport(package);
        lock (gate) return PrepareTagImport(package).Preview;
    }

    public TagImportPreview ApplyTagImport(TagImportRequest request)
    {
        if (request.Package is null) throw new ArgumentException("An import package is required.");
        if (gatewayStore is not null) return gatewayStore.ApplyTagImport(request);
        lock (gate)
        {
            var prepared = PrepareTagImport(request.Package);
            if (prepared.Preview.Revision != request.Revision || prepared.Preview.PreviewToken != request.PreviewToken)
                throw new InvalidOperationException("Tags, connections or the import changed after preview. Preview the import again.");
            if (!prepared.Preview.CanApply) throw new ArgumentException("Resolve tag model conflicts before applying: " + string.Join(" ", prepared.Preview.Conflicts!));
            PersistTagModel(prepared.Model);
            return prepared.Preview;
        }
    }

    private (JsonObject Model, TagImportPreview Preview) PrepareTagImport(JsonObject package)
    {
        if (Optional(package, "format") != "sparkstudio.tags" || package["version"] is not JsonValue version || !version.TryGetValue<int>(out var number) || number is not (1 or 2))
            throw new ArgumentException("Import requires sparkstudio.tags version 1 or 2.");
        if (number == 1) TagModel.Fields(package, "format", "version", "tags");
        else TagModel.Fields(package, "format", "version", "tags", "provider", "scanGroups", "udtDefinitions", "instances", "removeTags", "removeInstances", "removeScanGroups", "removeUdtDefinitions");
        var imported = TagModel.Array(package, "tags", 1000);
        if (number == 1 && imported.Count == 0) throw new ArgumentException("Version 1 imports require at least one tag.");
        if (number == 2)
        {
            TagModel.Array(package, "scanGroups", 32); TagModel.Array(package, "udtDefinitions", 128); TagModel.Array(package, "instances", 128);
        }
        var next = (JsonObject)tagModel.DeepClone(); var changes = new List<TagImportChange>();
        void Merge(string collection, JsonArray incoming, Func<JsonObject, string> key, Func<JsonObject, JsonObject>? normalize = null, bool immutable = false)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal); var target = next[collection]!.AsArray();
            foreach (var value in incoming.OfType<JsonObject>())
            {
                var node = normalize is null ? (JsonObject)value.DeepClone() : normalize(value); var id = key(node);
                if (!seen.Add(id)) throw new ArgumentException($"Duplicate {collection} key: {id}.");
                var old = target.OfType<JsonObject>().FirstOrDefault(item => key(item) == id);
                if (immutable && old is not null && !JsonNode.DeepEquals(old, node)) throw new ArgumentException($"UDT {id} is immutable. Create a new version and explicitly upgrade instances.");
                if (collection != "tags") changes.Add(new(id, old is null ? "add" : JsonNode.DeepEquals(old, node) ? "unchanged" : "update", collection));
                if (old is not null) target.Remove(old); target.Add(node);
            }
        }
        Merge("tags", imported, tag => Required(tag, "path"), tag => { TagModel.ValidateTagFields(tag); return NormalizeTag(tag); });
        if (number == 2)
        {
            Merge("scanGroups", package["scanGroups"]!.AsArray(), group => TagModel.Name(group, "name"));
            Merge("udtDefinitions", package["udtDefinitions"]!.AsArray(), TagModel.DefinitionKey, immutable: true);
            Merge("instances", package["instances"]!.AsArray(), item => TagDefinitionValidator.Path(Required(item, "path")));
            if (package["provider"] is JsonObject provider)
            {
                changes.Add(new("default", JsonNode.DeepEquals(next["provider"], provider) ? "unchanged" : "update", "provider"));
                next["provider"] = provider.DeepClone();
            }
            else if (package.ContainsKey("provider")) throw new ArgumentException("provider must be an object.");
            void Remove(string field, string collection, Func<JsonObject, string> key)
            {
                if (!package.ContainsKey(field)) return;
                if (package[field] is not JsonArray remove || remove.Count > 1000) throw new ArgumentException($"{field} must be an array of keys.");
                foreach (var item in remove)
                {
                    if (item is not JsonValue scalar || !scalar.TryGetValue<string>(out var id)) throw new ArgumentException($"{field} must contain text keys.");
                    if (package[collection]!.AsArray().OfType<JsonObject>().Any(value => key(value) == id)) throw new ArgumentException($"Cannot import and remove {id} together.");
                    var target = next[collection]!.AsArray(); var old = target.OfType<JsonObject>().FirstOrDefault(value => key(value) == id);
                    if (old is null) throw new ArgumentException($"Cannot remove missing {collection}: {id}.");
                    target.Remove(old); if (collection != "tags") changes.Add(new(id, "remove", collection));
                }
            }
            Remove("removeTags", "tags", tag => Required(tag, "path")); Remove("removeInstances", "instances", tag => Required(tag, "path"));
            Remove("removeScanGroups", "scanGroups", tag => Required(tag, "name")); Remove("removeUdtDefinitions", "udtDefinitions", TagModel.DefinitionKey);
        }
        var previous = GetTagDefinitions().OfType<JsonObject>().ToDictionary(tag => Required(tag, "path"), StringComparer.Ordinal);
        JsonArray expanded; string[] conflicts = [];
        try { expanded = TagModel.Expand(next, NormalizeTag); }
        catch (ArgumentException error) when (number == 2) { expanded = []; conflicts = [error.Message]; }
        if (conflicts.Length == 0)
        {
            foreach (var node in expanded.OfType<JsonObject>())
            {
                var path = Required(node, "path"); var old = previous.GetValueOrDefault(path);
                var action = old is null ? "add" : JsonNode.DeepEquals(old, node) ? "unchanged" : "update";
                // Include unchanged incoming direct tags as in the version-1 contract, and all affected instance members.
                if (action != "unchanged" || imported.OfType<JsonObject>().Any(tag => Required(tag, "path") == path) || number == 2 && node["udtInstance"] is not null)
                    changes.Add(new(path, action, Required(node, "kind"), node["overrideFields"]?.AsArray().Select(field => field!.GetValue<string>()).ToArray()));
                previous.Remove(path);
            }
            foreach (var old in previous.Values) changes.Add(new(Required(old, "path"), "remove", TagDefinitionValidator.Kind(old)));
        }
        var revision = Hash(tagModel.ToJsonString());
        var token = Hash(revision + "\n" + connections.ToJsonString() + "\n" + package.ToJsonString());
        return (next, new(revision, token, expanded.Count, changes.ToArray(), conflicts));
    }
    private static string Hash(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
}
