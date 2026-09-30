namespace SparkStudio.Gateway;

/// <summary>All projects share a bounded Python process budget; overload never creates a delayed side effect.</summary>
public static class PythonProcessAdmission
{
    public const int Capacity = 16;
    private static readonly SemaphoreSlim Slots = new(Capacity, Capacity);
    public static IDisposable Acquire(CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        if (!Slots.Wait(0, cancellation)) throw new BadHttpRequestException("The gateway's Python process limit is reached. Try again shortly.", 429);
        return new Lease();
    }

    private sealed class Lease : IDisposable
    {
        private int released;
        public void Dispose() { if (Interlocked.Exchange(ref released, 1) == 0) Slots.Release(); }
    }
}
