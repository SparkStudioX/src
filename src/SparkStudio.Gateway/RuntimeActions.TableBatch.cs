using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public sealed partial class RuntimeActions
{
    public async Task<JsonObject> ExecuteTableBatchEditAsync(string screenId, string componentId, TableEditRequest request, CancellationToken cancellation)
    {
        if (string.IsNullOrWhiteSpace(request.PublishedAt)) throw new ArgumentException("Reload the published screen before applying table edits.");
        var action = publications.GetTableEdit(screenId, componentId, request.PublishedAt, request.InstanceId, request.RowId, request.PopupOrigin, request.InstancePath);
        var table = action["table"]!.AsObject();
        if (table["tableEdit"]?["batch"] is not JsonObject) throw new ArgumentException("This published table does not permit atomic batches.");
        var context = await ResolveContextAsync(action, request.Parameters, request.BindingInputs, request.PopupOrigin?.BindingInputs, request.BindingState, request.PopupOrigin?.BindingState, cancellation);
        var query = action["query"]!.AsObject();
        var parameters = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var parameter in (query["parameters"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var name = ProjectStore.Required(parameter, "name"); if (context.TryGetValue(name, out var value)) parameters[name] = value;
        }
        SparkStudio.Connectors.ExecuteResult result;
        try { result = await queries.ExecuteTableBatchAsync(query, parameters, table, fresh => TableEditValidator.BatchRows(table, fresh, request), cancellation); }
        // A rejected database transaction is not a changed publication. Keep
        // publication conflicts from GetTableEdit above distinct (HTTP 409).
        catch (InvalidOperationException error) { throw new ArgumentException(error.Message, error); }
        return new JsonObject { ["success"] = true, ["result"] = new JsonObject { ["rowsAffected"] = result.RowsAffected, ["cellsApplied"] = request.Edits!.Count, ["atomic"] = true }, ["stdout"] = "", ["stderr"] = "", ["durationMs"] = result.DurationMs };
    }
}
