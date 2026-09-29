using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;

namespace SparkStudio.Gateway;

/// <summary>One fixed-delay task per published event; each resource has one execution lease.</summary>
public sealed class ScriptEventService(ScriptResourceStore store, PythonRunner python, ILogger<ScriptEventService> logger) : BackgroundService
{
    private readonly object gate = new();
    private readonly Channel<bool> publications = Channel.CreateBounded<bool>(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true });
    private readonly ConcurrentDictionary<string, SemaphoreSlim> leases = new(StringComparer.Ordinal);
    private readonly LinkedList<JsonObject> logs = new();
    private readonly Dictionary<string, JsonObject> states = new(StringComparer.Ordinal);
    private CancellationTokenSource? activation;
    private int? activeRevision;
    private string? activePublishedAt;

    public JsonArray Logs()
    {
        lock (gate) return new JsonArray(logs.Reverse().Select(entry => entry.DeepClone()).ToArray());
    }

    public JsonObject Status()
    {
        lock (gate) return new JsonObject
        {
            ["activeRevision"] = activeRevision, ["publishedAt"] = activePublishedAt,
            ["pythonAvailable"] = python.Available,
            ["resources"] = new JsonArray(states.Values.Select(state => state.DeepClone()).ToArray())
        };
    }

    public async Task<JsonObject> RunAsync(string id, ScriptRunRequest request, CancellationToken cancellation)
    {
        var run = store.CaptureRun(id, request.Revision, request.Source);
        var parameters = ScriptResourceStore.ResolveParameters(run.Resource, request.Parameters);
        return await RunCoreAsync(run.Resource, run.Revision, run.Source, "manual", parameters, run.Libraries, cancellation, waitForLease: false);
    }

    private void OnPublished()
    {
        CancellationTokenSource? prior;
        var revision = store.Metadata()["revision"]?.GetValue<int>();
        lock (gate) prior = activeRevision == revision ? null : activation;
        // In-flight old events are cancelled immediately; replacements wait for their exit.
        try { prior?.Cancel(); } catch (ObjectDisposedException) { }
        publications.Writer.TryWrite(true);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Task[] tasks = [];
        store.Published += OnPublished;
        publications.Writer.TryWrite(true);
        try
        {
            while (await publications.Reader.WaitToReadAsync(stoppingToken))
            {
                while (publications.Reader.TryRead(out _)) { }
                var snapshot = store.CapturePublished();
                var revision = snapshot is null ? (int?)null : ScriptResourceStore.Revision(snapshot);
                CancellationTokenSource? prior;
                lock (gate)
                {
                    if (activation is { IsCancellationRequested: false } && activeRevision == revision) continue;
                    prior = activation;
                }
                if (prior is not null) prior.Cancel();
                await AwaitTasks(tasks);
                prior?.Dispose();
                // Coalesce publications made while the old workers were stopping.
                snapshot = store.CapturePublished();
                revision = snapshot is null ? (int?)null : ScriptResourceStore.Revision(snapshot);
                var next = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                lock (gate)
                {
                    activation = next;
                    activeRevision = revision;
                    activePublishedAt = snapshot?["publishedAt"]?.GetValue<string>();
                    states.Clear();
                    foreach (var resource in ScriptResourceStore.Resources(snapshot).Where(item => ProjectStore.Required(item, "type") == "gateway"))
                        states[ProjectStore.Required(resource, "id")] = new JsonObject
                        {
                            ["id"] = resource["id"]!.DeepClone(), ["name"] = resource["name"]!.DeepClone(),
                            ["event"] = resource["event"]!.DeepClone(), ["enabled"] = ScriptResourceStore.Enabled(resource),
                            ["running"] = false, ["nextRunAt"] = null, ["lastRunAt"] = null, ["lastSuccess"] = null
                        };
                }
                var libraries = ScriptLibrary.Capture(snapshot);
                tasks = ScriptResourceStore.Resources(snapshot)
                    .Where(resource => ProjectStore.Required(resource, "type") == "gateway" && ScriptResourceStore.Enabled(resource))
                    .Select(resource => RunEventAsync(resource.DeepClone().AsObject(), revision!.Value, libraries, next.Token)).ToArray();
                // A publication arriving between capture and installing the new generation
                // must not remain active. The queued notification will replace it.
                var current = store.Metadata();
                if (current["revision"]?.GetValue<int>() != revision) next.Cancel();
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally
        {
            store.Published -= OnPublished;
            CancellationTokenSource? current;
            lock (gate) current = activation;
            current?.Cancel();
            await AwaitTasks(tasks);
            current?.Dispose();
            lock (gate)
            {
                activation = null;
                foreach (var state in states.Values) { state["running"] = false; state["nextRunAt"] = null; }
            }
        }
    }

    private static async Task AwaitTasks(Task[] tasks)
    {
        try { await Task.WhenAll(tasks); }
        catch (OperationCanceledException) { }
    }

    private async Task RunEventAsync(JsonObject resource, int revision, IReadOnlyDictionary<string, string> libraries, CancellationToken cancellation)
    {
        var id = ProjectStore.Required(resource, "id");
        var trigger = ProjectStore.Required(resource, "event");
        var parameters = ScriptResourceStore.ResolveParameters(resource, null);
        try
        {
            if (trigger == "startup")
            {
                await RunCoreAsync(resource, revision, "published", trigger, parameters, libraries, cancellation, waitForLease: true);
                return;
            }
            var interval = resource["intervalMs"]!.GetValue<int>();
            while (!cancellation.IsCancellationRequested)
            {
                lock (gate) if (states.TryGetValue(id, out var state)) state["nextRunAt"] = DateTimeOffset.UtcNow.AddMilliseconds(interval).ToString("O");
                await Task.Delay(interval, cancellation);
                await RunCoreAsync(resource, revision, "published", trigger, parameters, libraries, cancellation, waitForLease: true);
                // Fixed delay starts after completion, so slow scripts never queue a backlog.
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        catch (Exception error)
        {
            logger.LogError(error, "Script event {ResourceId} stopped unexpectedly", id);
        }
        finally
        {
            lock (gate) if (states.TryGetValue(id, out var state)) state["nextRunAt"] = null;
        }
    }

    private async Task<JsonObject> RunCoreAsync(JsonObject resource, int revision, string source, string trigger,
        Dictionary<string, JsonElement> parameters, IReadOnlyDictionary<string, string> libraries, CancellationToken cancellation, bool waitForLease)
    {
        var id = ProjectStore.Required(resource, "id");
        var lease = leases.GetOrAdd(id, _ => new SemaphoreSlim(1, 1));
        if (waitForLease) await lease.WaitAsync(cancellation);
        else if (!await lease.WaitAsync(0, cancellation)) throw new InvalidOperationException("This script resource is already running.");
        var clock = Stopwatch.StartNew();
        var entry = new JsonObject
        {
            ["runId"] = Guid.NewGuid().ToString("N"), ["resourceId"] = id,
            ["name"] = resource["name"]!.DeepClone(), ["type"] = resource["type"]!.DeepClone(),
            ["event"] = trigger, ["source"] = source, ["revision"] = revision,
            ["startedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["finishedAt"] = null,
            ["status"] = "running", ["success"] = null, ["stdout"] = "", ["stderr"] = "", ["durationMs"] = 0
        };
        lock (gate)
        {
            logs.AddLast(entry);
            while (logs.Count > 100) logs.RemoveFirst();
            if (states.TryGetValue(id, out var state)) { state["running"] = true; state["nextRunAt"] = null; state["lastRunAt"] = entry["startedAt"]!.DeepClone(); }
        }
        try
        {
            cancellation.ThrowIfCancellationRequested();
            var result = await python.RunWithLibrariesAsync(ProjectStore.Optional(resource, "code") ?? "", parameters, null, libraries, cancellation);
            Complete(entry, result["success"]?.GetValue<bool>() == true ? "succeeded" : "failed", result, clock.Elapsed.TotalMilliseconds);
            return result;
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            Complete(entry, "cancelled", new JsonObject { ["success"] = false, ["stderr"] = "Script execution was cancelled." }, clock.Elapsed.TotalMilliseconds);
            throw;
        }
        catch (Exception error)
        {
            var result = new JsonObject { ["success"] = false, ["stdout"] = "", ["stderr"] = error.Message, ["durationMs"] = clock.Elapsed.TotalMilliseconds };
            Complete(entry, "failed", result, clock.Elapsed.TotalMilliseconds);
            return result;
        }
        finally
        {
            lock (gate) if (states.TryGetValue(id, out var state)) state["running"] = false;
            lease.Release();
        }
    }

    private void Complete(JsonObject entry, string status, JsonObject result, double duration)
    {
        lock (gate)
        {
            entry["status"] = status;
            entry["success"] = result["success"]?.DeepClone() ?? JsonValue.Create(false);
            entry["finishedAt"] = DateTimeOffset.UtcNow.ToString("O");
            entry["durationMs"] = duration;
            entry["stdout"] = Truncate(result["stdout"]?.GetValue<string>() ?? "");
            entry["stderr"] = Truncate(result["stderr"]?.GetValue<string>() ?? "");
            if (result["result"] is { } value)
            {
                var serialized = value.ToJsonString();
                if (serialized.Length <= 8192) entry["result"] = value.DeepClone();
                else entry["resultTruncated"] = true;
            }
            if (states.TryGetValue(entry["resourceId"]!.GetValue<string>(), out var state)) state["lastSuccess"] = entry["success"]!.DeepClone();
        }
    }

    private static string Truncate(string value) => value.Length <= 8192 ? value : value[..8192] + "\n[Output truncated]";
}
