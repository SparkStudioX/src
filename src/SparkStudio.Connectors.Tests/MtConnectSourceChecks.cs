using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using SparkStudio.Connectors;

internal static class MtConnectSourceChecks
{
    // All protocol documents below are synthetic fixtures authored for SparkStudio.
    public static async Task<int> RunAsync()
    {
        var checks = 0;
        void Check(bool value, string description) { if (!value) throw new Exception("MTConnect: " + description); checks++; }
        void Reject(Action operation, string description, string? code = null) {
            try { operation(); }
            catch (Exception error) when (error is MtConnectProtocolException or SourceLimitException or System.Xml.XmlException or ArgumentException) {
                if (code is not null && error is MtConnectProtocolException p && p.Code != code) throw;
                checks++; return;
            }
            throw new Exception("MTConnect did not reject: " + description);
        }
        var catalog = MtConnectXml.Probe(Bytes(Probe()), 1024 * 1024);
        Check(catalog.Items.Count == 7, "probe discovers independently authored sample/event/condition/collection fixtures");
        Check(catalog.Items[0].Name == "speed" && catalog.Items[0].Address == "machine/speed", "missing item name falls back to stable id");
        Check(catalog.Items[0].ComponentPath == "Controller", "component hierarchy is preserved as browse metadata");
        Check(catalog.Items.First(i => i.Id == "samples").Supported == false, "unsupported time series is browse-only");
        Check(catalog.Items.First(i => i.Id == "count").DataType == "Int64", "numeric event has exact Int64 default");
        Check(catalog.Items.First(i => i.Id == "position").DataType == "String", "3D units are recognized even when type has no _3D suffix");
        using var reducer = new MtConnectReducer(catalog.Items);
        reducer.Apply(Parse(Streams(10, 20,
            Obs("speed", "SpindleSpeed", 7, "42.5") + Obs("count", "PartCount", 8, "9007199254740993") +
            Cond("Fault", 9, "A", "same", "fault A") + Cond("Fault", 4, "B", "same", "fault B") + Cond("Normal", 2, null, null, "") +
            Set(5, "<Entry key=\"a\">1</Entry><Entry key=\"b\">2</Entry>") +
            Table(6, "<Entry key=\"r\"><Cell key=\"x\">3</Cell><Cell key=\"y\">4</Cell></Entry>") + Obs("position", "PathPosition", 3, "1.25 2.5 3.75"))), true);
        Check((string?)reducer.Read("machine/position", "y").Value == "2.5", "3D selectors remain separate from stable raw address");
        Check((string?)reducer.Read("machine/condition", "level").Value == "FAULT", "unordered current snapshot keeps complete active set despite older Normal");
        using (var active = JsonDocument.Parse((string)reducer.Read("machine/condition", "active").Value!))
            Check(active.RootElement.GetArrayLength() == 2, "same nativeCode permits concurrent conditionId activations");
        Check((string?)reducer.Read("machine/condition", "message").Value == "fault A", "representative identity selection is deterministic");
        reducer.Apply(Parse(Streams(10, 25, Cond("Normal", 22, "A", null, "") +
            Set(23, "<Entry key=\"a\" removed=\"true\"/><Entry key=\"c\">5</Entry>") +
            Table(24, "<Entry key=\"r\"><Cell key=\"x\" removed=\"true\"/><Cell key=\"z\">6</Cell></Entry>"))), false);
        Check((string?)reducer.Read("machine/condition", "message").Value == "fault B", "targeted Normal with conditionId and no nativeCode clears only that activation");
        Check(reducer.Read("machine/set", "/a").Quality == "Bad_NoData", "removed dataset leaf becomes explicit no-data");
        Check((string?)reducer.Read("machine/set", "/b").Value == "2" && (string?)reducer.Read("machine/set", "/c").Value == "5", "dataset sample merges delta before publishing");
        Check(reducer.Read("machine/table", "/r/x").Quality == "Bad_NoData" && (string?)reducer.Read("machine/table", "/r/y").Value == "4", "table cell tombstone retains other cells");
        Check(reducer.Header!.Next == 25, "header nextSequence advances over legitimate filtered gaps");
        reducer.Apply(Parse(Streams(10, 28, Table(27, "<Entry key=\"r\" removed=\"true\"/>"))), false);
        Check(reducer.Read("machine/table", "/r").Quality == "Bad_NoData", "table row removal clears its selected descendants");
        reducer.Apply(Parse(Streams(10, 31, Set(30, "<Entry key=\"fresh\">7</Entry>", " resetTriggered=\"MANUAL\""))), false);
        Check(reducer.Read("machine/set", "/b").Quality == "Bad_NoData" && (string?)reducer.Read("machine/set", "/fresh").Value == "7", "reset clears prior dataset before applying new entries");
        reducer.Apply(Parse(Streams(10, 32, Set(31, "UNAVAILABLE"))), false);
        Check(reducer.Read("machine/set", null).Quality == "Bad_NoData", "UNAVAILABLE clears dataset state");
        reducer.Apply(Parse(Streams(10, 33, Cond("Unavailable", 32, null, null, ""))), false);
        Check(reducer.Read("machine/condition", "level").Quality == "Bad_NoData", "condition unavailable clears prior activations");
        reducer.Apply(Parse(Streams(10, 36, Cond("Warning", 35, null, "legacy", "fallback"), version: "2.5")), false);
        Check((string?)reducer.Read("machine/condition", "level").Value == "WARNING", "qualified 2.5 nativeCode condition identity fallback");
        reducer.Apply(Parse(Streams(10, 37, Cond("Normal", 36, null, "legacy", ""), version: "2.5")), false);
        Check((string?)reducer.Read("machine/condition", "level").Value == "NORMAL", "nativeCode fallback supports targeted clearing");
        reducer.Apply(Parse(Streams(10, 40, Obs("speed", "SpindleSpeed", 39, "8"))), false);
        reducer.Apply(Parse(Streams(10, 41, Obs("speed", "SpindleSpeed", 40, "9", "1999-01-01T00:00:00Z"))), false);
        Check((string?)reducer.Read("machine/speed", null).Value == "9", "source clock reset does not freeze higher-sequence updates");
        reducer.Apply(Parse(Streams(10, 42, "", last: 100)), false);
        Check(reducer.Header.Next == 42, "heartbeat advances accepted header cursor without deriving selected observation max");
        Reject(() => reducer.Apply(Parse(Streams(10, 50, "", first: 43)), false), "cursor expired from buffer boundaries", "OUT_OF_RANGE");
        Check(reducer.Header.Next == 42, "failed cursor validation does not commit cursor");
        Reject(() => reducer.Apply(Parse(Streams(11, 2, Obs("speed", "SpindleSpeed", 1, "0"))), false), "new epoch requires seed", "INSTANCE_CHANGED");
        reducer.Apply(Parse(Streams(11, 2, Obs("speed", "SpindleSpeed", 1, "0"))), true);
        Check(reducer.Header.Instance == 11 && reducer.Header.Next == 2, "new epoch permits cursor reset after authoritative snapshot");
        Check(reducer.Read("machine/count", null).Quality == "Bad_NoData", "missing snapshot item clears expected data");

        var discreteCatalog = catalog.Items.Select(i => i.Id == "set" ? i with { Discrete = true } : i).ToArray();
        using var discrete = new MtConnectReducer(discreteCatalog);
        discrete.Apply(Parse(Streams(10, 10, Set(9, "<Entry key=\"old\">1</Entry>"))), true);
        discrete.Apply(Parse(Streams(10, 11, Set(10, "<Entry key=\"new\">2</Entry>"))), false);
        Check(discrete.Read("machine/set", "/old").Quality == "Bad_NoData" && (string?)discrete.Read("machine/set", "/new").Value == "2", "discrete datasets replace each observation's complete set");
        var high = (ulong)long.MaxValue + 123;
        using var unsigned = new MtConnectReducer(catalog.Items);
        unsigned.Apply(Parse(Streams(high, high + 2, Obs("speed", "SpindleSpeed", high + 1, "1"), first: high)), true);
        Check(unsigned.Header!.Instance == high && unsigned.Header.Next == high + 2, "instance and cursors preserve unsigned values above Int64");
        Reject(() => Parse(Streams(10, 2, "<SpindleSpeed dataItemId=\"speed\" sequence=\"2\" timestamp=\"2026-10-01T00:00:00Z\">0</SpindleSpeed>")), "observation cannot exceed accepted document cursor");
        Reject(() => MtConnectXml.Probe(Bytes(Probe().Replace("2.8", "2.9")), 1024 * 1024), "unqualified namespace version rejected", "VERSION");
        Reject(() => MtConnectXml.Probe(Bytes("<!DOCTYPE MTConnectDevices [<!ENTITY x SYSTEM 'file:///not-read'>]>" + Probe()), 1024 * 1024), "DTD and external entities disabled");
        Reject(() => MtConnectXml.Probe(Bytes(Probe()), 10), "document byte ceiling enforced", "LIMIT");
        Reject(() => MtConnectXml.Probe(Bytes(Probe()), 1024 * 1024, new(DecodeNodes: 2)), "decode node ceiling enforced", "LIMIT");
        Reject(() => Parse(Streams(10, 2, "<SpindleSpeed xmlns=\"urn:other\" dataItemId=\"speed\" sequence=\"1\" timestamp=\"2026-10-01T00:00:00Z\">0</SpindleSpeed>")), "mixed namespace rejected");
        Reject(() => Parse("<MTConnectError xmlns=\"urn:mtconnect.org:MTConnectError:2.5\"><Errors><Error errorCode=\"OUT_OF_RANGE\">expired</Error></Errors></MTConnectError>"), "old agent error normalized", "OUT_OF_RANGE");
        Reject(() => Parse("<MTConnectError xmlns=\"urn:mtconnect.org:MTConnectError:2.8\"><Errors><OutOfRange><Message>expired</Message></OutOfRange></Errors></MTConnectError>"), "new agent error normalized", "OUT_OF_RANGE");
        using var small = new MtConnectReducer(catalog.Items, new(StateBytes: 1024));
        small.Apply(Parse(Streams(10, 2, Obs("speed", "SpindleSpeed", 1, "4"))), true);
        Reject(() => small.Apply(Parse(Streams(10, 3, Set(2, "<Entry key=\"large\">" + new string('x', 1000) + "</Entry>"))), false), "canonical state budget enforced atomically", "LIMIT");
        Check(small.Header!.Next == 2 && (string?)small.Read("machine/speed", null).Value == "4", "over-cap delta leaves prior state and cursor unchanged");
        using var valueBound = new MtConnectReducer(catalog.Items, new(ValueBytes: 4));
        valueBound.Apply(Parse(Streams(10, 2, Obs("count", "PartCount", 1, "12345"))), true);
        Check(valueBound.Read("machine/count", null).Quality == "Bad_DecodingError", "scalar output size limit gives visible bad quality");

        var multipart = "--fixture-boundary\r\nContent-Type: application/xml\r\n\r\n" + Streams(10, 2, "") + "\r\n--fixture-boundary\r\nContent-Type: application/xml\r\n\r\n" + Streams(10, 3, "") + "\r\n--fixture-boundary--\r\n";
        var parts = new List<byte[]>();
        await foreach (var part in MtConnectMultipart.ReadAsync(new FragmentedStream(Bytes(multipart), 7), "fixture-boundary", 1024 * 1024, TimeSpan.FromSeconds(2), default)) parts.Add(part);
        Check(parts.Count == 2 && Parse(Encoding.UTF8.GetString(parts[1])).Header.Next == 3, "multipart parsing spans arbitrary network chunks and excludes MIME headers");
        var handler = new FixtureHandler(Probe(), Streams(10, 10,
            Obs("speed", "SpindleSpeed", 9, "42.5") + Obs("count", "PartCount", 8, "9007199254740993") + Cond("Fault", 7, "A", "X", "fixture")));
        using var http = new HttpClient(handler);
        var points = new[] { new SourcePoint("s", "Speed", "machine/speed", "Double"),
            new SourcePoint("c", "Count", "machine/count", "Int64"), new SourcePoint("a", "Alarm", "machine/condition", "String", "level") };
        var connection = new ConnectionDefinition("mt", "MT fixture", "mtconnect", Source: new("http://127.0.0.1/agent", Points: points,
            Authentication: new("api-key", Token: "fixture-token"), MtConnect: new(Device: "machine", Path: "//DataItem")));
        await using var session = new SourceMtConnectSession(connection, http);
        var test = await session.TestAsync(default);
        Check(test.Success && !test.Capabilities.CanWrite && test.Version == "2.8", "Test returns read-only capabilities and version evidence");
        var devices = await session.BrowseAsync(new(Generation: 7, BindingRevision: 2), default);
        Check(devices.Entries.Single().Address == "machine", "browse root exposes device hierarchy without reading every value");
        var page = await session.BrowseAsync(new("machine", 2, Generation: 7, BindingRevision: 2), default);
        Check(page.Entries.Count == 2 && page.ContinuationToken is not null, "browse is paged and generation/revision fenced");
        var next = await session.BrowseAsync(new("machine", 2, page.ContinuationToken, 7, 2), default);
        Check(next.Entries.Count == 2 && next.Entries[0].Address != page.Entries[0].Address, "browse continuation advances bounded page");
        try { await session.BrowseAsync(new("machine", 2, page.ContinuationToken, 8, 2), default); throw new Exception("No generation rejection"); }
        catch (ArgumentException) { checks++; }
        var read = await session.ReadAsync(new(points, 7, 2), default);
        Check(read.Values[0].Value is double speed && speed == 42.5, "read returns typed scalar sample");
        Check(read.Values[1].Value is long count && count == 9007199254740993, "read preserves exact integer event above JavaScript safe range");
        Check(read.Values.All(v => v.Generation == 7 && v.BindingRevision == 2 && v.MonotonicReceipt > 0 && v.SourceTimestamp is not null), "read carries source/receipt times and lifecycle fences");
        Check(handler.Requests.All(r => r.Path.Contains("/machine/") && r.Path.Contains("path=%2F%2FDataItem") && r.UserAgent.Contains("SparkStudio") && r.ApiKey == "fixture-token"), "device/path filtering, explicit User-Agent and protected authentication applied");
        Reject(() => session.ReadAsync(new([points[0] with { Writable = true }]), default).GetAwaiter().GetResult(), "forged writable source point denied");
        var sink = new FixtureSink();
        await using var watch = await session.StartMonitoringAsync(new(9, new(1, points)), sink, default);
        await sink.FirstValues.Task.WaitAsync(TimeSpan.FromSeconds(3));
        Check(sink.Values.Last().All(v => v.Generation == 9 && v.BindingRevision == 1), "monitor seeds connection-owned state");
        var healthySeed = sink.Values.Last()[0];
        await watch.UpdateBindingsAsync(new(2, [points[0]]), default);
        Check(sink.Values.Last().Count == 1 && sink.Values.Last()[0].BindingRevision == 2, "hot revision atomically removes retired bindings and seeds new selectors");
        Check(sink.Values.Last()[0].ReceiptTimestamp == healthySeed.ReceiptTimestamp && sink.Values.Last()[0].MonotonicReceipt == healthySeed.MonotonicReceipt,
            "healthy cached binding seed preserves accepted wall-clock and monotonic receipts");
        Check(sink.LatestHealthy == healthySeed.ReceiptTimestamp, "unchanged healthy binding seed does not advance latest healthy observation time");
        var explicitWhileWatching = await session.ReadAsync(new([points[0]]), default);
        Check(explicitWhileWatching.Values.Count == 1, "lifetime watch does not hold user Read admission gate");
        await watch.DisposeAsync();
        var after = sink.Values.Count;
        await Task.Delay(30);
        Check(sink.Values.Count == after, "dispose fences late callbacks and releases in cancellation budget");
        await RecoveryChecksAsync(Check);
        await OutageBindingChecksAsync(Check);
        await LoopbackChecksAsync(Check);
        await BackoffRecoveryChecksAsync(Check);
        await PollTelemetryChecksAsync(Check);
        Check(SourceMemoryBudget.Snapshot().GetValueOrDefault("state") >= 0, "global source state accounting remains nonnegative");
        return checks;
    }
    private static async Task LoopbackChecksAsync(Action<bool, string> check)
    {
        var point = new SourcePoint("speed", "Speed", "machine/speed", "Double");
        await using (var fixture = new MtConnectSimulatorFixture { ExpireFirstCursor = true }) {
            await using var session = new SourceMtConnectSession(new("loop", "Synthetic CNC", "mtconnect", Source:
                new(fixture.Endpoint.ToString(), "subscribe", Points: [point], MtConnect: new(HeartbeatMs: 1000))));
            check((await session.TestAsync(default)).Success, "real loopback HTTP probe connects using gateway-owned client");
            var sink = new RecoverySink(100);
            await using var monitor = await session.StartMonitoringAsync(new(41, new(1, [point])), sink, default);
            await sink.Recovered.Task.WaitAsync(TimeSpan.FromSeconds(8));
            check(fixture.SampleRequests >= 2 && fixture.CurrentReads >= 2, "real fragmented multipart HTTP stream recovers expired cursor and publishes reduced values");
        }
        await using (var fixture = new MtConnectSimulatorFixture { StallAfterSeed = true }) {
            await using var session = new SourceMtConnectSession(new("stall", "Stall", "mtconnect", Source:
                new(fixture.Endpoint.ToString(), "subscribe", Points: [point], MtConnect: new(HeartbeatMs: 1000))));
            var sink = new TimeoutSink();
            await using var monitor = await session.StartMonitoringAsync(new(42, new(1, [point])), sink, default);
            await sink.TimedOut.Task.WaitAsync(TimeSpan.FromSeconds(6));
            check(sink.Retained, "no complete document for three heartbeats times out despite an open HTTP transport");
        }
    }
    private static async Task RecoveryChecksAsync(Action<bool, string> check)
    {
        foreach (var errorStatus in new[] { HttpStatusCode.BadRequest, HttpStatusCode.NotFound }) {
            var handler = new RecoveryHandler(errorStatus);
            var point = new SourcePoint("speed", "Speed", "machine/speed", "Double");
            await using var session = new SourceMtConnectSession(new("fixture", "Recovery", "mtconnect", Source:
                new("http://127.0.0.1/", "subscribe", Points: [point], MtConnect: new(HeartbeatMs: 1000))), new HttpClient(handler));
            var sink = new RecoverySink(3);
            await using var monitor = await session.StartMonitoringAsync(new(12, new(1, [point])), sink, default);
            await sink.Recovered.Task.WaitAsync(TimeSpan.FromSeconds(6));
            check(handler.SampleRequests.Count >= 2 && handler.CurrentReads >= 2, "HTTP " + (int)errorStatus + " OUT_OF_RANGE re-seeds current instead of unbounded buffer replay");
            check(handler.SampleRequests.All(query => query.Contains("from=", StringComparison.Ordinal)), "every initial/recovery sample explicitly supplies saved cursor");
            check(sink.UnknownLossEvents > 0 && sink.SawLossQuality, "expired cursor reports unknown loss amount and uncertain retained data");
        }
        var ordinary = new OrdinaryDropHandler();
        var ordinaryPoint = new SourcePoint("speed", "Speed", "machine/speed", "Double");
        await using var ordinarySession = new SourceMtConnectSession(new("drop", "Drop", "mtconnect", Source:
            new("http://127.0.0.1/", "subscribe", Points: [ordinaryPoint], MtConnect: new(HeartbeatMs: 1000))), new HttpClient(ordinary));
        var ordinarySink = new RecoverySink();
        await using var ordinaryWatch = await ordinarySession.StartMonitoringAsync(new(13, new(1, [ordinaryPoint])), ordinarySink, default);
        await ordinarySink.Recovered.Task.WaitAsync(TimeSpan.FromSeconds(6));
        check(ordinary.CurrentReads == 1 && ordinary.SampleRequests.Count >= 2
            && ordinary.SampleRequests.All(query => query.Contains("from=10", StringComparison.Ordinal)), "ordinary stream drop resumes valid saved cursor without unnecessary seed/replay");
        check(ordinarySink.SawCommunicationFailure, "ordinary stream drop retains prior value with communication quality before resumed Good");
    }
    private static async Task BackoffRecoveryChecksAsync(Action<bool, string> check)
    {
        var point = new SourcePoint("speed", "Speed", "machine/speed", "Double");
        await using (var fixture = new MtConnectSimulatorFixture { DropAfterValidPart = true }) {
            await using var session = new SourceMtConnectSession(new("repeat-drop", "Repeated live drops", "mtconnect", Source:
                new(fixture.Endpoint.ToString(), "subscribe", Points: [point], MtConnect: new(HeartbeatMs: 1000))));
            var sink = new RecoverySink(105);
            var started = System.Diagnostics.Stopwatch.GetTimestamp();
            await using var monitor = await session.StartMonitoringAsync(new(43, new(1, [point])), sink, default);
            await sink.Recovered.Task.WaitAsync(TimeSpan.FromSeconds(8));
            var attempts = fixture.SampleStarts.Take(5).ToArray();
            check(attempts.Length == 5 && System.Diagnostics.Stopwatch.GetElapsedTime(started).TotalSeconds < 8,
                "five real multipart drops recover with first-step backoff after each validated live part");
            check(fixture.CurrentReads == 1 && attempts.Select(attempt => attempt.Cursor).SequenceEqual(new ulong[] { 10, 11, 12, 13, 14 }),
                "repeated partial-stream recovery preserves every accepted cursor without unnecessary current reconciliation");
            check(attempts.Zip(attempts.Skip(1), (before, after) => System.Diagnostics.Stopwatch.GetElapsedTime(before.Started, after.Started).TotalSeconds).All(seconds => seconds < 2.5),
                "validated multipart progress resets exponential retry even when the same HTTP response later fails");
        }
        await using (var fixture = new MtConnectSimulatorFixture { MalformedSamples = true }) {
            await using var session = new SourceMtConnectSession(new("malformed-backoff", "Malformed backoff", "mtconnect", Source:
                new(fixture.Endpoint.ToString(), "subscribe", Points: [point], MtConnect: new(HeartbeatMs: 1000))));
            var sink = new BackoffSink();
            await using var monitor = await session.StartMonitoringAsync(new(44, new(1, [point])), sink, default);
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (fixture.SampleStarts.Count < 2) await Task.Delay(20, deadline.Token);
            await monitor.UpdateBindingsAsync(new(2, [point, point with { Id = "cached-alias" }]), default);
            while (fixture.SampleStarts.Count < 4) await Task.Delay(20, deadline.Token);
            var attempts = fixture.SampleStarts.Take(4).ToArray();
            var gaps = attempts.Zip(attempts.Skip(1), (before, after) => System.Diagnostics.Stopwatch.GetElapsedTime(before.Started, after.Started).TotalSeconds).ToArray();
            check(gaps[0] >= 0.9 && gaps[1] >= 1.8 && gaps[2] >= 3.8,
                "opening HTTP multipart transports without an accepted part retains exponential retry backoff");
            check(fixture.CurrentReads == 1 && attempts.All(attempt => attempt.Cursor == 10),
                "malformed parts do not advance the accepted cursor or fabricate reconciliation progress");
            check(sink.Values.Where(value => value.Quality == "Good").All(value => value.Value is double number && number == 1)
                && sink.Values.Any(value => value.BindingRevision == 2),
                "a cached binding seed does not count as authoritative progress or reset malformed-response backoff");
            while (!sink.Statuses.Any(status => status.Diagnostics?.GetValueOrDefault("reconnectAttempts") is long count && count >= 3)) await Task.Delay(20, deadline.Token);
            check(sink.Statuses.All(status => status.Diagnostics?.ContainsKey("lastTransportActivityAt") == true)
                && sink.Statuses.Any(status => status.Diagnostics?.GetValueOrDefault("inputBytes") is long bytes && bytes > 0),
                "transport headers and malformed partial input remain visible across retry status diagnostics");
        }
    }
    private static async Task PollTelemetryChecksAsync(Action<bool, string> check)
    {
        var point = new SourcePoint("speed", "Speed", "machine/speed", "Double");
        await using var fixture = new MtConnectSimulatorFixture();
        await using var session = new SourceMtConnectSession(new("poll-metrics", "Poll metrics", "mtconnect", Source:
            new(fixture.Endpoint.ToString(), "poll", Points: [point])));
        var sink = new PollTelemetrySink();
        await using var monitor = await session.StartMonitoringAsync(new(45, new(1, [point])), sink, default);
        var status = await sink.Polled.Task.WaitAsync(TimeSpan.FromSeconds(4));
        var first = sink.Statuses.First(item => item.State == "connected").Diagnostics!;
        var metrics = status.Diagnostics!;
        check(metrics["inputBytes"] is long bytes && bytes > (long)first["inputBytes"]!
            && metrics["inputBytesPerSecond"] is double rate && rate > 0,
            "HTTP polling accounts probe, current seed and later current response bytes and owner-mean input rate");
        check(metrics["lastTransportActivityAt"] is DateTimeOffset activity && activity > (DateTimeOffset)first["lastTransportActivityAt"]!,
            "poll response activity advances despite an unchanged old native source timestamp");
        check((string)metrics["mode"]! == "poll" && (int)metrics["catalogCount"]! == 1 && (long)metrics["catalogBytes"]! > 0
            && (long)metrics["reconnectAttempts"]! == 0 && metrics.ContainsKey("effectiveLimits"),
            "poll status carries actual acquisition mode, catalog usage, retry count and effective limits");
        check(sink.Statuses.All(item => item.Diagnostics is { } details && details.ContainsKey("inputBytes") && details.ContainsKey("inputBytesPerSecond")
            && details.ContainsKey("lastTransportActivityAt") && details.ContainsKey("sampleDocumentBytes")),
            "every MTConnect status includes transport telemetry while preserving accepted sample-document counters");
    }
    private static async Task OutageBindingChecksAsync(Action<bool, string> check)
    {
        var handler = new HeldOutageHandler();
        var point = new SourcePoint("speed", "Speed", "machine/speed", "Double");
        await using var session = new SourceMtConnectSession(new("binding-outage", "Binding outage", "mtconnect", Source:
            new("http://127.0.0.1/", "subscribe", Points: [point], MtConnect: new(HeartbeatMs: 1000))), new HttpClient(handler));
        var sink = new OutageBindingSink();
        await using var monitor = await session.StartMonitoringAsync(new(14, new(1, [point])), sink, default);
        await sink.Degraded.Task.WaitAsync(TimeSpan.FromSeconds(3));
        var accepted = sink.Values.First(value => value.Quality == "Good"); var healthyBefore = sink.LatestHealthy;
        await monitor.UpdateBindingsAsync(new(2, [point, point with { Id = "second", Name = "New cached binding" }]), default);
        var seed = sink.Values.Where(value => value.BindingRevision == 2).ToArray();
        check(seed.Length == 2 && seed.All(value => value.Quality == "Bad_CommunicationError" && value.Action == SourceValueAction.Retain),
            "hot bindings during transport backoff retain outage quality for old and newly cached selectors");
        check(seed.All(value => value.ReceiptTimestamp == accepted.ReceiptTimestamp && value.MonotonicReceipt > accepted.MonotonicReceipt),
            "outage binding seed retains the accepted receipt while delivering Retain diagnostics after the transport fence");
        check(seed.All(value => value.SourceTimestamp == accepted.SourceTimestamp && value.MonotonicReceipt > sink.DegradedMonotonic),
            "outage binding diagnostics cross the current failure fence without changing native source time");
        check(sink.LatestHealthy == healthyBefore && !seed.Any(value => value.Quality == "Good"),
            "hot binding cannot heal transport quality or advance latest healthy during an outage");
        handler.Resume.TrySetResult();
        await sink.Recovered.Task.WaitAsync(TimeSpan.FromSeconds(6));
        check(sink.Values.Any(value => value.BindingRevision == 2 && value.Quality == "Good" && value.Value is double number && number == 2)
            && sink.LatestHealthy > healthyBefore, "only a newly accepted recovered document refreshes the new binding revision");
    }
    private static byte[] Bytes(string value) => Encoding.UTF8.GetBytes(value);
    private static MtConnectDocument Parse(string value) => MtConnectXml.Streams(Bytes(value), 1024 * 1024);
    private static string Probe() => "<MTConnectDevices xmlns=\"urn:mtconnect.org:MTConnectDevices:2.8\"><Header instanceId=\"10\" version=\"fixture\"/><Devices><Device id=\"m\" uuid=\"machine\" name=\"Synthetic CNC\"><Components><Controller id=\"ctl\" name=\"Controller\"><DataItems>"
        + "<DataItem id=\"speed\" category=\"SAMPLE\" type=\"SPINDLE_SPEED\" units=\"REVOLUTION/MINUTE\"/>"
        + "<DataItem id=\"count\" category=\"EVENT\" type=\"PART_COUNT\"/>"
        + "<DataItem id=\"condition\" category=\"CONDITION\" type=\"SYSTEM\"/>"
        + "<DataItem id=\"set\" category=\"EVENT\" type=\"VARIABLE\" representation=\"DATA_SET\"/>"
        + "<DataItem id=\"table\" category=\"EVENT\" type=\"VARIABLE\" representation=\"TABLE\"/>"
        + "<DataItem id=\"samples\" category=\"SAMPLE\" type=\"POSITION\" representation=\"TIME_SERIES\"/>"
        + "<DataItem id=\"position\" category=\"SAMPLE\" type=\"PATH_POSITION\" units=\"MILLIMETER_3D\"/>"
        + "</DataItems></Controller></Components></Device></Devices></MTConnectDevices>";
    private static string Streams(ulong instance, ulong next, string observations, ulong first = 1, ulong? last = null, string version = "2.8") =>
        $"<MTConnectStreams xmlns=\"urn:mtconnect.org:MTConnectStreams:{version}\"><Header instanceId=\"{instance}\" firstSequence=\"{first}\" lastSequence=\"{last ?? next - 1}\" nextSequence=\"{next}\"/><Streams><DeviceStream uuid=\"machine\"><ComponentStream><Events>{observations}</Events></ComponentStream></DeviceStream></Streams></MTConnectStreams>";
    private static string Obs(string id, string kind, ulong sequence, string value, string time = "2026-10-01T00:00:00Z") =>
        $"<{kind} dataItemId=\"{id}\" sequence=\"{sequence}\" timestamp=\"{time}\">{value}</{kind}>";
    private static string Cond(string kind, ulong seq, string? identity, string? code, string message) =>
        $"<{kind} dataItemId=\"condition\" sequence=\"{seq}\" timestamp=\"2026-10-01T00:00:00Z\"{(identity is null ? "" : " conditionId=\"" + identity + "\"")}{(code is null ? "" : " nativeCode=\"" + code + "\"")}>{message}</{kind}>";
    private static string Set(ulong seq, string entries, string attrs = "") =>
        $"<VariableDataSet dataItemId=\"set\" sequence=\"{seq}\" timestamp=\"2026-10-01T00:00:00Z\"{attrs}>{entries}</VariableDataSet>";
    private static string Table(ulong seq, string entries) =>
        $"<VariableTable dataItemId=\"table\" sequence=\"{seq}\" timestamp=\"2026-10-01T00:00:00Z\">{entries}</VariableTable>";
    private sealed class FragmentedStream(byte[] bytes, int chunk) : MemoryStream(bytes)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => base.ReadAsync(buffer[..Math.Min(buffer.Length, chunk)], cancellationToken);
    }
    private sealed class FixtureHandler(string probe, string current) : HttpMessageHandler
    {
        public ConcurrentQueue<(string Path, string UserAgent, string? ApiKey)> Requests { get; } = new();
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Requests.Enqueue((request.RequestUri!.AbsolutePath + request.RequestUri.Query, request.Headers.UserAgent.ToString(), request.Headers.TryGetValues("X-API-Key", out var values) ? values.Single() : null));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(request.RequestUri.AbsolutePath.EndsWith("probe", StringComparison.Ordinal) ? probe : current, Encoding.UTF8, "application/xml") });
        }
    }
    private sealed class FixtureSink : ISourceSink
    {
        public TaskCompletionSource FirstValues { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public List<IReadOnlyList<SourceValue>> Values { get; } = [];
        public DateTimeOffset? LatestHealthy;
        public void OnValues(IReadOnlyList<SourceValue> values) { lock (Values) Values.Add(values); foreach (var value in values.Where(value => value.Quality == "Good" && value.Action == SourceValueAction.Replace)) LatestHealthy = value.ReceiptTimestamp; FirstValues.TrySetResult(); }
        public void OnStatus(SourceStatus status) { }
        public void OnDiscovery(SourceDiscoveryBatch discovery) { }
    }
    private sealed class RecoverySink(double minimum = 2) : ISourceSink
    {
        public TaskCompletionSource Recovered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public long Lost;
        public long UnknownLossEvents;
        public bool SawLossQuality;
        public bool SawCommunicationFailure;
        public void OnValues(IReadOnlyList<SourceValue> values) {
            foreach (var value in values) {
                SawLossQuality |= value.Quality == "Uncertain_DataLoss" && value.Action == SourceValueAction.Retain;
                SawCommunicationFailure |= value.Quality == "Bad_CommunicationError" && value.Action == SourceValueAction.Retain;
                if (value.Value is double number && number >= minimum && value.Quality == "Good") Recovered.TrySetResult();
            }
        }
        public void OnStatus(SourceStatus status) {
            Lost = Math.Max(Lost, status.LostUpdates);
            if (status.Diagnostics?.GetValueOrDefault("unknownLossEvents") is long unknown) UnknownLossEvents = Math.Max(UnknownLossEvents, unknown);
        }
        public void OnDiscovery(SourceDiscoveryBatch discovery) { }
    }
    private sealed class TimeoutSink : ISourceSink
    {
        public TaskCompletionSource TimedOut { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool Retained;
        public void OnValues(IReadOnlyList<SourceValue> values) {
            Retained = values.Any(value => value.Quality == "Bad_Timeout" && value.Action == SourceValueAction.Retain);
            if (Retained) TimedOut.TrySetResult();
        }
        public void OnStatus(SourceStatus status) { }
        public void OnDiscovery(SourceDiscoveryBatch discovery) { }
    }
    private sealed class BackoffSink : ISourceSink
    {
        public ConcurrentQueue<SourceValue> Values { get; } = new();
        public ConcurrentQueue<SourceStatus> Statuses { get; } = new();
        public void OnValues(IReadOnlyList<SourceValue> values) { foreach (var value in values) Values.Enqueue(value); }
        public void OnStatus(SourceStatus status) { Statuses.Enqueue(status); }
        public void OnDiscovery(SourceDiscoveryBatch discovery) { }
    }
    private sealed class PollTelemetrySink : ISourceSink
    {
        public ConcurrentQueue<SourceStatus> Statuses { get; } = new();
        public TaskCompletionSource<SourceStatus> Polled { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int values;
        public void OnValues(IReadOnlyList<SourceValue> batch) { if (batch.Any(value => value.Quality == "Good")) Interlocked.Increment(ref values); }
        public void OnStatus(SourceStatus status) { Statuses.Enqueue(status); if (status.State == "connected" && Volatile.Read(ref values) >= 2) Polled.TrySetResult(status); }
        public void OnDiscovery(SourceDiscoveryBatch discovery) { }
    }
    private sealed class RecoveryHandler(HttpStatusCode expiredStatus) : HttpMessageHandler
    {
        public ConcurrentQueue<string> SampleRequests { get; } = new();
        public int CurrentReads;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.RequestUri!.AbsolutePath.EndsWith("probe", StringComparison.Ordinal)) return Task.FromResult(Response(Probe()));
            if (request.RequestUri.AbsolutePath.EndsWith("current", StringComparison.Ordinal)) {
                var read = Interlocked.Increment(ref CurrentReads);
                return Task.FromResult(Response(Streams(10, (ulong)(read == 1 ? 10 : 20), Obs("speed", "SpindleSpeed", (ulong)(read == 1 ? 9 : 19), read == 1 ? "1" : "2"))));
            }
            SampleRequests.Enqueue(request.RequestUri.Query);
            return SampleRequests.Count == 1 ? Task.FromResult(Response(
                "<MTConnectError xmlns=\"urn:mtconnect.org:MTConnectError:2.8\"><Errors><OutOfRange><Message>expired</Message></OutOfRange></Errors></MTConnectError>", expiredStatus))
                : Task.FromResult(Response(Streams(10, 21, Obs("speed", "SpindleSpeed", 20, "3"))));
        }
    }
    private sealed class OrdinaryDropHandler : HttpMessageHandler
    {
        public ConcurrentQueue<string> SampleRequests { get; } = new();
        public int CurrentReads;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.RequestUri!.AbsolutePath.EndsWith("probe", StringComparison.Ordinal)) return Task.FromResult(Response(Probe()));
            if (request.RequestUri.AbsolutePath.EndsWith("current", StringComparison.Ordinal)) { CurrentReads++; return Task.FromResult(Response(Streams(10, 10, Obs("speed", "SpindleSpeed", 9, "1")))); }
            SampleRequests.Enqueue(request.RequestUri.Query);
            if (SampleRequests.Count == 1) throw new IOException("Synthetic disconnected stream.");
            return Task.FromResult(Response(Streams(10, 11, Obs("speed", "SpindleSpeed", 10, "2"))));
        }
    }
    private sealed class OutageBindingSink : ISourceSink
    {
        public ConcurrentQueue<SourceValue> Values { get; } = new();
        public TaskCompletionSource Degraded { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Recovered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public DateTimeOffset? LatestHealthy;
        public long DegradedMonotonic;
        public void OnValues(IReadOnlyList<SourceValue> values) {
            foreach (var value in values) {
                Values.Enqueue(value);
                if (value.Quality != "Good" || value.Action != SourceValueAction.Replace) continue;
                LatestHealthy = value.ReceiptTimestamp;
                if (value.BindingRevision == 2 && value.Value is double number && number == 2) Recovered.TrySetResult();
            }
        }
        public void OnStatus(SourceStatus status) { if (status.State == "degraded") { DegradedMonotonic = System.Diagnostics.Stopwatch.GetTimestamp(); Degraded.TrySetResult(); } }
        public void OnDiscovery(SourceDiscoveryBatch discovery) { }
    }
    private sealed class HeldOutageHandler : HttpMessageHandler
    {
        public TaskCompletionSource Resume { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int samples;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.RequestUri!.AbsolutePath.EndsWith("probe", StringComparison.Ordinal)) return Response(Probe());
            if (request.RequestUri.AbsolutePath.EndsWith("current", StringComparison.Ordinal)) return Response(Streams(10, 10, Obs("speed", "SpindleSpeed", 9, "1")));
            if (Interlocked.Increment(ref samples) == 1) throw new IOException("Synthetic outage held across a local binding change.");
            await Resume.Task.WaitAsync(ct);
            return Response(Streams(10, 11, Obs("speed", "SpindleSpeed", 10, "2")));
        }
    }
    private static HttpResponseMessage Response(string content, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(content, Encoding.UTF8, "application/xml") };
}
