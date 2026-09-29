using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

public record TagValue(string Path, object? Value, string DataType, string Quality, DateTimeOffset Timestamp, string Source);

public sealed class TagEngine(ProjectStore store, ConnectorService connectors, ILogger<TagEngine> logger) : BackgroundService
{
    private readonly ConcurrentDictionary<string, TagValue> values = new(StringComparer.Ordinal);
    private readonly DateTimeOffset started = DateTimeOffset.UtcNow;
    private readonly ConcurrentDictionary<string, WatchRegistration> watches = new(StringComparer.Ordinal);
    private readonly object stateGate = new();
    private long configurationGeneration;
    private sealed record Binding(string Path, string NodeId);
    private sealed record WatchPlan(string Key, ConnectionDefinition Connection, int Interval, Binding[] Bindings)
    {
        public bool Matches(WatchPlan other) => Connection == other.Connection && Interval == other.Interval && Bindings.SequenceEqual(other.Bindings);
    }
    private sealed class WatchRegistration(WatchPlan plan, CancellationTokenSource cancellation)
    {
        public readonly WatchPlan Plan = plan;
        public readonly CancellationTokenSource Cancellation = cancellation;
        public Task Completion = Task.CompletedTask;
        public bool Active = true;
        public string State = "Connecting";
        public DateTimeOffset? LastNotification;
        public Task? CancellationRequested;
    }
    public TagValue[] Snapshot() => values.Values.OrderBy(x => x.Path, StringComparer.Ordinal).ToArray();
    public JsonObject SaveDefinition(JsonObject definition)
    {
        lock (stateGate)
        {
            var saved = store.SaveTag(definition);
            var path = ProjectStore.Required(saved, "path");
            InvalidateWatches(watch => watch.Plan.Bindings.Any(binding => binding.Path == path));
            configurationGeneration++;
            if (ProjectStore.Required(saved, "kind") == "memory") values[path] = MemoryValue(saved, DateTimeOffset.UtcNow);
            else
            {
                var disabled = store.GetConnections().OfType<JsonObject>().Any(item => ProjectStore.Optional(item, "id") == ProjectStore.Optional(saved, "connectionId") && item["enabled"]?.GetValue<bool>() == false);
                SetUnavailable(path, saved["enabled"]?.GetValue<bool>() == false || disabled ? "Bad_Disabled" : "Bad_WaitingForInitialData");
            }
            return saved;
        }
    }
    public bool DeleteDefinition(string path)
    {
        lock (stateGate)
        {
            if (!store.DeleteTag(path)) return false;
            InvalidateWatches(watch => watch.Plan.Bindings.Any(binding => binding.Path == path));
            configurationGeneration++;
            values.TryRemove(path, out _);
            return true;
        }
    }
    public JsonObject SaveConnection(JsonObject connection)
    {
        lock (stateGate)
        {
            var saved = store.SaveConnection(connection);
            var id = ProjectStore.Required(saved, "id");
            InvalidateWatches(watch => watch.Plan.Connection.Id == id);
            foreach (var definition in store.GetTagDefinitions().OfType<JsonObject>().Where(item => ProjectStore.Optional(item, "connectionId") == id))
                SetUnavailable(ProjectStore.Required(definition, "path"), saved["enabled"]?.GetValue<bool>() == false || definition["enabled"]?.GetValue<bool>() == false ? "Bad_Disabled" : "Bad_WaitingForInitialData");
            configurationGeneration++;
            return saved;
        }
    }
    private void InvalidateWatches(Func<WatchRegistration, bool> matches)
    {
        foreach (var watch in watches.Values.Where(watch => watch.Active && matches(watch)))
        {
            watch.Active = false;
            watch.State = "Reconfiguring";
            watch.CancellationRequested ??= watch.Cancellation.CancelAsync();
            foreach (var binding in watch.Plan.Bindings) SetUnavailable(binding.Path, "Bad_WaitingForInitialData");
        }
    }
    public object SubscriptionSnapshot()
    {
        lock (stateGate)
            return watches.Values.Select(watch => new
            {
                connectionId = watch.Plan.Connection.Id, publishingIntervalMs = watch.Plan.Interval,
                tagCount = watch.Plan.Bindings.Length, state = watch.State, lastNotificationAt = watch.LastNotification
            }).ToArray();
    }
    public static string Resolve(string path, IReadOnlyDictionary<string, JsonElement>? parameters)
    {
        if (path.Length > 1024) throw new ArgumentException("Tag path is too long.");
        return Regex.Replace(path, "\\{([A-Za-z_][A-Za-z0-9_]*)\\}", match =>
        {
            if (parameters is null || !parameters.TryGetValue(match.Groups[1].Value, out var value)) throw new ArgumentException($"Missing binding parameter: {match.Groups[1].Value}");
            var text = TemplateParameterTypes.ScalarText(value);
            if (text.IndexOfAny(['{', '}', '[', ']', '\\']) >= 0 || text.Contains("..")) throw new ArgumentException("Invalid tag binding parameter.");
            return text;
        });
    }
    public TagValue[] Read(IEnumerable<string> paths, IReadOnlyDictionary<string, JsonElement>? parameters) => paths.Select(path =>
    {
        var resolved = Resolve(path, parameters);
        return values.TryGetValue(resolved, out var value) ? value : new TagValue(resolved, null, "Unknown", "Bad_NotFound", DateTimeOffset.UtcNow, "unknown");
    }).ToArray();
    public string[] WriteMemory(string[] paths, JsonElement[] input)
    {
        if (paths.Length != input.Length) throw new ArgumentException("Paths and values must have equal lengths.");
        return paths.Select((path, index) =>
        {
            lock (stateGate)
            {
                if (path == "[default]Setpoints/TargetSpeed")
                {
                    if (input[index].ValueKind != JsonValueKind.Number || !input[index].TryGetDouble(out var number) || !double.IsFinite(number) || number < 0 || number > 500) return "Bad_OutOfRange";
                    values[path] = new(path, number, "Double", "Good", DateTimeOffset.UtcNow, "memory"); return "Good";
                }
                try
                {
                    var saved = store.WriteMemoryTag(path, input[index]);
                    values[path] = MemoryValue(saved, DateTimeOffset.UtcNow);
                    return "Good";
                }
                catch (KeyNotFoundException) { return "Bad_NotFound"; }
                catch (ArgumentException) { return "Bad_NotWritable"; }
            }
        }).ToArray();
    }
    private void UpdateSamples()
    {
        var now = DateTimeOffset.UtcNow;
        var seconds = (now - started).TotalSeconds;
        values.TryAdd("[default]Setpoints/TargetSpeed", new("[default]Setpoints/TargetSpeed", 85d, "Double", "Good", now, "memory"));
        for (var line = 1; line <= 2; line++)
        {
            void Set(string name, object value, string type) { var p = $"[default]Line/Line{line}/{name}"; values[p] = new(p, value, type, "Good", now, "simulated"); }
            Set("Speed", Math.Round(72 + line * 8 + Math.Sin(seconds / 7 + line) * 7, 1), "Double");
            Set("Temperature", Math.Round(38 + line * 4 + Math.Sin(seconds / 14 + line) * 3, 1), "Double");
            Set("ProductionCount", 12000 + line * 1600 + (int)(seconds * (line + 1)), "Int32");
            Set("Status", "Running", "String");
        }
    }
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        => await Task.WhenAll(SampleLoop(stoppingToken), DefinitionLoop(stoppingToken));
    private async Task SampleLoop(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            UpdateSamples();
            await Task.Delay(1000, stoppingToken);
        }
    }
    private static TagValue MemoryValue(JsonObject definition, DateTimeOffset timestamp)
    {
        var path = ProjectStore.Required(definition, "path");
        return new(path, definition["value"]?.Deserialize<JsonElement>(), ProjectStore.Required(definition, "dataType"),
            definition["enabled"]?.GetValue<bool>() == false ? "Bad_Disabled" : "Good", timestamp, "memory");
    }

    private async Task DefinitionLoop(CancellationToken stoppingToken)
    {
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                JsonObject[] definitions;
                HashSet<string> disabledConnections;
                long generation;
                lock (stateGate)
                {
                    generation = configurationGeneration;
                    definitions = store.GetTagDefinitions().OfType<JsonObject>().ToArray();
                    disabledConnections = store.GetConnections().OfType<JsonObject>().Where(item => item["enabled"]?.GetValue<bool>() == false)
                        .Select(item => ProjectStore.Required(item, "id")).ToHashSet(StringComparer.Ordinal);
                    foreach (var definition in definitions.Where(definition => ProjectStore.Optional(definition, "kind") == "memory"))
                    {
                        var next = MemoryValue(definition, DateTimeOffset.UtcNow);
                        if (values.TryGetValue(next.Path, out var previous) && previous.Source == "memory"
                            && previous.Quality == next.Quality && previous.DataType == next.DataType
                            && JsonSerializer.Serialize(previous.Value) == JsonSerializer.Serialize(next.Value))
                            next = next with { Timestamp = previous.Timestamp };
                        values[next.Path] = next;
                    }
                }
                var plans = definitions.Where(definition => ProjectStore.Optional(definition, "kind") != "memory" && definition["enabled"]?.GetValue<bool>() != false
                        && !disabledConnections.Contains(ProjectStore.Required(definition, "connectionId")))
                    .GroupBy(definition => (ConnectionId: ProjectStore.Required(definition, "connectionId"), Interval: definition["publishingIntervalMs"]?.GetValue<int>() ?? 1000))
                    .Select(group => new WatchPlan($"{group.Key.ConnectionId}\n{group.Key.Interval}", store.GetConnection(group.Key.ConnectionId, allowDisabled: true), group.Key.Interval,
                        group.Select(definition => new Binding(ProjectStore.Required(definition, "path"), ProjectStore.Required(definition, "nodeId"))).OrderBy(binding => binding.Path, StringComparer.Ordinal).ToArray()))
                    .ToDictionary(plan => plan.Key, StringComparer.Ordinal);

                // Configuration changes cancel the old generation before installing a new subscription.
                foreach (var pair in watches.ToArray())
                {
                    if (plans.TryGetValue(pair.Key, out var desired) && pair.Value.Active && pair.Value.Plan.Matches(desired) && !pair.Value.Completion.IsCompleted) continue;
                    await StopWatch(pair.Value);
                    watches.TryRemove(pair.Key, out _);
                }
                lock (stateGate)
                {
                    if (generation != configurationGeneration) continue;
                    var definedPaths = definitions.Select(definition => ProjectStore.Required(definition, "path")).ToHashSet(StringComparer.Ordinal);
                    foreach (var path in values.Keys.Where(path => !path.StartsWith("[default]Line/") && !path.StartsWith("[default]Setpoints/") && !definedPaths.Contains(path)))
                        values.TryRemove(path, out _);
                    foreach (var definition in definitions.Where(definition => ProjectStore.Optional(definition, "kind") != "memory" && (definition["enabled"]?.GetValue<bool>() == false
                        || disabledConnections.Contains(ProjectStore.Required(definition, "connectionId")))))
                        SetUnavailable(ProjectStore.Required(definition, "path"), "Bad_Disabled");
                    foreach (var plan in plans.Values)
                    {
                        if (watches.ContainsKey(plan.Key)) continue;
                        if (watches.Count >= 32)
                        {
                            foreach (var binding in plan.Bindings) SetUnavailable(binding.Path, "Bad_ResourceUnavailable");
                            continue;
                        }
                        var watch = new WatchRegistration(plan, CancellationTokenSource.CreateLinkedTokenSource(stoppingToken));
                        foreach (var binding in plan.Bindings) SetUnavailable(binding.Path, "Bad_WaitingForInitialData");
                        watches[plan.Key] = watch;
                        watch.Completion = RunWatch(watch);
                    }
                }
                await Task.Delay(500, stoppingToken);
            }
        }
        finally
        {
            await Task.WhenAll(watches.Values.Select(StopWatch));
            watches.Clear();
        }
    }

    private void SetUnavailable(string path, string quality)
    {
        values.TryGetValue(path, out var previous);
        values[path] = new(path, previous?.Value, previous?.DataType ?? "Unknown", quality, previous?.Timestamp ?? DateTimeOffset.UtcNow, "opcua");
    }

    private async Task RunWatch(WatchRegistration watch)
    {
        try
        {
            await connectors.WatchAsync(watch.Plan.Connection, watch.Plan.Bindings.Select(binding => binding.NodeId).Distinct().ToArray(), watch.Plan.Interval,
                batch =>
                {
                    lock (stateGate)
                    {
                        if (!watch.Active) return;
                        var byNode = batch.ToDictionary(value => value.NodeId, StringComparer.Ordinal);
                        foreach (var binding in watch.Plan.Bindings)
                            if (byNode.TryGetValue(binding.NodeId, out var value))
                                values[binding.Path] = new(binding.Path, value.Value, value.DataType, value.Quality, value.Timestamp, "opcua");
                        watch.LastNotification = DateTimeOffset.UtcNow;
                    }
                },
                status =>
                {
                    lock (stateGate)
                    {
                        if (!watch.Active) return;
                        watch.State = status;
                        if (status != "Connected")
                            foreach (var binding in watch.Plan.Bindings) SetUnavailable(binding.Path, "Bad_CommunicationError");
                    }
                }, watch.Cancellation.Token);
        }
        catch (OperationCanceledException) when (watch.Cancellation.IsCancellationRequested) { }
        catch (Exception error)
        {
            logger.LogWarning("OPC UA subscription failed ({ErrorType}); a new subscription will be attempted.", error.GetType().Name);
            lock (stateGate)
            {
                watch.State = "Error";
                if (watch.Active)
                    foreach (var binding in watch.Plan.Bindings) SetUnavailable(binding.Path, "Bad_CommunicationError");
            }
            try { await Task.Delay(5000, watch.Cancellation.Token); } catch (OperationCanceledException) { }
        }
    }

    private async Task StopWatch(WatchRegistration watch)
    {
        Task cancellation;
        lock (stateGate)
        {
            watch.Active = false;
            cancellation = watch.CancellationRequested ??= watch.Cancellation.CancelAsync();
        }
        await cancellation;
        try { await watch.Completion; }
        catch (OperationCanceledException) { }
        finally { watch.Cancellation.Dispose(); }
    }
}
