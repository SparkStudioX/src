using System.Text.Json.Nodes;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

public sealed partial class ProjectStore
{
    // database connector plugin: read-only connectors cannot store update queries.
    private void RejectPluginUpdate(JsonObject query)
    {
        if ((Optional(query, "kind") ?? "query") != "update") return;
        try { DatabaseConnectors.RejectUpdates(GetConnection(Required(query, "connectionId"), allowDisabled: true)); }
        catch (KeyNotFoundException) { }
        catch (InvalidOperationException) { }
    }
}
