using System.Collections.Concurrent;
using System.Text.Json;

namespace SparkStudio.Gateway;

public sealed record TagDelta(TagValue[] Upserts, string[] Removed);

/// <summary>Per-stream bounded latest-value mailbox. A slow reader coalesces updates rather than accumulating frames.</summary>
public sealed class TagDeltaSubscription : IDisposable
{
    private readonly TagEngine engine;
    private readonly object gate = new();
    private readonly HashSet<string> pending = new(StringComparer.Ordinal);
    private readonly Func<string, bool> allowed;
    private bool reset;
    private bool disposed;
    public TagValue[] Initial { get; }
    public int PendingCount { get { lock (gate) return pending.Count; } }
    public TagDeltaSubscription(TagEngine engine, Func<string, bool> allowed)
    {
        this.engine = engine; this.allowed = allowed;
        Initial = engine.SubscribeWithSnapshot(OnChanged).Where(tag => allowed(tag.Path)).ToArray();
    }
    private void OnChanged(TagValue? previous, TagValue current)
    {
        // Access checks occur on the stream thread, never under the tag engine lock.
        lock (gate)
        {
            if (disposed || reset) return;
            pending.Add(current.Path);
            if (pending.Count > 2048) { pending.Clear(); reset = true; }
        }
    }
    public (TagValue[]? Snapshot, TagDelta Delta) Drain()
    {
        string[] paths; bool needsSnapshot;
        lock (gate)
        {
            needsSnapshot = reset; reset = false;
            paths = pending.ToArray(); pending.Clear();
        }
        // Reset the mailbox before capturing. Concurrent changes remain queued;
        // harmless duplicates cannot lose a write that races the snapshot.
        if (needsSnapshot) return (engine.Snapshot().Where(tag => allowed(tag.Path)).ToArray(), new([], []));
        // A callback can be delayed behind another subscriber until after a reset.
        // Resolve queued paths now, so an older notification cannot roll the
        // client back from the newer value already sent in that snapshot.
        var changes = engine.Read(paths, null);
        return (null, new(changes.Where(tag => tag.Quality != "Bad_NotFound" && allowed(tag.Path)).ToArray(),
            changes.Where(tag => tag.Quality == "Bad_NotFound" && allowed(tag.Path)).Select(tag => tag.Path).ToArray()));
    }
    public TagValue[] Reset()
    {
        lock (gate) { pending.Clear(); reset = false; }
        return engine.Snapshot().Where(tag => allowed(tag.Path)).ToArray();
    }
    public void Dispose() { engine.ValueChanged -= OnChanged; lock (gate) { disposed = true; pending.Clear(); } }
}

public static class TagEventEndpoint
{
    public static async Task WriteHeartbeatAsync(HttpResponse response, CancellationToken cancellation)
    {
        // EventSource hides comment frames from listeners. A named event keeps
        // the client's idle watchdog alive even when no tag values change.
        await response.WriteAsync("event: heartbeat\ndata: {}\n\n", cancellation);
        await response.Body.FlushAsync(cancellation);
    }
    public sealed record AuthorizedBatch(long Revision, TagValue[]? Snapshot, TagDelta Delta);
    public static AuthorizedBatch? CaptureCurrent(TagDeltaSubscription changes, long previousRevision, Func<long> revision)
    {
        var current = revision();
        var update = current != previousRevision ? (Snapshot: (TagValue[]?)changes.Reset(), Delta: new TagDelta([], [])) : changes.Drain();
        // Scope can change during filtering. Discard that batch; the unchanged
        // caller revision forces a complete replacement on its next attempt.
        return revision() == current ? new(current, update.Snapshot, update.Delta) : null;
    }
    private static readonly ConcurrentDictionary<string, int> Streams = new(StringComparer.Ordinal);
    public static IDisposable Acquire(HttpContext context)
    {
        var owner = GatewaySecurity.CurrentSessionAdministrationId(context) ?? GatewayAccess.Actor(context).Id;
        if (Streams.AddOrUpdate(owner, 1, (_, count) => count + 1) > 32)
        { Release(owner); throw new BadHttpRequestException("This login already has 32 live data streams. Close a tab and retry.", 429); }
        return new Lease(owner);
    }
    private static void Release(string owner)
    {
        while (Streams.TryGetValue(owner, out var count))
        {
            if (count == 1) { if (Streams.TryRemove(new KeyValuePair<string, int>(owner, count))) return; }
            else if (Streams.TryUpdate(owner, count - 1, count)) return;
        }
    }
    private sealed class Lease(string owner) : IDisposable
    {
        private int disposed;
        public void Dispose() { if (Interlocked.Exchange(ref disposed, 1) == 0) Release(owner); }
    }
    public static async Task WriteAsync(HttpContext context, TagEngine tags, SecurityStore security)
    {
        using var lease = Acquire(context);
        using var changes = new TagDeltaSubscription(tags, path => GatewayAccess.CanReadTag(context, security, path));
        context.Response.ContentType = "text/event-stream";
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers["X-Accel-Buffering"] = "no";
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        json.Converters.Add(new ExactInt64JsonConverter());
        json.Converters.Add(new ExactUInt64JsonConverter());
        async Task<bool> Write(string name, object value, long revision)
        {
            var frame = $"event: {name}\ndata: {JsonSerializer.Serialize(value, json)}\n\n";
            if (!GatewayAccess.SessionStillAllowed(context, security) || security.SettingsRevision != revision) return false;
            await context.Response.WriteAsync(frame, context.RequestAborted);
            await context.Response.Body.FlushAsync(context.RequestAborted);
            return true;
        }
        try
        {
            var scopeRevision = -1L;
            async Task SendChanges()
            {
                var update = CaptureCurrent(changes, scopeRevision, () => security.SettingsRevision);
                if (update is null) return;
                if (update.Snapshot is { } snapshot)
                { if (await Write("tags", snapshot, update.Revision)) scopeRevision = update.Revision; }
                else if (update.Delta.Upserts.Length + update.Delta.Removed.Length > 0)
                { if (await Write("tags-delta", update.Delta, update.Revision)) scopeRevision = update.Revision; }
            }
            await SendChanges();
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
            var heartbeat = DateTimeOffset.UtcNow.AddSeconds(5);
            while (await timer.WaitForNextTickAsync(context.RequestAborted))
            {
                // Validate before releasing each batch; revoked users receive no more data.
                if (!GatewayAccess.SessionStillAllowed(context, security)) break;
                await SendChanges();
                if (DateTimeOffset.UtcNow >= heartbeat)
                { await WriteHeartbeatAsync(context.Response, context.RequestAborted); heartbeat = DateTimeOffset.UtcNow.AddSeconds(5); }
            }
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
    }
}
