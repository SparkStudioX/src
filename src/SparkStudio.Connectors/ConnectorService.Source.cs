using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;

namespace SparkStudio.Connectors;

public sealed partial class ConnectorService
{
    private readonly ConcurrentDictionary<string, SourceOwner> _sourceOwners = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, int> _sourceConfigurationRevisions = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SourceStatus> _sourceOwnerFaults = new(StringComparer.Ordinal);
    private readonly object _sourceConfigurationGate = new();
    private readonly SemaphoreSlim _sourceChanges = new(1, 1);
    private long _sourceGeneration;
    private sealed class SourceOwner(ConnectionDefinition connection, long generation, ISourceSession session, CancellationTokenSource stopping) : IDisposable
    {
        public ConnectionDefinition Connection = connection;
        public readonly string Fingerprint = SourceConfiguration.TransportFingerprint(connection);
        public readonly long Generation = generation;
        public readonly ISourceSession Session = session;
        public readonly CancellationTokenSource Stopping = stopping;
        public readonly SemaphoreSlim Operations = new(4, 4);
        public ISourceMonitor? Monitor;
        public ISourceSink? Sink;
        public long BindingRevision;
        public long AppliedRevision = -1;
        public volatile bool Active = true;
        public SourceStatus Status = new("configured", Generation: generation);
        public DateTimeOffset? LastValue;
        public DateTimeOffset? LastLiveValue;
        public long AcceptedValues;
        public long CoalescedValues;
        public long LastAcceptedMonotonic;
        public long LastLiveMonotonic;
        public long BindingStartedMonotonic;
        public long AcceptedWatermarkBytes;
        public readonly Dictionary<string, (long Monotonic, DateTimeOffset? Receipt)> AcceptedReceipts = new(StringComparer.Ordinal);
        public string? BindingsFingerprint;
        public string? FaultFingerprint;
        public DateTimeOffset NextAttempt;
        public readonly object DeliveryGate = new();
        public bool BindingTransition;
        public readonly Dictionary<string, SourceValue> PendingValues = new(StringComparer.Ordinal);
        public readonly Dictionary<string, SourceDiscoveryItem> PendingDiscovery = new(StringComparer.Ordinal);
        public SourceStatus? PendingStatus;
        public readonly SourceMemoryBudget PendingBudget = new();
        public long PendingBytes;
        public long PendingHighWaterBytes;
        public long PendingHighWaterCount;
        public long PendingDroppedRecords;
        public bool PendingLoss;
        public TaskCompletionSource<bool> TransitionCompletion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public long TransportEpoch;
        public long TransportFailureReceipt;
        private readonly object operationGate = new();
        private int operationUsers;
        private bool disposeRequested;
        public CancellationToken BeginOperation()
        {
            lock (operationGate) {
                if (!Active || disposeRequested) throw new OperationCanceledException("Source generation retired.");
                operationUsers++;
                return Stopping.Token;
            }
        }
        public void EndOperation()
        {
            lock (operationGate) {
                operationUsers--;
                if (disposeRequested && operationUsers == 0) DisposeOperationResources();
            }
        }
        public void Dispose()
        {
            lock (operationGate) {
                if (disposeRequested) return;
                disposeRequested = true;
                PendingBudget.Dispose();
                if (operationUsers == 0) DisposeOperationResources();
            }
            GC.SuppressFinalize(this);
        }
        private void DisposeOperationResources() { Operations.Dispose(); Stopping.Dispose(); }
    }
    private sealed class OwnerSink(SourceOwner owner) : ISourceSink
    {
        private bool Current(long generation, long revision) => owner.Active && !owner.Stopping.IsCancellationRequested
            && generation == owner.Generation && revision == Volatile.Read(ref owner.BindingRevision);
        private bool AfterTransportFence(SourceValue value) => Volatile.Read(ref owner.TransportFailureReceipt) == 0
            || value.MonotonicReceipt > Volatile.Read(ref owner.TransportFailureReceipt);
        public void OnValues(IReadOnlyList<SourceValue> values)
        {
            lock (owner.DeliveryGate) {
                var current = values.Where(value => Current(value.Generation, value.BindingRevision) && AfterTransportFence(value)).ToArray();
                if (current.Length == 0) return;
                if (owner.BindingTransition) {
                    foreach (var value in current) {
                        var bytes = JsonSerializer.SerializeToUtf8Bytes(value).Length + 128;
                        var prior = owner.PendingValues.TryGetValue(value.PointId, out var old) ? JsonSerializer.SerializeToUtf8Bytes(old).Length + 128 : 0;
                        if (!Reserve(bytes - prior)) continue;
                        if (old is not null) Interlocked.Increment(ref owner.CoalescedValues);
                        owner.PendingValues[value.PointId] = value;
                        owner.PendingHighWaterCount = Math.Max(owner.PendingHighWaterCount, owner.PendingValues.Count + owner.PendingDiscovery.Count);
                    }
                    return;
                }
                RecordAcceptedValues(owner, current);
                owner.Sink?.OnValues(current);
            }
        }
        public void OnStatus(SourceStatus status)
        {
            lock (owner.DeliveryGate) {
                if (!Current(status.Generation, status.BindingRevision)) return;
                var state = status.State.ToLowerInvariant();
                if (state is "disconnected" or "backoff" or "faulted" or "disabled" or "degraded") {
                    Volatile.Write(ref owner.TransportFailureReceipt, Stopwatch.GetTimestamp());
                    Interlocked.Increment(ref owner.TransportEpoch);
                    owner.PendingValues.Clear(); owner.PendingDiscovery.Clear(); owner.PendingBytes = 0; owner.PendingBudget.SetBytes("queue", 0);
                }
                if (owner.BindingTransition) {
                    owner.PendingStatus = status;
                    if (status.State is not ("connected" or "Connected")) { owner.PendingValues.Clear(); owner.PendingDiscovery.Clear(); owner.PendingBytes = 0; owner.PendingBudget.SetBytes("queue", 0); }
                    return;
                }
                owner.Status = status;
                owner.Sink?.OnStatus(status);
            }
        }
        public void OnDiscovery(SourceDiscoveryBatch discovery)
        {
            lock (owner.DeliveryGate) {
                if (!Current(discovery.Generation, discovery.BindingRevision)) return;
                if (owner.BindingTransition) {
                    foreach (var item in discovery.Items) {
                        var key = SourceConfiguration.PointId(owner.Connection.Id, item.MappingId, item.Address, item.Selector);
                        var bytes = JsonSerializer.SerializeToUtf8Bytes(item).Length + 128;
                        var prior = owner.PendingDiscovery.TryGetValue(key, out var old) ? JsonSerializer.SerializeToUtf8Bytes(old).Length + 128 : 0;
                        if (!Reserve(bytes - prior)) continue;
                        owner.PendingDiscovery[key] = item;
                        owner.PendingHighWaterCount = Math.Max(owner.PendingHighWaterCount, owner.PendingValues.Count + owner.PendingDiscovery.Count);
                    }
                    return;
                }
                owner.Sink?.OnDiscovery(discovery);
            }
        }
        private bool Reserve(long delta) {
            var bytes = owner.PendingBytes + delta;
            if (bytes > 8 * 1024 * 1024 || owner.PendingValues.Count + owner.PendingDiscovery.Count >= 20000) { owner.PendingLoss = true; owner.PendingDroppedRecords++; return false; }
            try { owner.PendingBudget.SetBytes("queue", bytes); owner.PendingBytes = bytes; owner.PendingHighWaterBytes = Math.Max(owner.PendingHighWaterBytes, bytes); return true; }
            catch (SourceLimitException) { owner.PendingLoss = true; owner.PendingDroppedRecords++; return false; }
        }
        public async ValueTask<bool> OnPublicationAsync(SourcePublication publication, CancellationToken ct) {
            Task<bool>? transition;
            long epoch;
            lock (owner.DeliveryGate) {
                if (!Current(publication.Generation, publication.BindingRevision) || publication.Values.Any(value => !AfterTransportFence(value))) return false;
                epoch = Volatile.Read(ref owner.TransportEpoch);
                transition = owner.BindingTransition ? owner.TransitionCompletion.Task : null;
            }
            if (transition is not null && !await transition.WaitAsync(ct)) return false;
            bool CanCommit() => Current(publication.Generation, publication.BindingRevision)
                && epoch == Volatile.Read(ref owner.TransportEpoch)
                && publication.Values.All(AfterTransportFence) && publication.CanCommit?.Invoke() != false;
            if (!CanCommit() || owner.Sink is null) return false;
            var accepted = await owner.Sink.OnPublicationAsync(publication with { CanCommit = CanCommit }, ct);
            if (accepted) RecordAcceptedValues(owner, publication.Values);
            return accepted;
        }
    }
    private ISourceSession CreateSourceSession(ConnectionDefinition connection) => _sourceFactory?.Invoke(connection) ?? connection.Type switch {
        "mtconnect" => new SourceMtConnectSession(connection, SourceHttp.CreateClient(connection, _dataDirectory)),
        "i3x" => new SourceI3xSession(connection, SourceHttp.CreateClient(connection, _dataDirectory)),
        "mqtt" => new SourceMqttSession(connection, _dataDirectory),
        _ => throw new ArgumentException("Unsupported source driver.")
    };
    private async Task<SourceOwner> GetSourceOwnerAsync(ConnectionDefinition connection, CancellationToken cancellation)
    {
        SourceConfiguration.Validate(connection.Type, connection.Source ?? throw new ArgumentException("Source settings are required."));
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        await _sourceChanges.WaitAsync(cancellation);
        try
        {
            lock (_sourceConfigurationGate) ValidateSourceConfigurationRevision(connection, accept: true);
            if (_sourceOwners.TryGetValue(connection.Id, out var existing))
            {
                if (existing.Active && existing.Fingerprint == SourceConfiguration.TransportFingerprint(connection)) {
                    lock (_sourceConfigurationGate) { ValidateSourceConfigurationRevision(connection, accept: true); existing.Connection = connection; _sourceOwnerFaults.TryRemove(connection.Id, out _); return existing; }
                }
                _sourceOwners.TryRemove(connection.Id, out _);
                await StopSourceOwnerAsync(existing);
            }
            if (_sourceOwners.Count >= 32) throw new SourceLimitException("At most 32 source connections may be active.");
            var owner = new SourceOwner(connection, Interlocked.Increment(ref _sourceGeneration), CreateSourceSession(connection),
                CancellationTokenSource.CreateLinkedTokenSource(_watchStopping));
            try {
                lock (_sourceConfigurationGate) { ValidateSourceConfigurationRevision(connection, accept: true); _sourceOwners[connection.Id] = owner; _sourceOwnerFaults.TryRemove(connection.Id, out _); }
            }
            catch { await StopSourceOwnerAsync(owner); throw; }
            return owner;
        }
        finally { _sourceChanges.Release(); }
    }
    private async Task<T> WithSourceAsync<T>(ConnectionDefinition connection, Func<ISourceSession, SourceOwner, CancellationToken, Task<T>> operation, CancellationToken cancellation)
    {
        _ensureOperationsAllowed?.Invoke();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation, _watchStopping);
        timeout.CancelAfter(connection.Source?.EffectiveLimits.OperationTimeoutMs ?? 10000);
        var owner = await GetSourceOwnerAsync(connection, timeout.Token);
        var stopping = owner.BeginOperation();
        try {
            using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, stopping);
            await owner.Operations.WaitAsync(lifetime.Token);
            try {
                lock (_sourceConfigurationGate) ValidateSourceConfigurationRevision(connection);
                var result = await operation(owner.Session, owner, lifetime.Token);
                lock (_sourceConfigurationGate) ValidateSourceConfigurationRevision(connection);
                if (!owner.Active || lifetime.IsCancellationRequested) throw new OperationCanceledException("Source generation retired.", lifetime.Token);
                return result;
            }
            finally { owner.Operations.Release(); }
        }
        finally { owner.EndOperation(); }
    }
    public Task<SourceTestResult> TestSourceAsync(ConnectionDefinition connection, CancellationToken ct) =>
        WithSourceAsync(connection, (session, _, token) => session.TestAsync(token), ct);
    public Task<SourceBrowsePage> BrowseSourceAsync(ConnectionDefinition connection, SourceBrowseRequest request, CancellationToken ct) =>
        WithSourceAsync(connection, (session, owner, token) => session.BrowseAsync(request with {
            Generation = owner.Generation, BindingRevision = Volatile.Read(ref owner.BindingRevision) }, token), ct);
    public Task<SourceReadBatch> ReadSourceAsync(ConnectionDefinition connection, IReadOnlyList<string> ids, CancellationToken ct)
    {
        if (ids.Count > 1000) throw new ArgumentException("Read at most 1,000 saved source points.");
        var points = ids.Distinct(StringComparer.Ordinal).Select(id => SourceConfiguration.Point(connection, id)).ToArray();
        return WithSourceAsync(connection, (session, owner, token) => session.ReadAsync(new(points, owner.Generation, Volatile.Read(ref owner.BindingRevision)), token), ct);
    }
    private async Task<IReadOnlyList<ConnectorValue>> ReadSourceLegacyAsync(ConnectionDefinition connection, IReadOnlyList<string> ids, CancellationToken ct) =>
        (await ReadSourceAsync(connection, ids, ct)).Values.Select(value => value.ToConnectorValue()).ToArray();
    private async Task<IReadOnlyList<BrowseNode>> BrowseSourceLegacyAsync(ConnectionDefinition connection, string? parent, CancellationToken ct)
    {
        if (parent == "@configured") return connection.Source!.SavedPoints.Select(point => new BrowseNode(point.Id, point.Name, true,
            point.DataType, false, "configured", point.Id, point.Address)).ToArray();
        var page = await BrowseSourceAsync(connection, new(parent), ct);
        return page.Entries.Select(entry => new BrowseNode(entry.Address, entry.Name, entry.IsVariable, entry.DataType, false,
            connection.Type == "mqtt" ? "observed" : "native", Address: entry.Address)).ToArray();
    }
    public async Task SynchronizeSourcesAsync(IReadOnlyList<ConnectionDefinition> connections, long bindingRevision,
        Func<string, ISourceSink> sink, CancellationToken cancellation)
    {
        if (connections.Count > 0) _ensureOperationsAllowed?.Invoke();
        var wanted = connections.Select(connection => connection.Id).ToHashSet(StringComparer.Ordinal);
        foreach (var pair in _sourceOwners.ToArray().Where(pair => !wanted.Contains(pair.Key))) {
            try { await RemoveSourceAsync(pair.Key, cancellation); }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { throw; }
            catch (Exception error) { _sourceOwnerFaults[pair.Key] = new("faulted", SourceSafeError(error), Reason: "owner-cleanup"); }
        }
        foreach (var id in _sourceOwnerFaults.Keys.Where(id => !wanted.Contains(id))) _sourceOwnerFaults.TryRemove(id, out _);
        foreach (var connection in connections)
        {
            cancellation.ThrowIfCancellationRequested();
            try {
            var owner = await GetSourceOwnerAsync(connection, cancellation);
            owner.Sink = sink(connection.Id);
            var settings = connection.Source!;
            var fingerprint = JsonSerializer.Serialize(new { settings.Points, settings.Mqtt?.Mappings });
            if (owner.FaultFingerprint == fingerprint || owner.NextAttempt > DateTimeOffset.UtcNow) continue;
            if (owner.Monitor is not null && owner.BindingsFingerprint == fingerprint && owner.AppliedRevision == Volatile.Read(ref owner.BindingRevision)) continue;
            var revision = Math.Max(bindingRevision, Volatile.Read(ref owner.BindingRevision) + 1);
            lock (owner.DeliveryGate) {
                owner.BindingTransition = true;
                owner.BindingStartedMonotonic = Stopwatch.GetTimestamp();
                owner.TransitionCompletion = new(TaskCreationOptions.RunContinuationsAsynchronously);
                Volatile.Write(ref owner.BindingRevision, revision);
            }
            var bindings = new SourceBindingRevision(revision, settings.SavedPoints, settings.Mqtt?.Mappings);
            try
            {
                if (owner.Monitor is null) owner.Monitor = await owner.Session.StartMonitoringAsync(new(owner.Generation, bindings), new OwnerSink(owner), owner.Stopping.Token);
                else await owner.Monitor.UpdateBindingsAsync(bindings, cancellation);
                owner.AppliedRevision = revision; owner.BindingsFingerprint = fingerprint;
                owner.FaultFingerprint = null; owner.NextAttempt = default;
                CompleteBindingTransition(owner, success: true);
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { CompleteBindingTransition(owner, success: false); throw; }
            catch (Exception error)
            {
                CompleteBindingTransition(owner, success: false);
                owner.Status = new(owner.Monitor is null ? "faulted" : "degraded", SourceSafeError(error), owner.Generation, revision, "binding-reconciliation");
                owner.Sink.OnStatus(owner.Status);
                if (error is SourceLimitException or ArgumentException) owner.FaultFingerprint = fingerprint;
                else owner.NextAttempt = DateTimeOffset.UtcNow.AddSeconds(5);
            }
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { throw; }
            catch (Exception error) { _sourceOwnerFaults[connection.Id] = new("faulted", SourceSafeError(error), Reason: "acquisition-owner"); }
        }
    }
    private static void CompleteBindingTransition(SourceOwner owner, bool success)
    {
        lock (owner.DeliveryGate) {
            owner.BindingTransition = false;
            if (success && owner.Active) {
                var points = owner.Connection.Source!.SavedPoints.Select(point => point.Id).ToHashSet(StringComparer.Ordinal);
                foreach (var id in owner.AcceptedReceipts.Keys.Where(id => !points.Contains(id)).ToArray()) {
                    owner.AcceptedReceipts.Remove(id); owner.AcceptedWatermarkBytes -= 128L + id.Length * 2L;
                }
                owner.PendingBudget.SetBytes("state", owner.AcceptedWatermarkBytes);
                if (owner.PendingStatus is { } status) { owner.Status = status; owner.Sink?.OnStatus(status); }
                if (owner.PendingDiscovery.Count > 0) owner.Sink?.OnDiscovery(new(owner.PendingDiscovery.Values.ToArray(), owner.Generation, owner.BindingRevision));
                if (owner.PendingValues.Count > 0) { owner.Sink?.OnValues(owner.PendingValues.Values.ToArray()); RecordAcceptedValues(owner, owner.PendingValues.Values.ToArray()); }
                if (owner.PendingLoss) { owner.Status = new("degraded", "Binding transition buffer exceeded its bounded profile. Reconcile source values.", owner.Generation, owner.BindingRevision, "binding-buffer-loss", LostUpdates: 1); owner.Sink?.OnStatus(owner.Status); }
            }
            owner.PendingStatus = null; owner.PendingValues.Clear(); owner.PendingDiscovery.Clear(); owner.PendingLoss = false;
            owner.PendingBytes = 0; owner.PendingBudget.SetBytes("queue", 0);
            owner.TransitionCompletion.TrySetResult(success);
        }
    }
    public void FenceSourceBindings(string id)
    {
        if (_sourceOwners.TryGetValue(id, out var owner)) Interlocked.Increment(ref owner.BindingRevision);
    }
    private static void RecordAcceptedValues(SourceOwner owner, IReadOnlyList<SourceValue> values)
    {
        lock (owner.DeliveryGate) {
            var accepted = 0;
            foreach (var value in values.Where(value => value.Action == SourceValueAction.Replace && value.Value is not null)) {
                var known = owner.AcceptedReceipts.TryGetValue(value.PointId, out var previous);
                if (known && (value.MonotonicReceipt > 0 && previous.Monotonic > 0 ? value.MonotonicReceipt <= previous.Monotonic
                    : value.ReceiptTimestamp is { } receipt && previous.Receipt is { } priorReceipt && receipt <= priorReceipt)) continue;
                if (!known) {
                    if (owner.AcceptedReceipts.Count >= 10000) continue;
                    var bytes = owner.AcceptedWatermarkBytes + 128L + value.PointId.Length * 2L;
                    try { owner.PendingBudget.SetBytes("state", bytes); } catch (SourceLimitException) { continue; }
                    owner.AcceptedWatermarkBytes = bytes;
                }
                owner.AcceptedReceipts[value.PointId] = (value.MonotonicReceipt, value.ReceiptTimestamp); accepted++;
                // Retained replay and old canonical binding seeds are accepted cached values,
                // but cannot establish a newly received live value.
                if (!value.Retained && value.MonotonicReceipt > owner.BindingStartedMonotonic && value.MonotonicReceipt > owner.LastLiveMonotonic) {
                    owner.LastLiveMonotonic = value.MonotonicReceipt;
                    owner.LastLiveValue = value.ReceiptTimestamp ?? DateTimeOffset.UtcNow;
                }
                if (value.MonotonicReceipt > owner.LastAcceptedMonotonic || value.MonotonicReceipt == 0 && (owner.LastValue is null || value.ReceiptTimestamp > owner.LastValue)) {
                    owner.LastAcceptedMonotonic = Math.Max(owner.LastAcceptedMonotonic, value.MonotonicReceipt);
                    owner.LastValue = value.ReceiptTimestamp ?? DateTimeOffset.UtcNow;
                }
            }
            Interlocked.Add(ref owner.AcceptedValues, accepted);
        }
    }
    public void AcceptSourceConfiguration(string id, int revision)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(revision);
        lock (_sourceConfigurationGate) _sourceConfigurationRevisions.AddOrUpdate(id, revision, (_, prior) => Math.Max(prior, revision));
    }
    private void ValidateSourceConfigurationRevision(ConnectionDefinition connection, bool accept = false)
    {
        if (_sourceConfigurationRevisions.TryGetValue(connection.Id, out var latest)
            && (connection.ConfigurationRevision is not { } supplied || supplied < latest))
            throw new InvalidOperationException("The source configuration changed. Reload before starting or completing an operation.");
        if (connection.ConfigurationRevision is { } revision) {
            if (revision < 0) throw new ArgumentException("Source configuration revision must be nonnegative.");
            if (accept) _sourceConfigurationRevisions.AddOrUpdate(connection.Id, revision, (_, prior) => Math.Max(prior, revision));
        }
    }
    public void FenceSourceConnection(string id, int? revision = null)
    {
        lock (_sourceConfigurationGate) {
            if (revision is { } accepted) AcceptSourceConfiguration(id, accepted);
            if (!_sourceOwners.TryGetValue(id, out var owner)) return;
            owner.Active = false;
            _ = owner.Stopping.CancelAsync();
        }
    }
    public bool SourceGenerationCurrent(string id, long generation, long revision) =>
        _sourceOwners.TryGetValue(id, out var owner) && owner.Active && owner.Generation == generation && Volatile.Read(ref owner.BindingRevision) == revision;
    public object SourceDiagnostics(string id, bool disabled = false) {
        if (_sourceOwners.TryGetValue(id, out var owner)) lock (owner.DeliveryGate) {
            var acceptedAt = owner.LastValue ?? owner.Status.Diagnostics?.GetValueOrDefault("lastAcceptedAt") as DateTimeOffset?;
            var liveAt = owner.LastLiveValue ?? owner.Status.Diagnostics?.GetValueOrDefault("lastLiveAcceptedAt") as DateTimeOffset?;
            var diagnostics = new Dictionary<string, object?>(owner.Status.Diagnostics ?? new Dictionary<string, object?>()) {
                ["lastAcceptedAt"] = acceptedAt, ["lastLiveAcceptedAt"] = liveAt,
                ["acceptedValues"] = Interlocked.Read(ref owner.AcceptedValues), ["coalescedValues"] = Interlocked.Read(ref owner.CoalescedValues),
                ["coalescingBasis"] = "latest-point replacements in the binding-transition mailbox",
                ["pendingQueueBytes"] = owner.PendingBytes, ["pendingQueueCount"] = owner.PendingValues.Count + owner.PendingDiscovery.Count,
                ["pendingQueueHighWaterBytes"] = owner.PendingHighWaterBytes, ["pendingQueueHighWaterCount"] = owner.PendingHighWaterCount,
                ["pendingQueueDroppedRecords"] = owner.PendingDroppedRecords,
                ["pendingQueueLossBasis"] = "rejected point/discovery admissions to the binding-transition mailbox",
                ["mode"] = owner.Status.Diagnostics?.GetValueOrDefault("mode") ?? owner.Connection.Source?.Acquisition,
                ["configuredMode"] = owner.Connection.Source?.Acquisition, ["driverState"] = owner.Status.State,
                ["transportState"] = disabled ? "disabled" : TransportState(owner.Status.State)
            };
            if (owner.Connection.Type == "mqtt" && !diagnostics.ContainsKey("lastLiveMqttValueAt")) diagnostics["lastLiveMqttValueAt"] = liveAt;
            return new {
        state = disabled ? "disabled" : TransportState(owner.Status.State),
        generation = owner.Generation, bindingRevision = Volatile.Read(ref owner.BindingRevision),
        owner.Status.Reason, owner.Status.Message, owner.Status.NativeStatus, owner.Status.LostUpdates,
        diagnostics, lastAcceptedAt = acceptedAt, lastLiveAcceptedAt = liveAt,
        acceptedValues = Interlocked.Read(ref owner.AcceptedValues), coalescedValues = Interlocked.Read(ref owner.CoalescedValues),
        globalMemory = SourceMemoryBudget.Snapshot(), peakGlobalMemory = SourceMemoryBudget.PeakSnapshot(), effectiveLimits = owner.Connection.Source?.EffectiveLimits
            };
        }
        return _sourceOwnerFaults.TryGetValue(id, out var failure)
        ? new { state = disabled ? "disabled" : TransportState(failure.State), failure.Reason, failure.Message,
            diagnostics = new Dictionary<string, object?> { ["transportState"] = disabled ? "disabled" : TransportState(failure.State), ["driverState"] = failure.State },
            globalMemory = SourceMemoryBudget.Snapshot(), peakGlobalMemory = SourceMemoryBudget.PeakSnapshot() }
        : (object)new { state = disabled ? "disabled" : "disconnected",
            diagnostics = new Dictionary<string, object?> { ["transportState"] = disabled ? "disabled" : "disconnected" },
            globalMemory = SourceMemoryBudget.Snapshot(), peakGlobalMemory = SourceMemoryBudget.PeakSnapshot() };
    }
    private static string TransportState(string state) => state.ToLowerInvariant() switch { "configured" => "connecting", "backoff" => "disconnected", var normalized => normalized };
    public async Task RemoveSourceAsync(string id, CancellationToken ct = default)
    {
        await _sourceChanges.WaitAsync(ct);
        try { if (_sourceOwners.TryRemove(id, out var owner)) await StopSourceOwnerAsync(owner); }
        finally { _sourceChanges.Release(); }
    }
    private static async Task StopSourceOwnerAsync(SourceOwner owner)
    {
        owner.Active = false;
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        Exception? failure = null;
        try
        {
            await Attempt(owner.Stopping.CancelAsync);
            if (owner.Monitor is not null) await Attempt(() => owner.Monitor.DisposeAsync().AsTask());
            await Attempt(() => owner.Session.DisposeAsync().AsTask());
        }
        finally { CompleteBindingTransition(owner, success: false); owner.Dispose(); }
        if (failure is not null) throw new InvalidOperationException("Source cleanup failed or exceeded its two-second deadline; all cleanup actions were attempted.", failure);

        async Task Attempt(Func<Task> cleanup) {
            try {
                var task = cleanup();
                _ = task.ContinueWith(completed => { _ = completed.Exception; }, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
                await task.WaitAsync(deadline.Token);
            }
            catch (Exception error) { failure ??= error; }
        }
    }
    private void DisposeSources()
    {
        var stopping = _sourceOwners.Values.Select(StopSourceOwnerAsync).ToArray();
        _sourceOwners.Clear();
        try { Task.WhenAll(stopping).Wait(TimeSpan.FromSeconds(2)); } catch (AggregateException) { }
    }
    private static string SourceSafeError(Exception error) => error switch {
        SourceLimitException => error.Message, ArgumentException => error.Message,
        TimeoutException or OperationCanceledException => "Source operation timed out.",
        _ => "Source operation failed (" + error.GetType().Name + "). Check transport, credentials and source diagnostics."
    };
}
