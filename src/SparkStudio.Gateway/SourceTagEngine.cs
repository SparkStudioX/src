using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

public sealed partial class TagEngine
{
    private Dictionary<string, Dictionary<string, Binding[]>> sourceBindings = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> sourceTransportFingerprints = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SourceStatus> sourceStatuses = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SourceStatus> sourceAdmissionFailures = new(StringComparer.Ordinal);
    private readonly Dictionary<string, DateTimeOffset> sourceHealthySince = new(StringComparer.Ordinal);
    private readonly Dictionary<string, DateTimeOffset> sourceLastValues = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> sourceValueBytes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> sourceConnectionValueBytes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> sourceValueOwners = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HashSet<string>> sourceSuppressedPoints = new(StringComparer.Ordinal);
    private long sourceValueTotalBytes;
    private readonly SourceMemoryBudget sourceValueBudget = new();
    private readonly SourceMemoryBudget sourcePendingBudget = new();
    private bool sourceDisposed;
    private string? sourceAcquisitionFailure;
    private readonly object sourcePendingGate = new();
    private readonly Dictionary<string, (string Id, SourceDiscoveryItem Item, long Generation, long Revision, int Bytes)> sourcePending = new(StringComparer.Ordinal);
    private int sourcePendingBytes;
    private bool IsSourceGenerationCurrent(string id, long generation, long revision) => connectors.SourceGenerationCurrent(id, generation, revision);
    private bool SourceRecoveryActive => recovery?.Active == true;
    private ProjectStore SourceStore => store;
    private void RefreshSourceBindings()
    {
        var sourceConnections = store.GetConnections().OfType<JsonObject>().Where(item => SourceConfiguration.IsSource(ProjectStore.Required(item, "type"))).ToArray();
        var byId = sourceConnections.ToDictionary(item => ProjectStore.Required(item, "id"), StringComparer.Ordinal);
        sourceBindings = cachedDefinitions.Where(definition => TagDefinitionValidator.Kind(definition) == "device"
            && byId.ContainsKey(ProjectStore.Required(definition, "connectionId")))
            .GroupBy(definition => ProjectStore.Required(definition, "connectionId"), StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.GroupBy(definition => ProjectStore.Required(definition, "nodeId"), StringComparer.Ordinal)
                .ToDictionary(points => points.Key, points => points.Select(definition => new Binding(ProjectStore.Required(definition, "path"),
                    points.Key, TagDefinitionValidator.AbsoluteDeadband(definition), TagDefinitionValidator.MonitorQueueSize(definition))).ToArray(), StringComparer.Ordinal), StringComparer.Ordinal);
        foreach (var item in sourceConnections)
        {
            var id = ProjectStore.Required(item, "id");
            sourceBindings.TryAdd(id, new(StringComparer.Ordinal));
            sourceTransportFingerprints[id] = SourceConfiguration.TransportFingerprint(store.GetConnection(id, true));
            sourceSuppressedPoints[id] = store.SourceOwnership(id).Where(leaf => leaf.Suppressed).Select(leaf => leaf.PointId).ToHashSet(StringComparer.Ordinal);
        }
        foreach (var id in sourceTransportFingerprints.Keys.Where(id => !byId.ContainsKey(id)).ToArray()) sourceTransportFingerprints.Remove(id);
    }
    private void FenceSourceDefinitionChange(JsonObject tag)
    {
        if (ProjectStore.Optional(tag, "connectionId") is { } id) connectors.FenceSourceBindings(id);
    }
    private void FenceAllSourceBindings()
    {
        foreach (var id in sourceBindings.Keys) connectors.FenceSourceBindings(id);
    }
    private sealed class SourceTagSink(TagEngine engine, string id) : ISourceSink
    {
        public void OnValues(IReadOnlyList<SourceValue> batch) => engine.ApplySourceValues(id, batch);
        public ValueTask<bool> OnPublicationAsync(SourcePublication publication, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            using (engine.ChangeState())
            lock (GatewayConfigurationLock.SyncRoot)
            {
                if (engine.sourceDisposed || !engine.IsSourceGenerationCurrent(id, publication.Generation, publication.BindingRevision) || engine.SourceRecoveryActive || publication.CanCommit?.Invoke() == false) return ValueTask.FromResult(false);
                var oldBytes = engine.sourceValueTotalBytes;
                try {
                    var automaticIds = engine.SourceStore.GetConnection(id).Source!.Mqtt?.Mappings?.Where(mapping => mapping.Tags == "automatic" && mapping.Enabled)
                        .Select(mapping => mapping.Id).ToHashSet(StringComparer.Ordinal) ?? [];
                    var automatic = publication.Discoveries.Where(item => automaticIds.Contains(item.MappingId)).ToArray();
                    var staged = engine.StageSourceValues(id, publication.Values, automatic);
                    engine.sourceValueBudget.SetBytes("values", staged.Total);
                    if (automatic.Length > 0 && engine.SourceStore.ApplySourceDiscovery(id, automatic) > 0) engine.configurationGeneration++;
                    engine.RefreshDefinitions();
                    engine.CommitSourceValues(staged);
                    engine.ResumeSourceObservation(id);
                    if (publication.Values.Any(value => value.Action == SourceValueAction.Replace && value.Value is not null)) engine.sourceLastValues[id] = DateTimeOffset.UtcNow;
                    return ValueTask.FromResult(true);
                }
                catch (Exception error) when (error is IOException or ArgumentException or InvalidOperationException) {
                    engine.sourceValueBudget.SetBytes("values", oldBytes);
                    engine.RejectSourceObservation(id, new("degraded", error.Message, publication.Generation, publication.BindingRevision, "publication-rejected"));
                    return ValueTask.FromResult(false);
                }
            }
        }
        public void OnStatus(SourceStatus status)
        {
            using (engine.ChangeState())
            {
                if (!engine.IsSourceGenerationCurrent(id, status.Generation, status.BindingRevision)) return;
                engine.sourceStatuses[id] = status;
                var state = status.State.ToLowerInvariant();
                if (state == "connected") {
                    if (engine.sourceAdmissionFailures.TryGetValue(id, out var failure)) {
                        engine.sourceStatuses[id] = status with { State = "degraded", Message = failure.Message, Reason = failure.Reason };
                        engine.sourceHealthySince.Remove(id);
                    }
                    else engine.sourceHealthySince.TryAdd(id, DateTimeOffset.UtcNow);
                    return;
                }
                engine.sourceHealthySince.Remove(id);
                var quality = state == "disabled" ? "Bad_Disabled" : state == "degraded" ? "Uncertain_DataLoss" : "Bad_CommunicationError";
                foreach (var binding in engine.sourceBindings.GetValueOrDefault(id)?.Values.SelectMany(bindings => bindings) ?? [])
                    engine.SetUnavailable(binding.Path, quality);
            }
        }
        public void OnDiscovery(SourceDiscoveryBatch batch)
        {
            if (!engine.IsSourceGenerationCurrent(id, batch.Generation, batch.BindingRevision)) return;
            lock (engine.sourcePendingGate)
            {
                if (engine.sourceDisposed) return;
                foreach (var item in batch.Items)
                {
                    var key = SourceConfiguration.PointId(id, item.MappingId, item.Address, item.Selector);
                    var bytes = JsonSerializer.SerializeToUtf8Bytes(item).Length;
                    var previous = engine.sourcePending.GetValueOrDefault(key);
                    var total = engine.sourcePendingBytes - previous.Bytes + bytes;
                    if (total > 8 * 1024 * 1024 || !engine.sourcePending.ContainsKey(key) && engine.sourcePending.Count >= 4096)
                    {
                        engine.sourceAdmissionFailures[id] = engine.sourceStatuses[id] = new("degraded", "Automatic discovery queue is full.", batch.Generation, batch.BindingRevision, "discovery-overflow");
                        continue;
                    }
                    try { engine.sourcePendingBudget.SetBytes("state", total); }
                    catch (SourceLimitException error) {
                        engine.sourceAdmissionFailures[id] = engine.sourceStatuses[id] = new("degraded", error.Message, batch.Generation, batch.BindingRevision, "discovery-global-budget");
                        continue;
                    }
                    engine.sourcePending[key] = (id, item, batch.Generation, batch.BindingRevision, bytes);
                    engine.sourcePendingBytes = total;
                }
            }
        }
    }
    private void RejectSourceObservation(string id, SourceStatus failure)
    {
        sourceAdmissionFailures[id] = sourceStatuses[id] = failure;
        sourceHealthySince.Remove(id);
    }
    private void ResumeSourceObservation(string id)
    {
        if (sourceAdmissionFailures.TryRemove(id, out _)) sourceHealthySince[id] = DateTimeOffset.UtcNow;
    }
    private void ApplySourceValues(string id, IReadOnlyList<SourceValue> batch)
    {
        using (ChangeState())
        {
            if (sourceDisposed) return;
            try { var staged = StageSourceValues(id, batch, []); sourceValueBudget.SetBytes("values", staged.Total); CommitSourceValues(staged); if (staged.Changes.Count > 0) ResumeSourceObservation(id); }
            catch (SourceLimitException error) {
                RejectSourceObservation(id, new("degraded", error.Message, Reason: "value-budget"));
                foreach (var binding in sourceBindings.GetValueOrDefault(id)?.Values.SelectMany(bindings => bindings) ?? []) SetUnavailable(binding.Path, "Bad_ResourceUnavailable");
            }
            if (batch.Any(value => value.Action == SourceValueAction.Replace && value.Value is not null)) sourceLastValues[id] = DateTimeOffset.UtcNow;
        }
    }
    private sealed record StagedSourceValues(string Id, Dictionary<string, (TagValue Value, long Bytes)> Changes, long Total, long ConnectionTotal, Dictionary<string, long> ReleasedOwners);
    private StagedSourceValues StageSourceValues(string id, IReadOnlyList<SourceValue> batch, IReadOnlyList<SourceDiscoveryItem> discoveries)
    {
        var changes = new Dictionary<string, (TagValue Value, long Bytes)>(StringComparer.Ordinal);
        var limits = store.GetConnection(id).Source!.EffectiveLimits;
        var bindings = sourceBindings.GetValueOrDefault(id) ?? new(StringComparer.Ordinal);
        var suppressed = sourceSuppressedPoints.GetValueOrDefault(id) ?? [];
        var newPaths = discoveries.Where(item => !suppressed.Contains(SourceConfiguration.PointId(id, item.MappingId, item.Address, item.Selector)))
            .GroupBy(item => SourceConfiguration.PointId(id, item.MappingId, item.Address, item.Selector), StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First().SuggestedPath, StringComparer.Ordinal);
        foreach (var value in batch) {
            if (!connectors.SourceGenerationCurrent(id, value.Generation, value.BindingRevision) || recovery?.Active == true) continue;
            var paths = (bindings.GetValueOrDefault(value.PointId) ?? []).Select(binding => binding.Path).ToList();
            if (newPaths.TryGetValue(value.PointId, out var discoveredPath) && !paths.Contains(discoveredPath, StringComparer.Ordinal)) paths.Add(discoveredPath);
            foreach (var path in paths) {
                if (cachedDefinitionsByPath.TryGetValue(path, out var definition) && definition["enabled"]?.GetValue<bool>() == false) continue;
                values.TryGetValue(path, out var previous);
                var content = value.Action == SourceValueAction.Retain ? previous?.Value : value.Action == SourceValueAction.Clear ? null : value.Value;
                var timestamp = value.Action == SourceValueAction.Retain ? previous?.Timestamp ?? DateTimeOffset.UtcNow : value.SourceTimestamp ?? value.ReceiptTimestamp ?? DateTimeOffset.UtcNow;
                var deadband = bindings.GetValueOrDefault(value.PointId)?.FirstOrDefault(binding => binding.Path == path)?.AbsoluteDeadband ?? 0;
                var filtered = value.Action == SourceValueAction.Replace && previous is not null && previous.Quality == value.Quality
                    && previous.Source == id + ":" + value.PointId && previous.AcquisitionGeneration == value.Generation
                    && previous.BindingRevision == value.BindingRevision && WithinSourceDeadband(previous.Value, content, deadband);
                if (filtered) { content = previous!.Value; timestamp = previous.Timestamp; }
                var contentBytes = content is string text ? Math.Max(Encoding.UTF8.GetByteCount(text), text.Length * 2L) : content is null ? 0 : 16;
                var bytes = contentBytes + 256 + 2L * (path.Length + id.Length + value.PointId.Length + (value.NativeStatus?.Length ?? 0));
                if (contentBytes > limits.ValueBytes) throw new SourceLimitException("A source value exceeds its scalar byte limit.");
                changes[path] = (new(path, content, value.DataType, value.Quality, timestamp, id + ":" + value.PointId, false,
                    value.Action == SourceValueAction.Retain || filtered ? previous?.SourceTimestamp : value.SourceTimestamp, value.ReceiptTimestamp,
                    value.NativeStatus, value.Generation, value.BindingRevision, value.MonotonicReceipt), bytes);
            }
        }
        var delta = changes.Sum(change => change.Value.Bytes - sourceValueBytes.GetValueOrDefault(change.Key));
        var connectionDelta = changes.Sum(change => change.Value.Bytes - (sourceValueOwners.GetValueOrDefault(change.Key) == id ? sourceValueBytes.GetValueOrDefault(change.Key) : 0));
        var releasedOwners = changes.Keys.Where(path => sourceValueOwners.TryGetValue(path, out var owner) && owner != id)
            .GroupBy(path => sourceValueOwners[path], StringComparer.Ordinal).ToDictionary(group => group.Key, group => group.Sum(path => sourceValueBytes.GetValueOrDefault(path)), StringComparer.Ordinal);
        var connectionBytes = sourceConnectionValueBytes.GetValueOrDefault(id) + connectionDelta;
        if (connectionBytes > limits.StateBytes) throw new SourceLimitException("The connection value mailbox exceeds its byte limit.");
        return new(id, changes, sourceValueTotalBytes + delta, connectionBytes, releasedOwners);
    }
    private static bool WithinSourceDeadband(object? previous, object? next, double deadband)
    {
        if (deadband <= 0 || previous is null || next is null || previous is string or bool || next is string or bool) return false;
        try { return Math.Abs(Convert.ToDecimal(previous, System.Globalization.CultureInfo.InvariantCulture) - Convert.ToDecimal(next, System.Globalization.CultureInfo.InvariantCulture)) <= (decimal)deadband; }
        catch (OverflowException) { return Math.Abs(Convert.ToDouble(previous, System.Globalization.CultureInfo.InvariantCulture) - Convert.ToDouble(next, System.Globalization.CultureInfo.InvariantCulture)) <= deadband; }
        catch (InvalidCastException) { return false; }
    }
    private void CommitSourceValues(StagedSourceValues staged)
    {
        sourceValueTotalBytes = staged.Total;
        sourceConnectionValueBytes[staged.Id] = staged.ConnectionTotal;
        foreach (var released in staged.ReleasedOwners) sourceConnectionValueBytes[released.Key] -= released.Value;
        foreach (var change in staged.Changes) { sourceValueOwners[change.Key] = staged.Id; sourceValueBytes[change.Key] = change.Value.Bytes; SetValue(change.Value.Value); }
    }
    private async Task SynchronizeSourceAcquisitionAsync(CancellationToken stopping)
    {
        ConnectionDefinition[] connections; long revision;
        using (ChangeState())
        lock (GatewayConfigurationLock.SyncRoot)
        {
            revision = store.TagConfigurationGeneration;
            connections = recovery?.Active == true || !store.DefaultTagProviderEnabled() ? [] : store.EnabledSourceConnections();
            var enabledIds = connections.Select(connection => connection.Id).ToHashSet(StringComparer.Ordinal);
            foreach (var id in sourceHealthySince.Keys.Where(id => !enabledIds.Contains(id)).ToArray()) sourceHealthySince.Remove(id);
        }
        try { await connectors.SynchronizeSourcesAsync(connections, revision, id => new SourceTagSink(this, id), stopping); }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { throw; }
        catch (Exception error) { GatewayLog.SourceSynchronizationFailed(logger, error.GetType().Name, null); }
        (string Id, SourceDiscoveryItem Item, long Generation, long Revision, int Bytes)[] pending;
        lock (sourcePendingGate)
        {
            pending = sourcePending.Values.ToArray(); sourcePending.Clear(); sourcePendingBytes = 0;
            if (!sourceDisposed) sourcePendingBudget.SetBytes("state", 0);
        }
        using (ChangeState())
        foreach (var group in pending.GroupBy(item => (item.Id, item.Generation, item.Revision)))
        {
            if (!connectors.SourceGenerationCurrent(group.Key.Id, group.Key.Generation, group.Key.Revision)) continue;
            foreach (var batch in group.Chunk(1024))
            {
                try { if (store.ApplySourceDiscovery(group.Key.Id, batch.Select(item => item.Item).ToArray()) > 0) configurationGeneration++; ResumeSourceObservation(group.Key.Id); }
                catch (Exception error) when (error is ArgumentException or SourceLimitException or InvalidOperationException)
                {
                    RejectSourceObservation(group.Key.Id, new("degraded", error.Message, group.Key.Generation, group.Key.Revision, "discovery-rejected"));
                    GatewayLog.SourceDiscoveryRejected(logger, error.GetType().Name, null);
                }
            }
        }
        using (ChangeState())
        lock (GatewayConfigurationLock.SyncRoot)
        foreach (var connection in connections)
        {
            // Synchronization awaits remote registration. A source may have
            // been disabled, deleted or edited while that work was in flight.
            JsonObject current;
            try { current = store.ConnectionMetadata(connection.Id); }
            catch (KeyNotFoundException) { sourceHealthySince.Remove(connection.Id); continue; }
            if (current["enabled"]?.GetValue<bool>() == false || current["revision"]?.GetValue<int>() != connection.ConfigurationRevision)
            { sourceHealthySince.Remove(connection.Id); continue; }
            var previousGeneration = store.TagConfigurationGeneration;
            if (sourceAdmissionFailures.ContainsKey(connection.Id)) sourceHealthySince.Remove(connection.Id);
            var paths = store.PruneSourceLeaves(connection.Id, !sourceAdmissionFailures.ContainsKey(connection.Id) && sourceStatuses.GetValueOrDefault(connection.Id)?.State is "connected" or "Connected",
                sourceHealthySince.TryGetValue(connection.Id, out var since) ? since : null);
            if (paths.Length > 0) {
                foreach (var path in paths) if (values.TryGetValue(path, out var previous)) SetValue(previous with { Value = null, Quality = "Bad_NoData", Writable = false });
                if (previousGeneration != store.TagConfigurationGeneration) configurationGeneration++;
            }
        }
    }
    public object SourceSnapshot(string id)
    {
        var disabled = store.ConnectionMetadata(id)["enabled"]?.GetValue<bool>() == false;
        var status = sourceStatuses.GetValueOrDefault(id);
        if (disabled) status = (status ?? new SourceStatus("disabled")) with { State = "disabled", Reason = "configuration", Message = "Connection is disabled." };
        return new { transport = connectors.SourceDiagnostics(id, disabled), state = status,
            acquisitionFailure = Volatile.Read(ref sourceAcquisitionFailure), ownership = store.SourceOwnership(id).Length };
    }
    public object ApplySourceImport(string id, SourceImportRequest request)
    {
        using (ChangeState()) { var result = store.ApplySourceImport(id, request); connectors.AcceptSourceConfiguration(id, store.GetConnection(id, true).ConfigurationRevision ?? 0); connectors.FenceSourceBindings(id); configurationGeneration++; return result; }
    }
    public void ClearSourceSuppression(string id, string pointId)
    {
        using (ChangeState()) { store.ClearSourceSuppression(id, pointId); connectors.FenceSourceBindings(id); configurationGeneration++; }
    }
    public override void Dispose()
    {
        base.Dispose();
        using (ChangeState())
        lock (sourcePendingGate) {
            sourceDisposed = true;
            store.FlushSourceObservations();
            sourcePending.Clear(); sourcePendingBudget.Dispose(); sourceValueBudget.Dispose();
        }
    }
}
