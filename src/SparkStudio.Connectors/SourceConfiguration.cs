using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SparkStudio.Connectors;

public static class SourceConfiguration
{
    public static readonly string[] Types = ["mtconnect", "i3x", "mqtt"];
    public static readonly string[] DataTypes = ["Boolean", "Int16", "UInt16", "Int32", "UInt32", "Int64", "Float", "Double", "String"];
    public static bool IsSource(ConnectionDefinition connection) => IsSource(connection.Type);
    public static bool IsSource(string type) => Types.Contains(type, StringComparer.Ordinal);
    public static string PointId(string connectionId, string mappingId, string address, string? selector) =>
        "src_" + Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new[] { connectionId, mappingId, address, selector ?? "" })))[..32].ToLowerInvariant();
    public static string TransportFingerprint(ConnectionDefinition connection)
    {
        var source = connection.Source ?? throw new ArgumentException("Source settings are required.");
        var transport = source with { Points = null, Mqtt = source.Mqtt is null ? null : source.Mqtt with { Mappings = null } };
        return Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new { connection.Type, Source = transport })));
    }
    public static bool CertificateReferenceValid(string value) => Regex.IsMatch(value, "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100)) && !value.Contains("..");
    public static SourcePoint Point(ConnectionDefinition connection, string id) =>
        connection.Source?.SavedPoints.SingleOrDefault(point => point.Id == id) ?? throw new ArgumentException("Select a saved source point.");
    public static SourceSettings Normalize(string type, SourceSettings settings)
    {
        var result = settings with { Points = settings.SavedPoints };
        if (type == "i3x") result = result with { I3x = (result.I3x ?? new()) with { ClientId = result.I3x?.ClientId ?? Guid.NewGuid().ToString("N") } };
        if (type == "mqtt") result = result with { Acquisition = "subscribe", Mqtt = (result.Mqtt ?? new()) with {
            ClientId = result.Mqtt?.ClientId ?? "spark-" + Guid.NewGuid().ToString("N"), Mappings = result.Mqtt?.Mappings ?? [] } };
        Validate(type, result);
        return result;
    }
    public static void Validate(string type, SourceSettings settings)
    {
        if (!IsSource(type)) throw new ArgumentException("Unsupported read source.");
        if (!Uri.TryCreate(settings.Endpoint, UriKind.Absolute, out var endpoint) || endpoint.UserInfo.Length != 0 || endpoint.Fragment.Length != 0 || settings.Endpoint.Length > 2048)
            throw new ArgumentException("Supply an absolute source endpoint without embedded credentials or fragment.");
        if (type == "mqtt" ? endpoint.Scheme is not ("mqtt" or "mqtts" or "ws" or "wss") : endpoint.Scheme is not ("http" or "https"))
            throw new ArgumentException("Choose a supported source endpoint scheme.");
        if (type == "i3x" && endpoint.Scheme == "http" && !endpoint.IsLoopback) throw new ArgumentException("i3X requires HTTPS except for a loopback development server.");
        if (settings.Acquisition is not ("poll" or "subscribe") || type == "mqtt" && settings.Acquisition != "subscribe") throw new ArgumentException("Unsupported source acquisition mode.");
        if (settings.IntervalMs is < 1000 or > 60000) throw new ArgumentException("Source interval must be 1000–60000 ms.");
        var limits = settings.EffectiveLimits;
        if (limits.DocumentBytes is < 1024 or > 8 * 1024 * 1024 || limits.ValueBytes is < 1 or > 65536
            || limits.StateBytes is < 1024 or > 16 * 1024 * 1024 || limits.QueueBytes is < 1024 or > 8 * 1024 * 1024
            || limits.QueueCount is < 1 or > 4096 || limits.PacketBytes is < 1024 or > 272 * 1024 || limits.PayloadBytes is < 1 or > 256 * 1024
            || limits.PayloadBytes >= limits.PacketBytes || limits.CatalogCount is < 1 or > 10000 || limits.CatalogBytes is < 1024 or > 8 * 1024 * 1024
            || limits.RequestTimeoutMs is < 100 or > 30000 || limits.OperationTimeoutMs is < 100 or > 30000 || limits.ConnectTimeoutMs is < 100 or > 30000
            || limits.DecodeNodes is < 1 or > 65536 || limits.DecodeBytes is < 1024 or > 32 * 1024 * 1024
            || limits.ScriptTimeoutMs is < 1 or > 100 || limits.ScriptResultBytes is < 1 or > 256 * 1024 || limits.ScriptResultDepth is < 1 or > 16
            || limits.ScriptResultMembers is < 1 or > 4096 || limits.ScriptResultLeaves is < 1 or > 1024 || limits.WorkerCount is < 1 or > 2)
            throw new ArgumentException("Source limits exceed the qualified resource profile.");
        var auth = settings.Authentication ?? new();
        if (auth.Mode is not ("none" or "basic" or "bearer" or "api-key")) throw new ArgumentException("Choose none, basic, bearer or api-key authentication.");
        foreach (var secret in new[] { auth.Username, auth.Password, auth.Token })
            if (secret is { Length: > 8192 } || secret?.Any(character => character is '\r' or '\n' or '\0') == true) throw new ArgumentException("Invalid source authentication value.");
        if (auth.Mode == "basic" && string.IsNullOrWhiteSpace(auth.Username) || auth.Mode is "bearer" or "api-key" && string.IsNullOrWhiteSpace(auth.Token))
            throw new ArgumentException("The selected authentication mode requires credentials.");
        if (auth.Mode == "api-key" && (!Regex.IsMatch(auth.Header, "^[A-Za-z][A-Za-z0-9-]{0,63}$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100))
            || new[] { "Host", "Content-Length", "Connection", "Transfer-Encoding", "Cookie", "Authorization" }.Contains(auth.Header, StringComparer.OrdinalIgnoreCase)))
            throw new ArgumentException("Choose a valid dedicated API-key header.");
        if (settings.Tls is { } tls)
        {
            foreach (var reference in new[] { tls.CaCertificateReference, tls.ClientCertificateReference, tls.ClientKeyReference })
                if (reference is { Length: > 0 } && !CertificateReferenceValid(reference)) throw new ArgumentException("Invalid gateway certificate reference.");
            if (tls.ServerCertificateSha256 is { Length: > 0 } pin && !Regex.IsMatch(pin, "^[A-Fa-f0-9]{64}$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100))) throw new ArgumentException("Certificate fingerprint must be SHA-256 hexadecimal.");
            if (tls.ClientKeyReference is { Length: > 0 } && string.IsNullOrWhiteSpace(tls.ClientCertificateReference)) throw new ArgumentException("A client key requires its certificate.");
        }
        if (settings.SavedPoints.Length > 10000 || JsonSerializer.SerializeToUtf8Bytes(settings.SavedPoints).Length > 768 * 1024) throw new ArgumentException("Source map exceeds 10,000 points or 768 KiB.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var point in settings.SavedPoints)
        {
            if (!Regex.IsMatch(point.Id, "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100)) || !ids.Add(point.Id)) throw new ArgumentException("Source point ids must be valid and unique.");
            if (string.IsNullOrWhiteSpace(point.Name) || point.Name.Length > 256 || string.IsNullOrWhiteSpace(point.Address) || point.Address.Length > 2048 || point.Address.Any(char.IsControl)
                || point.Selector is { Length: > 512 } || point.Selector?.Any(char.IsControl) == true || !DataTypes.Contains(point.DataType, StringComparer.Ordinal) || point.Writable)
                throw new ArgumentException("Source points require bounded name/address/selector, a scalar type and read-only access.");
            if (type == "i3x" && point.Selector is { Length: > 0 } pointer && !pointer.StartsWith('/')) throw new ArgumentException("i3X selectors are JSON pointers independent of element ids.");
        }
        if (type == "mtconnect")
        {
            var mt = settings.MtConnect ?? new();
            if (mt.HeartbeatMs is < 1000 or > 60000 || mt.Count is < 1 or > 10000 || mt.UserAgent.Length is < 1 or > 256 || mt.UserAgent.Any(char.IsControl)
                || mt.Device is { Length: > 512 } || mt.Path is { Length: > 2048 }) throw new ArgumentException("Invalid MTConnect filter, heartbeat, count or User-Agent.");
        }
        if (type == "i3x")
        {
            var i3x = settings.I3x ?? new();
            if (i3x.MaxDepth != 1 || i3x.ReconciliationSeconds is < 5 or > 300 || i3x.ClientId is { Length: > 128 }) throw new ArgumentException("i3X requires maxDepth 1, a bounded client id and 5–300 s reconciliation.");
        }
        if (type == "mqtt")
        {
            var mqtt = settings.Mqtt ?? new();
            if ((mqtt.Mappings?.Length ?? 0) > 10000 || JsonSerializer.SerializeToUtf8Bytes(new { settings.Points, mqtt.Mappings }).Length > 768 * 1024)
                throw new ArgumentException("The combined source point/mapping map exceeds 10,000 mappings or 768 KiB.");
            if (mqtt.ProtocolVersion is not ("3.1.1" or "5") || mqtt.Transport is not ("tcp" or "tls" or "websocket") || mqtt.ClientId is { Length: > 128 }
                || mqtt.KeepAliveSeconds is < 5 or > 300 || mqtt.SessionExpirySeconds is < 0 or > 3600) throw new ArgumentException("Invalid MQTT transport, protocol, client identity or session lifetime.");
            var mappingIds = new HashSet<string>(StringComparer.Ordinal);
            var filters = new HashSet<string>(StringComparer.Ordinal);
            foreach (var mapping in mqtt.Mappings ?? [])
            {
                if (!Regex.IsMatch(mapping.Id, "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100)) || !mappingIds.Add(mapping.Id)
                    || !filters.Add(mapping.TopicFilter) || !TopicFilterValid(mapping.TopicFilter)) throw new ArgumentException("MQTT mappings require unique ids and filters with valid wildcard syntax.");
                if (!TagPathValid(mapping.Root) || mapping.Root.Length > 384 || mapping.StripLevels is < 0 or > 64 || mapping.Tags is not ("explicit" or "review" or "automatic")
                    || mapping.Payload is not ("scalar" or "script") || mapping.StructuredUpdates is not ("snapshot" or "patch") || mapping.Retained is not ("uncertain" or "good" or "ignore")
                    || mapping.Qos is < 0 or > 1 || mapping.StaleAfterMs is < 0 or > 86400000 || mapping.MaximumTags is < 1 or > 10000 || mapping.PruneAfterSeconds is < 0 or > 31536000
                    || mapping.Shape is not ("scalar" or "structure") || mapping.Ordering is not ("receipt" or "sequence" or "timestamp")
                    || mapping.DataType is not null && !DataTypes.Contains(mapping.DataType, StringComparer.Ordinal)) throw new ArgumentException("Invalid MQTT mapping policy.");
                if (mapping.Tags == "explicit" && (mapping.TopicFilter.Contains('+') || mapping.TopicFilter.Contains('#'))) throw new ArgumentException("Explicit MQTT mappings require exact topics.");
                if (mapping.Payload == "script" && string.IsNullOrWhiteSpace(mapping.Script)) throw new ArgumentException("Script payload mode requires an extraction expression.");
                foreach (var script in new[] { mapping.Script, mapping.TimestampExpression, mapping.SequenceExpression, mapping.EpochExpression })
                    if (script is { Length: > 16384 }) throw new ArgumentException("Mapping expressions exceed 16 KiB.");
                if (mapping.Ordering != "receipt" && (string.IsNullOrWhiteSpace(mapping.SequenceExpression) || string.IsNullOrWhiteSpace(mapping.EpochExpression))) throw new ArgumentException("Application ordering requires a sequence/time and publisher epoch expression.");
            }
            foreach (var point in settings.SavedPoints)
                if (point.MappingId is not null && !mappingIds.Contains(point.MappingId)) throw new ArgumentException("A source point references an unknown MQTT mapping.");
        }
    }
    public static bool TopicFilterValid(string filter)
    {
        if (string.IsNullOrEmpty(filter) || Encoding.UTF8.GetByteCount(filter) > 65535 || filter.Any(char.IsControl)) return false;
        var levels = filter.Split('/');
        return levels.Select((level, index) => (level, index)).All(item => (!item.level.Contains('+') || item.level == "+")
            && (!item.level.Contains('#') || item.level == "#" && item.index == levels.Length - 1));
    }
    public static bool TagPathValid(string path) => path.StartsWith("[default]", StringComparison.Ordinal) && path.Length is > 9 and <= 512
        && path[9..].Split('/').All(segment => segment.Length > 0 && segment is not ("." or "..") && !segment.Any(character => char.IsControl(character) || "[]{}\\".Contains(character)));
    public static string TopicPath(SourceMqttMapping mapping, string topic, string? selector = null)
    {
        static string Segment(string value) => string.IsNullOrEmpty(value) || value is "." or ".." ? "_"
            : new(value.Select(character => char.IsControl(character) || "[]{}\\".Contains(character) ? '_' : character).ToArray());
        var levels = topic.Split('/').Skip(mapping.StripLevels).Select(Segment).ToList();
        if (selector is { Length: > 0 }) levels.AddRange(selector.TrimStart('/').Split('/').Select(level => Segment(level.Replace("~1", "/").Replace("~0", "~"))));
        var path = mapping.Root.TrimEnd('/') + "/" + string.Join('/', levels);
        if (!TagPathValid(path)) throw new SourceLimitException("Mapped tag path is invalid or exceeds 512 characters.");
        return path;
    }
    public static object? Coerce(object? value, string type)
    {
        if (value is JsonElement element) value = element.ValueKind switch {
            JsonValueKind.True => true, JsonValueKind.False => false, JsonValueKind.String => element.GetString(),
            JsonValueKind.Number when element.TryGetInt64(out var integer) => integer,
            JsonValueKind.Number => element.GetDecimal(), JsonValueKind.Null => null, _ => throw new ArgumentException("Expected a scalar source value.") };
        if (value is null) return null;
        var culture = CultureInfo.InvariantCulture;
        if (type == "String") return value is string stringValue ? stringValue : Convert.ToString(value, culture);
        if (type == "Boolean") return value is bool boolean ? boolean : value is string booleanText && bool.TryParse(booleanText, out var parsed) ? parsed : throw new ArgumentException("Expected a Boolean value.");
        if (type is "Float" or "Double")
        {
            var number = Convert.ToDouble(value, culture);
            if (!double.IsFinite(number) || type == "Float" && !float.IsFinite((float)number)) throw new ArgumentException("Expected a finite floating-point value.");
            return type == "Float" ? (object)(float)number : number;
        }
        var numeric = value is string scalar ? decimal.Parse(scalar, NumberStyles.Integer, culture) : Convert.ToDecimal(value, culture);
        if (numeric != decimal.Truncate(numeric)) throw new ArgumentException("A nonintegral value cannot be converted to an integer.");
        return type switch { "Int16" => checked((short)numeric), "UInt16" => checked((ushort)numeric), "Int32" => checked((int)numeric),
            "UInt32" => checked((uint)numeric), "Int64" => checked((long)numeric), _ => throw new ArgumentException("Unsupported scalar source type.") };
    }
}

public static class PointCatalog
{
    public static bool IsPointConnection(ConnectionDefinition connection) => DeviceConfiguration.IsDevice(connection) || SourceConfiguration.IsSource(connection);
    public static SourcePoint Point(ConnectionDefinition connection, string id)
    {
        if (SourceConfiguration.IsSource(connection)) return SourceConfiguration.Point(connection, id);
        var point = DeviceConfiguration.Point(connection, id);
        return new(point.Id, point.Name, point.Address, point.DataType, Writable: point.Writable);
    }
    public static bool CanWrite(ConnectionDefinition connection) => DeviceConfiguration.IsDevice(connection) || connection.Type == "opcua";
}
