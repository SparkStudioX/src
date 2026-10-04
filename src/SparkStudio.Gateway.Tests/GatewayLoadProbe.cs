using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

/// <summary>Opt-in, finite synthetic measurements. Never opens installed gateway data or a network connector.</summary>
internal static class GatewayLoadProbe
{
    private const int Writers = 8;
    private const int SeedCycles = 120;
    private const long MaximumDiskBytes = 1536L * 1024 * 1024;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public static async Task RunAsync(string[] args)
    {
        string Option(string name, string fallback)
        {
            var index = Array.IndexOf(args, name);
            if (index < 0) return fallback;
            if (index + 1 >= args.Length) throw new ArgumentException(name + " requires a value.");
            return args[index + 1];
        }
        var seconds = int.Parse(Option("--seconds", "30"), System.Globalization.CultureInfo.InvariantCulture);
        if (seconds is < 5 or > 120) throw new ArgumentException("--seconds must be between 5 and 120 per stage.");
        var selected = Option("--load-stages", "all");
        if (selected is not ("all" or "memory" or "history")) throw new ArgumentException("--load-stages is all, memory, or history.");
        var tagCounts = Option("--tag-counts", "100,500,1000").Split(',').Select(value => int.Parse(value, System.Globalization.CultureInfo.InvariantCulture)).Distinct().ToArray();
        if (tagCounts.Length is < 1 or > 10 || tagCounts.Any(count => count < Writers || count > TagModel.MaximumTags))
            throw new ArgumentException($"--tag-counts requires 1–10 comma-separated counts between {Writers} and {TagModel.MaximumTags}.");
        var repository = FindRepository();
        var dataRoot = Path.GetFullPath(Path.Combine(repository, ".data"));
        var output = Path.GetFullPath(Option("--output-dir", Path.Combine(dataRoot, "load-tests", DateTimeOffset.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N")[..8])));
        var pathComparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        if (!output.StartsWith(dataRoot + Path.DirectorySeparatorChar, pathComparison))
            throw new ArgumentException("Load output must be a new directory beneath this checkout's .data directory.");
        if (Directory.Exists(output) || File.Exists(output)) throw new ArgumentException("Refusing to reuse an existing output directory.");
        for (var ancestor = new DirectoryInfo(output).Parent; ancestor is not null; ancestor = ancestor.Parent)
            if (ancestor.Exists && (ancestor.Attributes & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("Load output cannot use symbolic links.");
        Directory.CreateDirectory(output);
        var stages = new List<object>();
        var report = new JsonObject
        {
            ["startedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["outputDirectory"] = output,
            ["machine"] = Environment.MachineName, ["os"] = RuntimeInformation.OSDescription,
            ["runtime"] = RuntimeInformation.FrameworkDescription, ["logicalProcessors"] = Environment.ProcessorCount,
            ["secondsPerStage"] = seconds, ["writers"] = Writers,
            ["configuredTagLimit"] = TagModel.MaximumTags, ["memoryTagCounts"] = JsonSerializer.SerializeToNode(tagCounts),
            ["scope"] = "In-process production TagEngine and ProcessDataService, synthetic memory tags only; no HTTP, OPC, installed gateway data, or production capacity guarantee.",
            ["methodology"] = "Memory stages run eight saturated writers. History stages run eight writers paced at 8 ms per write (nominal <=1000 writes/sec), and 0/1/4 query workers with 100 ms think time. Sample() is called then delayed 250 ms, matching the production fixed-delay loop, not a claimed fixed 4 Hz. Queries select 32 rotating paths with up to 1000 points each. 120 seeded cycles use the production Sample API with a fixture clock advancing one second; seeded rows are reported separately. Measured stages use wall time. Latencies use bounded logarithmic histograms with <=1% bucket rounding. Resource use includes the in-process load generator. No acceptance threshold is inferred from throughput.",
            ["limits"] = $"Each stage is bounded to 5–120 seconds plus setup/teardown; resource monitor cancels at 1.5 GiB fixture disk or 2 GiB process working set. Production tag model permits at most {TagModel.MaximumTags} expanded tags. Over-limit rejection probes never apply invalid fixtures."
        };
        void Save()
        {
            report["stages"] = JsonSerializer.SerializeToNode(stages, Json);
            File.WriteAllText(Path.Combine(output, "report.json"), report.ToJsonString(Json));
        }
        Save();
        try
        {
            report["capacityProbes"] = JsonSerializer.SerializeToNode(CapacityProbes(Path.Combine(output, "capacity")), Json);
            if (selected is "all" or "memory")
                foreach (var count in tagCounts)
                {
                    stages.Add(await StageAsync(output, "memory-" + count, count, seconds, -1)); Save();
                }
            if (selected is "all" or "history")
                foreach (var queries in new[] { 0, 1, 4 })
                {
                    stages.Add(await StageAsync(output, "history-1000-query-" + queries, 1000, seconds, queries)); Save();
                }
            report["completedAt"] = DateTimeOffset.UtcNow.ToString("O");
            report["diskBytes"] = DiskBytes(output);
            Save();
            Console.WriteLine("Gateway load report: " + Path.Combine(output, "report.json"));
        }
        catch (Exception error)
        {
            report["failedAt"] = DateTimeOffset.UtcNow.ToString("O"); report["failure"] = error.GetType().Name + ": " + error.Message;
            report["failureDetails"] = error.ToString(); Save(); throw;
        }
    }

    private static string FindRepository()
    {
        foreach (var root in new[] { Environment.CurrentDirectory, AppContext.BaseDirectory })
            for (var folder = new DirectoryInfo(root); folder is not null; folder = folder.Parent)
                if (File.Exists(Path.Combine(folder.FullName, "src", "SparkStudio.Gateway.Tests", "SparkStudio.Gateway.Tests.csproj"))) return folder.FullName;
        throw new InvalidOperationException("Run from the source checkout or its built test executable.");
    }

    private static JsonObject Package(int count) => new()
    {
        ["format"] = "sparkstudio.tags", ["version"] = TagModel.FormatVersion,
        ["scanGroups"] = new JsonArray(), ["udtDefinitions"] = new JsonArray(), ["instances"] = new JsonArray(), ["hierarchy"] = new JsonArray(),
        ["tags"] = new JsonArray(Enumerable.Range(0, count).Select(index => (JsonNode)new JsonObject
        { ["path"] = TagPath(index), ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = 0 }).ToArray())
    };
    private static string TagPath(int index) => $"[default]LoadFixture/T{index:D5}";
    private static object[] CapacityProbes(string directory)
    {
        var store = new ProjectStore(directory, new EphemeralDataProtectionProvider());
        return new[] { TagModel.MaximumTags + 1, TagModel.MaximumTags * 2 }.Select(count =>
        {
            var timer = Stopwatch.StartNew();
            try { store.PreviewTagImport(Package(count)); return (object)new { requestedTags = count, rejected = false, elapsedMs = timer.Elapsed.TotalMilliseconds, message = "Unexpectedly accepted; fixture was not applied." }; }
            catch (ArgumentException error) { return new { requestedTags = count, rejected = true, elapsedMs = timer.Elapsed.TotalMilliseconds, message = error.Message }; }
        }).ToArray();
    }

    private static async Task<object> StageAsync(string output, string name, int count, int seconds, int queryWorkers)
    {
        Console.WriteLine($"Starting {name}: {count} tags, {seconds}s measured, query workers={Math.Max(0, queryWorkers)}.");
        var stageWatch = Stopwatch.StartNew();
        var directory = Path.Combine(output, name);
        var protection = new EphemeralDataProtectionProvider();
        var store = new ProjectStore(directory, protection);
        var package = Package(count); var preview = store.PreviewTagImport(package);
        store.ApplyTagImport(new(package, preview.Revision, preview.PreviewToken));
        using var connectors = new ConnectorService(directory);
        using var tags = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance);
        await tags.StartAsync(CancellationToken.None);
        try
        {
            var ready = Stopwatch.StartNew();
            while (tags.Snapshot().Length != count && ready.Elapsed < TimeSpan.FromSeconds(20)) await Task.Delay(20);
            if (tags.Snapshot().Length != count) throw new InvalidOperationException("Memory definitions did not initialize.");
            var configurationBytes = File.ReadAllBytes(Path.Combine(directory, "tags.json"));
            using var clock = new FixtureClock();
            using var processData = queryWorkers >= 0 ? new ProcessDataService(directory, tags, new RecoveryQuarantine(directory), NullLogger<ProcessDataService>.Instance, clock) : null;
            var paths = Enumerable.Range(0, count).Select(TagPath).ToArray();
            var historyStart = DateTimeOffset.UtcNow.AddSeconds(-SeedCycles - 1);
            long seededRows = 0;
            if (processData is not null)
            {
                processData.Save(new(1, 7, [], paths.Select(path => new HistoryDefinition(path, true, 0, 250, 7)).ToArray()));
                for (var cycle = 0; cycle < SeedCycles; cycle++)
                {
                    clock.Set(historyStart.AddSeconds(cycle)); processData.Sample();
                    if ((cycle % 20) == 0 && DiskBytes(output) > MaximumDiskBytes) throw new IOException("Fixture disk limit exceeded while preparing history.");
                }
                seededRows = HistoryCount(directory); clock.UseWallTime();
            }
            var setupMs = stageWatch.Elapsed.TotalMilliseconds;
            var errors = new ConcurrentQueue<string>();
            long errorCount = 0;
            void Error(Exception error)
            {
                Interlocked.Increment(ref errorCount);
                if (errors.Count < 20) errors.Enqueue(error.GetType().Name + ": " + error.Message);
            }
            using var stop = new CancellationTokenSource();
            using var start = new ManualResetEventSlim();
            var writes = Enumerable.Range(0, Writers).Select(_ => new Latencies()).ToArray();
            var queries = Enumerable.Range(0, Math.Max(0, queryWorkers)).Select(_ => new Latencies()).ToArray();
            var sampleTimes = new Latencies(); var sampleStarts = new List<double>();
            var expected = new int[count]; var successfulWrites = new long[Writers];
            long queryBytes = 0;
            var measured = new Stopwatch();
            Task Worker(Action action) => Task.Factory.StartNew(() => { start.Wait(); action(); }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            var workers = Enumerable.Range(0, Writers).Select(writer => Worker(() =>
            {
                var index = writer; var value = 0;
                var inputPaths = new string[1]; var inputValues = new JsonElement[1];
                while (!stop.IsCancellationRequested)
                {
                    inputPaths[0] = paths[index]; inputValues[0] = JsonSerializer.SerializeToElement(++value);
                    var stamp = Stopwatch.GetTimestamp();
                    try
                    {
                        var status = tags.WriteMemory(inputPaths, inputValues)[0];
                        if (status != "Good") throw new InvalidOperationException("Write status: " + status);
                        expected[index] = value; successfulWrites[writer]++;
                    }
                    catch (Exception error) { Error(error); }
                    writes[writer].Add(Stopwatch.GetElapsedTime(stamp).TotalMilliseconds);
                    index += Writers; if (index >= count) index = writer;
                    if (queryWorkers >= 0) stop.Token.WaitHandle.WaitOne(8);
                }
            })).ToList();
            if (processData is not null)
            {
                workers.Add(Worker(() =>
                {
                    while (!stop.IsCancellationRequested)
                    {
                        sampleStarts.Add(measured.Elapsed.TotalMilliseconds);
                        var stamp = Stopwatch.GetTimestamp();
                        try { processData.Sample(); } catch (Exception error) { Error(error); }
                        sampleTimes.Add(Stopwatch.GetElapsedTime(stamp).TotalMilliseconds);
                        stop.Token.WaitHandle.WaitOne(250);
                    }
                }));
                for (var queryIndex = 0; queryIndex < queryWorkers; queryIndex++)
                {
                    var workerIndex = queryIndex;
                    workers.Add(Worker(() =>
                    {
                        var iteration = 0;
                        while (!stop.IsCancellationRequested)
                        {
                            var chosen = Enumerable.Range(0, 32).Select(i => paths[(iteration * 32 + workerIndex * 32 + i) % count]).ToArray(); iteration++;
                            var stamp = Stopwatch.GetTimestamp();
                            try
                            {
                                var result = processData.Query(new(chosen, historyStart.AddSeconds(-1), DateTimeOffset.UtcNow, 1000), _ => true);
                                queries[workerIndex].Add(Stopwatch.GetElapsedTime(stamp).TotalMilliseconds);
                                Interlocked.Add(ref queryBytes, JsonSerializer.SerializeToUtf8Bytes(result).Length);
                            }
                            catch (Exception error) { Error(error); }
                            stop.Token.WaitHandle.WaitOne(100);
                        }
                    }));
                }
            }
            using var process = Process.GetCurrentProcess(); process.Refresh();
            var cpuStart = process.TotalProcessorTime; var peakWorkingSet = process.WorkingSet64;
            var collections = new[] { GC.CollectionCount(0), GC.CollectionCount(1), GC.CollectionCount(2) };
            var allocated = GC.GetTotalAllocatedBytes();
            var definitionBuildsBefore = tags.DefinitionBuildCount; var checkpointsBefore = store.MemoryStateWriteCount;
            measured.Start(); start.Set();
            try
            {
                while (measured.Elapsed < TimeSpan.FromSeconds(seconds))
                {
                    await Task.Delay(Math.Min(500, Math.Max(1, (int)(seconds * 1000 - measured.Elapsed.TotalMilliseconds))));
                    process.Refresh(); peakWorkingSet = Math.Max(peakWorkingSet, process.WorkingSet64);
                    if (process.WorkingSet64 > 2L * 1024 * 1024 * 1024 || DiskBytes(output) > MaximumDiskBytes)
                    { Error(new InvalidOperationException("Resource safety cap reached; workload cancelled.")); break; }
                }
            }
            finally { stop.Cancel(); await Task.WhenAll(workers).WaitAsync(TimeSpan.FromSeconds(30)); }
            measured.Stop(); process.Refresh();
            var cpuMs = (process.TotalProcessorTime - cpuStart).TotalMilliseconds;
            var gcCounts = Enumerable.Range(0, 3).Select(index => GC.CollectionCount(index) - collections[index]).ToArray();
            var allocationBytes = GC.GetTotalAllocatedBytes() - allocated;
            var beforeFlush = store.MemoryStateWriteCount; store.FlushMemoryValues();
            var finalRead = tags.Read(paths, null);
            var valueMismatches = Enumerable.Range(0, count).Count(index => finalRead[index].Quality != "Good" || finalRead[index].Value is not JsonElement value || value.GetInt32() != expected[index]);
            var reloaded = new ProjectStore(directory, protection);
            var restartedValues = reloaded.GetTagDefinitions().OfType<JsonObject>().ToDictionary(tag => ProjectStore.Required(tag, "path"), tag => tag["value"]!.GetValue<int>());
            var restartMismatches = Enumerable.Range(0, count).Count(index => restartedValues[paths[index]] != expected[index]);
            var intervals = new Latencies();
            for (var index = 1; index < sampleStarts.Count; index++) intervals.Add(sampleStarts[index] - sampleStarts[index - 1]);
            var historical = processData is null ? null : HistoryEvidence(directory, seededRows);
            object? historyRestart = null;
            if (processData is not null)
            {
                using var restart = new ProcessDataService(directory, tags, new RecoveryQuarantine(directory), NullLogger<ProcessDataService>.Instance);
                var firstSeries = JsonSerializer.SerializeToElement(restart.Query(new([paths[0]], historyStart.AddSeconds(-1), DateTimeOffset.UtcNow, 1000), _ => true), Json);
                historyRestart = new { rowsForFirstTag = firstSeries.GetProperty("series")[0].GetProperty("points").GetArrayLength(), diagnostics = restart.Diagnostics() };
            }
            var writeLatency = Latencies.Merge(writes); var queryLatency = Latencies.Merge(queries);
            var totalWrites = successfulWrites.Sum();
            var result = new
            {
                name, configuredTags = count, historyTags = processData is null ? 0 : count, queryWorkers = Math.Max(queryWorkers, 0),
                setupMs, requestedSeconds = seconds, measuredSeconds = measured.Elapsed.TotalSeconds,
                successfulWrites = totalWrites, writesPerSecond = totalWrites / measured.Elapsed.TotalSeconds,
                writeLatencyMs = writeLatency.Report(), queryLatencyMs = queryLatency.Report(),
                queriesPerSecond = queryLatency.Count / measured.Elapsed.TotalSeconds, querySerializedBytes = queryBytes,
                sampleLatencyMs = sampleTimes.Report(), samplingIntervalMs = intervals.Report(),
                sampleCalls = sampleTimes.Count, achievedSampleCallsPerSecond = sampleTimes.Count / measured.Elapsed.TotalSeconds,
                targetFixedDelayMs = processData is null ? (int?)null : 250,
                sampleIntervalsOver375ms = sampleStarts.Zip(sampleStarts.Skip(1), (before, after) => after - before).Count(interval => interval > 375),
                cpuMs, averageCpuCoreEquivalent = cpuMs / measured.Elapsed.TotalMilliseconds,
                averageCpuMachinePercent = cpuMs / measured.Elapsed.TotalMilliseconds / Environment.ProcessorCount * 100,
                peakWorkingSetBytes = peakWorkingSet, allocatedBytes = allocationBytes, gcCollections = gcCounts,
                memoryCheckpointsDuringWork = beforeFlush - checkpointsBefore, memoryCheckpointsIncludingFinalFlush = store.MemoryStateWriteCount - checkpointsBefore,
                definitionBuildsBefore, definitionBuildsAfter = tags.DefinitionBuildCount,
                errors = errorCount, errorExamples = errors.ToArray(),
                correctness = new { finalValueMismatches = valueMismatches, restartValueMismatches = restartMismatches, tagConfigurationUnchanged = configurationBytes.SequenceEqual(File.ReadAllBytes(Path.Combine(directory, "tags.json"))) },
                history = historical, historyRestart, diskBytes = DiskBytes(directory), stageTotalSeconds = stageWatch.Elapsed.TotalSeconds
            };
            File.WriteAllText(Path.Combine(directory, "measurement.json"), JsonSerializer.Serialize(result, Json));
            Console.WriteLine($"Completed {name}: {totalWrites / measured.Elapsed.TotalSeconds:F0} writes/s, write p95 {writeLatency.Percentile(.95):F3} ms, sample p95 {sampleTimes.Percentile(.95):F3} ms, query p95 {queryLatency.Percentile(.95):F3} ms, errors {errorCount}.");
            if (errorCount != 0 || valueMismatches != 0 || restartMismatches != 0) Environment.ExitCode = 1;
            return result;
        }
        finally { await tags.StopAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(30)); }
    }

    private static SqliteConnection OpenHistory(string directory)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(directory, "process-data", "journal.sqlite"), Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
        connection.Open(); return connection;
    }
    private static long HistoryCount(string directory)
    {
        using var connection = OpenHistory(directory); using var command = connection.CreateCommand(); command.CommandText = "SELECT count(*) FROM history";
        return (long)command.ExecuteScalar()!;
    }
    private static object HistoryEvidence(string directory, long seededRows)
    {
        using var connection = OpenHistory(directory); using var command = connection.CreateCommand();
        command.CommandText = "SELECT path,recorded,quality FROM history WHERE sequence > $seed ORDER BY path,recorded,sequence";
        command.Parameters.AddWithValue("$seed", seededRows);
        long rows = 0, badQuality = 0, over375ms = 0; string? priorPath = null; long priorTime = 0;
        var gaps = new Latencies(); var perTag = new Dictionary<string, int>(StringComparer.Ordinal);
        using (var reader = command.ExecuteReader())
            while (reader.Read())
            {
                var path = reader.GetString(0); var recorded = reader.GetInt64(1); rows++;
                if (reader.GetString(2) != "Good") badQuality++;
                perTag[path] = perTag.GetValueOrDefault(path) + 1;
                if (path == priorPath) { var gap = recorded - priorTime; gaps.Add(gap); if (gap > 375) over375ms++; }
                priorPath = path; priorTime = recorded;
            }
        command.CommandText = "PRAGMA integrity_check"; command.Parameters.Clear(); var integrity = (string)command.ExecuteScalar()!;
        return new { seededRows, measuredRows = rows, totalRows = seededRows + rows, tagsWithMeasuredSamples = perTag.Count,
            minimumMeasuredSamplesPerTag = perTag.Count == 0 ? 0 : perTag.Values.Min(), maximumMeasuredSamplesPerTag = perTag.Count == 0 ? 0 : perTag.Values.Max(),
            badQualityRows = badQuality, recordedIntervalMs = gaps.Report(), recordedIntervalsOver375ms = over375ms, integrity };
    }
    private static long DiskBytes(string directory) => Directory.Exists(directory) ? Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories).Sum(path => new FileInfo(path).Length) : 0;

    private sealed class FixtureClock : TimeProvider, IDisposable
    {
        private long ticks;
        public override DateTimeOffset GetUtcNow() => ticks == 0 ? DateTimeOffset.UtcNow : new DateTimeOffset(ticks, TimeSpan.Zero);
        public void Set(DateTimeOffset now) => ticks = now.UtcTicks;
        public void UseWallTime() => ticks = 0;
        public void Dispose() { }
    }
    private sealed class Latencies
    {
        private readonly long[] bins = new long[2200];
        public long Count { get; private set; }
        private double total, maximum;
        public void Add(double milliseconds)
        {
            var index = milliseconds <= .001 ? 0 : Math.Min(bins.Length - 1, (int)Math.Ceiling(Math.Log(milliseconds / .001) / Math.Log(1.01)));
            bins[index]++; Count++; total += milliseconds; maximum = Math.Max(maximum, milliseconds);
        }
        public double Percentile(double percentile)
        {
            if (Count == 0) return 0;
            var target = (long)Math.Ceiling(Count * percentile); long sum = 0;
            for (var index = 0; index < bins.Length; index++) { sum += bins[index]; if (sum >= target) return Math.Min(maximum, .001 * Math.Pow(1.01, index)); }
            return maximum;
        }
        public object Report() => new { count = Count, mean = Count == 0 ? 0 : total / Count, p50 = Percentile(.50), p95 = Percentile(.95), p99 = Percentile(.99), max = maximum };
        public static Latencies Merge(IEnumerable<Latencies> inputs)
        {
            var result = new Latencies();
            foreach (var input in inputs)
            {
                result.Count += input.Count; result.total += input.total; result.maximum = Math.Max(result.maximum, input.maximum);
                for (var index = 0; index < result.bins.Length; index++) result.bins[index] += input.bins[index];
            }
            return result;
        }
    }
}
