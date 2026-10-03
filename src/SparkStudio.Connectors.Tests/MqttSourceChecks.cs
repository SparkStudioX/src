using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using SparkStudio.Connectors;

internal static class MqttSourceChecks
{
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool value, string message) { if (!value) throw new InvalidOperationException(message); passed++; }
        Check(SourceMqttMappingEngine.Matches("factory/+/temp", "factory/a/temp"), "+ matches one level");
        Check(!SourceMqttMappingEngine.Matches("factory/+/temp", "factory/a/x/temp"), "+ cannot match multiple levels");
        Check(SourceMqttMappingEngine.Matches("factory/#", "factory"), "# matches zero levels");
        Check(!SourceMqttMappingEngine.Matches("#", "$SYS/load"), "Leading wildcard excludes $ topics");
        Check(SourceMqttMappingEngine.Matches("$SYS/+", "$SYS/load"), "Explicit $ root accepts later wildcard");
        Check(SourceMqttMappingEngine.CompareFilters("a/literal/#", "a/+/x") > 0, "Lexicographic literal precedence");
        Check(SourceMqttMappingEngine.CompareFilters("a/+", "a/#") > 0, "+ precedence over #");
        Check(SourceMqttMappingEngine.CompareFilters("a/b", "a/b/#") < 0, "Longer filter breaks equal specificity tie");
        foreach (var protocol in new[] { "3.1.1", "5" })
        {
            await using var fixture = new SourceMqttFixture();
            var mapping = new SourceMqttMapping("m", "factory/#", "[default]MQTT", Qos: 1);
            var source = new SourceSettings("mqtt://127.0.0.1:" + fixture.Port, "subscribe", Mqtt: new(protocol, Mappings: [mapping]));
            var connection = new ConnectionDefinition("bounded-" + protocol, "Fixture", "mqtt", Source: source);
            await using var wire = await SourceMqttWire.ConnectAsync(connection, Path.GetTempPath(), CancellationToken.None);
            var rejected = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            wire.Start(_ => false, (_, _) => rejected.TrySetResult(true));
            await wire.SubscribeAsync([("factory/#", 1)], CancellationToken.None);
            var beforeInput = (long)wire.Metrics()["inputBytes"]!;
            await fixture.PublishAsync("factory/a", "42", qos: 1, id: 19);
            await rejected.Task.WaitAsync(TimeSpan.FromSeconds(2));
            Check(await fixture.PublishAcknowledged.Task.WaitAsync(TimeSpan.FromSeconds(2)) == 19, protocol + " dropped QoS 1 message is acknowledged before processing");
            var metrics = wire.Metrics();
            Check((long)metrics["inputBytes"]! - beforeInput == (protocol == "5" ? 18 : 17), protocol + " input counts packet headers and rejected body exactly once");
            Check((double)metrics["inputBytesPerSecond"]! > 0 && metrics["lastTransportActivityAt"] is DateTimeOffset,
                protocol + " rejected publication still records actual transport activity and monotonic rate");
        }
        foreach (var v5 in new[] { false, true })
        {
            // The stream supplies only the header. Any attempt to read a body proves the cap
            // was applied too late, without requiring a giant fixture allocation.
            var header = new MemoryStream(); header.WriteByte(0x30); SourceMqttWire.WriteVariable(header, 272 * 1024);
            var guarded = new HeaderOnlyStream(header.ToArray());
            await using var wire = SourceMqttWire.ForFixture(guarded, v5);
            try { await wire.ReadPacketAsync(CancellationToken.None); throw new InvalidOperationException("Oversize header was accepted."); }
            catch (SourceMqttWire.ProtocolException) { Check(guarded.BodyReads == 0, "Oversize " + (v5 ? "5" : "3.1.1") + " rejected before body read/allocation"); }
            Check((long)wire.Metrics()["inputBytes"]! == header.Length, "Oversized packet telemetry counts only admitted header reads");
        }
        await using (var partial = SourceMqttWire.ForFixture(new MemoryStream([0x30, 0x03, 0x00]), false)) {
            try { await partial.ReadPacketAsync(CancellationToken.None); throw new InvalidOperationException("Truncated packet accepted."); }
            catch (EndOfStreamException) { Check((long)partial.Metrics()["inputBytes"]! == 3, "Partial failed body records actual bytes received before failure"); }
        }
        foreach (var transport in new[] { (Tls: true, WebSocket: false), (Tls: false, WebSocket: true), (Tls: true, WebSocket: true) })
        foreach (var protocol in new[] { "3.1.1", "5" })
        {
            await using var fixture = new SourceMqttFixture(transport.Tls, transport.WebSocket);
            var received = new TaskCompletionSource<SourceMqttWire.Publish>(TaskCreationOptions.RunContinuationsAsynchronously);
            var source = new SourceSettings(fixture.Endpoint, "subscribe", Tls: fixture.TlsSettings,
                Mqtt: new(protocol, transport.WebSocket ? "websocket" : "tls", Mappings: [new("m", "#", "[default]Wire")]));
            SourceMqttWire connected;
            try { connected = await SourceMqttWire.ConnectAsync(new("transport", "Transport", "mqtt", Source: source), fixture.DataDirectory, CancellationToken.None); }
            catch (Exception error) { throw new IOException("Authored transport fixture failed; server diagnostic: " + fixture.Failure?.ToString(), error); }
            await using var wire = connected;
            wire.Start(message => { received.TrySetResult(message); return true; }, (_, _) => { });
            await wire.SubscribeAsync([("#", 0)], CancellationToken.None);
            await fixture.PublishAsync("bounded/topic", "42");
            Check(Encoding.UTF8.GetString((await received.Task.WaitAsync(TimeSpan.FromSeconds(2))).Payload.Span) == "42", protocol + " " + source.Mqtt!.Transport + " TLS=" + transport.Tls + " receives bounded packets");
            var header = new MemoryStream(); header.WriteByte(0x30); SourceMqttWire.WriteVariable(header, 272 * 1024);
            await fixture.SendRawAsync(header.ToArray());
            try { await wire.Completion.WaitAsync(TimeSpan.FromSeconds(2)); throw new InvalidOperationException("Transport accepted oversized MQTT header."); }
            catch (SourceMqttWire.ProtocolException) { Check(true, "Transport rejects oversize header without requesting body"); }
        }
        var scalarMapping = new SourceMqttMapping("m", "factory/#", "[default]MQTT", Retained: "uncertain");
        var point = new SourcePoint("p", "Temperature", "factory/a", "Int64", MappingId: "m");
        var scalarConnection = new ConnectionDefinition("cache", "Cache", "mqtt", Source: new("mqtt://localhost", "subscribe", Points: [point], Mqtt: new(Mappings: [scalarMapping])));
        await using (var engine = new SourceMqttMappingEngine(scalarConnection, new(3, [point], [scalarMapping]), 2))
        {
            var first = await engine.ProcessAsync(new("factory/a", Encoding.UTF8.GetBytes("9007199254740993"), false, false, 1), DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), CancellationToken.None);
            Check(first.Values.Single().Value is long integer && integer == 9007199254740993L, "Mapping preserves Int64 beyond Double exact range");
            engine.Loss("factory/a", "drop", 2);
            var skip = await engine.ProcessAsync(new("factory/a", Encoding.UTF8.GetBytes("null"), false, false, 3), DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), CancellationToken.None);
            Check(skip.Values.Count == 0 && engine.Read(new([point])).Values.Single().Quality == "Uncertain_DataLoss", "Null skip cannot clear input loss");
            var next = await engine.ProcessAsync(new("factory/a", Encoding.UTF8.GetBytes("7"), false, false, 4), DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), CancellationToken.None);
            Check(next.Values.Single().Quality == "Good", "Later valid leaf recovers input loss");
            var retained = await engine.ProcessAsync(new("factory/a", Encoding.UTF8.GetBytes("8"), true, false, 5), DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), CancellationToken.None);
            Check(retained.Values.Single().Quality == "Uncertain_Retained", "Retained default quality");
            var invalid = await engine.ProcessAsync(new("factory/a", new byte[] { 0xC3, 0x28 }, false, false, 6), DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), CancellationToken.None);
            Check(invalid.Values.Single().Action == SourceValueAction.Retain && invalid.Values.Single().Quality == "Bad_DecodingError", "Invalid UTF8 retains previous accepted value");
            Check(engine.Read(new([point])).Values.Single().Value is long cached && cached == 8, "Failed decode leaves cache value intact");
            var collision = await engine.ProcessAsync(new("factory/a[b]", Encoding.UTF8.GetBytes("1"), false, false, 7), DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), CancellationToken.None);
            var colliding = await engine.ProcessAsync(new("factory/a_b_", Encoding.UTF8.GetBytes("2"), false, false, 8), DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), CancellationToken.None);
            Check(collision.Discoveries.Count == 1 && colliding.Error?.Contains("collides") == true, "Sanitized paths cannot overwrite another raw identity");
            var browse = engine.Browse(new(PageSize: 1, Generation: 2, BindingRevision: 3));
            Check(browse.Entries.Count == 1 && browse.ContinuationToken is not null, "Observed catalog uses bounded paging");
        }
        await using (var fixture = new SourceMqttFixture())
        {
            var settings = new SourceSettings("mqtt://127.0.0.1:" + fixture.Port, "subscribe", Points: [point], Mqtt: new("5", Mappings: [scalarMapping]));
            await using var session = new SourceMqttSession(new("monitor", "Monitor", "mqtt", Source: settings), Path.GetTempPath());
            var sink = new Sink(); await using var monitor = await session.StartMonitoringAsync(new(9, new(1, [point], [scalarMapping])), sink, CancellationToken.None);
            await fixture.Subscribed.Task.WaitAsync(TimeSpan.FromSeconds(3));
            await fixture.PublishAsync("factory/a", "12"); await WaitAsync(() => sink.Values.Any(value => value.Quality == "Good"), TimeSpan.FromSeconds(2));
            await WaitAsync(() => sink.Statuses.Last().Diagnostics?.GetValueOrDefault("inputBytes") is long bytes && bytes > 10, TimeSpan.FromSeconds(2));
            var initialMetrics = sink.Statuses.Last().Diagnostics!;
            Check((long)initialMetrics["reconnectAttempts"]! == 0 && (long)initialMetrics["inputBytes"]! > 10, "Initial monitor reports ingress without counting a reconnect");
            var activeTest = await session.TestAsync(CancellationToken.None);
            Check(activeTest.Success && fixture.Connections == 1, "Testing an active MQTT source reuses its acknowledged subscriber without a second CONNECT");
            await fixture.PublishAsync("factory/a", "13");
            await WaitAsync(() => sink.Values.Any(value => value.Value is long number && number == 13), TimeSpan.FromSeconds(2));
            Check(fixture.Connections == 1 && fixture.Failure is null, "MQTT acquisition continues on its original transport after a connection test");
            var second = point with { Id = "other", Address = "factory/b" };
            await monitor.UpdateBindingsAsync(new(2, [point, second], [scalarMapping]), CancellationToken.None);
            await fixture.PublishAsync("factory/b", "21"); await WaitAsync(() => sink.Values.Any(value => value.PointId == "other" && value.Quality == "Good"), TimeSpan.FromSeconds(2));
            Check(fixture.Connections == 1, "Hot bindings reuse the transport");
            await fixture.PublishAsync("factory/a", "null"); await Task.Delay(1100);
            Check((long)sink.Statuses.Last().Diagnostics!["inputBytes"]! > (long)initialMetrics["inputBytes"]!
                && (long)sink.Statuses.Last().Diagnostics!["reconnectAttempts"]! == 0, "Null skips and hot binding control traffic update bytes without a reconnect");
            Check((long)(await session.ReadAsync(new([second], 9, 2), CancellationToken.None)).Values.Single().Value! == 21, "Read returns accepted MQTT cache");
            Check((await session.TestAsync(CancellationToken.None)).Success && fixture.Connections == 1,
                "A connection test reuses subscriptions after a hot binding update");
            var exact = new SourceMqttMapping("retained", "factory/c", "[default]Retained", Tags: "explicit", Retained: "good");
            var retainedPoint = new SourcePoint("retained-point", "Retained", "factory/c", "Int64", MappingId: exact.Id);
            fixture.RetainedBeforeSubAck["factory/c"] = "32";
            await monitor.UpdateBindingsAsync(new(3, [point, second, retainedPoint], [scalarMapping, exact]), CancellationToken.None);
            await WaitAsync(() => sink.Values.Any(value => value.PointId == retainedPoint.Id && value.Quality == "Good"), TimeSpan.FromSeconds(2));
            Check((long)(await session.ReadAsync(new([retainedPoint], 9, 3), CancellationToken.None)).Values.Single().Value! == 32, "Retained packet before SUBACK survives candidate binding installation");
        }
        string unavailable;
        await using (var unused = new SourceMqttFixture()) unavailable = unused.Endpoint;
        await using (var retry = new SourceMqttSession(new("retry", "Retry", "mqtt", Source: new(unavailable, "subscribe", Limits: new(ConnectTimeoutMs: 250), Mqtt: new(Mappings: [scalarMapping]))), Path.GetTempPath())) {
            var sink = new Sink(); await using var monitor = await retry.StartMonitoringAsync(new(10, new(1, [], [scalarMapping])), sink, CancellationToken.None);
            await WaitAsync(() => sink.Statuses.Any(status => status.Diagnostics?.GetValueOrDefault("reconnectAttempts") is long count && count >= 1), TimeSpan.FromSeconds(4));
            var metrics = sink.Statuses.Last().Diagnostics!;
            Check((long)metrics["reconnectAttempts"]! >= 1 && (long)metrics["inputBytes"]! == 0
                && metrics["lastTransportActivityAt"] is null, "Failed reconnect attempts do not invent incoming transport activity");
            Check(!(await retry.TestAsync(CancellationToken.None)).Success,
                "Testing a disconnected active MQTT monitor does not report a successful subscription");
        }
        var automatic = scalarMapping with { Tags = "automatic" };
        var expiring = scalarMapping with { StaleAfterMs = 10 };
        var alias = point with { Id = "alias", Name = "Alias" };
        await using (var staleEngine = new SourceMqttMappingEngine(scalarConnection, new(1, [point, alias], [expiring]), 1)) {
            var receipt = Stopwatch.GetTimestamp(); var wall = DateTimeOffset.UtcNow;
            await staleEngine.ProcessAsync(new("factory/a", "10"u8.ToArray(), false, false, 1), wall, receipt, CancellationToken.None);
            var stale = staleEngine.Stale(receipt + Stopwatch.Frequency);
            Check(stale.Count == 2 && stale.All(value => value.Action == SourceValueAction.Retain && value.Quality == "Uncertain_Stale"),
                "Freshness expiry fans out to every saved alias of one canonical leaf");
            staleEngine.Update(new(2, [point, alias, alias with { Id = "imported-alias" }], [expiring]));
            var seeded = staleEngine.Read(new([alias with { Id = "imported-alias" }], 1, 2)).Values.Single();
            Check(seeded.Quality == "Uncertain_Stale" && seeded.ReceiptTimestamp == wall && seeded.MonotonicReceipt == receipt,
                "Hot imported alias reads stale canonical quality with original accepted receipt");
        }
        var automaticConnection = scalarConnection with { Source = scalarConnection.Source! with { Points = [], Mqtt = new(Mappings: [automatic]) } };
        await using (var engine = new SourceMqttMappingEngine(automaticConnection, new(1, [], [automatic]), 1))
        {
            SourcePublication? attempted = null;
            var denied = await engine.ProcessAsync(new("factory/c", "42"u8.ToArray(), false, false, 1), DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), CancellationToken.None,
                (publication, _) => { attempted = publication; return ValueTask.FromResult(false); });
            var id = SourceConfiguration.PointId(automaticConnection.Id, automatic.Id, "factory/c", null);
            Check(attempted!.Values.Single().PointId == id && attempted.Discoveries.Count == 1, "Automatic publication combines stable values and ownership candidates");
            Check(denied.Error is not null && engine.Browse(new()).Entries.Count == 0, "Rejected admission cannot install value/catalog/type lock");
            var accepted = await engine.ProcessAsync(new("factory/c", "\"new type\""u8.ToArray(), false, false, 2), DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), CancellationToken.None,
                (_, _) => ValueTask.FromResult(true));
            Check(accepted.Published && accepted.Values.Single().DataType == "String", "First admitted result owns the type lock after a rejected candidate");
            var replacement = automatic with { Id = "replacement" };
            engine.Update(new(2, [], [replacement]));
            Check(engine.Browse(new()).Entries.Count == 0, "Removed mapping identity releases its observed catalog and path locks");
            var remapped = await engine.ProcessAsync(new("factory/c", "true"u8.ToArray(), false, false, 3), DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), CancellationToken.None,
                (_, _) => ValueTask.FromResult(true));
            Check(remapped.Published && remapped.Values.Single().DataType == "Boolean", "Reviewed replacement mapping can establish a new schema in the released namespace");
        }
        var reviewConnection = automaticConnection with { Source = automaticConnection.Source! with { Mqtt = new(Mappings: [scalarMapping]) } };
        await using (var observed = new SourceMqttMappingEngine(reviewConnection, new(1, [], [scalarMapping]), 1)) {
            var acceptedAt = DateTimeOffset.UtcNow; var acceptedMono = Stopwatch.GetTimestamp();
            await observed.ProcessAsync(new("factory/observed", "11"u8.ToArray(), false, false, 1), acceptedAt, acceptedMono, CancellationToken.None, (_, _) => ValueTask.FromResult(true));
            var metrics = observed.Metrics();
            Check((DateTimeOffset)metrics["lastLiveMqttValueAt"]! == acceptedAt && (long)metrics["liveAcceptedMessages"]! == 1,
                "Zero-point review reports actual admitted live extraction time");
            await observed.ProcessAsync(new("factory/observed", "12"u8.ToArray(), true, false, 2), acceptedAt.AddSeconds(1), acceptedMono + Stopwatch.Frequency, CancellationToken.None);
            await observed.ProcessAsync(new("factory/observed", "null"u8.ToArray(), false, false, 3), acceptedAt.AddSeconds(2), acceptedMono + 2 * Stopwatch.Frequency, CancellationToken.None);
            await observed.ProcessAsync(new("factory/observed", new byte[] { 0xC3, 0x28 }, false, false, 4), acceptedAt.AddSeconds(3), acceptedMono + 3 * Stopwatch.Frequency, CancellationToken.None);
            await observed.ProcessAsync(new("factory/observed", "true"u8.ToArray(), false, false, 5), acceptedAt.AddSeconds(4), acceptedMono + 4 * Stopwatch.Frequency, CancellationToken.None);
            metrics = observed.Metrics();
            Check((DateTimeOffset)metrics["lastLiveMqttValueAt"]! == acceptedAt && (DateTimeOffset)metrics["lastAcceptedAt"]! == acceptedAt.AddSeconds(1),
                "Retained data, skips and decode/type failures preserve the last admitted live receipt");
            Check((long)metrics["decodeErrors"]! == 1 && (long)metrics["typeErrors"]! == 1 && (long)metrics["skippedMessages"]! == 1,
                "Decode, type and deliberate skip counters have separate meanings");
            Check((int)metrics["catalogCount"]! == 1 && (long)metrics["catalogBytes"]! > 0 && (long)metrics["stateBytes"]! > 0
                && metrics["catalogTruncated"] is false, "Catalog usage reports actual bounded state without invented truncation");
            var deniedAt = acceptedAt.AddSeconds(5);
            await observed.ProcessAsync(new("factory/other", "1"u8.ToArray(), false, false, 6), deniedAt, acceptedMono + 5 * Stopwatch.Frequency, CancellationToken.None, (_, _) => ValueTask.FromResult(false));
            Check((DateTimeOffset)observed.Metrics()["lastLiveMqttValueAt"]! == acceptedAt, "Rejected publication cannot advance diagnostic extraction freshness");
        }
        var failingScript = scalarMapping with { Payload = "script", Script = "undefined.member" };
        await using (var scripted = new SourceMqttMappingEngine(reviewConnection, new(1, [], [failingScript]), 1)) {
            try {
                await scripted.WarmAsync(CancellationToken.None);
                await scripted.ProcessAsync(new("factory/script", "1"u8.ToArray(), false, false, 1), DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), CancellationToken.None);
                Check((long)scripted.Metrics()["scriptErrors"]! == 1 && (long)scripted.Metrics()["decodeErrors"]! == 0
                    && scripted.Metrics()["lastLiveMqttValueAt"] is null, "Worker extraction failure is counted separately and cannot establish live time");
            }
            catch (PlatformNotSupportedException) when (OperatingSystem.IsLinux()) {
                Console.WriteLine("MQTT script-error telemetry fixture skipped: delegated Linux containment unavailable; scalar protocol qualification continues.");
            }
        }
        await using (var engine = new SourceMqttMappingEngine(reviewConnection, new(1, [], [scalarMapping]), 1))
        {
            for (var index = 0; index < 110; index++) await engine.ProcessAsync(new("factory/sample" + index, "\"sample\""u8.ToArray(), false, false, index + 1), DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), CancellationToken.None);
            var observed = engine.Browse(new(PageSize: 500));
            Check(observed.Entries.Count == 110 && observed.Entries.Count(entry => entry.Metadata?.ContainsKey("sample") == true) <= 100, "Observed metadata retains at most 100 bounded unimported samples");
            await engine.ProcessAsync(new("factory/large", Encoding.UTF8.GetBytes("\"" + new string('x', 5000) + "\""), false, false, 111), DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), CancellationToken.None);
            var large = new SourcePoint("large", "Large", "factory/large", "String", MappingId: scalarMapping.Id);
            Check(engine.Read(new([large])).Values.Single().Quality == "Bad_NoData", "Oversized unimported sample is not kept as an implicit live value");
        }
        return passed;
    }
    private static async Task WaitAsync(Func<bool> condition, TimeSpan timeout)
    { var started = Stopwatch.StartNew(); while (!condition()) { if (started.Elapsed > timeout) throw new TimeoutException("MQTT fixture did not observe expected value."); await Task.Delay(10); } }
    private sealed class Sink : ISourceSink
    {
        internal readonly ConcurrentQueue<SourceValue> Values = new();
        internal readonly ConcurrentQueue<SourceStatus> Statuses = new();
        public void OnValues(IReadOnlyList<SourceValue> values) { foreach (var value in values) Values.Enqueue(value); }
        public void OnStatus(SourceStatus status) => Statuses.Enqueue(status);
        public void OnDiscovery(SourceDiscoveryBatch discovery) { }
    }
    private sealed class HeaderOnlyStream(byte[] header) : MemoryStream(header)
    {
        internal int BodyReads;
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
        { if (Position == Length) { BodyReads++; throw new InvalidOperationException("Body was read before packet admission."); } return base.ReadAsync(buffer, ct); }
    }
}
