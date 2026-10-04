using System.Text;
using System.Text.Json;

namespace SparkStudio.Gateway;

public sealed record ModelPublishingMessage(string Id, string Topic, string Payload, DateTimeOffset CapturedAt)
{
    public long Bytes => Encoding.UTF8.GetByteCount(Topic) + Encoding.UTF8.GetByteCount(Payload) + 128L;
}
public sealed record ModelPublishingQueueStatus(int Count, long Bytes);

/// <summary>Pins the queued message and its destination until delivery completes or fails.</summary>
public sealed class ModelPublishingDelivery(int revision, ModelPublisher settings, ModelPublishingMessage message, Action release) : IDisposable
{
    private Action? releaseLease = release;
    public int Revision { get; } = revision;
    public ModelPublisher Settings { get; } = settings;
    public ModelPublishingMessage Message { get; } = message;
    public void Dispose() { Interlocked.Exchange(ref releaseLease, null)?.Invoke(); GC.SuppressFinalize(this); }
}

public sealed partial class ModelPublishingStore
{
    private readonly Dictionary<string, List<ModelPublishingMessage>> queues = new(StringComparer.Ordinal);
    private readonly HashSet<string> activeDeliveries = new(StringComparer.Ordinal);
    public ModelPublishingDelivery? BeginDelivery(string id)
    {
        lock (gate)
        {
            var settings = Find(id).Settings;
            if (!settings.Enabled) return null;
            EnsureNoActiveDelivery(id);
            var message = Queue(id).FirstOrDefault();
            if (message is null) return null;
            var runtime = Runtime(id);
            activeDeliveries.Add(id);
            return new(document.Revision, runtime, message, () => { lock (gate) activeDeliveries.Remove(id); });
        }
    }
    private void EnsureNoActiveDelivery(string id)
    {
        if (activeDeliveries.Contains(id))
            throw new InvalidOperationException("This publisher is delivering a message. Disable it and retry after the current delivery finishes before discarding, deleting or changing its destination.");
    }
    private List<ModelPublishingMessage> Queue(string id)
    {
        if (!Identifier.IsMatch(id)) throw new ArgumentException("Invalid publisher ID.");
        if (queues.TryGetValue(id, out var existing)) return existing;
        var file = QueueFile(id);
        var messages = new List<ModelPublishingMessage>();
        if (File.Exists(file))
        {
            RecoveryFileSystem.RejectLinks(file);
            if (new FileInfo(file).Length > 512L * 1024 * 1024) throw new InvalidOperationException("Publisher queue exceeds its recovery limit. Preserve the file and inspect it offline.");
            messages = JsonSerializer.Deserialize<List<ModelPublishingMessage>>(File.ReadAllText(file), Json)
                ?? throw new InvalidOperationException("Publisher queue is empty or invalid.");
            if (messages.Count > 10000 || messages.Sum(item => item.Bytes) > 67108864 || messages.Any(item => !ValidMessage(item)))
                throw new InvalidOperationException("Publisher queue is invalid. Preserve the file and inspect it offline.");
        }
        queues[id] = messages;
        return messages;
    }
    private static bool ValidMessage(ModelPublishingMessage message) => message.Id.Length is > 0 and <= 64
        && message.Topic.Length is > 0 and <= 4096 && !message.Topic.Any(char.IsControl)
        && !message.Topic.Contains('+') && !message.Topic.Contains('#') && Encoding.UTF8.GetByteCount(message.Payload) <= 256 * 1024;
    private string QueueFile(string id) => Path.Combine(queueDirectory, id + ".json");
    private void PersistQueue(string id, List<ModelPublishingMessage> next)
    {
        DurableJsonFile.Write(QueueFile(id), JsonSerializer.SerializeToNode(next, Json)!);
        queues[id] = next;
    }
    public bool Enqueue(string id, int revision, IReadOnlyList<ModelPublishingMessage> messages)
    {
        lock (gate)
        {
            if (document.Revision != revision) return false;
            var settings = Find(id).Settings;
            if (!settings.Enabled) return false;
            if (messages.Any(item => !ValidMessage(item))) throw new ArgumentException("Published message is invalid or exceeds 256 KiB. Choose leaf topics or reduce the equipment payload.");
            var queue = Queue(id);
            if (queue.Count + messages.Count > settings.QueueLimit || queue.Sum(item => item.Bytes) + messages.Sum(item => item.Bytes) > settings.QueueBytes) return false;
            PersistQueue(id, queue.Concat(messages).ToList());
            return true;
        }
    }
    public ModelPublishingMessage? Peek(string id) { lock (gate) return Queue(id).FirstOrDefault(); }
    public void Acknowledge(string id, string messageId)
    {
        lock (gate)
        {
            var queue = Queue(id);
            if (queue.Count > 0 && queue[0].Id == messageId) PersistQueue(id, queue.Skip(1).ToList());
        }
    }
    public ModelPublishingQueueStatus QueueStatus(string id)
    {
        lock (gate) { var queue = Queue(id); return new(queue.Count, queue.Sum(item => item.Bytes)); }
    }
    public int Discard(string id)
    {
        lock (gate)
        {
            EnsureNoActiveDelivery(id);
            var queue = Queue(id); var count = queue.Count;
            PersistQueue(id, []);
            return count;
        }
    }
}
