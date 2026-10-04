using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

public sealed partial class ProjectStore
{
    private static void RedactSourceSecrets(JsonObject connection)
    {
        if (connection["source"]?["authentication"] is not JsonObject auth) return;
        auth["hasPassword"] = auth.ContainsKey("protectedPassword"); auth["hasToken"] = auth.ContainsKey("protectedToken");
        foreach (var field in new[] { "password", "token", "protectedPassword", "protectedToken" }) auth.Remove(field);
    }
    private SourceSettings? UnprotectSourceSettings(JsonObject connection)
    {
        var settings = connection["source"]?.Deserialize<SourceSettings>(Json);
        if (settings is null) return null;
        var auth = settings.Authentication ?? new();
        if (connection["source"]?["authentication"] is JsonObject secrets)
            auth = auth with {
                Password = Optional(secrets, "protectedPassword") is { } password ? protector.Unprotect(password) : null,
                Token = Optional(secrets, "protectedToken") is { } token ? protector.Unprotect(token) : null
            };
        return settings with { Authentication = auth };
    }
    private SourceSettings ReadSourceSettingsForSave(JsonObject value, JsonObject? old)
    {
        var settings = value["source"]?.Deserialize<SourceSettings>(Json) ?? throw new ArgumentException("Source settings are required.");
        var oldSettings = old is null ? null : UnprotectSourceSettings(old);
        var suppliedAuth = value["source"]?["authentication"] as JsonObject;
        var auth = settings.Authentication ?? oldSettings?.Authentication ?? new();
        auth = auth with {
            Password = suppliedAuth?.ContainsKey("password") == true ? auth.Password : oldSettings?.Authentication?.Password,
            Token = suppliedAuth?.ContainsKey("token") == true ? auth.Token : oldSettings?.Authentication?.Token
        };
        var ownedIds = OwnedLeaves.Where(leaf => leaf.ConnectionId == Optional(value, "id")).Select(leaf => leaf.PointId).ToHashSet(StringComparer.Ordinal);
        return settings with { Authentication = auth, Points = settings.SavedPoints.Where(point => !ownedIds.Contains(point.Id)).ToArray(),
            I3x = settings.I3x is { } i3x ? i3x with { ClientId = i3x.ClientId ?? oldSettings?.I3x?.ClientId } : oldSettings?.I3x,
            Mqtt = settings.Mqtt is { } mqtt ? mqtt with { ClientId = mqtt.ClientId ?? oldSettings?.Mqtt?.ClientId } : oldSettings?.Mqtt
        };
    }
    private JsonObject ProtectSourceSettings(SourceSettings settings)
    {
        var node = JsonSerializer.SerializeToNode(settings, Json)!.AsObject();
        if (node["authentication"] is JsonObject auth)
        {
            if (settings.Authentication?.Password is { Length: > 0 } password) auth["protectedPassword"] = protector.Protect(password);
            if (settings.Authentication?.Token is { Length: > 0 } token) auth["protectedToken"] = protector.Protect(token);
            auth.Remove("password"); auth.Remove("token");
        }
        return node;
    }
    private void ValidateSourceMapChange(string id, SourceSettings settings)
    {
        foreach (var mapping in settings.Mqtt?.Mappings?.Where(mapping => mapping.Tags == "automatic") ?? []) {
            if (AuthoredNamespaceCollision(mapping.Root, mapping.Root) || OtherSourceRootCollision(id, mapping)
                || settings.Mqtt!.Mappings!.Any(other => other.Id != mapping.Id && other.Tags == "automatic"
                    && (other.Root == mapping.Root || other.Root.StartsWith(mapping.Root.TrimEnd('/') + "/", StringComparison.Ordinal)
                        || mapping.Root.StartsWith(other.Root.TrimEnd('/') + "/", StringComparison.Ordinal))))
                throw new ArgumentException("Automatic source roots must be exclusive of authored tags, UDT instances and other automatic mappings.");
        }
        var points = settings.SavedPoints.Concat(SourceOwnedPoints(id)).ToDictionary(point => point.Id, StringComparer.Ordinal);
        expandedTagDefinitions ??= ExpandTagModel(tagModel);
        var bindings = expandedTagDefinitions.OfType<JsonObject>().Concat(SourceOwnedDefinitions().OfType<JsonObject>()).Concat(tagModel["udtDefinitions"]!.AsArray().OfType<JsonObject>()
            .SelectMany(definition => definition["members"]!.AsArray().OfType<JsonObject>()));
        foreach (var binding in bindings.Where(tag => Optional(tag, "kind") == "device" && Optional(tag, "connectionId") == id))
            if (!points.TryGetValue(Required(binding, "nodeId"), out var point) || point.DataType != Optional(binding, "dataType"))
                throw new ArgumentException("A tag/UDT binding references a removed or retyped source point. Update the binding first.");
    }
    private SourceDiscoveryState? PrepareSourceMappingChange(string id, SourceSettings settings, string? token)
    {
        var leaves = OwnedLeaves.Where(leaf => leaf.ConnectionId == id).ToArray();
        if (leaves.Length == 0) return null;
        var changes = PrepareSourceMigration(id, settings);
        if (!changes.Changed) return null;
        if (token != changes.Token) throw new ArgumentException("Owned source paths/schema changed. Preview and explicitly apply the source migration before saving.");
        return new(1, sourceDiscovery.Generation + 1, changes.Leaves);
    }
    private (bool Changed, string Token, SourceOwnedLeaf[] Leaves) PrepareSourceMigration(string id, SourceSettings settings)
    {
        var changed = false;
        var next = OwnedLeaves.Select(leaf => {
            if (leaf.ConnectionId != id) return leaf;
            var mapping = settings.Mqtt?.Mappings?.SingleOrDefault(mapping => mapping.Id == leaf.MappingId);
            if (mapping is null) {
                if (leaf.MappingRemoved && leaf.Suppressed) return leaf;
                if (SourcePathReferenced(leaf.Path)) throw new ArgumentException("A saved resource references a point in the removed mapping. Update its references first.");
                var previousMapping = GetConnection(id, true).Source!.Mqtt!.Mappings!.Single(previous => previous.Id == leaf.MappingId);
                changed = true;
                return leaf with { Suppressed = true, Pruned = false, MappingRemoved = true, HistoricalRoot = previousMapping.Root, HistoricalStripLevels = previousMapping.StripLevels };
            }
            if (leaf.MappingRemoved) throw new ArgumentException("A removed mapping identity cannot be reused while its suppressed schema is retained. Use a new mapping id.");
            var fingerprint = MappingFingerprint(mapping);
            if (fingerprint == leaf.MappingFingerprint) return leaf;
            var path = SourceConfiguration.TopicPath(mapping, leaf.Address, leaf.Selector);
            if (path != leaf.Path && SourcePathReferenced(leaf.Path)) throw new ArgumentException("A saved resource references a path that this migration renames. Update its references first.");
            if (mapping.DataType is not null && mapping.DataType != leaf.DataType || !ShapeMatches(mapping, leaf.Shape))
                throw new ArgumentException("Owned point type/shape is locked. Suppress the old definition before creating a new schema.");
            if (AuthoredNamespaceCollision(path, mapping.Root) || OtherSourceRootCollision(id, mapping)) throw new ArgumentException("The source migration namespace collides with an authored/owned root.");
            changed = true;
            return leaf with { Path = path, MappingFingerprint = fingerprint };
        }).ToArray();
        if (next.Where(leaf => !leaf.Suppressed && !leaf.Pruned).Select(leaf => leaf.Path).Distinct(StringComparer.Ordinal).Count() != next.Count(leaf => !leaf.Suppressed && !leaf.Pruned))
            throw new ArgumentException("The source migration creates a display-path collision.");
        foreach (var mapping in settings.Mqtt?.Mappings ?? [])
            if (next.Count(leaf => leaf.ConnectionId == id && leaf.MappingId == mapping.Id && !leaf.Suppressed && !leaf.Pruned) > mapping.MaximumTags)
                throw new ArgumentException("The mapping cap is smaller than its existing owned leaves.");
        ValidateRetention(next);
        var token = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new {
            Connection = id, Generation = tagConfigurationGeneration,
            settings.Points, settings.Mqtt, Leaves = next.Select(leaf => new { leaf.PointId, leaf.Path, leaf.DataType, leaf.Shape, leaf.MappingFingerprint, leaf.Suppressed, leaf.Pruned, leaf.MappingRemoved })
        })));
        return (changed, token, next);
    }
    public object PreviewSourceMigration(string id, int revision, SourceSettings settings)
    {
        if (gatewayStore is not null) return gatewayStore.PreviewSourceMigration(id, revision, settings);
        lock (gate)
        {
            var saved = connections.OfType<JsonObject>().SingleOrDefault(item => Optional(item, "id") == id) ?? throw new KeyNotFoundException("Connection not found.");
            if (saved["revision"]!.GetValue<int>() != revision) throw new InvalidOperationException("Connection changed. Reload before migration.");
            var prior = GetConnection(id, true).Source!;
            var ownedIds = OwnedLeaves.Where(leaf => leaf.ConnectionId == id).Select(leaf => leaf.PointId).ToHashSet(StringComparer.Ordinal);
            settings = SourceConfiguration.Normalize(Required(saved, "type"), settings with {
                Authentication = prior.Authentication, Points = settings.SavedPoints.Where(point => !ownedIds.Contains(point.Id)).ToArray() });
            var result = PrepareSourceMigration(id, settings);
            return new { token = result.Token, changed = result.Changed, generation = sourceDiscovery.Generation,
                changes = result.Leaves.Where(leaf => leaf.ConnectionId == id).Select(leaf => new {
                    leaf.PointId, before = OwnedLeaves.Single(old => old.PointId == leaf.PointId).Path, after = leaf.Path, leaf.DataType, leaf.Suppressed, leaf.Pruned
                }).ToArray() };
        }
    }
    private (JsonArray Connections, JsonObject Model, string Token, SourcePoint[] Points, JsonObject[] Tags) PrepareSourceImport(string id, SourceImportRequest request)
    {
        if (request.Points is null || request.Points.Length is < 1 or > 1000) throw new ArgumentException("Import 1–1,000 source points per reviewed batch.");
        var saved = connections.OfType<JsonObject>().SingleOrDefault(item => Optional(item, "id") == id) ?? throw new KeyNotFoundException("Connection not found.");
        if (saved["revision"]!.GetValue<int>() != request.Revision) throw new InvalidOperationException("Connection changed. Reload its source browse before import.");
        var connection = GetConnection(id);
        if (!SourceConfiguration.IsSource(connection)) throw new ArgumentException("Use a read-source connection.");
        var settings = UnprotectSourceSettings(saved)!;
        var imported = request.Points.Select(point => new SourcePoint(SourceConfiguration.PointId(id, point.MappingId ?? "source", point.Address, point.Selector),
            point.Name, point.Address, point.DataType, point.Selector, MappingId: point.MappingId, SuggestedPath: TagDefinitionValidator.Path(point.Path))).ToArray();
        if (imported.Select(point => point.Id).Distinct().Count() != imported.Length || imported.Select(point => point.SuggestedPath).Distinct().Count() != imported.Length)
            throw new ArgumentException("Imported point identities and paths must be distinct.");
        var ownedIds = SourceOwnedPoints(id).Select(point => point.Id).ToHashSet(StringComparer.Ordinal);
        var points = settings.SavedPoints.Concat(imported.Where(point => !settings.SavedPoints.Any(old => old.Id == point.Id) && !ownedIds.Contains(point.Id))).ToArray();
        SourceConfiguration.Validate(connection.Type, settings with { Points = points.Concat(SourceOwnedPoints(id)).ToArray() });
        var candidateConnections = (JsonArray)connections.DeepClone();
        var candidateConnection = candidateConnections.OfType<JsonObject>().Single(item => Optional(item, "id") == id);
        candidateConnection["source"] = ProtectSourceSettings(settings with { Points = points }); candidateConnection["revision"] = request.Revision + 1;
        var current = GetTagDefinitions().OfType<JsonObject>().ToDictionary(tag => Required(tag, "path"), StringComparer.Ordinal);
        var model = (JsonObject)tagModel.DeepClone(); var tags = model["tags"]!.AsArray(); var addedTags = new List<JsonObject>();
        foreach (var point in imported)
        {
            if (current.ContainsKey(point.SuggestedPath!)) throw new ArgumentException("An imported source path collides with a saved definition. Choose another path.");
            if (points.Concat(SourceOwnedPoints(id)).Single(old => old.Id == point.Id).DataType != point.DataType) throw new ArgumentException("The imported type differs from an existing saved point.");
            var tag = new JsonObject { ["path"] = point.SuggestedPath, ["kind"] = "device", ["connectionId"] = id,
                ["nodeId"] = point.Id, ["dataType"] = point.DataType, ["enabled"] = true, ["publishingIntervalMs"] = 1000, ["writable"] = false };
            tags.Add(tag); addedTags.Add(tag);
        }
        var previous = connections; connections = candidateConnections;
        try { ValidateOwnedNamespaces(ExpandTagModel(model)); }
        finally { connections = previous; }
        var token = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new {
            Id = id, request.Revision, Generation = tagConfigurationGeneration, Points = request.Points
        })));
        return (candidateConnections, model, token, imported, addedTags.ToArray());
    }
    public object PreviewSourceImport(string id, SourceImportRequest request)
    {
        if (gatewayStore is not null) return gatewayStore.PreviewSourceImport(id, request);
        lock (gate) { var preview = PrepareSourceImport(id, request); return new { previewToken = preview.Token,
            points = preview.Points, tags = preview.Tags, totalTags = GetTagDefinitions().Count + preview.Tags.Length }; }
    }
    public object ApplySourceImport(string id, SourceImportRequest request)
    {
        if (gatewayStore is not null) return gatewayStore.ApplySourceImport(id, request);
        lock (gate)
        {
            var prepared = PrepareSourceImport(id, request);
            if (request.PreviewToken != prepared.Token) throw new InvalidOperationException("Source import preview changed. Review it again before applying.");
            var state = JsonSerializer.SerializeToNode(sourceDiscovery, Json)!;
            Persist("source-config-commit.json", new JsonObject { ["version"] = 1, ["connections"] = prepared.Connections.DeepClone(),
                ["discovery"] = state, ["tags"] = prepared.Model.DeepClone() });
            Persist("connections.json", prepared.Connections); Persist("tags.json", prepared.Model);
            connections = prepared.Connections; tagModel = prepared.Model; definitions = tagModel["tags"]!.AsArray();
            File.Delete(Path.Combine(directory, "source-config-commit.json"));
            expandedTagDefinitions = null; expandedTagIndex = null; tagConfigurationGeneration++;
            return new { imported = prepared.Tags.Length, connection = GetConnections().OfType<JsonObject>().Single(item => Optional(item, "id") == id) };
        }
    }
}
