namespace SparkStudio.Connectors;

public sealed partial class ConnectorService
{
    private Task<IDeviceSession> CreateDeviceSessionAsync(ConnectionDefinition connection, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        DeviceConfiguration.Validate(connection.Device ?? throw new ArgumentException("Industrial device settings are required."), connection.Type);
        return Task.FromResult<IDeviceSession>(connection.Type switch
        {
            "modbus-tcp" => new ModbusDeviceSession(connection),
            "ab-eip" => new EthernetIpDeviceSession(connection, _dataDirectory),
            "siemens-s7" => new SiemensS7DeviceSession(connection),
            "beckhoff-ads" => new BeckhoffAdsDeviceSession(connection),
            _ => throw new ArgumentException("Unsupported industrial driver.")
        });
    }
    private async Task<T> WithDeviceAsync<T>(ConnectionDefinition connection, Func<IDeviceSession, CancellationToken, Task<T>> action, CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        DeviceConfiguration.Validate(connection.Device ?? throw new ArgumentException("Industrial device settings are required."), connection.Type);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(TimeSpan.FromSeconds(30));
        try { return await _deviceSessions.RunAsync(connection, action, deadline.Token); }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
        { throw new TimeoutException("The industrial device operation timed out or the gateway is stopping."); }
    }
    private async Task WatchDeviceAsync(ConnectionDefinition connection, IReadOnlyList<string> nodeIds, int interval,
        Action<IReadOnlyList<ConnectorValue>> onValues, Action<string> onStatus, CancellationToken cancellation)
    {
        ArgumentNullException.ThrowIfNull(nodeIds);
        if (nodeIds.Count is < 1 or > MaximumReadNodes || interval is < 100 or > 60000)
            throw new ArgumentException("Watch 1–1000 saved device points at intervals of 100–60000 ms.");
        var ids = nodeIds.Distinct(StringComparer.Ordinal).ToArray();
        foreach (var id in ids) _ = DeviceConfiguration.Point(connection, id);
        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(cancellation, _watchStopping);
        var failures = 0;
        string? previous = null;
        void Status(string status) { if (previous == status) return; InvokeWatchCallback(() => onStatus(status)); previous = status; }
        try
        {
            Status("Reconnecting");
            while (!stopping.IsCancellationRequested)
            {
                try
                {
                    var values = await ReadAsync(connection, ids, stopping.Token);
                    InvokeWatchCallback(() => onValues(values));
                    if (values.Count > 0 && values.All(value => value.Quality is "Bad_Timeout" or "Bad_CommunicationError"))
                        throw new IOException("The device could not acquire any mapped points.");
                    Status("Connected");
                    failures = 0;
                    await Task.Delay(interval, stopping.Token);
                }
                catch (OperationCanceledException) when (stopping.IsCancellationRequested) { break; }
                catch (Exception error) when (error is IOException or System.Net.Sockets.SocketException or TimeoutException or InvalidOperationException or OperationCanceledException)
                {
                    Status("Error");
                    var bad = ids.Select(id => new ConnectorValue(id, null, DeviceConfiguration.Point(connection, id).DataType,
                        error is TimeoutException or OperationCanceledException ? "Bad_Timeout" : "Bad_CommunicationError", DateTimeOffset.UtcNow)).ToArray();
                    InvokeWatchCallback(() => onValues(bad));
                    await Task.Delay(WatchReconnectDelay(failures++), stopping.Token);
                    Status("Reconnecting");
                }
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (WatchCallbackException) { throw new InvalidOperationException("A device watch callback failed; the watch has stopped."); }
    }
}
