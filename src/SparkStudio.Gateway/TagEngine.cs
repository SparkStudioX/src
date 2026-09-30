using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

public record TagValue(string Path, object? Value, string DataType, string Quality, DateTimeOffset Timestamp, string Source);

public sealed class TagEngine(ProjectStore store, ConnectorService connectors, ILogger<TagEngine> logger, RecoveryQuarantine? recovery = null, bool enableDemoTags = false) : BackgroundService
{
    public bool DemoMode => enableDemoTags;
    private readonly ConcurrentDictionary<string, TagValue> values = new(StringComparer.Ordinal);
    private readonly DateTimeOffset started = DateTimeOffset.UtcNow;
    private readonly ConcurrentDictionary<string, WatchRegistration> watches = new(StringComparer.Ordinal);
    private readonly object stateGate = new();
    // Subscribers enqueue notifications only; Python never executes on the tag thread.
    public event Action<TagValue?, TagValue>? ValueChanged;
    private void SetValue(TagValue next)
    {
        using (ChangeState())
        {
            values.TryGetValue(next.Path, out var previous);
            values[next.Path] = next;
            var handlers = ValueChanged;
            if (handlers is null || previous is not null && previous.Quality == next.Quality && previous.Timestamp == next.Timestamp
                && SameValue(previous.Value, next.Value)) return;
            notifications.Enqueue((previous, next, handlers));
        }
    }
    private readonly object notificationGate = new();
    private readonly Queue<(TagValue? Previous, TagValue Current, Action<TagValue?, TagValue> Handlers)> notifications = new();
    private int mutationDepth;
    private bool drainingNotifications;
    private IDisposable ChangeState()
    {
        Monitor.Enter(stateGate); mutationDepth++;
        return new Mutation(this);
    }
    private sealed class Mutation(TagEngine engine) : IDisposable
    {
        public void Dispose()
        {
            var outermost = --engine.mutationDepth == 0;
            Monitor.Exit(engine.stateGate);
            if (outermost) engine.DrainNotifications();
        }
    }
    private void DrainNotifications()
    {
        lock (notificationGate)
        {
            if (drainingNotifications) return;
            drainingNotifications = true;
            try
            {
                while (true)
                {
                    (TagValue? Previous, TagValue Current, Action<TagValue?, TagValue> Handlers) notice;
                    lock (stateGate) { if (!notifications.TryDequeue(out notice)) return; }
                    // Capture recipients at mutation time so newly subscribing consumers
                    // cannot receive older queued updates after their atomic snapshot.
                    foreach (Action<TagValue?, TagValue> handler in notice.Handlers.GetInvocationList())
                        try { handler(notice.Previous, notice.Current); }
                        catch (Exception error) { logger.LogWarning("Tag event subscriber failed ({ErrorType}).", error.GetType().Name); }
                }
            }
            finally { drainingNotifications = false; }
        }
    }
    private void RemoveValue(string path)
    {
        using (ChangeState())
        {
            if (!values.TryGetValue(path, out var previous)) return;
            SetValue(previous with { Value = null, Quality = "Bad_NotFound", Timestamp = DateTimeOffset.UtcNow });
            values.TryRemove(path, out _);
        }
    }
    private long configurationGeneration;
    private long expressionGeneration = -1;
    private long definitionGeneration = -1;
    private JsonObject[] cachedDefinitions = [];
    private HashSet<string> cachedDisabledConnections = new(StringComparer.Ordinal);
    private Dictionary<string, WatchPlan> cachedPlans = new(StringComparer.Ordinal);
    private bool cachedRecovery;
    private readonly HashSet<string> capacityWarnings = new(StringComparer.Ordinal);
    public long DefinitionBuildCount { get; private set; }
    private void RefreshDefinitions()
    {
        // Definitions, connections and their generation belong to one committed
        // configuration. Never label a mixed capture with a newer generation.
        lock (GatewayConfigurationLock.SyncRoot)
        {
            var generation = store.TagConfigurationGeneration;
            if (generation == definitionGeneration && cachedRecovery == (recovery?.Active == true)) return;
            cachedDefinitions = store.GetRuntimeTagDefinitions().OfType<JsonObject>().ToArray();
            cachedDisabledConnections = store.GetConnections().OfType<JsonObject>().Where(item => item["enabled"]?.GetValue<bool>() == false)
                .Select(item => ProjectStore.Required(item, "id")).ToHashSet(StringComparer.Ordinal);
            cachedPlans = cachedDefinitions.Where(definition => recovery?.Active != true && TagDefinitionValidator.Kind(definition) == "opcua" && definition["enabled"]?.GetValue<bool>() != false
                    && !cachedDisabledConnections.Contains(ProjectStore.Required(definition, "connectionId")))
                .GroupBy(definition => (ConnectionId: ProjectStore.Required(definition, "connectionId"), Interval: definition["publishingIntervalMs"]?.GetValue<int>() ?? 1000, Deadband: TagDefinitionValidator.AbsoluteDeadband(definition), QueueSize: TagDefinitionValidator.MonitorQueueSize(definition)))
                .Select(group => new WatchPlan($"{group.Key.ConnectionId}\n{group.Key.Interval}\n{group.Key.Deadband:R}\n{group.Key.QueueSize}", store.GetConnection(group.Key.ConnectionId, allowDisabled: true), group.Key.Interval,
                    group.Select(definition => new Binding(ProjectStore.Required(definition, "path"), ProjectStore.Required(definition, "nodeId"), TagDefinitionValidator.AbsoluteDeadband(definition), TagDefinitionValidator.MonitorQueueSize(definition))).OrderBy(binding => binding.Path, StringComparer.Ordinal).ToArray()))
                .ToDictionary(plan => plan.Key, StringComparer.Ordinal);
            capacityWarnings.RemoveWhere(key => !cachedPlans.ContainsKey(key));
            definitionGeneration = generation; cachedRecovery = recovery?.Active == true; DefinitionBuildCount++;
        }
    }
    public static bool SameValue(object? left, object? right) => ReferenceEquals(left, right) ||
        (left is JsonElement a && right is JsonElement b ? JsonElement.DeepEquals(a, b) : Equals(left, right));
    private TagExpressions.Plan[] expressionPlans = [];
    private readonly Dictionary<string, DateTimeOffset> expressionDue = new(StringComparer.Ordinal);
    private sealed record Binding(string Path, string NodeId, double AbsoluteDeadband, uint QueueSize);
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
    public TagValue[] SubscribeWithSnapshot(Action<TagValue?, TagValue> handler)
    {
        lock (stateGate)
        {
            ValueChanged += handler;
            return Snapshot();
        }
    }
    public JsonObject SaveDefinition(JsonObject definition)
    {
        using (ChangeState())
        {
            var saved = store.SaveTag(definition);
            var path = ProjectStore.Required(saved, "path");
            InvalidateWatches(watch => watch.Plan.Bindings.Any(binding => binding.Path == path));
            configurationGeneration++;
            if (ProjectStore.Required(saved, "kind") == "memory") SetValue(MemoryValue(saved, DateTimeOffset.UtcNow));
            else if (ProjectStore.Required(saved, "kind") == "expression")
                SetValue(new(path, null, ProjectStore.Required(saved, "dataType"), saved["effectiveEnabled"]?.GetValue<bool>() == false ? "Bad_Disabled" : "Bad_WaitingForInitialData", DateTimeOffset.UtcNow, "expression"));
            else
            {
                var disabled = store.GetConnections().OfType<JsonObject>().Any(item => ProjectStore.Optional(item, "id") == ProjectStore.Optional(saved, "connectionId") && item["enabled"]?.GetValue<bool>() == false);
                SetUnavailable(path, recovery?.Active == true ? "Bad_RecoveryMode" : saved["effectiveEnabled"]?.GetValue<bool>() == false || disabled ? "Bad_Disabled" : "Bad_WaitingForInitialData");
            }
            return saved;
        }
    }
    public TagImportPreview ApplyImport(TagImportRequest request)
    {
        using (ChangeState())
        {
            var result = store.ApplyTagImport(request);
            var changed = result.Changes.Where(item => item.Action != "unchanged").Select(item => item.Path).ToHashSet(StringComparer.Ordinal);
            InvalidateWatches(watch => watch.Plan.Bindings.Any(binding => changed.Contains(binding.Path)));
            foreach (var removed in result.Changes.Where(item => item.Action == "remove" && item.Path.StartsWith("[default]", StringComparison.Ordinal))) RemoveValue(removed.Path);
            foreach (var definition in store.GetRuntimeTagDefinitions().OfType<JsonObject>().Where(item => changed.Contains(ProjectStore.Required(item, "path"))))
            {
                var path = ProjectStore.Required(definition, "path");
                if (TagDefinitionValidator.Kind(definition) == "memory") SetValue(MemoryValue(definition, DateTimeOffset.UtcNow));
                else SetValue(new(path, null, ProjectStore.Optional(definition, "dataType") ?? "Unknown", recovery?.Active == true && TagDefinitionValidator.Kind(definition) == "opcua" ? "Bad_RecoveryMode" : TagDefinitionValidator.Enabled(definition) ? "Bad_WaitingForInitialData" : "Bad_Disabled", DateTimeOffset.UtcNow, TagDefinitionValidator.Kind(definition)));
            }
            configurationGeneration++;
            return result;
        }
    }
    public bool DeleteDefinition(string path)
    {
        using (ChangeState())
        {
            if (!store.DeleteTag(path)) return false;
            InvalidateWatches(watch => watch.Plan.Bindings.Any(binding => binding.Path == path));
            configurationGeneration++;
            RemoveValue(path);
            return true;
        }
    }
    public JsonObject SaveConnection(JsonObject connection)
    {
        using (ChangeState())
        {
            var saved = store.SaveConnection(connection);
            var id = ProjectStore.Required(saved, "id");
            InvalidateWatches(watch => watch.Plan.Connection.Id == id);
            foreach (var definition in store.GetRuntimeTagDefinitions().OfType<JsonObject>().Where(item => ProjectStore.Optional(item, "connectionId") == id))
                SetUnavailable(ProjectStore.Required(definition, "path"), recovery?.Active == true ? "Bad_RecoveryMode" : saved["enabled"]?.GetValue<bool>() == false || definition["enabled"]?.GetValue<bool>() == false ? "Bad_Disabled" : "Bad_WaitingForInitialData");
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
    public object ProviderSnapshot()
    {
        lock (stateGate)
        {
            var definitions = store.GetRuntimeTagDefinitions().OfType<JsonObject>().ToArray();
            var configured = definitions.Select(tag => ProjectStore.Required(tag, "path")).ToHashSet(StringComparer.Ordinal);
            var snapshot = values.Values.Where(value => configured.Contains(value.Path)).ToArray();
            var enabled = store.DefaultTagProviderEnabled();
            var unavailable = definitions.Count(tag => TagDefinitionValidator.Enabled(tag) && (!values.TryGetValue(ProjectStore.Required(tag, "path"), out var value) || !value.Quality.StartsWith("Good", StringComparison.OrdinalIgnoreCase)));
            return new { name = "default", enabled, state = !enabled ? "Disabled" : unavailable > 0 ? "Degraded" : "Running", configuredTags = definitions.Length,
                goodTags = snapshot.Count(value => value.Quality.StartsWith("Good", StringComparison.OrdinalIgnoreCase)), unavailableTags = unavailable,
                disabledTags = definitions.Count(tag => !TagDefinitionValidator.Enabled(tag)), scanGroups = store.ExportTags()["scanGroups"],
                watchGroupLimit = 32, rejectedWatchGroups = capacityWarnings.Count, subscriptions = SubscriptionSnapshot() };
        }
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
            using (ChangeState())
            {
                if (!store.DefaultTagProviderEnabled()) return "Bad_Disabled";
                if (enableDemoTags && path == "[default]Setpoints/TargetSpeed")
                {
                    if (input[index].ValueKind != JsonValueKind.Number || !input[index].TryGetDouble(out var number) || !double.IsFinite(number) || number < 0 || number > 500) return "Bad_OutOfRange";
                    SetValue(new(path, number, "Double", "Good", DateTimeOffset.UtcNow, "memory")); return "Good";
                }
                try
                {
                    var saved = store.WriteMemoryTag(path, input[index]);
                    SetValue(MemoryValue(saved, DateTimeOffset.UtcNow));
                    return "Good";
                }
                catch (KeyNotFoundException) { return "Bad_NotFound"; }
                catch (ArgumentException) { return "Bad_NotWritable"; }
            }
        }).ToArray();
    }
    /// <summary>Validate a reviewed memory command and dispatch under the normal tag/configuration lock order.</summary>
    public string WriteReviewedMemory(string path, JsonElement value, Action validate)
    {
        using (ChangeState())
        lock (GatewayConfigurationLock.SyncRoot)
        {
            validate();
            return WriteMemory([path], [value]).Single();
        }
    }
    private void UpdateSamples()
    {
        if (!enableDemoTags) return;
        var now = DateTimeOffset.UtcNow;
        if (!store.DefaultTagProviderEnabled())
        {
            foreach (var value in values.Values.Where(value => value.Path.StartsWith("[default]Line/", StringComparison.Ordinal) || value.Path.StartsWith("[default]Setpoints/", StringComparison.Ordinal)))
                SetValue(value with { Quality = "Bad_Disabled" });
            return;
        }
        var seconds = (now - started).TotalSeconds;
        using (ChangeState())
        {
            if (!values.TryGetValue("[default]Setpoints/TargetSpeed", out var target)) SetValue(new("[default]Setpoints/TargetSpeed", 85d, "Double", "Good", now, "memory"));
            else if (target.Quality == "Bad_Disabled") SetValue(target with { Quality = "Good" });
        }
        for (var line = 1; line <= 2; line++)
        {
            void Set(string name, object value, string type) { var p = $"[default]Line/Line{line}/{name}"; SetValue(new(p, value, type, "Good", now, "simulated")); }
            Set("Speed", Math.Round(72 + line * 8 + Math.Sin(seconds / 7 + line) * 7, 1), "Double");
            Set("Temperature", Math.Round(38 + line * 4 + Math.Sin(seconds / 14 + line) * 3, 1), "Double");
            Set("ProductionCount", 12000 + line * 1600 + (int)(seconds * (line + 1)), "Int32");
            Set("Status", "Running", "String");
        }
    }
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
        try { await Task.WhenAll(SampleLoop(stoppingToken), DefinitionLoop(stoppingToken), ExpressionLoop(stoppingToken), MemoryPersistenceLoop(stoppingToken)); }
        finally { store.FlushMemoryValues(); }
    }
    private async Task MemoryPersistenceLoop(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await Task.Delay(1000, stoppingToken);
            try { store.FlushMemoryValues(); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            { logger.LogError("Memory tag checkpoint failed ({ErrorType}); the in-memory values remain active.", error.GetType().Name); }
        }
    }
    private async Task ExpressionLoop(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            using (ChangeState())
            {
                if (expressionGeneration != store.TagConfigurationGeneration)
                {
                    RefreshDefinitions();
                    expressionPlans = TagExpressions.Order(cachedDefinitions);
                    expressionGeneration = definitionGeneration;
                    expressionDue.Clear();
                }
                var now = DateTimeOffset.UtcNow;
                var snapshot = values.ToDictionary(item => item.Key, item => item.Value, StringComparer.Ordinal);
                foreach (var plan in expressionPlans)
                {
                    if (expressionDue.TryGetValue(plan.Path, out var due) && now < due) continue;
                    var next = TagExpressions.Evaluate(plan, snapshot, now, snapshot.GetValueOrDefault(plan.Path));
                    SetValue(next); snapshot[plan.Path] = next;
                    expressionDue[plan.Path] = now.AddMilliseconds(plan.Interval);
                }
            }
            await Task.Delay(100, stoppingToken);
        }
    }
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
            definition["enabled"]?.GetValue<bool>() == false || definition["effectiveEnabled"]?.GetValue<bool>() == false ? "Bad_Disabled" : "Good", timestamp, "memory");
    }

    private async Task DefinitionLoop(CancellationToken stoppingToken)
    {
        long appliedGeneration = -1;
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                JsonObject[] definitions;
                HashSet<string> disabledConnections;
                Dictionary<string, WatchPlan> plans;
                long generation, tagGeneration;
                using (ChangeState())
                {
                    generation = configurationGeneration;
                    RefreshDefinitions();
                    tagGeneration = definitionGeneration;
                    var changed = appliedGeneration != tagGeneration;
                    appliedGeneration = tagGeneration;
                    definitions = cachedDefinitions;
                    disabledConnections = cachedDisabledConnections;
                    plans = cachedPlans;
                    foreach (var definition in definitions.Where(definition => ProjectStore.Optional(definition, "kind") == "memory" && (changed || !values.ContainsKey(ProjectStore.Required(definition, "path")))))
                    {
                        var next = MemoryValue(definition, DateTimeOffset.UtcNow);
                        if (values.TryGetValue(next.Path, out var previous) && previous.Source == "memory"
                            && previous.Quality == next.Quality && previous.DataType == next.DataType
                            && SameValue(previous.Value, next.Value))
                            next = next with { Timestamp = previous.Timestamp };
                        SetValue(next);
                    }
                }
                // Configuration changes cancel the old generation before installing a new subscription.
                foreach (var pair in watches.ToArray())
                {
                    if (plans.TryGetValue(pair.Key, out var desired) && pair.Value.Active && pair.Value.Plan.Matches(desired) && !pair.Value.Completion.IsCompleted) continue;
                    await StopWatch(pair.Value);
                    watches.TryRemove(pair.Key, out _);
                }
                using (ChangeState())
                {
                    if (generation != configurationGeneration || tagGeneration != store.TagConfigurationGeneration) continue;
                    var definedPaths = definitions.Select(definition => ProjectStore.Required(definition, "path")).ToHashSet(StringComparer.Ordinal);
                    foreach (var path in values.Keys.Where(path => !(enableDemoTags && (path.StartsWith("[default]Line/") || path.StartsWith("[default]Setpoints/"))) && !definedPaths.Contains(path)))
                        RemoveValue(path);
                    foreach (var definition in definitions.Where(definition => TagDefinitionValidator.Kind(definition) == "opcua" && (recovery?.Active == true || definition["enabled"]?.GetValue<bool>() == false
                        || disabledConnections.Contains(ProjectStore.Required(definition, "connectionId")))))
                        SetUnavailable(ProjectStore.Required(definition, "path"), recovery?.Active == true ? "Bad_RecoveryMode" : "Bad_Disabled");
                    foreach (var plan in plans.Values)
                    {
                        if (watches.ContainsKey(plan.Key)) continue;
                        if (watches.Count >= 32)
                        {
                            if (capacityWarnings.Add(plan.Key)) logger.LogWarning("OPC UA watch group capacity (32) reached; {TagCount} tags in connection {ConnectionId} cannot subscribe.", plan.Bindings.Length, plan.Connection.Id);
                            foreach (var binding in plan.Bindings) SetUnavailable(binding.Path, "Bad_ResourceUnavailable");
                            continue;
                        }
                        capacityWarnings.Remove(plan.Key);
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
        SetValue(new(path, previous?.Value, previous?.DataType ?? "Unknown", quality, previous?.Timestamp ?? DateTimeOffset.UtcNow, "opcua"));
    }

    private async Task RunWatch(WatchRegistration watch)
    {
        try
        {
            await connectors.WatchAsync(watch.Plan.Connection, watch.Plan.Bindings.Select(binding => binding.NodeId).Distinct().ToArray(), watch.Plan.Interval,
                batch =>
                {
                    using (ChangeState())
                    {
                        if (!watch.Active) return;
                        var byNode = batch.ToDictionary(value => value.NodeId, StringComparer.Ordinal);
                        foreach (var binding in watch.Plan.Bindings)
                            if (byNode.TryGetValue(binding.NodeId, out var value))
                                SetValue(new(binding.Path, value.Value, value.DataType, value.Quality, value.Timestamp, "opcua"));
                        watch.LastNotification = DateTimeOffset.UtcNow;
                    }
                },
                status =>
                {
                    using (ChangeState())
                    {
                        if (!watch.Active) return;
                        watch.State = status;
                        if (status != "Connected")
                            foreach (var binding in watch.Plan.Bindings) SetUnavailable(binding.Path, "Bad_CommunicationError");
                    }
                }, watch.Cancellation.Token, watch.Plan.Bindings.DistinctBy(binding => binding.NodeId).ToDictionary(binding => binding.NodeId, binding => new OpcMonitorSettings(binding.AbsoluteDeadband, binding.QueueSize), StringComparer.Ordinal));
        }
        catch (OperationCanceledException) when (watch.Cancellation.IsCancellationRequested) { }
        catch (Exception error)
        {
            logger.LogWarning("OPC UA subscription failed ({ErrorType}); a new subscription will be attempted.", error.GetType().Name);
            using (ChangeState())
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
        using (ChangeState())
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
