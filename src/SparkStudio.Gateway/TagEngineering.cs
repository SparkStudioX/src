using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public static class TagEngineering
{
    public static void MapTagEngineeringEndpoints(this RouteGroupBuilder routes)
    {
        routes.MapGet("/tag-engineering/export", (ProjectStore store) => store.ExportTags()).Access("admin");
        routes.MapPost("/tag-engineering/preview", (JsonObject package, ProjectStore store) => store.PreviewTagImport(package)).Access("admin");
        routes.MapPost("/tag-engineering/apply", (TagImportRequest request, TagEngine tags) => tags.ApplyImport(request)).Access("admin", audit: true);
    }
}

public sealed record TagImportRequest(JsonObject Package, string Revision, string PreviewToken);
public sealed record TagImportChange(string Path, string Action, string Kind);
public sealed record TagImportPreview(string Revision, string PreviewToken, int TotalTags, TagImportChange[] Changes);

public sealed partial class ProjectStore
{
    private JsonObject NormalizeTag(JsonObject value)
    {
        var kind = TagDefinitionValidator.Kind(value);
        if (kind is not ("opcua" or "memory" or "expression")) throw new ArgumentException("kind must be opcua, memory or expression.");
        var node = new JsonObject
        {
            ["path"] = TagDefinitionValidator.Path(TagDefinitionValidator.Text(value, "path")), ["kind"] = kind,
            ["enabled"] = TagDefinitionValidator.Enabled(value), ["publishingIntervalMs"] = TagDefinitionValidator.PublishingInterval(value)
        };
        if (kind == "opcua")
        {
            var id = TagDefinitionValidator.Text(value, "connectionId");
            var connection = GetConnections().OfType<JsonObject>().FirstOrDefault(item => Optional(item, "id") == id)
                ?? throw new ArgumentException("An existing OPC UA connection is required.");
            if (Optional(connection, "type") != "opcua") throw new ArgumentException("Tag bindings require an OPC UA connection.");
            node["connectionId"] = id; node["nodeId"] = TagDefinitionValidator.NodeIdentifier(value);
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
        lock (gate) return new JsonObject { ["format"] = "sparkstudio.tags", ["version"] = 1, ["tags"] = GetTagDefinitions() };
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
            Persist("tags.json", prepared.Definitions);
            definitions = prepared.Definitions;
            return prepared.Preview;
        }
    }

    private (JsonArray Definitions, TagImportPreview Preview) PrepareTagImport(JsonObject package)
    {
        if (package.Any(item => item.Key is not ("format" or "version" or "tags"))
            || Optional(package, "format") != "sparkstudio.tags" || package["version"] is not JsonValue version || !version.TryGetValue<int>(out var number) || number != 1
            || package["tags"] is not JsonArray imported || imported.Count is < 1 or > 1000)
            throw new ArgumentException("Import requires sparkstudio.tags version 1 with 1–1000 tag definitions and no unsupported fields.");
        var normalized = new List<JsonObject>(); var incoming = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in imported)
        {
            if (item is not JsonObject value || value.Any(field => field.Key is not ("path" or "kind" or "dataType" or "value" or "enabled" or "publishingIntervalMs" or "connectionId" or "nodeId" or "expression" or "inputs")))
                throw new ArgumentException("Every import tag must be an object with supported fields only. UDT and provider definitions are not supported.");
            var kind = TagDefinitionValidator.Kind(value);
            var sourceFields = kind switch { "memory" => new[] { "value" }, "expression" => new[] { "expression", "inputs" }, _ => new[] { "connectionId", "nodeId" } };
            if (value.Any(field => field.Key is not ("path" or "kind" or "dataType" or "enabled" or "publishingIntervalMs") && !sourceFields.Contains(field.Key, StringComparer.Ordinal)))
                throw new ArgumentException("Import tag fields must match the selected value source.");
            var node = NormalizeTag(value); var path = Required(node, "path");
            if (!incoming.Add(path)) throw new ArgumentException($"Duplicate import tag path: {path}.");
            normalized.Add(node);
        }
        var next = (JsonArray)definitions.DeepClone(); var changes = new List<TagImportChange>();
        foreach (var node in normalized)
        {
            var path = Required(node, "path"); var old = next.OfType<JsonObject>().FirstOrDefault(item => Optional(item, "path") == path);
            changes.Add(new(path, old is null ? "add" : JsonNode.DeepEquals(TagDefinitionValidator.WithLegacyDefaults(old), node) ? "unchanged" : "update", Required(node, "kind")));
            if (old is not null) next.Remove(old);
            next.Add(node);
        }
        if (next.Count > 1000) throw new ArgumentException("A gateway supports at most 1000 configured tags in this version.");
        TagExpressions.Order(next.OfType<JsonObject>().ToArray());
        var revision = Hash(GetTagDefinitions().ToJsonString());
        var token = Hash(revision + "\n" + connections.ToJsonString() + "\n" + package.ToJsonString());
        return (next, new(revision, token, next.Count, changes.ToArray()));
    }
    private static string Hash(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
}
