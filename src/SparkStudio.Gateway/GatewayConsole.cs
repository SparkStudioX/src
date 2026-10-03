using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Bounded observations; no request values, tokens or authored code are retained.</summary>
public sealed class GatewayObservations(string dataDirectory)
{
    private readonly object gate = new();
    private readonly Queue<RequestObservation> requests = new();
    private readonly DateTimeOffset startedAt = DateTimeOffset.UtcNow;
    private long completed, failed;
    private int active;
    private TimeSpan priorCpu = Process.GetCurrentProcess().TotalProcessorTime;
    private long priorSample = Stopwatch.GetTimestamp();
    private double? cpuPercent;
    public sealed record RequestObservation(DateTimeOffset RecordedAt, string Method, string Route, int Status, double DurationMs);
    public void Enter() => Interlocked.Increment(ref active);
    public void Complete(string method, string route, int status, double elapsed)
    {
        Interlocked.Decrement(ref active);
        lock (gate)
        {
            completed++; if (status >= 400) failed++;
            requests.Enqueue(new(DateTimeOffset.UtcNow, method, route, status, Math.Round(elapsed, 2)));
            while (requests.Count > 128) requests.Dequeue();
        }
    }
    public object Snapshot()
    {
        lock (gate)
        {
            using var process = Process.GetCurrentProcess();
            var now = Stopwatch.GetTimestamp();
            var elapsed = Stopwatch.GetElapsedTime(priorSample, now).TotalSeconds;
            if (elapsed >= 1)
            {
                cpuPercent = Math.Clamp((process.TotalProcessorTime - priorCpu).TotalSeconds / elapsed / Environment.ProcessorCount * 100, 0, 100);
                priorCpu = process.TotalProcessorTime; priorSample = now;
            }
            long? diskAvailableBytes = null;
            try { diskAvailableBytes = new DriveInfo(Path.GetPathRoot(dataDirectory)!).AvailableFreeSpace; }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException) { }
            return new { observedAt = DateTimeOffset.UtcNow, startedAt, uptimeSeconds = (DateTimeOffset.UtcNow - startedAt).TotalSeconds,
                processWorkingSetBytes = process.WorkingSet64, managedMemoryBytes = GC.GetTotalMemory(false), cpuPercent,
                diskAvailableBytes, activeRequests = Volatile.Read(ref active), completedRequests = completed, failedRequests = failed,
                requestWindow = requests.Reverse().ToArray(), retention = "Last 128 completed API requests; reset on gateway restart." };
        }
    }
}

public static class GatewayConsole
{
    private static readonly string[] SupportSnapshotExclusions = ["credentials", "session identities and tokens", "configuration values", "tag values and paths", "project resources", "script output", "exception bodies", "certificates and keys"];
    public static void UseGatewayObservations(this WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            if (!context.Request.Path.StartsWithSegments("/api")) { await next(); return; }
            var observations = context.RequestServices.GetRequiredService<GatewayObservations>();
            var start = Stopwatch.GetTimestamp(); observations.Enter();
            var status = 500;
            try { await next(); status = context.Response.StatusCode; }
            catch (Exception error) { status = error is BadHttpRequestException bad ? bad.StatusCode : error is OperationCanceledException ? 499 : error is ArgumentException or System.Text.Json.JsonException ? 400 : error is InvalidOperationException ? 409 : error is KeyNotFoundException ? 404 : error is ReadQueryTimeoutException ? 504 : 502; throw; }
            finally
            {
                var route = (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? "unmatched";
                observations.Complete(context.Request.Method, route, status, Stopwatch.GetElapsedTime(start).TotalMilliseconds);
            }
        });
    }

    public static void MapGatewayConsoleEndpoints(this WebApplication app)
    {
        app.MapGet("/api/gateway/overview", (HttpContext context, ProjectCatalog catalog, TagEngine tags, SecurityStore security, GatewayObservations observations, RecoveryQuarantine recovery) =>
        {
            var actor = GatewayAccess.Actor(context); var capabilities = security.GetGatewayCapabilities(actor);
            var resources = capabilities.Diagnostics || capabilities.Configuration;
            var projects = resources ? catalog.List(includeArchived: true) : new JsonArray();
            var values = tags.Snapshot();
            var connections = catalog.GatewayStore.GetConnections().OfType<JsonObject>().Where(_ => resources).Select(item => new {
                id = ProjectStore.Required(item, "id"), name = ProjectStore.Required(item, "name"), type = ProjectStore.Required(item, "type"),
                status = ProjectStore.Optional(item, "status") ?? "unknown"
            }).ToArray();
            return new { observedAt = DateTimeOffset.UtcNow, identity = Environment.MachineName, recoveryMode = recovery.Active,
                version = typeof(GatewayConsole).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown",
                framework = RuntimeInformation.FrameworkDescription, platform = RuntimeInformation.OSDescription,
                projects, connections, tags = new { total = resources ? values.Length : 0, good = resources ? values.Count(item => item.Quality == "Good") : 0,
                    unavailable = resources ? values.Count(item => item.Quality != "Good") : 0, configured = resources ? catalog.GatewayStore.GetTagDefinitions().Count : 0 },
                currentSessionId = capabilities.Sessions ? GatewaySecurity.CurrentSessionAdministrationId(context) : null,
                sessions = capabilities.Sessions ? security.SessionInventory() : [], metrics = capabilities.Diagnostics ? observations.Snapshot() : null };
        }).Access("gateway");
        app.MapPost("/api/gateway/sessions/{id}/revoke", (string id, SecurityStore security) =>
            security.RevokeManagedSession(id) ? Results.Ok(new { revoked = true }) : Results.NotFound(new { error = "Session is no longer active." }))
            .Access("sessions", audit: true);
        app.MapGet("/api/gateway/diagnostics", (GatewayObservations observations) => observations.Snapshot()).Access("diagnostics");
        app.MapGet("/api/gateway/support-snapshot", (GatewayObservations observations, ProjectCatalog catalog, TagEngine tags) =>
        {
            // Export an explicit allowlist, never configuration files or exception/output bodies.
            var data = new { format = "sparkstudio-support-snapshot", formatVersion = 1, createdAt = DateTimeOffset.UtcNow,
                version = typeof(GatewayConsole).Assembly.GetName().Version?.ToString(), framework = RuntimeInformation.FrameworkDescription,
                projectCount = catalog.List(includeArchived: true).Count, connectionCount = catalog.GatewayStore.GetConnections().Count,
                tagCount = tags.Snapshot().Length, metrics = observations.Snapshot(),
                excluded = SupportSnapshotExclusions };
            return Results.File(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(data, ProjectStore.Json), "application/json", "sparkstudio-support-snapshot.json");
        }).Access("diagnostics", audit: true);
    }
}
