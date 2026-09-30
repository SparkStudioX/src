using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;

namespace SparkStudio.Gateway;

/// <summary>Bounded project event execution; replacement drains its predecessor before starting.</summary>
public sealed class ScriptEventService : BackgroundService
{
    private const int QueueCapacity = 32;
    private readonly ScriptResourceStore store;
    private readonly PythonRunner python;
    private readonly ILogger<ScriptEventService> logger;
    private readonly TagEngine tags;
    private readonly object gate = new();
    private readonly Channel<bool> publications = Channel.CreateBounded<bool>(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true });
    private readonly Dictionary<string, ExecutionLease> leases = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ActiveRun> activeRuns = new(StringComparer.Ordinal);
    private readonly LinkedList<JsonObject> logs = new();
    private readonly Dictionary<string, JsonObject> states = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource lifetime = new();
    private readonly ScriptRunJournal journal;
    private bool journalAvailable = true;
    private Generation? active;
    private string? journalError;
    private readonly Dictionary<string, JsonObject> journalPending = new(StringComparer.Ordinal);
    private Task journalWriter = Task.CompletedTask;
    public string MessageScope { get; set; }

    private sealed class ExecutionLease { public readonly SemaphoreSlim Semaphore = new(1, 1); public int Users; }
    private sealed record ActiveRun(CancellationTokenSource Cancellation, TaskCompletionSource Done, Generation? Generation, string ResourceId, bool Shared);
    private sealed class Resource(JsonObject definition)
    {
        public readonly JsonObject Definition = definition;
        public string Id => ProjectStore.Required(Definition, "id");
        public string Event => ProjectStore.Required(Definition, "event");
        public bool Shared => ProjectStore.Optional(Definition, "threading") == "shared";
        public Lane Lane = null!;
        public long Executions;
        public long Missed;
        public long DroppedTagNotifications;
    }
    private sealed class Lane
    {
        public readonly Channel<Work> Queue = Channel.CreateBounded<Work>(new BoundedChannelOptions(QueueCapacity)
        { SingleReader = true, FullMode = BoundedChannelFullMode.Wait, AllowSynchronousContinuations = false });
    }
    private sealed record TagNotice(TagValue? Previous, TagValue Current, Resource[] Recipients);
    private sealed class Generation(JsonObject? snapshot, CancellationToken stopping)
    {
        public readonly JsonObject? Snapshot = snapshot;
        public readonly int? Revision = snapshot is null ? null : ScriptResourceStore.Revision(snapshot);
        public readonly string? Stamp = snapshot?["publishedAt"]?.GetValue<string>();
        public readonly IReadOnlyDictionary<string, string> Libraries = ScriptLibrary.Capture(snapshot);
        public readonly CancellationTokenSource Cancellation = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        public readonly Dictionary<string, Resource> Resources = new(StringComparer.Ordinal);
        public readonly Lane Shared = new();
        public readonly List<Task> Tasks = [];
        public readonly Channel<ScriptUpdateNotice> Updates = Channel.CreateBounded<ScriptUpdateNotice>(new BoundedChannelOptions(QueueCapacity)
        { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
        public readonly Channel<TagNotice> Tags = Channel.CreateBounded<TagNotice>(new BoundedChannelOptions(256)
        { SingleReader = true, FullMode = BoundedChannelFullMode.Wait, AllowSynchronousContinuations = false });
        public Action<TagValue?, TagValue>? TagHandler;
        public volatile bool Accepting;
    }
    private sealed record Work(Resource Resource, JsonObject Context, Dictionary<string, JsonElement> Parameters,
        string Source, string Trigger, int Revision, IReadOnlyDictionary<string, string> Libraries,
        CancellationToken Caller, string[] Chain, bool WaitForLease, TaskCompletionSource<JsonObject> Completion, JsonArray? Queries, PythonExecutionAccess? Access);

    public ScriptEventService(ScriptResourceStore store, PythonRunner python, ILogger<ScriptEventService> logger, TagEngine tags)
    {
        this.store = store; this.python = python; this.logger = logger; this.tags = tags;
        MessageScope = Path.GetFullPath(store.DataDirectory);
        journal = new ScriptRunJournal(store.DataDirectory);
        try { foreach (var entry in journal.Load()) logs.AddLast(entry); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidOperationException or JsonException)
        {
            // Keep the unreadable file intact. Diagnostics must not prevent project startup.
            journalAvailable = false;
            journalError = "Existing execution history could not be read. It is preserved; new history is in memory until storage is repaired and the project restarts.";
            logger.LogError(error, "Could not load script execution history");
        }
    }
    public JsonArray Logs() { lock (gate) return new(logs.Reverse().Select(entry => entry.DeepClone()).ToArray()); }
    public JsonObject Status()
    {
        lock (gate) return new()
        {
            ["activeRevision"] = active?.Revision, ["publishedAt"] = active?.Snapshot?["publishedAt"]?.DeepClone(),
            ["pythonAvailable"] = python.Available, ["acceptingEvents"] = active?.Accepting == true, ["journalError"] = journalError,
            ["resources"] = new JsonArray(states.Values.Select(state => state.DeepClone()).ToArray()),
            ["activeRuns"] = new JsonArray(activeRuns.Keys.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray())
        };
    }
    public bool CancelRun(string runId)
    {
        CancellationTokenSource? cancellation;
        lock (gate) cancellation = activeRuns.TryGetValue(runId, out var run) ? run.Cancellation : null;
        if (cancellation is null) return false;
        TryCancel(cancellation); return true;
    }
    public async Task<JsonObject> RunAsync(string id, ScriptRunRequest request, CancellationToken cancellation, string actor = "gateway-script")
    {
        var run = store.CaptureRun(id, request.Revision, request.Source);
        var resource = new Resource(run.Resource);
        var parameters = ScriptResourceStore.ResolveParameters(run.Resource, request.Parameters);
        Generation? generation;
        CancellationToken generationToken;
        lock (gate)
        {
            generation = active;
            if (run.Source == "published" && (generation is null || generation.Stamp != run.PublishedAt || !generation.Accepting))
                throw new InvalidOperationException("The application event generation is changing. Retry after the published version activates.");
            generationToken = generation?.Cancellation.Token ?? CancellationToken.None;
        }
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token, generationToken);
        var context = Context("manual");
        context["actor"] = actor;
        if (resource.Shared && generation is not null)
        {
            resource.Lane = generation.Shared;
            Task<JsonObject> pending;
            lock (gate)
            {
                if (Busy(id)) throw new InvalidOperationException("This script resource is already running.");
                pending = Enqueue(generation, resource, context, parameters, run.Source, "manual", run.Revision, run.Libraries, linked.Token, [], false, run.Queries);
            }
            return await pending;
        }
        return await RunCoreAsync(generation, resource, run.Revision, run.Source, "manual", parameters, run.Libraries, context, linked.Token, [], false, run.Queries);
    }
    public string GetMessageRequirement(string name)
    {
        lock (gate)
        {
            var (_, resource) = MessageHandler(name);
            return ProjectStore.Optional(resource.Definition, "requiredPermission") ?? "operate";
        }
    }
    public Task<JsonObject> DispatchMessageAsync(string name, JsonElement payload, string actor, string[]? roles,
        CancellationToken cancellation, string[]? chain = null, int? expectedRevision = null)
        => QueueMessage(name, payload, actor, roles, cancellation, chain ?? [], false, expectedRevision).Pending;
    public JsonObject SendMessage(string name, JsonElement payload, string actor, string[]? roles, string[]? chain = null, int? expectedRevision = null)
    {
        var delivery = QueueMessage(name, payload, actor, roles, CancellationToken.None, chain ?? [], true, expectedRevision);
        Observe(delivery.Pending);
        return new() { ["accepted"] = true, ["messageId"] = delivery.Id };
    }
    private (string Id, Task<JsonObject> Pending) QueueMessage(string name, JsonElement payload, string actor, string[]? roles,
        CancellationToken cancellation, string[] chain, bool oneWay, int? expectedRevision)
    {
        if (payload.ValueKind != JsonValueKind.Object || System.Text.Encoding.UTF8.GetByteCount(payload.GetRawText()) > 65_536)
            throw new ArgumentException("Message payload must be a JSON object of at most 64 KiB.");
        cancellation.ThrowIfCancellationRequested();
        lock (gate)
        {
            var (generation, resource) = MessageHandler(name, chain.Length > 0 && (roles is null || roles.Contains("gateway", StringComparer.Ordinal)));
            if (expectedRevision is not null && expectedRevision != generation.Revision)
                throw new InvalidOperationException("Script publication changed. Reload before sending this message.");
            var required = ProjectStore.Optional(resource.Definition, "requiredPermission") ?? "operate";
            if (roles is not null && !roles.Contains("gateway", StringComparer.Ordinal) && !roles.Contains("admin", StringComparer.Ordinal)
                && (required == "admin" || !roles.Contains("operate", StringComparer.Ordinal)))
                throw new BadHttpRequestException("Your account does not have permission for this message handler.", 403);
            if (chain.Length >= 8 || chain.Contains(Identity(resource.Id), StringComparer.Ordinal))
                throw new InvalidOperationException("Recursive gateway message delivery is not allowed.");
            // Independently initiated A→B and B→A calls can deadlock despite acyclic individual chains.
            if (!oneWay && chain.Length > 0 && (Busy(resource.Id) || resource.Shared &&
                activeRuns.Values.Any(item => item.Shared && chain.Contains(Identity(item.ResourceId), StringComparer.Ordinal))))
                throw new InvalidOperationException("A synchronous nested message cannot wait on a busy handler or its caller's shared lane. Use sendMessage.");
            var id = Guid.NewGuid().ToString("N");
            var context = Context("message");
            context["messageId"] = id; context["handler"] = name; context["actor"] = actor;
            context["payload"] = JsonNode.Parse(payload.GetRawText()); context["oneWay"] = oneWay;
            return (id, Enqueue(generation, resource, context, ScriptResourceStore.ResolveParameters(resource.Definition, null),
                "published", "message", generation.Revision!.Value, generation.Libraries, cancellation, chain, chain.Length == 0 || oneWay));
        }
    }
    private (Generation, Resource) MessageHandler(string name, bool internalStartup = false)
    {
        var generation = active;
        if (generation is null || !generation.Accepting && !internalStartup || generation.Cancellation.IsCancellationRequested)
            throw new InvalidOperationException("Gateway events are starting, stopping or unpublished. Try again after activation.");
        var resource = generation.Resources.Values.FirstOrDefault(item => item.Event == "message" && ProjectStore.Optional(item.Definition, "name") == name)
            ?? throw new KeyNotFoundException("Published message handler not found.");
        return (generation, resource);
    }

    private void OnPublished()
    {
        var stamp = store.Metadata()["publishedAt"]?.GetValue<string>();
        Generation? prior;
        lock (gate) { prior = active?.Stamp == stamp ? null : active; if (prior is not null) prior.Accepting = false; }
        if (prior is not null) TryCancel(prior.Cancellation);
        publications.Writer.TryWrite(true);
    }
    private void OnUpdated(ScriptUpdateNotice notice)
    {
        lock (gate)
        {
            if (active is not { } generation || generation.Cancellation.IsCancellationRequested) return;
            if (!generation.Updates.Writer.TryWrite(notice with { Resources = notice.Resources.DeepClone().AsObject() }))
                foreach (var resource in generation.Resources.Values.Where(item => item.Event == "update")) Missed(resource);
        }
    }
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var automaticAccess = PythonExecutionAccess.Enter(null);
        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, lifetime.Token);
        store.Published += OnPublished; store.Updated += OnUpdated;
        publications.Writer.TryWrite(true);
        try
        {
            while (await publications.Reader.WaitToReadAsync(stopping.Token))
            {
                while (publications.Reader.TryRead(out _)) { }
                var snapshot = store.CapturePublished();
                var stamp = snapshot?["publishedAt"]?.GetValue<string>();
                Generation? prior;
                lock (gate)
                {
                    prior = active;
                    if (prior is not null && !prior.Cancellation.IsCancellationRequested && prior.Stamp == stamp) continue;
                }
                if (prior is not null) await StopGenerationAsync(prior, "publication");
                stopping.Token.ThrowIfCancellationRequested();
                await ActivateAsync(store.CapturePublished(), stopping.Token);
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        finally
        {
            store.Published -= OnPublished; store.Updated -= OnUpdated;
            Generation? prior;
            lock (gate) prior = active;
            if (prior is not null) await StopGenerationAsync(prior, "shutdown");
            TryCancel(lifetime);
            Task[] manual;
            lock (gate) manual = activeRuns.Values.Select(run => run.Done.Task).ToArray();
            await Task.WhenAll(manual);
            Task writer; lock (gate) writer = journalWriter;
            await writer;
        }
    }
    private async Task ActivateAsync(JsonObject? snapshot, CancellationToken cancellation)
    {
        var generation = new Generation(snapshot, cancellation);
        foreach (var definition in ScriptResourceStore.Resources(snapshot).Where(item => ProjectStore.Required(item, "type") == "gateway" && ScriptResourceStore.Enabled(item)))
        {
            var resource = new Resource(definition.DeepClone().AsObject());
            resource.Lane = resource.Shared ? generation.Shared : new Lane();
            generation.Resources.Add(resource.Id, resource);
        }
        lock (gate)
        {
            active = generation; states.Clear();
            foreach (var resource in ScriptResourceStore.Resources(snapshot).Where(item => ProjectStore.Required(item, "type") == "gateway"))
                states[ProjectStore.Required(resource, "id")] = new()
                {
                    ["id"] = resource["id"]!.DeepClone(), ["name"] = resource["name"]!.DeepClone(),
                    ["event"] = resource["event"]!.DeepClone(), ["enabled"] = ScriptResourceStore.Enabled(resource),
                    ["running"] = false, ["nextRunAt"] = null, ["lastRunAt"] = null, ["lastSuccess"] = null,
                    ["currentRunId"] = null, ["queued"] = 0, ["missedEvents"] = 0L, ["executionCount"] = 0L
                };
        }
        foreach (var lane in generation.Resources.Values.Select(resource => resource.Lane).Append(generation.Shared).Distinct())
            generation.Tasks.Add(ConsumeAsync(generation, lane));
        try
        {
            // Declaration-order startup completes before recurring work or external messages.
            foreach (var resource in generation.Resources.Values.Where(item => item.Event == "startup"))
                await EnqueueAutomatic(generation, resource, Context("startup"));
            generation.Cancellation.Token.ThrowIfCancellationRequested();
            generation.Accepting = true;
            if (generation.Resources.Values.Any(item => item.Event == "tagChange"))
            {
                var tagResources = generation.Resources.Values.Where(item => item.Event == "tagChange").ToArray();
                // Tag delivery is serialized outside the engine state monitor;
                // callbacks must still enqueue promptly for other consumers.
                generation.TagHandler = (previous, current) =>
                {
                    if (!generation.Accepting) return;
                    var recipients = tagResources.Where(item => MatchesTag(item, current.Path)).ToArray();
                    if (recipients.Length > 0 && !generation.Tags.Writer.TryWrite(new(previous, current, recipients)))
                        foreach (var recipient in recipients) Interlocked.Increment(ref recipient.DroppedTagNotifications);
                };
                generation.Tasks.Add(ConsumeTagsAsync(generation, tags.SubscribeWithSnapshot(generation.TagHandler)));
            }
            generation.Tasks.Add(ConsumeUpdatesAsync(generation));
            foreach (var resource in generation.Resources.Values.Where(item => item.Event is "timer" or "scheduled"))
                generation.Tasks.Add(RunClockAsync(generation, resource));
            if (store.Metadata()["publishedAt"]?.GetValue<string>() != generation.Stamp)
            { generation.Accepting = false; TryCancel(generation.Cancellation); publications.Writer.TryWrite(true); }
        }
        catch (OperationCanceledException) when (generation.Cancellation.IsCancellationRequested) { }
    }
    private async Task StopGenerationAsync(Generation generation, string reason)
    {
        generation.Accepting = false;
        if (generation.TagHandler is not null) tags.ValueChanged -= generation.TagHandler;
        TryCancel(generation.Cancellation);
        generation.Updates.Writer.TryComplete(); generation.Tags.Writer.TryComplete();
        foreach (var lane in generation.Resources.Values.Select(resource => resource.Lane).Append(generation.Shared).Distinct()) lane.Queue.Writer.TryComplete();
        await Task.WhenAll(generation.Tasks);
        Task[] running;
        lock (gate) running = activeRuns.Values.Where(run => run.Generation == generation).Select(run => run.Done.Task).ToArray();
        await Task.WhenAll(running);
        // Old code/libraries get one aggregate ten-second shutdown window. New code waits.
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        foreach (var resource in generation.Resources.Values.Where(item => item.Event == "shutdown"))
        {
            if (deadline.IsCancellationRequested) break;
            var context = Context("shutdown"); context["reason"] = reason;
            try
            {
                await RunCoreAsync(generation, resource, generation.Revision!.Value, "published", "shutdown",
                    ScriptResourceStore.ResolveParameters(resource.Definition, null), generation.Libraries, context, deadline.Token, [], true);
            }
            catch (OperationCanceledException) when (deadline.IsCancellationRequested) { break; }
        }
        lock (gate)
        {
            if (active == generation) active = null;
            foreach (var state in states.Values) { state["running"] = false; state["nextRunAt"] = null; state["currentRunId"] = null; state["queued"] = 0; }
        }
        generation.Cancellation.Dispose();
    }
    private async Task ConsumeAsync(Generation generation, Lane lane)
    {
        try
        {
            await foreach (var work in lane.Queue.Reader.ReadAllAsync(generation.Cancellation.Token))
            {
                lock (gate) ChangeQueued(work.Resource.Id, -1);
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(generation.Cancellation.Token, work.Caller);
                try
                {
                    using var access = PythonExecutionAccess.Enter(work.Access);
                    linked.Token.ThrowIfCancellationRequested();
                    var result = await RunCoreAsync(generation, work.Resource, work.Revision, work.Source, work.Trigger, work.Parameters,
                        work.Libraries, work.Context, linked.Token, work.Chain, work.WaitForLease, work.Queries);
                    work.Completion.TrySetResult(result);
                }
                catch (OperationCanceledException) { work.Completion.TrySetCanceled(linked.Token); }
                catch (Exception error) { work.Completion.TrySetException(error); }
            }
        }
        catch (OperationCanceledException) when (generation.Cancellation.IsCancellationRequested) { }
        finally
        {
            while (lane.Queue.Reader.TryRead(out var work))
            {
                lock (gate) ChangeQueued(work.Resource.Id, -1);
                work.Completion.TrySetCanceled(generation.Cancellation.Token);
            }
        }
    }
    private Task<JsonObject> Enqueue(Generation generation, Resource resource, JsonObject context,
        Dictionary<string, JsonElement> parameters, string source, string trigger, int revision,
        IReadOnlyDictionary<string, string> libraries, CancellationToken caller, string[] chain, bool waitForLease, JsonArray? queryDefinitions = null)
    {
        generation.Cancellation.Token.ThrowIfCancellationRequested(); caller.ThrowIfCancellationRequested();
        var completion = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
        var work = new Work(resource, context, parameters, source, trigger, revision, libraries, caller, chain.ToArray(), waitForLease, completion, queryDefinitions, PythonExecutionAccess.Current);
        lock (gate)
        {
            if (!resource.Lane.Queue.Writer.TryWrite(work))
            { Missed(resource); throw new InvalidOperationException("The gateway script execution queue is full. Try again later."); }
            ChangeQueued(resource.Id, 1);
        }
        // A queued request must respect its caller's deadline without waiting for a
        // busy lane. The consumer checks the same token before any execution.
        Observe(completion.Task);
        return caller.CanBeCanceled ? completion.Task.WaitAsync(caller) : completion.Task;
    }
    private async Task<JsonObject> EnqueueAutomatic(Generation generation, Resource resource, JsonObject context)
    {
        try
        {
            return await Enqueue(generation, resource, context, ScriptResourceStore.ResolveParameters(resource.Definition, null),
                "published", resource.Event, generation.Revision!.Value, generation.Libraries, generation.Cancellation.Token, [], true);
        }
        catch (InvalidOperationException error)
        {
            logger.LogWarning(error, "Gateway event {ResourceId} was not queued", resource.Id);
            return new() { ["success"] = false, ["stderr"] = error.Message };
        }
    }
    private async Task RunClockAsync(Generation generation, Resource resource)
    {
        var cancellation = generation.Cancellation.Token;
        var fixedRate = ProjectStore.Optional(resource.Definition, "delayType") == "fixedRate";
        var interval = resource.Definition["intervalMs"]?.GetValue<int>() ?? 1000;
        var clock = Stopwatch.StartNew();
        var nextTick = (long)interval;
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                DateTimeOffset due;
                if (resource.Event == "scheduled")
                {
                    var next = ScriptCron.Next(ProjectStore.Required(resource.Definition, "cron"),
                        ProjectStore.Optional(resource.Definition, "timeZone") ?? "local", DateTimeOffset.UtcNow);
                    if (next is null) throw new InvalidOperationException("No scheduled occurrence exists within the supported calendar horizon.");
                    due = next.Value;
                }
                else due = DateTimeOffset.UtcNow.AddMilliseconds(fixedRate ? Math.Max(0, nextTick - clock.ElapsedMilliseconds) : interval);
                lock (gate) if (states.TryGetValue(resource.Id, out var state)) state["nextRunAt"] = due.ToString("O");
                if (resource.Event == "scheduled") await DelayUntilAsync(due, cancellation);
                else await Task.Delay(TimeSpan.FromMilliseconds(fixedRate ? Math.Max(0, nextTick - clock.ElapsedMilliseconds) : interval), cancellation);
                var context = Context(resource.Event); context["scheduledAt"] = due.ToString("O");
                await EnqueueAutomatic(generation, resource, context);
                if (resource.Event == "scheduled")
                {
                    var after = DateTimeOffset.UtcNow; var cursor = due; long skipped = 0;
                    while (ScriptCron.Next(ProjectStore.Required(resource.Definition, "cron"), ProjectStore.Optional(resource.Definition, "timeZone") ?? "local", cursor) is { } occurrence && occurrence <= after)
                    { skipped++; cursor = occurrence; }
                    if (skipped > 0) lock (gate) Missed(resource, skipped);
                }
                if (fixedRate)
                {
                    var following = nextTick + interval;
                    var now = clock.ElapsedMilliseconds;
                    if (following <= now)
                    {
                        var skipped = (now - following) / interval + 1;
                        lock (gate) Missed(resource, skipped);
                        following += skipped * interval;
                    }
                    nextTick = following;
                }
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        catch (Exception error) { logger.LogError(error, "Script event {ResourceId} stopped unexpectedly", resource.Id); }
        finally { lock (gate) if (states.TryGetValue(resource.Id, out var state)) state["nextRunAt"] = null; }
    }
    private static async Task DelayUntilAsync(DateTimeOffset due, CancellationToken cancellation)
    {
        while (due > DateTimeOffset.UtcNow)
        {
            var remaining = due - DateTimeOffset.UtcNow;
            if (remaining > TimeSpan.Zero) await Task.Delay(remaining > TimeSpan.FromSeconds(30) ? TimeSpan.FromSeconds(30) : remaining, cancellation);
        }
        cancellation.ThrowIfCancellationRequested();
    }
    private async Task ConsumeUpdatesAsync(Generation generation)
    {
        try
        {
            await foreach (var notice in generation.Updates.Reader.ReadAllAsync(generation.Cancellation.Token))
                foreach (var resource in generation.Resources.Values.Where(item => item.Event == "update"))
                {
                    var context = Context("update"); context["actor"] = notice.Actor; context["reason"] = notice.Reason;
                    context["resources"] = notice.Resources.DeepClone();
                    await EnqueueAutomatic(generation, resource, context);
                }
        }
        catch (OperationCanceledException) when (generation.Cancellation.IsCancellationRequested) { }
    }
    private static bool MatchesTag(Resource resource, string path)
        => resource.Definition["tagPaths"]!.AsArray().Any(node => node?.GetValue<string>() is { } pattern &&
            (pattern.EndsWith("/*", StringComparison.Ordinal) ? path.StartsWith(pattern[..^1], StringComparison.Ordinal) : path == pattern));
    private async Task ConsumeTagsAsync(Generation generation, TagValue[] initial)
    {
        var resources = generation.Resources.Values.Where(item => item.Event == "tagChange").ToArray();
        // The tag engine subscribes and captures atomically. Source timestamps may move
        // backward, so arrival order, never timestamp comparison, determines delivery.
        try
        {
            foreach (var value in initial)
                foreach (var resource in resources.Where(item => MatchesTag(item, value.Path))) QueueTag(generation, resource, null, value, true);
            await foreach (var notice in generation.Tags.Reader.ReadAllAsync(generation.Cancellation.Token))
            {
                foreach (var resource in notice.Recipients)
                {
                    var dropped = Interlocked.Exchange(ref resource.DroppedTagNotifications, 0);
                    if (dropped > 0) lock (gate) Missed(resource, dropped);
                    QueueTag(generation, resource, notice.Previous, notice.Current, false);
                }
            }
        }
        catch (OperationCanceledException) when (generation.Cancellation.IsCancellationRequested) { }
    }
    private void QueueTag(Generation generation, Resource resource, TagValue? previous, TagValue current, bool initial)
    {
        var changes = new List<string>();
        if (previous is null || !JsonNode.DeepEquals(JsonSerializer.SerializeToNode(previous.Value), JsonSerializer.SerializeToNode(current.Value))) changes.Add("value");
        if (previous is null || previous.Quality != current.Quality) changes.Add("quality");
        if (previous is null || previous.Timestamp != current.Timestamp) changes.Add("timestamp");
        if (!initial && !resource.Definition["changeTriggers"]!.AsArray().Any(node => changes.Contains(node!.GetValue<string>(), StringComparer.Ordinal))) return;
        var context = Context("tagChange"); context["tagPath"] = current.Path; context["initialChange"] = initial;
        context["previousValue"] = previous is null ? null : JsonSerializer.SerializeToNode(previous, ProjectStore.Json);
        context["newValue"] = JsonSerializer.SerializeToNode(current, ProjectStore.Json);
        context["changes"] = new JsonArray(changes.Select(change => (JsonNode?)JsonValue.Create(change)).ToArray());
        try
        {
            Observe(Enqueue(generation, resource, context, ScriptResourceStore.ResolveParameters(resource.Definition, null),
                "published", "tagChange", generation.Revision!.Value, generation.Libraries, generation.Cancellation.Token, [], true));
        }
        catch (InvalidOperationException) { /* Enqueue already increments missedEvents. */ }
        catch (OperationCanceledException) { }
    }
    private async Task<JsonObject> RunCoreAsync(Generation? generation, Resource resource, int revision, string source, string trigger,
        Dictionary<string, JsonElement> parameters, IReadOnlyDictionary<string, string> libraries, JsonObject context,
        CancellationToken cancellation, string[] chain, bool waitForLease, JsonArray? queryDefinitions = null)
    {
        cancellation.ThrowIfCancellationRequested();
        ExecutionLease lease;
        lock (gate)
        {
            if (!leases.TryGetValue(resource.Id, out lease!)) leases.Add(resource.Id, lease = new());
            lease.Users++;
        }
        var acquired = false;
        try
        {
            if (waitForLease) { await lease.Semaphore.WaitAsync(cancellation); acquired = true; }
            else if (!(acquired = await lease.Semaphore.WaitAsync(0, cancellation))) throw new InvalidOperationException("This script resource is already running.");
            cancellation.ThrowIfCancellationRequested();
            using var runCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            var clock = Stopwatch.StartNew();
            var runId = Guid.NewGuid().ToString("N");
            var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var entry = new JsonObject
            {
                ["runId"] = runId, ["resourceId"] = resource.Id, ["name"] = resource.Definition["name"]!.DeepClone(),
                ["type"] = resource.Definition["type"]!.DeepClone(), ["event"] = trigger, ["source"] = source, ["revision"] = revision,
                ["actor"] = context["actor"]?.DeepClone(), ["reason"] = context["reason"]?.DeepClone(), ["projectId"] = MessageScope,
                ["startedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["finishedAt"] = null,
                ["status"] = "running", ["success"] = null, ["stdout"] = "", ["stderr"] = "", ["durationMs"] = 0
            };
            // Correlate deliveries without retaining message payloads, parameters or tag values.
            foreach (var field in new[] { "messageId", "tagPath", "scheduledAt" })
                if (context[field] is { } value) entry[field] = value.DeepClone();
            lock (gate)
            {
                context["executionCount"] = resource.Executions++;
                context["missedEvents"] = resource.Missed; resource.Missed = 0;
                context["runId"] = runId; context["revision"] = revision;
                entry["executionCount"] = context["executionCount"]!.DeepClone();
                entry["missedEvents"] = context["missedEvents"]!.DeepClone();
                activeRuns.Add(runId, new(runCancellation, done, generation, resource.Id, resource.Shared));
                logs.AddLast(entry); while (logs.Count > 100) logs.RemoveFirst();
                if (states.TryGetValue(resource.Id, out var state))
                {
                    state["running"] = true; state["nextRunAt"] = null; state["currentRunId"] = runId;
                    state["lastRunAt"] = entry["startedAt"]!.DeepClone(); state["executionCount"] = resource.Executions;
                }
                PersistLog(entry);
            }
            try
            {
                runCancellation.Token.ThrowIfCancellationRequested();
                var nextChain = chain.Append(Identity(resource.Id)).ToArray();
                var result = await python.RunWithLibrariesAsync(ProjectStore.Optional(resource.Definition, "code") ?? "", parameters, null,
                    libraries, runCancellation.Token, queryDefinitions: queryDefinitions ?? (source == "published" ? generation?.Snapshot?["queries"] as JsonArray : null), eventContext: context, timeoutMs: resource.Definition["timeoutMs"]?.GetValue<int>() ?? 10_000, messageChain: nextChain);
                Complete(entry, result["success"]?.GetValue<bool>() == true ? "succeeded" : "failed", result, clock.Elapsed.TotalMilliseconds);
                return result;
            }
            catch (OperationCanceledException)
            {
                var result = new JsonObject { ["success"] = false, ["stdout"] = "", ["stderr"] = "Script execution was cancelled.", ["durationMs"] = clock.Elapsed.TotalMilliseconds };
                Complete(entry, "cancelled", result, clock.Elapsed.TotalMilliseconds);
                if (cancellation.IsCancellationRequested) throw;
                return result;
            }
            catch (Exception error)
            {
                var result = new JsonObject { ["success"] = false, ["stdout"] = "", ["stderr"] = error.Message, ["durationMs"] = clock.Elapsed.TotalMilliseconds };
                Complete(entry, "failed", result, clock.Elapsed.TotalMilliseconds);
                return result;
            }
            finally
            {
                lock (gate)
                {
                    activeRuns.Remove(runId);
                    if (states.TryGetValue(resource.Id, out var state)) { state["running"] = false; state["currentRunId"] = null; }
                }
                done.TrySetResult();
            }
        }
        finally
        {
            if (acquired) lease.Semaphore.Release();
            lock (gate) if (--lease.Users == 0) { leases.Remove(resource.Id); lease.Semaphore.Dispose(); }
        }
    }
    private void Complete(JsonObject entry, string status, JsonObject result, double duration)
    {
        lock (gate)
        {
            entry["status"] = status; entry["success"] = result["success"]?.DeepClone() ?? JsonValue.Create(false);
            entry["finishedAt"] = DateTimeOffset.UtcNow.ToString("O"); entry["durationMs"] = duration;
            entry["stdout"] = Truncate(result["stdout"]?.GetValue<string>() ?? ""); entry["stderr"] = Truncate(result["stderr"]?.GetValue<string>() ?? "");
            if (result["result"] is { } value)
            {
                if (value.ToJsonString().Length <= 8192) entry["result"] = value.DeepClone(); else entry["resultTruncated"] = true;
            }
            if (states.TryGetValue(entry["resourceId"]!.GetValue<string>(), out var state)) state["lastSuccess"] = entry["success"]!.DeepClone();
            PersistLog(entry);
        }
    }
    private void PersistLog(JsonObject entry)
    {
        if (!journalAvailable) return;
        journalPending[entry["runId"]!.GetValue<string>()] = entry.DeepClone().AsObject();
        var retained = logs.Select(item => item["runId"]!.GetValue<string>()).ToHashSet(StringComparer.Ordinal);
        foreach (var id in journalPending.Keys.Where(id => !retained.Contains(id)).ToArray()) journalPending.Remove(id);
        if (journalWriter.IsCompleted) journalWriter = Task.Run(WriteJournalAsync);
    }
    private async Task WriteJournalAsync()
    {
        // Coalesce transitions for 250 ms. Filesystem flushes never own the scheduler lock.
        await Task.Delay(250);
        while (true)
        {
            JsonObject[] entries;
            lock (gate)
            {
                entries = journalPending.Values.ToArray(); journalPending.Clear();
                if (entries.Length == 0) { journalWriter = Task.CompletedTask; return; }
            }
            try { journal.Append(entries); lock (gate) journalError = null; }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                lock (gate) journalError = "Execution history could not be persisted. Check project storage.";
                logger.LogError(error, "Could not persist script execution history");
            }
            await Task.Delay(250);
        }
    }
    private JsonObject Context(string trigger) => new()
    { ["type"] = trigger, ["reason"] = trigger, ["timestamp"] = DateTimeOffset.UtcNow.ToString("O"), ["projectId"] = MessageScope, ["actor"] = "gateway-script" };
    private string Identity(string resourceId) => MessageScope + ":" + resourceId;
    private bool Busy(string id) => activeRuns.Values.Any(run => run.ResourceId == id) || states.TryGetValue(id, out var state) && (state["queued"]?.GetValue<int>() ?? 0) > 0;
    private void ChangeQueued(string id, int delta) { if (states.TryGetValue(id, out var state)) state["queued"] = Math.Max(0, (state["queued"]?.GetValue<int>() ?? 0) + delta); }
    private void Missed(Resource resource, long count = 1)
    {
        resource.Missed += count;
        if (states.TryGetValue(resource.Id, out var state)) state["missedEvents"] = (state["missedEvents"]?.GetValue<long>() ?? 0) + count;
    }
    private static void TryCancel(CancellationTokenSource cancellation) { try { cancellation.Cancel(); } catch (ObjectDisposedException) { } }
    private static void Observe(Task task) => _ = task.ContinueWith(completed => { _ = completed.Exception; }, CancellationToken.None,
        TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
    private static string Truncate(string value) => value.Length <= 8192 ? value : value[..8192] + "\n[Output truncated]";
}
