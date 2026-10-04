using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Immutable configuration-generation view. Runtime values are read from TagEngine, never cached here.</summary>
public sealed class ModelReadIndex
{
    private readonly JsonObject[] definitions;
    private readonly JsonObject[] instances;
    private readonly JsonObject[] hierarchy;
    private readonly JsonObject[] leaves;
    private readonly Dictionary<string, JsonObject> typeByKey;
    private readonly Dictionary<string, JsonObject[]> instanceLeaves;
    private readonly Dictionary<string, JsonObject> instanceByPath;
    private readonly Dictionary<string, JsonObject> leafByPath;
    private readonly JsonObject[] treeNodes;
    private readonly HashSet<string> declaredTreePaths;
    public long Generation { get; }

    public ModelReadIndex(long generation, JsonObject model, JsonArray expanded)
    {
        Generation = generation;
        definitions = Objects(TagModelWire.Package(model), "udtDefinitions");
        instances = Objects(model, "instances");
        hierarchy = Objects(model, "hierarchy");
        leaves = expanded.OfType<JsonObject>().Select(LeafMetadata).ToArray();
        typeByKey = definitions.ToDictionary(TagModel.DefinitionKey, StringComparer.Ordinal);
        instanceLeaves = leaves.Where(leaf => leaf["udtInstance"] is not null)
            .GroupBy(leaf => Text(leaf, "udtInstance"), StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.ToArray(), StringComparer.Ordinal);
        instanceByPath = instances.ToDictionary(item => Text(item, "path"), StringComparer.Ordinal);
        leafByPath = leaves.ToDictionary(item => Text(item, "path"), StringComparer.Ordinal);
        declaredTreePaths = new(StringComparer.Ordinal);
        foreach (var item in hierarchy) AddVisiblePaths(declaredTreePaths, Text(item, "path"));
        treeNodes = BuildTreeNodes();
    }

    public JsonObject Types(Func<string, bool> canRead, bool includeUnused, string? type, int offset, int limit, bool includeConfiguration = false)
    {
        var visible = includeUnused ? new Dictionary<string, HashSet<string>>(StringComparer.Ordinal) : VisibleTypeMembers(canRead);
        var items = definitions.Where(definition => string.IsNullOrEmpty(type) || Text(definition, "id") == type)
            .Where(definition => includeUnused || visible.ContainsKey(TagModel.DefinitionKey(definition)))
            .OrderBy(definition => Text(definition, "id"), StringComparer.Ordinal).ThenBy(TagModel.Version)
            .Select(definition => ProjectType(definition, includeUnused ? null : visible[TagModel.DefinitionKey(definition)], includeConfiguration));
        return Page(items, offset, limit);
    }

    public JsonObject Instances(Func<string, bool> canRead, string? type, int? version, string? under, int offset, int limit, bool includeConfiguration = false)
    {
        var root = Root(under);
        var items = instances.Where(instance => string.IsNullOrEmpty(type) || Text(instance, "definitionId") == type)
            .Where(instance => version is null || TagModel.Version(instance) == version)
            .Where(instance => Under(Text(instance, "path"), root))
            .Where(instance => Members(instance).Any(member => canRead(Text(member, "path"))))
            .OrderBy(instance => Text(instance, "path"), StringComparer.Ordinal)
            .Select(instance => InstanceSummary(instance, canRead, includeConfiguration));
        return Page(items, offset, limit);
    }

    public JsonObject Tree(Func<string, bool> canRead, bool includeEmpty, IReadOnlyDictionary<string, TagValue> values,
        string? path, int depth, int offset, int limit, bool includeConfiguration = false) =>
        PrepareTree(canRead, includeEmpty, path, depth, offset, limit, includeConfiguration).Render(values);

    public ModelReadPlan PrepareTree(Func<string, bool> canRead, bool includeEmpty, string? path, int depth, int offset, int limit, bool includeConfiguration = false)
    {
        if (depth is < 1 or > 8) throw new ArgumentException("Model tree depth must be from 1 through 8.");
        ValidatePage(offset, limit);
        var root = Root(path);
        var rootDepth = Segments(root);
        var readable = leaves.Where(leaf => canRead(Text(leaf, "path"))).Select(leaf => Text(leaf, "path")).ToHashSet(StringComparer.Ordinal);
        var visible = includeEmpty ? new HashSet<string>(declaredTreePaths, StringComparer.Ordinal) : new HashSet<string>(StringComparer.Ordinal);
        foreach (var leaf in readable) AddVisiblePaths(visible, leaf);
        var candidates = treeNodes.Where(node => visible.Contains(Text(node, "path")) && Text(node, "path") != root && Under(Text(node, "path"), root))
            .Where(node => Segments(Text(node, "path")) - rootDepth <= depth).ToArray();
        var selected = candidates.Skip(offset).Take(limit).ToArray();
        var paths = selected.Where(node => Text(node, "kind") == "member" && readable.Contains(Text(node, "path"))).Select(node => Text(node, "path")).ToArray();
        return new(paths, values => PageResult(selected.Select(node => RenderTreeNode(node, readable.Contains, includeConfiguration, values)), candidates.Length, offset, limit));
    }

    public JsonObject ReadObject(string path, Func<string, bool> canRead, IReadOnlyDictionary<string, TagValue> values, bool includeConfiguration = false) =>
        PrepareObject(path, canRead, includeConfiguration).Render(values);

    public ModelReadPlan PrepareObject(string path, Func<string, bool> canRead, bool includeConfiguration = false)
    {
        TagDefinitionValidator.Path(path);
        var instance = instanceByPath.GetValueOrDefault(path);
        if (instance is null || !Members(instance).Any(member => canRead(Text(member, "path"))))
            throw new KeyNotFoundException("Model instance not found.");
        var readable = Members(instance).Where(member => canRead(Text(member, "path"))).ToArray();
        var paths = readable.Select(member => Text(member, "path")).ToArray();
        var summary = InstanceSummary(instance, paths.ToHashSet(StringComparer.Ordinal).Contains, includeConfiguration);
        return new(paths, values => ObjectResult(summary, readable, values));
    }

    public ModelReadPlan PrepareIssues(Func<string, bool> canRead, string? path, int offset, int limit, bool includeConfiguration = false)
    {
        ValidatePage(offset, limit);
        var root = Root(path);
        var selected = leaves.Where(leaf => leaf["udtInstance"] is not null && Under(Text(leaf, "path"), root) && canRead(Text(leaf, "path")))
            .OrderBy(leaf => Text(leaf, "path"), StringComparer.Ordinal).ToArray();
        return new(selected.Select(leaf => Text(leaf, "path")).ToArray(), values => Page(selected.SelectMany(leaf => IssueRows(leaf, values.GetValueOrDefault(Text(leaf, "path")), includeConfiguration)), offset, limit));
    }

    private static IEnumerable<JsonObject> IssueRows(JsonObject leaf, TagValue? value, bool includeConfiguration)
    {
        var issues = value?.ModelIssues ?? [];
        var sourceQuality = value?.SourceQuality ?? value?.Quality ?? "Bad_WaitingForInitialData";
        if (!sourceQuality.StartsWith("Good", StringComparison.OrdinalIgnoreCase))
            issues = [.. issues, new ModelFieldIssue("sourceQuality", "The source is not supplying a good-quality value: " + sourceQuality + ".", "Good source quality")];
        foreach (var issue in issues)
        {
            var row = new JsonObject { ["path"] = leaf["path"]!.DeepClone(), ["instancePath"] = leaf["udtInstance"]?.DeepClone(),
                ["modelPath"] = leaf["modelPath"]?.DeepClone(), ["code"] = issue.Code, ["message"] = issue.Message, ["expected"] = issue.Expected,
                ["quality"] = value?.Quality ?? "Bad_WaitingForInitialData", ["sourceQuality"] = sourceQuality,
                ["value"] = TagModelWire.Value(value?.DataType, System.Text.Json.JsonSerializer.SerializeToNode(value?.Value, ProjectStore.Json)), ["receiptTimestamp"] = value?.ReceiptTimestamp };
            if (includeConfiguration && leaf["target"] is not null) row["target"] = leaf["target"]!.DeepClone();
            yield return row;
        }
    }

    private JsonObject ObjectResult(JsonObject summary, JsonObject[] readable, IReadOnlyDictionary<string, TagValue> values)
    {
        var result = Copy(summary); result["generation"] = Generation;
        var members = new JsonObject();
        foreach (var leaf in readable)
        {
            var relative = Text(leaf, "modelPath");
            if (relative.Length == 0) relative = Text(leaf, "udtMember");
            AddMember(members, relative, RuntimeLeaf(leaf, values));
        }
        result["members"] = members;
        return result;
    }

    private JsonObject[] BuildTreeNodes()
    {
        var nodes = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var leaf in leaves)
        {
            var path = Text(leaf, "path");
            AddParents(nodes, path);
            var node = new JsonObject { ["path"] = path };
            node["name"] = Name(path); node["kind"] = "member"; node["sourceKind"] = leaf["kind"]?.DeepClone();
            foreach (var field in new[] { "unit", "description" })
                if (leaf[field] is not null) node[field] = leaf[field]!.DeepClone();
            nodes[path] = node;
        }
        foreach (var instance in instances)
        {
            var path = Text(instance, "path");
            AddParents(nodes, path);
            var node = new JsonObject { ["path"] = path, ["name"] = Name(path), ["kind"] = "instance" };
            nodes[path] = node;
        }
        foreach (var item in hierarchy)
        {
            var path = Text(item, "path");
            AddParents(nodes, path);
            if (nodes.TryGetValue(path, out var existing) && Text(existing, "kind") is "instance" or "member")
            {
                existing["level"] = item["level"]!.DeepClone();
                existing["hierarchy"] = Copy(item);
                continue;
            }
            var node = Copy(item); node["name"] = Name(path); node["kind"] = "hierarchy";
            nodes[path] = node;
        }
        return nodes.Values.OrderBy(node => Text(node, "path"), StringComparer.Ordinal).ToArray();
    }

    private JsonObject RenderTreeNode(JsonObject node, Func<string, bool> canRead, bool includeConfiguration, IReadOnlyDictionary<string, TagValue> values)
    {
        var path = Text(node, "path");
        if (Text(node, "kind") == "member" && !canRead(path)
            || Text(node, "kind") == "instance" && !Members(instanceByPath[path]).Any(leaf => canRead(Text(leaf, "path"))))
            return new JsonObject { ["path"] = path, ["name"] = Name(path), ["kind"] = "folder" };
        var result = Text(node, "kind") switch
        {
            "instance" => InstanceSummary(instanceByPath[path], canRead, includeConfiguration),
            "member" => RuntimeLeaf(leafByPath[path], values),
            _ => new JsonObject()
        };
        foreach (var field in node) result[field.Key] = field.Value?.DeepClone();
        return result;
    }

    private JsonObject InstanceSummary(JsonObject instance, Func<string, bool> canRead, bool includeConfiguration)
    {
        var type = typeByKey[Text(instance, "definitionId") + "@" + TagModel.Version(instance)];
        var restricted = Members(instance).Count(leaf => !canRead(Text(leaf, "path")));
        return new JsonObject
        {
            ["path"] = instance["path"]!.DeepClone(), ["definitionId"] = instance["definitionId"]!.DeepClone(),
            ["version"] = instance["version"]!.DeepClone(),
            ["parameters"] = !includeConfiguration || restricted > 0 ? new JsonObject() : TagModelWire.Parameters(type, TagModelParameters.Bind(type, instance["parameters"] as JsonObject).Values),
            ["parameterValuesRestricted"] = !includeConfiguration || restricted > 0,
            ["enabled"] = instance["enabled"]?.DeepClone() ?? JsonValue.Create(true), ["metadata"] = Metadata(type),
            ["restrictedMembers"] = restricted
        };
    }

    private Dictionary<string, HashSet<string>> VisibleTypeMembers(Func<string, bool> canRead)
    {
        var result = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var instance in instances)
        {
            var key = Text(instance, "definitionId") + "@" + TagModel.Version(instance);
            foreach (var leaf in Members(instance).Where(leaf => canRead(Text(leaf, "path"))))
            {
                var relative = Text(leaf, "modelPath");
                if (relative.Length == 0) relative = Text(leaf, "udtMember");
                AddVisibleMember(result, key, relative, 0);
            }
        }
        return result;
    }

    private void AddVisibleMember(Dictionary<string, HashSet<string>> visible, string key, string path, int depth)
    {
        if (depth >= 4 || !typeByKey.TryGetValue(key, out var definition)) return;
        if (!visible.TryGetValue(key, out var members)) visible[key] = members = new(StringComparer.Ordinal);
        members.Add(path);
        foreach (var member in definition["members"]!.AsArray().OfType<JsonObject>().Where(item => Text(item, "kind") == "type"))
        {
            var prefix = Text(member, "path") + "/";
            if (path.StartsWith(prefix, StringComparison.Ordinal))
                AddVisibleMember(visible, Text(member, "definitionId") + "@" + TagModel.Version(member), path[prefix.Length..], depth + 1);
        }
    }

    private static JsonObject ProjectType(JsonObject definition, HashSet<string>? visible, bool includeConfiguration)
    {
        var result = includeConfiguration ? Copy(definition) : LogicalFields(definition, "id", "version");
        var members = definition["members"]!.AsArray().OfType<JsonObject>().ToArray();
        var shown = members.Where(member => visible is null || visible.Any(path => path == Text(member, "path") || path.StartsWith(Text(member, "path") + "/", StringComparison.Ordinal))).ToArray();
        result["members"] = new JsonArray(shown.Select(member => (JsonNode)ProjectMember(member, includeConfiguration)).ToArray());
        if (!includeConfiguration)
            result["parameters"] = new JsonArray((definition["parameters"] as JsonArray ?? []).OfType<JsonObject>()
                .Select(parameter => (JsonNode)LogicalFields(parameter, "name", "type", "required")).ToArray());
        result["parameterValuesRestricted"] = !includeConfiguration;
        result["restrictedMembers"] = members.Length - shown.Length;
        return result;
    }

    private static JsonObject ProjectMember(JsonObject member, bool includeConfiguration)
    {
        // An allowlist keeps future acquisition/configuration fields private by default.
        return includeConfiguration ? Copy(member) : LogicalFields(member, "path", "kind", "dataType", "definitionId", "version");
    }

    private static JsonObject LogicalFields(JsonObject value, params string[] fields)
    {
        var result = Metadata(value);
        foreach (var field in fields) if (value[field] is not null) result[field] = value[field]!.DeepClone();
        return result;
    }

    private JsonObject[] Members(JsonObject instance) => instanceLeaves.GetValueOrDefault(Text(instance, "path")) ?? [];

    private JsonObject Page(IEnumerable<JsonObject> source, int offset, int limit)
    {
        ValidatePage(offset, limit);
        var items = source.ToArray();
        return PageResult(items.Skip(offset).Take(limit), items.Length, offset, limit);
    }

    private JsonObject PageResult(IEnumerable<JsonObject> items, int total, int offset, int limit)
    {
        var page = items.Select(item => (JsonNode)Copy(item)).ToArray();
        return new JsonObject { ["generation"] = Generation, ["items"] = new JsonArray(page), ["total"] = total,
            ["offset"] = offset, ["limit"] = limit, ["nextOffset"] = offset < total - page.Length ? JsonValue.Create(offset + page.Length) : null };
    }

    private static void ValidatePage(int offset, int limit)
    {
        if (offset < 0 || limit is < 1 or > 200) throw new ArgumentException("Model pages require offset >= 0 and limit from 1 through 200.");
    }

    private static JsonObject RuntimeLeaf(JsonObject leaf, IReadOnlyDictionary<string, TagValue> values)
    {
        var path = Text(leaf, "path"); var value = values.GetValueOrDefault(path);
        var dataType = leaf["dataType"]?.GetValue<string>() ?? value?.DataType ?? "Unknown";
        return new JsonObject
        {
            ["path"] = path, ["modelPath"] = leaf["modelPath"]?.DeepClone(), ["dataType"] = dataType,
            ["kind"] = leaf["kind"]?.DeepClone(), ["value"] = TagModelWire.Value(dataType, System.Text.Json.JsonSerializer.SerializeToNode(value?.Value, ProjectStore.Json)),
            ["quality"] = value?.Quality ?? "Bad_WaitingForInitialData", ["timestamp"] = value?.Timestamp,
            ["sourceQuality"] = value?.SourceQuality ?? value?.Quality ?? "Bad_WaitingForInitialData",
            ["modelIssues"] = System.Text.Json.JsonSerializer.SerializeToNode(value?.ModelIssues ?? [], ProjectStore.Json),
            ["sourceTimestamp"] = value?.SourceTimestamp, ["receiptTimestamp"] = value?.ReceiptTimestamp,
            ["metadata"] = Metadata(leaf), ["writable"] = value?.Writable == true
        };
    }

    private static void AddMember(JsonObject root, string path, JsonObject leaf)
    {
        var parts = path.Split('/'); var parent = root;
        foreach (var part in parts[..^1])
        {
            if (parent[part] is not JsonObject next) { next = new JsonObject(); parent[part] = next; }
            parent = next;
        }
        parent[parts[^1]] = leaf;
    }

    private static void AddParents(Dictionary<string, JsonObject> nodes, string path)
    {
        var end = path.LastIndexOf('/');
        while (end > "[default]".Length)
        {
            var parent = path[..end];
            nodes.TryAdd(parent, new JsonObject { ["path"] = parent, ["name"] = Name(parent), ["kind"] = "folder" });
            end = parent.LastIndexOf('/');
        }
    }

    private static void AddVisiblePaths(HashSet<string> paths, string path)
    {
        paths.Add(path);
        var end = path.LastIndexOf('/');
        while (end > "[default]".Length) { paths.Add(path[..end]); end = path.LastIndexOf('/', end - 1); }
    }

    public static JsonObject Metadata(JsonObject value)
    {
        var result = new JsonObject();
        foreach (var field in TagModelMetadata.Fields.Where(field => field != "alarms"))
            if (value[field] is not null) result[field] = value[field]!.DeepClone();
        return result;
    }

    private static JsonObject LeafMetadata(JsonObject value)
    {
        var result = Metadata(value);
        foreach (var field in new[] { "path", "kind", "dataType", "modelPath", "udtInstance", "udtDefinition", "udtVersion", "udtMember", "target" })
            if (value[field] is not null) result[field] = value[field]!.DeepClone();
        return result;
    }

    private static JsonObject[] Objects(JsonObject model, string field) => (model[field] as JsonArray)?.OfType<JsonObject>().Select(Copy).ToArray() ?? [];
    private static JsonObject Copy(JsonObject value) => (JsonObject)value.DeepClone();
    private static string Text(JsonObject value, string field) => value[field]?.GetValue<string>() ?? "";
    private static string Name(string path) => path[(Math.Max(path.LastIndexOf('/'), path.IndexOf(']')) + 1)..];
    private static int Segments(string path) => path == "[default]" ? 0 : path.Count(character => character == '/') + 1;
    private static bool Under(string path, string root) => root == "[default]" ? path.StartsWith(root, StringComparison.Ordinal) : path == root || path.StartsWith(root + "/", StringComparison.Ordinal);
    private static string Root(string? path) => string.IsNullOrEmpty(path) || path == "[default]" ? "[default]" : TagDefinitionValidator.Path(path);
}

public sealed record ModelReadPlan(IReadOnlyList<string> Paths, Func<IReadOnlyDictionary<string, TagValue>, JsonObject> Render);

public sealed partial class ProjectStore
{
    private ModelReadIndex? modelReadIndex;
    private readonly object modelIndexGate = new();

    public ModelReadIndex GetModelReadIndex()
    {
        if (gatewayStore is not null) return gatewayStore.GetModelReadIndex();
        // Ordinary readers share one build instead of cloning the same large
        // configuration repeatedly while another reader constructs the index.
        lock (modelIndexGate) return CaptureModelReadIndex()();
    }

    // Capture configuration under the caller's normal state -> configuration lock
    // order, then invoke the returned builder only after releasing both locks.
    // The immutable capture remains valid even if a newer generation commits while
    // its topology is being built; chasing the latest generation can starve reads.
    internal Func<ModelReadIndex> CaptureModelReadIndex()
    {
        if (gatewayStore is not null) return gatewayStore.CaptureModelReadIndex();
        lock (gate)
        {
            var cached = modelReadIndex;
            if (cached is not null && cached.Generation == tagConfigurationGeneration) return () => cached;
            var generation = tagConfigurationGeneration;
            var model = (JsonObject)tagModel.DeepClone(); var expanded = GetTagDefinitions();
            return () => BuildModelReadIndex(generation, model, expanded);
        }
    }

    private ModelReadIndex BuildModelReadIndex(long generation, JsonObject model, JsonArray expanded)
    {
        lock (modelIndexGate)
        {
            lock (gate)
                if (modelReadIndex is not null && modelReadIndex.Generation == generation) return modelReadIndex;
            var next = new ModelReadIndex(generation, model, expanded);
            lock (gate)
                if (generation == tagConfigurationGeneration) modelReadIndex = next;
            return next;
        }
    }
}
