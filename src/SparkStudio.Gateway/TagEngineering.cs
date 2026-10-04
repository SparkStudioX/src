using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Features;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

public static class TagEngineering
{
    public const long MaximumImportBytes = 32L * 1024 * 1024;

    public static void MapTagEngineeringEndpoints(this RouteGroupBuilder routes)
    {
        routes.MapGet("/tag-engineering/export", (ProjectStore store) => store.ExportTags()).Access("configuration");
        routes.MapGet("/tag-engineering/definitions", (ProjectStore store) => TagModelWire.Definitions(store.GetTagDefinitions())).Access("configuration");
        routes.MapPost("/tag-engineering/preview", async (HttpContext context, ProjectStore store) => store.PreviewTagImport(await ReadImportAsync<JsonObject>(context))).Access("configuration");
        routes.MapPost("/tag-engineering/apply", async (HttpContext context, TagEngine tags) => tags.ApplyImport(await ReadImportAsync<TagImportRequest>(context))).Access("configuration", audit: true);
        routes.MapGet("/tag-engineering/status", (TagEngine tags) => tags.ProviderSnapshot()).Access("configuration");
        routes.MapGet("/tag-engineering/values", (TagEngine tags) => tags.Snapshot()).Access("configuration");
    }

    private static async Task<T> ReadImportAsync<T>(HttpContext context)
    {
        // Model binding normally reads the body before the handler. Read explicitly
        // so only these authorized import routes lift the global 1 MiB ceiling.
        var size = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (size is { IsReadOnly: false }) size.MaxRequestBodySize = MaximumImportBytes;
        if (context.Request.ContentLength > MaximumImportBytes) throw new BadHttpRequestException("Tag imports are limited to 32 MiB.", 413);
        if (!context.Request.HasJsonContentType()) throw new BadHttpRequestException("Tag imports require a JSON content type.", 415);
        using var data = new MemoryStream();
        var buffer = new byte[81920];
        int count;
        while ((count = await context.Request.Body.ReadAsync(buffer, context.RequestAborted)) > 0)
        {
            if (data.Length + count > MaximumImportBytes) throw new BadHttpRequestException("Tag imports are limited to 32 MiB.", 413);
            await data.WriteAsync(buffer.AsMemory(0, count), context.RequestAborted);
        }
        data.Position = 0;
        return await System.Text.Json.JsonSerializer.DeserializeAsync<T>(data, ProjectStore.Json, context.RequestAborted)
            ?? throw new ArgumentException("A tag import package is required.");
    }
}

public sealed record TagImportRequest(JsonObject Package, string Revision, string PreviewToken);
public sealed record TagImportChange(string Path, string Action, string Kind, string[]? OverrideFields = null);
public sealed record TagImportPreview(string Revision, string PreviewToken, int TotalTags, TagImportChange[] Changes, string[]? Conflicts = null, JsonArray? ExpandedTags = null)
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
        if (saved is not null) tagModel = (JsonObject)TagModel.RequireCurrentFormat(saved).DeepClone();
        definitions = tagModel["tags"]!.AsArray();
        if (Load("tag-values.json") is JsonObject state && state["version"]?.GetValue<int>() == 1 && state["values"] is JsonObject savedValues)
            memoryTagState = (JsonObject)savedValues.DeepClone();
    }
    private void PersistTagModel(JsonObject next)
    {
        var expanded = ExpandTagModel(next);
        ValidateOwnedNamespaces(expanded);
        var prior = expandedTagDefinitions ?? ExpandTagModel(tagModel);
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
            if (memoryTagState[Required(tag, "path")] is JsonObject saved && Optional(saved, "dataType") == Optional(tag, "dataType") && Hash(tag.ToJsonString()) == Optional(saved, "configuration"))
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
        if (kind is not ("opcua" or "device" or "memory" or "expression" or "reference")) throw new ArgumentException("kind must be opcua, device, memory, expression or reference.");
        var node = new JsonObject
        {
            ["path"] = TagDefinitionValidator.Path(TagDefinitionValidator.Text(value, "path")), ["kind"] = kind,
            ["enabled"] = TagDefinitionValidator.Enabled(value), ["publishingIntervalMs"] = TagDefinitionValidator.PublishingInterval(value)
        };
        if (value["scanGroup"] is not null) node["scanGroup"] = TagModel.Name(value, "scanGroup");
        if (kind is "opcua" or "device")
            NormalizeAcquisitionTag(value, node, kind);
        else NormalizeDerivedTag(value, node, kind);
        TagModelMetadata.Copy(value, node);
        return node;
    }
    private void NormalizeAcquisitionTag(JsonObject value, JsonObject node, string kind)
    {
            var id = TagDefinitionValidator.Text(value, "connectionId");
            var connection = connections.OfType<JsonObject>().FirstOrDefault(item => Optional(item, "id") == id)
                ?? throw new ArgumentException("An existing device connection is required.");
            if (kind == "opcua" && Optional(connection, "type") != "opcua") throw new ArgumentException("OPC tag bindings require an OPC UA connection.");
            if (kind == "device" && !DeviceConfiguration.IsDevice(Required(connection, "type")) && !SourceConfiguration.IsSource(Required(connection, "type"))) throw new ArgumentException("Device tag bindings require a supported point connection.");
            node["connectionId"] = id;
            node["nodeId"] = kind == "opcua" ? TagDefinitionValidator.NodeIdentifier(value) : TagDefinitionValidator.DevicePointIdentifier(value);
            node["absoluteDeadband"] = TagDefinitionValidator.AbsoluteDeadband(value);
            node["queueSize"] = TagDefinitionValidator.MonitorQueueSize(value);
            if (kind == "device")
            {
                var point = PointCatalog.Point(GetConnection(id, allowDisabled: true), Required(node, "nodeId"));
                var dataType = value.ContainsKey("dataType") ? TagDefinitionValidator.DataType(value) : point.DataType;
                if (dataType != point.DataType) throw new ArgumentException("The tag data type must match the saved device point.");
                node["dataType"] = dataType;
                node["writable"] = point.Writable;
                if (SourceConfiguration.IsSource(Required(connection, "type")) && value["writable"]?.GetValue<bool>() == true)
                    throw new ArgumentException("Read-source tags cannot be writable.");
            }
            else if (value.ContainsKey("dataType")) node["dataType"] = TagDefinitionValidator.DataType(value);
    }
    private static void NormalizeDerivedTag(JsonObject value, JsonObject node, string kind)
    {
            node["dataType"] = TagDefinitionValidator.DataType(value);
            if (kind == "memory") node["value"] = TagDefinitionValidator.MemoryValue(Required(node, "dataType"), value["value"]);
            else if (kind == "reference") node["target"] = TagDefinitionValidator.Path(TagDefinitionValidator.Text(value, "target"));
            else
            {
                var plan = TagExpressions.Compile(value);
                node["expression"] = Required(value, "expression");
                node["inputs"] = new JsonObject(plan.Inputs.OrderBy(item => item.Key, StringComparer.Ordinal).Select(item => KeyValuePair.Create<string, JsonNode?>(item.Key, JsonValue.Create(item.Value))));
            }
    }

    public JsonObject ExportTags()
    {
        if (gatewayStore is not null) return gatewayStore.ExportTags();
        lock (gate) return TagModelWire.Package(tagModel);
    }

    private JsonArray ExpandTagModel(JsonObject model) => TagModel.Expand(model, NormalizeTag, SourceOwnedDefinitions().OfType<JsonObject>());

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
        ValidateTagImportEnvelope(package);
        package = TagModelWire.NormalizePackage(package, tagModel);
        var imported = package["tags"]!.AsArray();
        var next = (JsonObject)tagModel.DeepClone(); var changes = new List<TagImportChange>();
        MergeTagImport(package, imported, next, changes);
        return PreviewExpandedTagImport(package, imported, next, changes);
    }
    private static void ValidateTagImportEnvelope(JsonObject package)
    {
        TagModel.RequireCurrentFormat(package);
        TagModel.Fields(package, "format", "version", "tags", "provider", "scanGroups", "udtDefinitions", "instances", "removeTags", "removeInstances", "removeScanGroups", "removeUdtDefinitions", "hierarchy", "removeHierarchy", "mappingProfiles", "removeMappingProfiles");
        TagModel.Array(package, "tags", TagModel.MaximumTags); TagModel.Array(package, "scanGroups", 32);
        TagModel.Array(package, "udtDefinitions", TagModel.MaximumDefinitions); TagModel.Array(package, "instances", TagModel.MaximumInstances);
        if (package.ContainsKey("hierarchy")) TagModel.Array(package, "hierarchy", TagModel.MaximumHierarchyNodes);
        if (package.ContainsKey("mappingProfiles")) TagModel.Array(package, "mappingProfiles", 256);
    }
    private void MergeTagImport(JsonObject package, JsonArray imported, JsonObject next, List<TagImportChange> changes)
    {
        next["mappingProfiles"] ??= new JsonArray();
        void Merge(string collection, JsonArray incoming, Func<JsonObject, string> key, Func<JsonObject, JsonObject>? normalize = null, bool immutable = false)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var target = next[collection]!.AsArray().OfType<JsonObject>().ToDictionary(key, StringComparer.Ordinal);
            var incomingNodes = new List<JsonObject>();
            foreach (var value in incoming.OfType<JsonObject>())
            {
                var node = normalize is null ? (JsonObject)value.DeepClone() : normalize(value); var id = key(node);
                if (!seen.Add(id)) throw new ArgumentException($"Duplicate {collection} key: {id}.");
                target.Remove(id, out var old);
                if (immutable && old is not null && !JsonNode.DeepEquals(old, node)) throw new ArgumentException($"UDT {id} is immutable. Create a new version and explicitly upgrade instances.");
                if (collection != "tags") changes.Add(new(id, old is null ? "add" : JsonNode.DeepEquals(old, node) ? "unchanged" : "update", collection));
                incomingNodes.Add(node);
            }
            next[collection] = new JsonArray(target.Values.Select(item => item.DeepClone()).Concat(incomingNodes).ToArray());
        }
        Merge("tags", imported, tag => Required(tag, "path"), tag => { TagModel.ValidateTagFields(tag); return NormalizeTag(tag); });
            Merge("scanGroups", package["scanGroups"]!.AsArray(), group => TagModel.Name(group, "name"));
            Merge("udtDefinitions", package["udtDefinitions"]!.AsArray(), TagModel.DefinitionKey, immutable: true);
            Merge("instances", package["instances"]!.AsArray(), item => TagDefinitionValidator.Path(Required(item, "path")));
            if (package["mappingProfiles"] is JsonArray mappings) Merge("mappingProfiles", mappings, item => TagModel.Name(item, "id"));
            if (package["hierarchy"] is JsonArray hierarchy) Merge("hierarchy", hierarchy, item => TagDefinitionValidator.Path(Required(item, "path")));
            if (package["provider"] is JsonObject provider)
            {
                var proposed = (JsonObject)provider.DeepClone();
                if (!proposed.ContainsKey("requireDeclaredHierarchy") && next["provider"]?["requireDeclaredHierarchy"] is JsonNode governance)
                    proposed["requireDeclaredHierarchy"] = governance.DeepClone();
                changes.Add(new("default", JsonNode.DeepEquals(next["provider"], proposed) ? "unchanged" : "update", "provider"));
                next["provider"] = proposed;
            }
            else if (package.ContainsKey("provider")) throw new ArgumentException("provider must be an object.");
            void Remove(string field, string collection, Func<JsonObject, string> key, int maximum)
            {
                if (!package.ContainsKey(field)) return;
                if (package[field] is not JsonArray remove || remove.Count > maximum) throw new ArgumentException($"{field} must be an array of at most {maximum} keys.");
                var incomingIds = (package[collection] as JsonArray ?? []).OfType<JsonObject>().Select(key).ToHashSet(StringComparer.Ordinal);
                var target = next[collection]!.AsArray().OfType<JsonObject>().ToDictionary(key, StringComparer.Ordinal);
                foreach (var item in remove)
                {
                    if (item is not JsonValue scalar || !scalar.TryGetValue<string>(out var id)) throw new ArgumentException($"{field} must contain text keys.");
                    if (incomingIds.Contains(id)) throw new ArgumentException($"Cannot import and remove {id} together.");
                    if (!target.Remove(id)) throw new ArgumentException($"Cannot remove missing {collection}: {id}.");
                    if (collection != "tags") changes.Add(new(id, "remove", collection));
                }
                next[collection] = new JsonArray(target.Values.Select(item => item.DeepClone()).ToArray());
            }
            Remove("removeTags", "tags", tag => Required(tag, "path"), TagModel.MaximumTags); Remove("removeInstances", "instances", tag => Required(tag, "path"), TagModel.MaximumInstances);
            Remove("removeScanGroups", "scanGroups", tag => Required(tag, "name"), 32); Remove("removeUdtDefinitions", "udtDefinitions", TagModel.DefinitionKey, TagModel.MaximumDefinitions);
            Remove("removeHierarchy", "hierarchy", tag => Required(tag, "path"), TagModel.MaximumHierarchyNodes);
            Remove("removeMappingProfiles", "mappingProfiles", item => TagModel.Name(item, "id"), 256);
    }
    private (JsonObject Model, TagImportPreview Preview) PreviewExpandedTagImport(JsonObject package, JsonArray imported, JsonObject next, List<TagImportChange> changes)
    {
        var previous = GetTagDefinitions().OfType<JsonObject>().ToDictionary(tag => Required(tag, "path"), StringComparer.Ordinal);
        JsonArray expanded; string[] conflicts = [];
        var ownedDefinitions = SourceOwnedDefinitions();
        try {
            expanded = ExpandTagModel(next);
            ValidateOwnedNamespaces(expanded);
            // Engineering packages edit authored definitions. Source-owned
            // definitions remain part of the resulting complete runtime model.
            foreach (var owned in ownedDefinitions.OfType<JsonObject>()) {
                var candidate = (JsonObject)owned.DeepClone();
                candidate["effectiveEnabled"] = TagDefinitionValidator.Enabled(next["provider"]!.AsObject());
                expanded.Add(candidate);
            }
        }
        catch (ArgumentException error) { expanded = []; conflicts = [error.Message]; }
        if (conflicts.Length == 0)
        {
            var importedPaths = imported.OfType<JsonObject>().Select(tag => Required(tag, "path")).ToHashSet(StringComparer.Ordinal);
            foreach (var node in expanded.OfType<JsonObject>())
            {
                var path = Required(node, "path"); var old = previous.GetValueOrDefault(path);
                var action = old is null ? "add" : JsonNode.DeepEquals(old, node) ? "unchanged" : "update";
                // Include unchanged incoming direct tags and all affected instance members.
                if (action != "unchanged" || importedPaths.Contains(path) || node["udtInstance"] is not null)
                    changes.Add(new(path, action, Required(node, "kind"), node["overrideFields"]?.AsArray().Select(field => field!.GetValue<string>()).ToArray()));
                previous.Remove(path);
            }
            foreach (var old in previous.Values) changes.Add(new(Required(old, "path"), "remove", TagDefinitionValidator.Kind(old)));
        }
        var revision = Hash(tagModel.ToJsonString());
        var token = Hash(revision + "\n" + connections.ToJsonString() + "\n" + ownedDefinitions.ToJsonString() + "\n" + package.ToJsonString());
        return (next, new(revision, token, expanded.Count, changes.ToArray(), conflicts, TagModelWire.Definitions(expanded)));
    }
    private static string Hash(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
}
