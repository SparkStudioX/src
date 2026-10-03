using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using SparkStudio.Connectors;

internal static class I3xSourceChecks
{
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("i3X: " + message); passed++; }
        async Task Reject(Func<Task> action, string message)
        {
            try { await action(); }
            catch (Exception error) when (error is ArgumentException or IOException or InvalidOperationException or OperationCanceledException) { passed++; return; }
            throw new InvalidOperationException("i3X accepted " + message);
        }
        static ConnectionDefinition Connection(SourcePoint[] points, string acquisition = "poll", SourceI3xSettings? options = null, SourceLimits? limits = null)
            => new("i3x-test", "Synthetic i3X", "i3x", Source: new("http://127.0.0.1/v1", acquisition,
                Points: points, I3x: options ?? new(PreferStream: false, ReconciliationSeconds: 5, ClientId: "persistent-synthetic-client"), Limits: limits));
        await Reject(() => { SourceConfiguration.Validate("i3x", new("http://industrial.invalid/v1", Authentication: new("bearer", Token: "synthetic"))); return Task.CompletedTask; }, "non-loopback i3X plaintext even with authentication");
        SourceConfiguration.Validate("i3x", new("https://industrial.invalid/v1"));
        Check(true, "non-loopback HTTPS accepts omitted authentication");
        SourceConfiguration.Validate("i3x", new("https://industrial.invalid/v1", Authentication: new("none")));
        Check(true, "non-loopback HTTPS accepts explicit None authentication");
        SourceConfiguration.Validate("i3x", new("https://industrial.invalid/v1", Authentication: new("bearer", Token: "synthetic")));
        Check(true, "non-loopback authenticated HTTPS settings pass local validation without a network request");
        foreach (var mode in new[] { "basic", "bearer", "api-key" })
            await Reject(() => { SourceConfiguration.Validate("i3x", new("https://industrial.invalid/v1", Authentication: new(mode))); return Task.CompletedTask; }, mode + " without its selected credentials");
        var opaque = "urn:synthetic:cell#state/a&b=one";
        var points = new[] { new SourcePoint("temperature", "Temperature", opaque, "Int64", "/reading~1raw/~0value"),
            new SourcePoint("missing", "Missing", opaque, "Boolean", "/absent"),
            new SourcePoint("array", "Array", opaque, "Double", "/items/1") };
        using var fixture = new I3xFixture();
        fixture.Values[opaque] = Vqt(new Dictionary<string, object?> { ["reading/raw"] = new Dictionary<string, object?> { ["~value"] = 9007199254740993L }, ["items"] = new[] { 1.0, 2.5 } });
        using var http = new HttpClient(fixture) { Timeout = Timeout.InfiniteTimeSpan };
        var anonymousConnection = Connection(points);
        anonymousConnection = anonymousConnection with { Source = anonymousConnection.Source! with {
            Endpoint = "https://industrial.invalid/v1", Authentication = new("none", Token: "unused-synthetic-token") } };
        await using var session = new SourceI3xSession(anonymousConnection, http);
        var test = await session.TestAsync(default);
        Check(test.Success && test.Capabilities.CanWrite == false && test.Version == "1.0"
            && Equals(test.Details?["serverVersion"], "fixture-1") && Equals(test.Details?["streamAdvertised"], false),
            "successful /info envelope preserves version, capabilities and read-only behavior");
        var read = await session.ReadAsync(new(points, 7, 11), default);
        Check((long)read.Values[0].Value! == 9007199254740993L, "Int64 conversion lost precision above JavaScript safe range");
        Check(read.Values[0].Generation == 7 && read.Values[0].BindingRevision == 11 && read.Values[0].SourceTimestamp.HasValue
            && read.Values[0].ReceiptTimestamp.HasValue && read.Values[0].MonotonicReceipt != 0, "generation, provenance and monotonic receipt");
        Check(read.Values[1].Quality == "Bad_NoData" && read.Values[1].Action == SourceValueAction.Clear && read.Values[1].Value is null, "missing selector must clear");
        Check((double)read.Values[2].Value! == 2.5, "array JSON pointer");
        Check(fixture.ReadIds.Single().Single() == opaque && fixture.MaxDepths.All(depth => depth == 1), "opaque ids must never split at # or recurse");
        var beforeRead = fixture.ReadIds.Count;
        var browse = await session.BrowseAsync(new(PageSize: 1, Generation: 4, BindingRevision: 3), default);
        Check(browse.Entries.Count == 1 && fixture.ReadIds.Count == beforeRead && browse.Entries[0].DataType == "Double", "browse uses schemas without reading values");
        Check(fixture.AuthenticatedRequests.Count >= 3 && fixture.AuthenticatedRequests.All(authenticated => !authenticated),
            "non-loopback None authentication tests, browses and reads without sending stored credentials");
        Check(fixture.GetRequests.Count == 3 && fixture.GetRequests.All(request => !request.HasContent)
            && fixture.GetRequests.Select(request => request.Path).Order().SequenceEqual(["info", "objects", "objecttypes"]),
            "info and catalog GET requests have no HTTP content or content headers");
        Check(fixture.IdentifiedRequests.Count >= 4 && fixture.IdentifiedRequests.All(identified => identified),
            "i3X requests identify SparkStudio to services that reject anonymous HTTP clients");
        foreach (var (reason, hint) in new[] {
            (HttpRequestError.NameResolutionError, "DNS"),
            (HttpRequestError.SecureConnectionError, "certificate"),
            (HttpRequestError.ResponseEnded, "closed the connection") })
        {
            using var failedTransport = new I3xFixture { NextTransportFailure = new(reason, "private-request-canary") };
            using var failedHttp = new HttpClient(failedTransport);
            using var failedClient = new SourceI3xClient(new Uri("https://industrial.invalid/v1/"), 1024 * 1024, 2000, failedHttp);
            try { await failedClient.InfoAsync(default); throw new InvalidOperationException("Transport failure was accepted."); }
            catch (HttpRequestException error)
            {
                Check(error.HttpRequestError == reason && error.Message.Contains(hint, StringComparison.Ordinal)
                    && !error.Message.Contains("private-request-canary", StringComparison.Ordinal),
                    "transport failure provides actionable " + reason + " advice without request details");
            }
        }
        using (var bareInfoFixture = new I3xFixture { WrappedInfo = false, AdvertiseStream = true })
        using (var bareInfoHttp = new HttpClient(bareInfoFixture))
        using (var bareInfoClient = new SourceI3xClient(new Uri("http://127.0.0.1/v1/"), 1024 * 1024, 2000, bareInfoHttp))
        {
            var bareInfo = await bareInfoClient.InfoAsync(default);
            Check(bareInfo.SpecVersion == "1.0" && bareInfo.ServerVersion == "fixture-1" && bareInfo.Stream,
                "bare /info preserves the specification's version and advertised stream capability");
        }
        var validInfo = new { specVersion = "1.0", capabilities = new { subscribe = new { stream = true } } };
        foreach (var (reply, description) in new (object Reply, string Description)[] {
            (new { success = false, result = validInfo }, "unsuccessful /info envelope despite valid result"),
            (new { success = "true", result = validInfo }, "non-boolean /info success"),
            (new { result = validInfo }, "/info result without success"),
            (new { success = true }, "/info success without result"),
            (new { success = true, result = (object?)null }, "null /info result"),
            (new { success = true, result = new[] { validInfo } }, "array /info result"),
            (new { success = true, result = new { specVersion = "1.0" } }, "/info result without capabilities"),
            (new { success = false, specVersion = "1.0", capabilities = validInfo.capabilities },
                "unsuccessful /info cannot fall back to bare fields"),
        })
        {
            using var invalidInfoFixture = new I3xFixture { InfoOverride = JsonSerializer.Serialize(reply) };
            using var invalidInfoHttp = new HttpClient(invalidInfoFixture);
            using var invalidInfoClient = new SourceI3xClient(new Uri("http://127.0.0.1/v1/"), 1024 * 1024, 2000, invalidInfoHttp);
            await Reject(() => invalidInfoClient.InfoAsync(default), description);
        }
        var children = await session.BrowseAsync(new("root", Generation: 4, BindingRevision: 3), default);
        Check(children.Entries.Any(entry => entry.Address == "nested" && entry.DataType == "String"), "structured object is a variable independently of composition");
        var selectors = await session.BrowseAsync(new("nested"), default);
        Check(selectors.Entries.Any(entry => entry.Address == "nested" && entry.Selector == "/reading" && entry.DataType == "Int64"), "structured browse keeps address and selector separate");
        var paged = await session.BrowseAsync(new("root", PageSize: 1, Generation: 4, BindingRevision: 3), default);
        Check(paged.ContinuationToken is not null, "bounded local browse pagination");
        var page2 = await session.BrowseAsync(new("root", PageSize: 1, ContinuationToken: paged.ContinuationToken, Generation: 4, BindingRevision: 3), default);
        Check(page2.Entries.Count == 1 && page2.Entries[0].Address != paged.Entries[0].Address, "continuation advances bounded page");
        await Reject(() => session.BrowseAsync(new("root", PageSize: 1, ContinuationToken: paged.ContinuationToken, Generation: 5, BindingRevision: 3), default), "cross-generation browse token");
        await Reject(() => session.BrowseAsync(new(PageSize: 501), default), "oversized browse page");
        using (var json = JsonDocument.Parse("{\"a/b\":{\"~\":2},\"list\":[3]}"))
        {
            Check(SourceI3xClient.Select(json.RootElement, "/a~1b/~0").GetInt32() == 2, "RFC6901 escaped fields");
            Check(SourceI3xClient.Select(json.RootElement, "/list/00").ValueKind == JsonValueKind.Undefined, "noncanonical array index is not accepted");
            await Reject(() => { SourceI3xClient.Select(json.RootElement, "/a~2b"); return Task.CompletedTask; }, "invalid JSON-pointer escape");
        }
        var scalar = new SourcePoint("scalar", "Scalar", "scalar", "Int64");
        foreach (var (quality, value, expected, action) in new (string, object?, string, SourceValueAction)[] {
            ("GoodNoData", null, "Bad_NoData", SourceValueAction.Clear), ("Bad", null, "Bad", SourceValueAction.Clear),
            ("Uncertain", 4L, "Uncertain", SourceValueAction.Replace), ("Good", null, "Bad_DecodingError", SourceValueAction.Retain),
            ("GoodNoData", 4L, "Bad_DecodingError", SourceValueAction.Retain), ("INVALID", 4L, "Bad_DecodingError", SourceValueAction.Retain),
            ("Good", "text", "Bad_TypeMismatch", SourceValueAction.Retain), ("Good", 18446744073709551615UL, "Bad_TypeMismatch", SourceValueAction.Retain),
        })
        {
            fixture.Values["scalar"] = Vqt(value, quality);
            var result = await session.ReadAsync(new([scalar]), default);
            Check(result.Values.Single().Quality == expected && result.Values.Single().Action == action, "quality/value action for " + quality + "/" + value);
        }
        fixture.Values["scalar"] = new { value = 4, quality = "Good", timestamp = "2026-01-01T00:00:00+01:00" };
        Check((await session.ReadAsync(new([scalar]), default)).Values.Single().Quality == "Bad_DecodingError", "non-UTC VQT rejected");
        fixture.Values["scalar"] = Vqt(4);
        fixture.Values["scalar"] = JsonSerializer.Deserialize<JsonElement>("{\"value\":9007199254740993.0,\"quality\":\"Good\",\"timestamp\":\"2026-01-01T00:00:00Z\"}");
        Check((long)(await session.ReadAsync(new([scalar]), default)).Values.Single().Value! == 9007199254740993L, "integral JSON decimals preserve exact Int64");
        fixture.Values["scalar"] = Vqt(4);
        fixture.NextReadOverride = JsonSerializer.Serialize(new { success = true, results = new[] { new { elementId = "other", success = true, result = Vqt(4) } } });
        await Reject(() => session.ReadAsync(new([scalar]), default), "bulk response identity mismatch");
        fixture.NextReadOverride = "{\"success\":true,\"results\":[]}";
        await Reject(() => session.ReadAsync(new([scalar]), default), "bulk response count mismatch");
        fixture.FailedReads.Add("missing-id");
        var partial = await session.ReadAsync(new([scalar, scalar with { Id = "failed", Address = "missing-id" }]), default);
        Check(partial.Values[0].Quality == "Good" && partial.Values[1].Action == SourceValueAction.Retain, "per-item failure does not discard successful bulk sibling");
        var many = Enumerable.Range(0, 501).Select(index => scalar with { Id = "p" + index, Address = "v" + index }).ToArray();
        var before = fixture.ReadIds.Count;
        var manyRead = await session.ReadAsync(new(many), default);
        Check(manyRead.Values.Count == 501 && fixture.ReadIds.Skip(before).Select(ids => ids.Length).SequenceEqual([250, 250, 1]), "user reads batch at most250 ids");
        await Reject(() => session.ReadAsync(new(Enumerable.Range(0, 1001).Select(index => scalar with { Id = "p" + index }).ToArray()), default), "read hard ceiling");

        using var protocol = new SourceI3xClient(new Uri("http://127.0.0.1/v1/"), 1024 * 1024, 2000, http);
        await protocol.DeleteAsync("synthetic-cleanup-client", "synthetic-owned-subscription", default);
        Check(fixture.Deletes == 1 && fixture.ClientIds.Last() == "synthetic-cleanup-client",
            "subscription cleanup confirms the owned identity through POST /subscriptions/delete");
        fixture.SyncReplies.Enqueue((HttpStatusCode.OK, new[] { new I3xFixture.Batch(9223372036854775809UL, [Flat("scalar", 8)]) }));
        var sync = await protocol.SyncAsync("client", "sub", null, default);
        Check(sync.Batches.Single().Sequence == 9223372036854775809UL, "sync unsigned64 sequence aboveInt64");
        fixture.SyncReplies.Enqueue((HttpStatusCode.OK, new[] { new I3xFixture.Batch(ulong.MaxValue, [Flat("scalar", 9)]) }));
        var maximum = await protocol.SyncAsync("client", "sub", sync.Batches[0].Sequence, default);
        Check(maximum.Batches.Single().Sequence == ulong.MaxValue && fixture.SyncAcknowledgments.Last() == "9223372036854775809", "full UInt64 serialization and parse");
        await protocol.SyncAsync("client", "sub", ulong.MaxValue, default);
        Check(fixture.SyncAcknowledgments.Last() == ulong.MaxValue.ToString() && fixture.SyncAcknowledgments.All(ack => ack != "-1"), "ordinary sync never sends clear-all");
        await protocol.SyncAsync("client", "sub", null, default, clearForRecovery: true);
        Check(fixture.SyncAcknowledgments.Last() == "-1", "clear-all requires explicit recovery flag");
        fixture.SyncReplies.Enqueue((HttpStatusCode.PartialContent, new[] { new I3xFixture.Batch(10, [Flat("scalar", 10)]) }));
        Check((await protocol.SyncAsync("client", "sub", null, default)).Overflow, "206 signals subscription loss");
        fixture.NextSyncOverride = "{\"success\":true,\"result\":[{\"sequenceNumber\":-1,\"updates\":[]}]}";
        await Reject(() => protocol.SyncAsync("client", "sub", null, default), "negative sync sequence");
        fixture.NextSyncOverride = "{\"success\":true,\"result\":[{\"sequenceNumber\":1,\"updates\":[]},{\"sequenceNumber\":1,\"updates\":[]}]}";
        await Reject(() => protocol.SyncAsync("client", "sub", null, default), "duplicate sequences inside one envelope");
        using (var stream = new MemoryStream(Encoding.UTF8.GetBytes(": comment\r\ndata: [{\"elementId\":\"scalar\",\n" + "data: \"value\":1,\"quality\":\"Good\",\"timestamp\":\"2026-01-01T00:00:00Z\"}]\n\n")))
        {
            var count = 0;
            await foreach (var payload in SourceI3xClient.ReadEventsAsync(stream, 2048, default))
            { using var parsed = SourceI3xClient.ParseBounded(payload); Check(parsed.RootElement.GetArrayLength() == 1, "bounded multiline SSE data"); count++; }
            Check(count == 1, "exactly one SSE event");
        }
        await Reject(async () => {
            using var stream = new MemoryStream(Encoding.UTF8.GetBytes(":" + new string('x', 2048)));
            await foreach (var _ in SourceI3xClient.ReadEventsAsync(stream, 1024, default)) { }
        }, "oversized SSE comment before string materialization");
        await Reject(async () => {
            using var stream = new MemoryStream(Encoding.UTF8.GetBytes("data: []\n"));
            await foreach (var _ in SourceI3xClient.ReadEventsAsync(stream, 1024, default)) { }
        }, "incomplete SSE event at EOF");
        await Reject(() => { SourceI3xClient.ParseBounded(Encoding.UTF8.GetBytes(new string('[', 65) + "1" + new string(']', 65))); return Task.CompletedTask; }, "deep JSON");
        await Reject(() => { SourceI3xClient.ParseBounded(Encoding.UTF8.GetBytes("[1,2,3,4,5]"), 3); return Task.CompletedTask; }, "decoded-node ceiling");
        using (var largeFixture = new I3xFixture { InfoOverride = new string('x', 2049) })
        using (var largeHttp = new HttpClient(largeFixture))
        using (var small = new SourceI3xClient(new Uri("http://127.0.0.1/v1/"), 1024, 1000, largeHttp))
            await Reject(() => small.InfoAsync(default), "oversized response before JSON materialization");
        using (var browseFailureFixture = new I3xFixture { ObjectsOverride = "{\"success\":false}" })
        using (var browseFailureHttp = new HttpClient(browseFailureFixture))
        await using (var browseFailure = new SourceI3xSession(Connection([]), browseFailureHttp))
        {
            var beforeCatalogBytes = SourceMemoryBudget.Snapshot().GetValueOrDefault("catalog");
            await Reject(() => browseFailure.BrowseAsync(new(), default), "unsuccessful catalog fetch");
            Check(SourceMemoryBudget.Snapshot().GetValueOrDefault("catalog") == beforeCatalogBytes,
                "failed catalog fetch releases its reservation while the session remains alive");
        }
        using (var json = JsonDocument.Parse("{\"missing\":1}"))
            await Reject(() => { SourceI3xClient.Select(default, "/first/late~2"); return Task.CompletedTask; }, "invalid later pointer escape even when earlier field absent");
        using (var limitedFixture = new I3xFixture())
        using (var limitedHttp = new HttpClient(limitedFixture))
        await using (var limited = new SourceI3xSession(Connection([], limits: new(ValueBytes: 8)), limitedHttp))
        {
            limitedFixture.Values["big"] = Vqt(new string('x', 9));
            var limitRead = await limited.ReadAsync(new([new SourcePoint("big", "Big", "big", "String")]), default);
            Check(limitRead.Values.Single().Quality == "Bad_DecodingError" && limitRead.Values.Single().Action == SourceValueAction.Retain,
                "configured scalar byte limit produces retained decoding failure");
        }

        await MonitorChecks(Connection, Check, Reject);
        await PollTelemetryChecks(Connection, Check);
        await TransportRecoveryChecks(Connection, Check);
        return passed;
    }

    private static async Task TransportRecoveryChecks(Func<SourcePoint[], string, SourceI3xSettings?, SourceLimits?, ConnectionDefinition> connection,
        Action<bool, string> check)
    {
        var point = new SourcePoint("value", "Value", "sensor", "Int64");
        using var fixture = new I3xFixture { NextTransportFailure = new(HttpRequestError.ResponseEnded, "private-request-canary") };
        fixture.Values["sensor"] = Vqt(42L);
        using var http = new HttpClient(fixture) { Timeout = Timeout.InfiniteTimeSpan };
        await using var session = new SourceI3xSession(connection([point], "poll", null, null), http);
        var sink = new I3xSink();
        await using var monitor = await session.StartMonitoringAsync(new(13, new(1, [point])), sink, default);
        await Until(() => Equals(sink.Latest("value")?.Value, 42L), "transport outage recovery", 8000);
        check(sink.Statuses.Any(status => status.State == "degraded")
            && sink.Statuses.All(status => status.State != "faulted")
            && sink.Latest("value")?.Quality == "Good",
            "an interrupted HTTP response retries acquisition and restores current Good values");
    }

    private static async Task MonitorChecks(Func<SourcePoint[], string, SourceI3xSettings?, SourceLimits?, ConnectionDefinition> connection,
        Action<bool, string> check, Func<Func<Task>, string, Task> reject)
    {
        var point = new SourcePoint("value", "Value", "sensor", "Int64");
        using var fixture = new I3xFixture();
        fixture.Values["sensor"] = Vqt(1L);
        using var http = new HttpClient(fixture) { Timeout = Timeout.InfiniteTimeSpan };
        await using var session = new SourceI3xSession(connection([point], "subscribe", null, null), http);
        var sink = new I3xSink();
        await using var monitor = await session.StartMonitoringAsync(new(10, new(1, [point])), sink, default);
        await Until(() => sink.Latest("value")?.Quality == "Good", "initial sync seed");
        check(fixture.Creates == 1 && fixture.Registered.All(id => id == "sensor") && fixture.ClientIds.All(id => id == "persistent-synthetic-client"), "subscription owner and persisted clientId");
        check((await session.TestAsync(default)).Success, "Test is admitted while lifetime acquisition is active");
        fixture.SyncReplies.Enqueue((HttpStatusCode.OK, new[] { new I3xFixture.Batch(9223372036854775809UL, [Flat("sensor", 2L)]) }));
        await Until(() => Equals(sink.Latest("value")?.Value, 2L), "sync delivery");
        fixture.SyncReplies.Enqueue((HttpStatusCode.OK, new[] { new I3xFixture.Batch(9223372036854775809UL, [Flat("sensor", 0L)]), new I3xFixture.Batch(9223372036854775810UL, [Flat("sensor", 3L)]) }));
        await Until(() => Equals(sink.Latest("value")?.Value, 3L), "duplicate suppression");
        check(!sink.Values.Any(value => Equals(value.Value, 0L)), "duplicate older batch cannot regress accepted state");
        await Until(() => fixture.SyncAcknowledgments.Contains("9223372036854775810"), "following-call accepted ack");
        check(fixture.SyncAcknowledgments.Contains("9223372036854775809"), "UInt64 acknowledgment survives monitor state machine");
        var beforeExpiry = fixture.Creates;
        fixture.NextSyncStatus = HttpStatusCode.NotFound;
        fixture.Values["sensor"] = Vqt(6L);
        await Until(() => fixture.Creates > beforeExpiry && Equals(sink.Latest("value")?.Value, 6L), "expired subscription 404 recovery", 8000);
        check(sink.Statuses.Any(status => status.NativeStatus == "NotFound" && status.Reason == "recovery"), "404 subscription expiry is observed and reseeded");
        var creates = fixture.Creates;
        fixture.Values["sensor"] = Vqt(7L);
        fixture.SyncReplies.Enqueue((HttpStatusCode.PartialContent, new[] { new I3xFixture.Batch(9223372036854775811UL, [Flat("sensor", 99L)]) }));
        await Until(() => fixture.Creates > creates && Equals(sink.Latest("value")?.Value, 7L), "206 recovery seed", 8000);
        check(!sink.Values.Any(value => Equals(value.Value, 99L)) && sink.Statuses.Any(status => status.LostUpdates > 0), "overflow batch is fenced and loss is visible");
        check(fixture.SyncAcknowledgments.Last() == "omitted", "replacement subscription resets acknowledgment watermark");
        var revised = point with { Id = "replacement" };
        await monitor.UpdateBindingsAsync(new(2, [revised]), default);
        await Until(() => sink.Latest("replacement")?.BindingRevision == 2, "hot binding seed");
        check(sink.Latest("replacement")?.Generation == 10 && fixture.Deletes >= 2, "binding revision cleanup with stable connection generation");
        var writes = sink.Values.Count(value => value.PointId == "value");
        fixture.SyncReplies.Enqueue((HttpStatusCode.OK, new[] { new I3xFixture.Batch(1, [Flat("sensor", 8L)]) }));
        await Until(() => Equals(sink.Latest("replacement")?.Value, 8L), "new binding update");
        check(sink.Values.Count(value => value.PointId == "value") == writes, "removed binding receives zero late updates");
        fixture.FailNextRegistration = true;
        await reject(() => monitor.UpdateBindingsAsync(new(3, [revised with { Address = "new-sensor" }]), default), "partial register failure");
        fixture.SyncReplies.Enqueue((HttpStatusCode.OK, new[] { new I3xFixture.Batch(1, [Flat("sensor", 9L)]) }));
        await Until(() => Equals(sink.Latest("replacement")?.Value, 9L), "previous interest compensation");
        check(sink.Latest("replacement")?.BindingRevision == 2 && sink.Statuses.Any(status => status.Reason == "binding-compensation"), "failed candidate preserves previous local/remote complete revision");
        var goodBeforeUnavailable = sink.Values.Count(value => value.Quality == "Good" && value.BindingRevision == 3);
        fixture.NextReadStatus = HttpStatusCode.ServiceUnavailable;
        await reject(() => monitor.UpdateBindingsAsync(new(3, [revised with { Id = "outage-candidate" }]), default), "unavailable authoritative seed during binding update");
        check(sink.Values.All(value => value.PointId != "outage-candidate")
            && sink.Values.Count(value => value.Quality == "Good" && value.BindingRevision == 3) == goodBeforeUnavailable,
            "binding updates cannot relabel cached Good values after an unavailable current read");
        await monitor.DisposeAsync();
        var stopped = sink.Values.Count;
        check(fixture.Deletes >= fixture.Creates - 1 && fixture.ActiveStreams == 0, "disable releases local delivery and remote subscription best effort");
        check(sink.Values.Count == stopped, "stopped monitor cannot apply values");

        using var raceFixture = new I3xFixture { AdvertiseStream = true,
            ReadStarted = new(TaskCreationOptions.RunContinuationsAsynchronously), ReadRelease = new(TaskCreationOptions.RunContinuationsAsynchronously) };
        raceFixture.Values["sensor"] = Vqt(19L);
        using var raceHttp = new HttpClient(raceFixture) { Timeout = Timeout.InfiniteTimeSpan };
        await using var raceSession = new SourceI3xSession(connection([point], "subscribe", new(PreferStream: true, ReconciliationSeconds: 5, ClientId: "race-client"), new(RequestTimeoutMs: 5000)), raceHttp);
        var raceSink = new I3xSink();
        await using var raceMonitor = await raceSession.StartMonitoringAsync(new(1, new(1, [point])), raceSink, default);
        await raceFixture.ReadStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await Until(() => raceFixture.CurrentStream is not null, "seed candidate receiver");
        await raceFixture.CurrentStream!.SendAsync([Flat("sensor", 99L)]);
        await Until(() => raceFixture.CurrentStream.ConsumedEvents > 0, "delivery during seed");
        raceFixture.ReadRelease.TrySetResult();
        await Until(() => Equals(raceSink.Latest("value")?.Value, 19L), "authoritative seed after racing event");
        check(!raceSink.Values.Any(value => Equals(value.Value, 99L)) && raceSink.Statuses.Any(status => status.LostUpdates > 0),
            "events arriving during current read are discarded and counted before seed commit");
        await raceFixture.CurrentStream.SendAsync([Flat("sensor", 20L)]);
        await Until(() => Equals(raceSink.Latest("value")?.Value, 20L), "post-seed arrival");
        check(raceSink.Latest("value")?.Quality == "Good", "post-commit current-generation arrivals resume");
        await raceMonitor.DisposeAsync();

        using var streamFixture = new I3xFixture { AdvertiseStream = true };
        streamFixture.Values["sensor"] = Vqt(11L);
        using var streamHttp = new HttpClient(streamFixture) { Timeout = Timeout.InfiniteTimeSpan };
        await using var streamSession = new SourceI3xSession(connection([point], "subscribe", new(PreferStream: true, ReconciliationSeconds: 5, ClientId: "stream-client"), null), streamHttp);
        var streamSink = new I3xSink();
        await using var streamMonitor = await streamSession.StartMonitoringAsync(new(2, new(1, [point])), streamSink, default);
        await Until(() => streamFixture.ActiveStreams == 1 && streamSink.Latest("value")?.Quality == "Good", "SSE initialization");
        var currentStream = streamFixture.CurrentStream!;
        await currentStream.SendAsync([Flat("sensor", 12L)]);
        await Until(() => Equals(streamSink.Latest("value")?.Value, 12L), "SSE update");
        streamFixture.Values["sensor"] = Vqt(13L);
        currentStream.Complete();
        await Until(() => streamFixture.Creates >= 2 && Equals(streamSink.Latest("value")?.Value, 13L), "ordinary SSE close recovery", 8000);
        check(streamSink.Statuses.Any(status => status.Reason == "recovery") && streamFixture.ActiveStreams == 1,
            "ordinary stream loss recreates current seed even without404");
        // A healthy but silent SSE must still reconcile, and /info health is not used as a delivery substitute.
        streamFixture.Values["sensor"] = Vqt(14L);
        await Until(() => Equals(streamSink.Latest("value")?.Value, 14L), "silent-stream authoritative watchdog", 7000);
        check(streamSink.Statuses.Any(status => status.Reason == "periodic-reconcile"), "quiet/half-open stream receives bounded current reconciliation");
        streamFixture.NextReadStatus = HttpStatusCode.ServiceUnavailable;
        await Until(() => streamSink.Values.Any(value => value.Quality == "Bad_CommunicationError"), "failed current read with reachableinfo", 7000);
        check((await streamSession.TestAsync(default)).Success && streamSink.Values.Any(value => value.Quality == "Bad_CommunicationError" && value.Action == SourceValueAction.Retain),
            "reachable /info cannot mask failed delivery/current state");
        await streamMonitor.DisposeAsync();
        check(streamFixture.ActiveStreams == 0 && streamFixture.SyncDuringStream == 0, "SSE cancellation releases response before cleanup");

        using var fallback = new I3xFixture { AdvertiseStream = true, RejectStream501 = true };
        using var fallbackHttp = new HttpClient(fallback) { Timeout = Timeout.InfiniteTimeSpan };
        await using var fallbackSession = new SourceI3xSession(connection([], "subscribe", new(PreferStream: true, ReconciliationSeconds: 5, ClientId: "empty-client"), null), fallbackHttp);
        var fallbackSink = new I3xSink();
        await using var fallbackMonitor = await fallbackSession.StartMonitoringAsync(new(1, new(1, [])), fallbackSink, default);
        await Until(() => fallback.SyncCalls > 0, "zero-point stream501 fallback");
        check(fallback.Creates == 1 && fallbackSink.Statuses.Any(status => status.Reason == "stream-501") && fallback.SyncDuringStream == 0,
            "zero-point connection owns one transport and closes optional stream before mandatory sync");
    }

    private static object Vqt(object? value, string quality = "Good") => new { value, quality, timestamp = "2026-01-01T00:00:00Z" };
    private static async Task PollTelemetryChecks(Func<SourcePoint[], string, SourceI3xSettings?, SourceLimits?, ConnectionDefinition> connection,
        Action<bool, string> check)
    {
        var point = new SourcePoint("value", "Value", "sensor", "Int64");
        using var fixture = new I3xFixture();
        fixture.Values["sensor"] = Vqt(1L);
        using var http = new HttpClient(fixture) { Timeout = Timeout.InfiniteTimeSpan };
        await using var session = new SourceI3xSession(connection([point], "poll", null, null), http);
        await session.BrowseAsync(new(), default);
        var sink = new I3xSink();
        await using var monitor = await session.StartMonitoringAsync(new(12, new(1, [point])), sink, default);
        await Until(() => sink.Statuses.Any(status => status.State == "connected"), "poll telemetry initial current read");
        var first = sink.Statuses.Last().Diagnostics!;
        fixture.Values["sensor"] = Vqt(2L);
        await Until(() => Equals(sink.Latest("value")?.Value, 2L)
            && sink.Statuses.Any(status => status.Diagnostics?.GetValueOrDefault("inputBytes") is long bytes && bytes > (long)first["inputBytes"]!),
            "poll telemetry subsequent current read");
        var metrics = sink.Statuses.Last().Diagnostics!;
        check(metrics["inputBytes"] is long input && input > (long)first["inputBytes"]! && metrics["inputBytesPerSecond"] is double rate && rate > 0,
            "poll-only HTTP bodies contribute increasing input bytes and owner-mean rate with an injected client");
        check(metrics["lastTransportActivityAt"] is DateTimeOffset activity && activity > (DateTimeOffset)first["lastTransportActivityAt"]!,
            "poll transport activity advances independently of the old source timestamp");
        check((string)metrics["mode"]! == "poll" && (int)metrics["catalogCount"]! == 3 && (long)metrics["catalogBytes"]! > 0
            && (long)metrics["reconnectAttempts"]! == 0 && metrics.ContainsKey("effectiveLimits"),
            "poll diagnostics carry mode, populated catalog usage, retry attempts and effective limits");
        check(sink.Statuses.All(status => status.Diagnostics is { } details && details.ContainsKey("inputBytes") && details.ContainsKey("lastTransportActivityAt")),
            "every i3X polling status merges transport telemetry");
    }
    private static object Flat(string elementId, object? value) => new { elementId, value, quality = "Good", timestamp = "2026-01-01T00:00:00Z" };
    private static async Task Until(Func<bool> ready, string description, int timeout = 6000)
    {
        using var limit = new CancellationTokenSource(timeout);
        while (!ready()) { try { await Task.Delay(10, limit.Token); } catch (OperationCanceledException) { throw new TimeoutException("i3X fixture timed out: " + description); } }
    }
    private sealed class I3xSink : ISourceSink
    {
        public ConcurrentQueue<SourceValue> Values { get; } = new();
        public ConcurrentQueue<SourceStatus> Statuses { get; } = new();
        public SourceValue? Latest(string id) => Values.LastOrDefault(value => value.PointId == id);
        public void OnValues(IReadOnlyList<SourceValue> values) { foreach (var value in values) Values.Enqueue(value); }
        public void OnStatus(SourceStatus status) => Statuses.Enqueue(status);
        public void OnDiscovery(SourceDiscoveryBatch discovery) { }
    }
    // Synthetic server behavior, authored for these tests; no copied live server payloads.
    private sealed class I3xFixture : HttpMessageHandler
    {
        internal sealed record Batch(ulong sequenceNumber, object[] updates);
        public ConcurrentDictionary<string, object> Values { get; } = new();
        public HashSet<string> FailedReads { get; } = new();
        public ConcurrentQueue<string[]> ReadIds { get; } = new();
        public ConcurrentQueue<bool> AuthenticatedRequests { get; } = new();
        public ConcurrentQueue<bool> IdentifiedRequests { get; } = new();
        public ConcurrentQueue<(string Path, bool HasContent)> GetRequests { get; } = new();
        public ConcurrentQueue<int> MaxDepths { get; } = new();
        public ConcurrentQueue<string> ClientIds { get; } = new();
        public ConcurrentQueue<string> Registered { get; } = new();
        public ConcurrentQueue<string> SyncAcknowledgments { get; } = new();
        public ConcurrentQueue<(HttpStatusCode Status, Batch[] Batches)> SyncReplies { get; } = new();
        public string? NextReadOverride;
        public string? NextSyncOverride;
        public string? InfoOverride;
        public HttpRequestException? NextTransportFailure;
        public string? ObjectsOverride;
        public HttpStatusCode? NextReadStatus;
        public HttpStatusCode? NextSyncStatus;
        public bool AdvertiseStream;
        public bool WrappedInfo = true;
        public bool RejectStream501;
        public bool FailNextRegistration;
        public int Creates;
        public int Deletes;
        public int SyncCalls;
        public int ActiveStreams;
        public int SyncDuringStream;
        public I3xSseStream? CurrentStream;
        public TaskCompletionSource? ReadStarted;
        public TaskCompletionSource? ReadRelease;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
        {
            if (Interlocked.Exchange(ref NextTransportFailure, null) is { } failure) throw failure;
            AuthenticatedRequests.Enqueue(request.Headers.Authorization is not null || request.Headers.Contains("X-API-Key"));
            IdentifiedRequests.Enqueue(request.Headers.UserAgent.ToString() == "SparkStudio/1.0");
            var path = request.RequestUri!.AbsolutePath[4..];
            if (request.Method == HttpMethod.Get) GetRequests.Enqueue((path, request.Content is not null));
            if (path is "info" or "objecttypes" or "objects"
                && (request.Method != HttpMethod.Get || request.Content is not null))
                return Json(new { success = false }, HttpStatusCode.BadRequest);
            var text = request.Content is null ? "{}" : await request.Content.ReadAsStringAsync(cancellation);
            using var document = JsonDocument.Parse(string.IsNullOrEmpty(text) ? "{}" : text);
            var body = document.RootElement;
            if (body.TryGetProperty("clientId", out var identity)) ClientIds.Enqueue(identity.GetString()!);
            switch (path)
            {
                case "info":
                    var info = new { specVersion = "1.0", serverVersion = "fixture-1", capabilities = new { subscribe = new { stream = AdvertiseStream } } };
                    return InfoOverride is not null ? Raw(InfoOverride) : WrappedInfo ? Json(new { success = true, result = info }) : Json(info);
                case "objecttypes": return Json(new { success = true, result = new object[] {
                    new { elementId = "number", schema = new { type = "number" } },
                    new { elementId = "structure", schema = new { type = "object", properties = new { reading = new { type = "integer" } } } }, } });
                case "objects": return ObjectsOverride is not null ? Raw(ObjectsOverride) : Json(new { success = true, result = new object[] {
                    new { elementId = "root", displayName = "Root", parentId = "", typeElementId = "number", isComposition = false },
                    new { elementId = "nested", displayName = "Nested", parentId = "root", typeElementId = "structure", isComposition = false },
                    new { elementId = "child", displayName = "Child", parentId = "root", typeElementId = "number", isComposition = false }, } });
                case "objects/value":
                    var ids = body.GetProperty("elementIds").EnumerateArray().Select(id => id.GetString()!).ToArray();
                    ReadIds.Enqueue(ids); MaxDepths.Enqueue(body.GetProperty("maxDepth").GetInt32());
                    if (NextReadStatus is { } readStatus) { NextReadStatus = null; return Json(new { success = false }, readStatus); }
                    if (Interlocked.Exchange(ref NextReadOverride, null) is { } overrideRead) return Raw(overrideRead);
                    var results = ids.Select(id => new { elementId = id, success = !FailedReads.Contains(id), result = Values.GetValueOrDefault(id, Vqt(1L)) }).ToArray();
                    if (ReadStarted is not null && ReadRelease is not null) { ReadStarted.TrySetResult(); await ReadRelease.Task.WaitAsync(cancellation); }
                    return Json(new { success = ids.All(id => !FailedReads.Contains(id)), results });
                case "subscriptions" when request.Method == HttpMethod.Post:
                    return Json(new { success = true, result = new { subscriptionId = "fixture-sub-" + Interlocked.Increment(ref Creates) } });
                case "subscriptions/delete" when request.Method == HttpMethod.Post:
                    Interlocked.Increment(ref Deletes);
                    return Json(new { success = true, results = body.GetProperty("subscriptionIds").EnumerateArray().Select(id => new { subscriptionId = id.GetString(), success = true, result = (object?)null }).ToArray() });
                case "subscriptions/register":
                    var register = body.GetProperty("elementIds").EnumerateArray().Select(id => id.GetString()!).ToArray();
                    foreach (var id in register) Registered.Enqueue(id);
                    var fail = FailNextRegistration; FailNextRegistration = false;
                    return Json(new { success = !fail, results = register.Select(id => new { elementId = id, success = !fail, result = (object?)null }).ToArray() });
                case "subscriptions/sync":
                    Interlocked.Increment(ref SyncCalls);
                    if (Volatile.Read(ref ActiveStreams) > 0) Interlocked.Increment(ref SyncDuringStream);
                    SyncAcknowledgments.Enqueue(body.TryGetProperty("lastSequenceNumber", out var acknowledgment) ? acknowledgment.GetRawText() : "omitted");
                    if (NextSyncStatus is { } syncStatus) { NextSyncStatus = null; return Json(new { success = false }, syncStatus); }
                    if (Interlocked.Exchange(ref NextSyncOverride, null) is { } overrideSync) return Raw(overrideSync);
                    if (SyncReplies.TryDequeue(out var queued)) return Json(new { success = true, result = queued.Batches }, queued.Status);
                    return Json(new { success = true, result = Array.Empty<object>() });
                case "subscriptions/stream":
                    if (RejectStream501) return Json(new { success = false }, HttpStatusCode.NotImplemented);
                    Interlocked.Increment(ref ActiveStreams);
                    CurrentStream = new(() => Interlocked.Decrement(ref ActiveStreams));
                    var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(CurrentStream) };
                    response.Content.Headers.ContentType = new("text/event-stream");
                    return response;
                default: return Json(new { success = false }, HttpStatusCode.NotFound);
            }
        }
        private static HttpResponseMessage Json(object value, HttpStatusCode status = HttpStatusCode.OK) => Raw(JsonSerializer.Serialize(value), status);
        private static HttpResponseMessage Raw(string value, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(value, Encoding.UTF8, "application/json") };
    }
    private sealed class I3xSseStream(Action onDispose) : Stream
    {
        private readonly Channel<byte[]> messages = Channel.CreateBounded<byte[]>(16);
        private byte[]? current;
        private int position;
        private int closed;
        public int ConsumedEvents;
        public Task SendAsync(object[] updates) => messages.Writer.WriteAsync(Encoding.UTF8.GetBytes("data: " + JsonSerializer.Serialize(updates) + "\n\n")).AsTask();
        public void Complete() => messages.Writer.TryComplete();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellation = default)
        {
            if (current is null || position == current.Length)
            {
                if (!await messages.Reader.WaitToReadAsync(cancellation)) return 0;
                current = await messages.Reader.ReadAsync(cancellation); position = 0; Interlocked.Increment(ref ConsumedEvents);
            }
            var size = Math.Min(buffer.Length, current.Length - position);
            current.AsMemory(position, size).CopyTo(buffer); position += size; return size;
        }
        protected override void Dispose(bool disposing) { if (Interlocked.Exchange(ref closed, 1) == 0) { Complete(); onDispose(); } base.Dispose(disposing); }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
