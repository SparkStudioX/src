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
            one.Complete(new(500, 0, 80, 20, 600));
            Check(usage.Snapshot(1000).UsedTokens == 200, "completion is idempotent");
            using (var rejected = usage.Reserve(300, 1000)) rejected.Release();
            Check(usage.Snapshot(1000) is { UsedTokens: 200, Requests: 1, UncertainRequests: 0 }, "known rejected requests release their reservation");
            using (usage.Reserve(300, 1000)) { }
            usage = new AskSparkUsage(directory, clock);
            Check(usage.Snapshot(1000) is { UsedTokens: 500, UncertainRequests: 1 }, "unknown requests remain charged after restart");
            using var crossingMonth = usage.Reserve(100, 1000);
            clock.Now = clock.Now.AddMinutes(2);
            Check(usage.Snapshot(1000) is { UsedTokens: 0, Month: "2026-11" }, "UTC month begins with fresh allowance");
            crossingMonth.Complete(new(40, 0, 10, 0, 50));
            Check(usage.Snapshot(1000).UsedTokens == 0, "late response charges its admission month");
            using (var unlimited = usage.Reserve(0, 0)) unlimited.Complete(new(1200, 1000, 100, 50, 1350));
            Check(usage.Snapshot(0) is { Limit: 0, UsedTokens: 350, CachedTokens: 1000 }, "unlimited requests still account actual tokens");
            var settings = new AskSparkSettings(directory, new EphemeralDataProtectionProvider());
            Check(settings.Snapshot() is { ModelStepLimit: 100, MonthlyTokenLimit: 0 }, "100 steps and unlimited monthly allowance default");
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
