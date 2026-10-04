using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public static class ModelPublishingPayload
{
    public static ModelPublishingMessage[] Capture(ModelPublisher settings, Func<string, JsonObject> readObject)
    {
        var messages = new List<ModelPublishingMessage>();
        long bytes = 0;
        var capturedAt = DateTimeOffset.UtcNow;
        foreach (var path in settings.InstancePaths)
        {
            var source = readObject(path);
            var root = settings.TopicPrefix + "/" + TopicPath(path);
            if (settings.Shape == "object") Add(Message(root, ObjectPayload(source, capturedAt), capturedAt));
            else
            {
                foreach (var (relative, leaf) in Leaves(source["members"] as JsonObject ?? []))
                {
                    var payload = LeafPayload(leaf); payload["equipmentPath"] = path; payload["capturedAt"] = capturedAt;
                    Add(Message(root + "/" + string.Join('/', relative.Split('/').Select(Uri.EscapeDataString)), payload, capturedAt));
                }
            }
        }
        return messages.ToArray();
        void Add(ModelPublishingMessage message)
        {
            bytes += message.Bytes;
            if (messages.Count >= 10000 || bytes > 67108864) throw new ArgumentException("This publisher expands beyond 10000 messages or 64 MiB. Select fewer equipment items.");
            messages.Add(message);
        }
    }
    public static string TopicPath(string path)
    {
        TagDefinitionValidator.Path(path);
        var end = path.IndexOf(']');
        return Uri.EscapeDataString(path[1..end]) + "/" + string.Join('/', path[(end + 1)..].Split('/').Select(Uri.EscapeDataString));
    }
    private static ModelPublishingMessage Message(string topic, JsonObject payload, DateTimeOffset capturedAt)
    {
        if (Encoding.UTF8.GetByteCount(topic) > 4096) throw new ArgumentException("The encoded MQTT topic exceeds 4096 bytes. Shorten the prefix or equipment path.");
        var text = payload.ToJsonString();
        if (Encoding.UTF8.GetByteCount(text) > 256 * 1024) throw new ArgumentException("Equipment payload exceeds 256 KiB. Choose leaf topics or reduce the equipment payload.");
        return new(Guid.NewGuid().ToString("N"), topic, text, capturedAt);
    }
    private static JsonObject ObjectPayload(JsonObject source, DateTimeOffset capturedAt)
    {
        var output = new JsonObject { ["equipmentPath"] = source["path"]?.DeepClone(), ["capturedAt"] = capturedAt };
        foreach (var name in new[] { "definitionId", "version", "generation" }) output[name] = source[name]?.DeepClone();
        output["members"] = CleanMembers(source["members"] as JsonObject ?? []);
        return output;
    }
    private static JsonObject CleanMembers(JsonObject members)
    {
        var output = new JsonObject();
        foreach (var (name, item) in members)
            if (item is JsonObject child) output[name] = IsLeaf(child) ? LeafPayload(child) : CleanMembers(child);
        return output;
    }
    private static bool IsLeaf(JsonObject item) => item.ContainsKey("value")
        && item["quality"] is JsonValue quality && quality.TryGetValue<string>(out _);
    private static JsonObject LeafPayload(JsonObject leaf)
    {
        var result = new JsonObject();
        foreach (var name in new[] { "value", "dataType", "quality", "sourceQuality", "modelIssues", "timestamp", "sourceTimestamp", "receiptTimestamp", "metadata" })
            if (leaf.ContainsKey(name)) result[name] = leaf[name]?.DeepClone();
        return result;
    }
    private static IEnumerable<(string Path, JsonObject Leaf)> Leaves(JsonObject members, string prefix = "")
    {
        foreach (var (name, item) in members)
        {
            if (item is not JsonObject child) continue;
            var path = prefix.Length == 0 ? name : prefix + "/" + name;
            if (IsLeaf(child)) yield return (path, child);
            else foreach (var leaf in Leaves(child, path)) yield return leaf;
        }
    }
    public static string Fingerprint(IReadOnlyList<ModelPublishingMessage> messages)
    {
        // Timestamp-only changes do not publish in on-change mode. Quality, issues, values and metadata do.
        var rows = new JsonArray();
        foreach (var message in messages)
        {
            var node = JsonNode.Parse(message.Payload)!;
            StripVolatilePayload(node.AsObject());
            rows.Add(new JsonObject { ["topic"] = message.Topic, ["payload"] = node });
        }
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(rows.ToJsonString())));
    }
    private static void StripVolatilePayload(JsonObject payload)
    {
        payload.Remove("capturedAt"); payload.Remove("generation");
        if (payload["members"] is JsonObject members) StripMemberTimestamps(members);
        else StripLeafTimestamps(payload);
    }
    private static void StripMemberTimestamps(JsonObject members)
    {
        foreach (var (_, value) in members)
            if (value is JsonObject child)
            {
                if (IsLeaf(child)) StripLeafTimestamps(child);
                else StripMemberTimestamps(child);
            }
    }
    private static void StripLeafTimestamps(JsonObject leaf)
    {
        foreach (var name in new[] { "timestamp", "sourceTimestamp", "receiptTimestamp" }) leaf.Remove(name);
    }
}
