using System.Diagnostics;
using System.Net.Sockets;
using Opc.Ua;
using Opc.Ua.Client;

namespace SparkStudio.Connectors;

public sealed partial class ConnectorService
{
    /// <summary>
    /// Watches one immutable connection configuration until cancellation. Owns its secure session;
    /// callbacks are serialized and should return promptly. Status values are Connected, Reconnecting,
    /// or Error. Cancellation completes normally after bounded cleanup; callback failures terminate.
    /// </summary>
    public async Task WatchAsync(ConnectionDefinition connection, IReadOnlyList<string> nodeIds,
        int publishingIntervalMs, Action<IReadOnlyList<ConnectorValue>> onValues,
        Action<string> onStatus, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        ArgumentNullException.ThrowIfNull(onValues);
        ArgumentNullException.ThrowIfNull(onStatus);
        var requests = ValidateWatch(connection, nodeIds, publishingIntervalMs);
        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(ct, _watchStopping);
        var failedAttempts = 0;
        string? previousStatus = null;
        void Status(string value)
        {
            if (value == previousStatus) return;
            InvokeWatchCallback(() => onStatus(value));
            previousStatus = value;
        }
        try
        {
            while (!stopping.IsCancellationRequested)
            {
                Status("Reconnecting");
                var connectedFor = new Stopwatch();
                try
                {
                    await WatchSessionAsync(connection, requests, publishingIntervalMs,
                        values => InvokeWatchCallback(() => onValues(values)),
                        () => { connectedFor.Start(); Status("Connected"); }, stopping.Token);
                }
                catch (OperationCanceledException) when (stopping.IsCancellationRequested) { break; }
                catch (Exception error) when (error is ServiceResultException or IOException or SocketException or TimeoutException or OperationCanceledException or InvalidOperationException)
                {
                    Status("Error");
                    // Re-establish the full secure session and items. Never reuse a partially failed subscription.
                    if (connectedFor.Elapsed >= TimeSpan.FromSeconds(30)) failedAttempts = 0;
                    await Task.Delay(WatchReconnectDelay(failedAttempts++), stopping.Token);
                }
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (WatchCallbackException)
        {
            throw new InvalidOperationException("An OPC UA subscription callback failed; the watch has stopped.");
        }
    }

    internal static TimeSpan WatchReconnectDelay(int failureCount) => TimeSpan.FromSeconds(Math.Min(15, 1 << Math.Clamp(failureCount, 0, 4)));

    internal static ReadValueIdCollection ValidateWatch(ConnectionDefinition connection, IReadOnlyList<string> nodeIds, int publishingIntervalMs)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(nodeIds);
        if (!IsOpc(connection)) throw new ArgumentException("An opcua connection is required.");
        if (!Uri.TryCreate(connection.Endpoint, UriKind.Absolute, out var endpoint) || endpoint.Scheme != "opc.tcp" || !string.IsNullOrEmpty(endpoint.UserInfo))
            throw new ArgumentException("Supply an opc.tcp endpoint URL without embedded credentials.");
        if (ParseSecurityMode(connection.SecurityMode) == MessageSecurityMode.None && !string.IsNullOrEmpty(connection.Username))
            throw new ArgumentException("Username authentication requires Sign or SignAndEncrypt.");
        if (nodeIds.Count is < 1 or > MaximumReadNodes)
            throw new ArgumentException($"Watch between 1 and {MaximumReadNodes} OPC UA nodes per connection.");
        if (publishingIntervalMs is < 100 or > 60000)
            throw new ArgumentException("OPC UA publishing interval must be between 100 and 60,000 milliseconds.");
        if (!string.IsNullOrWhiteSpace(connection.ServerCertificateSha256) &&
            !System.Text.RegularExpressions.Regex.IsMatch(connection.ServerCertificateSha256.Replace(":", "").Replace(" ", ""), "^[0-9A-Fa-f]{64}$"))
            throw new ArgumentException("Server certificate pin must be a 64-character SHA-256 fingerprint.");
        try
        {
            var requests = new ReadValueIdCollection(nodeIds.Distinct(StringComparer.Ordinal).Select(id =>
            {
                ArgumentException.ThrowIfNullOrWhiteSpace(id);
                return new ReadValueId { NodeId = NodeId.Parse(id), AttributeId = Attributes.Value, Handle = id };
            }));
            return requests;
        }
        catch (ServiceResultException) { throw new ArgumentException("A watched OPC UA node ID is invalid."); }
    }

    private async Task WatchSessionAsync(ConnectionDefinition connection, ReadValueIdCollection requests,
        int interval, Action<IReadOnlyList<ConnectorValue>> onValues, Action onConnected, CancellationToken ct)
    {
        ISession? session = null;
        Subscription? subscription = null;
        var items = new List<MonitoredItem>();
        var queue = new SubscriptionValueQueue();
        KeepAliveEventHandler keepAlive = (_, args) =>
        {
            if (ServiceResult.IsBad(args.Status)) queue.Fail(args.Status!.StatusCode.Code);
            else if (args.CurrentState == ServerState.Shutdown) queue.Fail(StatusCodes.BadServerHalted);
        };
        try
        {
            using var setup = CancellationTokenSource.CreateLinkedTokenSource(ct);
            setup.CancelAfter(TimeSpan.FromSeconds(30));
            session = await CreateSessionAsync(connection, setup.Token);
            session.KeepAliveInterval = 5000;
            session.KeepAlive += keepAlive;
            var initial = await session.ReadAsync(null, 0, TimestampsToReturn.Both, requests, setup.Token);
            if (initial.Results.Count != requests.Count) throw new InvalidOperationException("OPC UA returned an incomplete initial subscription read.");
            subscription = new Subscription(session.DefaultSubscription)
            {
                DisplayName = "SparkStudio tags", PublishingInterval = interval, PublishingEnabled = true,
                KeepAliveCount = (uint)Math.Max(1, 5000 / interval), LifetimeCount = (uint)Math.Max(30, 30000 / interval),
                TimestampsToReturn = TimestampsToReturn.Both, MaxNotificationsPerPublish = (uint)MaximumReadNodes
            };
            subscription.PublishStatusChanged += (_, _) =>
            {
                if (subscription.Created && subscription.PublishingStopped) queue.Fail(StatusCodes.BadNoCommunication);
            };
            foreach (var request in requests)
            {
                var nodeId = (string)request.Handle;
                var item = new MonitoredItem(subscription.DefaultItem)
                {
                    StartNodeId = request.NodeId, AttributeId = Attributes.Value, DisplayName = nodeId,
                    SamplingInterval = interval, QueueSize = 1, DiscardOldest = true, MonitoringMode = MonitoringMode.Reporting
                };
                item.Notification += (monitored, _) =>
                {
                    foreach (var value in monitored.DequeueValues()) queue.Put(ToConnectorValue(nodeId, value));
                };
                items.Add(item);
            }
            subscription.AddItems(items);
            if (!session.AddSubscription(subscription)) throw new InvalidOperationException("Could not attach the OPC UA subscription.");
            await subscription.CreateAsync(setup.Token);
            ct.ThrowIfCancellationRequested();
            onConnected();
            var firstValues = initial.Results.Select((value, i) =>
            {
                var itemError = items[i].Status.Error;
                if (ServiceResult.IsBad(itemError)) value = new DataValue { StatusCode = itemError!.StatusCode, ServerTimestamp = DateTime.UtcNow };
                return ToConnectorValue((string)requests[i].Handle, value);
            }).ToArray();
            onValues(firstValues);
            while (!ct.IsCancellationRequested)
            {
                var values = await queue.ReadAsync(ct);
                if (values.Count > 0) onValues(values);
            }
        }
        finally
        {
            if (session is not null) session.KeepAlive -= keepAlive;
            foreach (var item in items) item.DetachNotificationEventHandlers();
            using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            if (subscription is not null)
            {
                try { if (subscription.Created) await subscription.DeleteAsync(true, cleanup.Token); }
                catch { /* Closing the session and transport still releases server resources. */ }
                finally { subscription.Dispose(); }
            }
            if (session is not null)
            {
                try { await session.CloseAsync(2000, true, cleanup.Token); }
                catch { }
                finally { session.Dispose(); }
            }
        }
    }

    private static void InvokeWatchCallback(Action callback)
    {
        try { callback(); }
        catch { throw new WatchCallbackException(); }
    }
    private sealed class WatchCallbackException : Exception;
}
