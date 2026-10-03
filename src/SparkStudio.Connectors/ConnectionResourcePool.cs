namespace SparkStudio.Connectors;

/// <summary>Bounded resources with serialized use per connection and cancellation on shutdown.</summary>
internal sealed class ConnectionResourcePool<T>(
    int capacity,
    Func<ConnectionDefinition, CancellationToken, Task<T>> create,
    Func<T, bool> healthy,
    Func<T, Task> close,
    Func<Exception, bool>? reusableAfterError = null,
    int maximumConcurrencyPerConnection = 1,
    Func<ConnectionDefinition, ConnectionDefinition, bool>? sameConfiguration = null) : IDisposable where T : class, IDisposable
{
    private sealed class Slot : IDisposable
    {
        public readonly SemaphoreSlim Gate = new(1, 1);
        public ConnectionDefinition? Configuration;
        public T? Resource;
        public int Users;
        public long LastUse;
        public void Dispose() { Gate.Dispose(); GC.SuppressFinalize(this); }
    }

    private readonly object _sync = new();
    private readonly Dictionary<(string Id, int Lane), Slot> _slots = new();
    private readonly HashSet<string> _removed = new(StringComparer.Ordinal);
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
            if (_removed.Contains(connection.Id)) throw new InvalidOperationException("This connection has been removed. Select a saved connection before starting an operation.");
            stopping = _shutdown.Token;
            var candidates = _slots.Where(pair => pair.Key.Id == connection.Id).OrderBy(pair => pair.Value.Users).ThenBy(pair => pair.Key.Lane).ToArray();
            slot = candidates.FirstOrDefault().Value!;
            if (slot is null || slot.Users > 0 && candidates.Length < Math.Clamp(maximumConcurrencyPerConnection, 1, capacity)
                && (_slots.Count < capacity || _slots.Values.Any(candidate => candidate.Users == 0)))
            {
                if (_slots.Count >= capacity)
                {
                    var candidate = _slots.Where(pair => pair.Value.Users == 0).OrderBy(pair => pair.Value.LastUse).FirstOrDefault();
                    if (candidate.Value is null) throw new InvalidOperationException($"All {capacity} connection slots are busy. Retry after an operation completes.");
                    _slots.Remove(candidate.Key);
                    evicted = candidate.Value;
                }
                slot = new Slot();
                var lane = 0;
                while (_slots.ContainsKey((connection.Id, lane))) lane++;
                _slots.Add((connection.Id, lane), slot);
            }
            slot.Users++;
            _leases++;
        }

        try
        {
            if (evicted is not null) { await CloseSlotAsync(evicted); evicted.Dispose(); }
            using var operation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, stopping);
            await slot.Gate.WaitAsync(operation.Token);
            try
            {
                operation.Token.ThrowIfCancellationRequested();
                if (slot.Resource is null || slot.Configuration is null || !(sameConfiguration?.Invoke(slot.Configuration, connection) ?? slot.Configuration == connection) || !healthy(slot.Resource))
                {
                    await CloseSlotAsync(slot);
                    slot.Resource = await create(connection, operation.Token);
                    slot.Configuration = connection;
                }
                operation.Token.ThrowIfCancellationRequested();
                return await action(slot.Resource, operation.Token);
            }
            catch (Exception error)
            {
                // Cancelled/incomplete transport work is discarded. A known
                // application-level server rejection need not tear down a healthy session.
                if (slot.Resource is null || !healthy(slot.Resource) || reusableAfterError?.Invoke(error) != true)
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
                if (_disposed && slot.Users == 0) slot.Dispose();
                if (_disposed && _leases == 0) _shutdown.Dispose();
            }
        }
    }

    internal Func<Task> PrepareConnectionRemoval(string id, Action commit)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(id);
        ArgumentNullException.ThrowIfNull(commit);
        Slot[] idle;
        lock (_sync)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var slots = _slots.Where(pair => pair.Key.Id == id).ToArray();
            if (slots.Any(pair => pair.Value.Users > 0))
                throw new InvalidOperationException("An operation is using this connection. Wait for it to finish before deleting.");
            commit();
            _removed.Add(id);
            foreach (var pair in slots) _slots.Remove(pair.Key);
            idle = slots.Select(pair => pair.Value).ToArray();
        }
        return () => CloseRemovedAsync(idle);
    }

    private async Task CloseRemovedAsync(Slot[] idle)
    {
        await Task.WhenAll(idle.Select(async slot =>
        {
            try { await CloseSlotAsync(slot); }
            finally { slot.Dispose(); }
        }));
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
            slot.Dispose();
        }
        // Leased resources close in RunAsync's finally after shutdown cancellation.
    }
}
