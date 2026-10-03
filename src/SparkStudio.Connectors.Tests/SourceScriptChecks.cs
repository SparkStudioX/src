using System.Diagnostics;
using System.Text;
using SparkStudio.Connectors;

internal static class SourceScriptChecks
{
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool value, string message) { if (!value) throw new InvalidOperationException(message); passed++; }
        void Reject(Action action, string message) { try { action(); } catch (Exception error) when (error is InvalidDataException or DecoderFallbackException) { passed++; return; } throw new InvalidOperationException(message); }
        Check((long)SourceScriptProtocol.DecodeScalar("9007199254740993"u8, 65536)! == 9007199254740993L, "Scalar Int64 exactness");
        Check((bool)SourceScriptProtocol.DecodeScalar("true"u8, 65536)!, "Scalar Boolean");
        Check((string)SourceScriptProtocol.DecodeScalar("\"hello\""u8, 65536)! == "hello", "JSON string unwrapped");
        Check((string)SourceScriptProtocol.DecodeScalar("hello"u8, 65536)! == "hello", "Raw scalar text preserved");
        Reject(() => SourceScriptProtocol.DecodeScalar("9223372036854775808"u8, 65536), "Integer overflow cannot silently become Double");
        Reject(() => SourceScriptProtocol.DecodeScalar("NaN"u8, 65536), "Nonfinite scalar rejected");
        Reject(() => SourceScriptProtocol.DecodeScalar("{}"u8, 65536), "Structured scalar rejected");
        Reject(() => SourceScriptProtocol.DecodeScalar(new byte[] { 0xFF }, 65536), "Invalid UTF8 rejected");
        Reject(() => SourceScriptProtocol.Coerce(9007199254740993L, "Double"), "Lossy Int64 to Double conversion rejected");
        Reject(() => SourceScriptProtocol.Coerce(16777217L, "Float"), "Lossy integer to Float conversion rejected");
        Check(SourceScriptProtocol.Coerce(1.1d, "Float") is float && (string)SourceScriptProtocol.Coerce(9007199254740993L, "String") == "9007199254740993", "Declared scalar types preserve integer strings and finite Float conversion");
        await using var host = new SourceScriptHost();
        try { using var startup = new CancellationTokenSource(TimeSpan.FromSeconds(5)); await host.WarmAsync(startup.Token); }
        catch (PlatformNotSupportedException error) when (OperatingSystem.IsLinux())
        { Check(error.Message.Contains("cgroup", StringComparison.OrdinalIgnoreCase), "Linux fails closed without delegated memory boundary"); return passed; }
        SourceScriptRequest Request(string payload, string script) => new(payload, "factory/a", false, "2026-10-01T12:00:00.0000000+00:00", script);
        async Task RejectDuringCooldown(SourceScriptHost failedHost, string description) {
            await Task.Delay(200);
            var remaining = failedHost.WorkerCooldownRemainingMs; var starts = failedHost.WorkerStarts; var clock = Stopwatch.StartNew();
            for (var attempt = 0; attempt < 3; attempt++) {
                try { await failedHost.EvaluateAsync(Request("", "42"), 100, CancellationToken.None); throw new InvalidOperationException("Premature worker replacement: " + description); }
                catch (SourceScriptHost.WorkerCooldownException) { }
            }
            Check(remaining > 0 && failedHost.WorkerStarts == starts && clock.Elapsed < TimeSpan.FromMilliseconds(500)
                && failedHost.WorkerCooldownRemainingMs <= remaining, description + " rejects repeated inputs without spawning, waiting or extending cooldown");
        }
        async Task WaitForReplacement(SourceScriptHost failedHost) => await Task.Delay(failedHost.WorkerCooldownRemainingMs + 25);
        async Task WaitForReady(SourceScriptHost failedHost) {
            var clock = Stopwatch.StartNew();
            while (!failedHost.WorkerReady) { if (clock.Elapsed > TimeSpan.FromSeconds(5)) throw new TimeoutException("Background worker replacement did not become ready."); await Task.Delay(10); }
        }
        var typed = await host.EvaluateAsync(Request("{\"value\":9007199254740993}", "(json payload).value"), 100, CancellationToken.None);
        Check(typed.Success && typed.Result!.Value.GetInt64() == 9007199254740993L, "Typed Evaluate preserves integer rather than rendering text");
        var missing = await host.EvaluateAsync(Request("{}", "(json payload).missing"), 100, CancellationToken.None);
        Check(!missing.Success, "Missing member is an extraction error with strict member access");
        var index = await host.EvaluateAsync(Request("[]", "(json payload)[3]"), 100, CancellationToken.None);
        Check(!index.Success, "Missing array index is an extraction error");
        var intentional = await host.EvaluateAsync(Request("{}", "null"), 100, CancellationToken.None);
        Check(intentional.Success && intentional.Skip && intentional.Result is null, "Intentional null result preserved as skip");
        var skippedMetadata = await host.EvaluateAsync(Request("{}", "null") with { TimestampExpression = "missing_variable" }, 100, CancellationToken.None);
        Check(skippedMetadata.Success && skippedMetadata.Skip, "Whole null skips metadata expressions and acceptance state");
        var xml = await host.EvaluateAsync(Request("<root><value>12.5</value></root>", "xml.xpath payload \"/root/value\" | string.to_double"), 100, CancellationToken.None);
        Check(xml.Success && xml.Result!.Value.GetDouble() == 12.5, "Bounded XML XPath helper returns typed numeric expression");
        var dtd = await host.EvaluateAsync(Request("<!DOCTYPE root [<!ENTITY ext SYSTEM 'file:///nonexistent'>]><root>&ext;</root>", "xml.xpath payload \"/root\""), 100, CancellationToken.None);
        Check(!dtd.Success, "DTD/external entity expansion prohibited");
        var include = await host.EvaluateAsync(Request("", "include \"missing\""), 100, CancellationToken.None);
        Check(!include.Success, "Include/filesystem loading unavailable");
        var globals = await host.EvaluateAsync(Request("", "levels[1] == \"a\" && retained == false"), 100, CancellationToken.None);
        Check(globals.Success && globals.Result!.Value.GetBoolean(), "Documented globals available");
        var numericString = await host.EvaluateAsync(Request("{\"t\":\"bad\"}", "(json payload).t") with { TimestampExpression = "(json payload).t" }, 100, CancellationToken.None);
        Check(!numericString.Success, "Invalid timestamp fails visibly rather than falling back to receipt");
        var depth = await host.EvaluateAsync(Request("", "[[[[1]]]]") with { ResultDepth = 2 }, 100, CancellationToken.None);
        Check(!depth.Success, "Result traversal checks returned object depth independently of rendering");
        var many = await host.EvaluateAsync(Request("", "[1,2,3]") with { ResultLeaves = 2 }, 100, CancellationToken.None);
        Check(!many.Success, "Result leaf count checked before return");
        var started = Stopwatch.StartNew();
        var timeout = false;
        try { await host.EvaluateAsync(Request("", "x = []; for i in 1..10000; x = x + x + [i]; end; 1"), 100, CancellationToken.None); }
        catch (Exception error) when (error is TimeoutException or IOException or InvalidDataException or OperationCanceledException) { timeout = true; }
        Check(started.Elapsed < TimeSpan.FromSeconds(2), "Expanding intermediate/tiny final result remains bounded by process/deadline");
        // The worker may reject expansion by its own string/loop guard before the OS kills it;
        // either outcome is safe. Force a one-millisecond admission/deadline kill separately.
        await using (var hanging = SourceScriptHost.ForFixture("--fixture-hang"))
        {
            using var startup = new CancellationTokenSource(TimeSpan.FromSeconds(5)); await hanging.WarmAsync(startup.Token);
            var clock = Stopwatch.StartNew();
            Check(hanging.EnforcedProcessLimitBytes == SourceScriptHost.ProcessBytes, "OS reports the configured 256 MiB process cap");
            try { await hanging.EvaluateAsync(Request("", "1"), 100, CancellationToken.None); }
            catch (TimeoutException) { timeout = true; }
            Check(clock.Elapsed < TimeSpan.FromSeconds(2), "Uncooperative host work is killed within bounded cleanup");
            await RejectDuringCooldown(hanging, "Timed-out worker");
            hanging.EndFixtureMode();
            await WaitForReady(hanging);
            var replaced = await hanging.EvaluateAsync(Request("", "42"), 100, CancellationToken.None);
            Check(replaced.Success && replaced.Result!.Value.GetInt32() == 42, "Killed worker is replaced before normal extraction resumes");
            Check(hanging.WorkerStarts == 2, "Timeout permits exactly one successful replacement after cooldown");
            await hanging.EvaluateAsync(Request("", "43"), 100, CancellationToken.None);
            Check(hanging.WorkerStarts == 2, "Healthy worker reuse does not restart or incur cooldown");
        }
        await using (var allocating = SourceScriptHost.ForFixture("--fixture-memory"))
        {
            using var startup = new CancellationTokenSource(TimeSpan.FromSeconds(5)); await allocating.WarmAsync(startup.Token);
            var failed = false;
            try { await allocating.EvaluateAsync(Request("", "1"), 100, CancellationToken.None); }
            catch (Exception error) when (error is TimeoutException or IOException or InvalidDataException or OperationCanceledException) { failed = true; }
            Check(failed, "OS-capped worker cannot return a tiny result after unbounded intermediate allocation");
            var peaks = allocating.PeakMemory;
            Console.WriteLine("Source worker allocation peaks: " + System.Text.Json.JsonSerializer.Serialize(peaks));
            Check(peaks.Samples > 0 && peaks.WorkingSetBytes > 0 && peaks.PrivateBytes > 0, "Worker RSS and private commit peaks are measured during allocation and cleanup");
            if (OperatingSystem.IsWindows()) Check(peaks.JobProcessCommitBytes > 0 && peaks.JobProcessCommitBytes <= SourceScriptHost.ProcessBytes
                && peaks.JobCommitBytes <= SourceScriptHost.ProcessBytes, "Windows Job peak commit remains inside the enforced process/aggregate cap");
        }
        var beforeOomWorkers = SourceMemoryBudget.Snapshot().GetValueOrDefault("workers");
        await using (var oom = SourceScriptHost.ForFixture("--fixture-oom")) {
            using var startup = new CancellationTokenSource(TimeSpan.FromSeconds(5)); await oom.WarmAsync(startup.Token);
            var failed = false;
            try { await oom.EvaluateAsync(Request("", "1"), 100, CancellationToken.None); }
            catch (Exception error) when (error is IOException or InvalidDataException) { failed = true; }
            Check(failed && SourceMemoryBudget.Snapshot().GetValueOrDefault("workers") == beforeOomWorkers,
                "Over-cap allocation terminates the worker and releases its process reservation");
            await RejectDuringCooldown(oom, "OOM worker");
            oom.EndFixtureMode(); await WaitForReplacement(oom); await oom.WarmAsync(startup.Token);
            var recovered = await oom.EvaluateAsync(Request("", "42"), 100, CancellationToken.None);
            Check(recovered.Success && recovered.Result!.Value.GetInt32() == 42 && oom.WorkerStarts == 2, "OOM replacement succeeds only after its monotonic cooldown");
        }
        Check(SourceMemoryBudget.Snapshot().GetValueOrDefault("workers") == beforeOomWorkers, "Recovered OOM worker cleanup returns its aggregate memory lease");
        var beforePreparing = SourceMemoryBudget.Snapshot().GetValueOrDefault("workers");
        await using (var preparing = SourceScriptHost.ForFixture("--fixture-hang")) {
            await preparing.WarmAsync(CancellationToken.None);
            try { await preparing.EvaluateAsync(Request("", "1"), 100, CancellationToken.None); }
            catch (TimeoutException) { }
            preparing.BlockFixtureReplacementStartup();
            // The replacement is already waiting on the original deadline.
            // Renew it to deterministically exercise a timer waking too early.
            await Task.Delay(200);
            preparing.RenewFixtureReplacementCooldown();
            var replacementClock = Stopwatch.StartNew();
            while (preparing.WorkerStarts < 2) { if (replacementClock.Elapsed > TimeSpan.FromSeconds(3)) throw new TimeoutException("Replacement startup was not admitted."); await Task.Delay(10); }
            var immediate = Stopwatch.StartNew(); var rejected = false;
            try { await preparing.EvaluateAsync(Request("", "42"), 100, CancellationToken.None); }
            catch (SourceScriptHost.WorkerPreparingException) { rejected = true; }
            Check(rejected && immediate.Elapsed < TimeSpan.FromMilliseconds(100), "Inputs reject immediately during bounded background preparation");
            var cleanup = Stopwatch.StartNew(); await preparing.DisposeAsync();
            Check(cleanup.Elapsed < TimeSpan.FromSeconds(2) && SourceMemoryBudget.Snapshot().GetValueOrDefault("workers") == beforePreparing,
                "Canceling a blocked replacement handshake releases its process and memory lease within two seconds");
            await Task.Delay(1100);
            Check(preparing.WorkerStarts == 2 && !preparing.WorkerReady, "Disposed replacement task cannot restart after its cancellation deadline");
        }
        var originalWorker = Environment.GetEnvironmentVariable("SPARKSTUDIO_SOURCE_WORKER");
        await using (var failedStart = new SourceScriptHost()) {
            try {
                Environment.SetEnvironmentVariable("SPARKSTUDIO_SOURCE_WORKER", Path.Combine(Path.GetTempPath(), "spark-missing-worker-" + Guid.NewGuid().ToString("N")));
                try { await failedStart.WarmAsync(CancellationToken.None); throw new InvalidOperationException("Missing worker started."); }
                catch (FileNotFoundException) { Check(failedStart.WorkerStarts == 0, "Failed startup never spawns a worker"); }
            }
            finally { Environment.SetEnvironmentVariable("SPARKSTUDIO_SOURCE_WORKER", originalWorker); }
            await RejectDuringCooldown(failedStart, "Failed startup");
            await WaitForReplacement(failedStart); await failedStart.WarmAsync(CancellationToken.None);
            Check((await failedStart.EvaluateAsync(Request("", "42"), 100, CancellationToken.None)).Success && failedStart.WorkerStarts == 1,
                "Corrected startup succeeds after cooldown without a leaked lease");
        }
        Check(timeout, "Whole-evaluation deadline causes bounded worker cancellation");
        await WaitForReplacement(host);
        using (var startup = new CancellationTokenSource(TimeSpan.FromSeconds(5))) await host.WarmAsync(startup.Token);
        var recovery = await host.EvaluateAsync(Request("", "42"), 100, CancellationToken.None);
        Check(recovery.Success && recovery.Result!.Value.GetInt32() == 42, "Worker replacement recovers after deadline/kill");
        var mapping = new SourceMqttMapping("m", "factory/a", "[default]Script", Tags: "explicit", Payload: "script", Script: "json payload", Shape: "structure");
        var a = new SourcePoint("a", "A", "factory/a", "Int64", "/a", MappingId: "m");
        var b = new SourcePoint("b", "B", "factory/a", "Int64", "/b", MappingId: "m");
        var connection = new ConnectionDefinition("script", "Script", "mqtt", Source: new("mqtt://localhost", "subscribe", Points: [a, b], Mqtt: new(Mappings: [mapping])));
        await using var engine = new SourceMqttMappingEngine(connection, new(1, [a, b], [mapping]), 1);
        using (var startup = new CancellationTokenSource(TimeSpan.FromSeconds(5))) await engine.WarmAsync(startup.Token);
        Task<SourceMqttMappingEngine.Result> Apply(string json, long ordinal) => engine.ProcessAsync(new("factory/a", Encoding.UTF8.GetBytes(json), false, false, ordinal), DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), CancellationToken.None);
        var complete = await Apply("{\"a\":1,\"b\":2}", 1);
        Check(complete.Values.Count == 2 && complete.Values.All(value => value.Quality == "Good"), "Structured selected leaves commit atomically");
        var snapshot = await Apply("{\"a\":3}", 2);
        Check(snapshot.Values.Single(value => value.PointId == "b").Action == SourceValueAction.Clear && snapshot.Values.Single(value => value.PointId == "b").Quality == "Bad_NoData", "Snapshot omitted child clears previous value");
        engine.Update(new(2, [a, b], [mapping with { StructuredUpdates = "patch" }]));
        await Apply("{\"a\":4,\"b\":5}", 3);
        var patch = await Apply("{\"a\":6}", 4);
        Check(patch.Values.All(value => value.PointId != "b") && (long)engine.Read(new([b])).Values.Single().Value! == 5, "Patch omitted child keeps its own accepted state");
        var nullChild = await Apply("{\"a\":null,\"b\":7}", 5);
        Check(nullChild.Values.All(value => value.PointId != "a"), "Intentional null child does not refresh its leaf");
        var typeChange = await Apply("{\"a\":8,\"b\":\"changed\"}", 6);
        Check(typeChange.Values.All(value => value.Action == SourceValueAction.Retain) && (long)engine.Read(new([a])).Values.Single().Value! == 6, "A mismatched child prevents partial sibling commit");
        var shapeChange = await Apply("[1,2]", 7);
        Check(shapeChange.Values.All(value => value.Quality == "Bad_TypeMismatch"), "Object-to-array shape change rejected");
        engine.Update(new(3, [a, b], [mapping with { Ordering = "sequence", SequenceExpression = "(json payload).seq", EpochExpression = "(json payload).epoch" }]));
        await Apply("{\"a\":9,\"b\":10,\"seq\":3,\"epoch\":\"one\"}", 8);
        var replay = await Apply("{\"a\":1,\"b\":2,\"seq\":2,\"epoch\":\"one\"}", 9);
        Check(replay.Values.Count == 0 && (long)engine.Read(new([a])).Values.Single().Value! == 9, "Application sequence rejects replay within an epoch");
        var reset = await Apply("{\"a\":11,\"b\":12,\"seq\":1,\"epoch\":\"two\"}", 10);
        Check(reset.Values.Single(value => value.PointId == "a").Value is long next && next == 11, "Explicit epoch change permits sequence reset");
        var retiredEpoch = await Apply("{\"a\":100,\"b\":101,\"seq\":100,\"epoch\":\"one\"}", 11);
        Check(retiredEpoch.Skipped && (long)engine.Read(new([a])).Values.Single().Value! == 11, "A delayed retired epoch cannot reset ordering backward");
        SourcePublication? deniedPublication = null;
        var denied = await engine.ProcessAsync(new("factory/a", "{\"a\":13,\"seq\":2,\"epoch\":\"two\"}"u8.ToArray(), false, false, 11), DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), CancellationToken.None,
            (publication, _) => { deniedPublication = publication; return ValueTask.FromResult(false); });
        Check(deniedPublication!.Values.Any(value => value.PointId == "b" && value.Action == SourceValueAction.Clear), "Snapshot absent-child clears participate in transactional admission");
        Check(denied.Error is not null && (long)engine.Read(new([a])).Values.Single().Value! == 11 && (long)engine.Read(new([b])).Values.Single().Value! == 12, "Rejected publication preserves all accepted sibling cache values");
        var acceptedRetry = await Apply("{\"a\":13,\"b\":14,\"seq\":2,\"epoch\":\"two\"}", 12);
        Check(acceptedRetry.Values.Single(value => value.PointId == "a").Value is long retry && retry == 13, "Rejected admission cannot advance the publisher ordering marker");
        return passed;
    }
}
