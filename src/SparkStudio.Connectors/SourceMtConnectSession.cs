using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Text;

namespace SparkStudio.Connectors;

public sealed class SourceMtConnectSession : ISourceSession
{
    private readonly SourceSettings settings;
    private readonly ConnectionDefinition connection;
    private readonly SourceMtConnectSettings options;
    private readonly HttpClient client;
    private readonly SemaphoreSlim probeGate = new(1);
    private readonly object monitorGate = new();
    private MtConnectProbe? probe;
    private Monitor? monitor;
    private bool disposed;
    private readonly SourceMemoryBudget catalogBudget = new();
    private readonly SourceTransportTelemetry telemetry = new();
    private long catalogBytes;
    public SourceCapabilities Capabilities { get; } = new("mtconnect", ["poll", "subscribe"], "native",
        MaximumReadBatch: 1000, SupportedRepresentations: ["VALUE", "DATA_SET", "TABLE", "CONDITION"]);
    public SourceMtConnectSession(ConnectionDefinition connection, HttpClient? client = null)
    {
        this.connection = connection;
        settings = connection.Source ?? throw new ArgumentException("MTConnect source settings are required.");
        SourceConfiguration.Validate("mtconnect", settings);
        options = settings.MtConnect ?? new();
        this.client = client ?? SourceHttp.CreateClient(connection);
    }
    public async Task<SourceTestResult> TestAsync(CancellationToken ct)
    {
        ThrowIfDisposed();
        var catalog = await EnsureProbeAsync(ct, refresh: true);
        return new(true, "MTConnect agent probe accepted; read-only source.", Capabilities,
            catalog.Header.Version, new Dictionary<string, object?> {
                ["agentVersion"] = catalog.Header.AgentVersion, ["schemaVersion"] = catalog.Header.Version,
                ["instanceId"] = catalog.Header.Instance.ToString(CultureInfo.InvariantCulture),
                ["devices"] = catalog.Items.Select(i => i.DeviceUuid).Distinct().Count(),
                ["dataItems"] = catalog.Items.Count,
                ["unsupportedRepresentations"] = catalog.Items.Where(i => !i.Supported).Select(i => i.Representation).Distinct().ToArray(),
                ["limits"] = settings.EffectiveLimits });
    }
    public async Task<SourceBrowsePage> BrowseAsync(SourceBrowseRequest request, CancellationToken ct)
    {
        ThrowIfDisposed();
        if (request.PageSize is < 1 or > 500) throw new ArgumentException("Choose a browse page size from 1 through 500.");
        var catalog = await EnsureProbeAsync(ct);
        var entries = new List<SourceBrowseEntry>();
        if (string.IsNullOrEmpty(request.Parent)) {
            foreach (var group in catalog.Items.GroupBy(i => i.DeviceUuid))
                entries.Add(new(group.Key, group.First().DeviceName, false,
                    Metadata: new Dictionary<string, object?> { ["deviceUuid"] = group.Key,
                        ["agent"] = group.First().DeviceName == "Agent", ["defaultSelected"] = group.First().DeviceName != "Agent" }));
        } else if (catalog.Items.FirstOrDefault(i => i.Address == request.Parent && i.Category == "CONDITION") is { } condition) {
            foreach (var selector in new[] { "level", "nativeCode", "nativeSeverity", "message", "active" })
                entries.Add(new(condition.Address, condition.Name + "/" + selector, true, "String", selector, request.Parent));
        } else {
            foreach (var item in catalog.Items.Where(i => i.DeviceUuid == request.Parent)) {
                entries.Add(new(item.Address, item.Name, item.Supported, item.DataType,
                    item.Category == "CONDITION" ? "level" : null, request.Parent,
                    new Dictionary<string, object?> { ["dataItemId"] = item.Id, ["deviceUuid"] = item.DeviceUuid,
                        ["componentPath"] = item.ComponentPath, ["category"] = item.Category, ["type"] = item.Type,
                        ["representation"] = item.Representation, ["discrete"] = item.Discrete,
                        ["units"] = item.Units, ["nativeUnits"] = item.NativeUnits, ["supported"] = item.Supported },
                    SuggestedPath: SuggestedPath(item)));
                if (item.Supported && item.Vector3)
                    foreach (var selector in new[] { "x", "y", "z" }) entries.Add(new(item.Address,
                        item.Name + "/" + selector, true, "Double", selector, request.Parent));
            }
        }
        // Include catalog epoch in the signed catalog digest, even when entries
        // happen to retain the same names after an agent restart.
        entries = entries.Select(entry => entry with { Metadata = new Dictionary<string, object?>(entry.Metadata ?? new Dictionary<string, object?>()) {
            ["instanceId"] = catalog.Header.Instance.ToString(CultureInfo.InvariantCulture), ["modelChangeTime"] = catalog.Header.ModelChangeTime } }).ToList();
        return SourceBrowse.Page(entries, request);
    }
    private static string SuggestedPath(MtConnectItem item)
    {
        static string Segment(string text) {
            var result = new string(text.Select(c => char.IsControl(c) || "[]{}\\/".Contains(c) ? '_' : c).ToArray()).Trim();
            return result.Length == 0 || result is "." or ".." ? "_" : result;
        }
        var segments = new List<string> { Segment(item.DeviceName) };
        if (item.ComponentPath.Length > 0) segments.AddRange(item.ComponentPath.Split('/').Select(Segment));
        segments.Add(Segment(item.Name));
        var path = string.Join('/', segments);
        if (path.Length > 448) path = path[..416] + "_" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(item.Address)))[..24].ToLowerInvariant();
        return path;
    }
    public async Task<SourceReadBatch> ReadAsync(SourceReadRequest request, CancellationToken ct)
    {
        ThrowIfDisposed();
        if (request.Points.Count > 1000) throw new ArgumentException("Read at most 1000 source points in one request.");
        ValidatePoints(request.Points);
        var catalog = await EnsureProbeAsync(ct);
        var document = await CurrentAsync(ct);
        if (document.Header.Instance != catalog.Header.Instance) catalog = await EnsureProbeAsync(ct, refresh: true);
        if (document.Header.Instance != catalog.Header.Instance) throw new MtConnectProtocolException("INSTANCE_CHANGED", "MTConnect instance changed during explicit Read; retry after re-probing.");
        using var reducer = new MtConnectReducer(catalog.Items, settings.EffectiveLimits);
        using var decoding = DecodeLease();
        reducer.Apply(document, true);
        return new(Values(reducer, request.Points, request.Generation, request.BindingRevision, 0));
    }
    public Task<ISourceMonitor> StartMonitoringAsync(SourceMonitorRequest request, ISourceSink sink, CancellationToken lifetime)
    {
        ThrowIfDisposed();
        ValidatePoints(request.Bindings.Points);
        lock (monitorGate) {
            if (monitor is not null) throw new InvalidOperationException("An MTConnect connection owns exactly one monitor.");
            monitor = new(this, request, sink, lifetime);
            return Task.FromResult<ISourceMonitor>(monitor);
        }
    }
    private static void ValidatePoints(IReadOnlyList<SourcePoint> points)
    {
        if (points.Count > 10_000 || points.Any(p => p.Writable || string.IsNullOrEmpty(p.Address)))
            throw new ArgumentException("MTConnect points are read-only and require a bounded raw address map.");
        if (points.Select(p => p.Id).Distinct(StringComparer.Ordinal).Count() != points.Count)
            throw new ArgumentException("MTConnect saved point ids must be unique.");
    }
    private async Task<MtConnectProbe> EnsureProbeAsync(CancellationToken ct, bool refresh = false)
    {
        await probeGate.WaitAsync(ct);
        try {
            if (probe is not null && !refresh) return probe;
            var bytes = await FetchAsync("probe", ct);
            using var decoding = DecodeLease();
            var candidate = MtConnectXml.Probe(bytes, settings.EffectiveLimits.DocumentBytes, settings.EffectiveLimits);
            var metadataBytes = candidate.Items.Sum(i => 256L + (i.Address.Length + i.Id.Length + i.DeviceUuid.Length + i.DeviceName.Length + i.ComponentPath.Length + i.Name.Length + i.Category.Length + i.Type.Length + i.Representation.Length + (i.Units?.Length ?? 0) + (i.NativeUnits?.Length ?? 0)) * 2L);
            if (metadataBytes > settings.EffectiveLimits.CatalogBytes) throw new SourceLimitException("MTConnect catalog exceeds its metadata budget.");
            catalogBudget.SetBytes("catalog", metadataBytes);
            Interlocked.Exchange(ref catalogBytes, metadataBytes);
            probe = candidate;
            return candidate;
        } finally { probeGate.Release(); }
    }
    private async Task<MtConnectDocument> CurrentAsync(CancellationToken ct)
    {
        var bytes = await FetchAsync("current", ct);
        using var decoding = DecodeLease();
        return MtConnectXml.Streams(bytes, settings.EffectiveLimits.DocumentBytes, settings.EffectiveLimits);
    }
    private SourceMemoryBudget DecodeLease()
    {
        var budget = new SourceMemoryBudget();
        try { budget.SetBytes("decode", settings.EffectiveLimits.DecodeBytes); return budget; }
        catch { budget.Dispose(); throw; }
    }
    private Uri UriFor(string operation, string? query = null)
    {
        var baseUri = new Uri(settings.Endpoint.TrimEnd('/') + "/", UriKind.Absolute);
        var path = (string.IsNullOrEmpty(options.Device) ? "" : Uri.EscapeDataString(options.Device) + "/") + operation;
        var parameters = new List<string>();
        if (!string.IsNullOrEmpty(options.Path)) parameters.Add("path=" + Uri.EscapeDataString(options.Path));
        if (!string.IsNullOrEmpty(query)) parameters.Add(query);
        return new(baseUri, path + (parameters.Count > 0 ? "?" + string.Join('&', parameters) : ""));
    }
    private HttpRequestMessage Request(string operation, string? query = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, UriFor(operation, query));
        request.Headers.UserAgent.ParseAdd(options.UserAgent);
        request.Headers.Accept.Add(new("application/xml"));
        SourceHttp.ApplyAuthentication(request, connection);
        request.Headers.Accept.Clear(); request.Headers.Accept.Add(new("application/xml"));
        return request;
    }
    private async Task<byte[]> FetchAsync(string operation, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(settings.EffectiveLimits.RequestTimeoutMs);
        using var request = Request(operation);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
        SourceHttp.ObserveResponse(response, telemetry);
        using var ingress = new SourceMemoryBudget(); ingress.SetBytes("queue", settings.EffectiveLimits.DocumentBytes);
        var bytes = await ReadDocumentAsync(await response.Content.ReadAsStreamAsync(deadline.Token), deadline.Token);
        if (!response.IsSuccessStatusCode) {
            if (response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.NotFound)
                _ = MtConnectXml.Streams(bytes, settings.EffectiveLimits.DocumentBytes, settings.EffectiveLimits); // normalize supported agent errors before generic HTTP failure
            response.EnsureSuccessStatusCode();
        }
        return bytes;
    }
    private async Task<byte[]> ReadDocumentAsync(Stream input, CancellationToken ct)
    {
        using var output = new MemoryStream();
        var buffer = new byte[8192];
        for (;;) {
            var read = await input.ReadAsync(buffer, ct);
            if (read == 0) return output.ToArray();
            if (output.Length + read > settings.EffectiveLimits.DocumentBytes)
                throw new MtConnectProtocolException("LIMIT", "MTConnect decoded document exceeds its configured limit.");
            await output.WriteAsync(buffer.AsMemory(0, read), ct);
        }
    }
    private List<SourceValue> Values(MtConnectReducer reducer, IReadOnlyList<SourcePoint> points, long generation, long revision, long ordinal,
        DateTimeOffset? acceptedReceipt = null, long acceptedMonotonic = 0)
    {
        var receipt = acceptedReceipt ?? DateTimeOffset.UtcNow; var tick = acceptedMonotonic > 0 ? acceptedMonotonic : Stopwatch.GetTimestamp();
        var values = new List<SourceValue>(points.Count);
        long bytes = 0;
        foreach (var point in points) {
            var reduced = reducer.Read(point.Address, point.Selector);
            object? value = reduced.Value; var quality = reduced.Quality;
            var action = quality == "Bad_NoData" ? SourceValueAction.Clear : quality.StartsWith("Bad", StringComparison.Ordinal) ? SourceValueAction.Retain : SourceValueAction.Replace;
            if (action == SourceValueAction.Replace) {
                try { value = SourceConfiguration.Coerce(value, point.DataType); }
                catch (Exception error) when (error is FormatException or OverflowException or ArgumentException) {
                    value = null; quality = "Bad_TypeMismatch"; action = SourceValueAction.Retain;
                }
            }
            bytes += 256 + point.Id.Length * 2L + (value is string text ? text.Length * 2L : 16);
            if (bytes > settings.EffectiveLimits.StateBytes) throw new SourceLimitException("MTConnect point fan-out exceeds the connection value-byte ceiling.");
            values.Add(new SourceValue(point.Id, value, point.DataType, quality, reduced.Timestamp, receipt,
                action, reduced.NativeStatus, generation, revision, reducer.Header?.Instance.ToString(CultureInfo.InvariantCulture),
                reduced.Sequence, ordinal, MonotonicReceipt: tick));
        }
        return values;
    }
    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(disposed, this);
    public async ValueTask DisposeAsync()
    {
        if (disposed) return;
        disposed = true;
        Monitor? current; lock (monitorGate) current = monitor;
        if (current is not null) await current.DisposeAsync();
        client.Dispose();
        catalogBudget.Dispose();
        // Pending operation cancellation may still unwind a probeGate.Release;
        // this managed semaphore has no created WaitHandle and is left to GC.
    }
    private sealed class Monitor : ISourceMonitor
    {
        private readonly SourceMtConnectSession owner;
        private readonly SourceMonitorRequest request;
        private readonly ISourceSink sink;
        private readonly CancellationTokenSource lifetime;
        private readonly object gate = new();
        private SourceBindingRevision bindings;
        private MtConnectReducer? reducer;
        private readonly Task runner;
        private long ordinal;
        private long recoveries;
        private long reconnectAttempts;
        private long losses;
        private long gapEvents;
        private long unknownLossEvents;
        private ulong? lostFrom;
        private ulong? lostThrough;
        private long inputBytes;
        private long inputDocuments;
        private long decodeErrors;
        private long typeErrors;
        private DateTimeOffset? lastDocument;
        private DateTimeOffset? acceptedReceipt;
        private long acceptedMonotonic;
        private long acceptedDocuments;
        private string? acquisitionFailureQuality;
        private readonly SourceMemoryBudget valuesBudget = new();
        private bool closed;
        public Monitor(SourceMtConnectSession owner, SourceMonitorRequest request, ISourceSink sink, CancellationToken lifetime)
        {
            this.owner = owner; this.request = request; this.sink = sink; bindings = request.Bindings;
            this.lifetime = CancellationTokenSource.CreateLinkedTokenSource(lifetime);
            runner = Task.Run(RunAsync, CancellationToken.None);
        }
        public Task UpdateBindingsAsync(SourceBindingRevision revision, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested(); ValidatePoints(revision.Points);
            lock (gate) {
                ObjectDisposedException.ThrowIf(closed, this);
                if (revision.Revision <= bindings.Revision) throw new ArgumentException("Binding revisions must increase.");
                IReadOnlyList<SourceValue>? seeded = reducer is null ? null : owner.Values(reducer, revision.Points, request.Generation, revision.Revision, ordinal + 1, acceptedReceipt, acceptedMonotonic);
                // A local binding change observes the accepted canonical state; it
                // is neither a transport recovery nor a fresh accepted observation.
                if (acquisitionFailureQuality is { } quality) {
                    // Retain diagnostics are delivered after the current transport
                    // fence, while their accepted value receipt remains unchanged.
                    var delivery = Stopwatch.GetTimestamp();
                    seeded = seeded is null
                        ? revision.Points.Select(point => new SourceValue(point.Id, null, point.DataType, quality,
                            ReceiptTimestamp: acceptedReceipt, Action: SourceValueAction.Retain,
                            Generation: request.Generation, BindingRevision: revision.Revision,
                            IngressOrdinal: ordinal + 1, MonotonicReceipt: delivery)).ToArray()
                        : seeded.Select(value => value with { Quality = quality, Action = SourceValueAction.Retain, MonotonicReceipt = delivery }).ToArray();
                }
                if (seeded is not null) ReserveValues(seeded);
                bindings = revision;
                // Acquisition filter is a transport option; compatible point/selector edits
                // use canonical state and do not reopen the transport.
                if (seeded is not null) { ordinal++; sink.OnValues(seeded); }
            }
            return Task.CompletedTask;
        }
        private void Status(string state, string? reason = null, string? native = null)
        {
            lock (gate) {
                if (closed) return;
                var metrics = new Dictionary<string, object?>(owner.telemetry.Snapshot()) {
                    ["recoveryCount"] = recoveries, ["reconnectAttempts"] = reconnectAttempts, ["protocolGaps"] = losses,
                    ["protocolGapEvents"] = gapEvents, ["unknownLossEvents"] = unknownLossEvents,
                    ["lostFrom"] = lostFrom?.ToString(CultureInfo.InvariantCulture), ["lostThrough"] = lostThrough?.ToString(CultureInfo.InvariantCulture),
                    ["sampleDocumentBytes"] = inputBytes, ["inputDocuments"] = inputDocuments, ["lastCompleteDocumentAt"] = lastDocument,
                    ["decodeErrors"] = decodeErrors, ["typeErrors"] = typeErrors,
                    ["canonicalStateBytes"] = reducer?.StateBytes ?? 0,
                    ["catalogCount"] = owner.probe?.Items.Count ?? 0, ["catalogBytes"] = Interlocked.Read(ref owner.catalogBytes), ["catalogTruncated"] = false,
                    ["instanceId"] = reducer?.Header?.Instance.ToString(CultureInfo.InvariantCulture),
                    ["nextSequence"] = reducer?.Header?.Next.ToString(CultureInfo.InvariantCulture), ["mode"] = owner.settings.Acquisition,
                    ["effectiveLimits"] = owner.settings.EffectiveLimits
                };
                sink.OnStatus(new(state, reason, request.Generation, bindings.Revision, reason, native, losses,
                    metrics));
            }
        }
        private void Bad(string quality)
        {
            lock (gate) {
                if (closed) return;
                acquisitionFailureQuality = quality;
                sink.OnValues(bindings.Points.Select(p => new SourceValue(p.Id, null, p.DataType, quality,
                    ReceiptTimestamp: DateTimeOffset.UtcNow, Action: SourceValueAction.Retain,
                    Generation: request.Generation, BindingRevision: bindings.Revision,
                    IngressOrdinal: ++ordinal, MonotonicReceipt: Stopwatch.GetTimestamp())).ToArray());
            }
        }
        private void PublishLocked()
        {
            if (closed || reducer is null || lifetime.IsCancellationRequested) return;
            var receipt = DateTimeOffset.UtcNow; var monotonic = Stopwatch.GetTimestamp();
            var values = owner.Values(reducer, bindings.Points, request.Generation, bindings.Revision, ++ordinal, receipt, monotonic);
            typeErrors += values.Count(value => value.Quality == "Bad_TypeMismatch");
            ReserveValues(values);
            acceptedReceipt = receipt; acceptedMonotonic = monotonic; acquisitionFailureQuality = null;
            acceptedDocuments++;
            sink.OnValues(values);
        }
        private void ReserveValues(IReadOnlyList<SourceValue> values) =>
            valuesBudget.SetBytes("values", values.Sum(value => 256L + value.PointId.Length * 2L + (value.Value is string text ? text.Length * 2L : 16L)));
        private async Task SeedAsync(CancellationToken ct)
        {
            Status("connecting", "Probe and current-state reconciliation");
            for (var attempt = 0; attempt < 3; attempt++) {
                var catalog = await owner.EnsureProbeAsync(ct, refresh: true);
                var current = await owner.CurrentAsync(ct);
                if (catalog.Header.Instance != current.Header.Instance || catalog.Header.ModelChangeTime != current.Header.ModelChangeTime) continue;
                var candidate = new MtConnectReducer(catalog.Items, owner.settings.EffectiveLimits);
                try { using var decoding = owner.DecodeLease(); candidate.Apply(current, true); }
                catch { candidate.Dispose(); throw; }
                lock (gate) { reducer?.Dispose(); reducer = candidate; PublishLocked(); }
                Status("connected"); return;
            }
            throw new MtConnectProtocolException("INSTANCE_CHANGED", "MTConnect instance did not stabilize across probe/current handoff.");
        }
        private async Task RunAsync()
        {
            var ct = lifetime.Token;
            var retries = 0;
            long acceptedAtLastFailure = 0;
            while (!ct.IsCancellationRequested) {
                try {
                    if (reducer is null) await SeedAsync(ct);
                    if (owner.settings.Acquisition == "poll") {
                        await Task.Delay(Math.Max(1000, owner.settings.IntervalMs), ct);
                        var current = await owner.CurrentAsync(ct);
                        if (current.Header.Instance != reducer!.Header!.Instance
                            || current.Header.ModelChangeTime != reducer.Header.ModelChangeTime)
                            throw new MtConnectProtocolException("INSTANCE_CHANGED", "MTConnect agent/model changed.");
                        lock (gate) { using var decoding = owner.DecodeLease(); reducer.Apply(current, true); PublishLocked(); }
                        Status("connected");
                    } else {
                        await SampleAsync(ct);
                        await Task.Delay(Math.Max(1000, owner.settings.IntervalMs), ct);
                    }
                } catch (OperationCanceledException) when (ct.IsCancellationRequested) { break;
                } catch (Exception error) {
                    var protocol = error as MtConnectProtocolException;
                    if (error is SourceLimitException || protocol?.Code is "LIMIT" or "VERSION" or "CONDITION_ID" or "UNAUTHORIZED"
                        || error is HttpRequestException { StatusCode: HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden }) {
                        Bad(error is SourceLimitException || protocol?.Code == "LIMIT" ? "Bad_DecodingError" : "Bad_CommunicationError");
                        Status("faulted", "MTConnect configuration, authentication or resource limit requires correction", protocol?.Code);
                        break;
                    }
                    recoveries++;
                    if (protocol?.Code is "OUT_OF_RANGE" or "INSTANCE_CHANGED" or "CURSOR") {
                        gapEvents++; lostFrom = protocol.LostFrom; lostThrough = protocol.LostThrough;
                        if (lostFrom is { } start && lostThrough is { } finish) {
                            var count = finish - start + 1;
                            losses = count > (ulong)(long.MaxValue - losses) ? long.MaxValue : losses + (long)count;
                        } else unknownLossEvents++;
                        Bad("Uncertain_DataLoss"); lock (gate) { reducer?.Dispose(); reducer = null; }
                    } else Bad(error is OperationCanceledException or TimeoutException ? "Bad_Timeout" : protocol is not null ? "Bad_DecodingError" : "Bad_CommunicationError");
                    if (protocol is not null) decodeErrors++;
                    Status("degraded", "MTConnect acquisition interrupted; bounded recovery scheduled", protocol?.Code);
                    // A partial/malformed response leaves the accepted cursor intact.
                    // A long-lived stream can accept authoritative documents before
                    // its eventual failure. Reset backoff for that progress, not for
                    // opening a socket, an empty response, or a cached binding seed.
                    lock (gate) {
                        if (acceptedDocuments != acceptedAtLastFailure) retries = 0;
                        acceptedAtLastFailure = acceptedDocuments;
                    }
                    var seconds = Math.Min(30, 1 << Math.Min(retries++, 5));
                    try { await Task.Delay(TimeSpan.FromMilliseconds(seconds * 1000 + Random.Shared.Next(0, 250)), ct); }
                    catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
                    reconnectAttempts++;
                }
            }
        }
        private async Task SampleAsync(CancellationToken ct)
        {
            ulong cursor; lock (gate) cursor = reducer!.Header!.Next;
            var query = $"from={cursor.ToString(CultureInfo.InvariantCulture)}&interval={Math.Max(1000, owner.settings.IntervalMs)}&heartbeat={owner.options.HeartbeatMs}&count={owner.options.Count}";
            using var request = owner.Request("sample", query);
            using var connect = CancellationTokenSource.CreateLinkedTokenSource(ct);
            connect.CancelAfter(owner.settings.EffectiveLimits.ConnectTimeoutMs);
            using var response = await owner.client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, connect.Token);
            SourceHttp.ObserveResponse(response, owner.telemetry);
            using var ingress = new SourceMemoryBudget(); ingress.SetBytes("queue", owner.settings.EffectiveLimits.DocumentBytes + 16 * 1024);
            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            if (!response.IsSuccessStatusCode) {
                using var errorDeadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                errorDeadline.CancelAfter(owner.settings.EffectiveLimits.RequestTimeoutMs);
                var bytes = await owner.ReadDocumentAsync(stream, errorDeadline.Token);
                if (response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.NotFound)
                    _ = MtConnectXml.Streams(bytes, owner.settings.EffectiveLimits.DocumentBytes, owner.settings.EffectiveLimits);
                response.EnsureSuccessStatusCode();
            }
            var contentType = response.Content.Headers.ContentType;
            if (contentType?.MediaType?.StartsWith("multipart/", StringComparison.OrdinalIgnoreCase) == true) {
                var boundary = contentType.Parameters.FirstOrDefault(p => p.Name.Equals("boundary", StringComparison.OrdinalIgnoreCase))?.Value?.Trim('"');
                if (string.IsNullOrEmpty(boundary) || boundary.Length > 200 || boundary.Any(char.IsControl))
                    throw new MtConnectProtocolException("XML", "Invalid multipart MTConnect boundary.");
                await foreach (var bytes in MtConnectMultipart.ReadAsync(stream, boundary, owner.settings.EffectiveLimits.DocumentBytes,
                    TimeSpan.FromMilliseconds(owner.options.HeartbeatMs * 3L), ct)) Commit(bytes);
            } else {
                using var health = CancellationTokenSource.CreateLinkedTokenSource(ct);
                health.CancelAfter(TimeSpan.FromMilliseconds(owner.options.HeartbeatMs * 3L));
                Commit(await owner.ReadDocumentAsync(stream, health.Token));
            }
            void Commit(byte[] bytes) {
                using var decoding = owner.DecodeLease();
                var document = MtConnectXml.Streams(bytes, owner.settings.EffectiveLimits.DocumentBytes, owner.settings.EffectiveLimits);
                lock (gate) {
                    if (closed || ct.IsCancellationRequested) return;
                    if (document.Header.ModelChangeTime != reducer!.Header!.ModelChangeTime)
                        throw new MtConnectProtocolException("INSTANCE_CHANGED", "MTConnect model changed during acquisition.");
                    reducer.Apply(document, false); PublishLocked();
                    inputBytes += bytes.Length; inputDocuments++; lastDocument = DateTimeOffset.UtcNow;
                }
                Status("connected");
            }
        }
        public async ValueTask DisposeAsync()
        {
            lock (gate) { if (closed) return; closed = true; }
            lifetime.Cancel();
            try { await runner.WaitAsync(TimeSpan.FromSeconds(2)); }
            catch (OperationCanceledException) { }
            catch (TimeoutException) { throw new TimeoutException("MTConnect monitor did not release within its two-second cancellation budget."); }
            finally { lifetime.Dispose(); lock (gate) { reducer?.Dispose(); reducer = null; valuesBudget.Dispose(); } lock (owner.monitorGate) if (ReferenceEquals(owner.monitor, this)) owner.monitor = null; }
        }
    }
}

internal static class MtConnectMultipart
{
    // Read multipart documents without reading the whole infinite response or a
    // whole unbounded line. Boundary scanning works across arbitrary byte chunks.
    public static async IAsyncEnumerable<byte[]> ReadAsync(Stream stream, string boundary, int maximumBytes,
        TimeSpan documentDeadline, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        var marker = Encoding.ASCII.GetBytes("--" + boundary);
        var buffer = new List<byte>(8192);
        var chunk = new byte[4096];
        var started = false;
        var scanStart = 0;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(documentDeadline);
        for (;;) {
            var read = await stream.ReadAsync(chunk, deadline.Token);
            if (read == 0) {
                if (buffer.Count != 0 && buffer.Any(b => b != 13 && b != 10))
                    throw new MtConnectProtocolException("XML", "MTConnect multipart stream ended with an incomplete part.");
                yield break;
            }
            for (var i = 0; i < read; i++) buffer.Add(chunk[i]);
            for (;;) {
                var position = Find(buffer, marker, scanStart, boundaryLine: true);
                if (position < 0) { scanStart = Math.Max(0, buffer.Count - marker.Length - 2); break; }
                if (started) {
                    var part = buffer.Take(position).ToArray();
                    var headerEnd = Find(part, [13, 10, 13, 10]);
                    var separator = 4;
                    if (headerEnd < 0) { headerEnd = Find(part, [10, 10]); separator = 2; }
                    if (headerEnd < 0 || headerEnd > 8192) throw new MtConnectProtocolException("XML", "Malformed MTConnect multipart headers.");
                    var payload = part.AsSpan(headerEnd + separator);
                    while (payload.Length > 0 && payload[^1] is 13 or 10) payload = payload[..^1];
                    if (payload.Length > maximumBytes) throw new MtConnectProtocolException("LIMIT", "MTConnect multipart document exceeds decoded byte ceiling.");
                    if (payload.Length > 0) { yield return payload.ToArray(); deadline.CancelAfter(documentDeadline); }
                }
                buffer.RemoveRange(0, position + marker.Length);
                scanStart = 0;
                // A closing marker can arrive in a later chunk; recognize it at
                // the start of the buffered next part as well.
                started = true;
                if (buffer.Count >= 2 && buffer[0] == '-' && buffer[1] == '-') yield break;
                while (buffer.Count > 0 && buffer[0] is 13 or 10) buffer.RemoveAt(0);
            }
            if (started && buffer.Count >= 2 && buffer[0] == '-' && buffer[1] == '-') yield break;
            if (buffer.Count > maximumBytes + 8192 + marker.Length + chunk.Length)
                throw new MtConnectProtocolException("LIMIT", "MTConnect multipart part exceeds its bounded ingress capacity.");
        }
    }
    private static int Find(IReadOnlyList<byte> haystack, byte[] needle, int start = 0, bool boundaryLine = false)
    {
        for (var i = start; i <= haystack.Count - needle.Length; i++) {
            if (boundaryLine && i > 0 && haystack[i - 1] != 10) continue;
            var matches = true;
            for (var j = 0; j < needle.Length; j++) if (haystack[i + j] != needle[j]) { matches = false; break; }
            if (matches) return i;
        }
        return -1;
    }
}
