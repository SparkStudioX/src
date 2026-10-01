using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

/// <summary>Connection administration with revision-checked removal and reference observations.</summary>
public static class GatewayConnections
{
    public sealed record DeviceReadRequest(int Revision, string[] NodeIds);

    public static void MapGatewayConnectionEndpoints(this RouteGroupBuilder routes)
    {
        routes.MapPost("/connections/{id}/read", async (string id, DeviceReadRequest request, ProjectStore store, ConnectorService connector, CancellationToken cancellation) =>
        {
            if (request.NodeIds is null || request.NodeIds.Length is < 1 or > 256 || request.NodeIds.Any(string.IsNullOrWhiteSpace))
                throw new ArgumentException("Read between 1 and 256 saved device points.");
            ConnectionDefinition connection;
            lock (GatewayConfigurationLock.SyncRoot)
            {
                var saved = store.GetConnections().OfType<JsonObject>().SingleOrDefault(item => ProjectStore.Optional(item, "id") == id)
                    ?? throw new KeyNotFoundException("Connection not found.");
                if (request.Revision < 0 || saved["revision"]!.GetValue<int>() != request.Revision)
                    throw new InvalidOperationException("The connection changed. Reload before reading device points.");
                connection = store.GetConnection(id);
                if (!DeviceConfiguration.IsDevice(connection)) throw new ArgumentException("Use a saved industrial device connection.");
                foreach (var point in request.NodeIds) _ = DeviceConfiguration.Point(connection, point);
            }
            return await connector.ReadAsync(connection, request.NodeIds, cancellation);
        }).Access("configuration");
        routes.MapPost("/connections/{id}/test", async (string id, ProjectStore store, ConnectorService connector, CancellationToken cancellation) =>
        {
            var capture = store.BeginConnectionTest(id);
            var timer = Stopwatch.StartNew();
            var result = await connector.TestAsync(capture.Connection, cancellation);
            return store.CompleteConnectionTest(capture, result.Success, timer.Elapsed.TotalMilliseconds, result.Message);
        }).Access("configuration", audit: true);
        routes.MapGet("/connections/{id}/diagnostics", (string id, ProjectCatalog catalog, TagEngine tags) => Snapshot(id, catalog, tags)).Access("configuration");
        routes.MapDelete("/connections/{id}", async (string id, [Microsoft.AspNetCore.Mvc.FromBody] JsonObject request, ProjectCatalog catalog, TagEngine tags) =>
        {
            if (request["revision"] is not JsonValue value || !value.TryGetValue<int>(out var revision) || revision < 0)
                throw new ArgumentException("Connection revision must be a nonnegative integer.");
            await tags.DeleteConnectionAsync(id, revision, catalog);
            return Results.NoContent();
        }).Access("configuration", audit: true);
    }

    public static object Snapshot(string id, ProjectCatalog catalog, TagEngine tags)
    {
        var connection = catalog.GatewayStore.GetConnections().OfType<JsonObject>().FirstOrDefault(item => ProjectStore.Optional(item, "id") == id)
            ?? throw new KeyNotFoundException("Connection not found.");
        var dependencies = References(id, catalog);
        var definitions = catalog.GatewayStore.GetTagDefinitions().OfType<JsonObject>()
            .Where(item => ProjectStore.Optional(item, "connectionId") == id).ToArray();
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
            note = "Saved tag, UDT member and named-query references prevent deletion. Scripts can also use connections dynamically; review those scripts before removing a connection."
        };
    }

    internal static IReadOnlyList<ConnectionDependency> References(string id, ProjectCatalog catalog)
    {
        lock (GatewayConfigurationLock.SyncRoot)
        {
            var dependencies = new List<ConnectionDependency>();
            dependencies.AddRange(catalog.GatewayStore.GetTagDefinitions().OfType<JsonObject>()
                .Where(item => ProjectStore.Optional(item, "connectionId") == id)
                .Select(item => new ConnectionDependency("tag", null, null, ProjectStore.Required(item, "path"), ProjectStore.Required(item, "path"))));
            foreach (var definition in catalog.GatewayStore.ExportTags()["udtDefinitions"]!.AsArray().OfType<JsonObject>())
            foreach (var member in definition["members"]!.AsArray().OfType<JsonObject>().Where(item => ProjectStore.Optional(item, "connectionId") == id))
            {
                var name = TagModel.DefinitionKey(definition) + "/" + ProjectStore.Required(member, "path");
                dependencies.Add(new("UDT member", null, null, name, name));
            }
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
            return dependencies;
        }
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
