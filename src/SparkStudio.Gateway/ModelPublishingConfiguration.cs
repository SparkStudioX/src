using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;

namespace SparkStudio.Gateway;

public sealed record ModelPublisher(string Id, string Name, string Endpoint, string[] InstancePaths,
    bool Enabled = false, string TopicPrefix = "spark/models", string Shape = "object", string Mode = "onChange",
    int IntervalMs = 1000, int Qos = 1, bool Retain = false, int QueueLimit = 1000, int QueueBytes = 10485760,
    string? Username = null, string? Password = null, bool ClearPassword = false, bool HasPassword = false);
public sealed record ModelPublishingSave(int Revision, ModelPublisher Publisher);
public sealed record ModelPublishingPreview(ModelPublisher Publisher);

public sealed partial class ModelPublishingStore
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
    private static readonly Regex Identifier = new("\\A[a-z0-9][a-z0-9_-]{0,63}\\z", RegexOptions.CultureInvariant);
    private readonly object gate = new();
    private readonly string filename;
    private readonly string queueDirectory;
    private readonly IDataProtector protector;
    private StoredConfiguration document;
    private sealed record StoredPublisher(ModelPublisher Settings, string? ProtectedPassword);
    private sealed record StoredConfiguration(int Revision, StoredPublisher[] Publishers);
    public ModelPublishingStore(string dataDirectory, IDataProtectionProvider protection)
    {
        Directory.CreateDirectory(dataDirectory);
        filename = Path.Combine(dataDirectory, "model-publishing.json");
        queueDirectory = Path.Combine(dataDirectory, "model-publishing-queue");
        Directory.CreateDirectory(queueDirectory);
        protector = protection.CreateProtector("SparkStudio.ModelPublishing.Secrets.v1");
        document = ReadDocument();
    }
    private StoredConfiguration ReadDocument()
    {
        if (!File.Exists(filename)) return new(0, []);
        RecoveryFileSystem.RejectLinks(filename);
        if (new FileInfo(filename).Length > 1024 * 1024) throw new InvalidOperationException("Model publisher configuration is too large.");
        var result = JsonSerializer.Deserialize<StoredConfiguration>(File.ReadAllText(filename), Json)
            ?? throw new InvalidOperationException("Model publisher configuration is empty.");
        if (result.Revision < 0 || result.Publishers.Length > 16) throw new InvalidOperationException("Invalid model publisher configuration.");
        foreach (var publisher in result.Publishers) Validate(publisher.Settings);
        if (result.Publishers.Select(item => item.Settings.Id).Distinct(StringComparer.Ordinal).Count() != result.Publishers.Length)
            throw new InvalidOperationException("Model publisher IDs must be unique.");
        return result;
    }
    public object Snapshot() { lock (gate) return new { document.Revision, Publishers = document.Publishers.Select(Safe).ToArray() }; }
    public (int Revision, ModelPublisher[] Publishers) RuntimeSnapshot()
    {
        lock (gate) return (document.Revision, document.Publishers.Select(Safe).ToArray());
    }
    public ModelPublisher Runtime(string id)
    {
        lock (gate)
        {
            var saved = Find(id);
            return saved.Settings with { InstancePaths = [.. saved.Settings.InstancePaths], Password = saved.ProtectedPassword is null ? null : protector.Unprotect(saved.ProtectedPassword) };
        }
    }
    public object Save(ModelPublishingSave request)
    {
        var input = Validate(request.Publisher);
        lock (gate)
        {
            CheckRevision(request.Revision);
            var old = document.Publishers.FirstOrDefault(item => item.Settings.Id == input.Id);
            if (old is null && document.Publishers.Length == 16) throw new ArgumentException("At most 16 model publishers are supported.");
            if (old is not null && Routing(old.Settings) != Routing(input)) EnsureNoActiveDelivery(input.Id);
            if (old is not null && Queue(input.Id).Count > 0 && Routing(old.Settings) != Routing(input))
                throw new InvalidOperationException("This publisher has pending messages. Drain or explicitly discard the queue before changing its destination, topic, equipment or payload options.");
            var secret = input.ClearPassword ? null : input.Password is not null ? protector.Protect(input.Password) : old?.ProtectedPassword;
            var stored = new StoredPublisher(input with { Password = null, ClearPassword = false, HasPassword = false }, secret);
            var items = document.Publishers.Where(item => item.Settings.Id != input.Id).Append(stored).OrderBy(item => item.Settings.Id, StringComparer.Ordinal).ToArray();
            Commit(new(document.Revision + 1, items));
            return Snapshot();
        }
    }
    public object Delete(string id, int revision, bool discardPending)
    {
        lock (gate)
        {
            CheckRevision(revision); _ = Find(id);
            EnsureNoActiveDelivery(id);
            if (Queue(id).Count > 0 && !discardPending) throw new InvalidOperationException("This publisher has pending messages. Confirm discarding them before deleting.");
            // Clear the durable queue before freeing the ID. Otherwise a failed
            // second write could replay orphaned messages through a new destination.
            Discard(id);
            Commit(new(document.Revision + 1, document.Publishers.Where(item => item.Settings.Id != id).ToArray()));
            return Snapshot();
        }
    }
    private void Commit(StoredConfiguration next)
    {
        // The online configuration snapshot owns this monitor while it captures
        // saved configuration. Queue I/O deliberately uses only the local gate.
        lock (GatewayConfigurationLock.SyncRoot)
        {
            DurableJsonFile.Write(filename, JsonSerializer.SerializeToNode(next, Json)!);
            document = next;
        }
    }
    private StoredPublisher Find(string id) => document.Publishers.FirstOrDefault(item => item.Settings.Id == id) ?? throw new KeyNotFoundException("Model publisher not found.");
    private void CheckRevision(int revision) { if (revision != document.Revision) throw new InvalidOperationException("Model publisher settings changed. Reload before saving."); }
    private static ModelPublisher Safe(StoredPublisher publisher) => publisher.Settings with { InstancePaths = [.. publisher.Settings.InstancePaths], Password = null, ClearPassword = false, HasPassword = publisher.ProtectedPassword is not null };
    private static string Routing(ModelPublisher item) => JsonSerializer.Serialize(new { item.Endpoint, item.TopicPrefix, item.InstancePaths, item.Shape, item.Qos, item.Retain });

    public static ModelPublisher Validate(ModelPublisher? item)
    {
        if (item is null || item.Id is null || !Identifier.IsMatch(item.Id)) throw new ArgumentException("Choose a publisher ID using lowercase letters, numbers, underscores or hyphens (up to 64 characters).");
        if (string.IsNullOrWhiteSpace(item.Name) || item.Name.Length > 120 || item.Name.Any(char.IsControl)) throw new ArgumentException("Publisher name must contain 1–120 printable characters.");
        ValidateEndpoint(item.Endpoint);
        if (item.InstancePaths is not { Length: > 0 and <= 100 } || item.InstancePaths.Distinct(StringComparer.Ordinal).Count() != item.InstancePaths.Length)
            throw new ArgumentException("Select between 1 and 100 unique saved equipment paths.");
        foreach (var path in item.InstancePaths) TagDefinitionValidator.Path(path);
        ValidateTopic(item.TopicPrefix);
        ValidateDelivery(item);
        ValidateCredentials(item);
        return item with { Name = item.Name.Trim(), InstancePaths = item.InstancePaths.Order(StringComparer.Ordinal).ToArray() };
    }
    private static void ValidateDelivery(ModelPublisher item)
    {
        if (item.Shape is not ("object" or "leaves") || item.Mode is not ("onChange" or "interval") || item.Qos is not (0 or 1))
            throw new ArgumentException("Select object or leaves, onChange or interval, and QoS 0 or 1.");
        if (item.IntervalMs is < 250 or > 86400000 || item.QueueLimit is < 1 or > 10000 || item.QueueBytes is < 1024 or > 67108864)
            throw new ArgumentException("Interval must be 250–86400000 ms, queue count 1–10000 and queue bytes 1024–67108864.");
    }
    private static void ValidateCredentials(ModelPublisher item)
    {
        if (item.Username?.Length > 256 || item.Username?.Any(char.IsControl) == true || item.Password?.Length > 4096 || item.Password?.Contains('\0') == true)
            throw new ArgumentException("MQTT credentials exceed their supported length or contain invalid control characters.");
        if (item.Password is not null && string.IsNullOrEmpty(item.Username)) throw new ArgumentException("A username is required when setting an MQTT password.");
        if (item.ClearPassword && item.Password is not null) throw new ArgumentException("Choose either a replacement password or clear password.");
    }
    private static void ValidateEndpoint(string endpoint)
    {
        if (string.IsNullOrWhiteSpace(endpoint) || endpoint.Length > 2048 || !Uri.TryCreate(endpoint, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("mqtt" or "mqtts") || string.IsNullOrEmpty(uri.Host) || uri.UserInfo.Length != 0
            || uri.AbsolutePath != "/" || uri.Query.Length != 0 || uri.Fragment.Length != 0 || uri.Port == 0)
            throw new ArgumentException("Use mqtt://host:1883 or mqtts://host:8883 without credentials, a path, query or fragment. TLS verifies the broker certificate against the gateway's trusted authorities.");
    }
    internal static void ValidateTopic(string topic)
    {
        if (string.IsNullOrWhiteSpace(topic) || Encoding.UTF8.GetByteCount(topic) > 2048 || topic.Any(char.IsControl) || topic.Contains('+') || topic.Contains('#') || topic.StartsWith('$') || topic.StartsWith('/') || topic.EndsWith('/') || topic.Contains("//", StringComparison.Ordinal))
            throw new ArgumentException("Topic prefix must be a concrete nonempty MQTT path, without wildcards, control characters, empty levels or a leading $.");
    }
}
