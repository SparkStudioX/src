namespace SparkStudio.Gateway;

public static class ProcessDataEndpoints
{
    public static void MapProcessDataConfiguration(this WebApplication app)
    {
        app.MapGet("/api/gateway/process-data", (ProcessDataService service) => service.Configuration()).Access("configuration");
        app.MapGet("/api/gateway/process-data/diagnostics", (ProcessDataService service) => service.Diagnostics()).Access("diagnostics");
        app.MapPut("/api/gateway/process-data", (ProcessDataConfiguration request, ProcessDataService service) => service.Save(request)).Access("configuration", audit: true);
    }

    public static void MapProcessDataRuntime(this RouteGroupBuilder routes)
    {
        routes.MapGet("/alarms", (HttpContext context, ProcessDataService service, SecurityStore security)
            => new { alarms = service.Alarms(path => GatewayAccess.CanReadTag(context, security, path)) }).Access("read", "context");
        routes.MapGet("/alarm-journal", (int? limit, HttpContext context, ProcessDataService service, SecurityStore security)
            => service.JournalPage(path => GatewayAccess.CanReadTag(context, security, path), limit ?? 200)).Access("read", "context");
        routes.MapPost("/alarms/{id}/ack", (string id, AlarmAcknowledgeRequest request, HttpContext context, ProcessDataService service, SecurityStore security)
            => service.Acknowledge(id, request.EventId, GatewayAccess.Actor(context).Username, path => GatewayAccess.CanReadTag(context, security, path))).Access("operate", "operator", audit: true);
        routes.MapPost("/history/query", (HistoryQuery request, HttpContext context, ProcessDataService service, SecurityStore security)
            => service.Query(request, path => GatewayAccess.CanReadTag(context, security, path))).Access("read", "context");
    }
}
