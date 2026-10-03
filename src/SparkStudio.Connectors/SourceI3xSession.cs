using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace SparkStudio.Connectors;

/// <summary>Read-only i3X 1.0 current-value, sync and optional SSE source.</summary>
public sealed class SourceI3xSession : ISourceSession
{
    private readonly SourceSettings settings;
    private readonly SourceI3xClient protocol;
    private readonly HttpClient? injectedClient;
    private readonly string clientId;
    private readonly SemaphoreSlim catalogGate = new(1, 1);
    private IReadOnlyList<I3xObject>? catalog;
    private DateTimeOffset catalogCreated;
    private readonly SourceMemoryBudget memory = new();
    private readonly SourceTransportTelemetry telemetry = new();
    private long catalogBytes;
    private bool catalogTruncated;
    private Monitor? monitor;
    private bool disposed;
    public SourceCapabilities Capabilities { get; } = new("i3x", ["poll", "subscribe", "stream", "sync"], "native", MaximumReadBatch: 250);

    public SourceI3xSession(ConnectionDefinition connection, HttpClient? client = null)
    {
        settings = connection.Source ?? throw new ArgumentException("i3X source settings are required.");
        SourceConfiguration.Validate("i3x", settings);
        injectedClient = client ?? SourceHttp.CreateClient(connection);
        var authentication = settings.Authentication ?? new();
        AuthenticationHeaderValue? header = authentication.Mode.ToLowerInvariant() switch {
            "none" => null,
            "basic" => new("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes((authentication.Username ?? "") + ":" + (authentication.Password ?? "")))),
            "bearer" => new("Bearer", authentication.Token),
            "apikey" or "api-key" => null,
            _ => throw new ArgumentException("Unsupported i3X authentication mode."),
        };
        protocol = new(new Uri(settings.Endpoint), settings.EffectiveLimits.DocumentBytes,
            settings.EffectiveLimits.RequestTimeoutMs, injectedClient, header,
            authentication.Mode is "apikey" or "api-key" ? authentication.Header : null,
            authentication.Mode is "apikey" or "api-key" ? authentication.Token : null, settings.EffectiveLimits, telemetry);
        clientId = settings.I3x?.ClientId ?? "sparkstudio-" + Guid.NewGuid().ToString("N");
    }

    public async Task<SourceTestResult> TestAsync(CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        var info = await protocol.InfoAsync(ct);
        return new(true, "i3X read source is reachable; subscriptions use best-effort current-state reconciliation.", Capabilities,
            info.SpecVersion, new Dictionary<string, object?> {
                ["serverVersion"] = info.ServerVersion, ["streamAdvertised"] = info.Stream,
                ["reconciliationSeconds"] = settings.I3x?.ReconciliationSeconds ?? 30,
                ["maximumReadBatch"] = 250, ["limits"] = settings.EffectiveLimits,
                ["consistency"] = "best-effort; no lossless event delivery",
            });
    }

    public async Task<SourceBrowsePage> BrowseAsync(SourceBrowseRequest request, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (request.PageSize is < 1 or > 500) throw new ArgumentException("Browse page size must be 1–500.");
        await catalogGate.WaitAsync(ct);
        try
        {
            if (catalog is null || DateTimeOffset.UtcNow - catalogCreated >= TimeSpan.FromMinutes(5))
            {
                if (request.ContinuationToken is not null) throw new ArgumentException("The i3X browse token expired; refresh the catalog.");
                // An expired snapshot is no longer a usable catalog. Retire it before
                // admitting a replacement so both snapshots cannot consume the budget.
                catalog = null;
                Volatile.Write(ref catalogTruncated, false);
                memory.SetBytes("catalog", 0);
                Interlocked.Exchange(ref catalogBytes, 0);
                memory.SetBytes("catalog", settings.EffectiveLimits.CatalogBytes);
                try
                {
                    var candidate = await protocol.ObjectsAsync(ct);
                    var bytes = candidate.Sum(item => 128L + Encoding.UTF8.GetByteCount(item.Id + item.Name + item.ParentId + item.TypeId + item.Schema.GetRawText()) * 2L);
                    if (candidate.Count > settings.EffectiveLimits.CatalogCount || bytes > settings.EffectiveLimits.CatalogBytes)
                        throw new I3xProtocolException("i3X browse catalog exceeds configured capacity.");
                    memory.SetBytes("catalog", bytes);
                    Interlocked.Exchange(ref catalogBytes, bytes);
                    catalog = candidate;
                    catalogCreated = DateTimeOffset.UtcNow;
                }
                catch { memory.SetBytes("catalog", 0); throw; }
            }
            var entries = new List<SourceBrowseEntry>();
            foreach (var item in catalog.Where(item => string.IsNullOrEmpty(request.Parent) ? string.IsNullOrEmpty(item.ParentId) : item.ParentId == request.Parent))
                entries.Add(Entry(item));
            if (request.Parent is not null && catalog.FirstOrDefault(item => item.Id == request.Parent) is { } parent)
            {
                AddSelectors(parent, parent.Schema, "", entries, 0);
                if (entries.Count == 0) entries.Add(Entry(parent));
            }
            var truncated = entries.Count >= settings.EffectiveLimits.CatalogCount;
            Volatile.Write(ref catalogTruncated, truncated);
            return SourceBrowse.Page(entries, request, truncated);
        }
        finally { catalogGate.Release(); }
    }

    private SourceBrowseEntry Entry(I3xObject item)
    {
        var type = SchemaType(item.Schema);
        return new(item.Id, item.Name, true, type, Parent: item.ParentId,
            Metadata: new Dictionary<string, object?> { ["typeElementId"] = item.TypeId, ["isComposition"] = item.Composition,
                ["shape"] = type == "String" && item.Schema.TryGetProperty("type", out var raw) && raw.ValueKind == JsonValueKind.String ? raw.GetString() : "scalar" },
            SuggestedPath: SuggestedPath(item));
    }
    private string SuggestedPath(I3xObject item)
    {
        var names = new List<string>();
        var visited = new HashSet<string>(StringComparer.Ordinal);
        while (visited.Add(item.Id) && names.Count < 64)
        {
            // Stable identity suffix avoids sanitizer and sibling display-name collisions.
            names.Add(Segment(item.Name) + "_" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(item.Id)))[..16].ToLowerInvariant());
            if (item.ParentId is null || catalog?.FirstOrDefault(parent => parent.Id == item.ParentId) is not { } parent) break;
            item = parent;
        }
        names.Reverse();
        var path = string.Join('/', names);
        return path.Length <= 512 ? path : path[..480] + "_" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(path)))[..16].ToLowerInvariant();
    }
    private void AddSelectors(I3xObject item, JsonElement schema, string pointer, List<SourceBrowseEntry> result, int depth)
    {
        if (depth >= 16 || result.Count >= settings.EffectiveLimits.CatalogCount) return;
        if (schema.TryGetProperty("properties", out var properties) && properties.ValueKind == JsonValueKind.Object)
        {
            foreach (var field in properties.EnumerateObject())
            {
                var child = pointer + "/" + field.Name.Replace("~", "~0", StringComparison.Ordinal).Replace("/", "~1", StringComparison.Ordinal);
                if (child.Length > 512) throw new SourceLimitException("i3X schema selector exceeds 512 characters.");
                if (field.Value.ValueKind != JsonValueKind.Object) continue;
                if (field.Value.TryGetProperty("properties", out _)) AddSelectors(item, field.Value, child, result, depth + 1);
                else result.Add(new(item.Id, field.Name, true, SchemaType(field.Value), child, item.Id,
                    SuggestedPath: SuggestedPath(item) + "/" + Segment(field.Name) + "_"
                        + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(child)))[..16].ToLowerInvariant()));
                if (result.Count >= settings.EffectiveLimits.CatalogCount) return;
            }
        }
    }
    private static string Segment(string value)
    {
        var result = new string(value.Select(character => char.IsLetterOrDigit(character) || character is '_' or '-' ? character : '_').ToArray());
        return string.IsNullOrEmpty(result) ? "item" : result[..Math.Min(result.Length, 128)];
    }
    private static string SchemaType(JsonElement schema)
    {
        if (!schema.TryGetProperty("type", out var type)) return "String";
        var name = type.ValueKind == JsonValueKind.String ? type.GetString() : type.ValueKind == JsonValueKind.Array
            ? type.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.String && item.GetString() != "null").Select(item => item.GetString()).FirstOrDefault() : null;
        return name switch { "boolean" => "Boolean", "integer" => "Int64", "number" => "Double", _ => "String" };
    }

    public async Task<SourceReadBatch> ReadAsync(SourceReadRequest request, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (request.Points.Count > 1000) throw new ArgumentException("Read at most 1000 source points per user request.");
        return await ReadAllAsync(request.Points, request.Generation, request.BindingRevision, ct);
    }

    private async Task<SourceReadBatch> ReadAllAsync(IReadOnlyList<SourcePoint> points, long generation, long revision, CancellationToken ct)
    {
        var values = new List<SourceValue>(points.Count);
        using var projectionAdmission = new SourceMemoryBudget();
        long valueBytes = 0;
        var byAddress = points.GroupBy(point => point.Address, StringComparer.Ordinal).ToDictionary(group => group.Key, group => group.ToArray(), StringComparer.Ordinal);
        foreach (var ids in byAddress.Keys.Chunk(250))
        {
            var readings = await protocol.ReadAsync(ids, ct);
            foreach (var reading in readings)
            {
                var projection = byAddress[reading.ElementId];
                var candidateBytes = EstimateProjection(reading, projection, settings.EffectiveLimits.ValueBytes);
                if (valueBytes + candidateBytes > settings.EffectiveLimits.StateBytes)
                    throw new SourceLimitException("i3X current batch exceeds the value-state ceiling.");
                projectionAdmission.SetBytes("values", valueBytes + candidateBytes);
                var projected = Project(reading, projection, generation, revision, maximumValueBytes: settings.EffectiveLimits.ValueBytes);
                valueBytes += candidateBytes;
                values.AddRange(projected);
            }
        }
        return new(values);
    }

    private static long EstimateProjection(I3xVqt vqt, IReadOnlyList<SourcePoint> points, int valueLimit)
    {
        long bytes = 0;
        foreach (var group in points.GroupBy(point => point.Selector, StringComparer.Ordinal))
        {
            var perPoint = 128L;
            if (vqt.Error is null)
            {
                try
                {
                    var selected = SourceI3xClient.Select(vqt.Value, group.Key);
                    if (selected.ValueKind != JsonValueKind.Undefined)
                        perPoint += Math.Min((long)Encoding.UTF8.GetByteCount(selected.GetRawText()), valueLimit) * 2L;
                }
                catch (ArgumentException) { }
            }
            bytes = checked(bytes + perPoint * group.Count());
        }
        return bytes;
    }

    private static SourceValue[] Project(I3xVqt vqt, IReadOnlyList<SourcePoint> points,
        long generation, long revision, string? epoch = null, ulong? sequence = null, long ordinal = 0,
        int maximumValueBytes = 65536)
    {
        var receipt = DateTimeOffset.UtcNow;
        var monotonic = Stopwatch.GetTimestamp();
        var converted = new Dictionary<(string Selector, string Type), object>();
        return points.Select(point => {
            if (vqt.Error is not null)
                return new SourceValue(point.Id, null, point.DataType, vqt.Quality, ReceiptTimestamp: receipt,
                    Action: SourceValueAction.Retain, NativeStatus: vqt.Error, Generation: generation, BindingRevision: revision,
                    Epoch: epoch, Sequence: sequence, IngressOrdinal: ordinal, MonotonicReceipt: monotonic);
            JsonElement selected;
            try { selected = SourceI3xClient.Select(vqt.Value, point.Selector); }
            catch (ArgumentException)
            { return new SourceValue(point.Id, null, point.DataType, "Bad_DecodingError", ReceiptTimestamp: receipt, Action: SourceValueAction.Retain,
                NativeStatus: "Invalid JSON pointer.", Generation: generation, BindingRevision: revision, Epoch: epoch, Sequence: sequence,
                IngressOrdinal: ordinal, MonotonicReceipt: monotonic); }
            if (selected.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null || vqt.Quality == "GoodNoData")
                return new SourceValue(point.Id, null, point.DataType, vqt.Quality == "Bad" ? "Bad" : "Bad_NoData", vqt.Timestamp, receipt,
                    SourceValueAction.Clear, vqt.Quality, generation, revision, epoch, sequence, ordinal, MonotonicReceipt: monotonic);
            try
            {
                if (Encoding.UTF8.GetByteCount(selected.GetRawText()) > maximumValueBytes)
                    return new SourceValue(point.Id, null, point.DataType, "Bad_DecodingError", ReceiptTimestamp: receipt,
                        Action: SourceValueAction.Retain, NativeStatus: "Scalar byte ceiling exceeded.", Generation: generation,
                        BindingRevision: revision, Epoch: epoch, Sequence: sequence, IngressOrdinal: ordinal, MonotonicReceipt: monotonic);
                var key = (point.Selector ?? "", point.DataType);
                if (!converted.TryGetValue(key, out var scalar)) converted.Add(key, scalar = SourceI3xClient.ConvertValue(selected, point.DataType));
                return new SourceValue(point.Id, scalar, point.DataType, vqt.Quality,
                    vqt.Timestamp, receipt, SourceValueAction.Replace, vqt.Quality, generation, revision, epoch, sequence, ordinal,
                    MonotonicReceipt: monotonic);
            }
            catch (ArgumentException)
            { return new SourceValue(point.Id, null, point.DataType, "Bad_TypeMismatch", ReceiptTimestamp: receipt, Action: SourceValueAction.Retain,
                NativeStatus: vqt.Quality, Generation: generation, BindingRevision: revision, Epoch: epoch, Sequence: sequence,
                IngressOrdinal: ordinal, MonotonicReceipt: monotonic); }
        }).ToArray();
    }

    public Task<ISourceMonitor> StartMonitoringAsync(SourceMonitorRequest request, ISourceSink sink, CancellationToken lifetime)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        lock (this)
        {
            if (monitor is not null) throw new InvalidOperationException("An i3X source session has one acquisition owner.");
            monitor = new(this, request, sink, lifetime);
            return Task.FromResult<ISourceMonitor>(monitor);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (disposed) return;
        disposed = true;
        if (monitor is not null) await monitor.DisposeAsync();
        protocol.Dispose();
        injectedClient?.Dispose();
        memory.Dispose();
        catalogGate.Dispose();
    }

    private sealed class Monitor : ISourceMonitor
    {
        private readonly SourceI3xSession owner;
        private readonly ISourceSink sink;
        private readonly long generation;
        private readonly CancellationTokenSource lifetime;
        private readonly SemaphoreSlim changes = new(1, 1);
        private readonly object commitGate = new();
        private SourceBindingRevision bindings;
        private CancellationTokenSource runCancellation;
        private Task run;
        private long nextEpoch;
        private long ordinal;
        private long losses;
        private long quarantined;
        private long recoveries;
        private long reconnectAttempts;
        private Epoch? currentEpoch;
        private bool disposed;

        public Monitor(SourceI3xSession owner, SourceMonitorRequest request, ISourceSink sink, CancellationToken lifetime)
        {
            this.owner = owner; this.sink = sink; generation = request.Generation;
            bindings = Copy(request.Bindings);
            this.lifetime = CancellationTokenSource.CreateLinkedTokenSource(lifetime);
            runCancellation = CancellationTokenSource.CreateLinkedTokenSource(this.lifetime.Token);
            run = RunAsync(bindings, runCancellation.Token);
        }

        public async Task UpdateBindingsAsync(SourceBindingRevision revision, CancellationToken ct)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            var candidate = Copy(revision);
            if (candidate.Revision <= bindings.Revision) throw new ArgumentException("i3X binding revisions must increase.");
            await changes.WaitAsync(ct);
            try
            {
                if (candidate.Revision <= bindings.Revision) throw new ArgumentException("i3X binding revisions must increase.");
                await StopRunAsync();
                var previous = bindings;
                runCancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                // Validate remote interests and seed before exposing the candidate revision.
                Epoch? prepared = null;
                try
                {
                    if (owner.settings.Acquisition == "poll")
                    {
                        var seed = await owner.ReadAllAsync(candidate.Points, generation, candidate.Revision, ct);
                        lock (commitGate) { bindings = candidate; sink.OnValues(seed.Values); }
                    }
                    else
                    {
                        prepared = await PrepareAsync(candidate, startDelivery: true, ct, deliveryCancellation: runCancellation.Token);
                        lock (commitGate) { bindings = candidate; }
                    }
                    run = RunAsync(candidate, runCancellation.Token, prepared);
                }
                catch (Exception error) when (error is not OperationCanceledException || !lifetime.IsCancellationRequested)
                {
                    if (prepared is not null) await CleanupAsync(prepared);
                    lock (commitGate) { bindings = previous; }
                    Status("degraded", "Candidate i3X bindings failed; rebuilding the previous complete interest set.", "binding-compensation", error);
                    // A fresh subscription confirms restoration; never claim the retired remote set survived.
                    try
                    {
                        Epoch? restored = owner.settings.Acquisition == "poll" ? null : await PrepareAsync(previous, startDelivery: true, lifetime.Token, deliveryCancellation: runCancellation.Token);
                        run = RunAsync(previous, runCancellation.Token, restored);
                    }
                    catch (Exception compensation)
                    {
                        Status("degraded", "i3X candidate and interest restoration failed; acquisition will reconcile before resuming.", "binding-compensation-failed", compensation);
                        run = RunAsync(previous, runCancellation.Token);
                    }
                    throw new InvalidOperationException("The i3X binding revision was not committed.", error);
                }
            }
            finally { changes.Release(); }
        }

        private async Task RunAsync(SourceBindingRevision active, CancellationToken ct, Epoch? prepared = null)
        {
            var retry = 1000;
            while (!ct.IsCancellationRequested)
            {
                Epoch? epoch = prepared; prepared = null;
                try
                {
                    if (owner.settings.Acquisition == "poll") { await PollAsync(active, ct); return; }
                    epoch ??= await PrepareAsync(active, startDelivery: true, ct);
                    currentEpoch = epoch;
                    if (epoch.Delivery is null) StartDelivery(epoch, ct);
                    if (epoch.Seed is not null) CommitSeed(epoch, epoch.Seed);
                    var interval = TimeSpan.FromSeconds(owner.settings.I3x?.ReconciliationSeconds ?? 30);
                    while (!ct.IsCancellationRequested)
                    {
                        var delay = Task.Delay(interval, ct);
                        var completed = await Task.WhenAny(epoch.Delivery!, delay);
                        if (completed == epoch.Delivery) { await epoch.Delivery!; throw new IOException("i3X delivery ended."); }
                        await delay;
                        await ReconcileAsync(epoch, ct);
                        retry = 1000;
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
                catch (Exception error)
                {
                    lock (commitGate)
                    {
                        if (epoch is not null) epoch.Retired = true;
                        Bad(active, error is OperationCanceledException ? "Bad_Timeout" : "Bad_CommunicationError");
                    }
                    var permanent = error is SourceLimitException || error is I3xProtocolException protocol && protocol.Permanent;
                    if (!permanent) Interlocked.Increment(ref recoveries);
                    Status(permanent ? "faulted" : "degraded", permanent ? "i3X configuration or bounded protocol validation failed." : "i3X delivery lost; creating a replacement subscription and current seed.",
                        "recovery", error, new Dictionary<string, object?> { ["lostTransientUpdates"] = "unknown", ["lastAcceptedSubscription"] = epoch?.Number,
                            ["lastAcknowledgment"] = epoch?.Acknowledgment?.ToString(CultureInfo.InvariantCulture), ["consistency"] = "best-effort current-state reconciliation" });
                    if (permanent) return;
                }
                finally { if (epoch is not null) await CleanupAsync(epoch); }
                try { await Task.Delay(retry + Random.Shared.Next(0, retry / 4 + 1), ct); }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
                Interlocked.Increment(ref reconnectAttempts);
                retry = Math.Min(30000, retry * 2);
            }
        }

        private async Task PollAsync(SourceBindingRevision active, CancellationToken ct)
        {
            await owner.protocol.InfoAsync(ct);
            while (!ct.IsCancellationRequested)
            {
                var result = await owner.ReadAllAsync(active.Points, generation, active.Revision, ct);
                lock (commitGate) { if (!ct.IsCancellationRequested) sink.OnValues(result.Values); }
                Status(result.Values.Any(value => !value.Quality.StartsWith("Good", StringComparison.Ordinal)) ? "degraded" : "connected",
                    "i3X polling current values.", "poll");
                await Task.Delay(Math.Max(1000, owner.settings.IntervalMs), ct);
            }
        }

        private async Task<Epoch> PrepareAsync(SourceBindingRevision active, bool startDelivery, CancellationToken ct,
            CancellationToken? deliveryCancellation = null)
        {
            Status("connecting", "Creating i3X subscription and authoritative current seed.", "reconcile");
            var info = await owner.protocol.InfoAsync(ct);
            var subscription = await owner.protocol.CreateAsync(owner.clientId, ct);
            var epoch = new Epoch(subscription, Interlocked.Increment(ref nextEpoch), active,
                owner.settings.Acquisition != "sync" && owner.settings.I3x?.PreferStream != false && info.Stream);
            try
            {
                foreach (var batch in active.Points.Select(point => point.Address).Distinct(StringComparer.Ordinal).Chunk(250))
                    await owner.protocol.RegisterAsync(owner.clientId, subscription, batch, false, ct);
                if (startDelivery) StartDelivery(epoch, deliveryCancellation ?? ct);
                epoch.Seed = await owner.ReadAllAsync(active.Points, generation, active.Revision, ct);
                return epoch;
            }
            catch { await CleanupAsync(epoch); throw; }
        }

        private void StartDelivery(Epoch epoch, CancellationToken ct)
        {
            epoch.Cancellation = CancellationTokenSource.CreateLinkedTokenSource(ct);
            epoch.Delivery = DeliverAsync(epoch, epoch.Cancellation.Token);
        }

        private async Task DeliverAsync(Epoch epoch, CancellationToken ct)
        {
            if (epoch.Stream)
            {
                try
                {
                    await owner.protocol.StreamAsync(owner.clientId, epoch.Subscription,
                        (updates, revision, cancellation) => { Accept(epoch, updates, null, revision); return Task.CompletedTask; }, ct,
                        () => Volatile.Read(ref epoch.SeedRevision));
                    return;
                }
                catch (I3xProtocolException error) when (error.Status == HttpStatusCode.NotImplemented)
                {
                    // StreamAsync has disposed its response/socket before entering sync.
                    epoch.Stream = false;
                    Status("degraded", "i3X stream is unavailable; using mandatory sync delivery.", "stream-501");
                }
            }
            ulong? accepted = null;
            while (!ct.IsCancellationRequested)
            {
                var seedRevision = Volatile.Read(ref epoch.SeedRevision);
                var result = await owner.protocol.SyncAsync(owner.clientId, epoch.Subscription, accepted, ct);
                if (result.Overflow)
                {
                    Interlocked.Increment(ref losses);
                    throw new I3xProtocolException("i3X sync reported queue overflow; the old subscription is retired.", HttpStatusCode.ServiceUnavailable);
                }
                foreach (var batch in result.Batches)
                {
                    if (accepted.HasValue && batch.Sequence <= accepted.Value) continue;
                    Accept(epoch, batch.Updates, batch.Sequence, seedRevision);
                    // Full batch was reduced or explicitly quarantined, even while seed buffering discarded it.
                    accepted = batch.Sequence;
                }
                epoch.Acknowledgment = accepted;
                await Task.Delay(Math.Max(1000, owner.settings.IntervalMs), ct);
            }
        }

        private void Accept(Epoch epoch, IReadOnlyList<I3xVqt> updates, ulong? sequence, long? seedRevision = null)
        {
            lock (commitGate)
            {
                if (epoch.Retired || lifetime.IsCancellationRequested || epoch.Bindings.Revision != bindings.Revision) return;
                if (epoch.Reconciling || seedRevision.HasValue && seedRevision.Value != epoch.SeedRevision)
                { Interlocked.Add(ref losses, updates.Count); return; }
                var values = new List<SourceValue>();
                using var admission = new SourceMemoryBudget();
                long admitted = 0;
                foreach (var update in updates)
                    if (epoch.ByAddress.TryGetValue(update.ElementId, out var points))
                    {
                        admitted += EstimateProjection(update, points, owner.settings.EffectiveLimits.ValueBytes);
                        if (admitted > owner.settings.EffectiveLimits.StateBytes)
                            throw new SourceLimitException("i3X selector fan-out exceeds the state-byte ceiling.");
                        admission.SetBytes("values", admitted);
                        if (update.Error is not null) Interlocked.Increment(ref quarantined);
                        values.AddRange(Project(update, points, generation, epoch.Bindings.Revision, epoch.Subscription,
                            sequence, Interlocked.Increment(ref ordinal), owner.settings.EffectiveLimits.ValueBytes));
                    }
                    else Interlocked.Increment(ref quarantined);
                var bytes = values.Sum(value => value.Value is string text ? Encoding.UTF8.GetByteCount(text) : 64L);
                if (bytes > owner.settings.EffectiveLimits.StateBytes) throw new SourceLimitException("i3X selector fan-out exceeds the state-byte ceiling.");
                if (values.Count > 0) sink.OnValues(values);
            }
        }

        private async Task ReconcileAsync(Epoch epoch, CancellationToken ct)
        {
            lock (commitGate) { epoch.Reconciling = true; epoch.SeedRevision++; }
            Status("degraded", "i3X authoritative current reconciliation; buffered delivery is discarded.", "periodic-reconcile");
            var seed = await owner.ReadAllAsync(epoch.Bindings.Points, generation, epoch.Bindings.Revision, ct);
            CommitSeed(epoch, seed);
        }
        private void CommitSeed(Epoch epoch, SourceReadBatch seed)
        {
            lock (commitGate)
            {
                if (epoch.Retired || lifetime.IsCancellationRequested || epoch.Bindings.Revision != bindings.Revision) return;
                sink.OnValues(seed.Values.Select(value => value with { Epoch = epoch.Subscription,
                    IngressOrdinal = Interlocked.Increment(ref ordinal) }).ToArray());
                epoch.Seed = null;
                epoch.SeedRevision++;
                epoch.Reconciling = false;
            }
            Status(seed.Values.Any(value => !value.Quality.StartsWith("Good", StringComparison.Ordinal)) ? "degraded" : "connected",
                "i3X current state reconciled; delivery remains best effort.", "reconciled", diagnostics: new Dictionary<string, object?> {
                    ["mode"] = epoch.Stream ? "stream" : "sync", ["subscriptionEpoch"] = epoch.Number,
                    ["acknowledgment"] = epoch.Acknowledgment?.ToString(CultureInfo.InvariantCulture),
                    ["streamHealth"] = epoch.Stream ? "current-read-confirmed; quiet delivery is unproven" : "sync-response-confirmed",
                    ["consistency"] = "best-effort periodic authoritative current",
                    ["quarantinedUpdates"] = Interlocked.Read(ref quarantined),
                });
        }
        private void Bad(SourceBindingRevision active, string quality)
            => sink.OnValues(active.Points.Select(point => new SourceValue(point.Id, null, point.DataType, quality,
                ReceiptTimestamp: DateTimeOffset.UtcNow, Action: SourceValueAction.Retain, Generation: generation,
                BindingRevision: active.Revision, MonotonicReceipt: Stopwatch.GetTimestamp())).ToArray());
        private void Status(string state, string message, string reason, Exception? error = null,
            IReadOnlyDictionary<string, object?>? diagnostics = null)
        {
            lock (commitGate)
            {
                if (lifetime.IsCancellationRequested) return;
                var metrics = new Dictionary<string, object?>(owner.telemetry.Snapshot()) {
                    ["mode"] = owner.settings.Acquisition == "poll" ? "poll" : currentEpoch is { } epoch ? epoch.Stream ? "stream" : "sync" : owner.settings.Acquisition,
                    ["configuredMode"] = owner.settings.Acquisition,
                    ["catalogCount"] = owner.catalog?.Count ?? 0, ["catalogBytes"] = Interlocked.Read(ref owner.catalogBytes),
                    ["catalogTruncated"] = Volatile.Read(ref owner.catalogTruncated),
                    ["recoveryCount"] = Interlocked.Read(ref recoveries), ["reconnectAttempts"] = Interlocked.Read(ref reconnectAttempts),
                    ["quarantinedUpdates"] = Interlocked.Read(ref quarantined), ["effectiveLimits"] = owner.settings.EffectiveLimits
                };
                if (diagnostics is not null) foreach (var pair in diagnostics) metrics[pair.Key] = pair.Value;
                sink.OnStatus(new(state, message, generation, bindings.Revision, reason,
                    error is I3xProtocolException protocol ? protocol.Status?.ToString() ?? "protocol-validation" : error?.GetType().Name,
                    Interlocked.Read(ref losses), metrics));
            }
        }
        private async Task CleanupAsync(Epoch epoch)
        {
            lock (commitGate) { epoch.Retired = true; }
            if (epoch.Cancellation is not null)
            {
                await epoch.Cancellation.CancelAsync();
                if (epoch.Delivery is not null) try { await epoch.Delivery.WaitAsync(TimeSpan.FromSeconds(1)); } catch { }
                epoch.Cancellation.Dispose();
            }
            using var cleanup = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
            try { await owner.protocol.DeleteAsync(owner.clientId, epoch.Subscription, cleanup.Token); } catch { }
        }
        private async Task StopRunAsync()
        {
            lock (commitGate) { if (currentEpoch is not null) currentEpoch.Retired = true; Interlocked.Increment(ref nextEpoch); }
            await runCancellation.CancelAsync();
            try { await run.WaitAsync(TimeSpan.FromSeconds(2)); }
            catch (OperationCanceledException) { }
            runCancellation.Dispose();
        }
        private static SourceBindingRevision Copy(SourceBindingRevision revision)
        {
            if (revision.Points.Count > 10000 || revision.Points.Any(point => point.Writable)
                || revision.Points.Select(point => point.Id).Distinct(StringComparer.Ordinal).Count() != revision.Points.Count)
                throw new ArgumentException("i3X binding revision needs unique read-only points within the saved-map cap.");
            foreach (var point in revision.Points) _ = SourceI3xClient.Select(default, point.Selector);
            return revision with { Points = revision.Points.ToArray() };
        }
        public async ValueTask DisposeAsync()
        {
            if (disposed) return;
            disposed = true;
            await lifetime.CancelAsync();
            await changes.WaitAsync();
            try { await StopRunAsync(); }
            finally { changes.Release(); lifetime.Dispose(); }
        }
        private sealed class Epoch(string subscription, long number, SourceBindingRevision bindings, bool stream)
        {
            public string Subscription { get; } = subscription;
            public long Number { get; } = number;
            public SourceBindingRevision Bindings { get; } = bindings;
            public Dictionary<string, SourcePoint[]> ByAddress { get; } = bindings.Points.GroupBy(point => point.Address, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.ToArray(), StringComparer.Ordinal);
            public bool Stream = stream;
            public bool Reconciling = true;
            public bool Retired;
            public long SeedRevision;
            public ulong? Acknowledgment;
            public SourceReadBatch? Seed;
            public CancellationTokenSource? Cancellation;
            public Task? Delivery;
        }
    }
}
