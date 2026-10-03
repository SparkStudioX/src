using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using SparkStudio.Connectors;

internal static class SourceAdversarialChecks
{
    public static async Task<int> RunAsync()
    {
        var checks = 0;
        void Check(bool condition, string description) {
            if (!condition) throw new InvalidOperationException("Source adversarial fixture: " + description);
            checks++;
        }
        async Task Rejected(Task operation, string description) {
            try { await operation; }
            catch (InvalidOperationException) { checks++; return; }
            throw new InvalidOperationException("Source adversarial fixture accepted " + description);
        }
        var root = Path.Combine(Path.GetTempPath(), "SparkStudio.SourceAdversarial." + Guid.NewGuid().ToString("N"));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        try {
            await RevisionWatermarks();
            await QueuedFiniteOperations();
            await FiniteOperationRetirement();
            await TransportCommitBarrier();
            await BindingFailureBuffer();
            await CleanupAndOwnerIsolation();
            await RecoveryGateAndFreshness();
            await LiveAndMailboxDiagnostics();
            return checks;
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); }

        async Task RevisionWatermarks()
        {
            var sessions = new ConcurrentQueue<SyntheticSession>();
            using var service = Service("revision", sessions);
            var first = Connection("revision", 1);
            var sink = new CommitSink();
            await service.SynchronizeSourcesAsync([first], 1, _ => sink, deadline.Token);
            service.AcceptSourceConfiguration(first.Id, 2);
            await Rejected(service.TestSourceAsync(first, deadline.Token), "captured Test after a compatible configuration edit");
            await Rejected(service.BrowseSourceAsync(first, new(), deadline.Token), "captured Browse after a configuration edit");
            await Rejected(service.ReadSourceAsync(first, ["point"], deadline.Token), "captured Read after a configuration edit");
            Check(sessions.Count == 1 && sessions.Single().Tests == 0, "stale finite operations never reach the session or create a transport");
            var second = Connection("revision", 2, "mqtt://127.0.0.1:1884");
            service.FenceSourceConnection(first.Id, 2);
            await service.SynchronizeSourcesAsync([second], 2, _ => sink, deadline.Token);
            await Rejected(service.TestSourceAsync(first, deadline.Token), "stale endpoint after replacement owner install");
            Check(sessions.Count == 2 && sessions.Last().Disposed == 0, "stale endpoint cannot retire the current owner");
            service.FenceSourceConnection(first.Id, int.MaxValue);
            await service.RemoveSourceAsync(first.Id, deadline.Token);
            await Rejected(service.TestSourceAsync(second, deadline.Token), "captured request after deletion and owner removal");
            Check(sessions.Count == 2, "deletion watermark survives owner removal");
        }

        async Task QueuedFiniteOperations()
        {
            var sessions = new ConcurrentQueue<SyntheticSession>();
            using var service = Service("operations", sessions);
            var connection = Connection("operations", 1);
            await service.SynchronizeSourcesAsync([connection], 1, _ => new CommitSink(), deadline.Token);
            var source = sessions.Single();
            source.TestRelease = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var inFlight = Enumerable.Range(0, 4).Select(_ => service.TestSourceAsync(connection, deadline.Token)).ToArray();
            await Until(() => Volatile.Read(ref source.Tests) == 4, deadline.Token);
            var waiting = service.TestSourceAsync(connection, deadline.Token);
            service.AcceptSourceConfiguration(connection.Id, 2);
            source.TestRelease.SetResult();
            foreach (var task in inFlight) await Rejected(task, "obsolete completion from an already running finite operation");
            await Rejected(waiting, "obsolete finite operation queued at the four-operation gate");
            Check(source.Tests == 4, "queued stale operation is rejected before entering the transport");
        }

        async Task FiniteOperationRetirement()
        {
            var sessions = new ConcurrentQueue<SyntheticSession>();
            using var service = Service("retirement", sessions);
            var connection = Connection("retirement", 1);
            await service.SynchronizeSourcesAsync([connection], 1, _ => new CommitSink(), deadline.Token);
            var source = sessions.Single();
            source.TestRelease = new(TaskCreationOptions.RunContinuationsAsynchronously);
            source.IgnoreTestCancellation = true;
            var active = Enumerable.Range(0, 4).Select(_ => service.TestSourceAsync(connection, deadline.Token)).ToArray();
            try {
                await Until(() => Volatile.Read(ref source.Tests) == 4, deadline.Token);
                var queued = service.TestSourceAsync(connection, deadline.Token);
                await service.RemoveSourceAsync(connection.Id, deadline.Token);
                Check(source.Disposed == 1 && source.MonitorDisposals == 1, "owner retirement closes both transports while finite calls are still finishing");
                Check(active.All(task => !task.IsCompleted), "independent finite calls actually outlive owner transport retirement");
                await Cancelled(queued);
                source.TestRelease.SetResult();
                foreach (var operation in active) await Cancelled(operation);
                Check(source.Tests == 4, "the cancelled fifth call never enters a retired transport");
            }
            finally { source.TestRelease.TrySetResult(); }

            async Task Cancelled(Task operation) {
                try { await operation.WaitAsync(deadline.Token); }
                catch (OperationCanceledException) { checks++; return; }
                throw new InvalidOperationException("Retired finite operation was accepted.");
            }
        }

        async Task TransportCommitBarrier()
        {
            var sessions = new ConcurrentQueue<SyntheticSession>();
            using var service = Service("transport", sessions);
            var sink = new CommitSink { Entered = new(TaskCreationOptions.RunContinuationsAsynchronously), Release = new(TaskCreationOptions.RunContinuationsAsynchronously) };
            await service.SynchronizeSourcesAsync([Connection("transport", 1)], 1, _ => sink, deadline.Token);
            var source = sessions.Single();
            var queued = source.Publication(10L);
            var pending = source.PublishAsync(queued, deadline.Token);
            await sink.Entered.Task.WaitAsync(deadline.Token);
            source.Status("disconnected");
            source.Status("connected");
            sink.Release.SetResult();
            Check(!await pending && sink.Values.IsEmpty, "publication queued at the gateway commit lock cannot cross a disconnect/reconnect fence");
            sink.Entered = null; sink.Release = null;
            Check(!await source.PublishAsync(queued, deadline.Token), "old receipt is still fenced after reconnection");
            source.Emit(queued.Values);
            Check(sink.Values.IsEmpty, "synchronous queued callback cannot cross the same failure fence");
            Check(await source.PublishAsync(source.Publication(11L), deadline.Token) && sink.Values.Single().Value is 11L,
                "fresh value can resume without replacing the connection owner");
            var constrained = source.Publication(12L) with { CanCommit = () => false };
            Check(!await source.PublishAsync(constrained, deadline.Token) && sink.Values.Count == 1, "owner combines rather than replaces the producer admission guard");
            Check(!JsonSerializer.Serialize(source.Publication(13L) with { CanCommit = () => true }).Contains("CanCommit", StringComparison.OrdinalIgnoreCase),
                "local commit delegate is absent from wire serialization");
        }

        async Task BindingFailureBuffer()
        {
            var sessions = new ConcurrentQueue<SyntheticSession>();
            using var service = Service("binding", sessions);
            var connection = Connection("binding", 1); var sink = new CommitSink();
            await service.SynchronizeSourcesAsync([connection], 1, _ => sink, deadline.Token);
            var source = sessions.Single();
            source.DuringUpdate = () => {
                var old = source.Publication(20L).Values;
                source.Emit(old);
                source.Status("disconnected");
                source.Emit(old);
            };
            var revised = connection with { Source = connection.Source! with { Points = [new("point", "Renamed", "fixture/value", "Int64", MappingId: "mapping")] } };
            await service.SynchronizeSourcesAsync([revised], 2, _ => sink, deadline.Token);
            Check(sink.Values.IsEmpty && sink.Statuses.Last().State == "disconnected", "binding transition clears pre-failure values and rejects later old receipts");
            source.Status("connected"); source.Emit(source.Publication(21L).Values);
            Check(sink.Values.Single().Value is 21L && sessions.Count == 1, "confirmed hot binding can receive fresh post-failure data on the same owner");
        }

        async Task CleanupAndOwnerIsolation()
        {
            var sessions = new ConcurrentQueue<SyntheticSession>();
            using (var service = Service("cleanup", sessions)) {
                await service.SynchronizeSourcesAsync([Connection("cleanup", 1)], 1, _ => new CommitSink(), deadline.Token);
                var old = sessions.Single(); old.ThrowMonitorDispose = true;
                await service.SynchronizeSourcesAsync([Connection("survivor", 1)], 2, _ => new CommitSink(), deadline.Token);
                Check(old.Disposed == 1 && old.MonitorDisposals == 1, "session cleanup runs when monitor cleanup throws");
                Check(sessions.Count == 2 && sessions.Last().Started == 1, "one owner cleanup failure cannot skip later source acquisition");
            }
            using (var service = new ConnectorService(Path.Combine(root, "factory"), sourceFactory: connection => connection.Id == "bad"
                ? throw new IOException("Independently authored synthetic constructor failure.") : new SyntheticSession(connection))) {
                await service.SynchronizeSourcesAsync([Connection("bad", 1), Connection("after-bad", 1)], 1, _ => new CommitSink(), deadline.Token);
                var failed = JsonSerializer.SerializeToElement(service.SourceDiagnostics("bad"));
                var healthy = JsonSerializer.SerializeToElement(service.SourceDiagnostics("after-bad"));
                Check(failed.GetProperty("state").GetString() == "faulted" && failed.GetProperty("Reason").GetString() == "acquisition-owner",
                    "constructor failure is visible without an installed owner");
                Check(healthy.GetProperty("state").GetString() == "connected", "constructor failure does not prevent subsequent owners from starting");
            }
            sessions = new();
            using (var service = Service("deadline", sessions)) {
                await service.SynchronizeSourcesAsync([Connection("deadline", 1)], 1, _ => new CommitSink(), deadline.Token);
                var source = sessions.Single(); source.MonitorRelease = new(TaskCreationOptions.RunContinuationsAsynchronously);
                var clock = Stopwatch.StartNew();
                try { await Rejected(service.RemoveSourceAsync("deadline", deadline.Token), "uncooperative monitor cleanup"); }
                finally { source.MonitorRelease.SetResult(); }
                Check(source.Disposed == 1 && clock.Elapsed < TimeSpan.FromSeconds(2.7), "deadline still attempts session cleanup within bounded shutdown time");
            }
        }

        async Task RecoveryGateAndFreshness()
        {
            var constructions = 0; var connection = Connection("quarantine", 1);
            using (var service = new ConnectorService(Path.Combine(root, "quarantine"), ensureOperationsAllowed: () => throw new InvalidOperationException("Synthetic quarantine."),
                sourceFactory: definition => { constructions++; return new SyntheticSession(definition); })) {
                await Rejected(service.TestSourceAsync(connection, deadline.Token), "Test during recovery quarantine");
                await Rejected(service.BrowseSourceAsync(connection, new(), deadline.Token), "Browse during recovery quarantine");
                await Rejected(service.ReadSourceAsync(connection, ["point"], deadline.Token), "Read during recovery quarantine");
                Check(constructions == 0, "finite recovery operations cannot construct a source transport");
            }
            var sessions = new ConcurrentQueue<SyntheticSession>();
            using (var service = Service("freshness", sessions)) {
                await service.SynchronizeSourcesAsync([Connection("freshness", 1)], 1, _ => new CommitSink(), deadline.Token);
                var source = sessions.Single(); var original = source.Publication(1L).Values; source.Emit(original);
                var before = JsonSerializer.SerializeToElement(service.SourceDiagnostics("freshness"));
                source.Emit(original);
                Check(JsonSerializer.SerializeToElement(service.SourceDiagnostics("freshness")).GetProperty("acceptedValues").GetInt64() == 1,
                    "duplicate canonical seed receipt is not counted as another accepted value");
                var retain = source.Publication(2L).Values.Select(value => value with { Value = null, Action = SourceValueAction.Retain, Quality = "Bad_DecodingError" }).ToArray();
                source.Emit(retain); await source.PublishAsync(new(retain, [], retain[0].Generation, retain[0].BindingRevision), deadline.Token);
                var after = JsonSerializer.SerializeToElement(service.SourceDiagnostics("freshness"));
                Check(before.GetProperty("lastAcceptedAt").GetString() == after.GetProperty("lastAcceptedAt").GetString()
                    && after.GetProperty("acceptedValues").GetInt64() == 1, "Retain diagnostics never advance accepted value time or count");
            }
        }

        async Task LiveAndMailboxDiagnostics()
        {
            var sessions = new ConcurrentQueue<SyntheticSession>(); var connection = Connection("telemetry", 1);
            using var service = Service("telemetry", sessions);
            await service.SynchronizeSourcesAsync([connection], 1, _ => new CommitSink(), deadline.Token);
            var source = sessions.Single();
            var retained = source.Publication(1L).Values.Select(value => value with { Retained = true, Quality = "Good" }).ToArray(); source.Emit(retained);
            var cached = JsonSerializer.SerializeToElement(service.SourceDiagnostics(connection.Id));
            Check(cached.GetProperty("lastAcceptedAt").ValueKind == JsonValueKind.String && cached.GetProperty("lastLiveAcceptedAt").ValueKind == JsonValueKind.Null,
                "even retained-as-good is accepted cached data without a live receipt");
            var fresh = source.Publication(2L).Values; source.Emit(fresh);
            var before = JsonSerializer.SerializeToElement(service.SourceDiagnostics(connection.Id));
            Check(before.GetProperty("lastLiveAcceptedAt").GetDateTimeOffset() == fresh[0].ReceiptTimestamp
                && before.GetProperty("diagnostics").GetProperty("lastLiveMqttValueAt").GetDateTimeOffset() == fresh[0].ReceiptTimestamp,
                "live receipt provenance is exposed in common and MQTT diagnostics");
            source.Emit(source.Publication(3L).Values.Select(value => value with { Retained = true }).ToArray());
            source.Emit(source.Publication(4L).Values.Select(value => value with { Value = null, Action = SourceValueAction.Clear, Quality = "Bad_NoData" }).ToArray());
            source.Emit(source.Publication(5L).Values.Select(value => value with { Value = null, Action = SourceValueAction.Retain, Quality = "Bad_TypeMismatch" }).ToArray());
            var after = JsonSerializer.SerializeToElement(service.SourceDiagnostics(connection.Id));
            Check(after.GetProperty("lastLiveAcceptedAt").GetString() == before.GetProperty("lastLiveAcceptedAt").GetString(),
                "retained replay, snapshot omission and type failures cannot refresh live time");
            var oldReceipt = Stopwatch.GetTimestamp(); var oldWall = DateTimeOffset.UtcNow;
            source.DuringUpdate = () => source.Emit([source.Publication(6L).Values[0] with { PointId = "imported", MonotonicReceipt = oldReceipt, ReceiptTimestamp = oldWall }]);
            var revised = connection with { Source = connection.Source! with { Points = [.. connection.Source.SavedPoints, new("imported", "Imported", "fixture/cached", "Int64", MappingId: "mapping")] } };
            await service.SynchronizeSourcesAsync([revised], 2, _ => new CommitSink(), deadline.Token);
            Check(JsonSerializer.SerializeToElement(service.SourceDiagnostics(connection.Id)).GetProperty("lastLiveAcceptedAt").GetString() == before.GetProperty("lastLiveAcceptedAt").GetString(),
                "a newly imported old canonical receipt does not establish new live input");
            JsonElement queued = default;
            source.DuringUpdate = () => {
                source.Emit(source.Publication(7L).Values); source.Emit(source.Publication(8L).Values);
                queued = JsonSerializer.SerializeToElement(service.SourceDiagnostics(connection.Id));
            };
            revised = revised with { Source = revised.Source! with { Points = revised.Source.SavedPoints.Select(point => point with { Name = point.Name + " renamed" }).ToArray() } };
            await service.SynchronizeSourcesAsync([revised], 3, _ => new CommitSink(), deadline.Token);
            var completed = JsonSerializer.SerializeToElement(service.SourceDiagnostics(connection.Id));
            Check(queued.GetProperty("diagnostics").GetProperty("pendingQueueCount").GetInt64() == 1
                && queued.GetProperty("diagnostics").GetProperty("pendingQueueBytes").GetInt64() > 0, "transition mailbox reports real admitted records and bytes");
            Check(completed.GetProperty("coalescedValues").GetInt64() == 1
                && completed.GetProperty("diagnostics").GetProperty("pendingQueueBytes").GetInt64() == 0
                && completed.GetProperty("diagnostics").GetProperty("pendingQueueHighWaterBytes").GetInt64() > 0,
                "transition replacement increments coalescing separately and preserves byte high water after drain");
            source.DuringUpdate = () => source.Emit([source.Publication(9L).Values[0] with { Value = new string('x', 9 * 1024 * 1024) }]);
            revised = revised with { Source = revised.Source! with { Points = revised.Source.SavedPoints.Select(point => point with { Name = point.Name + " retry" }).ToArray() } };
            await service.SynchronizeSourcesAsync([revised], 4, _ => new CommitSink(), deadline.Token);
            var rejected = JsonSerializer.SerializeToElement(service.SourceDiagnostics(connection.Id));
            Check(rejected.GetProperty("diagnostics").GetProperty("pendingQueueDroppedRecords").GetInt64() == 1
                && rejected.GetProperty("diagnostics").GetProperty("pendingQueueBytes").GetInt64() == 0,
                "mailbox rejection is counted as loss rather than coalescing");
            source.Status("backoff");
            var backoff = JsonSerializer.SerializeToElement(service.SourceDiagnostics(connection.Id));
            Check(backoff.GetProperty("state").GetString() == "disconnected"
                && backoff.GetProperty("diagnostics").GetProperty("driverState").GetString() == "backoff", "common state preserves raw driver backoff detail");
            var reviewSessions = new ConcurrentQueue<SyntheticSession>(); using var reviewService = Service("review-diagnostics", reviewSessions);
            var review = Connection("review-diagnostics", 1) with { Type = "i3x", Source = new("http://127.0.0.1", "subscribe", Points: [], I3x: new()) };
            await reviewService.SynchronizeSourcesAsync([review], 1, _ => new CommitSink(), deadline.Token);
            var observedAt = DateTimeOffset.UtcNow;
            reviewSessions.Single().Diagnostics(new Dictionary<string, object?> { ["lastAcceptedAt"] = observedAt, ["lastLiveAcceptedAt"] = observedAt, ["lastLiveMqttValueAt"] = observedAt, ["mode"] = "sync" });
            var reviewed = JsonSerializer.SerializeToElement(reviewService.SourceDiagnostics(review.Id));
            Check(reviewed.GetProperty("lastLiveAcceptedAt").GetDateTimeOffset() == observedAt
                && reviewed.GetProperty("diagnostics").GetProperty("lastLiveMqttValueAt").GetDateTimeOffset() == observedAt,
                "zero-bound-point reducer diagnostics survive the shared UI dictionary merge");
            Check(reviewed.GetProperty("diagnostics").GetProperty("mode").GetString() == "sync"
                && reviewed.GetProperty("diagnostics").GetProperty("configuredMode").GetString() == "subscribe",
                "shared i3X diagnostics preserve actual sync fallback separately from configured subscribe mode");
            var disabledOwner = JsonSerializer.SerializeToElement(reviewService.SourceDiagnostics(review.Id, disabled: true));
            Check(disabledOwner.GetProperty("state").GetString() == "disabled"
                && disabledOwner.GetProperty("diagnostics").GetProperty("transportState").GetString() == "disabled"
                && disabledOwner.GetProperty("diagnostics").GetProperty("driverState").GetString() == "connected"
                && disabledOwner.GetProperty("lastLiveAcceptedAt").GetDateTimeOffset() == observedAt,
                "saved disabled state overrides live owner transport state while retaining diagnostic provenance");
            await reviewService.RemoveSourceAsync(review.Id, deadline.Token);
            var disabledRemoved = JsonSerializer.SerializeToElement(reviewService.SourceDiagnostics(review.Id, disabled: true));
            Check(disabledRemoved.GetProperty("state").GetString() == "disabled"
                && disabledRemoved.GetProperty("diagnostics").GetProperty("transportState").GetString() == "disabled",
                "disabled connection without an acquisition owner remains observably disabled");
        }

        ConnectorService Service(string name, ConcurrentQueue<SyntheticSession> sessions) => new(Path.Combine(root, name),
            sourceFactory: connection => { var source = new SyntheticSession(connection); sessions.Enqueue(source); return source; });
    }

    private static ConnectionDefinition Connection(string id, int revision, string endpoint = "mqtt://127.0.0.1:1883") => new(id, "Synthetic source", "mqtt",
        Source: new(endpoint, "subscribe", Points: [new("point", "Value", "fixture/value", "Int64", MappingId: "mapping")],
            Mqtt: new(ClientId: "synthetic-" + id, Mappings: [new("mapping", "fixture/#", "[default]Fixture")])), ConfigurationRevision: revision);

    private static async Task Until(Func<bool> condition, CancellationToken ct) { while (!condition()) await Task.Delay(10, ct); }

    private sealed class CommitSink : ISourceSink
    {
        private readonly object commitGate = new();
        public ConcurrentQueue<SourceValue> Values { get; } = new();
        public ConcurrentQueue<SourceStatus> Statuses { get; } = new();
        public TaskCompletionSource? Entered;
        public TaskCompletionSource? Release;
        public void OnValues(IReadOnlyList<SourceValue> values) { foreach (var value in values) Values.Enqueue(value); }
        public void OnStatus(SourceStatus status) => Statuses.Enqueue(status);
        public void OnDiscovery(SourceDiscoveryBatch discovery) { }
        public async ValueTask<bool> OnPublicationAsync(SourcePublication publication, CancellationToken ct)
        {
            Entered?.TrySetResult();
            if (Release is { } release) await release.Task.WaitAsync(ct);
            lock (commitGate) {
                if (publication.CanCommit?.Invoke() == false) return false;
                OnValues(publication.Values); return true;
            }
        }
    }

    private sealed class SyntheticSession(ConnectionDefinition connection) : ISourceSession
    {
        private ISourceSink? sink;
        private SourceMonitorRequest? current;
        public int Tests; public int Disposed; public int Started; public int MonitorDisposals;
        public TaskCompletionSource? TestRelease;
        public bool IgnoreTestCancellation;
        public TaskCompletionSource? MonitorRelease;
        public bool ThrowMonitorDispose;
        public Action? DuringUpdate;
        public SourceCapabilities Capabilities { get; } = new(connection.Type, ["subscribe"], "observed", CachedReads: true);
        public async Task<SourceTestResult> TestAsync(CancellationToken ct) { Interlocked.Increment(ref Tests); if (TestRelease is { } release) await release.Task.WaitAsync(IgnoreTestCancellation ? CancellationToken.None : ct); return new(true, "Synthetic transport", Capabilities); }
        public Task<SourceBrowsePage> BrowseAsync(SourceBrowseRequest request, CancellationToken ct) => Task.FromResult(new SourceBrowsePage([]));
        public Task<SourceReadBatch> ReadAsync(SourceReadRequest request, CancellationToken ct) => Task.FromResult(new SourceReadBatch([]));
        public Task<ISourceMonitor> StartMonitoringAsync(SourceMonitorRequest request, ISourceSink recipient, CancellationToken lifetime) {
            sink = recipient; current = request; Interlocked.Increment(ref Started); Status("connected"); return Task.FromResult<ISourceMonitor>(new SyntheticMonitor(this));
        }
        public void Status(string state) => sink!.OnStatus(new(state, Generation: current!.Generation, BindingRevision: current.Bindings.Revision));
        public void Diagnostics(IReadOnlyDictionary<string, object?> metrics) => sink!.OnStatus(new("connected", Generation: current!.Generation, BindingRevision: current.Bindings.Revision, Diagnostics: metrics));
        public void Emit(IReadOnlyList<SourceValue> values) => sink!.OnValues(values);
        public SourcePublication Publication(long value) => new([new("point", value, "Int64", "Good", ReceiptTimestamp: DateTimeOffset.UtcNow,
            Generation: current!.Generation, BindingRevision: current.Bindings.Revision, MonotonicReceipt: Stopwatch.GetTimestamp())], [], current.Generation, current.Bindings.Revision);
        public Task<bool> PublishAsync(SourcePublication publication, CancellationToken ct) => sink!.OnPublicationAsync(publication, ct).AsTask();
        public ValueTask DisposeAsync() { Interlocked.Increment(ref Disposed); return ValueTask.CompletedTask; }
        private sealed class SyntheticMonitor(SyntheticSession source) : ISourceMonitor
        {
            public Task UpdateBindingsAsync(SourceBindingRevision revision, CancellationToken ct) { source.current = source.current! with { Bindings = revision }; source.DuringUpdate?.Invoke(); return Task.CompletedTask; }
            public ValueTask DisposeAsync() {
                Interlocked.Increment(ref source.MonitorDisposals);
                if (source.ThrowMonitorDispose) throw new InvalidOperationException("Independently authored monitor cleanup failure.");
                return source.MonitorRelease is { } release ? new(release.Task) : ValueTask.CompletedTask;
            }
        }
    }
}
