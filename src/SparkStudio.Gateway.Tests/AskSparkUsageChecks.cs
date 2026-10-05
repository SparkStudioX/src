using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using SparkStudio.Gateway;

internal static class AskSparkUsageChecks
{
    public static int Run()
    {
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.AskSpark.Usage." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var checks = 0;
        void Check(bool condition, string name) { if (!condition) throw new InvalidOperationException(name); checks++; }
        try
        {
            var clock = new Clock(new DateTimeOffset(2026, 10, 31, 23, 59, 0, TimeSpan.Zero));
            var usage = new AskSparkUsage(directory, clock);
            using var one = usage.Reserve(700, 1000);
            var blocked = false;
            try { using var ignored = usage.Reserve(400, 1000); }
            catch (BadHttpRequestException error) when (error.StatusCode == 429) { blocked = true; }
            Check(blocked, "concurrent reservation cannot exceed monthly headroom");
            one.Complete(new(500, 400, 80, 20, 600));
            Check(usage.Snapshot(1000) is { UsedTokens: 200, CachedTokens: 400, TotalTokens: 600, Requests: 1, UncertainRequests: 0 }, "cached inputs excluded; output and thinking charged");
            Check(usage.Snapshot(1000) is { InputTokens: 500, OutputTokens: 80, ThoughtTokens: 20, UnclassifiedTokens: 0 }, "input includes cached tokens; response and thinking have separate counters");
            one.Complete(new(500, 0, 80, 20, 600));
            Check(usage.Snapshot(1000).UsedTokens == 200, "completion is idempotent");
            using (var rejected = usage.Reserve(300, 1000)) rejected.Release();
            Check(usage.Snapshot(1000) is { UsedTokens: 200, Requests: 1, UncertainRequests: 0, InputTokens: 500, OutputTokens: 80, ThoughtTokens: 20 }, "known rejected requests release their reservation without adding categorized usage");
            using (usage.Reserve(300, 1000)) { }
            usage = new AskSparkUsage(directory, clock);
            Check(usage.Snapshot(1000) is { UsedTokens: 500, UncertainRequests: 1 }, "unknown requests remain charged after restart");
            Check(usage.Snapshot(1000) is { InputTokens: 500, OutputTokens: 80, ThoughtTokens: 20 }, "categorized usage persists and excludes unconfirmed reservations");
            using var crossingMonth = usage.Reserve(100, 1000);
            clock.Now = clock.Now.AddMinutes(2);
            Check(usage.Snapshot(1000) is { UsedTokens: 0, Month: "2026-11", InputTokens: 0, OutputTokens: 0, ThoughtTokens: 0, UnclassifiedTokens: 0 }, "UTC month begins with fresh allowance and category counters");
            crossingMonth.Complete(new(40, 0, 10, 0, 50));
            Check(usage.Snapshot(1000).UsedTokens == 0, "late response charges its admission month");
            using (var unlimited = usage.Reserve(0, 0)) unlimited.Complete(new(1200, 1000, 100, 50, 1350));
            Check(usage.Snapshot(0) is { Limit: 0, UsedTokens: 350, CachedTokens: 1000, InputTokens: 1200, OutputTokens: 100, ThoughtTokens: 50 }, "unlimited requests still account actual categorized tokens");
            var legacyDirectory = Path.Combine(directory, "legacy");
            Directory.CreateDirectory(legacyDirectory);
            File.WriteAllText(Path.Combine(legacyDirectory, "ask-spark-usage.json"), """[{"id":"2026-11","used":350,"cached":1000,"total":1350,"requests":1,"uncertain":0}]""");
            var legacy = new AskSparkUsage(legacyDirectory, clock);
            Check(legacy.Snapshot(0) is { UsedTokens: 350, CachedTokens: 1000, InputTokens: null, OutputTokens: null, ThoughtTokens: null, UnclassifiedTokens: 1350 }, "legacy totals remain intact with an explicitly unknown breakdown");
            using (var rejected = legacy.Reserve(300, 0)) rejected.Release();
            Check(legacy.Snapshot(0).InputTokens is null, "rejected requests do not invent a legacy breakdown");
            using (var newer = legacy.Reserve(0, 0)) newer.Complete(new(100, 60, 20, 10, 135));
            legacy = new AskSparkUsage(legacyDirectory, clock);
            Check(legacy.Snapshot(0) is { UsedTokens: 425, CachedTokens: 1060, TotalTokens: 1485, InputTokens: 100, OutputTokens: 20, ThoughtTokens: 10, UnclassifiedTokens: 1355 }, "new categories accumulate while historical and uncategorized tokens remain identified across restart");
            var settings = new AskSparkSettings(directory, new EphemeralDataProtectionProvider());
            Check(settings.Snapshot() is { ModelStepLimit: 100, MonthlyTokenLimit: AskSparkSettings.DefaultMonthlyTokenLimit }, "100 steps and a bounded monthly allowance by default");
            settings.Save(new("0", false, AskSparkSettings.DefaultModel, ModelStepLimit: 65, MonthlyTokenLimit: 100000));
            Check(new AskSparkSettings(directory, new EphemeralDataProtectionProvider()).Snapshot() is { ModelStepLimit: 65, MonthlyTokenLimit: 100000 }, "configured limits persist without a credential");
            foreach (var steps in new[] { 0, 1001 })
            {
                var rejected = false;
                try { settings.Save(new(settings.Snapshot().Revision, false, AskSparkSettings.DefaultModel, ModelStepLimit: steps)); }
                catch (ArgumentException) { rejected = true; }
                Check(rejected, "model step range enforced");
            }
            return checks;
        }
        finally { Directory.Delete(directory, true); }
    }

    private sealed class Clock(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = now;
        public override DateTimeOffset GetUtcNow() => Now;
    }
}
