using System.Buffers;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SparkStudio.Connectors;

internal sealed record I3xServerInfo(string SpecVersion, string? ServerVersion, bool Stream);
internal sealed record I3xObject(string Id, string Name, string? ParentId, string TypeId, bool Composition,
    JsonElement Schema);
internal sealed record I3xVqt(string ElementId, JsonElement Value, string Quality, DateTimeOffset Timestamp,
    string? Error = null);
internal sealed record I3xSyncBatch(ulong Sequence, IReadOnlyList<I3xVqt> Updates);
internal sealed record I3xSyncResult(IReadOnlyList<I3xSyncBatch> Batches, bool Overflow);
internal sealed class I3xProtocolException(string message, HttpStatusCode? status = null) : IOException(message)
{
    public HttpStatusCode? Status { get; } = status;
    public bool Permanent => Status is HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized
        or HttpStatusCode.Forbidden || Status is null;
}

// Independently authored i3X 1.0 client. No values or credentials are included in errors.
internal sealed class SourceI3xClient : IDisposable
{
    private readonly HttpClient client;
    private readonly bool ownsClient;
    private readonly Uri endpoint;
    private readonly int documentBytes;
    private readonly int timeoutMs;
    private readonly SourceLimits limits;
    private readonly SourceTransportTelemetry? telemetry;
    private readonly SourceMemoryBudget workingMemory = new();
    private readonly SemaphoreSlim decodeSlots;
    private readonly object admissionGate = new();
    private long admittedDecodeBytes;
    private bool disposed;
    private static readonly Regex TimestampPattern = new(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,18})?Z$",
        RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    public SourceI3xClient(Uri endpoint, int documentBytes, int timeoutMs, HttpClient? client = null,
        AuthenticationHeaderValue? authentication = null, string? apiKeyHeader = null, string? apiKey = null,
        SourceLimits? limits = null, SourceTransportTelemetry? telemetry = null)
    {
        if (!endpoint.IsAbsoluteUri || endpoint.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(endpoint.UserInfo)
            || !string.IsNullOrEmpty(endpoint.Query) || !string.IsNullOrEmpty(endpoint.Fragment))
            throw new ArgumentException("i3X needs an absolute HTTP(S) base URL without credentials, query or fragment.");
        if (documentBytes is < 1024 or > 8 * 1024 * 1024 || timeoutMs is < 100 or > 30000)
            throw new ArgumentException("i3X document and request limits are outside the supported profile.");
        this.endpoint = new Uri(endpoint.AbsoluteUri.TrimEnd('/') + "/");
        this.documentBytes = documentBytes;
        this.timeoutMs = timeoutMs;
        this.limits = limits ?? new(DocumentBytes: documentBytes, RequestTimeoutMs: timeoutMs);
        this.telemetry = telemetry;
        var slots = Math.Max(1, this.limits.DecodeBytes / checked(documentBytes * 8));
        decodeSlots = new(slots, slots);
        ownsClient = client is null;
        this.client = client ?? new HttpClient(new SocketsHttpHandler {
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
            AllowAutoRedirect = false, ConnectTimeout = TimeSpan.FromSeconds(5), MaxConnectionsPerServer = 4,
        }) { Timeout = Timeout.InfiniteTimeSpan };
        if (authentication is not null) this.client.DefaultRequestHeaders.Authorization = authentication;
        if (!string.IsNullOrEmpty(apiKeyHeader))
        {
            if (string.IsNullOrEmpty(apiKey) || !this.client.DefaultRequestHeaders.TryAddWithoutValidation(apiKeyHeader, apiKey))
                throw new ArgumentException("Invalid i3X API-key header.");
        }
    }

    public async Task<I3xServerInfo> InfoAsync(CancellationToken cancellation)
    {
        using var reply = await JsonAsync(HttpMethod.Get, "info", null, cancellation);
        var root = reply.Document.RootElement;
        if (root.ValueKind == JsonValueKind.Object
            && (root.TryGetProperty("success", out _) || root.TryGetProperty("result", out _)))
        {
            RequireSuccess(root);
            if (!root.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Object)
                throw new I3xProtocolException("i3X /info omitted its result object.");
            root = result;
        }
        var version = RequiredString(root, "specVersion");
        if (!Version.TryParse(version, out var parsed) || parsed.Major != 1)
            throw new I3xProtocolException("The server does not implement the supported i3X 1.x profile.");
        if (!root.TryGetProperty("capabilities", out var capabilities) || capabilities.ValueKind != JsonValueKind.Object)
            throw new I3xProtocolException("i3X /info omitted capabilities.");
        var stream = capabilities.TryGetProperty("subscribe", out var subscribe)
            && subscribe.ValueKind == JsonValueKind.Object && subscribe.TryGetProperty("stream", out var advertised)
            && advertised.ValueKind == JsonValueKind.True;
        return new(version, OptionalString(root, "serverVersion"), stream);
    }

    public async Task<IReadOnlyList<I3xObject>> ObjectsAsync(CancellationToken cancellation)
    {
        using var typesReply = await JsonAsync(HttpMethod.Get, "objecttypes", null, cancellation);
        var typeItems = ResultArray(typesReply.Document.RootElement);
        if (typeItems.GetArrayLength() > 10000) throw new I3xProtocolException("i3X type catalog exceeds 10000 entries.");
        var types = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var type in typeItems.EnumerateArray())
        {
            var id = RequiredString(type, "elementId");
            if (!type.TryGetProperty("schema", out var schema) || schema.ValueKind != JsonValueKind.Object
                || !types.TryAdd(id, schema.Clone())) throw new I3xProtocolException("Invalid or duplicate i3X object type.");
        }
        using var objectsReply = await JsonAsync(HttpMethod.Get, "objects?includeMetadata=true", null, cancellation);
        var objects = ResultArray(objectsReply.Document.RootElement);
        if (objects.GetArrayLength() > 10000) throw new I3xProtocolException("i3X object catalog exceeds 10000 entries.");
        var result = new List<I3xObject>(objects.GetArrayLength());
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in objects.EnumerateArray())
        {
            var id = RequiredString(item, "elementId");
            if (!ids.Add(id)) throw new I3xProtocolException("Duplicate i3X object identity.");
            var type = RequiredString(item, "typeElementId");
            if (!types.TryGetValue(type, out var schema)) throw new I3xProtocolException("i3X object references an unknown object type.");
            result.Add(new(id, RequiredString(item, "displayName"), OptionalString(item, "parentId"), type,
                item.TryGetProperty("isComposition", out var composition) && composition.ValueKind == JsonValueKind.True, schema));
        }
        return result;
    }

    public async Task<IReadOnlyList<I3xVqt>> ReadAsync(IReadOnlyList<string> ids, CancellationToken cancellation)
    {
        ValidateIds(ids);
        using var reply = await JsonAsync(HttpMethod.Post, "objects/value", new { elementIds = ids, maxDepth = 1 }, cancellation);
        var items = BulkItems(reply.Document.RootElement, ids);
        return items.Select((item, index) => {
            if (!IsSuccess(item))
            {
                var status = item.TryGetProperty("responseDetail", out var detail) && detail.ValueKind == JsonValueKind.Object
                    && detail.TryGetProperty("status", out var code) && code.TryGetInt32(out var number) ? number : 0;
                return Failure(ids[index], status == 0 ? "i3X item read failed." : $"HTTP_{status}",
                    status switch { 404 => "Bad_NotFound", 401 or 403 => "Bad_UserAccessDenied", >= 500 => "Bad_CommunicationError", _ => "Bad" });
            }
            if (!item.TryGetProperty("result", out var vqt)) return Failure(ids[index], "i3X item omitted VQT.");
            return ParseVqt(vqt, ids[index]);
        }).ToArray();
    }

    public async Task<string> CreateAsync(string clientId, CancellationToken cancellation)
    {
        using var reply = await JsonAsync(HttpMethod.Post, "subscriptions", new { clientId, displayName = "SparkStudio read source" }, cancellation);
        var root = reply.Document.RootElement;
        RequireSuccess(root);
        if (!root.TryGetProperty("result", out var result)) throw new I3xProtocolException("i3X create omitted result.");
        return RequiredString(result, "subscriptionId");
    }

    public async Task RegisterAsync(string clientId, string subscriptionId, IReadOnlyList<string> ids,
        bool unregister, CancellationToken cancellation)
    {
        ValidateIds(ids);
        using var reply = await JsonAsync(HttpMethod.Post, unregister ? "subscriptions/unregister" : "subscriptions/register",
            new { clientId, subscriptionId, elementIds = ids, maxDepth = 1 }, cancellation);
        var items = BulkItems(reply.Document.RootElement, ids);
        if (items.Any(item => !IsSuccess(item))) throw new I3xProtocolException("i3X registration partially failed.");
    }

    public async Task DeleteAsync(string clientId, string subscriptionId, CancellationToken cancellation)
    {
        using var reply = await JsonAsync(HttpMethod.Post, "subscriptions/delete", new { clientId, subscriptionIds = new[] { subscriptionId } }, cancellation);
        // Remote deletion is best effort at the owner. Validate a successful reply here.
        var root = reply.Document.RootElement;
        if (!root.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array
            || results.GetArrayLength() != 1 || !IsSuccess(results[0])
            || RequiredString(results[0], "subscriptionId") != subscriptionId)
            throw new I3xProtocolException("i3X delete did not confirm the subscription identity.");
    }

    public async Task<I3xSyncResult> SyncAsync(string clientId, string subscriptionId, ulong? acknowledgment,
        CancellationToken cancellation, bool clearForRecovery = false)
    {
        using var ingress = new SourceMemoryBudget();
        ingress.SetBytes("queue", Math.Min(documentBytes, limits.QueueBytes));
        var body = new Dictionary<string, object> { ["clientId"] = clientId, ["subscriptionId"] = subscriptionId };
        if (clearForRecovery) body["lastSequenceNumber"] = -1;
        else if (acknowledgment.HasValue) body["lastSequenceNumber"] = acknowledgment.Value;
        using var reply = await JsonAsync(HttpMethod.Post, "subscriptions/sync", body, cancellation,
            maximumBytes: Math.Min(documentBytes, limits.QueueBytes));
        var items = ResultArray(reply.Document.RootElement);
        var result = new List<I3xSyncBatch>();
        ulong? previous = null;
        var updateCount = 0;
        foreach (var batch in items.EnumerateArray())
        {
            if (!batch.TryGetProperty("sequenceNumber", out var number) || !number.TryGetUInt64(out var sequence)
                || previous.HasValue && sequence <= previous.Value
                || !batch.TryGetProperty("updates", out var updates) || updates.ValueKind != JsonValueKind.Array)
                throw new I3xProtocolException("i3X sync has an invalid unsigned sequence or batch ordering.");
            previous = sequence;
            updateCount += updates.GetArrayLength();
            if (updateCount > limits.QueueCount) throw new SourceLimitException("i3X sync exceeds the admitted record ceiling.");
            result.Add(new(sequence, ParseUpdates(updates, limits.QueueCount)));
        }
        return new(result, reply.Status == HttpStatusCode.PartialContent);
    }

    public async Task StreamAsync(string clientId, string subscriptionId,
        Func<IReadOnlyList<I3xVqt>, long, CancellationToken, Task> accept, CancellationToken cancellation,
        Func<long>? ingressRevision = null)
    {
        using var ingress = new SourceMemoryBudget();
        var eventBytes = Math.Min(documentBytes, limits.QueueBytes);
        ingress.SetBytes("queue", eventBytes);
        using var request = Request(HttpMethod.Post, "subscriptions/stream", new { clientId, subscriptionId });
        request.Headers.Accept.Clear();
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        // Opening is finite, but a healthy quiet stream has no inactivity timeout.
        using var open = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        open.CancelAfter(timeoutMs);
        using var response = await SendAsync(request, open.Token);
        if (telemetry is not null) SourceHttp.ObserveResponse(response, telemetry);
        ValidateStatus(response);
        if (response.Content.Headers.ContentType?.MediaType != "text/event-stream")
            throw new I3xProtocolException("i3X stream did not return text/event-stream.");
        await using var stream = await response.Content.ReadAsStreamAsync(cancellation);
        await foreach (var payload in ReadEventsAsync(stream, eventBytes, cancellation))
        {
            var revision = ingressRevision?.Invoke() ?? 0;
            using var admission = await DecodeAdmissionAsync(cancellation);
            using var document = ParseBounded(payload, limits.DecodeNodes);
            if (document.RootElement.ValueKind != JsonValueKind.Array) throw new I3xProtocolException("i3X SSE event is not an update array.");
            await accept(ParseUpdates(document.RootElement, limits.QueueCount), revision, cancellation);
        }
        cancellation.ThrowIfCancellationRequested();
        throw new I3xProtocolException("i3X delivery stream closed.", HttpStatusCode.ServiceUnavailable);
    }

    internal static IReadOnlyList<I3xVqt> ParseUpdates(JsonElement updates, int maximumRecords = 4096)
    {
        if (updates.GetArrayLength() > maximumRecords) throw new SourceLimitException("i3X update event exceeds the admitted record ceiling.");
        return updates.EnumerateArray().Select(update => ParseVqt(update, RequiredString(update, "elementId"))).ToArray();
    }

    internal static I3xVqt ParseVqt(JsonElement vqt, string id)
    {
        try
        {
            var quality = RequiredString(vqt, "quality");
            var timestamp = RequiredString(vqt, "timestamp");
            if (quality is not ("Good" or "GoodNoData" or "Bad" or "Uncertain")
                || !TimestampPattern.IsMatch(timestamp) || !DateTimeOffset.TryParse(timestamp, CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var time)
                || !vqt.TryGetProperty("value", out var value)
                || value.ValueKind == JsonValueKind.Null && quality is "Good" or "Uncertain"
                || value.ValueKind != JsonValueKind.Null && quality == "GoodNoData")
                return Failure(id, "Invalid i3X VQT quality, timestamp or null contract.");
            return new(id, value.Clone(), quality, time);
        }
        catch (I3xProtocolException) { return Failure(id, "Invalid i3X VQT metadata."); }
    }

    private static I3xVqt Failure(string id, string message, string quality = "Bad_DecodingError") => new(id, default, quality, default, message);
    internal static JsonElement Select(JsonElement root, string? pointer)
    {
        if (string.IsNullOrEmpty(pointer)) return root;
        if (pointer[0] != '/' || pointer.Length > 512) throw new ArgumentException("i3X selectors are bounded RFC 6901 JSON pointers.");
        var segments = pointer[1..].Split('/');
        foreach (var raw in segments)
        {
            for (var index = 0; index < raw.Length; index++)
                if (raw[index] == '~' && (index + 1 >= raw.Length || raw[++index] is not ('0' or '1')))
                    throw new ArgumentException("Invalid JSON-pointer escape.");
        }
        foreach (var raw in segments)
        {
            var segment = raw.Replace("~1", "/", StringComparison.Ordinal).Replace("~0", "~", StringComparison.Ordinal);
            if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty(segment, out var child)) root = child;
            else if (root.ValueKind == JsonValueKind.Array && (segment == "0" || segment.Length > 0 && segment[0] != '0')
                && int.TryParse(segment, NumberStyles.None, CultureInfo.InvariantCulture, out var arrayIndex)
                && arrayIndex >= 0 && arrayIndex < root.GetArrayLength()) root = root[arrayIndex];
            else return default;
        }
        return root;
    }

    internal static object ConvertValue(JsonElement value, string type)
    {
        if (Encoding.UTF8.GetByteCount(value.GetRawText()) > 64 * 1024) throw new ArgumentException("i3X scalar exceeds 64 KiB.");
        try
        {
            return type switch {
                "Boolean" when value.ValueKind is JsonValueKind.True or JsonValueKind.False => value.GetBoolean(),
                "Int16" when value.ValueKind == JsonValueKind.Number => checked((short)Integer(value)),
                "UInt16" when value.ValueKind == JsonValueKind.Number => checked((ushort)Integer(value)),
                "Int32" when value.ValueKind == JsonValueKind.Number => checked((int)Integer(value)),
                "UInt32" when value.ValueKind == JsonValueKind.Number => checked((uint)Integer(value)),
                "Int64" when value.ValueKind == JsonValueKind.Number => checked((long)Integer(value)),
                "Float" when value.ValueKind == JsonValueKind.Number && float.IsFinite(value.GetSingle()) => value.GetSingle(),
                "Double" when value.ValueKind == JsonValueKind.Number && double.IsFinite(value.GetDouble()) => value.GetDouble(),
                "String" when value.ValueKind == JsonValueKind.String => value.GetString()!,
                "String" when value.ValueKind is JsonValueKind.Array or JsonValueKind.Object => value.GetRawText(),
                _ => throw new ArgumentException("i3X value does not match the saved point type."),
            };
        }
        catch (Exception error) when (error is FormatException or OverflowException or InvalidOperationException)
        { throw new ArgumentException("i3X value does not match the saved point type.", error); }
    }
    private static decimal Integer(JsonElement value)
    {
        if (!value.TryGetDecimal(out var number) || decimal.Truncate(number) != number)
            throw new ArgumentException("Expected an exact integral i3X value.");
        return number;
    }

    private async Task<JsonReply> JsonAsync(HttpMethod method, string path, object? body, CancellationToken cancellation,
        int? maximumBytes = null)
    {
        var maximum = maximumBytes ?? documentBytes;
        using var operation = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        operation.CancelAfter(timeoutMs);
        using var request = Request(method, path, body);
        using var response = await SendAsync(request, operation.Token);
        if (telemetry is not null) SourceHttp.ObserveResponse(response, telemetry);
        ValidateStatus(response);
        if (response.Content.Headers.ContentLength > maximum)
            throw new I3xProtocolException("i3X document exceeds the configured byte ceiling.");
        await using var stream = await response.Content.ReadAsStreamAsync(operation.Token);
        var admission = await DecodeAdmissionAsync(operation.Token);
        using var output = new MemoryStream(Math.Min(maximum, 64 * 1024));
        var buffer = ArrayPool<byte>.Shared.Rent(8192);
        try
        {
            int count;
            while ((count = await stream.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, maximum - (int)output.Length + 1)), operation.Token)) != 0)
            {
                if (output.Length + count > maximum) throw new SourceLimitException("i3X decoded document exceeds the configured byte ceiling.");
                output.Write(buffer, 0, count);
            }
            return new(ParseBounded(output.ToArray(), limits.DecodeNodes), response.StatusCode, admission);
        }
        catch { admission.Dispose(); throw; }
        finally { ArrayPool<byte>.Shared.Return(buffer); }
    }

    private HttpRequestMessage Request(HttpMethod method, string path, object? body)
    {
        var request = new HttpRequestMessage(method, new Uri(endpoint, path));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.UserAgent.ParseAdd("SparkStudio/1.0");
        if (body is not null)
            request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        return request;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
    {
        try { return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation); }
        catch (HttpRequestException error)
        {
            var message = error.HttpRequestError switch {
                HttpRequestError.NameResolutionError => "i3X server hostname could not be resolved. Check the endpoint and gateway DNS settings.",
                HttpRequestError.ConnectionError => "i3X server could not be reached. Check the endpoint, port and gateway network or proxy settings.",
                HttpRequestError.SecureConnectionError => "i3X TLS connection failed. Check the server certificate, hostname and configured gateway certificate references.",
                HttpRequestError.ResponseEnded => "i3X server or proxy closed the connection before sending a complete HTTP response. Check the endpoint and gateway network or proxy settings.",
                HttpRequestError.ProxyTunnelError => "i3X proxy tunnel could not be established. Check the gateway proxy settings.",
                _ => "i3X HTTP request failed. Check the endpoint and gateway network or proxy settings."
            };
            // Preserve the transport category so acquisition can retry an outage.
            // The original exception may include request or proxy details; keep it private.
            throw new HttpRequestException(error.HttpRequestError, message, statusCode: error.StatusCode);
        }
    }

    private static void ValidateStatus(HttpResponseMessage response)
    {
        if (!response.IsSuccessStatusCode)
            throw new I3xProtocolException($"i3X request failed with HTTP {(int)response.StatusCode}.", response.StatusCode);
    }

    private async Task<IDisposable> DecodeAdmissionAsync(CancellationToken cancellation)
    {
        // Conservative reservation includes UTF-8 input/copies, token/string materialization and clone fan-out.
        var bytes = checked((long)documentBytes * 8);
        await decodeSlots.WaitAsync(cancellation);
        try
        {
            lock (admissionGate)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                if (admittedDecodeBytes + bytes > limits.DecodeBytes)
                    throw new SourceLimitException("i3X temporary decode admission profile exhausted.");
                workingMemory.SetBytes("decode", admittedDecodeBytes + bytes);
                admittedDecodeBytes += bytes;
                return new DecodeLease(this, bytes);
            }
        }
        catch { decodeSlots.Release(); throw; }
    }
    private void ReleaseDecode(long bytes)
    {
        lock (admissionGate) { admittedDecodeBytes -= bytes; if (!disposed) workingMemory.SetBytes("decode", admittedDecodeBytes); }
        decodeSlots.Release();
    }

    internal static JsonDocument ParseBounded(ReadOnlyMemory<byte> bytes, int maximumNodes = 65536)
    {
        try
        {
            var reader = new Utf8JsonReader(bytes.Span, new JsonReaderOptions { MaxDepth = 64 });
            var count = 0;
            while (reader.Read())
                if (++count > maximumNodes) throw new SourceLimitException("i3X document exceeds its decoded-node ceiling.");
            return JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 64 });
        }
        catch (JsonException) { throw new I3xProtocolException("Malformed or excessive-depth i3X JSON."); }
    }

    internal static async IAsyncEnumerable<byte[]> ReadEventsAsync(Stream stream, int maximumBytes,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellation)
    {
        // Byte parser bounds comments, line length and whole event before UTF-8 materialization.
        var buffer = ArrayPool<byte>.Shared.Rent(8192);
        using var line = new MemoryStream();
        using var data = new MemoryStream();
        var eventBytes = 0;
        try
        {
            int count;
            while ((count = await stream.ReadAsync(buffer.AsMemory(), cancellation)) != 0)
            {
                for (var index = 0; index < count; index++)
                {
                    var current = buffer[index];
                    if (++eventBytes > maximumBytes) throw new I3xProtocolException("i3X SSE event exceeds the configured byte ceiling.");
                    if (current != '\n') { line.WriteByte(current); continue; }
                    var text = Encoding.UTF8.GetString(line.GetBuffer(), 0, (int)line.Length).TrimEnd('\r');
                    line.SetLength(0);
                    if (text.Length == 0)
                    {
                        if (data.Length > 0) { var payload = data.ToArray(); data.SetLength(0); yield return payload; }
                        eventBytes = 0;
                    }
                    else if (text.StartsWith("data:", StringComparison.Ordinal))
                    {
                        var content = text[5..];
                        if (content.StartsWith(' ')) content = content[1..];
                        if (data.Length > 0) data.WriteByte((byte)'\n');
                        var bytes = Encoding.UTF8.GetBytes(content);
                        if (data.Length + bytes.Length > maximumBytes) throw new I3xProtocolException("i3X SSE payload exceeds the configured byte ceiling.");
                        data.Write(bytes);
                    }
                }
            }
            if (line.Length > 0 || data.Length > 0) throw new I3xProtocolException("i3X stream ended during an incomplete SSE event.", HttpStatusCode.ServiceUnavailable);
        }
        finally { ArrayPool<byte>.Shared.Return(buffer); }
    }

    private static string RequiredString(JsonElement root, string property)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty(property, out var field)
            || field.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(field.GetString())
            || field.GetString()!.Length > 2048 || field.GetString()!.Any(char.IsControl))
            throw new I3xProtocolException("i3X response omitted a bounded required string.");
        return field.GetString()!;
    }
    private static string? OptionalString(JsonElement root, string property)
    {
        if (!root.TryGetProperty(property, out var field) || field.ValueKind == JsonValueKind.Null) return null;
        if (field.ValueKind != JsonValueKind.String || field.GetString()!.Length > 2048 || field.GetString()!.Any(char.IsControl))
            throw new I3xProtocolException("Invalid i3X optional metadata string.");
        return field.GetString();
    }
    private static bool IsSuccess(JsonElement root) => root.TryGetProperty("success", out var field) && field.ValueKind == JsonValueKind.True;
    private static void RequireSuccess(JsonElement root)
    { if (!IsSuccess(root)) throw new I3xProtocolException("i3X operation was unsuccessful."); }
    private static JsonElement ResultArray(JsonElement root)
    {
        RequireSuccess(root);
        if (!root.TryGetProperty("result", out var array) || array.ValueKind != JsonValueKind.Array)
            throw new I3xProtocolException("i3X operation omitted its result array.");
        return array;
    }
    private static JsonElement[] BulkItems(JsonElement root, IReadOnlyList<string> ids)
    {
        if (!root.TryGetProperty("results", out var array) || array.ValueKind != JsonValueKind.Array || array.GetArrayLength() != ids.Count)
            throw new I3xProtocolException("i3X bulk response size differs from its request.");
        var result = array.EnumerateArray().ToArray();
        if (!root.TryGetProperty("success", out var success) || success.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
            || success.GetBoolean() != result.All(IsSuccess))
            throw new I3xProtocolException("i3X bulk response has inconsistent success metadata.");
        for (var index = 0; index < result.Length; index++)
            if (RequiredString(result[index], "elementId") != ids[index])
                throw new I3xProtocolException("i3X bulk response identity/order differs from its request.");
        return result;
    }
    private static void ValidateIds(IReadOnlyList<string> ids)
    {
        if (ids.Count is < 1 or > 250 || ids.Distinct(StringComparer.Ordinal).Count() != ids.Count
            || ids.Any(id => string.IsNullOrEmpty(id) || id.Length > 2048 || id != id.Trim() || id.Any(char.IsControl)))
            throw new ArgumentException("i3X batches need 1–250 unique, bounded opaque element ids.");
    }
    private sealed record JsonReply(JsonDocument Document, HttpStatusCode Status, IDisposable Admission) : IDisposable
    { public void Dispose() { Document.Dispose(); Admission.Dispose(); } }
    private sealed class DecodeLease(SourceI3xClient owner, long bytes) : IDisposable
    {
        private int disposed;
        public void Dispose() { if (Interlocked.Exchange(ref disposed, 1) == 0) owner.ReleaseDecode(bytes); }
    }
    public void Dispose()
    {
        lock (admissionGate) { if (disposed) return; disposed = true; workingMemory.Dispose(); }
        if (ownsClient) client.Dispose();
    }
}
