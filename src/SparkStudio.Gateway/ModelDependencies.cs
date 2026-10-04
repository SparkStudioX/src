using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

public sealed record ModelDependencyNode(string Id, string Kind, string Label, string? Path = null);
public sealed record ModelDependencyEdge(string From, string To, string Relation);
public sealed record ModelDependencyIssue(string Kind, string Id, string Message);
public sealed record ModelDependencyResult(ModelDependencyNode[] Nodes, ModelDependencyEdge[] Edges, ModelDependencyIssue[] Issues, bool Truncated);
public sealed record ModelDependencyDocument(string Id, string Name, string Kind, JsonNode Content, string ProjectId);

public static class ModelDependencies
{
    private static readonly Regex EmbeddedPath = new(@"\[default\][^\s\""'{}<>;,()]+", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    public static IEnumerable<string> Strings(JsonNode? node)
    {
        if (node is JsonValue scalar && scalar.TryGetValue<string>(out var text)) { yield return text; yield break; }
        if (node is JsonObject value) { foreach (var pair in value) foreach (var item in Strings(pair.Value)) yield return item; }
        else if (node is JsonArray array) foreach (var child in array) foreach (var item in Strings(child)) yield return item;
    }
    public static IEnumerable<string> TagInputs(JsonObject tag)
    {
        if (tag["target"] is JsonValue target && target.TryGetValue<string>(out var path)) yield return path;
        if (tag["inputs"] is JsonObject inputs) foreach (var pair in inputs) if (pair.Value is JsonValue scalar && scalar.TryGetValue<string>(out var input)) yield return input;
    }
    public static ModelDependencyDocument[] Documents(ProjectCatalog catalog, Func<string, bool> allowed)
    {
        var result = new List<ModelDependencyDocument>();
        foreach (var projectId in catalog.ActiveIds().Where(allowed))
        {
            var workspace = catalog.Get(projectId); AddProject(workspace.Store.GetProject(), projectId, "draft", result);
            AddResources(workspace.Scripts.GetDraft()["resources"] as JsonArray, projectId, "script", result);
            AddResources(workspace.Store.GetQueries(), projectId, "query", result);
            if (workspace.Publication.Metadata()["published"]?.GetValue<bool>() == true) AddProject(workspace.Publication.GetProject(), projectId, "published", result);
        }
        return result.ToArray();
    }
    private static void AddProject(JsonObject project, string projectId, string scope, List<ModelDependencyDocument> result)
    {
        foreach (var collection in new[] { "screens", "templates" })
            foreach (var document in ModelMappingProfiles.Objects(project, collection))
                result.Add(new($"{scope}:{projectId}/{ModelMappingProfiles.Text(document, "id")}", ModelMappingProfiles.Text(document, "name"), collection == "screens" ? "screen" : "template", document, projectId));
    }
    private static void AddResources(JsonArray? resources, string projectId, string kind, List<ModelDependencyDocument> result)
    {
        foreach (var resource in resources?.OfType<JsonObject>() ?? [])
            result.Add(new($"{kind}:{projectId}/{ModelMappingProfiles.Text(resource, "id")}", ModelMappingProfiles.Text(resource, "name"), kind, resource, projectId));
    }
    public static ModelDependencyResult Build(JsonObject model, JsonArray expanded, JsonArray connections, ModelDependencyDocument[] documents, string? type = null, string? instance = null, string? query = null)
    {
        var nodes = new Dictionary<string, ModelDependencyNode>(StringComparer.Ordinal); var edges = new HashSet<ModelDependencyEdge>();
        var issues = new List<ModelDependencyIssue>();
        void Add(string kind, string id, string? label = null) => nodes.TryAdd(kind + ":" + id, new(kind + ":" + id, kind, label ?? id, id.StartsWith("[default]", StringComparison.Ordinal) ? id : null));
        foreach (var connection in connections.OfType<JsonObject>()) Add("connection", ModelMappingProfiles.Text(connection, "id"), ModelMappingProfiles.Text(connection, "name"));
        AddTypes(model, Add, edges);
        foreach (var tag in expanded.OfType<JsonObject>()) AddTag(tag, Add, edges);
        foreach (var document in documents) AddDocument(document, nodes, Add, edges);
        foreach (var edge in edges.Where(edge => !nodes.ContainsKey(edge.From))) issues.Add(new("missing-source", edge.To, $"Missing dependency {edge.From}."));
        foreach (var node in nodes.Values.Where(node => node.Kind is "connection" or "type"))
            if (!edges.Any(edge => edge.From == node.Id)) issues.Add(new("unused-" + node.Kind, node.Id, $"{node.Label} has no detected consumers."));
        var filtered = Filter(nodes.Values, edges, type, instance, query); var selected = filtered.Take(2000).ToArray(); var ids = selected.Select(node => node.Id).ToHashSet(StringComparer.Ordinal);
        var selectedEdges = edges.Where(edge => ids.Contains(edge.From) && ids.Contains(edge.To)).ToArray();
        return new(selected, selectedEdges.Take(10000).ToArray(), issues.Where(issue => ids.Contains(issue.Id)).ToArray(), filtered.Length > selected.Length || selectedEdges.Length > 10000);
    }
    private static void AddTypes(JsonObject model, Action<string, string, string?> add, HashSet<ModelDependencyEdge> edges)
    {
        foreach (var definition in ModelMappingProfiles.Objects(model, "udtDefinitions"))
        {
            var key = TagModel.DefinitionKey(definition); add("type", key, key);
            foreach (var nested in ModelMappingProfiles.Objects(definition, "members").Where(member => ModelMappingProfiles.Text(member, "kind") == "type"))
                edges.Add(new("type:" + ModelMappingProfiles.Text(nested, "definitionId") + "@" + TagModel.Version(nested), "type:" + key, "composed by"));
        }
        foreach (var profile in ModelMappingProfiles.Objects(model, "mappingProfiles")) add("mapping", ModelMappingProfiles.Text(profile, "id"), null);
        foreach (var equipment in ModelMappingProfiles.Objects(model, "instances"))
        {
            var path = ModelMappingProfiles.Text(equipment, "path"); add("instance", path, null);
            edges.Add(new("type:" + ModelMappingProfiles.Text(equipment, "definitionId") + "@" + TagModel.Version(equipment), "instance:" + path, "defines"));
            if (equipment["mappingProfileId"] is not null) edges.Add(new("mapping:" + ModelMappingProfiles.Text(equipment, "mappingProfileId"), "instance:" + path, "maps sources"));
        }
    }
    private static void AddTag(JsonObject tag, Action<string, string, string?> add, HashSet<ModelDependencyEdge> edges)
    {
        var path = ModelMappingProfiles.Text(tag, "path"); add("tag", path, null);
        if (tag["udtInstance"] is not null) edges.Add(new("instance:" + ModelMappingProfiles.Text(tag, "udtInstance"), "tag:" + path, "contains"));
        foreach (var input in TagInputs(tag)) edges.Add(new("tag:" + input, "tag:" + path, "supplies"));
        if (tag["connectionId"] is null) return;
        var connection = ModelMappingProfiles.Text(tag, "connectionId"); var point = connection + "/" + ModelMappingProfiles.Text(tag, "nodeId");
        add("point", point, ModelMappingProfiles.Text(tag, "nodeId"));
        edges.Add(new("connection:" + connection, "point:" + point, "exposes")); edges.Add(new("point:" + point, "tag:" + path, "acquires"));
    }
    private static void AddDocument(ModelDependencyDocument document, Dictionary<string, ModelDependencyNode> nodes, Action<string, string, string?> add, HashSet<ModelDependencyEdge> edges)
    {
        add(document.Kind, document.Id, document.Name);
        foreach (var text in Strings(document.Content).Distinct(StringComparer.Ordinal))
        {
            var candidates = text.StartsWith("[default]", StringComparison.Ordinal) ? new[] { text }.Concat(EmbeddedPath.Matches(text).Select(match => match.Value)) : EmbeddedPath.Matches(text).Select(match => match.Value);
            foreach (var path in candidates.Distinct(StringComparer.Ordinal))
            {
                var kind = nodes.ContainsKey("instance:" + path) ? "instance" : "tag";
                edges.Add(new(kind + ":" + path, document.Kind + ":" + document.Id, "referenced by"));
            }
        }
        if (document.Content is JsonObject resource && resource["connectionId"] is not null)
            edges.Add(new("connection:" + ModelMappingProfiles.Text(resource, "connectionId"), document.Kind + ":" + document.Id, "queried by"));
    }
    private static ModelDependencyNode[] Filter(IEnumerable<ModelDependencyNode> nodes, HashSet<ModelDependencyEdge> edges, string? type, string? instance, string? query)
    {
        var all = nodes.OrderBy(node => node.Kind).ThenBy(node => node.Label, StringComparer.Ordinal).ToArray();
        if (string.IsNullOrEmpty(type) && string.IsNullOrEmpty(instance) && string.IsNullOrEmpty(query)) return all;
        var scoped = !string.IsNullOrEmpty(type) || !string.IsNullOrEmpty(instance);
        var selected = all.Where(node => !string.IsNullOrEmpty(instance) ? node.Id == "instance:" + instance
            : !string.IsNullOrEmpty(type) ? node.Id == "type:" + type || node.Id.StartsWith("type:" + type + "@", StringComparison.Ordinal)
            : node.Label.Contains(query!, StringComparison.OrdinalIgnoreCase)).Select(node => node.Id).ToHashSet(StringComparer.Ordinal);
        if (!string.IsNullOrEmpty(type) && !string.IsNullOrEmpty(instance) && !edges.Any(edge => edge.To == "instance:" + instance && edge.Relation == "defines"
            && (edge.From == "type:" + type || edge.From.StartsWith("type:" + type + "@", StringComparison.Ordinal)))) return [];
        var neighbors = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var edge in edges)
        {
            if (!neighbors.TryGetValue(edge.From, out var from)) neighbors[edge.From] = from = new(StringComparer.Ordinal);
            if (!neighbors.TryGetValue(edge.To, out var to)) neighbors[edge.To] = to = new(StringComparer.Ordinal);
            from.Add(edge.To); to.Add(edge.From);
        }
        var pending = new Queue<string>(selected);
        while (pending.TryDequeue(out var current))
            if (neighbors.TryGetValue(current, out var adjacent)) foreach (var neighbor in adjacent) if (selected.Add(neighbor)) pending.Enqueue(neighbor);
        return all.Where(node => selected.Contains(node.Id) && (!scoped || string.IsNullOrEmpty(query) || node.Label.Contains(query, StringComparison.OrdinalIgnoreCase))).ToArray();
    }
}
