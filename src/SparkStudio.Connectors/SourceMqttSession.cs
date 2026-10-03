using System.Diagnostics;

namespace SparkStudio.Connectors;

public sealed class SourceMqttSession : ISourceSession
{
    private readonly ConnectionDefinition connection;
    private readonly string dataDirectory;
    private readonly SemaphoreSlim lifecycle = new(1, 1);
    private readonly SemaphoreSlim state = new(1, 1);
    private readonly SourceTransportTelemetry telemetry = new();
    private SourceMqttMappingEngine engine;
    private Monitor? monitor;
    private bool disposed;
    public SourceCapabilities Capabilities { get; } = new("mqtt", ["subscribe"], "observed", true, 256, false, ["scalar", "script"]);
    public SourceMqttSession(ConnectionDefinition connection, string dataDirectory)
    {
        SourceConfiguration.Validate("mqtt", connection.Source ?? throw new ArgumentException("Source settings are required."));
        this.connection = connection; this.dataDirectory = dataDirectory;
        engine = new(connection, new(0, connection.Source.SavedPoints, connection.Source.Mqtt?.Mappings), 0);
    }
    public async Task<SourceTestResult> TestAsync(CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        using var deadline = Deadline(ct);
        await lifecycle.WaitAsync(deadline.Token);
        try
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            // A second CONNECT with the saved client ID would evict acquisition
            // and may reset broker session state. Inspect its acknowledged owner.
            if (monitor is not null) return await monitor.TestAsync(deadline.Token);
            await using var candidate = new SourceMqttMappingEngine(connection, new(0, connection.Source!.SavedPoints), 0);
            await candidate.WarmAsync(deadline.Token);
            await using var wire = await SourceMqttWire.ConnectAsync(connection, dataDirectory, deadline.Token, telemetry);
            wire.Start(_ => true, (_, _) => { });
            await wire.SubscribeAsync(Filters(connection.Source.Mqtt?.Mappings ?? []), deadline.Token);
            return new(true, "MQTT subscriber connected and subscriptions were acknowledged.", Capabilities, connection.Source.Mqtt?.ProtocolVersion);
        }
        catch (Exception error) when (error is IOException or ArgumentException or TimeoutException or OperationCanceledException or PlatformNotSupportedException or System.Security.Authentication.AuthenticationException)
        { if (ct.IsCancellationRequested) throw; return new(false, error.Message, Capabilities); }
        finally { lifecycle.Release(); }
    }
    public async Task<SourceBrowsePage> BrowseAsync(SourceBrowseRequest request, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(disposed, this); using var deadline = Deadline(ct);
        await state.WaitAsync(deadline.Token); try { return engine.Browse(request); } finally { state.Release(); }
    }
    public async Task<SourceReadBatch> ReadAsync(SourceReadRequest request, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(disposed, this); using var deadline = Deadline(ct);
        await state.WaitAsync(deadline.Token);
        try
        {
            var cached = engine.Read(request);
            return monitor is { IsTransportUp: false } down ? new(cached.Values.Select(value => value with { Quality = down.DownQuality, Action = SourceValueAction.Retain }).ToArray()) : cached;
        }
        finally { state.Release(); }
    }
    public async Task<ISourceMonitor> StartMonitoringAsync(SourceMonitorRequest request, ISourceSink sink, CancellationToken lifetime)
    {
        await lifecycle.WaitAsync(lifetime);
        try
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (monitor is not null) throw new InvalidOperationException("This source session already has a monitor.");
            Validate(request.Bindings);
            await state.WaitAsync(lifetime);
            try
            {
                engine.Update(request.Bindings); engine.SetGeneration(request.Generation);
                var created = new Monitor(this, request, sink, lifetime); monitor = created;
                created.Start(); return created;
            }
            finally { state.Release(); }
        }
        finally { lifecycle.Release(); }
    }
    private void Validate(SourceBindingRevision revision)
    {
        SourceConfiguration.Validate("mqtt", connection.Source! with { Points = revision.Points.ToArray(), Mqtt = (connection.Source!.Mqtt ?? new()) with { Mappings = revision.Mappings?.ToArray() ?? connection.Source.Mqtt?.Mappings } });
    }
    private CancellationTokenSource Deadline(CancellationToken ct)
    { var source = CancellationTokenSource.CreateLinkedTokenSource(ct); source.CancelAfter(Math.Clamp(connection.Source!.EffectiveLimits.OperationTimeoutMs, 1, 30000)); return source; }
    private static (string Filter, int Qos)[] Filters(IReadOnlyList<SourceMqttMapping> mappings) => mappings.Where(mapping => mapping.Enabled).Select(mapping => (mapping.TopicFilter, mapping.Qos)).ToArray();
    public async ValueTask DisposeAsync()
    {
        await lifecycle.WaitAsync();
        try { if (disposed) return; disposed = true; if (monitor is not null) await monitor.DisposeAsync(); await engine.DisposeAsync(); }
        finally { lifecycle.Release(); }
    }
    private sealed class Monitor : ISourceMonitor
    {
        private sealed record Record(SourceMqttWire.Publish Message, DateTimeOffset Receipt, long Monotonic, int Bytes);
        private readonly SourceMqttSession owner;
        private readonly ISourceSink sink;
        private readonly CancellationTokenSource stop;
        private readonly SemaphoreSlim changed = new(0, 1);
        private readonly SemaphoreSlim bindingsGate = new(1, 1);
        private readonly SourceMemoryBudget budget = new();
        private readonly object queueGate = new();
        private readonly Queue<Record> queue = [];
        private readonly Dictionary<string, string> rejections = new(StringComparer.Ordinal);
        private long rejectionOrdinal, rejectionBytes, queueBytes, lost;
        private long queuePeakCount, queuePeakBytes, nextDiagnostics;
        private long transportAttempts, reconnectAttempts, recoveries;
        private IReadOnlyDictionary<string, object?> lastWireMetrics = new Dictionary<string, object?>();
        private bool rejectAll, transportUp, subscriptionsReady, disposed;
        internal string DownQuality { get; private set; } = "Bad_CommunicationError";
        private long epoch;
        private readonly long generation;
        private SourceBindingRevision bindings;
        private SourceMqttWire? wire;
        private Task? runner, processor;
        internal Monitor(SourceMqttSession owner, SourceMonitorRequest request, ISourceSink sink, CancellationToken lifetime)
        { this.owner = owner; this.sink = sink; generation = request.Generation; bindings = request.Bindings; stop = CancellationTokenSource.CreateLinkedTokenSource(lifetime); }
        internal bool IsTransportUp { get { lock (queueGate) return transportUp; } }
        internal async Task<SourceTestResult> TestAsync(CancellationToken ct)
        {
            await bindingsGate.WaitAsync(ct);
            try
            {
                lock (queueGate)
                {
                    var connected = transportUp && subscriptionsReady && !stop.IsCancellationRequested
                        && wire is { Completion.IsCompleted: false };
                    return new(connected, connected
                        ? "The active MQTT subscriber is connected and its subscriptions were acknowledged. Acquisition was reused."
                        : "The active MQTT subscriber has no acknowledged live subscription set. Check source diagnostics and retry after it reconnects.",
                        owner.Capabilities, owner.connection.Source!.Mqtt?.ProtocolVersion);
                }
            }
            finally { bindingsGate.Release(); }
        }
        internal void Start()
        {
            Safe(() => sink.OnValues(bindings.Points.Select(point => SourceValue.NoData(point, generation, bindings.Revision) with { Quality = "Bad_WaitingForInitialData" }).ToArray()));
            var disabled = owner.engine.Disabled(); if (disabled.Count > 0) Safe(() => sink.OnValues(disabled));
            processor = ProcessAsync(stop.Token); runner = RunAsync(stop.Token);
        }
        private void Signal() { try { changed.Release(); } catch (SemaphoreFullException) { } catch (ObjectDisposedException) { } }
        private bool Admit(SourceMqttWire.Publish message)
        {
            var cost = checked(message.Payload.Length + message.Topic.Length * 2 + 256);
            lock (queueGate)
            {
                if (stop.IsCancellationRequested || !transportUp || queue.Count >= owner.connection.Source!.EffectiveLimits.QueueCount || cost > owner.connection.Source.EffectiveLimits.QueueBytes - queueBytes) return false;
                try { budget.SetBytes("queue", queueBytes + cost); } catch (SourceLimitException) { return false; }
                queue.Enqueue(new(message, DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), cost)); queueBytes += cost;
                queuePeakCount = Math.Max(queuePeakCount, queue.Count); queuePeakBytes = Math.Max(queuePeakBytes, queueBytes);
            }
            Signal(); return true;
        }
        private void Rejected(SourceMqttWire.Publish message, string reason)
        {
            lock (queueGate)
            {
                if (stop.IsCancellationRequested) return;
                lost++; rejectionOrdinal = Math.Max(rejectionOrdinal, message.Ordinal);
                if (!rejections.ContainsKey(message.Topic)) rejectionBytes += message.Topic.Length * 2L + 256;
                if (rejections.Count >= 100 || rejectionBytes > 256 * 1024) { rejections.Clear(); rejectAll = true; rejectionBytes = 0; }
                else if (!rejectAll) rejections[message.Topic] = reason;
            }
            Signal();
        }
        private async Task RunAsync(CancellationToken ct)
        {
            var attempt = 0;
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    Status("Connecting", "Connecting MQTT subscriber.");
                    using var connectDeadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    connectDeadline.CancelAfter(Math.Clamp(owner.connection.Source!.EffectiveLimits.ConnectTimeoutMs, 1, 5000));
                    await owner.state.WaitAsync(connectDeadline.Token); try { await owner.engine.WarmAsync(connectDeadline.Token); } finally { owner.state.Release(); }
                    if (Interlocked.Increment(ref transportAttempts) > 1) Interlocked.Increment(ref reconnectAttempts);
                    var candidate = await SourceMqttWire.ConnectAsync(owner.connection, owner.dataDirectory, connectDeadline.Token, owner.telemetry);
                    await bindingsGate.WaitAsync(ct);
                    try
                    {
                        wire = candidate;
                        lock (queueGate) { epoch++; transportUp = true; subscriptionsReady = false; }
                        candidate.Start(Admit, Rejected);
                        await candidate.SubscribeAsync(Filters(bindings.Mappings ?? owner.connection.Source!.Mqtt?.Mappings ?? []), connectDeadline.Token);
                        lock (queueGate) subscriptionsReady = true;
                    }
                    finally { bindingsGate.Release(); }
                    if (Interlocked.Read(ref transportAttempts) > 1) Interlocked.Increment(ref recoveries);
                    attempt = 0; Status("Connected", "MQTT subscriptions active.");
                    await candidate.Completion.WaitAsync(ct);
                    throw new IOException("MQTT transport stopped.");
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
                catch (Exception error)
                {
                    await FenceDownAsync(error.Message, ct, error.Message.Contains("timed out", StringComparison.OrdinalIgnoreCase) ? "Bad_Timeout" : "Bad_CommunicationError");
                    var permanent = error is SourceMqttWire.ProtocolException or SourceMqttWire.RejectedException or SourceLimitException or FileNotFoundException or ArgumentException or PlatformNotSupportedException;
                    if (permanent) { Status("Faulted", error.Message, "configuration-or-protocol"); return; }
                    Status("Backoff", error.Message, "communication");
                    var milliseconds = Math.Min(30000, 1000 * (1 << Math.Min(attempt++, 5))) + Random.Shared.Next(0, 250);
                    try { await Task.Delay(milliseconds, ct); } catch (OperationCanceledException) { break; }
                }
            }
            await FenceDownAsync("MQTT subscriber stopped.", CancellationToken.None);
        }
        private async Task FenceDownAsync(string reason, CancellationToken ct, string quality = "Bad_CommunicationError")
        {
            DownQuality = quality;
            lock (queueGate) { transportUp = false; subscriptionsReady = false; epoch++; queue.Clear(); queueBytes = 0; rejections.Clear(); rejectionOrdinal = rejectionBytes = 0; rejectAll = false; budget.SetBytes("queue", 0); }
            Status("Disconnected", reason, "communication");
            var previous = Interlocked.Exchange(ref wire, null); if (previous is not null) { lastWireMetrics = previous.Metrics(); await previous.DisposeAsync(); }
            await owner.state.WaitAsync(ct);
            try { Emit(owner.engine.TransportDown(quality, reason)); }
            finally { owner.state.Release(); }
            Signal();
        }
        private async Task ProcessAsync(CancellationToken ct)
        {
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    if (IsTransportUp && Stopwatch.GetTimestamp() >= nextDiagnostics) { nextDiagnostics = Stopwatch.GetTimestamp() + Stopwatch.Frequency; Status("Connected", "MQTT diagnostic snapshot."); }
                    Record? record = null; KeyValuePair<string, string>[]? losses = null; bool all = false; long lossOrdinal = 0, fence;
                    lock (queueGate)
                    {
                        fence = epoch;
                        if (rejectionOrdinal > 0 && (queue.Count == 0 || queue.Peek().Message.Ordinal > rejectionOrdinal))
                        { losses = rejections.ToArray(); all = rejectAll; lossOrdinal = rejectionOrdinal; rejections.Clear(); rejectAll = false; rejectionOrdinal = rejectionBytes = 0; }
                        else if (queue.TryDequeue(out record)) { queueBytes -= record.Bytes; budget.SetBytes("queue", queueBytes); }
                    }
                    if (record is null && losses is null)
                    {
                        await changed.WaitAsync(TimeSpan.FromMilliseconds(100), ct);
                        await owner.state.WaitAsync(ct);
                        try { var stale = owner.engine.Stale(Stopwatch.GetTimestamp()); if (stale.Count > 0) Safe(() => sink.OnValues(stale)); }
                        finally { owner.state.Release(); }
                        continue;
                    }
                    await owner.state.WaitAsync(ct);
                    try
                    {
                        lock (queueGate) { if (!transportUp || epoch != fence) continue; }
                        if (losses is not null)
                        {
                            if (all) Emit(owner.engine.Loss(null, "MQTT input loss affected more topics than the bounded diagnostic set.", lossOrdinal));
                            else foreach (var loss in losses) Emit(owner.engine.Reject(loss.Key, loss.Value.Contains("payload exceeds", StringComparison.Ordinal) ? "Bad_DecodingError" : "Uncertain_DataLoss", loss.Value, lossOrdinal));
                            Status("Connected", "MQTT input rejection recorded.", "input-loss");
                        }
                        else if (record is not null)
                        {
                            var result = await owner.engine.ProcessAsync(record.Message, record.Receipt, record.Monotonic, ct, sink.OnPublicationAsync);
                            lock (queueGate) { if (!transportUp || epoch != fence) continue; }
                            if (!result.Published) Emit(result);
                            if (result.Error is not null) Status("Connected", result.Error, "mapping");
                        }
                    }
                    finally { owner.state.Release(); }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
            catch (Exception error) { Status("Faulted", "MQTT processing failed: " + error.Message, "processing"); stop.Cancel(); }
        }
        private void Emit(SourceMqttMappingEngine.Result result)
        {
            if (result.Values.Count > 0) Safe(() => sink.OnValues(result.Values));
            if (result.Discoveries.Count > 0) Safe(() => sink.OnDiscovery(new(result.Discoveries, generation, bindings.Revision)));
        }
        private void Safe(Action callback) { try { callback(); } catch (Exception error) { try { sink.OnStatus(new("Faulted", "Source callback failed: " + error.Message, generation, bindings.Revision, "callback")); } catch { } } }
        private void Status(string status, string message, string? reason = null)
        {
            var metrics = new Dictionary<string, object?>(wire?.Metrics() ?? lastWireMetrics);
            foreach (var pair in owner.telemetry.Snapshot()) metrics[pair.Key] = pair.Value;
            foreach (var pair in owner.engine.Metrics()) metrics[pair.Key] = pair.Value;
            metrics["inputByteBasis"] = "received MQTT protocol bytes, including headers and control packets";
            metrics["reconnectAttempts"] = Interlocked.Read(ref reconnectAttempts); metrics["recoveryCount"] = Interlocked.Read(ref recoveries);
            metrics["mode"] = "subscribe"; metrics["protocolGaps"] = null; metrics["protocolGapBasis"] = "MQTT receipt order cannot prove publisher completeness";
            lock (queueGate) { metrics["queueCount"] = queue.Count; metrics["queueBytes"] = queueBytes; metrics["queueHighWaterCount"] = queuePeakCount; metrics["queueHighWaterBytes"] = queuePeakBytes; metrics["rejectionTopics"] = rejections.Count; metrics["rejectionBytes"] = rejectionBytes; }
            var global = SourceMemoryBudget.Snapshot(); metrics["globalQueueBytes"] = global.GetValueOrDefault("queue"); metrics["globalDecodeBytes"] = global.GetValueOrDefault("decode"); metrics["globalWorkerBytes"] = global.GetValueOrDefault("workers");
            Safe(() => sink.OnStatus(new(status, message, generation, bindings.Revision, reason, LostUpdates: Interlocked.Read(ref lost), Diagnostics: metrics)));
        }
        public async Task UpdateBindingsAsync(SourceBindingRevision revision, CancellationToken ct)
        {
            owner.Validate(revision); using var deadline = owner.Deadline(ct);
            await bindingsGate.WaitAsync(deadline.Token);
            try
            {
                lock (queueGate) subscriptionsReady = false;
                await owner.state.WaitAsync(deadline.Token);
                try
                {
                    await owner.engine.WarmCandidateAsync(revision, deadline.Token);
                    var previous = bindings; var oldFilters = Filters(previous.Mappings ?? owner.connection.Source!.Mqtt?.Mappings ?? []);
                    var newFilters = Filters(revision.Mappings ?? owner.connection.Source!.Mqtt?.Mappings ?? []);
                    var added = newFilters.Where(filter => !oldFilters.Contains(filter)).ToArray();
                    var removed = oldFilters.Where(filter => !newFilters.Any(candidate => candidate.Filter == filter.Filter)).Select(filter => filter.Filter).ToArray();
                    var discarded = false;
                    void DiscardInputs() {
                        lock (queueGate) {
                            if (queue.Count > 0) { Interlocked.Add(ref lost, queue.Count); discarded = true; }
                            if (rejectionOrdinal > 0) discarded = true;
                            epoch++; queue.Clear(); queueBytes = 0; rejections.Clear(); rejectionOrdinal = rejectionBytes = 0; rejectAll = false; budget.SetBytes("queue", 0);
                        }
                    }
                    // The receive task stays live and bounded while this gate holds decoding.
                    // Retained packets delivered before SUBACK are part of the candidate buffer.
                    DiscardInputs();
                    try
                    {
                        if (wire is { } live) { await live.SubscribeAsync(added, deadline.Token); await live.UnsubscribeAsync(removed, deadline.Token); }
                        owner.engine.Update(revision); bindings = revision;
                        lock (queueGate) subscriptionsReady = transportUp;
                    }
                    catch
                    {
                        DiscardInputs();
                        if (wire is { } live)
                        {
                            try { await live.SubscribeAsync(oldFilters, deadline.Token); await live.UnsubscribeAsync(added.Where(filter => !oldFilters.Any(old => old.Filter == filter.Filter)).Select(filter => filter.Filter).ToArray(), deadline.Token); }
                            catch { await live.DisposeAsync(); Status("Faulted", "MQTT binding compensation failed; transport will reconcile the prior interests.", "bindings"); }
                        }
                        if (discarded) Emit(owner.engine.Loss(null, "MQTT binding compensation discarded pending source input."));
                        throw;
                    }
                    if (discarded) { Emit(owner.engine.Loss(null, "MQTT binding change discarded pending source input.")); Status("Connected", "MQTT binding input loss is counted; valid values must replace affected leaves.", "input-loss"); }
                    foreach (var point in revision.Points.Where(point => !previous.Points.Any(old => old.Id == point.Id))) Safe(() => sink.OnValues([SourceValue.NoData(point, generation, revision.Revision) with { Quality = "Bad_WaitingForInitialData" }]));
                    var disabled = owner.engine.Disabled(); if (disabled.Count > 0) Safe(() => sink.OnValues(disabled));
                }
                finally { owner.state.Release(); }
                Signal();
                if (runner?.IsCompleted == true && !stop.IsCancellationRequested) runner = RunAsync(stop.Token);
            }
            finally { bindingsGate.Release(); }
        }
        public async ValueTask DisposeAsync()
        {
            if (disposed) return; disposed = true; stop.Cancel(); Signal();
            var previous = Interlocked.Exchange(ref wire, null); if (previous is not null) await previous.DisposeAsync();
            foreach (var task in new[] { runner, processor }) if (task is not null) try { await task.WaitAsync(TimeSpan.FromSeconds(2)); } catch { }
            lock (queueGate) { queue.Clear(); queueBytes = 0; budget.SetBytes("queue", 0); }
            budget.Dispose(); stop.Dispose(); owner.monitor = null;
        }
    }
}
