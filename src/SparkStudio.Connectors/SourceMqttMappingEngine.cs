using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace SparkStudio.Connectors;

internal sealed class SourceMqttMappingEngine : IAsyncDisposable
{
    internal sealed record Result(IReadOnlyList<SourceValue> Values, IReadOnlyList<SourceDiscoveryItem> Discoveries, string? Error = null, bool Skipped = false, bool Published = false);
    private sealed record Leaf(string Selector, object? Value);
    private sealed record State(string Mapping, string Topic, string Selector, string Path, string Type,
        object? Value, string Quality, DateTimeOffset? SourceTime, DateTimeOffset Receipt,
        long Accepted, long Live, bool Retained, long Ordinal, string? Epoch, ulong? Sequence, bool SampleOnly = false);
    private sealed record TopicShape(string Root, IReadOnlyDictionary<string, string> Nodes);
    private sealed record OrderState(string Epoch, ulong Sequence, IReadOnlyList<string> Epochs);
    private readonly ConnectionDefinition connection;
    private readonly SourceLimits limits;
    private readonly SourceMemoryBudget budget = new();
    private readonly SourceScriptHost worker = new();
    private readonly bool preview;
    private readonly Dictionary<string, State> states = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> paths = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TopicShape> shapes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, OrderState> ordering = new(StringComparer.Ordinal);
    private SourceBindingRevision bindings;
    private long generation;
    private long stateBytes, catalogBytes;
    private long bindingIndexBytes;
    private int sampleCount;
    private int catalogCount, topicCount, catalogTruncated;
    private long acceptedMessages, liveAcceptedMessages, skippedMessages, decodeErrors, scriptErrors, typeErrors, catalogEvictions;
    private long lastAcceptedUtcTicks, lastLiveUtcTicks, lastAcceptedMonotonic, lastLiveMonotonic;
    private Dictionary<(string Mapping, string Topic), SourcePoint[]> selectedPoints = new();
    private Dictionary<string, SourcePoint[]> unmappedPoints = new(StringComparer.Ordinal);
    private HashSet<string> exactTopics = new(StringComparer.Ordinal);
    private SourceMqttMapping[] mappingsByPrecedence = [];
    internal SourceMqttMappingEngine(ConnectionDefinition connection, SourceBindingRevision bindings, long generation, bool preview = false)
    { this.connection = connection; limits = connection.Source!.EffectiveLimits; this.bindings = bindings; this.generation = generation; this.preview = preview; Update(bindings); }
    internal IReadOnlyList<SourceMqttMapping> Mappings => bindings.Mappings ?? connection.Source!.Mqtt?.Mappings ?? [];
    internal IReadOnlyDictionary<string, object?> Metrics() {
        var accepted = Interlocked.Read(ref lastAcceptedUtcTicks); var live = Interlocked.Read(ref lastLiveUtcTicks);
        return new Dictionary<string, object?> {
            ["catalogCount"] = Volatile.Read(ref catalogCount), ["catalogBytes"] = Interlocked.Read(ref catalogBytes),
            ["catalogTopics"] = Volatile.Read(ref topicCount), ["catalogTruncated"] = Volatile.Read(ref catalogTruncated) != 0,
            ["catalogEvictedLeaves"] = Interlocked.Read(ref catalogEvictions), ["stateBytes"] = Interlocked.Read(ref stateBytes),
            ["decodeErrors"] = Interlocked.Read(ref decodeErrors), ["scriptErrors"] = Interlocked.Read(ref scriptErrors), ["typeErrors"] = Interlocked.Read(ref typeErrors),
            ["skippedMessages"] = Interlocked.Read(ref skippedMessages), ["acceptedMessages"] = Interlocked.Read(ref acceptedMessages), ["liveAcceptedMessages"] = Interlocked.Read(ref liveAcceptedMessages),
            ["lastAcceptedAt"] = accepted == 0 ? null : new DateTimeOffset(accepted, TimeSpan.Zero),
            ["lastLiveAcceptedAt"] = live == 0 ? null : new DateTimeOffset(live, TimeSpan.Zero),
            ["lastLiveMqttValueAt"] = live == 0 ? null : new DateTimeOffset(live, TimeSpan.Zero),
            ["mqttValueTimeBasis"] = "admitted non-null extraction, including unimported review leaves; live excludes retained replay",
            ["effectiveLimits"] = limits,
            ["workerStarts"] = worker.WorkerStarts, ["workerReady"] = worker.WorkerReady, ["workerRestartMinimumMs"] = 1000, ["workerCooldownRemainingMs"] = worker.WorkerCooldownRemainingMs
        };
    }
    private void PublishResourceCounts() { Volatile.Write(ref catalogCount, states.Count); Volatile.Write(ref topicCount, shapes.Count); }
    internal void Update(SourceBindingRevision candidate)
    {
        var mappings = candidate.Mappings ?? connection.Source!.Mqtt?.Mappings ?? [];
        var retainedMappings = mappings.Select(mapping => mapping.Id).ToHashSet(StringComparer.Ordinal);
        var removedStates = states.Where(pair => !retainedMappings.Contains(pair.Value.Mapping)).ToArray();
        var removedShapes = shapes.Where(pair => !retainedMappings.Contains(pair.Key[..pair.Key.IndexOf('\0')])).ToArray();
        var removedOrders = ordering.Where(pair => !retainedMappings.Contains(pair.Key[..pair.Key.IndexOf('\0')])).ToArray();
        var removedMetadata = removedShapes.Sum(pair => ShapeCost(pair.Key, pair.Value)) + removedOrders.Sum(pair => OrderCost(pair.Value));
        var indexBytes = 256L + 128L * (candidate.Points.Count + mappings.Count);
        var nextBytes = stateBytes - bindingIndexBytes + indexBytes - removedStates.Sum(pair => StateCost(pair.Value)) - removedMetadata;
        var nextCatalog = catalogBytes - removedStates.Sum(pair => CatalogCost(pair.Value)) - removedMetadata;
        if (nextBytes > limits.StateBytes) throw new SourceLimitException("MQTT binding index exceeds its canonical state budget.");
        budget.SetBytes("state", nextBytes);
        try {
            var indexed = candidate.Points.Where(point => point.MappingId is not null).GroupBy(point => (Mapping: point.MappingId!, Topic: point.Address))
                .ToDictionary(group => group.Key, group => group.ToArray());
            var unassigned = candidate.Points.Where(point => point.MappingId is null).GroupBy(point => point.Address, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.ToArray(), StringComparer.Ordinal);
            var exact = mappings.GroupBy(mapping => mapping.TopicFilter, StringComparer.Ordinal).Where(group => group.Count() == 1)
                .Select(group => group.Key).ToHashSet(StringComparer.Ordinal);
            var ordered = mappings.Where(mapping => mapping.Enabled).OrderByDescending(mapping => mapping.TopicFilter, Comparer<string>.Create(CompareFilters)).ToArray();
            foreach (var pair in removedStates) {
                states.Remove(pair.Key); if (paths.GetValueOrDefault(pair.Value.Path) == pair.Key) paths.Remove(pair.Value.Path);
                if (pair.Value is { SampleOnly: true, Value: not null }) sampleCount--;
            }
            foreach (var pair in removedShapes) shapes.Remove(pair.Key);
            foreach (var pair in removedOrders) ordering.Remove(pair.Key);
            bindings = candidate; selectedPoints = indexed; unmappedPoints = unassigned; exactTopics = exact; mappingsByPrecedence = ordered;
            bindingIndexBytes = indexBytes; stateBytes = nextBytes; catalogBytes = nextCatalog; budget.SetBytes("catalog", catalogBytes);
            PublishResourceCounts();
        }
        catch { budget.SetBytes("state", stateBytes); throw; }
    }
    internal IReadOnlyList<SourceValue> Disabled()
    {
        var values = new List<SourceValue>();
        foreach (var point in bindings.Points)
        {
            var mapping = Mappings.FirstOrDefault(mapping => mapping.Id == point.MappingId) ?? Mappings.FirstOrDefault(mapping => Matches(mapping.TopicFilter, point.Address));
            if (mapping is null || mapping.Enabled) continue;
            var key = Identity(mapping.Id, point.Address, point.Selector ?? "");
            if (states.TryGetValue(key, out var prior)) states[key] = prior with { Quality = "Bad_Disabled" };
            values.Add(new(point.Id, null, point.DataType, "Bad_Disabled", ReceiptTimestamp: DateTimeOffset.UtcNow,
                Action: SourceValueAction.Retain, Generation: generation, BindingRevision: bindings.Revision, MonotonicReceipt: Stopwatch.GetTimestamp()));
        }
        return values;
    }
    internal void SetGeneration(long value) => generation = value;
    internal Task WarmAsync(CancellationToken ct) => Mappings.Any(mapping => mapping.Enabled && NeedsWorker(mapping)) ? worker.WarmAsync(ct) : Task.CompletedTask;
    internal Task WarmCandidateAsync(SourceBindingRevision candidate, CancellationToken ct) =>
        (candidate.Mappings ?? connection.Source!.Mqtt?.Mappings ?? []).Any(mapping => mapping.Enabled && NeedsWorker(mapping)) ? worker.WarmAsync(ct) : Task.CompletedTask;
    private static bool NeedsWorker(SourceMqttMapping mapping) => mapping.Payload == "script" || !string.IsNullOrWhiteSpace(mapping.TimestampExpression) || !string.IsNullOrWhiteSpace(mapping.SequenceExpression) || !string.IsNullOrWhiteSpace(mapping.EpochExpression);
    private static string Identity(string mapping, string topic, string selector) => mapping + "\0" + topic + "\0" + selector;
    private static string TopicIdentity(string mapping, string topic) => mapping + "\0" + topic;
    internal static bool Matches(string filter, string topic)
    {
        if (topic.StartsWith('$') && (filter.StartsWith('+') || filter.StartsWith('#'))) return false;
        var levels = filter.Split('/'); var actual = topic.Split('/');
        var index = 0;
        foreach (var level in levels) { if (level == "#") return true; if (index >= actual.Length || level != "+" && level != actual[index]) return false; index++; }
        return index == actual.Length;
    }
    internal static int CompareFilters(string left, string right)
    {
        static int Rank(string level) => level == "#" ? 0 : level == "+" ? 1 : 2;
        var a = left.Split('/'); var b = right.Split('/');
        for (var index = 0; index < Math.Min(a.Length, b.Length); index++) { var comparison = Rank(a[index]).CompareTo(Rank(b[index])); if (comparison != 0) return comparison; }
        return a.Length.CompareTo(b.Length);
    }
    internal SourceMqttMapping? Select(string topic) { foreach (var mapping in mappingsByPrecedence) if (Matches(mapping.TopicFilter, topic)) return mapping; return null; }

    internal async Task<Result> ProcessAsync(SourceMqttWire.Publish message, DateTimeOffset receipt, long monotonic, CancellationToken ct,
        Func<SourcePublication, CancellationToken, ValueTask<bool>>? admission = null)
    {
        var mapping = Select(message.Topic);
        if (mapping is null || message.Retained && mapping.Retained == "ignore") { Interlocked.Increment(ref skippedMessages); return new([], [], Skipped: true); }
        var selected = Selected(mapping.Id, message.Topic);
        var decodeReservation = Math.Min(limits.DecodeBytes, 32 * 1024 * 1024);
        var evaluating = false;
        try
        {
            budget.SetBytes("decode", decodeReservation);
            List<Leaf> leaves; Dictionary<string, string> nodes = new(StringComparer.Ordinal);
            string shape; DateTimeOffset? sourceTime = null; ulong? sequence = null; string? epoch = null;
            object? scalar = null; JsonElement? structured = null;
            if (mapping.Payload == "scalar") scalar = SourceScriptProtocol.DecodeScalar(message.Payload.Span, Math.Min(limits.ValueBytes, 64 * 1024));
            if (NeedsWorker(mapping))
            {
                var request = new SourceScriptRequest(SourceScriptProtocol.DecodeUtf8(message.Payload.Span, Math.Min(limits.PayloadBytes, 256 * 1024)), message.Topic, message.Retained,
                    receipt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture), mapping.Payload == "script" ? mapping.Script! : "null",
                    mapping.TimestampExpression, mapping.SequenceExpression, mapping.EpochExpression,
                    limits.ScriptResultBytes, limits.ScriptResultDepth, limits.ScriptResultMembers, limits.ScriptResultLeaves,
                    limits.ValueBytes, limits.DecodeNodes, limits.DecodeBytes, mapping.Ordering == "timestamp", mapping.Payload != "script");
                evaluating = true;
                var response = await worker.EvaluateAsync(request, limits.ScriptTimeoutMs, ct);
                if (!response.Success || response.Result is null && !response.Skip) throw new InvalidDataException(response.Error ?? "Invalid extraction result.");
                if (response.Timestamp is { } time) sourceTime = DateTimeOffset.Parse(time, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
                sequence = response.Sequence; epoch = response.Epoch;
                evaluating = false;
                if (mapping.Payload == "script")
                {
                    structured = response.Result;
                    if (response.Skip) { structured = null; scalar = null; }
                    else if (structured is { } extracted && extracted.ValueKind is not (JsonValueKind.Array or JsonValueKind.Object)) { scalar = SourceScriptProtocol.Scalar(extracted); structured = null; }
                }
            }
            // Whole null means intentional skip, including metadata/order/freshness state.
            if (structured is null && scalar is null) { Interlocked.Increment(ref skippedMessages); return new([], [], Skipped: true); }
            shape = structured?.ValueKind == JsonValueKind.Object ? "object" : structured?.ValueKind == JsonValueKind.Array ? "array" : "scalar";
            if (mapping.Shape == "scalar" && shape != "scalar" || mapping.Shape == "structure" && shape == "scalar")
                return Failure(selected, "Bad_TypeMismatch", "Extraction result disagrees with the mapping shape.", receipt, monotonic, message.Ordinal);
            if (structured is not null) leaves = Flatten(structured.Value, nodes);
            else { leaves = [new("", scalar)]; nodes.Add("", "scalar"); }
            var topicKey = TopicIdentity(mapping.Id, message.Topic);
            OrderState? newOrder = null;
            ordering.TryGetValue(topicKey, out var previousOrder);
            if (mapping.Ordering != "receipt")
            {
                if (sequence is null || epoch is null) throw new InvalidDataException("Ordered mapping needs a valid sequence/time and epoch.");
                if (previousOrder is not null)
                {
                    if (previousOrder.Epoch == epoch && sequence <= previousOrder.Sequence || previousOrder.Epoch != epoch && previousOrder.Epochs.Contains(epoch, StringComparer.Ordinal)) { Interlocked.Increment(ref skippedMessages); return new([], [], Skipped: true); }
                    if (previousOrder.Epoch != epoch && previousOrder.Epochs.Count >= 8) return Failure(selected, "Uncertain_DataLoss", "Publisher epoch history reached its bounded eight-epoch limit; use a new mapping identity to authorize further resets.", receipt, monotonic, message.Ordinal);
                }
                newOrder = new(epoch, sequence.Value, previousOrder is null ? [epoch] : previousOrder.Epoch == epoch ? previousOrder.Epochs : previousOrder.Epochs.Append(epoch).ToArray());
            }
            if (shapes.TryGetValue(topicKey, out var oldShape))
            {
                if (oldShape.Root != shape || nodes.Any(pair => oldShape.Nodes.TryGetValue(pair.Key, out var old) && old != pair.Value))
                    return Failure(selected, "Bad_TypeMismatch", "Extraction shape changed after its first accepted result.", receipt, monotonic, message.Ordinal);
            }
            // Validate the complete candidate before publishing any child or mutating its lock.
            var candidate = new List<State>(); var values = new List<SourceValue>(); var discoveries = new List<SourceDiscoveryItem>();
            var sampleSlots = 100 - sampleCount; var hasAcceptedValue = false;
            var localPaths = new Dictionary<string, string>(StringComparer.Ordinal); var present = new HashSet<string>(StringComparer.Ordinal);
            foreach (var leaf in leaves)
            {
                var key = Identity(mapping.Id, message.Topic, leaf.Selector); present.Add(key);
                if (leaf.Value is null) continue; // intentional null child never refreshes or clears
                var points = selected.Where(point => (point.Selector ?? "") == leaf.Selector).ToArray();
                if (mapping.Tags == "explicit" && points.Length == 0 && !preview) continue;
                hasAcceptedValue = true;
                object value;
                try { value = SourceScriptProtocol.Coerce(leaf.Value, mapping.DataType); }
                catch (InvalidDataException error) { return Failure(selected, "Bad_TypeMismatch", error.Message, receipt, monotonic, message.Ordinal); }
                var type = SourceScriptProtocol.DataType(value);
                if (states.TryGetValue(key, out var prior) && prior.Type != type) return Failure(selected, "Bad_TypeMismatch", "Leaf data type changed after its first accepted result.", receipt, monotonic, message.Ordinal);
                var path = SourceConfiguration.TopicPath(mapping, message.Topic, leaf.Selector);
                if (paths.TryGetValue(path, out var existing) && existing != key || localPaths.TryGetValue(path, out var local) && local != key)
                    return Failure(selected, "Bad_TypeMismatch", "Topic/selector sanitization collides with an existing raw identity at " + path + ".", receipt, monotonic, message.Ordinal);
                localPaths[path] = key;
                var quality = message.Retained && mapping.Retained != "good" ? "Uncertain_Retained" : "Good";
                var live = message.Retained && mapping.Retained != "good" ? prior?.Live ?? 0 : monotonic;
                var state = new State(mapping.Id, message.Topic, leaf.Selector, path, type, value, quality, sourceTime, receipt, monotonic, live, message.Retained, message.Ordinal, epoch, sequence);
                if (mapping.Tags == "review" && points.Length == 0 && !preview)
                {
                    var hasSampleSlot = prior is { SampleOnly: true, Value: not null } || sampleSlots > 0;
                    var keepSample = hasSampleSlot && JsonSerializer.SerializeToUtf8Bytes(value).Length <= 4096;
                    if (keepSample && prior is not { SampleOnly: true, Value: not null }) sampleSlots--;
                    candidate.Add(state with { Value = keepSample ? value : null, SampleOnly = true });
                }
                else candidate.Add(state);
                foreach (var point in points)
                {
                    try { var converted = SourceScriptProtocol.Coerce(value, point.DataType); values.Add(ToValue(point.Id, state, converted, point.DataType, monotonic)); }
                    catch (InvalidDataException error) { return Failure(selected, "Bad_TypeMismatch", error.Message, receipt, monotonic, message.Ordinal); }
                }
                if (mapping.Tags == "automatic")
                {
                    var id = SourceConfiguration.PointId(connection.Id, mapping.Id, message.Topic, leaf.Selector.Length == 0 ? null : leaf.Selector);
                    if (!values.Any(value => value.PointId == id)) values.Add(ToValue(id, state, value, type, monotonic));
                }
                if (preview || mapping.Tags is "review" or "automatic") discoveries.Add(new(mapping.Id, message.Topic, leaf.Selector.Length == 0 ? null : leaf.Selector,
                    leaf.Selector.Length == 0 ? message.Topic.Split('/').Last() : leaf.Selector.Split('/').Last(), type, path, value, quality, sourceTime, message.Retained, shape));
            }
            // A bounded metadata/value reservation precedes state installation. Imported state
            // is never evicted; unimported observed samples may be evicted as one topic unit.
            var lockedNodes = oldShape is null ? nodes : nodes.Keys.All(oldShape.Nodes.ContainsKey) ? oldShape.Nodes
                : oldShape.Nodes.Concat(nodes.Where(pair => !oldShape.Nodes.ContainsKey(pair.Key))).ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
            var nextShape = new TopicShape(shape, lockedNodes);
            var extraShapeBytes = ShapeCost(topicKey, nextShape) - (oldShape is null ? 0 : ShapeCost(topicKey, oldShape)) +
                (newOrder is null ? 0 : OrderCost(newOrder) - (previousOrder is null ? 0 : OrderCost(previousOrder)));
            if (lockedNodes.Count > limits.DecodeNodes || oldShape is null && shapes.Count >= limits.CatalogCount)
                { Volatile.Write(ref catalogTruncated, 1); return Failure(selected, "Uncertain_DataLoss", "MQTT shape/order metadata limit is full.", receipt, monotonic, message.Ordinal); }
            var additional = candidate.Where(state => !states.ContainsKey(Identity(state.Mapping, state.Topic, state.Selector))).ToArray();
            var newCount = states.Count + additional.Length;
            var nextState = stateBytes + extraShapeBytes; var nextCatalog = catalogBytes + extraShapeBytes;
            foreach (var state in candidate)
            {
                var key = Identity(state.Mapping, state.Topic, state.Selector);
                if (states.TryGetValue(key, out var previous)) { nextState -= StateCost(previous); nextCatalog -= CatalogCost(previous); }
                nextState += StateCost(state); nextCatalog += CatalogCost(state);
            }
            if (newCount > limits.CatalogCount || nextState > limits.StateBytes || nextCatalog > limits.CatalogBytes)
            {
                EvictUnimported(candidate.Select(state => TopicIdentity(state.Mapping, state.Topic)).ToHashSet(StringComparer.Ordinal));
                nextState = stateBytes + extraShapeBytes; nextCatalog = catalogBytes + extraShapeBytes;
                foreach (var state in candidate) { var key = Identity(state.Mapping, state.Topic, state.Selector); if (states.TryGetValue(key, out var old)) { nextState -= StateCost(old); nextCatalog -= CatalogCost(old); } nextState += StateCost(state); nextCatalog += CatalogCost(state); }
                newCount = states.Count + candidate.Count(state => !states.ContainsKey(Identity(state.Mapping, state.Topic, state.Selector)));
            }
            if (newCount > limits.CatalogCount || nextState > limits.StateBytes || nextCatalog > limits.CatalogBytes)
                { Volatile.Write(ref catalogTruncated, 1); return Failure(selected, "Uncertain_DataLoss", "MQTT observed catalog/state is full; candidate was not committed.", receipt, monotonic, message.Ordinal); }
            var clears = new List<(string Key, State State)>();
            if (mapping.StructuredUpdates == "snapshot" && shape != "scalar")
            {
                foreach (var point in selected)
                {
                    var key = Identity(mapping.Id, message.Topic, point.Selector ?? "");
                    if (!present.Contains(key))
                    {
                        values.Add(new(point.Id, null, point.DataType, "Bad_NoData", ReceiptTimestamp: receipt, Action: SourceValueAction.Clear,
                            Generation: generation, BindingRevision: bindings.Revision, IngressOrdinal: message.Ordinal, MonotonicReceipt: monotonic));
                        if (states.TryGetValue(key, out var previous)) clears.Add((key, previous with { Value = null, Quality = "Bad_NoData", SourceTime = null }));
                    }
                }
                // Automatic children can exist between ownership admission and the next binding
                // reconciliation. Their raw identities still take part in an authoritative snapshot.
                if (mapping.Tags == "automatic")
                {
                    foreach (var pair in states.Where(pair => pair.Value.Mapping == mapping.Id && pair.Value.Topic == message.Topic && !present.Contains(pair.Key)))
                    {
                        var state = pair.Value; var id = SourceConfiguration.PointId(connection.Id, mapping.Id, message.Topic, state.Selector.Length == 0 ? null : state.Selector);
                        if (!values.Any(value => value.PointId == id)) values.Add(new(id, null, state.Type, "Bad_NoData", ReceiptTimestamp: receipt, Action: SourceValueAction.Clear,
                            Generation: generation, BindingRevision: bindings.Revision, IngressOrdinal: message.Ordinal, MonotonicReceipt: monotonic));
                        if (!clears.Any(clear => clear.Key == pair.Key)) clears.Add((pair.Key, state with { Value = null, Quality = "Bad_NoData", SourceTime = null }));
                    }
                }
            }
            budget.SetBytes("state", nextState); budget.SetBytes("catalog", nextCatalog);
            var publication = new SourcePublication(values, discoveries, generation, bindings.Revision);
            if (admission is not null && !await admission(publication, ct))
                return Failure(selected, "Uncertain_DataLoss", "Gateway rejected the complete MQTT publication; no candidate values or definitions were committed.", receipt, monotonic, message.Ordinal);
            foreach (var state in candidate)
            {
                var key = Identity(state.Mapping, state.Topic, state.Selector);
                if (states.TryGetValue(key, out var old) && old.Path != state.Path) paths.Remove(old.Path);
                if (old is { SampleOnly: true, Value: not null }) sampleCount--;
                if (state is { SampleOnly: true, Value: not null }) sampleCount++;
                states[key] = state; paths[state.Path] = key;
            }
            stateBytes = nextState; catalogBytes = nextCatalog;
            shapes[topicKey] = nextShape;
            if (newOrder is not null) ordering[topicKey] = newOrder;
            foreach (var clear in clears)
            {
                if (states[clear.Key] is { SampleOnly: true, Value: not null }) sampleCount--;
                stateBytes += StateCost(clear.State) - StateCost(states[clear.Key]); states[clear.Key] = clear.State;
            }
            budget.SetBytes("state", stateBytes);
            if (hasAcceptedValue) {
                Interlocked.Increment(ref acceptedMessages);
                if (monotonic > lastAcceptedMonotonic) { lastAcceptedMonotonic = monotonic; Interlocked.Exchange(ref lastAcceptedUtcTicks, receipt.UtcTicks); }
                if (!message.Retained) {
                    Interlocked.Increment(ref liveAcceptedMessages);
                    if (monotonic > lastLiveMonotonic) { lastLiveMonotonic = monotonic; Interlocked.Exchange(ref lastLiveUtcTicks, receipt.UtcTicks); }
                }
            }
            return new(values, discoveries, Published: admission is not null);
        }
        catch (SourceLimitException error)
        { return Failure(selected, "Uncertain_DataLoss", error.Message, receipt, monotonic, message.Ordinal); }
        catch (Exception error) when (error is InvalidDataException or JsonException or DecoderFallbackException or TimeoutException or IOException or PlatformNotSupportedException)
        { return Failure(selected, "Bad_DecodingError", error.Message, receipt, monotonic, message.Ordinal, evaluating); }
        finally { budget.SetBytes("decode", 0); budget.SetBytes("state", stateBytes); budget.SetBytes("catalog", catalogBytes); PublishResourceCounts(); }
    }
    private List<Leaf> Flatten(JsonElement result, Dictionary<string, string> nodes)
    {
        var leaves = new List<Leaf>(); var members = 0; long bytes = 0;
        void Walk(JsonElement value, string selector, int depth)
        {
            if (depth > limits.ScriptResultDepth || ++members > limits.ScriptResultMembers) throw new InvalidDataException("Extraction result depth/member limit exceeded.");
            if (selector.Length > 512) throw new InvalidDataException("Extraction selector exceeds its limit.");
            var kind = value.ValueKind is JsonValueKind.Object ? "object" : value.ValueKind is JsonValueKind.Array ? "array" : "scalar";
            if (value.ValueKind != JsonValueKind.Null) nodes.Add(selector, kind);
            if (value.ValueKind == JsonValueKind.Object)
            {
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var property in value.EnumerateObject()) { if (!seen.Add(property.Name)) throw new InvalidDataException("Duplicate result member."); Walk(property.Value, selector + "/" + property.Name.Replace("~", "~0").Replace("/", "~1"), depth + 1); }
            }
            else if (value.ValueKind == JsonValueKind.Array) { var index = 0; foreach (var child in value.EnumerateArray()) Walk(child, selector + "/" + index++, depth + 1); }
            else
            {
                var scalar = SourceScriptProtocol.Scalar(value); var size = scalar is string text ? Encoding.UTF8.GetByteCount(text) : 16;
                bytes += size + Encoding.UTF8.GetByteCount(selector);
                if (size > limits.ValueBytes || bytes > limits.ScriptResultBytes || leaves.Count >= limits.ScriptResultLeaves) throw new InvalidDataException("Extraction leaf/result byte limit exceeded.");
                leaves.Add(new(selector, scalar));
            }
        }
        Walk(result, "", 0); return leaves;
    }
    private SourcePoint[] Selected(string mapping, string topic)
    {
        var assigned = selectedPoints.GetValueOrDefault((mapping, topic)) ?? [];
        if (!exactTopics.Contains(topic) || !unmappedPoints.TryGetValue(topic, out var unassigned)) return assigned;
        return assigned.Length == 0 ? unassigned : assigned.Concat(unassigned).ToArray();
    }
    private SourceValue ToValue(string id, State state, object? value, string type, long monotonic) => new(id, value, type, state.Quality,
        state.SourceTime, state.Receipt, state.Value is null ? SourceValueAction.Clear : SourceValueAction.Replace, Generation: generation,
        BindingRevision: bindings.Revision, Epoch: state.Epoch, Sequence: state.Sequence, IngressOrdinal: state.Ordinal, Retained: state.Retained, MonotonicReceipt: monotonic);
    private Result Failure(IReadOnlyList<SourcePoint> points, string quality, string error, DateTimeOffset receipt, long monotonic, long ordinal, bool scriptFault = false)
    {
        if (quality == "Bad_TypeMismatch") Interlocked.Increment(ref typeErrors);
        else if (quality == "Bad_DecodingError") { if (scriptFault) Interlocked.Increment(ref scriptErrors); else Interlocked.Increment(ref decodeErrors); }
        foreach (var point in points)
        {
            var mapping = point.MappingId ?? Select(point.Address)?.Id;
            if (mapping is not null && states.TryGetValue(Identity(mapping, point.Address, point.Selector ?? ""), out var prior))
                states[Identity(mapping, point.Address, point.Selector ?? "")] = prior with { Quality = quality };
        }
        return new(points.Select(point => new SourceValue(point.Id, null, point.DataType, quality, ReceiptTimestamp: receipt, Action: SourceValueAction.Retain,
            NativeStatus: error, Generation: generation, BindingRevision: bindings.Revision, IngressOrdinal: ordinal, MonotonicReceipt: monotonic)).ToArray(), [], error);
    }
    internal Result Loss(string? topic, string reason, long ordinal = 0)
    {
        var mapping = topic is null ? null : Select(topic);
        var points = topic is null || mapping is null ? bindings.Points : Selected(mapping.Id, topic);
        foreach (var pair in states.Where(pair => topic is null || pair.Value.Topic == topic).ToArray()) states[pair.Key] = pair.Value with { Quality = "Uncertain_DataLoss" };
        return Failure(points, "Uncertain_DataLoss", reason, DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), ordinal);
    }
    internal Result Reject(string topic, string quality, string reason, long ordinal)
    {
        if (quality == "Uncertain_DataLoss") return Loss(topic, reason, ordinal);
        var mapping = Select(topic);
        return Failure(mapping is null ? bindings.Points : Selected(mapping.Id, topic), quality, reason, DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), ordinal);
    }
    internal Result TransportDown(string quality, string reason)
    {
        foreach (var pair in states.ToArray()) states[pair.Key] = pair.Value with { Quality = quality };
        return Failure(bindings.Points, quality, reason, DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), 0);
    }
    internal IReadOnlyList<SourceValue> Stale(long monotonic)
    {
        var values = new List<SourceValue>();
        var expired = new HashSet<string>(StringComparer.Ordinal);
        foreach (var mapping in Mappings.Where(mapping => mapping.Enabled && mapping.StaleAfterMs > 0))
        {
            foreach (var point in bindings.Points.Where(point => point.MappingId == mapping.Id))
            {
                var key = Identity(mapping.Id, point.Address, point.Selector ?? "");
                if (states.TryGetValue(key, out var state) && (expired.Contains(key) || state.Quality is "Good" or "Uncertain_Retained" &&
                    (state.Live == 0 || Stopwatch.GetElapsedTime(state.Live, monotonic).TotalMilliseconds > mapping.StaleAfterMs)))
                {
                    expired.Add(key);
                    states[key] = state with { Quality = "Uncertain_Stale" };
                    values.Add(new(point.Id, null, point.DataType, "Uncertain_Stale", ReceiptTimestamp: DateTimeOffset.UtcNow, Action: SourceValueAction.Retain,
                        Generation: generation, BindingRevision: bindings.Revision, MonotonicReceipt: monotonic));
                }
            }
        }
        return values;
    }
    internal SourceReadBatch Read(SourceReadRequest request)
    {
        if (request.Points.Count > 1000) throw new ArgumentException("MQTT cached reads are limited to 1000 points.");
        var values = request.Points.Select(point =>
        {
            var mapping = point.MappingId ?? Select(point.Address)?.Id;
            if (mapping is null || !states.TryGetValue(Identity(mapping, point.Address, point.Selector ?? ""), out var state)) return SourceValue.NoData(point, request.Generation, request.BindingRevision);
            if (state.SampleOnly && state.Value is null) return SourceValue.NoData(point, request.Generation, request.BindingRevision);
            try { return ToValue(point.Id, state, state.Value is null ? null : SourceScriptProtocol.Coerce(state.Value, point.DataType), point.DataType, state.Accepted) with { Generation = request.Generation, BindingRevision = request.BindingRevision }; }
            catch (InvalidDataException error) { return new SourceValue(point.Id, null, point.DataType, "Bad_TypeMismatch", Action: SourceValueAction.Retain, NativeStatus: error.Message, Generation: request.Generation, BindingRevision: request.BindingRevision); }
        }).ToArray();
        return new(values);
    }
    internal SourceBrowsePage Browse(SourceBrowseRequest request)
    {
        var imported = bindings.Points.Select(point => Identity(point.MappingId ?? Select(point.Address)?.Id ?? "", point.Address, point.Selector ?? "")).ToHashSet(StringComparer.Ordinal);
        var entries = states.OrderBy(pair => pair.Key, StringComparer.Ordinal).Where(pair => request.Parent is null || pair.Value.Topic == request.Parent).Select((pair, index) =>
        {
            var state = pair.Value; var metadata = new Dictionary<string, object?> { ["quality"] = state.Quality, ["origin"] = "observed", ["imported"] = imported.Contains(pair.Key) };
            // Samples are bounded independently of the observed metadata index.
            if (index < 100 && state.Value is not null && JsonSerializer.SerializeToUtf8Bytes(state.Value).Length <= 4096) metadata["sample"] = state.Value;
            return new SourceBrowseEntry(state.Topic, state.Selector.Length == 0 ? state.Topic : state.Selector, true, state.Type,
                state.Selector.Length == 0 ? null : state.Selector, state.Topic, metadata, state.Mapping, state.Path);
        }).ToArray();
        return SourceBrowse.Page(entries, request, states.Count >= limits.CatalogCount || Volatile.Read(ref catalogTruncated) != 0);
    }
    private void EvictUnimported(HashSet<string> protectedTopics)
    {
        var imported = bindings.Points.Select(point => TopicIdentity(point.MappingId ?? Select(point.Address)?.Id ?? "", point.Address)).ToHashSet(StringComparer.Ordinal);
        foreach (var state in states.Values.Where(state => Mappings.Any(mapping => mapping.Id == state.Mapping && mapping.Tags == "automatic"))) imported.Add(TopicIdentity(state.Mapping, state.Topic));
        foreach (var group in states.Values.GroupBy(state => TopicIdentity(state.Mapping, state.Topic)).OrderBy(group => group.Min(state => state.Accepted)).ToArray())
        {
            if (imported.Contains(group.Key) || protectedTopics.Contains(group.Key)) continue;
            foreach (var state in group) { Interlocked.Increment(ref catalogEvictions); Volatile.Write(ref catalogTruncated, 1); if (state is { SampleOnly: true, Value: not null }) sampleCount--; states.Remove(Identity(state.Mapping, state.Topic, state.Selector)); paths.Remove(state.Path); stateBytes -= StateCost(state); catalogBytes -= CatalogCost(state); }
            if (shapes.Remove(group.Key, out var removed)) { var bytes = ShapeCost(group.Key, removed); stateBytes -= bytes; catalogBytes -= bytes; }
            if (ordering.Remove(group.Key, out var order)) { var bytes = OrderCost(order); stateBytes -= bytes; catalogBytes -= bytes; }
        }
        budget.SetBytes("state", stateBytes); budget.SetBytes("catalog", catalogBytes);
        PublishResourceCounts();
    }
    private static long ScalarCost(object? value) => value is string text ? Encoding.UTF8.GetByteCount(text) * 2L + 32 : 32;
    private static long ShapeCost(string topic, TopicShape shape) => 512L + topic.Length * 2L + shape.Nodes.Sum(pair => 128L + pair.Key.Length * 2L);
    private static long OrderCost(OrderState order) => 256L + order.Epochs.Sum(epoch => epoch.Length * 2L + 64);
    private static long CatalogCost(State state) => 512L + 2L * (state.Mapping.Length + state.Topic.Length + state.Selector.Length + state.Path.Length + state.Type.Length);
    private static long StateCost(State state) => CatalogCost(state) + ScalarCost(state.Value) + (state.Epoch?.Length ?? 0) * 2L;
    public async ValueTask DisposeAsync() { await worker.DisposeAsync(); budget.Dispose(); }
}
