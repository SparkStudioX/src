namespace SparkStudio.Connectors;

/// <summary>Bounded resources with serialized use per connection and cancellation on shutdown.</summary>
internal sealed class ConnectionResourcePool<T>(
    int capacity,
    Func<ConnectionDefinition, CancellationToken, Task<T>> create,
    Func<T, bool> healthy,
    Func<T, Task> close) : IDisposable where T : class, IDisposable
{
    private sealed class Slot
    {
        public readonly SemaphoreSlim Gate = new(1, 1);
        public ConnectionDefinition? Configuration;
        public T? Resource;
        public int Users;
        public long LastUse;
    }

    private readonly object _sync = new();
    private readonly Dictionary<string, Slot> _slots = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _shutdown = new();
    private bool _disposed;
    private int _leases;

    public async Task<TResult> RunAsync<TResult>(ConnectionDefinition connection,
        Func<T, CancellationToken, Task<TResult>> action, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(connection.Id);
        Slot slot;
        Slot? evicted = null;
        CancellationToken stopping;
        lock (_sync)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            stopping = _shutdown.Token;
            if (!_slots.TryGetValue(connection.Id, out slot!))
            {
                if (_slots.Count >= capacity)
                {
                    var candidate = _slots.Where(pair => pair.Value.Users == 0).OrderBy(pair => pair.Value.LastUse).FirstOrDefault();
                    if (candidate.Value is null) throw new InvalidOperationException($"All {capacity} OPC UA connection slots are busy. Retry after an operation completes.");
                    _slots.Remove(candidate.Key);
                    evicted = candidate.Value;
                }
                slot = new Slot();
                _slots.Add(connection.Id, slot);
            }
            slot.Users++;
            _leases++;
        }

        try
        {
            if (evicted is not null) { await CloseSlotAsync(evicted); evicted.Gate.Dispose(); }
            using var operation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, stopping);
            await slot.Gate.WaitAsync(operation.Token);
            try
            {
                operation.Token.ThrowIfCancellationRequested();
                if (slot.Resource is null || slot.Configuration != connection || !healthy(slot.Resource))
                {
                    await CloseSlotAsync(slot);
                    slot.Resource = await create(connection, operation.Token);
                    slot.Configuration = connection;
                }
                operation.Token.ThrowIfCancellationRequested();
                return await action(slot.Resource, operation.Token);
            }
            catch
            {
                // No failed/cancelled operation can leave a reusable resource behind.
                await CloseSlotAsync(slot);
                throw;
            }
            finally
            {
                if (stopping.IsCancellationRequested) await CloseSlotAsync(slot);
                slot.Gate.Release();
            }
        }
        finally
        {
            lock (_sync)
            {
                slot.Users--;
                slot.LastUse = Environment.TickCount64;
                _leases--;
                if (_disposed && slot.Users == 0) slot.Gate.Dispose();
                if (_disposed && _leases == 0) _shutdown.Dispose();
            }
        }
    }

    private async Task CloseSlotAsync(Slot slot)
    {
        var resource = slot.Resource;
        slot.Resource = null;
        slot.Configuration = null;
        if (resource is null) return;
        try { await close(resource); }
        catch { /* Always release the transport even if graceful close fails. */ }
        finally { resource.Dispose(); }
    }

    public void Dispose()
    {
        Slot[] idle;
        lock (_sync)
        {
            if (_disposed) return;
            _disposed = true;
            _shutdown.Cancel();
            idle = _slots.Values.Where(slot => slot.Users == 0).ToArray();
            _slots.Clear();
            if (_leases == 0) _shutdown.Dispose();
        }
        foreach (var slot in idle)
        {
            slot.Resource?.Dispose();
            slot.Resource = null;
            slot.Configuration = null;
            slot.Gate.Dispose();
        }
        // Leased resources close in RunAsync's finally after shutdown cancellation.
    }
}
