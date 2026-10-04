using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

/// <summary>Independently authored, opt-in source qualification profile. All peers and data are synthetic.</summary>
internal static class SourceLoadProbe
{
    private const int MqttCount = 2375, MqttAliases = 4, MqttGroups = 1, I3xCount = 250, MtCount = 249;
    private const string PlcPath = "[default]SourceLoad/PLC";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private static readonly IReadOnlyDictionary<string, long> GlobalCaps = new Dictionary<string, long> {
        ["queue"] = 64L << 20, ["state"] = 128L << 20, ["decode"] = 256L << 20,
        ["values"] = 128L << 20, ["catalog"] = 128L << 20, ["workers"] = 1024L << 20 };

    public static async Task RunAsync(string[] args)
    {
        string Option(string name, string fallback) {
            var index = Array.IndexOf(args, name); if (index < 0) return fallback;
            if (index + 1 >= args.Length) throw new ArgumentException(name + " requires a value."); return args[index + 1];
        }
        int Number(string name, int fallback, int minimum, int maximum) {
            var number = int.Parse(Option(name, fallback.ToString(CultureInfo.InvariantCulture)), CultureInfo.InvariantCulture);
            if (number < minimum || number > maximum) throw new ArgumentException($"{name} must be {minimum}–{maximum}."); return number;
        }
        var warmup = Number("--warmup-seconds", 300, 0, 3600);
        var duration = Number("--duration-seconds", 1800, 5, 86400);
        var burst = Number("--burst-seconds", 60, 1, 600);
        var baseline = Number("--baseline-seconds", 10, 3, 120);
        var churnCycles = Number("--churn-cycles", 5, 1, 100);
        var profileDuration = warmup >= 300 && duration >= 1800 && burst >= 60;
        var root = FindRepository(); var dataRoot = Path.Combine(root, ".data");
        var output = Path.GetFullPath(Option("--output-dir", Path.Combine(dataRoot, "source-load", DateTimeOffset.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N")[..8])));
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        if (!output.StartsWith(Path.GetFullPath(dataRoot) + Path.DirectorySeparatorChar, comparison) || Directory.Exists(output) || File.Exists(output))
            throw new ArgumentException("Use a fresh output directory inside this checkout's .data directory.");
        for (var parent = new DirectoryInfo(output).Parent; parent is not null; parent = parent.Parent)
            if (parent.Exists && (parent.Attributes & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("Load output cannot traverse symbolic links.");
        Directory.CreateDirectory(output);
        var report = new JsonObject {
            ["startedAt"] = DateTimeOffset.UtcNow, ["outputDirectory"] = output, ["profile"] = "sources-10000-mqtt1000x1024-mt-multipart-i3x250-modbus",
            ["qualified"] = false,
            ["qualificationDuration"] = profileDuration, ["warmupSeconds"] = warmup, ["steadySeconds"] = duration, ["burstSeconds"] = burst, ["churnCycles"] = churnCycles,
            ["expandedLeaves"] = 10000, ["mqttLeaves"] = MqttCount * MqttAliases, ["mqttPoints"] = MqttCount, ["mqttAliasesPerPoint"] = MqttAliases, ["mqttConnections"] = MqttGroups, ["i3xLeaves"] = I3xCount, ["mtConnectLeaves"] = MtCount, ["plcLeaves"] = 1,
            ["mqttRate"] = 1000, ["mqttPayloadBytes"] = 1024, ["mqttBurstRate"] = 10000,
            ["mtMultipartIntervalMs"] = 100, ["i3xPollIntervalMs"] = 1000,
            ["machine"] = Environment.MachineName, ["os"] = RuntimeInformation.OSDescription, ["rid"] = Rid(), ["cpuArchitecture"] = RuntimeInformation.ProcessArchitecture.ToString(),
            ["logicalProcessors"] = Environment.ProcessorCount, ["availableRuntimeMemoryBytes"] = GC.GetGCMemoryInfo().TotalAvailableMemoryBytes,
            ["physicalMemoryBytes"] = PhysicalMemoryBytes(),
            ["runtime"] = RuntimeInformation.FrameworkDescription, ["gatewayVersion"] = typeof(TagEngine).Assembly.GetName().Version!.ToString(),
            ["buildConfiguration"] = typeof(TagEngine).Assembly.GetCustomAttributes(typeof(System.Reflection.AssemblyConfigurationAttribute), false)
                .OfType<System.Reflection.AssemblyConfigurationAttribute>().SingleOrDefault()?.Configuration,
            ["connectorVersion"] = typeof(ConnectorService).Assembly.GetName().Version!.ToString(), ["effectiveLimits"] = JsonSerializer.SerializeToNode(new SourceLimits(), Json),
            ["assemblyFingerprints"] = JsonSerializer.SerializeToNode(new[] { typeof(TagEngine).Assembly, typeof(ConnectorService).Assembly, typeof(SourceLoadProbe).Assembly }
                .Distinct().Select(assembly => new { name = assembly.GetName().Name, moduleVersionId = assembly.ManifestModule.ModuleVersionId,
                    sha256 = File.Exists(assembly.Location) ? Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() : null }), Json),
            ["methodology"] = "One process hosts production TagEngine, ConnectorService, readiness and diagnostics HTTP handlers plus independently authored loopback MQTT/MTConnect/i3X/Modbus peers. An imported review MQTT catalog has 2375 points and four tag aliases per point, respecting the 768 KiB map cap while exercising 9500 expanded MQTT leaves. Each scalar payload is an integer padded with whitespace to exactly 1024 bytes. Peers use actual sockets; generator sends are awaited with no upstream publish queue. Histograms have 1 ms bins up to 10 s. PLC polling uses the production 100 ms watch; delay is callback interarrival minus 100 ms. CPU/RSS/heap include synthetic peers and HTTP clients. Equivalent blocking full collections every 60 s establish first/last ten-minute steady heap windows. This profile has no scripted mappings; adversarial script qualification is separate.",
            ["resourceGuard"] = "Cancel this owned fixture if RSS exceeds 2GiB or tracked global budgets exceed their caps. No installed gateway data or external endpoints are opened."
        };
        void Save() => File.WriteAllText(Path.Combine(output, "report.json"), report.ToJsonString(Json));
        Save(); Console.WriteLine("Source load report: " + Path.Combine(output, "report.json"));
        using var lifetime = new CancellationTokenSource(TimeSpan.FromSeconds(baseline + warmup + duration + burst + 300 + churnCycles * 10));
        ConsoleCancelEventHandler cancel = (_, eventArgs) => { eventArgs.Cancel = true; lifetime.Cancel(); };
        Console.CancelKeyPress += cancel;
        var metrics = new Measurements();
        var catalog = new ProjectCatalog(Path.Combine(output, "gateway"), new EphemeralDataProtectionProvider());
        var store = catalog.GatewayStore;
        await using var mqtt = new MqttPeer(); await using var plc = new ModbusPeer();
        using var connectors = new ConnectorService(Path.Combine(output, "gateway"));
        using var tags = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance);
        var readinessConfiguration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Python:Executable"] = TestEnvironment.PythonExecutable() }).Build();
        using var readiness = new GatewayReadiness(readinessConfiguration);
        await using var http = await ProtocolHost.CreateAsync(catalog, tags, readiness, metrics, lifetime.Token);
        var sourceIds = Enumerable.Range(0, MqttGroups).Select(group => "mqtt" + group).Append("mt").Append("i3x").ToArray();
        var observers = new CancellationTokenSource(); Task? observe = null, api = null;
        var started = false; var shutDown = false;
        tags.ValueChanged += (_, value) => { if (value.Path == PlcPath && value.Quality == "Good") metrics.PlcTick(); };
        try {
            Seed(store, mqtt.Port, plc.Port, http.Address);
            report["mapBytes"] = JsonSerializer.SerializeToNode(sourceIds.ToDictionary(id => id, id => JsonSerializer.SerializeToUtf8Bytes(store.GetConnection(id, true).Source!.SavedPoints).Length));
            report["definitionCount"] = store.GetTagDefinitions().Count;
            if (store.GetTagDefinitions().Count != 10000) throw new InvalidOperationException("The profile must contain exactly10000 expanded leaves.");
            await readiness.StartAsync(lifetime.Token);
            if (!readiness.Snapshot().PythonAvailable) throw new InvalidOperationException("The genuine production Python readiness startup probe failed.");
            await tags.StartAsync(lifetime.Token); started = true;
            metrics.SetPhase("baseline");
            await WaitAsync(() => tags.Read([PlcPath], null).Single().Quality == "Good", TimeSpan.FromSeconds(10), lifetime.Token);
            await Task.Delay(1000, lifetime.Token);
            await PhaseAsync("baseline", baseline, null);
            foreach (var id in sourceIds) { var saved = store.GetConnections().OfType<JsonObject>().Single(item => item["id"]!.GetValue<string>() == id); saved["enabled"] = true; tags.SaveConnection(saved); }
            await WaitAsync(() => mqtt.ReadyGroups == MqttGroups && http.MtDocuments > 0 && http.I3xBatches > 0, TimeSpan.FromSeconds(20), lifetime.Token);
            metrics.SetPhase("seed"); await SendMqttAsync(MqttCount, 1000, mqtt, metrics, lifetime.Token);
            await WaitAsync(() => tags.Snapshot().Count(value => value.Quality == "Good") == 10000, TimeSpan.FromSeconds(30), lifetime.Token);
            metrics.ResetPlcTick();
            observe = ObserveAsync(metrics, connectors, sourceIds, mqtt, plc, http, observers.Token, lifetime);
            api = ProbeApiAsync(http.Address, sourceIds, metrics, observers.Token);
            await PhaseAsync("warmup", warmup, 1000);
            metrics.SetPhase("steady"); metrics.SteadyStart = Stopwatch.GetTimestamp();
            metrics.CollectHeap("steady", 0);
            await PhaseAsync("steady", duration, 1000);
            metrics.CollectHeap("steady", duration);
            await PhaseAsync("burst", burst, 10000);
            report["postBurstConvergence"] = JsonSerializer.SerializeToNode(await ConvergeAsync("post-burst-convergence", 8123456789012345L), Json);
            metrics.SetPhase("churn");
            var churnClock = Stopwatch.StartNew();
            var churnMeasurements = new JsonArray(); report["churnMeasurements"] = churnMeasurements;
            using (var churn = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token)) {
                var publisher = PumpMqttAsync(1000, mqtt, metrics, churn.Token);
                try {
                    for (var cycle = 0; cycle < churnCycles; cycle++) {
                        var cycleClock = Stopwatch.StartNew();
                        mqtt.Disconnect(); http.DropMtStream();
                        var connection = store.GetConnections().OfType<JsonObject>().Single(item => item["id"]!.GetValue<string>() == "i3x");
                        connection["enabled"] = false; var saveClock = Stopwatch.StartNew(); tags.SaveConnection(connection);
                        var disableMilliseconds = saveClock.Elapsed.TotalMilliseconds;
                        await Task.Delay(250, lifetime.Token);
                        connection = store.GetConnections().OfType<JsonObject>().Single(item => item["id"]!.GetValue<string>() == "i3x");
                        connection["enabled"] = true; connection["source"]!["points"]![0]!["name"] = "Synthetic hot binding " + cycle;
                        saveClock.Restart(); tags.SaveConnection(connection); var enableMilliseconds = saveClock.Elapsed.TotalMilliseconds;
                        var recoveryClock = Stopwatch.StartNew();
                        await WaitAsync(() => mqtt.ReadyGroups == MqttGroups && http.ActiveMtStreams == 1, TimeSpan.FromSeconds(10), lifetime.Token);
                        var recoveryMilliseconds = recoveryClock.Elapsed.TotalMilliseconds;
                        await Task.Delay(1000, lifetime.Token); metrics.Churns++;
                        churnMeasurements.Add(new JsonObject { ["cycle"] = cycle, ["disableSaveMs"] = disableMilliseconds, ["enableSaveMs"] = enableMilliseconds,
                            ["mqttMtRecoveryMs"] = recoveryMilliseconds, ["totalMs"] = cycleClock.Elapsed.TotalMilliseconds });
                    }
                } finally {
                    churn.Cancel();
                    try { await publisher; } catch (OperationCanceledException) { }
                    finally { metrics.For("churn").Seconds = churnClock.Elapsed.TotalSeconds; }
                }
            }
            report["convergence"] = JsonSerializer.SerializeToNode(await ConvergeAsync("convergence", 8123456789012456L), Json);
            var shutdown = Stopwatch.StartNew(); using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5))) await tags.StopAsync(deadline.Token);
            tags.Dispose(); connectors.Dispose(); shutDown = true; metrics.AcquisitionShutdownMs = shutdown.Elapsed.TotalMilliseconds;
            observers.Cancel(); await IgnoreCancellation(observe); await IgnoreCancellation(api);
            await readiness.StopAsync(default); await http.StopAsync(); await mqtt.StopAsync(); await plc.StopAsync();
            metrics.FinalBudgets = SourceMemoryBudget.Snapshot();
            metrics.FinalWorkerProcesses = WorkerProcesses();
            report["measurements"] = JsonSerializer.SerializeToNode(metrics.Report(duration, http, mqtt, plc), Json);
            var gates = Gates(metrics, duration, profileDuration, http, mqtt, plc);
            report["gates"] = JsonSerializer.SerializeToNode(gates, Json);
            report["qualified"] = profileDuration && gates.Values.All(pass => pass);
            report["completedAt"] = DateTimeOffset.UtcNow; Save();
            Console.WriteLine("Source load completed; gates=" + JsonSerializer.Serialize(gates) + ", report=" + Path.Combine(output, "report.json"));
            if (gates.Values.Any(pass => !pass)) throw new InvalidOperationException("Source profile failed one or more measured gates. See report.json.");
        }
        catch (Exception error) {
            report["failedAt"] = DateTimeOffset.UtcNow; report["failure"] = error.GetType().Name + ": " + error.Message;
            var executionError = tags.ExecuteTask?.Exception?.ToString();
            report["tagExecution"] = new JsonObject { ["status"] = tags.ExecuteTask?.Status.ToString(), ["completed"] = tags.ExecuteTask?.IsCompleted,
                ["faulted"] = tags.ExecuteTask?.IsFaulted, ["exception"] = executionError is { Length: > 16384 } ? executionError[..16384] : executionError };
            report["sourceOwnerCount"] = sourceIds.Count(id => JsonSerializer.SerializeToElement(connectors.SourceDiagnostics(id)).TryGetProperty("generation", out _));
            report["sourceDiagnostics"] = JsonSerializer.SerializeToNode(sourceIds.ToDictionary(id => id, id => tags.SourceSnapshot(id)), Json);
            report["badRuntimeValues"] = JsonSerializer.SerializeToNode(tags.Snapshot().Where(value => value.Quality != "Good").Take(30).ToArray(), Json);
            report["measurements"] = JsonSerializer.SerializeToNode(metrics.Report(duration, http, mqtt, plc), Json); Save(); throw;
        }
        finally {
            observers.Cancel(); await IgnoreCancellation(observe); await IgnoreCancellation(api);
            if (started && !shutDown) { using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5)); try { await tags.StopAsync(deadline.Token); } catch (Exception) { } }
            await readiness.StopAsync(default); observers.Dispose(); Console.CancelKeyPress -= cancel;
        }

        async Task<List<object>> ConvergeAsync(string phase, long marker) {
            metrics.SetPhase(phase); await WaitForQueueDrainAsync(connectors, sourceIds, lifetime.Token);
            var convergence = new List<object>();
            for (var group = 0; group < MqttGroups; group++) {
                var index = group * (MqttCount / MqttGroups); var beforeValue = tags.Read([MqttPath(index)], null).Single();
                var clock = Stopwatch.StartNew(); var written = await mqtt.PublishAsync(index, marker + group, lifetime.Token); var visible = false;
                while (clock.Elapsed < TimeSpan.FromSeconds(1)) {
                    if (tags.Read([MqttPath(index)], null).Single() is { Quality: "Good", Value: long actual } && actual == marker + group) { visible = true; break; }
                    await Task.Delay(5, lifetime.Token);
                }
                convergence.Add(new { group, latestVisible = visible, elapsedMs = clock.Elapsed.TotalMilliseconds, wireWritten = written,
                    beforeValue, afterValue = tags.Read([MqttPath(index)], null).Single(), diagnostics = tags.SourceSnapshot("mqtt" + group),
                    cached = await connectors.ReadSourceAsync(store.GetConnection("mqtt" + group), ["p" + index], lifetime.Token) });
                if (!visible) metrics.Failures.Enqueue("MQTT final accepted update did not converge within1s during" + phase + " for group" + group);
            }
            return convergence;
        }
        async Task PhaseAsync(string phase, int seconds, int? rate) {
            metrics.SetPhase(phase); Console.WriteLine($"Source load {phase}: {seconds}s, MQTT rate={rate ?? 0}/s.");
            if (seconds == 0) return;
            var timer = Stopwatch.StartNew(); var nextCheckpoint = 30d;
            using var phaseStop = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); phaseStop.CancelAfter(TimeSpan.FromSeconds(seconds));
            var publisher = rate is null ? Task.CompletedTask : PumpMqttAsync(rate.Value, mqtt, metrics, phaseStop.Token);
            try {
                while (!phaseStop.IsCancellationRequested) {
                    if (publisher.IsFaulted) await publisher;
                    await Task.Delay(Math.Min(1000, seconds * 1000), phaseStop.Token);
                    if (timer.Elapsed.TotalSeconds >= nextCheckpoint) {
                        report["activePhase"] = phase; report["activePhaseElapsedSeconds"] = timer.Elapsed.TotalSeconds;
                        report["measurements"] = JsonSerializer.SerializeToNode(metrics.Report(duration, http, mqtt, plc), Json); Save();
                        using var process = Process.GetCurrentProcess();
                        Console.WriteLine($"Source load {phase}: {timer.Elapsed.TotalSeconds:F0}s, sent={metrics.For(phase).Sent}, RSS={process.WorkingSet64 >> 20}MiB."); nextCheckpoint += 30;
                    }
                }
            } catch (OperationCanceledException) when (!lifetime.IsCancellationRequested) { }
            finally {
                phaseStop.Cancel();
                try { await IgnoreCancellation(publisher); }
                finally { metrics.For(phase).Seconds = timer.Elapsed.TotalSeconds; }
            }
            lifetime.Token.ThrowIfCancellationRequested();
        }
    }

    private static Dictionary<string, bool> Gates(Measurements metrics, int duration, bool full, ProtocolHost http, MqttPeer mqtt, ModbusPeer plc)
    {
        var baseline = metrics.For("baseline").Plc.P95;
        var threshold = Math.Max(100, baseline * 1.2);
        var loaded = metrics.Phases.Where(pair => pair.Key is "steady" or "burst" or "churn").Select(pair => pair.Value).ToArray();
        var heaps = metrics.HeapSamples.Where(sample => sample.Phase == "steady").ToArray();
        var first = heaps.Where(sample => sample.Second <= Math.Min(600, duration / 3d)).Select(sample => sample.Bytes).DefaultIfEmpty(0).Average();
        var last = heaps.Where(sample => sample.Second >= duration - Math.Min(600, duration / 3d)).Select(sample => sample.Bytes).DefaultIfEmpty(0).Average();
        return new() {
            ["expanded10000Leaves"] = true,
            ["mqttSteadyRate"] = metrics.For("steady").Sent / Math.Max(1, metrics.For("steady").Seconds) >= 990,
            ["mqttBurstRate"] = metrics.For("burst").Sent / Math.Max(1, metrics.For("burst").Seconds) >= 9900,
            ["mtMultipartAcquired"] = http.MtDocuments > 2, ["i3x250BatchAcquired"] = http.I3xReadSizes.GetValueOrDefault(250) > 1,
            ["readyAndDiagnosticP95"] = loaded.All(phase => phase.Readiness.P95 <= 500 && phase.Diagnostics.P95 <= 500 && phase.ApiErrors == 0 && phase.Readiness.Count > 0),
            ["plcP95Delay"] = loaded.All(phase => phase.Plc.P95 <= threshold && phase.Plc.Count > 0),
            ["globalByteCaps"] = metrics.HighBudgets.All(pair => GlobalCaps.TryGetValue(pair.Key, out var cap) && pair.Value <= cap),
            ["mqttQueueCapsInstrumented"] = metrics.MqttHighMetrics.ContainsKey("queueHighWaterCount") && metrics.MqttHighMetrics.ContainsKey("queueHighWaterBytes"),
            ["mqttQueueItemAndByteCaps"] = metrics.MqttHighMetrics.GetValueOrDefault("queueHighWaterCount") <= 4096 && metrics.MqttHighMetrics.GetValueOrDefault("queueHighWaterBytes") <= 8L << 20,
            ["mqttPacketAllocationCap"] = metrics.MqttHighMetrics.GetValueOrDefault("peakPacketBytes") <= 272 * 1024 && metrics.MqttHighMetrics.GetValueOrDefault("peakBodyBytes") <= 272 * 1024,
            ["managedHeapGrowth"] = last - first <= Math.Max(16L << 20, first * .05),
            ["latestConvergence"] = !metrics.Failures.Any(message => message.Contains("converge", StringComparison.Ordinal)),
            ["acquisitionShutdown2s"] = metrics.AcquisitionShutdownMs <= 2000,
            ["noTrackedBudgetLeaks"] = metrics.FinalBudgets.Values.All(value => value == 0),
            ["noPeerConnectionLeaks"] = mqtt.Active == 0 && plc.Active == 0 && http.ActiveMtStreams == 0,
            ["noWorkerLeaks"] = metrics.FinalWorkerProcesses <= metrics.InitialWorkerProcesses,
            ["noResourceGuardFailure"] = !metrics.Failures.Any(message => message.StartsWith("Global accounting", StringComparison.Ordinal) || message.Contains("RSS guard", StringComparison.Ordinal))
        };
    }

    private static void Seed(ProjectStore store, int mqttPort, int plcPort, string httpAddress)
    {
        var tags = new JsonArray();
        for (var group = 0; group < MqttGroups; group++) {
            var first = group * (MqttCount / MqttGroups);
            var points = Enumerable.Range(first, MqttCount / MqttGroups).Select(index => new SourcePoint("p" + index, "P" + index, MqttTopic(index), "Int64", MappingId: "m")).ToArray();
            var mapping = new SourceMqttMapping("m", "q/" + group + "/#", "[default]SourceLoad/Mqtt" + group, Tags: "review", DataType: "Int64");
            SaveSource("mqtt" + group, "mqtt", new($"mqtt://127.0.0.1:{mqttPort}", "subscribe", Points: points,
                Mqtt: new(ClientId: "spark-source-load-" + group, Mappings: [mapping])));
            foreach (var point in points)
                for (var alias = 0; alias < MqttAliases; alias++) tags.Add(DeviceTag(MqttPath(int.Parse(point.Id[1..], CultureInfo.InvariantCulture), alias), "mqtt" + group, point.Id, point.DataType));
        }
        var i3xPoints = Enumerable.Range(0, I3xCount).Select(index => new SourcePoint("p" + index, "P" + index, "id#" + index, "Int64")).ToArray();
        SaveSource("i3x", "i3x", new(httpAddress + "/i3x", Points: i3xPoints, I3x: new(ClientId: "spark-source-load-i3x")));
        foreach (var point in i3xPoints) tags.Add(DeviceTag("[default]SourceLoad/I3x/" + point.Id, "i3x", point.Id, point.DataType));
        var mtPoints = Enumerable.Range(0, MtCount - 3).Select(index => new SourcePoint("p" + index, "P" + index, "load/i" + index, "Int64"))
            .Concat([new("condition", "Condition", "load/c", "String", "level"), new("dataset", "Dataset", "load/ds", "String", "/a"), new("table", "Table", "load/tb", "String", "/r/x")]).ToArray();
        SaveSource("mt", "mtconnect", new(httpAddress + "/mt", "subscribe", Points: mtPoints, MtConnect: new(Device: "load", HeartbeatMs: 1000)));
        foreach (var point in mtPoints) tags.Add(DeviceTag("[default]SourceLoad/Mt/" + point.Id, "mt", point.Id, point.DataType));
        store.SaveConnection(new JsonObject { ["id"] = "plc", ["name"] = "Synthetic PLC", ["type"] = "modbus-tcp", ["device"] = JsonSerializer.SerializeToNode(new DeviceSettings {
            Host = "127.0.0.1", Port = plcPort, Points = [new() { Id = "r", Name = "Register", Address = "holdingRegister:0", DataType = "UInt16" }] }, ProjectStore.Json) });
        var plcTag = DeviceTag(PlcPath, "plc", "r", "UInt16"); plcTag["publishingIntervalMs"] = 100; tags.Add(plcTag);
        var package = TagModel.Empty(); package["tags"] = tags;
        var preview = store.PreviewTagImport(package); store.ApplyTagImport(new(package, preview.Revision, preview.PreviewToken));
        void SaveSource(string id, string type, SourceSettings source) => store.SaveConnection(new JsonObject { ["id"] = id, ["name"] = "Synthetic " + id, ["type"] = type,
            ["enabled"] = false, ["source"] = JsonSerializer.SerializeToNode(source, ProjectStore.Json) });
    }
    private static JsonObject DeviceTag(string path, string connection, string point, string type) => new() {
        ["path"] = path, ["kind"] = "device", ["connectionId"] = connection, ["nodeId"] = point, ["dataType"] = type };
    private static string MqttTopic(int index) => $"q/{index / (MqttCount / MqttGroups)}/p{index}";
    private static string MqttPath(int index, int alias = 0) => "[default]SourceLoad/Mqtt" + alias + "/" + index;
    private static string FindRepository() {
        foreach (var start in new[] { Environment.CurrentDirectory, AppContext.BaseDirectory })
            for (var directory = new DirectoryInfo(start); directory is not null; directory = directory.Parent)
                if (File.Exists(Path.Combine(directory.FullName, "src", "SparkStudio.Gateway.Tests", "SparkStudio.Gateway.Tests.csproj"))) return directory.FullName;
        throw new InvalidOperationException("Run the load probe inside the source checkout.");
    }
    private static string Rid() => (OperatingSystem.IsWindows() ? "win" : OperatingSystem.IsLinux() ? "linux" : "unsupported") + "-" + RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant();
    private static long PhysicalMemoryBytes() {
        if (OperatingSystem.IsWindows()) { var status = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() }; return GlobalMemoryStatusEx(ref status) ? checked((long)status.TotalPhysical) : 0; }
        if (OperatingSystem.IsLinux()) { var line = File.ReadLines("/proc/meminfo").FirstOrDefault(text => text.StartsWith("MemTotal:", StringComparison.Ordinal)); if (line is not null && long.TryParse(line.Split(' ', StringSplitOptions.RemoveEmptyEntries)[1], out var kilobytes)) return kilobytes * 1024; }
        return 0;
    }
    [StructLayout(LayoutKind.Sequential)] private struct MemoryStatus { public uint Length, Load; public ulong TotalPhysical, AvailablePhysical, TotalPageFile, AvailablePageFile, TotalVirtual, AvailableVirtual, AvailableExtendedVirtual; }
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);
    private static int WorkerProcesses() { var processes = Process.GetProcessesByName("SparkStudio.SourceWorker"); try { return processes.Length; } finally { foreach (var process in processes) process.Dispose(); } }
    private static async Task IgnoreCancellation(Task? task) { if (task is null) return; try { await task; } catch (OperationCanceledException) { } }
    private static async Task WaitAsync(Func<bool> ready, TimeSpan maximum, CancellationToken ct) {
        var clock = Stopwatch.StartNew(); while (!ready()) { if (clock.Elapsed > maximum) throw new TimeoutException("Synthetic source profile did not reach its required initial/recovery state."); await Task.Delay(20, ct); }
    }
    private static async Task WaitForQueueDrainAsync(ConnectorService connectors, string[] ids, CancellationToken ct) {
        var clock = Stopwatch.StartNew(); var idleSince = -1d;
        while (clock.Elapsed < TimeSpan.FromSeconds(10)) {
            var queued = ids.Where(id => id.StartsWith("mqtt", StringComparison.Ordinal)).Select(id => JsonSerializer.SerializeToElement(connectors.SourceDiagnostics(id)))
                .Sum(element => element.TryGetProperty("diagnostics", out var diagnostics) && diagnostics.ValueKind == JsonValueKind.Object
                    && diagnostics.TryGetProperty("queueCount", out var count) && count.TryGetInt32(out var number) ? number : 0);
            if (queued == 0) { if (idleSince < 0) idleSince = clock.Elapsed.TotalSeconds; if (clock.Elapsed.TotalSeconds - idleSince >= 1.2) return; }
            else idleSince = -1; await Task.Delay(20, ct);
        }
        throw new TimeoutException("The bounded MQTT queue did not drain after overload.");
    }
    private static async Task SendMqttAsync(int count, int rate, MqttPeer mqtt, Measurements metrics, CancellationToken ct) {
        var clock = Stopwatch.StartNew();
        for (var index = 0; index < count; index++) {
            if (await mqtt.PublishAsync(index, index + 1L, ct)) Interlocked.Increment(ref metrics.For(metrics.Phase).Sent);
            var wait = (index + 1) * 1000d / rate - clock.Elapsed.TotalMilliseconds;
            if (wait > 0) await Task.Delay(TimeSpan.FromMilliseconds(wait), ct);
        }
    }
    private static async Task PumpMqttAsync(int rate, MqttPeer mqtt, Measurements metrics, CancellationToken ct) {
        // Socket writes can complete synchronously while the receiver drains them.
        // Start the producer independently even when a slower RID never reaches a pacing delay.
        await Task.Yield();
        var clock = Stopwatch.StartNew(); long sent = 0; const int slice = 10;
        while (!ct.IsCancellationRequested) {
            for (var count = 0; count < rate * slice / 1000; count++) {
                var index = (int)(sent % MqttCount); var published = await mqtt.PublishAsync(index, sent + 100000L, ct);
                sent++; if (published) Interlocked.Increment(ref metrics.For(metrics.Phase).Sent);
            }
            var wait = sent * 1000d / rate - clock.Elapsed.TotalMilliseconds;
            if (wait > 0) await Task.Delay(TimeSpan.FromMilliseconds(wait), ct);
        }
    }
    private static async Task ProbeApiAsync(string address, string[] ids, Measurements metrics, CancellationToken ct) {
        using var client = new HttpClient(new SocketsHttpHandler { ConnectTimeout = TimeSpan.FromSeconds(1), MaxConnectionsPerServer = 2 }) { Timeout = TimeSpan.FromSeconds(2) };
        var next = 0;
        while (!ct.IsCancellationRequested) {
            var phase = metrics.For(metrics.Phase);
            foreach (var (path, histogram) in new[] { ("/api/ready", phase.Readiness), ("/api/connections/" + ids[next++ % ids.Length] + "/diagnostics", phase.Diagnostics) }) {
                var timer = Stopwatch.StartNew();
                try { using var response = await client.GetAsync(address + path, HttpCompletionOption.ResponseHeadersRead, ct); _ = await SourceHttp.ReadBoundedAsync(response, 2 * 1024 * 1024, ct); if (!response.IsSuccessStatusCode) Interlocked.Increment(ref phase.ApiErrors); }
                catch (Exception) when (!ct.IsCancellationRequested) { Interlocked.Increment(ref phase.ApiErrors); }
                finally { histogram.Add(timer.Elapsed.TotalMilliseconds); }
            }
            await Task.Delay(250, ct);
        }
    }
    private static async Task ObserveAsync(Measurements metrics, ConnectorService connectors, string[] ids, MqttPeer mqtt, ModbusPeer plc, ProtocolHost http, CancellationToken ct, CancellationTokenSource lifetime) {
        var clock = Stopwatch.StartNew(); var nextHeap = 60d; var nextProcess = 0d; var nextResource = 0d;
        using var process = Process.GetCurrentProcess();
        while (!ct.IsCancellationRequested) {
            foreach (var item in SourceMemoryBudget.Snapshot()) {
                metrics.HighBudgets.AddOrUpdate(item.Key, item.Value, (_, previous) => Math.Max(previous, item.Value));
                if (!GlobalCaps.TryGetValue(item.Key, out var cap) || item.Value > cap) { metrics.Failures.Enqueue("Global accounting exceeded " + item.Key); lifetime.Cancel(); }
            }
            foreach (var id in ids.Where(id => id.StartsWith("mqtt", StringComparison.Ordinal))) {
                var snapshot = JsonSerializer.SerializeToElement(connectors.SourceDiagnostics(id));
                if (snapshot.TryGetProperty("diagnostics", out var diagnostics) && diagnostics.ValueKind == JsonValueKind.Object)
                    foreach (var metric in diagnostics.EnumerateObject()) if (metric.Value.ValueKind == JsonValueKind.Number && metric.Value.TryGetInt64(out var value))
                        metrics.MqttHighMetrics.AddOrUpdate(metric.Name, value, (_, previous) => Math.Max(previous, value));
            }
            if (clock.Elapsed.TotalSeconds >= nextResource) {
                process.Refresh(); var rss = process.WorkingSet64;
                metrics.Resources.Enqueue(new(clock.Elapsed.TotalSeconds, metrics.Phase, GC.GetTotalMemory(false), rss, process.PeakWorkingSet64,
                    process.TotalProcessorTime.TotalSeconds, mqtt.Active, plc.Active, http.ActiveMtStreams)); nextResource += 1;
                if (rss > 2L << 30) { metrics.Failures.Enqueue("Owned profile exceeded2GiB RSS guard."); lifetime.Cancel(); }
            }
            if (clock.Elapsed.TotalSeconds >= nextHeap) {
                if (metrics.Phase == "steady") metrics.CollectHeap("steady", Stopwatch.GetElapsedTime(metrics.SteadyStart).TotalSeconds);
                nextHeap += 60;
            }
            if (clock.Elapsed.TotalSeconds >= nextProcess) { metrics.HighWorkerProcesses = Math.Max(metrics.HighWorkerProcesses, WorkerProcesses()); nextProcess += 5; }
            await Task.Delay(100, ct);
        }
    }

    private sealed class Histogram
    {
        private readonly long[] buckets = new long[10001]; private long count, maximum;
        public long Count => Interlocked.Read(ref count);
        public double P95 => Percentile(.95);
        public void Add(double milliseconds) { var rounded = (long)Math.Ceiling(Math.Max(0, milliseconds)); Interlocked.Increment(ref buckets[Math.Min(10000, rounded)]); Interlocked.Increment(ref count); long old; do { old = Interlocked.Read(ref maximum); if (old >= rounded) break; } while (Interlocked.CompareExchange(ref maximum, rounded, old) != old); }
        private double Percentile(double quantile) { var required = (long)Math.Ceiling(Count * quantile); if (required == 0) return 0; long sum = 0; for (var index = 0; index < buckets.Length; index++) if ((sum += Interlocked.Read(ref buckets[index])) >= required) return index; return 10000; }
        public object Report() => new { count = Count, p50Ms = Percentile(.5), p95Ms = P95, p99Ms = Percentile(.99), maximumMs = Interlocked.Read(ref maximum), histogramCapMs = 10000 };
    }
    private sealed class Phase
    {
        public long Sent, ApiErrors; public double Seconds;
        public Histogram Plc { get; } = new(); public Histogram Readiness { get; } = new(); public Histogram Diagnostics { get; } = new();
        public object Report() => new { durationSeconds = Seconds, mqttSent = Sent, mqttActualPerSecond = Sent / Math.Max(1, Seconds), readiness = Readiness.Report(), diagnostics = Diagnostics.Report(), plcDelay = Plc.Report(), apiErrors = ApiErrors };
    }
    private sealed record Resource(double Second, string Phase, long ManagedBytes, long RssBytes, long PeakRssBytes, double CpuSeconds, int MqttConnections, int ModbusConnections, int MtStreams);
    private sealed record Heap(string Phase, double Second, long Bytes, int Gen2Collections);
    private sealed class Measurements
    {
        public string Phase = "setup"; public long SteadyStart; public int Churns; public double AcquisitionShutdownMs;
        public readonly int InitialWorkerProcesses = WorkerProcesses(); public int HighWorkerProcesses, FinalWorkerProcesses;
        public readonly ConcurrentDictionary<string, Phase> Phases = new(StringComparer.Ordinal);
        public readonly ConcurrentDictionary<string, long> HighBudgets = new(StringComparer.Ordinal);
        public readonly ConcurrentDictionary<string, long> MqttHighMetrics = new(StringComparer.Ordinal);
        public readonly ConcurrentQueue<string> Failures = new(); public readonly ConcurrentQueue<Resource> Resources = new(); public readonly ConcurrentQueue<Heap> HeapSamples = new();
        public IReadOnlyDictionary<string, long> FinalBudgets = new Dictionary<string, long>();
        private long lastPlc;
        public Phase For(string name) => Phases.GetOrAdd(name, _ => new());
        public void SetPhase(string phase) { Phase = phase; ResetPlcTick(); }
        public void ResetPlcTick() => Interlocked.Exchange(ref lastPlc, 0);
        public void PlcTick() { var now = Stopwatch.GetTimestamp(); var prior = Interlocked.Exchange(ref lastPlc, now); if (prior != 0) For(Phase).Plc.Add(Math.Max(0, Stopwatch.GetElapsedTime(prior, now).TotalMilliseconds - 100)); }
        public void CollectHeap(string phase, double second) { GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced, blocking: true, compacting: true); GC.WaitForPendingFinalizers(); GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced, blocking: true, compacting: true); HeapSamples.Enqueue(new(phase, second, GC.GetTotalMemory(false), GC.CollectionCount(2))); }
        public object Report(int duration, ProtocolHost http, MqttPeer mqtt, ModbusPeer plc) => new {
            phases = Phases.ToDictionary(pair => pair.Key, pair => pair.Value.Report()), trackedGlobalHighwaterBytes = HighBudgets, finalTrackedBytes = FinalBudgets,
            mqttBoundaryHighwaterMetrics = MqttHighMetrics,
            heapSamples = HeapSamples.ToArray(), resources = Resources.ToArray(), firstLastHeapWindowSeconds = Math.Min(600, duration / 3d),
            mtDocuments = http.MtDocuments, mtActiveStreams = http.ActiveMtStreams, i3xBatches = http.I3xBatches, i3xBatchSizes = http.I3xReadSizes,
            mqttPackets = mqtt.Packets, mqttPayloadBytes = mqtt.Packets * 1024, mqttWireBytes = mqtt.WireBytes, mqttConnections = mqtt.Accepted, mqttActive = mqtt.Active,
            modbusRequests = plc.Requests, modbusConnections = plc.Accepted, modbusActive = plc.Active, churns = Churns, acquisitionShutdownMs = AcquisitionShutdownMs,
            initialWorkerProcesses = InitialWorkerProcesses, highWorkerProcesses = HighWorkerProcesses, finalWorkerProcesses = FinalWorkerProcesses, failures = Failures.ToArray()
        };
    }

    private sealed class ProtocolHost : IAsyncDisposable
    {
        private readonly WebApplication app; private readonly object sequenceGate = new(); private ulong sequence = 1;
        private CancellationTokenSource mtEpoch = new(); private long tick;
        public string Address { get; private set; } = "";
        public long MtDocuments, I3xBatches; public int ActiveMtStreams;
        public ConcurrentDictionary<int, long> I3xReadSizes { get; } = new();
        private ProtocolHost(WebApplication app) { this.app = app; }
        public static async Task<ProtocolHost> CreateAsync(ProjectCatalog catalog, TagEngine tags, GatewayReadiness readiness, Measurements metrics, CancellationToken ct) {
            var builder = WebApplication.CreateSlimBuilder(); builder.Logging.ClearProviders();
            builder.WebHost.ConfigureKestrel(options => { GatewayReadiness.ConfigureTransport(options); options.Listen(IPAddress.Loopback, 0); });
            builder.Services.Configure<Microsoft.AspNetCore.Http.Json.JsonOptions>(options => { options.SerializerOptions.Converters.Add(new ExactInt64JsonConverter()); options.SerializerOptions.Converters.Add(new ExactUInt64JsonConverter()); });
            builder.Services.AddSingleton(readiness);
            var app = builder.Build(); var host = new ProtocolHost(app);
            app.MapGet("/api/ready", (HttpContext context) => GatewayReadiness.Respond(context, readiness));
            app.MapGet("/api/connections/{id}/diagnostics", (string id) => GatewayConnections.Snapshot(id, catalog, tags));
            app.MapGet("/i3x/info", () => new { specVersion = "1.0", serverVersion = "synthetic-source-load", capabilities = new { subscribe = new { stream = false } } });
            app.MapGet("/i3x/objecttypes", () => new { success = true, result = new[] { new { elementId = "integer", schema = new { type = "integer" } } } });
            app.MapGet("/i3x/objects", () => new { success = true, result = Enumerable.Range(0, I3xCount).Select(index => new { elementId = "id#" + index, displayName = "P" + index, typeElementId = "integer", isComposition = false }) });
            app.MapPost("/i3x/objects/value", async (HttpContext context) => {
                using var body = await JsonDocument.ParseAsync(context.Request.Body, cancellationToken: context.RequestAborted);
                var ids = body.RootElement.GetProperty("elementIds").EnumerateArray().Select(item => item.GetString()!).ToArray();
                if (ids.Length is < 1 or > 250) return Results.StatusCode(400);
                Interlocked.Increment(ref host.I3xBatches); host.I3xReadSizes.AddOrUpdate(ids.Length, 1, (_, value) => value + 1);
                var reading = Interlocked.Increment(ref host.tick); var timestamp = Timestamp();
                return Results.Json(new { success = true, results = ids.Select(id => new { elementId = id, success = true, result = new { value = reading, quality = "Good", timestamp } }).ToArray() });
            });
            app.MapGet("/mt/load/probe", () => Results.Text(Probe(), "application/xml"));
            app.MapGet("/mt/load/current", () => Results.Text(host.Streams(true), "application/xml"));
            app.MapGet("/mt/load/sample", async (HttpContext context) => {
                Interlocked.Increment(ref host.ActiveMtStreams);
                using var streamStop = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, host.mtEpoch.Token);
                context.Response.ContentType = "multipart/x-mixed-replace; boundary=source-load-boundary";
                try {
                    while (!streamStop.IsCancellationRequested) {
                        var document = Encoding.UTF8.GetBytes(host.Streams(false));
                        await context.Response.Body.WriteAsync("--source-load-boundary\r\nContent-Type: application/xml\r\n\r\n"u8.ToArray(), streamStop.Token);
                        var split = Math.Min(67, document.Length); await context.Response.Body.WriteAsync(document.AsMemory(0, split), streamStop.Token);
                        await context.Response.Body.WriteAsync(document.AsMemory(split), streamStop.Token);
                        await context.Response.Body.WriteAsync("\r\n"u8.ToArray(), streamStop.Token); await context.Response.Body.FlushAsync(streamStop.Token);
                        Interlocked.Increment(ref host.MtDocuments); await Task.Delay(100, streamStop.Token);
                    }
                } catch (OperationCanceledException) when (streamStop.IsCancellationRequested) { }
                catch (IOException) { }
                finally { Interlocked.Decrement(ref host.ActiveMtStreams); }
            });
            await app.StartAsync(ct); host.Address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single(); return host;
        }
        public void DropMtStream() { var prior = Interlocked.Exchange(ref mtEpoch, new()); prior.Cancel(); prior.Dispose(); }
        private static string Timestamp() => DateTimeOffset.UtcNow.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
        private static string Probe() {
            var items = new StringBuilder();
            for (var index = 0; index < MtCount - 3; index++) items.Append($"<DataItem id=\"i{index}\" name=\"P{index}\" type=\"PART_COUNT\" category=\"EVENT\"/>");
            items.Append("<DataItem id=\"c\" name=\"Condition\" type=\"SYSTEM\" category=\"CONDITION\"/><DataItem id=\"ds\" name=\"Dataset\" type=\"VARIABLE\" category=\"EVENT\" representation=\"DATA_SET\"/><DataItem id=\"tb\" name=\"Table\" type=\"VARIABLE\" category=\"EVENT\" representation=\"TABLE\"/>");
            return "<MTConnectDevices xmlns=\"urn:mtconnect.org:MTConnectDevices:2.8\"><Header instanceId=\"1\" version=\"synthetic-load\"/><Devices><Device id=\"load\" uuid=\"load\" name=\"Load\"><DataItems>" + items + "</DataItems></Device></Devices></MTConnectDevices>";
        }
        private string Streams(bool current) {
            lock (sequenceGate) {
                var stamp = Timestamp(); var observations = new StringBuilder(); var reading = Interlocked.Read(ref tick);
                for (var index = 0; index < MtCount - 3; index++) observations.Append($"<PartCount dataItemId=\"i{index}\" sequence=\"{sequence++}\" timestamp=\"{stamp}\">{reading + index}</PartCount>");
                observations.Append($"<VariableDataSet dataItemId=\"ds\" sequence=\"{sequence++}\" timestamp=\"{stamp}\"{(current ? " resetTriggered=\"MANUAL\"" : "")}><Entry key=\"a\">{reading}</Entry></VariableDataSet>");
                observations.Append($"<VariableTable dataItemId=\"tb\" sequence=\"{sequence++}\" timestamp=\"{stamp}\"><Entry key=\"r\"><Cell key=\"x\">{reading}</Cell></Entry></VariableTable>");
                var condition = $"<Normal dataItemId=\"c\" sequence=\"{sequence++}\" timestamp=\"{stamp}\"/>";
                return $"<MTConnectStreams xmlns=\"urn:mtconnect.org:MTConnectStreams:2.8\"><Header instanceId=\"1\" firstSequence=\"1\" lastSequence=\"{sequence - 1}\" nextSequence=\"{sequence}\"/><Streams><DeviceStream uuid=\"load\"><ComponentStream><Events>{observations}</Events><Condition>{condition}</Condition></ComponentStream></DeviceStream></Streams></MTConnectStreams>";
            }
        }
        public async Task StopAsync() { DropMtStream(); using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(2)); await app.StopAsync(stop.Token); }
        public async ValueTask DisposeAsync() { await StopAsync(); await app.DisposeAsync(); mtEpoch.Dispose(); }
    }

    private abstract class TcpPeer : IAsyncDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0); protected readonly CancellationTokenSource Stop = new();
        protected readonly ConcurrentDictionary<int, TcpClient> Clients = new(); private readonly ConcurrentDictionary<int, Task> handlers = new(); private readonly Task accept;
        public int Port { get; } public int Active => Clients.Count; public long Accepted;
        protected TcpPeer() { listener.Start(32); Port = ((IPEndPoint)listener.LocalEndpoint).Port; accept = AcceptAsync(); }
        private async Task AcceptAsync() {
            while (!Stop.IsCancellationRequested) {
                TcpClient client; try { client = await listener.AcceptTcpClientAsync(Stop.Token); } catch (Exception) when (Stop.IsCancellationRequested) { return; }
                client.NoDelay = true; var id = checked((int)Interlocked.Increment(ref Accepted)); Clients[id] = client;
                var task = Handle(id, client); handlers[id] = task;
                _ = task.ContinueWith(_ => handlers.TryRemove(id, out var ignored), CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            }
        }
        private async Task Handle(int id, TcpClient client) { try { await ServeAsync(id, client, Stop.Token); } catch (Exception error) when (error is IOException or SocketException or OperationCanceledException or ObjectDisposedException) { } finally { Clients.TryRemove(id, out _); client.Dispose(); } }
        protected abstract Task ServeAsync(int id, TcpClient client, CancellationToken ct);
        public virtual void Disconnect() { foreach (var client in Clients.Values) client.Dispose(); }
        public async Task StopAsync() { if (Stop.IsCancellationRequested) return; Stop.Cancel(); listener.Stop(); Disconnect(); await accept; await Task.WhenAll(handlers.Values).WaitAsync(TimeSpan.FromSeconds(2)); }
        public async ValueTask DisposeAsync() { await StopAsync(); Stop.Dispose(); }
    }
    private sealed class ModbusPeer : TcpPeer
    {
        public long Requests;
        protected override async Task ServeAsync(int id, TcpClient client, CancellationToken ct) {
            var stream = client.GetStream(); var header = new byte[7];
            while (!ct.IsCancellationRequested) {
                await stream.ReadExactlyAsync(header, ct); var length = BinaryPrimitives.ReadUInt16BigEndian(header.AsSpan(4));
                if (length is < 2 or > 260) throw new IOException("Synthetic Modbus request length."); var body = new byte[length - 1]; await stream.ReadExactlyAsync(body, ct);
                if (body.Length != 5 || body[0] != 3) throw new IOException("Synthetic PLC accepts only configured read registers.");
                var count = BinaryPrimitives.ReadUInt16BigEndian(body.AsSpan(3)); if (count is < 1 or > 125) throw new IOException("Synthetic PLC register count.");
                var response = new byte[9 + count * 2]; header.CopyTo(response, 0); BinaryPrimitives.WriteUInt16BigEndian(response.AsSpan(4), (ushort)(3 + count * 2));
                response[7] = 3; response[8] = (byte)(count * 2); var value = (ushort)Interlocked.Increment(ref Requests);
                for (var index = 0; index < count; index++) BinaryPrimitives.WriteUInt16BigEndian(response.AsSpan(9 + index * 2), value);
                await stream.WriteAsync(response, ct);
            }
        }
    }
    private sealed class MqttPeer : TcpPeer
    {
        private sealed class Subscriber(int group, Stream stream, bool v5) { public readonly int Group = group; public readonly Stream Stream = stream; public readonly bool V5 = v5; public readonly SemaphoreSlim Writes = new(1); }
        private readonly ConcurrentDictionary<int, Subscriber> subscribers = new(); public int ReadyGroups => subscribers.Values.Select(item => item.Group).Distinct().Count();
        public long Packets, WireBytes;
        protected override async Task ServeAsync(int id, TcpClient client, CancellationToken ct) {
            var stream = client.GetStream(); var connect = await PacketAsync(stream, ct);
            if (connect.Header != 0x10 || connect.Body.Length < 10) throw new IOException("Synthetic MQTT requires CONNECT."); var v5 = connect.Body[6] == 5;
            await SendAsync(stream, 0x20, v5 ? [0, 0, 0] : [0, 0], ct); Subscriber? subscriber = null;
            try {
                while (!ct.IsCancellationRequested) {
                    var packet = await PacketAsync(stream, ct);
                    if (packet.Header == 0x82) {
                        var offset = 2; if (v5) { var propertyLength = Variable(packet.Body, ref offset); offset += propertyLength; }
                        var filters = new List<string>();
                        while (offset < packet.Body.Length) { var size = BinaryPrimitives.ReadUInt16BigEndian(packet.Body.AsSpan(offset)); offset += 2;
                            filters.Add(Encoding.UTF8.GetString(packet.Body, offset, size)); offset += size + 1; }
                        var group = int.Parse(filters[0].Split('/')[1], CultureInfo.InvariantCulture);
                        subscriber ??= new(group, stream, v5); subscribers[id] = subscriber;
                        var ack = new byte[2 + (v5 ? 1 : 0) + filters.Count]; ack[0] = packet.Body[0]; ack[1] = packet.Body[1];
                        await subscriber.Writes.WaitAsync(ct); try { await SendAsync(stream, 0x90, ack, ct); } finally { subscriber.Writes.Release(); }
                    } else if (packet.Header == 0xA2) {
                        var ack = v5 ? new byte[] { packet.Body[0], packet.Body[1], 0, 0 } : new byte[] { packet.Body[0], packet.Body[1] };
                        await SendAsync(stream, 0xB0, ack, ct);
                    } else if (packet.Header == 0xC0) {
                        if (subscriber is not null) await subscriber.Writes.WaitAsync(ct);
                        try { await SendAsync(stream, 0xD0, [], ct); } finally { subscriber?.Writes.Release(); }
                    } else if (packet.Header == 0xE0) return;
                    else throw new IOException("Synthetic MQTT received an unsupported client packet.");
                }
            } finally { subscribers.TryRemove(id, out _); }
        }
        public override void Disconnect() { subscribers.Clear(); base.Disconnect(); }
        public async Task<bool> PublishAsync(int index, long reading, CancellationToken ct) {
            var group = index / (MqttCount / MqttGroups); var subscriber = subscribers.Values.FirstOrDefault(item => item.Group == group);
            if (subscriber is null) return false;
            var topic = Encoding.UTF8.GetBytes(MqttTopic(index)); var body = new byte[2 + topic.Length + (subscriber.V5 ? 1 : 0) + 1024];
            BinaryPrimitives.WriteUInt16BigEndian(body, (ushort)topic.Length); topic.CopyTo(body, 2); var offset = 2 + topic.Length + (subscriber.V5 ? 1 : 0);
            body.AsSpan(offset).Fill((byte)' '); Encoding.UTF8.GetBytes(reading.ToString(CultureInfo.InvariantCulture), body.AsSpan(offset));
            await subscriber.Writes.WaitAsync(ct);
            try {
                // A phase ends between packets. Cancelling a partial packet and reusing
                // that byte stream would manufacture an invalid publisher protocol.
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(Stop.Token); deadline.CancelAfter(TimeSpan.FromSeconds(2));
                var bytes = await SendAsync(subscriber.Stream, 0x30, body, deadline.Token);
                Interlocked.Increment(ref Packets); Interlocked.Add(ref WireBytes, bytes); return true;
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException) { return false; }
            finally { subscriber.Writes.Release(); }
        }
        private static async Task<(byte Header, byte[] Body)> PacketAsync(Stream stream, CancellationToken ct) {
            var header = new byte[1]; await stream.ReadExactlyAsync(header, ct); var length = 0; var multiplier = 1;
            for (var index = 0; index < 4; index++) { var next = new byte[1]; await stream.ReadExactlyAsync(next, ct); length += (next[0] & 127) * multiplier;
                if ((next[0] & 128) == 0) { if (length > 272 * 1024) throw new IOException("Synthetic MQTT receive bound."); var body = new byte[length]; await stream.ReadExactlyAsync(body, ct); return (header[0], body); } multiplier *= 128; }
            throw new IOException("Malformed MQTT remaining length.");
        }
        private static int Variable(byte[] bytes, ref int offset) { var value = 0; var multiplier = 1; for (var index = 0; index < 4; index++) { var next = bytes[offset++]; value += (next & 127) * multiplier; if ((next & 128) == 0) return value; multiplier *= 128; } throw new IOException("Malformed MQTT properties."); }
        private static async Task<int> SendAsync(Stream stream, byte header, byte[] body, CancellationToken ct) {
            var length = body.Length; var prefix = new byte[5]; prefix[0] = header; var used = 1;
            do { var digit = length % 128; length /= 128; prefix[used++] = (byte)(digit | (length == 0 ? 0 : 128)); } while (length != 0);
            var packet = new byte[used + body.Length]; prefix.AsSpan(0, used).CopyTo(packet); body.CopyTo(packet, used);
            await stream.WriteAsync(packet, ct); return packet.Length;
        }
    }
}
