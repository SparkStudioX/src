using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Validated gateway event settings shared by saved drafts, packages and the scheduler.</summary>
public static class GatewayScriptOptions
{
    private static readonly HashSet<string> Common = new(StringComparer.Ordinal)
        { "id", "name", "type", "code", "enabled", "parameters", "event", "timeoutMs", "threading" };

    public static JsonObject Normalize(JsonObject resource)
    {
        var trigger = Text(resource, "event", "startup");
        if (trigger is not ("startup" or "update" or "shutdown" or "timer" or "tagChange" or "message" or "scheduled"))
            throw new ArgumentException("Gateway event must be startup, update, shutdown, timer, tagChange, message or scheduled.");
        var allowed = new HashSet<string>(Common, StringComparer.Ordinal);
        foreach (var option in trigger switch
        {
            "timer" => new[] { "intervalMs", "delayType" },
            "tagChange" => ["tagPaths", "changeTriggers"],
            "message" => ["requiredPermission"],
            "scheduled" => ["cron", "timeZone"],
            _ => Array.Empty<string>()
        }) allowed.Add(option);
        // Earlier Designer builds sent the timer default even for new startup resources.
        // Accept and omit that legacy field without activating timer behavior.
        if (trigger == "startup" && resource.ContainsKey("intervalMs"))
        {
            Integer(resource, "intervalMs", 1000, 100, 86400000);
            allowed.Add("intervalMs");
        }
        if (resource.Any(pair => !allowed.Contains(pair.Key)))
            throw new ArgumentException("The gateway script contains an unknown option or an option for a different event.");
        var threading = Text(resource, "threading", "dedicated");
        if (threading is not ("dedicated" or "shared")) throw new ArgumentException("Script threading must be dedicated or shared.");
        var result = new JsonObject { ["event"] = trigger, ["timeoutMs"] = Integer(resource, "timeoutMs", 10000, 100, 300000), ["threading"] = threading };
        switch (trigger)
        {
            case "timer":
                result["intervalMs"] = Integer(resource, "intervalMs", 1000, 100, 86400000);
                var delay = Text(resource, "delayType", "fixedDelay");
                if (delay is not ("fixedDelay" or "fixedRate")) throw new ArgumentException("Timer delayType must be fixedDelay or fixedRate.");
                result["delayType"] = delay;
                break;
            case "tagChange":
                if (resource["tagPaths"] is not JsonArray paths || paths.Count is < 1 or > 64)
                    throw new ArgumentException("A tag-change script needs 1 to 64 absolute tag paths.");
                var seenPaths = new HashSet<string>(StringComparer.Ordinal);
                var normalizedPaths = new JsonArray();
                foreach (var path in paths)
                {
                    if (path is not JsonValue scalar || !scalar.TryGetValue<string>(out var text) || !seenPaths.Add(ValidateTagPath(text)))
                        throw new ArgumentException("Tag-change paths must be unique absolute strings.");
                    normalizedPaths.Add(text);
                }
                result["tagPaths"] = normalizedPaths;
                var triggers = resource.ContainsKey("changeTriggers") ? resource["changeTriggers"] as JsonArray : new JsonArray("value");
                if (triggers is null || triggers.Count is < 1 or > 3) throw new ArgumentException("Tag changeTriggers must contain 1 to 3 entries.");
                var seenTriggers = new HashSet<string>(StringComparer.Ordinal);
                foreach (var item in triggers)
                    if (item is not JsonValue scalar || !scalar.TryGetValue<string>(out var text) || text is not ("value" or "quality" or "timestamp") || !seenTriggers.Add(text))
                        throw new ArgumentException("Tag changeTriggers must be unique value, quality or timestamp entries.");
                result["changeTriggers"] = triggers.DeepClone();
                break;
            case "message":
                var permission = Text(resource, "requiredPermission", "operate");
                if (permission is not ("operate" or "admin")) throw new ArgumentException("Message requiredPermission must be operate or admin.");
                result["requiredPermission"] = permission;
                break;
            case "scheduled":
                var cron = Text(resource, "cron");
                var zone = Text(resource, "timeZone", TimeZoneInfo.Local.Id);
                ScriptCron.Validate(cron, zone);
                result["cron"] = string.Join(' ', cron.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
                result["timeZone"] = zone;
                break;
        }
        return result;
    }

    public static string ValidateTagPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 512 || path[0] != '[' || path.Any(char.IsControl))
            throw new ArgumentException("Tag-change paths need an absolute [provider]path of at most 512 characters.");
        var close = path.IndexOf(']');
        if (close <= 1 || close == path.Length - 1) throw new ArgumentException("A tag path needs a provider and a relative tag name.");
        var provider = path[1..close];
        var relative = path[(close + 1)..];
        if (provider.Any(character => char.IsWhiteSpace(character) || "[]{}\\/*?".Contains(character)) ||
            relative.IndexOfAny(['[', ']', '{', '}', '\\', '?']) >= 0)
            throw new ArgumentException("Tag-change paths contain invalid provider or path characters.");
        var segments = relative.Split('/');
        if (segments.Any(segment => string.IsNullOrWhiteSpace(segment) || segment is "." or "..") ||
            segments.Where((segment, index) => segment.Contains('*') && !(segment == "*" && index == segments.Length - 1 && index > 0)).Any())
            throw new ArgumentException("Tag-change wildcards are supported only as the final folder/* segment.");
        return path;
    }

    private static string Text(JsonObject value, string key, string? fallback = null)
    {
        if (!value.ContainsKey(key) && fallback is not null) return fallback;
        if (value[key] is JsonValue scalar && scalar.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text)) return text;
        throw new ArgumentException($"Script {key} must be nonempty text.");
    }

    private static int Integer(JsonObject value, string key, int fallback, int minimum, int maximum)
    {
        if (!value.ContainsKey(key)) return fallback;
        if (value[key] is JsonValue scalar && scalar.TryGetValue<int>(out var number) && number >= minimum && number <= maximum) return number;
        throw new ArgumentException($"Script {key} must be an integer from {minimum} through {maximum}.");
    }
}
