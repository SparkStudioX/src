using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

public static class BackendReliabilityChecks
{
    private sealed class Lifetime : IHostApplicationLifetime
    {
        public CancellationToken ApplicationStarted => CancellationToken.None;
        public CancellationToken ApplicationStopping => CancellationToken.None;
        public CancellationToken ApplicationStopped => CancellationToken.None;
        public void StopApplication() { }
    }
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool condition, string description) { if (!condition) throw new Exception(description); passed++; }
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.BackendReliability." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var protection = new EphemeralDataProtectionProvider();
        try
        {
            var heartbeatContext = new DefaultHttpContext();
            using (var frames = new MemoryStream())
            {
                heartbeatContext.Response.Body = frames;
                await TagEventStream.WriteHeartbeatAsync(heartbeatContext.Response, CancellationToken.None);
                var frame = System.Text.Encoding.UTF8.GetString(frames.ToArray());
                Check(frame == "event: heartbeat\ndata: {}\n\n", "idle SSE sends a named event visible to the browser liveness watchdog");
            }
            passed += await MemoryDefinitionCacheChecks(Path.Combine(directory, "memory-cache"), protection);
            var store = new ProjectStore(directory, protection);
            var package = new JsonObject { ["format"] = "sparkstudio.tags", ["version"] = 1,
                ["tags"] = new JsonArray(Enumerable.Range(0, 100).Select(index => (JsonNode)new JsonObject
                { ["path"] = $"[default]Perf/T{index}", ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = 0 }).ToArray()) };
            var preview = store.PreviewTagImport(package);
            store.ApplyTagImport(new(package, preview.Revision, preview.PreviewToken));
            var configuration = File.ReadAllBytes(Path.Combine(directory, "tags.json"));
            using var connectors = new ConnectorService(directory);
            using var tags = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance);
            await tags.StartAsync(CancellationToken.None);
            try
            {
                await Task.Delay(150);
                Check(!tags.DemoMode && tags.Snapshot().All(tag => tag.Source != "simulated"), "production default does not generate synthetic line tags");
                var builds = tags.DefinitionBuildCount;
                await Task.Delay(1150);
                Check(builds == 1 && tags.DefinitionBuildCount == builds, "unchanged model expands once across multiple definition/expression ticks");
                var scopeAllows = true;
                using var delta = new TagDeltaSubscription(tags, path => scopeAllows && path == "[default]Perf/T0");
                Check(delta.Initial.Length == 1 && delta.Initial[0].Path == "[default]Perf/T0", "initial snapshot enforces selected path scope");
                var clock = Stopwatch.StartNew();
                await Task.WhenAll(Enumerable.Range(0, 8).Select(writer => Task.Run(() =>
                {
                    for (var value = 1; value <= 250; value++)
                        if (tags.WriteMemory([$"[default]Perf/T{writer}"], [JsonSerializer.SerializeToElement(value)])[0] != "Good")
                            throw new Exception("Concurrent memory write failed.");
                })));
                Check(tags.Read(["[default]Perf/T0"], null)[0].Value is JsonElement last && last.GetInt32() == 250, "concurrent writes retain each path's last value");
                Check(configuration.SequenceEqual(File.ReadAllBytes(Path.Combine(directory, "tags.json"))), "two thousand runtime writes never rewrite tag configuration");
                Check(delta.PendingCount <= 8, "slow SSE consumer retains only one update per changed path");
                var batch = delta.Drain();
                Check(batch.Snapshot is null && batch.Delta.Upserts.Length == 1 && batch.Delta.Upserts[0].Value is JsonElement final && final.GetInt32() == 250,
                    "delta coalescing delivers the newest authorized value only");
                Check(delta.Drain().Delta.Upserts.Length == 0, "idle stream does not send a replacement snapshot");
                scopeAllows = false;
                Check(delta.Reset().Length == 0, "scope replacement resets client snapshot to remove newly forbidden paths");
                scopeAllows = true;
                Check(delta.Reset().Length == 1, "expanded scope resets client snapshot with newly authorized values");
                using (var entered = new ManualResetEventSlim())
                using (var release = new ManualResetEventSlim())
                using (var secondEntered = new ManualResetEventSlim())
                using (var secondRelease = new ManualResetEventSlim())
                {
                    void Delayed(TagValue? before, TagValue after)
                    {
                        if (after.Path == "[default]Perf/T2" && after.Value is JsonElement value && value.GetInt32() == 701)
                        { entered.Set(); if (!release.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Test callback release timed out."); }
                        if (after.Path == "[default]Perf/T2" && after.Value is JsonElement secondValue && secondValue.GetInt32() == 702)
                        { secondEntered.Set(); if (!secondRelease.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Second test callback release timed out."); }
                    }
                    tags.ValueChanged += Delayed;
                    try
                    {
                        using var delayed = new TagDeltaSubscription(tags, path => path == "[default]Perf/T2");
                        var first = Task.Run(() => tags.WriteMemory(["[default]Perf/T2"], [JsonSerializer.SerializeToElement(701)]));
                        Check(entered.Wait(TimeSpan.FromSeconds(2)), "test subscriber can delay delivery without owning the tag state monitor");
                        var second = Task.Run(() => tags.WriteMemory(["[default]Perf/T2"], [JsonSerializer.SerializeToElement(702)]));
                        Check(SpinWait.SpinUntil(() => tags.Read(["[default]Perf/T2"], null)[0].Value is JsonElement value && value.GetInt32() == 702, 2000),
                            "new tag state advances while an earlier notification is waiting");
                        Check(delayed.Reset()[0].Value is JsonElement newest && newest.GetInt32() == 702, "reset captures the new state before delayed delivery");
                        release.Set();
                        Check(secondEntered.Wait(TimeSpan.FromSeconds(2)), "older notification arrives before the newer pending notification");
                        Check(delayed.Drain().Delta.Upserts[0].Value is JsonElement delivered && delivered.GetInt32() == 702,
                            "delayed notification cannot roll a reset snapshot back to an older value");
                        secondRelease.Set(); await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(3));
                    }
                    finally { release.Set(); secondRelease.Set(); tags.ValueChanged -= Delayed; }
                }
                long scopeRevision = 1; var changeDuringCapture = false; var allowed = true;
                using (var changingScope = new TagDeltaSubscription(tags, path =>
                {
                    if (changeDuringCapture) { changeDuringCapture = false; allowed = false; scopeRevision++; }
                    return allowed;
                }))
                {
                    changeDuringCapture = true;
                    Check(TagEventStream.CaptureCurrent(changingScope, -1, () => scopeRevision) is null,
                        "scope changes during snapshot filtering discard the inconsistent batch");
                    var safe = TagEventStream.CaptureCurrent(changingScope, -1, () => scopeRevision);
                    Check(safe is { Revision: 2, Snapshot.Length: 0 }, "retry replaces client values under the final narrowed scope");
                }
                var callbackOutsideLock = false;
                void Probe(TagValue? before, TagValue after) { callbackOutsideLock = Task.Run(() => tags.SubscriptionSnapshot()).Wait(TimeSpan.FromSeconds(2)); }
                tags.ValueChanged += Probe;
                tags.WriteMemory(["[default]Perf/T1"], [JsonSerializer.SerializeToElement(251)]);
                tags.ValueChanged -= Probe;
                Check(callbackOutsideLock, "tag subscriber callback does not own state monitor and another thread can inspect subscriptions");
                store.FlushMemoryValues();
                Check(store.MemoryStateWriteCount < 20, "memory persistence coalesces writes into bounded checkpoints");
                var restored = new ProjectStore(directory, protection);
                Check(restored.GetTagDefinitions().OfType<JsonObject>().Single(tag => tag["path"]!.GetValue<string>() == "[default]Perf/T0")["value"]!.GetValue<int>() == 250,
                    "checkpointed state survives gateway restart");
                Check(tags.DefinitionBuildCount == builds, "memory-value changes do not rebuild expanded configuration");
                tags.DeleteDefinition("[default]Perf/T0");
                Check(delta.Drain().Delta.Removed.SequenceEqual(["[default]Perf/T0"]), "deleted tag is explicitly removed from client store");
                Console.WriteLine($"Backend measurement: 2,000 memory writes / 100 tags in {clock.ElapsedMilliseconds} ms; {store.MemoryStateWriteCount} state checkpoints; {builds} definition build before reconfiguration.");
            }
            finally { await tags.StopAsync(CancellationToken.None); }
            var reconfigured = new ProjectStore(directory, protection);
            reconfigured.SaveTag(new() { ["path"] = "[default]Perf/T3", ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = 77 });
            var crashReload = new ProjectStore(directory, protection);
            Check(crashReload.GetTagDefinitions().OfType<JsonObject>().Single(tag => tag["path"]!.GetValue<string>() == "[default]Perf/T3")["value"]!.GetValue<int>() == 77,
                "old value checkpoint cannot override a newly configured default after a crash before the next value checkpoint");

            var journalDirectory = Path.Combine(directory, "journal");
            var journal = new ScriptRunJournal(journalDirectory);
            journal.Append([new JsonObject { ["runId"] = "a", ["status"] = "running" }, new JsonObject { ["runId"] = "b", ["status"] = "running" },
                new JsonObject { ["runId"] = "a", ["status"] = "succeeded", ["success"] = true }]);
            File.AppendAllText(Path.Combine(journalDirectory, "script-event-runs.jsonl"), "{\"runId\":\"interrupted-write");
            var recovered = new ScriptRunJournal(journalDirectory).Load();
            Check(recovered.Length == 2 && recovered[0]["status"]!.GetValue<string>() == "succeeded" && recovered[1]["status"]!.GetValue<string>() == "interrupted",
                "append journal preserves completed transitions and recovers unfinished executions despite partial final write");
            Check(journal.AppendFlushCount == 1, "one append batch performs one flush for several transitions");
            Check(!File.Exists(Path.Combine(journalDirectory, "script-event-runs.jsonl")), "restart atomically checkpoints and compacts append journal");

            var catalogDirectory = Path.Combine(directory, "catalog");
            var catalog = new ProjectCatalog(catalogDirectory, protection);
            var healthy = catalog.Create("Healthy"); var damaged = catalog.Create("Damaged"); var badMetadata = catalog.Create("Bad metadata");
            badMetadata.Publication.Publish(badMetadata.Store, 0);
            var metadataPath = Path.Combine(badMetadata.Directory, "published.json");
            var metadataDocument = JsonNode.Parse(File.ReadAllText(metadataPath))!.AsObject();
            metadataDocument["historyWarnings"] = 123;
            File.WriteAllText(metadataPath, metadataDocument.ToJsonString());
            healthy.Publication.Publish(healthy.Store, 0);
            healthy.Publication.History(); var validations = healthy.Publication.HistoryValidationCount;
            for (var index = 0; index < 100; index++) healthy.Publication.History();
            Check(healthy.Publication.HistoryValidationCount == validations && validations == 1, "history integrity is checked once per immutable publication generation");
            File.WriteAllText(Path.Combine(damaged.Directory, "project.json"), "{broken");
            var reloaded = new ProjectCatalog(catalogDirectory, protection);
            Check(reloaded.List().OfType<JsonObject>().Single(project => project["id"]!.GetValue<string>() == damaged.Id)["available"]?.GetValue<bool>() == false,
                "catalog lists damaged entry for recovery without hiding healthy projects");
            Check(reloaded.List().OfType<JsonObject>().Single(project => project["id"]!.GetValue<string>() == badMetadata.Id)["available"]?.GetValue<bool>() == false,
                "invalid publication metadata is isolated as well as invalid JSON syntax");
            using var catalogTags = new TagEngine(reloaded.GatewayStore, connectors, NullLogger<TagEngine>.Instance);
            using var registry = new ProjectRuntimeRegistry(reloaded, catalogTags, connectors, new ConfigurationBuilder().Build(), NullLoggerFactory.Instance, new Lifetime());
            await registry.StartAsync(CancellationToken.None);
            Check(registry.StartupFailures.ContainsKey(damaged.Id) && registry.Get(healthy.Id).Workspace.Id == healthy.Id,
                "one corrupt project is isolated while healthy project runtime starts");
            Check(registry.StartupFailures.ContainsKey(badMetadata.Id), "invalid publication metadata is reported before starting its scheduler");
            await registry.StopAsync(CancellationToken.None);
            Check(File.ReadAllText(Path.Combine(damaged.Directory, "project.json")) == "{broken", "fault isolation preserves damaged data for recovery");
            Check(TagDefinitionValidator.AbsoluteDeadband(new() { ["absoluteDeadband"] = 0.5 }) == 0.5 && TagDefinitionValidator.MonitorQueueSize(new()) == 16,
                "OPC monitor deadband and bounded queue defaults validate");
            try { TagDefinitionValidator.AbsoluteDeadband(new() { ["absoluteDeadband"] = -1 }); throw new Exception("Negative deadband accepted."); } catch (ArgumentException) { passed++; }
            Check(TagDefinitionValidator.MemoryValue("UInt16", JsonSerializer.SerializeToElement(65535)).GetValue<ushort>() == ushort.MaxValue &&
                TagDefinitionValidator.MemoryValue("UInt32", JsonSerializer.SerializeToElement(4294967295L)).GetValue<uint>() == uint.MaxValue, "unsigned OPC word values preserve full scalar ranges");
            foreach (var (type, value) in new[] { ("UInt16", -1L), ("UInt16", 65536L), ("UInt32", -1L), ("UInt32", 4294967296L) })
            { try { TagDefinitionValidator.MemoryValue(type, JsonSerializer.SerializeToElement(value)); throw new Exception("Unsigned overflow accepted."); } catch (ArgumentException) { passed++; } }
            return passed;
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); }
    }

    private static async Task<int> MemoryDefinitionCacheChecks(string directory, IDataProtectionProvider protection)
    {
        var passed = 0;
        void Check(bool condition, string description) { if (!condition) throw new Exception(description); passed++; }
        var store = new ProjectStore(directory, protection, gatewayOnly: true);
        using var connectors = new ConnectorService(directory);
        using var tags = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance);
        JsonObject Memory(string name, int value, bool enabled = true) => new()
        { ["path"] = "[default]Cache/" + name, ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = value, ["enabled"] = enabled };
        TagValue Read(string name) => tags.Read(["[default]Cache/" + name], null)[0];
        void Write(string name, int value) => Check(tags.WriteMemory(["[default]Cache/" + name], [JsonSerializer.SerializeToElement(value)])[0] == "Good", "fixture memory write succeeds");
        var refresh = typeof(TagEngine).GetMethod("RefreshDefinitions", BindingFlags.NonPublic | BindingFlags.Instance)!;
        var apply = typeof(TagEngine).GetMethod("DefinitionLoop", BindingFlags.NonPublic | BindingFlags.Instance)!;
        void PrimeCache() => refresh.Invoke(tags, null);
        async Task ApplyPendingDefinitions()
        {
            using var stop = new CancellationTokenSource();
            // The loop applies its first generation synchronously, then awaits the
            // next scan. Isolate that step so the stale-cache ordering is deterministic.
            var task = (Task)apply.Invoke(tags, [stop.Token])!;
            stop.Cancel();
            try { await task; } catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        }
        tags.SaveDefinition(Memory("A", 0)); tags.SaveDefinition(Memory("B", 0));
        PrimeCache(); Write("A", 11); Write("B", 22);
        var a = Read("A"); var b = Read("B");
        await ApplyPendingDefinitions();
        Check(Read("A").Value is JsonElement first && first.GetInt32() == 11 && Read("B").Value is JsonElement second && second.GetInt32() == 22,
            "definition application retains memory writes made after another loop cached the configuration");
        Check(Read("A").Timestamp == a.Timestamp && Read("B").Timestamp == b.Timestamp,
            "definition application does not invent a timestamp for retained memory values");
        Check(tags.DefinitionBuildCount == 1, "runtime writes and authoritative value application do not rebuild configuration plans");

        tags.SaveDefinition(Memory("C", 0)); PrimeCache(); Write("A", 44); Write("B", 55); store.FlushMemoryValues();
        await ApplyPendingDefinitions();
        Check(Read("A").Value is JsonElement updated && updated.GetInt32() == 44 && Read("B").Value is JsonElement unrelated && unrelated.GetInt32() == 55,
            "unrelated configuration changes and checkpoints retain writes newer than the cached memory snapshot");
        Check(tags.DefinitionBuildCount == 2, "only the unrelated configuration change rebuilds plans");

        tags.SaveDefinition(Memory("A", 7)); PrimeCache(); Write("B", 66);
        await ApplyPendingDefinitions();
        Check(Read("A").Value is JsonElement changed && changed.GetInt32() == 7 && Read("B").Value is JsonElement retained && retained.GetInt32() == 66,
            "an edited memory default replaces its old runtime value while another tag retains its newer write");
        tags.SaveDefinition(Memory("B", 0, enabled: false)); PrimeCache(); await ApplyPendingDefinitions();
        Check(Read("B").Quality == "Bad_Disabled" && tags.WriteMemory(["[default]Cache/B"], [JsonSerializer.SerializeToElement(77)])[0] == "Bad_NotWritable",
            "authoritative definition application preserves disabled memory quality and write rejection");
        tags.SaveDefinition(Memory("B", 9)); PrimeCache(); await ApplyPendingDefinitions();
        Check(Read("B").Quality == "Good" && Read("B").Value is JsonElement enabled && enabled.GetInt32() == 9,
            "re-enabling a changed memory definition applies its reviewed default");
        return passed;
    }
}
