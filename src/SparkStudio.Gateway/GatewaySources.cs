using System.Text;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

public static class GatewaySources
{
    public sealed record BrowseRequest(string? Parent = null, int PageSize = 100, string? ContinuationToken = null, int? Revision = null);
    public sealed record MigrationRequest(int Revision, SourceSettings Source);
    public sealed record SuppressionRequest(string PointId);
    public sealed record TestRequest(int? Revision = null);
    public sealed record ScriptTestRequest(int Revision, string? MappingId, string Topic, string Payload,
        bool Retained = false, SourceMqttMapping? Mapping = null);

    public static void MapSourceEndpoints(this RouteGroupBuilder routes)
    {
        routes.MapPost("/connections/{id}/source/test", async (string id, TestRequest request, ProjectStore store, ConnectorService connectors, CancellationToken ct) => {
            var capture = Capture(store, id, request.Revision);
            var test = store.BeginConnectionTest(id);
            var timer = System.Diagnostics.Stopwatch.StartNew();
            var result = await connectors.TestSourceAsync(capture.Connection, ct);
            Verify(store, id, capture.Revision);
            var saved = store.CompleteConnectionTest(test, result.Success, timer.Elapsed.TotalMilliseconds, result.Message);
            return new { result.Success, result.Message, result.Capabilities, result.Version, result.Details, saved };
        }).Access("configuration", audit: true);
        routes.MapPost("/connections/{id}/source/browse", async (string id, BrowseRequest request, ProjectStore store, ConnectorService connectors, CancellationToken ct) => {
            var capture = Capture(store, id, request.Revision);
            var result = await connectors.BrowseSourceAsync(capture.Connection, new(request.Parent, request.PageSize, request.ContinuationToken), ct);
            Verify(store, id, capture.Revision);
            return result;
        }).Access("configuration");
        routes.MapPost("/connections/{id}/source/read", async (string id, GatewayConnections.DeviceReadRequest request, ProjectStore store, ConnectorService connectors, CancellationToken ct) => {
            var capture = Capture(store, id, request.Revision);
            if (request.NodeIds is null || request.NodeIds.Length is < 1 or > 1000 || request.NodeIds.Any(string.IsNullOrWhiteSpace))
                throw new ArgumentException("Read between 1 and 1,000 saved source points.");
            var result = await connectors.ReadSourceAsync(capture.Connection, request.NodeIds, ct);
            Verify(store, id, capture.Revision);
            return result;
        }).Access("configuration");
        routes.MapPost("/connections/{id}/source/import/preview", (string id, SourceImportRequest request, ProjectStore store) =>
            store.PreviewSourceImport(id, request)).Access("configuration");
        routes.MapPost("/connections/{id}/source/import/apply", (string id, SourceImportRequest request, TagEngine tags) =>
            tags.ApplySourceImport(id, request)).Access("configuration", audit: true);
        routes.MapPost("/connections/{id}/source/migration/preview", (string id, MigrationRequest request, ProjectStore store) =>
            store.PreviewSourceMigration(id, request.Revision, request.Source)).Access("configuration");
        routes.MapGet("/connections/{id}/source/ownership", (string id, ProjectStore store) => {
            _ = Capture(store, id, null, allowDisabled: true);
            return store.SourceOwnership(id);
        }).Access("configuration");
        routes.MapPost("/connections/{id}/source/suppression/clear", (string id, SuppressionRequest request, ProjectStore store, TagEngine tags) => {
            _ = Capture(store, id, null, allowDisabled: true);
            tags.ClearSourceSuppression(id, request.PointId);
            return Results.NoContent();
        }).Access("configuration", audit: true);
        routes.MapPost("/connections/{id}/source/script/test", async (string id, ScriptTestRequest request, ProjectStore store, CancellationToken ct) => {
            var capture = Capture(store, id, request.Revision);
            if (capture.Connection.Type != "mqtt") throw new ArgumentException("Extraction tests require an MQTT connection.");
            var settings = capture.Connection.Source!;
            if (request.Payload is null || Encoding.UTF8.GetByteCount(request.Payload) > settings.EffectiveLimits.PayloadBytes)
                throw new SourceLimitException("Test payload exceeds the connection payload limit.");
            if (request.Topic is null || request.Topic.Length is < 1 or > 2048 || request.Topic.Contains('\0'))
                throw new ArgumentException("Provide a bounded MQTT topic.");
            var mapping = request.Mapping ?? settings.Mqtt?.Mappings?.SingleOrDefault(item => item.Id == request.MappingId)
                ?? throw new ArgumentException("Choose a saved mapping or supply a draft mapping.");
            var candidate = settings with { Mqtt = settings.Mqtt! with { Mappings = [mapping] }, Points = settings.SavedPoints.Where(point => point.MappingId == mapping.Id).ToArray() };
            SourceConfiguration.Validate("mqtt", candidate);
            var result = await SourceMqttScriptTester.TestAsync(capture.Connection with { Source = candidate }, mapping, request.Topic, request.Payload, request.Retained, ct);
            Verify(store, id, capture.Revision);
            return result;
        }).Access("configuration");
    }

    internal static (ConnectionDefinition Connection, int Revision) Capture(ProjectStore store, string id, int? revision, bool allowDisabled = false)
    {
        lock (GatewayConfigurationLock.SyncRoot)
        {
            var saved = store.ConnectionMetadata(id);
            var current = saved["revision"]!.GetValue<int>();
            if (revision is not null && (revision < 0 || current != revision)) throw new InvalidOperationException("The connection changed. Reload before using its source catalog.");
            var connection = store.GetConnection(id, allowDisabled);
            if (!SourceConfiguration.IsSource(connection)) throw new ArgumentException("Use a saved source connection.");
            return (connection, current);
        }
    }
    internal static void Verify(ProjectStore store, string id, int revision) => _ = Capture(store, id, revision);
}
