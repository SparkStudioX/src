using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

public record TagValue(string Path, object? Value, string DataType, string Quality, DateTimeOffset Timestamp, string Source, bool Writable = false,
    DateTimeOffset? SourceTimestamp = null, DateTimeOffset? ReceiptTimestamp = null, string? NativeStatus = null,
    long? AcquisitionGeneration = null, long? BindingRevision = null, long? MonotonicReceipt = null);

public sealed partial class TagEngine(ProjectStore store, ConnectorService connectors, ILogger<TagEngine> logger, RecoveryQuarantine? recovery = null, bool enableDemoTags = false) : BackgroundService
{
    public bool DemoMode => enableDemoTags;
    private readonly ConcurrentDictionary<string, TagValue> values = new(StringComparer.Ordinal);
    private readonly DateTimeOffset started = DateTimeOffset.UtcNow;
    private double demoTargetSpeed = 85;
    private readonly ConcurrentDictionary<string, WatchRegistration> watches = new(StringComparer.Ordinal);
    private readonly object stateGate = new();
    // Subscribers enqueue notifications only; Python never executes on the tag thread.
    public event Action<TagValue?, TagValue>? ValueChanged;
    private void SetValue(TagValue next)
    {
        using (ChangeState())
        {
            values.TryGetValue(next.Path, out var previous);
            if (next.AcquisitionGeneration is null && sourceValueBytes.Remove(next.Path, out var releasedBytes))
            {
                sourceValueTotalBytes -= releasedBytes;
                if (sourceValueOwners.Remove(next.Path, out var releasedOwner)) sourceConnectionValueBytes[releasedOwner] -= releasedBytes;
                sourceValueBudget.SetBytes("values", sourceValueTotalBytes);
            }
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
    private Mutation ChangeState()
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
                        catch (Exception error) { GatewayLog.TagSubscriberFailed(logger, error.GetType().Name, null); }
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
            if (sourceValueBytes.Remove(path, out var removedBytes)) {
                sourceValueTotalBytes -= removedBytes;
                if (sourceValueOwners.Remove(path, out var removedOwner)) sourceConnectionValueBytes[removedOwner] -= removedBytes;
                sourceValueBudget.SetBytes("values", sourceValueTotalBytes);
            }
        }
    }
    private long configurationGeneration;
    private long expressionGeneration = -1;
    private long definitionGeneration = -1;
    private JsonObject[] cachedDefinitions = [];
    private Dictionary<string, JsonObject> cachedDefinitionsByPath = new(StringComparer.Ordinal);
    private HashSet<string> cachedDefinitionPaths = new(StringComparer.Ordinal);
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
            cachedDefinitionsByPath = cachedDefinitions.ToDictionary(definition => ProjectStore.Required(definition, "path"), StringComparer.Ordinal);
            cachedDefinitionPaths = cachedDefinitions.Select(definition => ProjectStore.Required(definition, "path")).ToHashSet(StringComparer.Ordinal);
            cachedDisabledConnections = store.GetConnections().OfType<JsonObject>().Where(item => item["enabled"]?.GetValue<bool>() == false)
                .Select(item => ProjectStore.Required(item, "id")).ToHashSet(StringComparer.Ordinal);
            var sourceIds = store.GetConnections().OfType<JsonObject>().Where(item => SourceConfiguration.IsSource(ProjectStore.Required(item, "type")))
                .Select(item => ProjectStore.Required(item, "id")).ToHashSet(StringComparer.Ordinal);
            cachedPlans = BuildWatchPlans(cachedDefinitions.Where(definition => recovery?.Active != true && TagDefinitionValidator.IsDeviceSource(definition) && definition["enabled"]?.GetValue<bool>() != false
                    && !cachedDisabledConnections.Contains(ProjectStore.Required(definition, "connectionId"))
                    && !sourceIds.Contains(ProjectStore.Required(definition, "connectionId"))), id => store.GetConnection(id, allowDisabled: true))
                .ToDictionary(plan => plan.Key, StringComparer.Ordinal);
            RefreshSourceBindings();
            capacityWarnings.RemoveWhere(key => !cachedPlans.ContainsKey(key));
            definitionGeneration = generation; cachedRecovery = recovery?.Active == true; DefinitionBuildCount++;
        }
    }
    private static WatchPlan[] BuildWatchPlans(IEnumerable<JsonObject> definitions, Func<string, ConnectionDefinition> getConnection)
    {
        return definitions.GroupBy(definition => (ConnectionId: ProjectStore.Required(definition, "connectionId"), Interval: definition["publishingIntervalMs"]?.GetValue<int>() ?? 1000,
                Deadband: TagDefinitionValidator.AbsoluteDeadband(definition), QueueSize: TagDefinitionValidator.MonitorQueueSize(definition)))
            .SelectMany(group =>
            {
                var connection = getConnection(group.Key.ConnectionId);
                // The connector's per-watch node ceiling is independent of the
                // gateway's configured-tag ceiling. Keep aliases for one node in
                // one partition and derive stable chunks from sorted node IDs.
                var byNode = group.Select(definition => new Binding(ProjectStore.Required(definition, "path"), ProjectStore.Required(definition, "nodeId"), group.Key.Deadband, group.Key.QueueSize))
                    .GroupBy(binding => binding.NodeId, StringComparer.Ordinal).ToDictionary(items => items.Key, items => items.ToArray(), StringComparer.Ordinal);
                var key = FormattableString.Invariant($"{group.Key.ConnectionId}\n{group.Key.Interval}\n{group.Key.Deadband:R}\n{group.Key.QueueSize}");
                return byNode.Keys.Order(StringComparer.Ordinal).Chunk(ConnectorService.MaximumReadNodes).Select((nodes, index) =>
                    new WatchPlan(key + "\n" + index.ToString(System.Globalization.CultureInfo.InvariantCulture), connection, group.Key.Interval,
                        nodes.SelectMany(node => byNode[node]).OrderBy(binding => binding.Path, StringComparer.Ordinal).ToArray()));
            }).OrderBy(plan => plan.Key, StringComparer.Ordinal).ToArray();
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
            FenceAllSourceBindings();
            InvalidateWatches(watch => watch.Plan.Bindings.Any(binding => binding.Path == path));
            configurationGeneration++;
            if (ProjectStore.Required(saved, "kind") == "memory") SetValue(MemoryValue(saved, DateTimeOffset.UtcNow));
            else if (ProjectStore.Required(saved, "kind") == "expression")
                SetValue(new(path, null, ProjectStore.Required(saved, "dataType"), saved["effectiveEnabled"]?.GetValue<bool>() == false ? "Bad_Disabled" : "Bad_WaitingForInitialData", DateTimeOffset.UtcNow, "expression"));
            else
            {
                var disabled = store.GetConnections().OfType<JsonObject>().Any(item => ProjectStore.Optional(item, "id") == ProjectStore.Optional(saved, "connectionId") && item["enabled"]?.GetValue<bool>() == false);
                // A newly configured source has not supplied a value yet. Do not
                // carry a prior memory or demo value into its OPC data record.
                SetValue(new(path, null, ProjectStore.Optional(saved, "dataType") ?? "Unknown",
                    recovery?.Active == true ? "Bad_RecoveryMode" : saved["effectiveEnabled"]?.GetValue<bool>() == false || disabled ? "Bad_Disabled" : "Bad_WaitingForInitialData",
                    DateTimeOffset.UtcNow, TagDefinitionValidator.Kind(saved), saved["writable"]?.GetValue<bool>() == true));
            }
            return saved;
        }
    }
    public TagImportPreview ApplyImport(TagImportRequest request)
    {
        using (ChangeState())
        {
            var result = store.ApplyTagImport(request);
            FenceAllSourceBindings();
            var changed = result.Changes.Where(item => item.Action != "unchanged").Select(item => item.Path).ToHashSet(StringComparer.Ordinal);
            InvalidateWatches(watch => watch.Plan.Bindings.Any(binding => changed.Contains(binding.Path)));
            foreach (var removed in result.Changes.Where(item => item.Action == "remove" && item.Path.StartsWith("[default]", StringComparison.Ordinal))) RemoveValue(removed.Path);
            foreach (var definition in store.GetRuntimeTagDefinitions().OfType<JsonObject>().Where(item => changed.Contains(ProjectStore.Required(item, "path"))))
            {
                var path = ProjectStore.Required(definition, "path");
                if (TagDefinitionValidator.Kind(definition) == "memory") SetValue(MemoryValue(definition, DateTimeOffset.UtcNow));
                else SetValue(new(path, null, ProjectStore.Optional(definition, "dataType") ?? "Unknown", recovery?.Active == true && TagDefinitionValidator.IsDeviceSource(definition) ? "Bad_RecoveryMode" : TagDefinitionValidator.Enabled(definition) ? "Bad_WaitingForInitialData" : "Bad_Disabled", DateTimeOffset.UtcNow, TagDefinitionValidator.Kind(definition), definition["writable"]?.GetValue<bool>() == true));
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
            FenceAllSourceBindings();
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
            if (SourceConfiguration.IsSource(ProjectStore.Required(saved, "type")))
            {
                var next = store.GetConnection(id, true);
                connectors.AcceptSourceConfiguration(id, next.ConfigurationRevision ?? 0);
                if (saved["enabled"]?.GetValue<bool>() == false || !sourceTransportFingerprints.TryGetValue(id, out var fingerprint)
                    || fingerprint != SourceConfiguration.TransportFingerprint(next)) connectors.FenceSourceConnection(id, next.ConfigurationRevision);
                else connectors.FenceSourceBindings(id);
            }
            InvalidateWatches(watch => watch.Plan.Connection.Id == id);
            foreach (var binding in store.ConnectionRuntimeBindings(id))
                SetUnavailable(binding.Path, recovery?.Active == true ? "Bad_RecoveryMode" : saved["enabled"]?.GetValue<bool>() == false || !binding.Enabled ? "Bad_Disabled" : "Bad_WaitingForInitialData");
            configurationGeneration++;
            return saved;
        }
    }
    public async Task DeleteConnectionAsync(string id, int revision, ProjectCatalog catalog)
    {
        Func<Task> cleanup;
        using (ChangeState())
        lock (GatewayConfigurationLock.SyncRoot)
        {
            if (revision < 0) throw new ArgumentException("Connection revision must be a nonnegative integer.");
            var connection = store.GetConnections().OfType<JsonObject>().FirstOrDefault(item => ProjectStore.Optional(item, "id") == id)
                ?? throw new KeyNotFoundException("Connection not found.");
            if (connection["revision"]!.GetValue<int>() != revision)
                throw new InvalidOperationException("The connection changed since it was loaded. Select it again before deleting.");
            var references = GatewayConnections.References(id, catalog);
            if (references.Count > 0)
                throw new InvalidOperationException($"This connection is used by {references.Count} saved tag, UDT member or named-query reference(s). Remove or change those references before deleting.");
            if (watches.Values.Any(watch => watch.Plan.Connection.Id == id))
                throw new InvalidOperationException("A device acquisition is still stopping. Try deleting this connection again shortly.");
            // Pool admission and persistence share one reservation. Failed writes leave
            // both configuration and transports intact; graceful close runs outside locks.
            cleanup = connectors.PrepareConnectionRemoval(id, () => store.DeleteConnection(id, revision));
            if (SourceConfiguration.IsSource(ProjectStore.Required(connection, "type"))) connectors.FenceSourceConnection(id, int.MaxValue);
            configurationGeneration++;
        }
        try { await cleanup(); }
        catch (Exception error)
        {
            // The durable removal already succeeded. Do not report a retryable
            // configuration failure or restore credentials after disposal failed.
            GatewayLog.RemovedTransportCleanupFailed(logger, error.GetType().Name, null);
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
            return watches.Values.Select(watch => (object)new
            {
                connectionId = watch.Plan.Connection.Id, publishingIntervalMs = watch.Plan.Interval,
                tagCount = watch.Plan.Bindings.Length, state = watch.State, lastNotificationAt = watch.LastNotification
            }).Concat(sourceBindings.Select(item => (object)new {
                connectionId = item.Key, publishingIntervalMs = 0, tagCount = item.Value.Values.Sum(bindings => bindings.Length),
                state = sourceStatuses.GetValueOrDefault(item.Key)?.State ?? "Connecting", lastNotificationAt = sourceLastValues.GetValueOrDefault(item.Key)
            })).ToArray();
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
            lock (GatewayConfigurationLock.SyncRoot)
            {
                if (!store.DefaultTagProviderEnabled()) return "Bad_Disabled";
                try
                {
                    var saved = store.WriteMemoryTag(path, input[index]);
                    SetValue(MemoryValue(saved, DateTimeOffset.UtcNow));
                    return "Good";
                }
                // Configured tags own their type, enabled state and persistence,
                // even when their path also appears in the optional demo.
                catch (KeyNotFoundException) when (enableDemoTags && path == "[default]Setpoints/TargetSpeed")
                {
                    if (input[index].ValueKind != JsonValueKind.Number || !input[index].TryGetDouble(out var number) || !double.IsFinite(number) || number < 0 || number > 500) return "Bad_OutOfRange";
                    demoTargetSpeed = number;
                    SetValue(new(path, number, "Double", "Good", DateTimeOffset.UtcNow, "memory")); return "Good";
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
        using (ChangeState())
        lock (GatewayConfigurationLock.SyncRoot)
        {
            RefreshDefinitions();
            var now = DateTimeOffset.UtcNow;
            if (!store.DefaultTagProviderEnabled())
            {
                foreach (var value in values.Values.Where(value => TagExpressions.SamplePath(value.Path) && !cachedDefinitionPaths.Contains(value.Path)))
                    SetValue(value with { Quality = "Bad_Disabled" });
                return;
            }
            // Demo values fill only unconfigured paths. In particular, a disabled
            // or unavailable configured tag must never be replaced with demo data.
            var seconds = (now - started).TotalSeconds;
            if (!cachedDefinitionPaths.Contains("[default]Setpoints/TargetSpeed"))
            {
                if (!values.TryGetValue("[default]Setpoints/TargetSpeed", out var target)
                    || target.Value is not double number || number != demoTargetSpeed
                    || target.DataType != "Double" || target.Source != "memory" || target.Quality != "Good")
                    SetValue(new("[default]Setpoints/TargetSpeed", demoTargetSpeed, "Double", "Good", now, "memory"));
            }
            for (var line = 1; line <= 2; line++)
            {
                void Set(string name, object value, string type)
                {
                    var path = $"[default]Line/Line{line}/{name}";
                    if (!cachedDefinitionPaths.Contains(path)) SetValue(new(path, value, type, "Good", now, "simulated"));
                }
                Set("Speed", Math.Round(72 + line * 8 + Math.Sin(seconds / 7 + line) * 7, 1), "Double");
                Set("Temperature", Math.Round(38 + line * 4 + Math.Sin(seconds / 14 + line) * 3, 1), "Double");
                Set("ProductionCount", 12000 + line * 1600 + (int)(seconds * (line + 1)), "Int32");
                Set("Status", "Running", "String");
            }
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
            { GatewayLog.MemoryTagCheckpointFailed(logger, error.GetType().Name, null); }
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
                lock (GatewayConfigurationLock.SyncRoot)
                {
                    generation = configurationGeneration;
                    RefreshDefinitions();
                    tagGeneration = definitionGeneration;
                    var changed = appliedGeneration != tagGeneration;
                    appliedGeneration = tagGeneration;
                    definitions = cachedDefinitions;
                    disabledConnections = cachedDisabledConnections;
                    plans = cachedPlans;
                    var memoryPaths = definitions.Where(definition => ProjectStore.Optional(definition, "kind") == "memory" && (changed || !values.ContainsKey(ProjectStore.Required(definition, "path"))))
                        .Select(definition => ProjectStore.Required(definition, "path")).ToHashSet(StringComparer.Ordinal);
                    // Configuration plans may have been cached by another loop
                    // before a runtime write. Read current memory state only when
                    // applying a configuration generation, under the same lock.
                    // Ordinary value writes still leave the expensive plans intact.
                    if (memoryPaths.Count > 0)
                    foreach (var definition in store.GetRuntimeTagDefinitions().OfType<JsonObject>().Where(definition => memoryPaths.Contains(ProjectStore.Required(definition, "path"))))
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
                    foreach (var path in values.Keys.Where(path => !(enableDemoTags && TagExpressions.SamplePath(path)) && !definedPaths.Contains(path)))
                        RemoveValue(path);
                    foreach (var definition in definitions.Where(definition => TagDefinitionValidator.IsDeviceSource(definition) && (recovery?.Active == true || definition["enabled"]?.GetValue<bool>() == false
                        || disabledConnections.Contains(ProjectStore.Required(definition, "connectionId")))))
                        SetUnavailable(ProjectStore.Required(definition, "path"), recovery?.Active == true ? "Bad_RecoveryMode" : "Bad_Disabled");
                    foreach (var plan in plans.Values)
                    {
                        if (watches.ContainsKey(plan.Key)) continue;
                        if (watches.Count >= 32)
                        {
                            if (capacityWarnings.Add(plan.Key)) GatewayLog.DeviceGroupCapacityReached(logger, plan.Bindings.Length, plan.Connection.Id, null);
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
                await SynchronizeSourceAcquisitionAsync(stoppingToken);
                await Task.Delay(500, stoppingToken);
            }
        }
        catch (Exception error) when (!stoppingToken.IsCancellationRequested)
        {
            // Unexpected errors may include remote payloads or connection
            // secrets. Diagnostics expose a bounded error type, not its text.
            Volatile.Write(ref sourceAcquisitionFailure, error.GetType().Name + ": acquisition loop stopped; see gateway diagnostics.");
            GatewayLog.TagAcquisitionLoopFailed(logger, error.GetType().Name, null);
            throw;
        }
        finally
        {
            await Task.WhenAll(watches.Values.Select(StopWatch));
            watches.Clear();
            await connectors.SynchronizeSourcesAsync([], store.TagConfigurationGeneration, id => new SourceTagSink(this, id), CancellationToken.None);
        }
    }

    private void SetUnavailable(string path, string quality)
    {
        values.TryGetValue(path, out var previous);
        if (previous?.AcquisitionGeneration is not null) { SetValue(previous with { Quality = quality, Writable = false }); return; }
        var definition = cachedDefinitionsByPath.GetValueOrDefault(path);
        var source = previous?.Source ?? (definition is null ? "opcua" : TagDefinitionValidator.Kind(definition));
        var dataType = previous?.DataType ?? (definition is null ? null : ProjectStore.Optional(definition, "dataType")) ?? "Unknown";
        var writable = previous?.Writable ?? (definition?["writable"]?.GetValue<bool>() == true);
        SetValue(new(path, previous?.Value, dataType, quality, previous?.Timestamp ?? DateTimeOffset.UtcNow, source, writable));
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
                                SetValue(new(binding.Path, value.Value, value.DataType, value.Quality, value.Timestamp, DeviceConfiguration.IsDevice(watch.Plan.Connection.Type) ? "device" : "opcua", watch.Plan.Connection.Device?.Points.Any(point => point.Id == binding.NodeId && point.Writable) == true));
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
            GatewayLog.DeviceAcquisitionFailed(logger, error.GetType().Name, null);
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
