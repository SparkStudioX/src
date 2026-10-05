using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>
/// Uploads large user-attached images to the provider's Files API once and refers to them by URI afterwards,
/// so a pasted reference image is not re-sent in full on every model round. Any upload problem keeps the inline bytes.
/// </summary>
public sealed class AskSparkFiles(HttpClient client, AskSparkRawLog? rawLog = null, Func<DateTimeOffset>? clock = null)
{
    /// <summary>Base64 characters (about 72 KB of image) below which an upload costs more than it saves.</summary>
    public const int MinimumInlineCharacters = 96_000;
    private const string Origin = "https://generativelanguage.googleapis.com/";
    private const int MaximumEntries = 256;
    private static readonly TimeSpan Reuse = TimeSpan.FromHours(40);
    private readonly ConcurrentDictionary<string, Entry> entries = new(StringComparer.Ordinal);
    private readonly Func<DateTimeOffset> now = clock ?? (() => DateTimeOffset.UtcNow);
    private sealed record Entry(string Uri, string MimeType, DateTimeOffset Expires);

    /// <summary>Return a copy of the request whose large top-level user images are file references, or the same body when nothing changed.</summary>
    public async Task<JsonObject> ReferenceImagesAsync(JsonObject body, string key, CancellationToken cancellation)
    {
        if (body["contents"] is not JsonArray contents) return body;
        var candidates = Candidates(contents).ToArray();
        if (candidates.Length == 0) return body;
        var replacements = new Dictionary<string, Entry>(StringComparer.Ordinal);
        foreach (var (data, mimeType) in candidates.Select(item => (item.Data, item.MimeType)).Distinct())
        {
            var entry = await UploadAsync(data, mimeType, key, cancellation);
            if (entry is not null) replacements[data] = entry;
        }
        if (replacements.Count == 0) return body;
        var copy = body.DeepClone().AsObject();
        foreach (var part in Candidates(copy["contents"]!.AsArray()).Where(item => replacements.ContainsKey(item.Data)).Select(item => item.Part).ToArray())
        {
            var entry = replacements[part["inlineData"]!["data"]!.GetValue<string>()];
            part.Remove("inlineData");
            part["fileData"] = new JsonObject { ["mimeType"] = entry.MimeType, ["fileUri"] = entry.Uri };
        }
        return copy;
    }

    /// <summary>Drop remembered uploads for this key, for example after the provider rejected a file reference.</summary>
    public void Forget(string key)
    {
        var prefix = KeyHash(key) + ":";
        foreach (var name in entries.Keys.Where(name => name.StartsWith(prefix, StringComparison.Ordinal))) entries.TryRemove(name, out _);
    }

    private static IEnumerable<(JsonObject Part, string Data, string MimeType)> Candidates(JsonArray contents)
    {
        foreach (var content in contents.OfType<JsonObject>())
        {
            if (content["role"]?.GetValue<string>() != "user" || content["parts"] is not JsonArray parts) continue;
            foreach (var part in parts.OfType<JsonObject>())
            {
                if (part["inlineData"] is not JsonObject inline || inline["data"] is not JsonValue data || !data.TryGetValue<string>(out var text)
                    || inline["mimeType"] is not JsonValue type || !type.TryGetValue<string>(out var mimeType)
                    || !mimeType.StartsWith("image/", StringComparison.Ordinal) || text.Length < MinimumInlineCharacters) continue;
                yield return (part, text, mimeType);
            }
        }
    }

    private async Task<Entry?> UploadAsync(string data, string mimeType, string key, CancellationToken cancellation)
    {
        byte[] bytes;
        try { bytes = Convert.FromBase64String(data); }
        catch (FormatException) { return null; }
        var name = KeyHash(key) + ":" + Convert.ToHexStringLower(SHA256.HashData(bytes));
        if (entries.TryGetValue(name, out var known) && known.Expires - now() > TimeSpan.FromHours(2)) return known;
        try
        {
            var entry = await StartAndUploadAsync(bytes, mimeType, name, key, cancellation);
            if (entry is null) return null;
            if (entries.Count >= MaximumEntries)
                foreach (var stale in entries.OrderBy(pair => pair.Value.Expires).Take(entries.Count - MaximumEntries + 1)) entries.TryRemove(stale.Key, out _);
            entries[name] = entry;
            return entry;
        }
        catch (Exception error) when (error is HttpRequestException or InvalidDataException or System.Text.Json.JsonException or AskSparkProviderException
            || error is OperationCanceledException && !cancellation.IsCancellationRequested)
        {
            return null; // The image stays inline; the conversation continues exactly as before.
        }
    }

    private async Task<Entry?> StartAndUploadAsync(byte[] bytes, string mimeType, string name, string key, CancellationToken cancellation)
    {
        using var start = new HttpRequestMessage(HttpMethod.Post, Origin + "upload/v1beta/files");
        start.Headers.Add("x-goog-api-key", key);
        start.Headers.Add("X-Goog-Upload-Protocol", "resumable");
        start.Headers.Add("X-Goog-Upload-Command", "start");
        start.Headers.Add("X-Goog-Upload-Header-Content-Length", bytes.Length.ToString(System.Globalization.CultureInfo.InvariantCulture));
        start.Headers.Add("X-Goog-Upload-Header-Content-Type", mimeType);
        start.Content = new StringContent(new JsonObject { ["file"] = new JsonObject { ["display_name"] = "ask-spark-" + name[^16..] } }.ToJsonString(), Encoding.UTF8, "application/json");
        using var started = await AskSparkProviderExchange.SendAsync(client, start, "files.start", rawLog, 65_536, cancellation);
        if (!started.IsSuccessStatusCode) throw await AskSparkProviderException.ReadAsync(started, key, cancellation);
        // The upload session URL comes from the provider; only its fixed HTTPS origin may receive the image bytes and key.
        if (!started.Headers.TryGetValues("X-Goog-Upload-URL", out var values) || values.FirstOrDefault() is not { } location
            || !Uri.TryCreate(location, UriKind.Absolute, out var target) || !target.AbsoluteUri.StartsWith(Origin, StringComparison.Ordinal)) return null;
        using var upload = new HttpRequestMessage(HttpMethod.Post, target);
        upload.Headers.Add("x-goog-api-key", key);
        upload.Headers.Add("X-Goog-Upload-Offset", "0");
        upload.Headers.Add("X-Goog-Upload-Command", "upload, finalize");
        upload.Content = new ByteArrayContent(bytes);
        upload.Content.Headers.ContentType = new MediaTypeHeaderValue(mimeType);
        var exchange = Guid.NewGuid().ToString("N");
        if (rawLog is not null) await rawLog.WriteAsync("files.upload POST " + target.AbsolutePath, exchange, "request", $"[{bytes.Length} image bytes, {mimeType}, sha256 {name[(name.IndexOf(':') + 1)..]}]", cancellation: CancellationToken.None);
        using var response = await client.SendAsync(upload, cancellation);
        var text = await response.Content.ReadAsStringAsync(cancellation);
        if (text.Length > 65_536) throw new InvalidDataException("The file upload response exceeded its size limit.");
        if (rawLog is not null) await rawLog.WriteAsync("files.upload POST " + target.AbsolutePath, exchange, "response", text, (int)response.StatusCode, CancellationToken.None);
        if (!response.IsSuccessStatusCode) return null;
        var file = (JsonNode.Parse(text) as JsonObject)?["file"] as JsonObject;
        var uri = file?["uri"]?.GetValue<string>();
        var state = file?["state"]?.GetValue<string>();
        if (uri is null || !uri.StartsWith(Origin, StringComparison.Ordinal) || state is not (null or "ACTIVE")) return null;
        var expires = DateTimeOffset.TryParse(file?["expirationTime"]?.GetValue<string>(), out var parsed) ? parsed : now() + Reuse;
        return new Entry(uri, file?["mimeType"]?.GetValue<string>() ?? mimeType, expires < now() + Reuse ? expires : now() + Reuse);
    }

    private static string KeyHash(string key) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..16];
}
