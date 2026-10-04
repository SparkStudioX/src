using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

public sealed record SourceOwnedLeaf(string ConnectionId, string MappingId, string Address, string? Selector,
    string PointId, string Path, string Name, string DataType, string Shape, string MappingFingerprint,
    DateTimeOffset LastSeen, bool Suppressed = false, bool Pruned = false, bool MappingRemoved = false,
    string? HistoricalRoot = null, int HistoricalStripLevels = 0);
public sealed record SourceDiscoveryState(int Version = 1, long Generation = 0, SourceOwnedLeaf[]? Leaves = null);
public sealed record SourceImportSelection(string Address, string Name, string DataType, string Path,
    string? Selector = null, string? MappingId = null);
public sealed record SourceImportRequest(int Revision, SourceImportSelection[] Points, string? PreviewToken = null);

public sealed partial class ProjectStore
{
    private SourceDiscoveryState sourceDiscovery = new(Leaves: []);
    // Authored tag and unrelated connection edits do not change a source point
    // catalog. Keep its parsed settings cached until its own saved node or the
    // ownership catalog changes.
    private long sourcePointCatalogGeneration;
    private SourceDiscoveryState? indexedSourceState;
    private Dictionary<string, SourceOwnedLeaf> ownershipIndex = new(StringComparer.Ordinal);
    private readonly Dictionary<string, DateTimeOffset> sourceObservedAt = new(StringComparer.Ordinal);
    private DateTimeOffset sourceObservationsFlushed;
    private SourceOwnedLeaf[] OwnedLeaves => sourceDiscovery.Leaves ?? [];
    private Dictionary<string, SourceOwnedLeaf> OwnershipIndex {
        get {
            if (!ReferenceEquals(indexedSourceState, sourceDiscovery)) {
                ownershipIndex = OwnedLeaves.ToDictionary(leaf => leaf.PointId, StringComparer.Ordinal);
                indexedSourceState = sourceDiscovery;
            }
            return ownershipIndex;
        }
    }
    private SourceOwnedLeaf ObservedLeaf(SourceOwnedLeaf leaf) => sourceObservedAt.TryGetValue(leaf.PointId, out var seen) && seen > leaf.LastSeen ? leaf with { LastSeen = seen } : leaf;
    internal void FlushSourceObservations()
    {
        if (gatewayStore is not null) { gatewayStore.FlushSourceObservations(); return; }
        lock (gate) {
            if (sourceObservedAt.Count == 0) return;
            PersistSourceState(new(1, sourceDiscovery.Generation + 1, OwnedLeaves.Select(ObservedLeaf).ToArray()), definitionsChanged: false);
        }
    }
    private void RecoverSourceCommit()
    {
        if (gatewayStore is not null) return;
        if (Load("source-config-commit.json") is not JsonObject commit) return;
        if (commit["version"]?.GetValue<int>() != 1 || commit["connections"] is not JsonArray saved || commit["discovery"] is not JsonObject state)
            throw new InvalidDataException("Source configuration recovery manifest is invalid.");
        Persist("connections.json", saved); Persist("source-discovery.json", state);
        if (commit["tags"] is JsonObject model) Persist("tags.json", model);
        File.Delete(Path.Combine(directory, "source-config-commit.json"));
    }
    private void LoadSourceDiscovery()
    {
        if (gatewayStore is not null) return;
        var file = Path.Combine(directory, "source-discovery.json");
        if (!File.Exists(file)) return;
        if (new FileInfo(file).Length > 16 * 1024 * 1024) throw new InvalidDataException("Source ownership storage exceeds its bound.");
        sourceDiscovery = JsonSerializer.Deserialize<SourceDiscoveryState>(File.ReadAllText(file), Json) ?? throw new InvalidDataException("Invalid source ownership storage.");
        if (sourceDiscovery.Version != 1 || sourceDiscovery.Generation < 0 || OwnedLeaves.Length > 20000
            || OwnedLeaves.Select(leaf => leaf.PointId).Distinct(StringComparer.Ordinal).Count() != OwnedLeaves.Length
            || OwnedLeaves.Any(leaf => !SourceConfiguration.TagPathValid(leaf.Path) || !SourceConfiguration.DataTypes.Contains(leaf.DataType)
                || leaf.PointId != SourceConfiguration.PointId(leaf.ConnectionId, leaf.MappingId, leaf.Address, leaf.Selector)))
            throw new InvalidDataException("Source ownership identity/version is inconsistent. Recover its complete configuration generation.");
        foreach (var group in OwnedLeaves.GroupBy(leaf => leaf.ConnectionId))
        {
            var connection = connections.OfType<JsonObject>().SingleOrDefault(item => Optional(item, "id") == group.Key)
                ?? throw new InvalidDataException("Source ownership references a missing connection.");
            var settings = connection["source"]?.Deserialize<SourceSettings>(Json) ?? throw new InvalidDataException("Owned MQTT definitions require source settings.");
            foreach (var leaf in group)
            {
                var mapping = settings.Mqtt?.Mappings?.SingleOrDefault(mapping => mapping.Id == leaf.MappingId);
                if (leaf.MappingRemoved && leaf.Suppressed && mapping is null) {
                    if (leaf.HistoricalRoot is null || !SourceConfiguration.TagPathValid(leaf.HistoricalRoot) || leaf.HistoricalStripLevels is < 0 or > 64
                        || leaf.Path != SourceConfiguration.TopicPath(new(leaf.MappingId, "#", leaf.HistoricalRoot, StripLevels: leaf.HistoricalStripLevels), leaf.Address, leaf.Selector))
                        throw new InvalidDataException("Removed source ownership has an inconsistent historical path schema.");
                    continue;
                }
                if (mapping is null || MappingFingerprint(mapping) != leaf.MappingFingerprint || mapping.Tags != "automatic"
                    || leaf.Path != SourceConfiguration.TopicPath(mapping, leaf.Address, leaf.Selector)
                    || !ShapeMatches(mapping, leaf.Shape) || mapping.DataType is not null && mapping.DataType != leaf.DataType)
                    throw new InvalidDataException("Source mapping/ownership identity, schema or generation mismatch. Restore the matching backup.");
            }
        }
    }
    private void ValidateRestoredSourceOwnership()
    {
        if (gatewayStore is not null || OwnedLeaves.Length == 0) return;
        try {
            ValidateRetention(OwnedLeaves);
            var active = OwnedLeaves.Where(leaf => !leaf.Suppressed && !leaf.Pruned).ToArray();
            if (active.Select(leaf => leaf.Path).Distinct(StringComparer.Ordinal).Count() != active.Length)
                throw new ArgumentException("Restored source paths collide.");
            ValidateOwnedNamespaces(ExpandTagModel(tagModel));
            foreach (var group in OwnedLeaves.GroupBy(leaf => leaf.ConnectionId)) {
                var connection = GetConnection(group.Key, true);
                SourceConfiguration.Validate(connection.Type, connection.Source!);
                foreach (var mapping in connection.Source!.Mqtt?.Mappings?.Where(mapping => mapping.Tags == "automatic") ?? []) {
                    if (active.Count(leaf => leaf.ConnectionId == group.Key && leaf.MappingId == mapping.Id) > mapping.MaximumTags)
                        throw new ArgumentException("Restored source mapping exceeds its leaf cap.");
                    if (OtherSourceRootCollision(group.Key, mapping) || AuthoredNamespaceCollision(mapping.Root, mapping.Root))
                        throw new ArgumentException("Restored source namespace collides.");
                }
            }
        }
        catch (Exception error) when (error is ArgumentException or SourceLimitException) {
            throw new InvalidDataException("Restored source ownership failed preflight before acquisition: " + error.Message, error);
        }
    }
    private static bool ShapeMatches(SourceMqttMapping mapping, string shape) => mapping.Shape == "scalar" ? shape == "scalar" : shape is "object" or "array";
    private static void ValidateRetention(IEnumerable<SourceOwnedLeaf> leaves)
    {
        var retained = leaves.Where(leaf => leaf.Suppressed || leaf.Pruned).ToArray();
        if (retained.Length > 10000 || JsonSerializer.SerializeToUtf8Bytes(retained).Length > 8 * 1024 * 1024)
            throw new SourceLimitException("Source suppression/identity retention exceeds its bounded store.");
    }
    private static string MappingFingerprint(SourceMqttMapping mapping) => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new {
        mapping.Id, mapping.Root, mapping.StripLevels, mapping.Payload, mapping.Script, mapping.TimestampExpression,
        mapping.DataType, mapping.StructuredUpdates, mapping.Shape, mapping.Ordering, mapping.SequenceExpression, mapping.EpochExpression
    })));
    private void PersistSourceState(SourceDiscoveryState next, bool definitionsChanged = true)
    {
        next = next with { Leaves = (next.Leaves ?? []).Select(ObservedLeaf).ToArray() };
        var node = JsonSerializer.SerializeToNode(next, Json)!;
        if (Encoding.UTF8.GetByteCount(node.ToJsonString(Json)) > 16 * 1024 * 1024) throw new SourceLimitException("Source ownership storage exceeds 16 MiB.");
        Persist("source-discovery.json", node); sourceDiscovery = next; sourceObservedAt.Clear(); sourceObservationsFlushed = DateTimeOffset.UtcNow;
        if (definitionsChanged) { expandedTagDefinitions = null; expandedTagIndex = null; tagConfigurationGeneration++; sourcePointCatalogGeneration++; }
    }
    private void CommitSourceConfiguration(JsonArray nextConnections, SourceDiscoveryState nextState)
    {
        nextState = nextState with { Leaves = (nextState.Leaves ?? []).Select(ObservedLeaf).ToArray() };
        var state = JsonSerializer.SerializeToNode(nextState, Json)!;
        Persist("source-config-commit.json", new JsonObject { ["version"] = 1, ["connections"] = nextConnections.DeepClone(), ["discovery"] = state.DeepClone() });
        Persist("connections.json", nextConnections); Persist("source-discovery.json", state);
        connections = nextConnections; sourceDiscovery = nextState; sourceObservedAt.Clear(); sourceObservationsFlushed = DateTimeOffset.UtcNow;
        File.Delete(Path.Combine(directory, "source-config-commit.json"));
        expandedTagDefinitions = null; expandedTagIndex = null; tagConfigurationGeneration++; sourcePointCatalogGeneration++;
    }
    private SourcePoint[] SourceOwnedPoints(string id) => OwnedLeaves.Where(leaf => leaf.ConnectionId == id && !leaf.Suppressed && !leaf.Pruned)
        .Select(leaf => new SourcePoint(leaf.PointId, leaf.Name, leaf.Address, leaf.DataType, leaf.Selector, MappingId: leaf.MappingId, SuggestedPath: leaf.Path)).ToArray();
    private JsonArray SourceOwnedDefinitions()
    {
        var enabled = DefaultTagProviderEnabled();
        return new(OwnedLeaves.Where(leaf => !leaf.Suppressed && !leaf.Pruned).Select(leaf => (JsonNode)new JsonObject {
            ["path"] = leaf.Path, ["kind"] = "device", ["connectionId"] = leaf.ConnectionId, ["nodeId"] = leaf.PointId,
            ["dataType"] = leaf.DataType, ["writable"] = false, ["enabled"] = true, ["effectiveEnabled"] = enabled,
            ["publishingIntervalMs"] = 1000, ["absoluteDeadband"] = 0d, ["queueSize"] = 16u,
            ["sourceOwned"] = true, ["sourceMappingId"] = leaf.MappingId
        }).ToArray());
    }
    private void ValidateOwnedNamespaces(JsonArray authored)
    {
        var paths = authored.OfType<JsonObject>().Select(tag => Required(tag, "path")).ToHashSet(StringComparer.Ordinal);
        var owned = OwnedLeaves.Where(leaf => !leaf.Suppressed && !leaf.Pruned).ToArray();
        if (authored.Count + owned.Length > TagModel.MaximumTags) throw new ArgumentException("Expanded authored/UDT/source definitions exceed 10,000 tags.");
        if (owned.Any(leaf => paths.Contains(leaf.Path))) throw new ArgumentException("An authored tag cannot replace a source-owned definition.");
        foreach (var connection in connections.OfType<JsonObject>().Where(item => Optional(item, "type") == "mqtt"))
        foreach (var mapping in connection["source"]?.Deserialize<SourceSettings>(Json)?.Mqtt?.Mappings ?? [])
            if (mapping.Tags == "automatic" && (paths.Any(path => path == mapping.Root || path.StartsWith(mapping.Root.TrimEnd('/') + "/", StringComparison.Ordinal))
                || authored.OfType<JsonObject>().Any(tag => Optional(tag, "udtInstance") is { } root && (mapping.Root == root || mapping.Root.StartsWith(root.TrimEnd('/') + "/", StringComparison.Ordinal)))))
                throw new ArgumentException("Automatic source namespaces cannot overlap authored tags or UDT instances.");
    }
    public SourceOwnedLeaf[] SourceOwnership(string? id = null)
    {
        if (gatewayStore is not null) return gatewayStore.SourceOwnership(id);
        lock (gate) return OwnedLeaves.Where(leaf => id is null || leaf.ConnectionId == id).Select(ObservedLeaf).ToArray();
    }
    public int ApplySourceDiscovery(string id, IReadOnlyList<SourceDiscoveryItem> items)
    {
        if (gatewayStore is not null) return gatewayStore.ApplySourceDiscovery(id, items);
        lock (gate)
        {
            var connection = GetConnection(id);
            if (connection.Type != "mqtt") throw new ArgumentException("Only MQTT automatic mappings own discovered definitions.");
            var settings = connection.Source!;
            if (items.Count > settings.EffectiveLimits.ScriptResultLeaves) throw new SourceLimitException("Discovery batch exceeds its leaf cap.");
            var index = OwnershipIndex;
            var known = true;
            foreach (var item in items) {
                var mapping = settings.Mqtt?.Mappings?.SingleOrDefault(mapping => mapping.Id == item.MappingId)
                    ?? throw new ArgumentException("The MQTT mapping was removed.");
                if (!mapping.Enabled || mapping.Tags != "automatic") continue;
                var pointId = SourceConfiguration.PointId(id, mapping.Id, item.Address, item.Selector);
                if (!index.TryGetValue(pointId, out var old) || old.Pruned) { known = false; break; }
                if (old.Suppressed) continue;
                if (old.DataType != item.DataType || old.Shape != item.Shape || old.Path != item.SuggestedPath
                    || !ShapeMatches(mapping, item.Shape) || mapping.DataType is not null && mapping.DataType != item.DataType)
                    throw new ArgumentException("The owned source identity/type/shape is locked.");
            }
            if (known) {
                var seen = DateTimeOffset.UtcNow;
                foreach (var item in items) {
                    var pointId = SourceConfiguration.PointId(id, item.MappingId, item.Address, item.Selector);
                    if (index.TryGetValue(pointId, out var old) && !old.Suppressed && settings.Mqtt?.Mappings?.Any(mapping => mapping.Id == item.MappingId && mapping.Enabled && mapping.Tags == "automatic") == true)
                        sourceObservedAt[pointId] = seen;
                }
                if (seen - sourceObservationsFlushed >= TimeSpan.FromSeconds(5)) FlushSourceObservations();
                return 0;
            }
            var next = OwnedLeaves.Select(ObservedLeaf).ToDictionary(leaf => leaf.PointId, StringComparer.Ordinal);
            var knownPaths = GetTagDefinitions().OfType<JsonObject>().ToDictionary(tag => Required(tag, "path"), StringComparer.Ordinal);
            var activeTotal = knownPaths.Count;
            var added = 0;
            foreach (var item in items)
            {
                var mapping = settings.Mqtt?.Mappings?.SingleOrDefault(mapping => mapping.Id == item.MappingId)
                    ?? throw new ArgumentException("The MQTT mapping was removed.");
                if (!mapping.Enabled || mapping.Tags != "automatic") continue;
                if (!ShapeMatches(mapping, item.Shape) || mapping.DataType is not null && mapping.DataType != item.DataType)
                    throw new ArgumentException("Discovery shape/type disagrees with the declared mapping.");
                var path = SourceConfiguration.TopicPath(mapping, item.Address, item.Selector);
                if (path != item.SuggestedPath || !SourceConfiguration.DataTypes.Contains(item.DataType)) throw new ArgumentException("The source discovery identity/path/type is invalid.");
                var pointId = SourceConfiguration.PointId(id, mapping.Id, item.Address, item.Selector);
                if (next.TryGetValue(pointId, out var old))
                {
                    if (old.Suppressed) continue;
                    if (old.DataType != item.DataType || old.Shape != item.Shape) throw new ArgumentException("The owned source type/shape is locked.");
                    if (old.Pruned) {
                        if (knownPaths.ContainsKey(path) || next.Values.Any(leaf => leaf.PointId != pointId && leaf.Path == path && !leaf.Suppressed && !leaf.Pruned))
                            throw new ArgumentException("Rediscovery collides with an existing definition.");
                        activeTotal++; added++;
                    }
                    next[pointId] = old with { Pruned = false, LastSeen = DateTimeOffset.UtcNow };
                    continue;
                }
                if (knownPaths.ContainsKey(path) || next.Values.Any(leaf => leaf.Path == path && !leaf.Suppressed && !leaf.Pruned))
                    throw new ArgumentException("Source display-path collision. Review a distinct path; existing definitions were not changed.");
                if (AuthoredNamespaceCollision(path, mapping.Root) || OtherSourceRootCollision(id, mapping))
                    throw new ArgumentException("The automatic mapping namespace overlaps authored tags, UDTs or another mapping.");
                next[pointId] = new(id, mapping.Id, item.Address, item.Selector, pointId, path, item.Name, item.DataType,
                    item.Shape, MappingFingerprint(mapping), DateTimeOffset.UtcNow);
                activeTotal++; added++;
            }
            if (activeTotal > TagModel.MaximumTags) throw new SourceLimitException("Discovery would exceed 10,000 expanded gateway tags.");
            foreach (var mapping in settings.Mqtt?.Mappings ?? [])
                if (next.Values.Count(leaf => leaf.ConnectionId == id && leaf.MappingId == mapping.Id && !leaf.Suppressed && !leaf.Pruned) > mapping.MaximumTags)
                    throw new SourceLimitException("Discovery would exceed its mapping leaf cap.");
            var candidatePoints = settings.SavedPoints.Where(point => !OwnedLeaves.Any(leaf => leaf.PointId == point.Id)).Concat(next.Values
                .Where(leaf => leaf.ConnectionId == id && !leaf.Suppressed && !leaf.Pruned).Select(leaf => new SourcePoint(leaf.PointId, leaf.Name, leaf.Address, leaf.DataType, leaf.Selector, MappingId: leaf.MappingId))).ToArray();
            SourceConfiguration.Validate(connection.Type, settings with { Points = candidatePoints });
            ValidateRetention(next.Values);
            var nextLeaves = next.Values.OrderBy(leaf => leaf.PointId, StringComparer.Ordinal).ToArray();
            if (added > 0 || nextLeaves.Where(leaf => leaf.LastSeen >= DateTimeOffset.UtcNow.AddSeconds(-2)).Any())
                PersistSourceState(new(1, sourceDiscovery.Generation + 1, nextLeaves), definitionsChanged: added > 0);
            return added;
        }
    }
    private bool AuthoredNamespaceCollision(string path, string root) => (expandedTagDefinitions ?? ExpandTagModel(tagModel)).OfType<JsonObject>()
        .Any(tag => { var candidate = Required(tag, "path"); var instance = Optional(tag, "udtInstance");
            return candidate == path || candidate == root || candidate.StartsWith(root.TrimEnd('/') + "/", StringComparison.Ordinal)
                || instance is not null && (root == instance || root.StartsWith(instance.TrimEnd('/') + "/", StringComparison.Ordinal)); });
    private bool OtherSourceRootCollision(string id, SourceMqttMapping mapping) => connections.OfType<JsonObject>()
        .Where(item => Optional(item, "type") == "mqtt").Any(item => (item["source"]?.Deserialize<SourceSettings>(Json)?.Mqtt?.Mappings ?? []).Any(other =>
            (Optional(item, "id") != id || other.Id != mapping.Id) && other.Tags == "automatic" && (other.Root == mapping.Root
                || other.Root.StartsWith(mapping.Root.TrimEnd('/') + "/", StringComparison.Ordinal) || mapping.Root.StartsWith(other.Root.TrimEnd('/') + "/", StringComparison.Ordinal))));
    private bool DeleteOwnedTag(string path)
    {
        var leaf = OwnedLeaves.SingleOrDefault(leaf => leaf.Path == path && !leaf.Suppressed && !leaf.Pruned);
        if (leaf is null) return false;
        if (SourcePathReferenced(path)) throw new ArgumentException("A saved resource references this source tag. Remove its references before deletion.");
        var next = OwnedLeaves.Select(item => item.PointId == leaf.PointId ? item with { Suppressed = true } : item).ToArray();
        if (next.Count(item => item.Suppressed || item.Pruned) > 10000 || JsonSerializer.SerializeToUtf8Bytes(next.Where(item => item.Suppressed || item.Pruned)).Length > 8 * 1024 * 1024)
            throw new SourceLimitException("Source tombstone cap reached. Clear suppression explicitly before deleting another tag.");
        PersistSourceState(new(1, sourceDiscovery.Generation + 1, next)); return true;
    }
    public void ClearSourceSuppression(string id, string pointId)
    {
        if (gatewayStore is not null) { gatewayStore.ClearSourceSuppression(id, pointId); return; }
        lock (gate)
        {
            var leaf = OwnedLeaves.SingleOrDefault(leaf => leaf.ConnectionId == id && leaf.PointId == pointId && leaf.Suppressed)
                ?? throw new ArgumentException("Choose a suppressed owned point.");
            if (leaf.MappingRemoved) throw new ArgumentException("This mapping was removed. Create a mapping with a new identity to declare a new schema.");
            PersistSourceState(new(1, sourceDiscovery.Generation + 1, OwnedLeaves.Select(item => item == leaf ? item with { Suppressed = false, Pruned = true } : item).ToArray()));
        }
    }
    private bool SourcePathReferenced(string path)
    {
        var expanded = expandedTagDefinitions ?? ExpandTagModel(tagModel);
        if (expanded.OfType<JsonObject>().Any(tag => Optional(tag, "target") == path
            || tag["inputs"] is JsonObject inputs && inputs.Any(input => input.Value?.GetValue<string>() == path))) return true;
        var point = OwnedLeaves.FirstOrDefault(leaf => leaf.Path == path);
        if (point is not null && definitions.OfType<JsonObject>().Any(tag => Optional(tag, "path") != path
            && Optional(tag, "connectionId") == point.ConnectionId && Optional(tag, "nodeId") == point.PointId)) return true;
        if (tagModel["udtDefinitions"]!.ToJsonString().Contains(JsonSerializer.Serialize(path), StringComparison.Ordinal)
            || definitions.OfType<JsonObject>().Any(tag => Optional(tag, "path") != path && tag.ToJsonString().Contains(JsonSerializer.Serialize(path), StringComparison.Ordinal))) return true;
        var projectsDirectory = Path.Combine(directory, "projects");
        if (!Directory.Exists(projectsDirectory)) return false;
        var projects = Directory.EnumerateDirectories(projectsDirectory).Take(1001).ToArray();
        if (projects.Length > 1000) throw new SourceLimitException("Project reference scan exceeds its bound; pruning is blocked.");
        foreach (var projectDirectory in projects)
        {
            if ((File.GetAttributes(projectDirectory) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Project reference scan cannot follow links.");
            foreach (var file in new[] { "project.json", "published.json", "scripts-draft.json", "scripts-published.json" })
            {
                var candidate = Path.Combine(projectDirectory, file);
                if (!File.Exists(candidate)) continue;
                if ((File.GetAttributes(candidate) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Project reference scan cannot follow file links.");
                if (new FileInfo(candidate).Length > 32 * 1024 * 1024) throw new SourceLimitException("Reference resource exceeds bounded scan size.");
                if (SourceResourceReferencesPath(candidate, path)) return true;
            }
        }
        return false;
    }
    private static bool SourceResourceReferencesPath(string file, string path)
    {
        // Resource JSON escapes non-ASCII characters, quotes and authored code.
        // Search decoded string content so those references retain the same
        // deletion/pruning protection as ordinary binding paths.
        var reader = new Utf8JsonReader(File.ReadAllBytes(file));
        while (reader.Read())
            if (reader.TokenType is JsonTokenType.String or JsonTokenType.PropertyName
                && reader.GetString()!.Contains(path, StringComparison.Ordinal)) return true;
        return false;
    }
    internal string[] SourceConnectionOwnedReferences(string id)
    {
        if (gatewayStore is not null) return gatewayStore.SourceConnectionOwnedReferences(id);
        lock (gate) return OwnedLeaves.Where(leaf => leaf.ConnectionId == id && SourcePathReferenced(leaf.Path)).Select(leaf => leaf.Path).Distinct(StringComparer.Ordinal).ToArray();
    }
    public string[] PruneSourceLeaves(string id, bool healthy, DateTimeOffset? healthySince = null)
    {
        if (gatewayStore is not null) return gatewayStore.PruneSourceLeaves(id, healthy, healthySince);
        lock (gate)
        {
            if (!healthy || healthySince is null) return [];
            var current = connections.OfType<JsonObject>().FirstOrDefault(connection => Optional(connection, "id") == id);
            if (current is null || current["enabled"]?.GetValue<bool>() == false) return [];
            var settings = GetConnection(id).Source;
            var changed = new List<string>();
            var next = OwnedLeaves.Select(ObservedLeaf).Select(leaf => {
                var mapping = settings?.Mqtt?.Mappings?.SingleOrDefault(mapping => mapping.Id == leaf.MappingId);
                if (leaf.ConnectionId != id || leaf.Suppressed || leaf.Pruned || mapping?.Enabled != true || mapping.PruneAfterSeconds == 0
                    || healthySince > DateTimeOffset.UtcNow.AddSeconds(-mapping.PruneAfterSeconds)
                    || leaf.LastSeen > DateTimeOffset.UtcNow.AddSeconds(-mapping.PruneAfterSeconds)) return leaf;
                if (SourcePathReferenced(leaf.Path)) { changed.Add(leaf.Path); return leaf; }
                changed.Add(leaf.Path); return leaf with { Pruned = true };
            }).ToArray();
            if (next.Any(leaf => leaf.Pruned != OwnershipIndex[leaf.PointId].Pruned)) { ValidateRetention(next); PersistSourceState(new(1, sourceDiscovery.Generation + 1, next)); }
            else if (DateTimeOffset.UtcNow - sourceObservationsFlushed >= TimeSpan.FromSeconds(5)) FlushSourceObservations();
            return changed.ToArray();
        }
    }
}
