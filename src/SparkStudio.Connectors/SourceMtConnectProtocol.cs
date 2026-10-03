using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Xml;

namespace SparkStudio.Connectors;

// Independently authored parser and reducers. The protocol reducer runs before
// latest-value delivery: conditions and collection deltas are not tag values.
internal sealed record MtConnectHeader(ulong Instance, ulong First, ulong Last, ulong Next,
    string Version, string AgentVersion, string? ModelChangeTime);
internal sealed record MtConnectItem(string Address, string Id, string DeviceUuid, string DeviceName,
    string ComponentPath, string Name, string Category, string Type, string Representation,
    bool Discrete, string? Units, string? NativeUnits)
{
    public bool Vector3 => Type.EndsWith("_3D", StringComparison.Ordinal) || Units?.EndsWith("_3D", StringComparison.Ordinal) == true;
    public bool Supported => Category is "SAMPLE" or "EVENT" or "CONDITION"
        && Representation is "VALUE" or "DATA_SET" or "TABLE";
    public string DataType => Category == "SAMPLE" && !Vector3
        && Representation == "VALUE" ? "Double" : Category == "EVENT" && Representation == "VALUE"
        && Type is "PART_COUNT" or "LINE_NUMBER" or "TOOL_NUMBER" ? "Int64" : "String";
}
internal sealed record MtConnectObservation(string Address, string ItemId, string Kind,
    ulong Sequence, DateTimeOffset Timestamp, string Text, string? ConditionId,
    string? NativeCode, string? NativeSeverity, bool Reset, IReadOnlyList<MtConnectEntry> Entries);
internal sealed record MtConnectEntry(string Key, bool Removed, string Text, IReadOnlyList<MtConnectCell> Cells);
internal sealed record MtConnectCell(string Key, bool Removed, string Text);
internal sealed record MtConnectDocument(MtConnectHeader Header, IReadOnlyList<MtConnectObservation> Observations);
internal sealed record MtConnectProbe(MtConnectHeader Header, IReadOnlyList<MtConnectItem> Items);
internal sealed class MtConnectProtocolException(string code, string message) : IOException(message)
{
    public string Code { get; } = code;
    public ulong? LostFrom { get; init; }
    public ulong? LostThrough { get; init; }
}

internal static class MtConnectXml
{
    private sealed record Node(string Name, string Namespace, Dictionary<string, string> Attributes,
        List<Node> Children, string Text)
    {
        public string? Attr(string name) => Attributes.GetValueOrDefault(name);
    }
    public const int MaximumNodes = 65_536;
    public const int MaximumDecodeBytes = 32 * 1024 * 1024;
    public const int MaximumDepth = 64;
    private static Node Parse(ReadOnlyMemory<byte> document, int maximumBytes, SourceLimits? limits)
    {
        if (document.Length > maximumBytes) throw new MtConnectProtocolException("LIMIT", "MTConnect document exceeds the decoded byte limit.");
        using var stream = new MemoryStream(document.ToArray(), false);
        using var reader = XmlReader.Create(stream, new XmlReaderSettings {
            DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null,
            MaxCharactersInDocument = maximumBytes, MaxCharactersFromEntities = 0,
            IgnoreComments = true, IgnoreProcessingInstructions = true });
        var nodes = 0;
        long allocated = document.Length * 2L;
        Node ReadNode()
        {
            if (++nodes > (limits?.DecodeNodes ?? MaximumNodes) || reader.Depth > MaximumDepth)
                throw new MtConnectProtocolException("LIMIT", "MTConnect XML node/depth limit exceeded.");
            allocated += 192 + reader.LocalName.Length * 2L + reader.NamespaceURI.Length * 2L;
            var attrs = new Dictionary<string, string>(StringComparer.Ordinal);
            if (reader.MoveToFirstAttribute()) do {
                allocated += 96 + (reader.LocalName.Length + reader.Value.Length) * 2L;
                if (!attrs.TryAdd(reader.LocalName, reader.Value)) throw new MtConnectProtocolException("XML", "Duplicate MTConnect attribute names.");
            } while (reader.MoveToNextAttribute());
            reader.MoveToElement();
            var name = reader.LocalName;
            var ns = reader.NamespaceURI;
            var children = new List<Node>();
            var text = new StringBuilder();
            CheckBudget();
            if (reader.IsEmptyElement) { reader.Read(); return new(name, ns, attrs, children, ""); }
            reader.Read();
            while (reader.NodeType != XmlNodeType.EndElement) {
                if (reader.EOF) throw new MtConnectProtocolException("XML", "Incomplete MTConnect document.");
                if (reader.NodeType == XmlNodeType.Element) {
                    var child = ReadNode();
                    if (child.Namespace != ns) throw new MtConnectProtocolException("XML", "Mixed namespaces in MTConnect document.");
                    children.Add(child);
                } else if (reader.NodeType is XmlNodeType.Text or XmlNodeType.CDATA or XmlNodeType.SignificantWhitespace or XmlNodeType.Whitespace) {
                    allocated += reader.Value.Length * 4L;
                    CheckBudget();
                    text.Append(reader.Value);
                    reader.Read();
                } else reader.Read();
            }
            reader.Read();
            return new(name, ns, attrs, children, text.ToString().Trim());
        }
        void CheckBudget() {
            if (allocated > (limits?.DecodeBytes ?? MaximumDecodeBytes)) throw new MtConnectProtocolException("LIMIT", "MTConnect decoded working storage exceeds its configured ceiling.");
        }
        reader.MoveToContent();
        if (reader.NodeType != XmlNodeType.Element) throw new MtConnectProtocolException("XML", "Missing MTConnect document root.");
        var root = ReadNode();
        reader.MoveToContent();
        if (!reader.EOF) throw new MtConnectProtocolException("XML", "Unexpected content after MTConnect document.");
        var expectedPrefix = "urn:mtconnect.org:" + root.Name + ":";
        if (!root.Namespace.StartsWith(expectedPrefix, StringComparison.Ordinal)
            || !Version.TryParse(root.Namespace[expectedPrefix.Length..], out var version)
            || version.Major != 2 || version.Minor is < 5 or > 8)
            throw new MtConnectProtocolException("VERSION", "MTConnect namespace must use the qualified 2.5–2.8 XML profile.");
        if (root.Name is "MTConnectError" or "MTConnectErrors") {
            var errors = Descendants(root).Where(n => n.Name is "Error" or "OutOfRange" or "Unauthorized" or "InvalidXPath" or "InvalidRequest").ToArray();
            var error = errors.FirstOrDefault();
            var code = error?.Attr("errorCode") ?? error?.Name ?? "AGENT_ERROR";
            if (code == "OutOfRange") code = "OUT_OF_RANGE";
            if (code == "Unauthorized") code = "UNAUTHORIZED";
            throw new MtConnectProtocolException(code, "MTConnect agent returned " + code + ".");
        }
        return root;
    }
    private static IEnumerable<Node> Descendants(Node parent)
    {
        foreach (var child in parent.Children) {
            yield return child;
            foreach (var nested in Descendants(child)) yield return nested;
        }
    }
    private static MtConnectHeader Header(Node root)
    {
        var header = root.Children.SingleOrDefault(n => n.Name == "Header")
            ?? throw new MtConnectProtocolException("XML", "Missing MTConnect Header.");
        var streams = root.Name == "MTConnectStreams";
        ulong Number(string key, bool required = true) {
            var raw = header.Attr(key);
            if (raw is null && !required) return 0;
            return ulong.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n
                : throw new MtConnectProtocolException("XML", "Invalid unsigned MTConnect Header " + key + ".");
        }
        var first = Number("firstSequence", streams); var last = Number("lastSequence", streams); var next = Number("nextSequence", streams);
        if (streams && (first > next || last < first && first - last > 1))
            throw new MtConnectProtocolException("CURSOR", "Inconsistent MTConnect sequence boundaries.");
        return new(Number("instanceId"), first, last, next,
            root.Namespace[(root.Namespace.LastIndexOf(':') + 1)..], header.Attr("version") ?? "unknown",
            header.Attr("deviceModelChangeTime"));
    }
    public static MtConnectProbe Probe(ReadOnlyMemory<byte> document, int maximumBytes, SourceLimits? limits = null)
    {
        var root = Parse(document, maximumBytes, limits);
        if (root.Name != "MTConnectDevices") throw new MtConnectProtocolException("XML", "Expected MTConnectDevices probe response.");
        var items = new List<MtConnectItem>();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        void Visit(Node node, string uuid, string device, string components) {
            if (node.Name is "Device" or "Agent") {
                uuid = Required(node, "uuid"); device = node.Attr("name") ?? Required(node, "id"); components = "";
            } else if (node.Name == "DataItem") {
                var id = Required(node, "id");
                if (!ids.Add(id)) throw new MtConnectProtocolException("MODEL", "Probe contains duplicate data item ids.");
                if (items.Count >= (limits?.CatalogCount ?? 10_000)) throw new MtConnectProtocolException("LIMIT", "MTConnect catalog exceeds its configured item ceiling.");
                var representation = node.Attr("representation") ?? "VALUE";
                items.Add(new(uuid + "/" + id, id, uuid, device, components, node.Attr("name") ?? id,
                    Required(node, "category"), Required(node, "type"), representation,
                    node.Attr("discrete") is "true" or "1", node.Attr("units"), node.Attr("nativeUnits")));
                return;
            } else if (node.Attr("id") is not null && node.Name is not "Description" and not "DataItems") {
                components = components.Length == 0 ? node.Attr("name") ?? node.Attr("id")!
                    : components + "/" + (node.Attr("name") ?? node.Attr("id"));
            }
            foreach (var child in node.Children) Visit(child, uuid, device, components);
        }
        foreach (var device in root.Children.Where(n => n.Name == "Devices").SelectMany(n => n.Children)) Visit(device, "", "", "");
        return new(Header(root), items);
    }
    private static string Required(Node node, string attr) => node.Attr(attr) is { Length: > 0 } value ? value
        : throw new MtConnectProtocolException("XML", "Missing MTConnect " + attr + ".");
    public static MtConnectDocument Streams(ReadOnlyMemory<byte> document, int maximumBytes, SourceLimits? limits = null)
    {
        var root = Parse(document, maximumBytes, limits);
        if (root.Name != "MTConnectStreams") throw new MtConnectProtocolException("XML", "Expected MTConnectStreams response.");
        var header = Header(root);
        var observations = new List<MtConnectObservation>();
        void Visit(Node node, string uuid) {
            if (node.Name == "DeviceStream") uuid = Required(node, "uuid");
            if (node.Attr("dataItemId") is { } id) {
                if (!ulong.TryParse(Required(node, "sequence"), NumberStyles.None, CultureInfo.InvariantCulture, out var seq)
                    || seq >= header.Next)
                    throw new MtConnectProtocolException("CURSOR", "Invalid MTConnect observation sequence.");
                if (!DateTimeOffset.TryParse(Required(node, "timestamp"), CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var stamp))
                    throw new MtConnectProtocolException("XML", "Invalid MTConnect observation timestamp.");
                var entries = node.Children.Where(n => n.Name == "Entry").Select(entry => new MtConnectEntry(
                    Required(entry, "key"), Removed(entry), entry.Text,
                    entry.Children.Where(n => n.Name == "Cell").Select(cell => new MtConnectCell(
                        Required(cell, "key"), Removed(cell), cell.Text)).ToArray())).ToArray();
                observations.Add(new(uuid + "/" + id, id, node.Name, seq, stamp, node.Text,
                    node.Attr("conditionId"), node.Attr("nativeCode"), node.Attr("nativeSeverity"),
                    node.Attr("resetTriggered") is { Length: > 0 }, entries));
                return;
            }
            foreach (var child in node.Children) Visit(child, uuid);
        }
        foreach (var streams in root.Children.Where(n => n.Name == "Streams")) Visit(streams, "");
        return new(header, observations);
    }
    private static bool Removed(Node node) => node.Attr("removed") is "true" or "1";
}

internal sealed record MtConnectReducedValue(object? Value, string Quality, DateTimeOffset? Timestamp, ulong? Sequence, string? NativeStatus = null);
internal sealed class MtConnectReducer : IDisposable
{
    private sealed class State
    {
        public string? Scalar;
        public bool Available;
        public DateTimeOffset Timestamp;
        public ulong Sequence;
        public Dictionary<string, MtConnectObservation> Conditions = new(StringComparer.Ordinal);
        public SortedDictionary<string, string> Entries = new(StringComparer.Ordinal);
        public SortedDictionary<string, SortedDictionary<string, string>> Rows = new(StringComparer.Ordinal);
        public State Clone() => new() { Scalar = Scalar, Available = Available, Timestamp = Timestamp, Sequence = Sequence,
            Conditions = new(Conditions, StringComparer.Ordinal), Entries = new(Entries, StringComparer.Ordinal),
            Rows = new(Rows.ToDictionary(k => k.Key, k => new SortedDictionary<string, string>(k.Value, StringComparer.Ordinal)), StringComparer.Ordinal) };
    }
    private readonly Dictionary<string, MtConnectItem> items;
    private readonly SourceMemoryBudget budget = new();
    private readonly int maximumStateBytes;
    private readonly int maximumValueBytes;
    private Dictionary<string, State> states = new(StringComparer.Ordinal);
    public MtConnectHeader? Header { get; private set; }
    public long StateBytes { get; private set; }
    public const long MaximumStateBytes = 16 * 1024 * 1024;
    public MtConnectReducer(IEnumerable<MtConnectItem> catalog, SourceLimits? limits = null)
    {
        items = catalog.ToDictionary(i => i.Address, StringComparer.Ordinal);
        maximumStateBytes = limits?.StateBytes ?? (int)MaximumStateBytes;
        maximumValueBytes = limits?.ValueBytes ?? 64 * 1024;
    }
    public void Apply(MtConnectDocument document, bool snapshot)
    {
        if (!snapshot && (Header is null || document.Header.Instance != Header.Instance))
            throw new MtConnectProtocolException("INSTANCE_CHANGED", "MTConnect instance changed; a current snapshot is required.");
        if (!snapshot && document.Header.First > Header!.Next)
            throw new MtConnectProtocolException("OUT_OF_RANGE", "MTConnect saved cursor expired from the agent buffer.") {
                LostFrom = Header.Next, LostThrough = document.Header.First - 1 };
        if (!snapshot && document.Header.Next < Header!.Next)
            throw new MtConnectProtocolException("CURSOR", "MTConnect cursor moved backwards within one instance.");
        var candidate = snapshot ? new Dictionary<string, State>(StringComparer.Ordinal)
            : states.ToDictionary(k => k.Key, k => k.Value.Clone(), StringComparer.Ordinal);
        // Current condition observations are a complete set, not ordered transitions.
        // Process availability/Normal before activation so an old Normal cannot erase a fault.
        var observations = snapshot ? document.Observations.OrderBy(o => o.Kind is "Normal" or "Unavailable" ? 0 : 1).ThenBy(o => o.Sequence)
            : document.Observations.OrderBy(o => o.Sequence);
        foreach (var observation in observations) {
            if (!items.TryGetValue(observation.Address, out var item) || !item.Supported) continue;
            if (!snapshot && observation.Sequence < Header!.Next) continue;
            if (!candidate.TryGetValue(item.Address, out var state)) candidate[item.Address] = state = new();
            if (!snapshot && observation.Sequence <= state.Sequence && state.Available) continue;
            state.Timestamp = observation.Timestamp; state.Sequence = Math.Max(state.Sequence, observation.Sequence);
            var unavailable = observation.Kind == "Unavailable" || observation.Text == "UNAVAILABLE";
            if (unavailable) {
                state.Available = false; state.Scalar = null; state.Conditions.Clear(); state.Entries.Clear(); state.Rows.Clear(); continue;
            }
            state.Available = true;
            if (item.Category == "CONDITION") {
                var identity = observation.ConditionId is { Length: > 0 } c ? c : observation.NativeCode;
                if (observation.Kind == "Normal") {
                    if (identity is { Length: > 0 }) state.Conditions.Remove(identity); else if (!snapshot) state.Conditions.Clear();
                } else if (observation.Kind is "Fault" or "Warning") {
                    if (string.IsNullOrEmpty(identity)) throw new MtConnectProtocolException("CONDITION_ID", "Active condition requires conditionId or nativeCode in the qualified profile.");
                    state.Conditions[identity] = observation;
                } else throw new MtConnectProtocolException("CONDITION", "Unsupported MTConnect condition state.");
            } else if (item.Representation is "DATA_SET" or "TABLE") {
                if (snapshot || observation.Reset || item.Discrete) { state.Entries.Clear(); state.Rows.Clear(); }
                var duplicateEntries = new HashSet<string>(StringComparer.Ordinal);
                foreach (var entry in observation.Entries) {
                    if (!duplicateEntries.Add(entry.Key)) throw new MtConnectProtocolException("DATA_SET", "Duplicate MTConnect entry key.");
                    if (item.Representation == "DATA_SET") {
                        if (entry.Removed) state.Entries.Remove(entry.Key); else state.Entries[entry.Key] = entry.Text;
                    } else {
                        if (entry.Removed) { state.Rows.Remove(entry.Key); continue; }
                        if (!state.Rows.TryGetValue(entry.Key, out var row)) state.Rows[entry.Key] = row = new(StringComparer.Ordinal);
                        var duplicateCells = new HashSet<string>(StringComparer.Ordinal);
                        foreach (var cell in entry.Cells) {
                            if (!duplicateCells.Add(cell.Key)) throw new MtConnectProtocolException("TABLE", "Duplicate MTConnect cell key.");
                            if (cell.Removed) row.Remove(cell.Key); else row[cell.Key] = cell.Text;
                        }
                    }
                }
            } else state.Scalar = observation.Text;
        }
        long bytes = 0;
        foreach (var (address, state) in candidate) {
            bytes += 256 + address.Length * 2L + (state.Scalar?.Length ?? 0) * 2L;
            foreach (var (key, condition) in state.Conditions)
                bytes += 384 + (key.Length + condition.Text.Length + (condition.NativeCode?.Length ?? 0) + (condition.NativeSeverity?.Length ?? 0)) * 2L;
            foreach (var (key, value) in state.Entries) bytes += 128 + (key.Length + value.Length) * 2L;
            foreach (var (rowKey, row) in state.Rows) {
                bytes += 192 + rowKey.Length * 2L;
                foreach (var (key, value) in row) bytes += 128 + (key.Length + value.Length) * 2L;
            }
            if (bytes > maximumStateBytes) throw new MtConnectProtocolException("LIMIT", "MTConnect canonical state exceeds its configured byte ceiling.");
        }
        budget.SetBytes("state", bytes);
        states = candidate; StateBytes = bytes; Header = document.Header;
    }
    public MtConnectReducedValue Read(string address, string? selector)
    {
        if (!items.TryGetValue(address, out var item) || !item.Supported)
            return new(null, "Bad_NotSupported", null, null);
        if (!states.TryGetValue(address, out var state) || !state.Available)
            return new(null, "Bad_NoData", state?.Timestamp, state?.Sequence, "UNAVAILABLE");
        object? value;
        if (item.Category == "CONDITION") {
            var representative = state.Conditions.OrderByDescending(k => k.Value.Kind == "Fault" ? 2 : 1)
                .ThenBy(k => k.Key, StringComparer.Ordinal).Select(k => k.Value).FirstOrDefault();
            value = selector switch {
                null or "" or "level" => representative?.Kind.ToUpperInvariant() ?? "NORMAL",
                "nativeCode" => representative?.NativeCode ?? "",
                "nativeSeverity" => representative?.NativeSeverity ?? "",
                "message" => representative?.Text ?? "",
                "active" => JsonSerializer.Serialize(state.Conditions.OrderBy(k => k.Key, StringComparer.Ordinal)
                    .Select(k => new { conditionId = k.Key, level = k.Value.Kind.ToUpperInvariant(), nativeCode = k.Value.NativeCode,
                        nativeSeverity = k.Value.NativeSeverity, message = k.Value.Text })),
                _ => null };
        } else if (item.Representation == "DATA_SET") {
            var segments = string.IsNullOrEmpty(selector) ? [] : PointerSegments(selector);
            value = segments.Length switch { 0 => JsonSerializer.Serialize(state.Entries),
                1 => state.Entries.GetValueOrDefault(segments[0]), _ => null };
        } else if (item.Representation == "TABLE") {
            var segments = string.IsNullOrEmpty(selector) ? [] : PointerSegments(selector);
            value = segments.Length switch { 0 => JsonSerializer.Serialize(state.Rows),
                1 => state.Rows.TryGetValue(segments[0], out var row) ? JsonSerializer.Serialize(row) : null,
                2 => state.Rows.TryGetValue(segments[0], out var row) ? row.GetValueOrDefault(segments[1]) : null, _ => null };
        } else if (item.Vector3 && selector is "x" or "y" or "z") {
            var parts = (state.Scalar ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 3) return new(null, "Bad_DecodingError", state.Timestamp, state.Sequence);
            value = parts[selector == "x" ? 0 : selector == "y" ? 1 : 2];
        } else value = string.IsNullOrEmpty(selector) ? state.Scalar : null;
        if (value is null) return new(null, "Bad_NoData", state.Timestamp, state.Sequence);
        if (Encoding.UTF8.GetByteCount(value.ToString()!) > maximumValueBytes) return new(null, "Bad_DecodingError", state.Timestamp, state.Sequence, "VALUE_LIMIT");
        return new(value, "Good", state.Timestamp, state.Sequence);
    }
    private static string[] PointerSegments(string selector)
    {
        if (!selector.StartsWith('/')) return [selector];
        return selector[1..].Split('/').Select(s => s.Replace("~1", "/", StringComparison.Ordinal).Replace("~0", "~", StringComparison.Ordinal)).ToArray();
    }
    public void Dispose() { states.Clear(); budget.Dispose(); }
}
