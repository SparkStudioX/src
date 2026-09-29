using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json.Serialization;

namespace SparkStudio.Gateway;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record PreviewStartRequest(string Mode);
public sealed record PreviewSessionResponse(string Token, string Mode, DateTimeOffset ExpiresAt);
public sealed record PreviewEndpoint(string Operation);

/// <summary>Short-lived engineering capabilities. Read-only previews never start Python.</summary>
public sealed class PreviewSessions(TimeProvider? timeProvider = null) : IDisposable
{
    public const string Header = "X-SPARK-PREVIEW";
    private readonly object gate = new();
    private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
    private sealed record Entry(string Session, string Project, string Mode, DateTimeOffset ExpiresAt, CancellationTokenSource Cancellation);

    public PreviewSessionResponse Start(HttpContext context, string mode)
    {
        if (mode is not ("read-only" or "live-actions")) throw new ArgumentException("Choose read-only or live-actions preview mode.");
        if (mode == "live-actions") GatewayAccess.RequireAdmin(context);
        var session = Session(context);
        lock (gate)
        {
            foreach (var expired in entries.Where(item => item.Value.ExpiresAt <= clock.GetUtcNow()).Select(item => item.Key).ToArray()) Remove(expired);
            if (entries.Count >= 256 || entries.Values.Count(item => item.Session == session) >= 8)
                throw new BadHttpRequestException("Too many preview sessions. Close another preview and try again.", 429);
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            var expires = clock.GetUtcNow().AddMinutes(15);
            var cancellation = new CancellationTokenSource(TimeSpan.FromMinutes(15));
            entries[token] = new(session, GatewayAccess.ProjectId(context), mode, expires, cancellation);
            return new(token, mode, expires);
        }
    }

    public CancellationToken Require(HttpContext context, bool liveActions = false)
    {
        var header = context.Request.Headers[Header];
        if (header.Count != 1 || header[0] is not { Length: 64 } token)
            throw new BadHttpRequestException("A current Designer preview session is required. Reopen Preview.", 403);
        lock (gate)
        {
            if (!entries.TryGetValue(token, out var entry) || entry.ExpiresAt <= clock.GetUtcNow() || entry.Cancellation.IsCancellationRequested)
                throw new BadHttpRequestException("The Designer preview session expired or was closed. Reopen Preview.", 403);
            if (entry.Session != Session(context) || entry.Project != GatewayAccess.ProjectId(context))
                throw new BadHttpRequestException("The preview session does not belong to this engineering session and project.", 403);
            if (liveActions)
            {
                if (entry.Mode != "live-actions") throw new BadHttpRequestException("Live read-only Preview does not execute Python, writes or table commits. Explicitly enable Live actions to run draft Python.", 403);
                GatewayAccess.RequireAdmin(context);
            }
            return entry.Cancellation.Token;
        }
    }

    public void Revoke(HttpContext context)
    {
        Require(context);
        lock (gate) Remove(context.Request.Headers[Header][0]!);
    }

    private static string Session(HttpContext context)
    {
        if (GatewayAccess.IsOperator(context) || !GatewaySecurity.SessionStillValid(context))
            throw new BadHttpRequestException("A current engineering session is required for Preview.", 403);
        return context.User.FindFirstValue("spark:session") ?? throw new BadHttpRequestException("Sign in again to open Preview.", 401);
    }

    private void Remove(string token)
    {
        if (!entries.Remove(token, out var entry)) return;
        entry.Cancellation.Cancel();
        entry.Cancellation.Dispose();
    }
    public void Dispose() { lock (gate) foreach (var token in entries.Keys.ToArray()) Remove(token); }
}

public static class PreviewCommunication
{
    public static void UsePreviewCommunication(this WebApplication app) => app.Use(async (context, next) =>
    {
        var policy = context.GetEndpoint()?.Metadata.GetMetadata<PreviewEndpoint>();
        var hasToken = context.Request.Headers.ContainsKey(PreviewSessions.Header);
        if (policy?.Operation == "start")
        {
            if (hasToken) throw new BadHttpRequestException("Close the current preview before requesting another mode.", 400);
        }
        else if (policy is not null || hasToken)
        {
            var sessions = context.RequestServices.GetRequiredService<PreviewSessions>();
            sessions.Require(context, liveActions: policy?.Operation == "script");
            var route = (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText;
            // All mutations use an explicit preview route. Even a live capability cannot
            // be presented to publication, generic script, operator or administration APIs.
            if (policy is null && !HttpMethods.IsGet(context.Request.Method) && !HttpMethods.IsHead(context.Request.Method)
                && route != "/api/tags/read")
                throw new BadHttpRequestException("This operation is unavailable from Designer Preview. Exit Preview before editing gateway or project configuration.", 403);
        }
        await next();
    });

    public static void MapPreviewEndpoints(this RouteGroupBuilder routes)
    {
        routes.MapPost("/preview/sessions", (PreviewStartRequest request, HttpContext context, PreviewSessions sessions) => sessions.Start(context, request.Mode))
            .WithMetadata(new PreviewEndpoint("start")).Access("design", audit: true);
        routes.MapDelete("/preview/session", (HttpContext context, PreviewSessions sessions) => { sessions.Revoke(context); return Results.NoContent(); })
            .WithMetadata(new PreviewEndpoint("revoke")).Access("design");
        routes.MapPost("/preview/queries/{id}/execute", async (string id, QueryRequest request, HttpContext context, PreviewSessions sessions,
            ProjectStore store, QueryExecutor queries, CancellationToken cancellation) =>
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, sessions.Require(context));
            linked.Token.ThrowIfCancellationRequested();
            // ExecuteDefinitionAsync rejects updates and uses the connector read path.
            return await queries.ExecuteDefinitionAsync(store.GetQuery(id), request.Parameters, linked.Token);
        }).WithMetadata(new PreviewEndpoint("query")).Access("design");
        routes.MapPost("/preview/scripts/run", async (ScriptRequest request, HttpContext context, PreviewSessions sessions, PythonRunner python, CancellationToken cancellation) =>
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, sessions.Require(context, liveActions: true));
            linked.Token.ThrowIfCancellationRequested();
            return await python.RunAsync(request.Code, request.Parameters, request.Inputs, linked.Token);
        }).WithMetadata(new PreviewEndpoint("script")).Access("admin", audit: true);
    }
}
