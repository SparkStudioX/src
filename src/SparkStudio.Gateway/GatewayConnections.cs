using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

/// <summary>Administrator observations. Dependency lists are advisory snapshots, not deletion locks.</summary>
public static class GatewayConnections
{
    public static void MapGatewayConnectionEndpoints(this RouteGroupBuilder routes)
    {
        routes.MapPost("/connections/{id}/test", async (string id, ProjectStore store, ConnectorService connector, CancellationToken cancellation) =>
        {
            var capture = store.BeginConnectionTest(id);
            var timer = Stopwatch.StartNew();
            var result = await connector.TestAsync(capture.Connection, cancellation);
            return store.CompleteConnectionTest(capture, result.Success, timer.Elapsed.TotalMilliseconds, result.Message);
        }).Access("admin", audit: true);
        routes.MapGet("/connections/{id}/diagnostics", (string id, ProjectCatalog catalog, TagEngine tags) => Snapshot(id, catalog, tags)).Access("admin");
    }

    public static object Snapshot(string id, ProjectCatalog catalog, TagEngine tags)
    {
        var connection = catalog.GatewayStore.GetConnections().OfType<JsonObject>().FirstOrDefault(item => ProjectStore.Optional(item, "id") == id)
            ?? throw new KeyNotFoundException("Connection not found.");
        var dependencies = new List<ConnectionDependency>();
        var definitions = catalog.GatewayStore.GetTagDefinitions().OfType<JsonObject>()
            .Where(item => ProjectStore.Optional(item, "connectionId") == id).ToArray();
        dependencies.AddRange(definitions.Select(item => new ConnectionDependency("tag", null, null, ProjectStore.Required(item, "path"), ProjectStore.Required(item, "path"))));
        foreach (var project in catalog.List(includeArchived: true).OfType<JsonObject>())
        {
            var projectId = ProjectStore.Required(project, "id");
            var workspace = catalog.Get(projectId, includeArchived: true);
            void Add(IEnumerable<JsonObject> queries, string scope) => dependencies.AddRange(queries
                .Where(query => ProjectStore.Optional(query, "connectionId") == id)
                .Select(query => new ConnectionDependency(scope, projectId, ProjectStore.Required(project, "name"), ProjectStore.Required(query, "id"), ProjectStore.Required(query, "name"))));
            Add(workspace.Store.GetQueries().OfType<JsonObject>(), "draft query");
            Add(workspace.Publication.ConnectionQueryReferences().OfType<JsonObject>(), "published query");
        }
        var paths = definitions.Select(item => ProjectStore.Required(item, "path")).ToHashSet(StringComparer.Ordinal);
        var values = tags.Read(paths.Take(100), null).Select(value => new
        {
            value.Path, value.Quality, value.DataType, value.Timestamp,
            displayValue = DisplayValue(value.Value)
        }).ToArray();
        var subscriptions = JsonSerializer.SerializeToNode(tags.SubscriptionSnapshot())!.AsArray().OfType<JsonObject>()
            .Where(item => ProjectStore.Optional(item, "connectionId") == id).Select(item => item.DeepClone()).ToArray();
        return new
        {
            capturedAt = DateTimeOffset.UtcNow, revision = connection["revision"]!.GetValue<int>(), enabled = connection["enabled"]!.GetValue<bool>(),
            dependencies = dependencies.Take(500).ToArray(), dependencyCount = dependencies.Count, omittedDependencies = Math.Max(0, dependencies.Count - 500),
            values, omittedValues = Math.Max(0, paths.Count - 100), subscriptions,
            note = "Dependencies are an observation across gateway tags and current draft and published named queries, including archived projects. Scripts may also resolve connections dynamically. Deletion is not available."
        };
    }

    private static string DisplayValue(object? value)
    {
        var text = value is null ? "null" : value is string stringValue ? stringValue : JsonSerializer.Serialize(value);
        return text.Length > 512 ? text[..512] + "…" : text;
    }
}

public sealed record ConnectionDependency(string Scope, string? ProjectId, string? ProjectName, string Id, string Name);

public sealed partial class PublicationStore
{
    internal JsonArray ConnectionQueryReferences()
    {
        lock (gate)
        {
            var queries = publication?["scriptQueries"] ?? publication?["queries"];
            return queries is JsonArray values ? (JsonArray)values.DeepClone() : [];
        }
    }
}
