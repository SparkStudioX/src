using System.Text.Json;
using System.Text.Json.Nodes;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

public sealed partial class QueryExecutor(ProjectStore store, ConnectorService connectors)
{
    public Task<QueryResult> ExecuteAsync(string id, Dictionary<string, JsonElement>? supplied, CancellationToken cancellation)
        => ExecuteDefinitionAsync(store.GetQuery(id), supplied, cancellation);

    public Task<object> ExecuteScriptAsync(string id, Dictionary<string, JsonElement>? supplied, CancellationToken cancellation)
        => ExecuteScriptDefinitionAsync(store.GetQuery(id), supplied, cancellation);

    public async Task<object> ExecuteScriptDefinitionAsync(JsonObject query, Dictionary<string, JsonElement>? supplied, CancellationToken cancellation, int? timeoutMs = null)
    {
        if (ProjectStore.Optional(query, "kind") != "update")
        {
            if (timeoutMs is null) return await ExecuteDefinitionAsync(query, supplied, cancellation);
            if (timeoutMs is < 250 or > 30_000) throw new ArgumentException("Read-query test deadline must be between 250 and 30,000 milliseconds.");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            deadline.CancelAfter(timeoutMs.Value);
            try { return await ExecuteDefinitionAsync(query, supplied, deadline.Token); }
            catch (OperationCanceledException) when (!cancellation.IsCancellationRequested && deadline.IsCancellationRequested)
            { throw new ReadQueryTimeoutException($"Read-query test exceeded its {timeoutMs.Value:N0} ms gateway deadline. No result was returned."); }
        }
        if (timeoutMs is not null) throw new ArgumentException("Read-query test deadlines cannot be applied to updates. An interrupted update can have an uncertain outcome.");
        var connection = store.GetConnection(ProjectStore.Required(query, "connectionId"));
        var result = await connectors.ExecuteAsync(connection, ProjectStore.Required(query, "sql"), Parameters(query, supplied), cancellation);
        return result.RowsAffected;
    }

    public async Task<QueryResult> ExecuteDefinitionAsync(JsonObject query, Dictionary<string, JsonElement>? supplied, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        if (ProjectStore.Optional(query, "kind") == "update") throw new ArgumentException("Update queries cannot be used as a table data source.");
        var boundParameters = Parameters(query, supplied);
        ConnectorService.ValidateReadParameters(boundParameters);
        var id = ProjectStore.Required(query, "id");
        var parameters = new Dictionary<string, JsonElement>(supplied ?? [], StringComparer.Ordinal);
        foreach (var item in (query["parameters"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var name = ProjectStore.Required(item, "name");
            if (!parameters.ContainsKey(name) && item.ContainsKey("defaultValue"))
                parameters[name] = JsonSerializer.SerializeToElement(item["defaultValue"]);
        }
        var connectionId = ProjectStore.Required(query, "connectionId");
        if (connectionId == "sample")
        {
            if (id != "production-summary" || ProjectStore.Required(query, "sql") != ProjectStore.Required(Seed.Queries()[0]!.AsObject(), "sql"))
                throw new ArgumentException("The sample provider only supports its built-in production summary. Configure SQL Server to execute SQL.");
            var line = parameters.TryGetValue("line", out var value) ? value.GetString() : null;
            var rows = new[]
            {
                new Dictionary<string, object?> { ["Line"] = "Line1", ["Product"] = "Assembly A", ["Produced"] = 13640, ["Target"] = 15000 },
                new Dictionary<string, object?> { ["Line"] = "Line2", ["Product"] = "Assembly B", ["Produced"] = 15280, ["Target"] = 18000 }
            }.Where(row => string.IsNullOrEmpty(line) || (string)row["Line"]! == line).ToArray();
            return new QueryResult(["Line", "Product", "Produced", "Target"], rows, 0);
        }
        return await connectors.QueryAsync(store.GetConnection(connectionId), ProjectStore.Required(query, "sql"), boundParameters, cancellation);
    }

    private static QueryParameter[] Parameters(JsonObject query, Dictionary<string, JsonElement>? supplied)
    {
        var parameters = new Dictionary<string, JsonElement>(supplied ?? [], StringComparer.Ordinal);
        var definitions = (query["parameters"] as JsonArray ?? []).OfType<JsonObject>().ToArray();
        foreach (var item in definitions)
        {
            var name = ProjectStore.Required(item, "name");
            if (!parameters.ContainsKey(name) && item.ContainsKey("defaultValue")) parameters[name] = JsonSerializer.SerializeToElement(item["defaultValue"]);
        }
        if (parameters.Keys.Any(name => !definitions.Any(d => ProjectStore.Required(d, "name") == name))) throw new ArgumentException("An undeclared query parameter was supplied.");
        return definitions.Select(d =>
        {
            var name = ProjectStore.Required(d, "name");
            if (!parameters.TryGetValue(name, out var value)) throw new ArgumentException($"Missing query parameter: {name}");
            return new QueryParameter(name, ProjectStore.Optional(d, "type") ?? "string", value);
        }).ToArray();
    }
}

public sealed class ReadQueryTimeoutException(string message) : TimeoutException(message);
