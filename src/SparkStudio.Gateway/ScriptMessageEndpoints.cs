using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace SparkStudio.Gateway;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ScriptMessageRequest(JsonElement Payload, int? Revision = null);

public static class ScriptMessageEndpoints
{
    public static void MapScriptMessageEndpoints(this RouteGroupBuilder routes)
    {
        routes.MapPost("/scripts/events/runs/{runId}/cancel", (string runId, ProjectRuntime runtime) =>
            runtime.Events.CancelRun(runId) ? Results.Ok(new { cancelled = true }) : Results.NotFound(new { error = "This run is no longer active." }))
            .Access("admin", audit: true);
        routes.MapPost("/scripts/messages/{name}/request", Request).Access("admin", audit: true);
        routes.MapPost("/scripts/messages/{name}/send", Send).Access("admin", audit: true);
        routes.MapPost("/runtime/messages/{name}/request", Request).Access("operate", "operator", audit: true);
        routes.MapPost("/runtime/messages/{name}/send", Send).Access("operate", "operator", audit: true);
    }

    private static string[] Roles(HttpContext context) => !GatewayAccess.IsOperator(context) && GatewayAccess.Actor(context).GatewayAdmin
        ? ["admin", "operate"] : ["operate"];

    private static async Task<JsonObject> Request(string name, ScriptMessageRequest request, ProjectRuntime runtime,
        HttpContext context, CancellationToken cancellation)
    {
        var result = await runtime.Events.DispatchMessageAsync(name, request.Payload, GatewayAccess.Actor(context).Username,
            Roles(context), cancellation, expectedRevision: request.Revision);
        context.Items["spark.actionOutcome"] = result["success"]?.GetValue<bool>() == true ? "Completed" : "Handler failed";
        return result;
    }

    private static JsonObject Send(string name, ScriptMessageRequest request, ProjectRuntime runtime, HttpContext context)
        => runtime.Events.SendMessage(name, request.Payload, GatewayAccess.Actor(context).Username, Roles(context), expectedRevision: request.Revision);
}
