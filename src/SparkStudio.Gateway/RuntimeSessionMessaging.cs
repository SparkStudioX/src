using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Threading.Channels;

namespace SparkStudio.Gateway;

/// <summary>Ephemeral per-tab mailboxes. Queuing acknowledges acceptance, never browser execution.</summary>
public sealed class RuntimeSessionMessaging(TimeProvider? time = null)
{
    private readonly TimeProvider clock = time ?? TimeProvider.System;
    private readonly object gate = new();
    private readonly Dictionary<string, Session> sessions = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (long Second, int Count)> rates = new(StringComparer.Ordinal);
    private (long Second, int Count) gatewayRate;
    private int pending;
    public sealed class Session(string id, string projectId, string publishedAt, string userId, string username, string owner, Func<bool> valid, DateTimeOffset now)
    {
        public string Id { get; } = id;
        public string ProjectId { get; } = projectId;
        public string PublishedAt { get; } = publishedAt;
        internal string UserId { get; } = userId;
        internal string Username { get; } = username;
        internal string Owner { get; } = owner;
        internal Func<bool> Valid { get; } = valid;
        internal DateTimeOffset Seen = now;
        internal bool Connected;
        internal readonly Queue<JsonObject> Queue = new();
        internal readonly CancellationTokenSource Closed = new();
        internal readonly Channel<bool> Signal = Channel.CreateBounded<bool>(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropWrite });
        public object Identity() => new { sessionId = Id, projectId = ProjectId, publishedAt = PublishedAt };
    }

    public Session Register(string projectId, string publishedAt, string userId, string username, string owner, Func<bool> valid)
    {
        if (string.IsNullOrWhiteSpace(projectId) || string.IsNullOrWhiteSpace(publishedAt) || string.IsNullOrWhiteSpace(userId) || string.IsNullOrWhiteSpace(owner))
            throw new ArgumentException("An operator session needs a project, publication and authenticated owner.");
        lock (gate)
        {
            Sweep();
            if (!valid()) throw new InvalidOperationException("This publication or operator account is no longer active.");
            if (sessions.Count >= 1024 || sessions.Values.Count(item => item.ProjectId == projectId) >= 256 || sessions.Values.Count(item => item.Owner == owner) >= 32)
                throw new BadHttpRequestException("Too many active operator tabs. Close an existing tab and retry.", 429);
            var session = new Session(Guid.NewGuid().ToString("N"), projectId, publishedAt, userId, username, owner, valid, clock.GetUtcNow());
            sessions.Add(session.Id, session);
            return session;
        }
    }

    public Session Connect(string projectId, string sessionId, string userId, string owner)
    {
        lock (gate)
        {
            var session = Owned(projectId, sessionId, userId, owner);
            if (session.Connected) throw new InvalidOperationException("This operator tab already has a message stream.");
            session.Connected = true; session.Seen = clock.GetUtcNow();
            return session;
        }
    }

    public void Close(string projectId, string sessionId, string userId, string owner)
    {
        lock (gate)
        {
            // Idempotent cleanup must not allow one login or project to close another's tab.
            if (!sessions.TryGetValue(sessionId, out var session)) return;
            if (session.ProjectId != projectId || session.UserId != userId || session.Owner != owner) throw new KeyNotFoundException("Operator tab not found.");
            Remove(session);
        }
    }

    public void Disconnect(Session session) { lock (gate) Remove(session); }
    public bool Refresh(Session session)
    {
        lock (gate)
        {
            if (!sessions.ContainsKey(session.Id) || !session.Connected || !IsValid(session)) { Remove(session); return false; }
            session.Seen = clock.GetUtcNow(); return true;
        }
    }
    public JsonObject? Take(Session session)
    {
        lock (gate)
        {
            if (!Refresh(session)) return null;
            while (session.Queue.TryDequeue(out var message))
            {
                pending--;
                if (clock.GetUtcNow() - DateTimeOffset.Parse(message["timestamp"]!.GetValue<string>(), System.Globalization.CultureInfo.InvariantCulture) < TimeSpan.FromSeconds(5)) return message;
            }
            return null;
        }
    }
    public JsonArray GetSessionInfo(string projectId)
    {
        lock (gate)
        {
            Sweep();
            foreach (var item in sessions.Values.Where(item => item.ProjectId == projectId).ToArray()) if (!IsValid(item)) Remove(item);
            return new JsonArray(sessions.Values.Where(item => item.ProjectId == projectId && item.Connected).Select(item => (JsonNode)new JsonObject
            { ["sessionId"] = item.Id, ["projectId"] = item.ProjectId, ["publishedAt"] = item.PublishedAt, ["username"] = item.Username }).ToArray());
        }
    }
    public JsonObject Send(string projectId, string messageType, JsonObject payload, string? sessionId = null)
    {
        ComponentEventValidator.ValidateMessageAction(new JsonObject { ["messageType"] = messageType, ["scope"] = "session", ["payload"] = payload.DeepClone() });
        if (sessionId is not null && (sessionId.Length != 32 || !sessionId.All(Uri.IsHexDigit))) throw new ArgumentException("sessionId must be a server-issued operator tab identity.");
        lock (gate)
        {
            Sweep();
            var second = clock.GetUtcNow().ToUnixTimeSeconds();
            if (rates.Count > 1024) foreach (var key in rates.Where(item => item.Value.Second != second).Select(item => item.Key).ToArray()) rates.Remove(key);
            var rate = rates.GetValueOrDefault(projectId);
            if (rate.Second == second && rate.Count >= 128) throw new InvalidOperationException("Session messaging is limited to 128 sends per project per second.");
            if (gatewayRate.Second == second && gatewayRate.Count >= 512) throw new InvalidOperationException("Session messaging is limited to 512 sends per gateway per second.");
            rates[projectId] = (second, rate.Second == second ? rate.Count + 1 : 1);
            gatewayRate = (second, gatewayRate.Second == second ? gatewayRate.Count + 1 : 1);
            var recipients = sessions.Values.Where(item => item.ProjectId == projectId && item.Connected && (sessionId is null || item.Id == sessionId) && IsValid(item)).ToArray();
            var messageId = Guid.NewGuid().ToString("N"); var queued = 0;
            foreach (var recipient in recipients)
            {
                if (recipient.Queue.Count >= 32 || pending >= 512) continue;
                recipient.Queue.Enqueue(new JsonObject { ["messageId"] = messageId, ["messageType"] = messageType, ["payload"] = payload.DeepClone(),
                    ["scope"] = "session", ["sessionId"] = recipient.Id, ["projectId"] = projectId, ["publishedAt"] = recipient.PublishedAt, ["timestamp"] = clock.GetUtcNow().ToString("O") });
                recipient.Signal.Writer.TryWrite(true); queued++; pending++;
            }
            return new JsonObject { ["messageId"] = messageId, ["eligible"] = recipients.Length, ["queued"] = queued, ["dropped"] = recipients.Length - queued,
                ["status"] = queued > 0 ? "queued" : recipients.Length > 0 ? "queueFull" : "noRecipients" };
        }
    }
    private Session Owned(string projectId, string sessionId, string userId, string owner)
    {
        Sweep();
        if (!sessions.TryGetValue(sessionId, out var session) || session.ProjectId != projectId || session.UserId != userId || session.Owner != owner || !IsValid(session))
            throw new KeyNotFoundException("Operator tab not found or expired. Register a new tab connection.");
        return session;
    }
    private bool IsValid(Session session) => clock.GetUtcNow() - session.Seen < TimeSpan.FromSeconds(30) && session.Valid();
    // Sweep only mailbox TTLs. Do not revalidate every gateway account/publication
    // for every send or registration; validate the actual connection/recipients.
    private void Sweep() { foreach (var item in sessions.Values.ToArray()) if (clock.GetUtcNow() - item.Seen >= TimeSpan.FromSeconds(30)) Remove(item); }
    private void Remove(Session session)
    {
        if (!sessions.Remove(session.Id)) return;
        session.Connected = false; pending -= session.Queue.Count; session.Queue.Clear(); session.Signal.Writer.TryComplete(); session.Closed.Cancel();
    }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record RuntimeSessionRegistration(string PublishedAt);

public static class RuntimeSessionMessageEndpoints
{
    public static void MapRuntimeSessionMessageEndpoints(this RouteGroupBuilder routes)
    {
        routes.MapPost("/runtime/sessions", (RuntimeSessionRegistration request, HttpContext context, RuntimeSessionMessaging messaging, ProjectCatalog catalog, SecurityStore security) =>
        {
            var projectId = GatewayAccess.ProjectId(context); var actor = GatewayAccess.Actor(context);
            var publication = catalog.Get(projectId).Publication;
            if (string.IsNullOrWhiteSpace(request.PublishedAt) || ProjectStore.Optional(publication.Metadata(), "publishedAt") != request.PublishedAt)
                throw new InvalidOperationException("The published application changed. Reload it before connecting this operator tab.");
            var authValid = GatewaySecurity.CaptureSessionValidator(context);
            bool Valid()
            {
                if (!authValid()) return false;
                var user = security.GetUser(actor.Id);
                if (user is null || user.Disabled || user.Revision != actor.Revision || !security.GetPermissions(user, projectId).View) return false;
                try { return ProjectStore.Optional(catalog.Get(projectId).Publication.Metadata(), "publishedAt") == request.PublishedAt; }
                catch (KeyNotFoundException) { return false; }
            }
            return messaging.Register(projectId, request.PublishedAt, actor.Id, actor.Username, Owner(context), Valid).Identity();
        }).Access("view", "operator");
        routes.MapDelete("/runtime/sessions/{sessionId}", (string sessionId, HttpContext context, RuntimeSessionMessaging messaging) =>
        {
            messaging.Close(GatewayAccess.ProjectId(context), sessionId, GatewayAccess.Actor(context).Id, Owner(context));
            return Results.NoContent();
        }).Access("view", "operator");
        routes.MapGet("/runtime/sessions/{sessionId}/messages", Stream).Access("view", "operator");
    }
    private static string Owner(HttpContext context) => GatewaySecurity.CurrentSessionAdministrationId(context)
        ?? throw new UnauthorizedAccessException("An active operator login is required.");
    private static async Task Stream(string sessionId, HttpContext context, RuntimeSessionMessaging messaging, TagEngine tags, SecurityStore security)
    {
        using var lease = TagEventStream.Acquire(context);
        var session = messaging.Connect(GatewayAccess.ProjectId(context), sessionId, GatewayAccess.Actor(context).Id, Owner(context));
        using var changes = new TagDeltaSubscription(tags, path => GatewayAccess.CanReadTag(context, security, path));
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, session.Closed.Token);
        var token = cancellation.Token;
        context.Response.ContentType = "text/event-stream";
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers["X-Accel-Buffering"] = "no";
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        async Task<bool> Write(string name, object value, long? revision = null)
        {
            token.ThrowIfCancellationRequested();
            var frame = $"event: {name}\ndata: {JsonSerializer.Serialize(value, json)}\n\n";
            if (!messaging.Refresh(session) || revision is not null && security.SettingsRevision != revision) return false;
            await context.Response.WriteAsync(frame, token);
            await context.Response.Body.FlushAsync(token);
            return true;
        }
        try
        {
            await Write("ready", session.Identity());
            var scopeRevision = -1L;
            var nextHeartbeat = DateTimeOffset.UtcNow.AddSeconds(5);
            while (messaging.Refresh(session))
            {
                var update = TagEventStream.CaptureCurrent(changes, scopeRevision, () => security.SettingsRevision);
                if (update is not null)
                {
                    if (update.Snapshot is { } snapshot)
                    { if (await Write("tags", snapshot, update.Revision)) scopeRevision = update.Revision; }
                    else if (update.Delta.Upserts.Length + update.Delta.Removed.Length > 0)
                    { if (await Write("tags-delta", update.Delta, update.Revision)) scopeRevision = update.Revision; }
                }
                if (DateTimeOffset.UtcNow >= nextHeartbeat)
                {
                    await TagEventStream.WriteHeartbeatAsync(context.Response, token);
                    nextHeartbeat = DateTimeOffset.UtcNow.AddSeconds(5);
                }
                while (messaging.Take(session) is { } message) await Write("message", message);
                using var heartbeat = CancellationTokenSource.CreateLinkedTokenSource(token);
                heartbeat.CancelAfter(TimeSpan.FromSeconds(1));
                try { if (!await session.Signal.Reader.WaitToReadAsync(heartbeat.Token)) break; while (session.Signal.Reader.TryRead(out _)) { } }
                catch (OperationCanceledException) when (!token.IsCancellationRequested) { }
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        finally { messaging.Disconnect(session); }
    }
}
