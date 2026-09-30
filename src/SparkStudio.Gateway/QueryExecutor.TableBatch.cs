using System.Text.Json;
using System.Text.Json.Nodes;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

public sealed partial class QueryExecutor
{
    public Task<ExecuteResult> ExecuteTableBatchAsync(JsonObject query, Dictionary<string, JsonElement> parameters, JsonObject table,
        Func<QueryResult, IReadOnlyList<AtomicTableRow>> validate, CancellationToken cancellation)
    {
        if (ProjectStore.Optional(query, "kind") == "update") throw new ArgumentException("Batch membership requires a published read query.");
        var edit = table["tableEdit"]!.AsObject();
        var connection = store.GetConnection(ProjectStore.Required(query, "connectionId"));
        return connectors.ExecuteTableBatchAsync(connection, ProjectStore.Required(query, "sql"), Parameters(query, parameters),
            ProjectStore.Required(edit["batch"]!.AsObject(), "table"), ProjectStore.Required(table, "rowKey"), ProjectStore.Required(edit, "versionColumn"), validate, cancellation);
    }
}
