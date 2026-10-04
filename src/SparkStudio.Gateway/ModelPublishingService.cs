using System.Collections.Concurrent;
using System.Text;
using System.Text.Json.Nodes;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

public sealed class ModelPublishingService(ModelPublishingStore store, Func<string, JsonObject> readObject,
    string dataDirectory, Action ensureAllowed) : BackgroundService
{
    private readonly ConcurrentDictionary<string, Status> statuses = new(StringComparer.Ordinal);
    private sealed class Status
    {
        public readonly object Gate = new();
        public string State = "disabled";
        public string? LastError;
        public long Delivered, Retries, Rejected;
        public DateTimeOffset? LastDeliveredAt;
        public DateTimeOffset NextCapture;
        public string? Fingerprint;
        public int Revision = -1;
    }
    public object[] Diagnostics()
    {
        return store.RuntimeSnapshot().Publishers.Select(settings =>
        {
            var state = statuses.GetOrAdd(settings.Id, _ => new());
            try
            {
                var queue = store.QueueStatus(settings.Id);
                lock (state.Gate) return (object)new { settings.Id, State = settings.Enabled ? state.State : "disabled", state.LastError,
                    QueuedCount = queue.Count, QueuedBytes = queue.Bytes, state.Delivered, state.Retries, state.Rejected, state.LastDeliveredAt,
                    OverflowPolicy = "reject-newest-batch", Delivery = settings.Qos == 1 ? "at-least-once; removed after broker PUBACK" : "best-effort; removed after socket write" };
            }
            catch (Exception error) { return new { settings.Id, State = "queue-error", LastError = PublicError(error) }; }
        }).ToArray();
    }
    public ModelPublishingMessage[] Preview(ModelPublisher settings) => ModelPublishingPayload.Capture(ModelPublishingStore.Validate(settings), readObject);
    public async Task<object> TestAsync(string id, CancellationToken cancellation)
    {
        ensureAllowed();
        var settings = store.Runtime(id);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation); timeout.CancelAfter(TimeSpan.FromSeconds(6));
        await using var wire = await ModelMqttPublisher.ConnectAsync(settings.Endpoint, "spark-test-" + Guid.NewGuid().ToString("N"),
            settings.Username, settings.Password, dataDirectory, timeout.Token);
        return new { success = true, message = "Broker accepted the MQTT connection. No messages were published; publish permission is checked when a message is sent." };
    }
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var workers = new Dictionary<string, Task>(StringComparer.Ordinal);
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                var snapshot = store.RuntimeSnapshot();
                foreach (var settings in snapshot.Publishers)
                {
                    if (!workers.TryGetValue(settings.Id, out var worker) || worker.IsCompleted)
                        workers[settings.Id] = DeliverAsync(settings.Id, stoppingToken);
                    Capture(settings, snapshot.Revision);
                }
                foreach (var id in workers.Keys.Except(snapshot.Publishers.Select(item => item.Id), StringComparer.Ordinal).ToArray())
                    if (workers[id].IsCompleted) { workers.Remove(id); statuses.TryRemove(id, out _); }
                await Task.Delay(250, stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally { await Task.WhenAll(workers.Values); }
    }
    private void Capture(ModelPublisher settings, int revision)
    {
        if (!settings.Enabled) return;
        var status = statuses.GetOrAdd(settings.Id, _ => new());
        var now = DateTimeOffset.UtcNow;
        lock (status.Gate)
        {
            if (status.Revision != revision) { status.Revision = revision; status.Fingerprint = null; status.NextCapture = default; }
            if (now < status.NextCapture) return;
            status.NextCapture = now.AddMilliseconds(settings.IntervalMs);
        }
        try
        {
            ensureAllowed();
            var messages = ModelPublishingPayload.Capture(settings, readObject);
            var fingerprint = ModelPublishingPayload.Fingerprint(messages);
            lock (status.Gate) if (settings.Mode == "onChange" && status.Fingerprint == fingerprint) return;
            var accepted = store.Enqueue(settings.Id, revision, messages);
            lock (status.Gate)
            {
                if (accepted) { status.Fingerprint = fingerprint; if (status.State == "queue-full") status.State = "queued"; }
                else { status.Rejected += messages.Length; status.State = "queue-full"; status.LastError = "The complete newest batch was not queued (queue full or configuration changed). Existing messages are preserved; on-change values retry at the next capture."; }
            }
        }
        catch (Exception error) { SetError(status, "capture-error", error); }
    }
    private async Task DeliverAsync(string id, CancellationToken cancellation)
    {
        ModelMqttPublisher? wire = null;
        var connectedRevision = -1; var attempt = 0;
        var status = statuses.GetOrAdd(id, _ => new());
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                var snapshot = store.RuntimeSnapshot();
                var settings = snapshot.Publishers.FirstOrDefault(item => item.Id == id);
                if (settings is null) return;
                if (!settings.Enabled || connectedRevision != snapshot.Revision)
                {
                    if (wire is not null) { await wire.DisposeAsync(); wire = null; }
                    connectedRevision = snapshot.Revision;
                }
                if (!settings.Enabled) { await Task.Delay(250, cancellation); continue; }
                try
                {
                    ensureAllowed();
                    using var delivery = store.BeginDelivery(id);
                    if (delivery is null) { await Task.Delay(100, cancellation); continue; }
                    if (wire is not null && connectedRevision != delivery.Revision) { await wire.DisposeAsync(); wire = null; }
                    connectedRevision = delivery.Revision;
                    var message = delivery.Message;
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation); timeout.CancelAfter(TimeSpan.FromSeconds(6));
                    wire ??= await Connect(delivery.Settings, timeout.Token);
                    await wire.PublishAsync(message.Topic, Encoding.UTF8.GetBytes(message.Payload), delivery.Settings.Qos, delivery.Settings.Retain, timeout.Token);
                    store.Acknowledge(id, message.Id);
                    attempt = 0;
                    lock (status.Gate) { status.Delivered++; status.LastDeliveredAt = DateTimeOffset.UtcNow; status.State = "connected"; status.LastError = null; }
                }
                catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { return; }
                catch (Exception error)
                {
                    if (wire is not null) { await wire.DisposeAsync(); wire = null; }
                    SetError(status, "retrying", error);
                    lock (status.Gate) status.Retries++;
                    await Task.Delay(TimeSpan.FromSeconds(Math.Min(30, 1 << Math.Min(attempt++, 5))), cancellation);
                }
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        finally { if (wire is not null) await wire.DisposeAsync(); }
    }
    private Task<ModelMqttPublisher> Connect(ModelPublisher settings, CancellationToken cancellation) => ModelMqttPublisher.ConnectAsync(
        settings.Endpoint, "spark-model-" + settings.Id, settings.Username, settings.Password, dataDirectory, cancellation);
    private static void SetError(Status status, string state, Exception error)
    {
        lock (status.Gate) { status.State = state; status.LastError = PublicError(error); }
    }
    private static string PublicError(Exception error) => error switch
    {
        OperationCanceledException => "Broker operation timed out. Pending messages remain on disk for retry.",
        System.Security.Authentication.AuthenticationException => "TLS authentication failed. Check the broker certificate, hostname and gateway trust store.",
        System.Net.Sockets.SocketException => "Cannot reach the MQTT broker. Check its address, port and network availability.",
        System.Security.Cryptography.CryptographicException => "The saved broker credential cannot be decrypted on this gateway. Enter it again.",
        ArgumentException or KeyNotFoundException or InvalidOperationException => error.Message,
        _ => "Model publishing failed (" + error.GetType().Name + "). Pending messages remain on disk; check the broker and publisher configuration."
    };
}
