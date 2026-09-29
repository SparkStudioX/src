using System.Collections.Concurrent;
using System.Threading.Channels;

namespace SparkStudio.Connectors;

/// <summary>One latest value per node, with a single wake-up signal rather than an unbounded event queue.</summary>
internal sealed class SubscriptionValueQueue
{
    private readonly ConcurrentDictionary<string, ConnectorValue> _pending = new(StringComparer.Ordinal);
    private readonly Channel<bool> _wake = Channel.CreateBounded<bool>(new BoundedChannelOptions(1)
    {
        FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true, SingleWriter = false,
        AllowSynchronousContinuations = false
    });
    private long _failure;

    public void Put(ConnectorValue value)
    {
        _pending[value.NodeId] = value;
        _wake.Writer.TryWrite(true);
    }

    public void Fail(uint statusCode)
    {
        Interlocked.CompareExchange(ref _failure, statusCode, 0);
        _wake.Writer.TryWrite(true);
    }

    public async Task<IReadOnlyList<ConnectorValue>> ReadAsync(CancellationToken cancellationToken)
    {
        await _wake.Reader.ReadAsync(cancellationToken);
        var failure = Volatile.Read(ref _failure);
        if (failure != 0) throw new Opc.Ua.ServiceResultException((uint)failure);
        var result = new List<ConnectorValue>(_pending.Count);
        foreach (var id in _pending.Keys)
            if (_pending.TryRemove(id, out var value)) result.Add(value);
        return result;
    }
}
