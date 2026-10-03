using System.Globalization;
using System.Text.Json;

namespace SparkStudio.Gateway;

public sealed record AskSparkUsageSnapshot(string Month, long Limit, long UsedTokens, long CachedTokens, long TotalTokens, long Requests, long UncertainRequests, DateTimeOffset ResetsAt,
    long? InputTokens, long? OutputTokens, long? ThoughtTokens, long UnclassifiedTokens);

/// <summary>Gateway-wide monthly admission and accounting. Contains counters only, never prompts or credentials.</summary>
public sealed class AskSparkUsage
{
    private sealed record Month(string Id, long Used = 0, long Cached = 0, long Total = 0, long Requests = 0, long Uncertain = 0,
        long? Input = null, long? Output = null, long? Thought = null);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly object gate = new();
    private readonly string path;
    private readonly TimeProvider clock;
    private List<Month> months = [];

    public AskSparkUsage(string directory, TimeProvider? clock = null)
    {
        path = Path.Combine(directory, "ask-spark-usage.json");
        this.clock = clock ?? TimeProvider.System;
        if (!File.Exists(path)) return;
        RecoveryFileSystem.RejectLinks(path);
        if (new FileInfo(path).Length > 32_768) throw new InvalidDataException("Ask Spark usage data exceeds its size limit.");
        months = JsonSerializer.Deserialize<List<Month>>(File.ReadAllText(path), Json) ?? throw new InvalidDataException("Ask Spark usage data is invalid.");
        if (months.Count > 13 || months.Select(item => item.Id).Distinct().Count() != months.Count || months.Any(Invalid))
            throw new InvalidDataException("Ask Spark usage counters are invalid.");
    }

    public AskSparkUsageSnapshot Snapshot(long limit)
    {
        lock (gate)
        {
            var now = clock.GetUtcNow();
            var month = Current(now);
            return new(month.Id, limit, month.Used, month.Cached, month.Total, month.Requests, month.Uncertain,
                new DateTimeOffset(now.Year, now.Month, 1, 0, 0, 0, TimeSpan.Zero).AddMonths(1), month.Input, month.Output, month.Thought,
                month.Total - (month.Input ?? 0) - (month.Output ?? 0) - (month.Thought ?? 0));
        }
    }

    public AskSparkUsageReservation Reserve(long requested, long limit)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(requested);
        ArgumentOutOfRangeException.ThrowIfNegative(limit);
        lock (gate)
        {
            var month = Current(clock.GetUtcNow());
            if (limit > 0 && (month.Used >= limit || requested > limit - month.Used))
                throw new BadHttpRequestException("The monthly Ask Spark allowance has insufficient headroom for this request. An administrator can increase it in Gateway Settings → AI, or wait for the next UTC month.", 429);
            Commit(month with { Used = checked(month.Used + requested), Uncertain = checked(month.Uncertain + 1) });
            return new(this, month.Id, requested);
        }
    }

    internal void Finish(string id, long reserved, AskSparkTokenUsage? usage)
    {
        lock (gate)
        {
            var month = months.Single(item => item.Id == id);
            var total = Math.Max(0, usage?.TotalTokens ?? 0);
            var cached = Math.Clamp(usage?.CachedTokens ?? 0, 0, total);
            // Keep provider categories separate. Older ledger entries and uncategorized
            // provider tokens remain visible as an unknown breakdown, never inferred.
            var input = Math.Clamp(usage?.PromptTokens ?? 0, 0, total);
            var output = Math.Clamp(usage?.OutputTokens ?? 0, 0, total - input);
            var thought = Math.Clamp(usage?.ThoughtTokens ?? 0, 0, total - input - output);
            Commit(month with {
                Used = checked(month.Used - reserved + total - cached), Cached = checked(month.Cached + cached),
                Total = checked(month.Total + total), Requests = checked(month.Requests + (usage is null ? 0 : 1)), Uncertain = month.Uncertain - 1,
                Input = usage is null ? month.Input : checked((month.Input ?? 0) + input),
                Output = usage is null ? month.Output : checked((month.Output ?? 0) + output),
                Thought = usage is null ? month.Thought : checked((month.Thought ?? 0) + thought)
            });
        }
    }

    private Month Current(DateTimeOffset now) => months.Find(item => item.Id == now.ToString("yyyy-MM", CultureInfo.InvariantCulture))
        ?? new(now.ToString("yyyy-MM", CultureInfo.InvariantCulture), Input: 0, Output: 0, Thought: 0);

    private void Commit(Month next)
    {
        var updated = months.Where(item => item.Id != next.Id).Append(next).OrderByDescending(item => item.Id, StringComparer.Ordinal).Take(13).ToList();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        DurableJsonFile.Write(path, JsonSerializer.SerializeToNode(updated, Json)!);
        months = updated;
    }

    private static bool Invalid(Month month) => !DateTime.TryParseExact(month.Id, "yyyy-MM", CultureInfo.InvariantCulture, DateTimeStyles.None, out _)
        || month.Used < 0 || month.Cached < 0 || month.Total < 0 || month.Requests < 0 || month.Uncertain < 0
        || InvalidBreakdown(month);

    private static bool InvalidBreakdown(Month month) => month.Input < 0 || month.Output < 0 || month.Thought < 0
        || month.Input.HasValue != month.Output.HasValue || month.Input.HasValue != month.Thought.HasValue
        || (month.Input ?? 0) > month.Total || (month.Output ?? 0) > month.Total - (month.Input ?? 0)
        || (month.Thought ?? 0) > month.Total - (month.Input ?? 0) - (month.Output ?? 0);
}

/// <summary>Persist first; unresolved dispatched requests keep their conservative reservation across restarts.</summary>
public sealed class AskSparkUsageReservation(AskSparkUsage owner, string month, long reserved) : IDisposable
{
    private int finished;
    public void Complete(AskSparkTokenUsage usage) => Finish(usage);
    public void Release() => Finish(null);
    private void Finish(AskSparkTokenUsage? usage)
    {
        if (Interlocked.CompareExchange(ref finished, 1, 0) != 0) return;
        try { owner.Finish(month, reserved, usage); }
        catch { Volatile.Write(ref finished, 0); throw; }
    }
    public void Dispose() { /* Unknown provider outcome keeps its already-persisted reservation. */ }
}
