namespace SparkStudio.Connectors;

/// <summary>Accounts source working sets across connections before their allocations/commits.</summary>
public sealed class SourceMemoryBudget : IDisposable
{
    private static readonly object Gate = new();
    private static readonly Dictionary<string, long> Used = new(StringComparer.Ordinal);
    private static readonly Dictionary<string, long> Peak = new(StringComparer.Ordinal);
    private static readonly Dictionary<string, long> Limits = new(StringComparer.Ordinal) {
        ["queue"] = 64L * 1024 * 1024, ["state"] = 128L * 1024 * 1024,
        ["decode"] = 256L * 1024 * 1024, ["values"] = 128L * 1024 * 1024,
        ["catalog"] = 128L * 1024 * 1024, ["workers"] = 1024L * 1024 * 1024
    };
    private readonly Dictionary<string, long> owned = new(StringComparer.Ordinal);
    private bool disposed;
    public void SetBytes(string category, long bytes)
    {
        lock (Gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (!Limits.TryGetValue(category, out var limit) || bytes < 0) throw new ArgumentException("Invalid source memory category or size.");
            var next = Used.GetValueOrDefault(category) - owned.GetValueOrDefault(category) + bytes;
            if (next > limit) throw new SourceLimitException($"Global source {category} memory budget exhausted.");
            Used[category] = next; owned[category] = bytes;
            Peak[category] = Math.Max(Peak.GetValueOrDefault(category), next);
        }
    }
    public static IReadOnlyDictionary<string, long> Snapshot() { lock (Gate) return new Dictionary<string, long>(Used); }
    public static IReadOnlyDictionary<string, long> PeakSnapshot() { lock (Gate) return new Dictionary<string, long>(Peak); }
    public void Dispose()
    {
        lock (Gate) { if (disposed) return; disposed = true; foreach (var item in owned) Used[item.Key] = Used.GetValueOrDefault(item.Key) - item.Value; owned.Clear(); }
    }
}
