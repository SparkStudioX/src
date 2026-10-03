using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Provider cache for immutable instructions and authorized schemas, never conversation contents.</summary>
public sealed class AskSparkCache(HttpClient client, TimeProvider? timeProvider = null, AskSparkRawLog? rawLog = null) : IDisposable
{
    private sealed record Entry(string? Name, string Credential, DateTimeOffset ExpiresAt, DateTimeOffset LastUsed, bool Usable);
    private const string Origin = "https://generativelanguage.googleapis.com/v1beta/";
    private const int MaximumCaches = 8;
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);
    private readonly Dictionary<string, DateTimeOffset> rejected = new(StringComparer.Ordinal);

    public async Task<string?> GetAsync(JsonObject request, string model, string key, string revision, string scope, CancellationToken cancellation)
    {
        var prefix = Prefix(request);
        if (prefix["tools"] is null || string.IsNullOrWhiteSpace(scope)) return null;
        var credential = Hash(key);
        var identity = Hash(new JsonArray(model, revision, scope, credential, Canonical(prefix)).ToJsonString());
        if (!await gate.WaitAsync(0, cancellation)) return null;
        try { return await GetLockedAsync(prefix, model, key, credential, identity, cancellation); }
        finally { gate.Release(); }
    }

    public async Task InvalidateAsync(string name, CancellationToken cancellation)
    {
        await gate.WaitAsync(cancellation);
        try
        {
            foreach (var item in entries.Where(item => item.Value.Name == name).ToArray())
                entries[item.Key] = item.Value with { Usable = false };
        }
        finally { gate.Release(); }
    }

    public static JsonObject Prefix(JsonObject request)
    {
        var prefix = new JsonObject();
        foreach (var name in new[] { "systemInstruction", "tools", "toolConfig" })
            if (request[name] is { } value) prefix[name] = value.DeepClone();
        return prefix;
    }

    public static JsonObject Reference(JsonObject request, string name)
    {
        var body = request.DeepClone().AsObject();
        body.Remove("systemInstruction"); body.Remove("tools"); body.Remove("toolConfig");
        body["cachedContent"] = name;
        return body;
    }

    private async Task<string?> GetLockedAsync(JsonObject prefix, string model, string key, string credential, string identity, CancellationToken cancellation)
    {
        var now = clock.GetUtcNow();
        Expire(now);
        if (entries.TryGetValue(identity, out var existing))
        {
            entries[identity] = existing with { LastUsed = now };
            return existing.Usable && existing.ExpiresAt > now.AddSeconds(15) ? existing.Name : null;
        }
        if (rejected.ContainsKey(identity)) return null;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(TimeSpan.FromSeconds(15));
        try
        {
            if (!await MakeRoomAsync(key, credential, deadline.Token)) return null;
            return await CreateAsync(prefix, model, key, credential, identity, now, deadline.Token);
        }
        catch (Exception error) when (error is HttpRequestException or OperationCanceledException or JsonException or InvalidDataException or InvalidOperationException)
        {
            // A lost creation response may still represent a live provider cache. Reserve its slot until TTL.
            if (entries.Count < MaximumCaches) entries.TryAdd(identity, new(null, credential, now.AddHours(1), now, false));
            cancellation.ThrowIfCancellationRequested();
            return null;
        }
    }

    private async Task<string?> CreateAsync(JsonObject prefix, string model, string key, string credential, string identity, DateTimeOffset now, CancellationToken cancellation)
    {
        prefix["model"] = "models/" + model;
        prefix["ttl"] = "3600s";
        prefix["displayName"] = "SparkStudio " + identity[..16];
        using var request = Request(HttpMethod.Post, "cachedContents", key);
        request.Content = new StringContent(prefix.ToJsonString(), Encoding.UTF8, "application/json");
        using var response = await AskSparkProviderExchange.SendAsync(client, request, "cache.create", rawLog, 65_536, cancellation);
        if (!response.IsSuccessStatusCode)
        {
            // Includes below-minimum prefixes and models/accounts without explicit cache support.
            if ((int)response.StatusCode >= 500) entries[identity] = new(null, credential, now.AddHours(1), now, false);
            else rejected[identity] = now.AddMinutes(5);
            return null;
        }
        var result = await ReadAsync(response, cancellation);
        var name = result["name"]?.GetValue<string>();
        var expires = Expiration(result, now);
        if (!ValidName(name)) throw new InvalidDataException("Invalid provider cache identity.");
        entries[identity] = new(name, credential, expires, now, true);
        return expires > now.AddSeconds(15) ? name : null;
    }

    private async Task<bool> MakeRoomAsync(string key, string credential, CancellationToken cancellation)
    {
        if (entries.Count < MaximumCaches) return true;
        var candidate = entries.Where(item => item.Value.Credential == credential && item.Value.Name is not null)
            .OrderBy(item => item.Value.LastUsed).FirstOrDefault();
        if (candidate.Key is null) return false;
        using var request = Request(HttpMethod.Delete, candidate.Value.Name!, key);
        using var response = await AskSparkProviderExchange.SendAsync(client, request, "cache.delete", rawLog, 65_536, cancellation);
        if (!response.IsSuccessStatusCode && response.StatusCode is not (HttpStatusCode.NotFound or HttpStatusCode.Gone)) return false;
        entries.Remove(candidate.Key);
        return true;
    }

    private void Expire(DateTimeOffset now)
    {
        foreach (var item in entries.Where(item => item.Value.ExpiresAt <= now).ToArray()) entries.Remove(item.Key);
        foreach (var item in rejected.Where(item => item.Value <= now).ToArray()) rejected.Remove(item.Key);
        while (rejected.Count >= 32) rejected.Remove(rejected.MinBy(item => item.Value).Key);
    }

    private static HttpRequestMessage Request(HttpMethod method, string path, string key)
    {
        var request = new HttpRequestMessage(method, Origin + path);
        request.Headers.Add("x-goog-api-key", key);
        return request;
    }

    private static DateTimeOffset Expiration(JsonObject result, DateTimeOffset now)
    {
        if (!DateTimeOffset.TryParse(result["expireTime"]?.GetValue<string>(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var expires))
            throw new InvalidDataException("Invalid provider cache expiration.");
        return expires < now.AddHours(1) ? expires : now.AddHours(1);
    }

    private static bool ValidName(string? name) => name is { Length: > 15 and <= 160 }
        && name.StartsWith("cachedContents/", StringComparison.Ordinal)
        && name[15..].All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_');

    private static async Task<JsonObject> ReadAsync(HttpResponseMessage response, CancellationToken cancellation)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(cancellation);
        using var data = new MemoryStream();
        var buffer = new byte[4096];
        int count;
        while ((count = await stream.ReadAsync(buffer, cancellation)) > 0)
        {
            if (data.Length + count > 65_536) throw new InvalidDataException("Provider cache response exceeded its limit.");
            await data.WriteAsync(buffer.AsMemory(0, count), cancellation);
        }
        return JsonNode.Parse(data.ToArray()) as JsonObject ?? throw new InvalidDataException("Invalid provider cache response.");
    }

    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    private static JsonNode? Canonical(JsonNode? value) => value switch
    {
        JsonObject obj => new JsonObject(obj.OrderBy(item => item.Key, StringComparer.Ordinal).Select(item => new KeyValuePair<string, JsonNode?>(item.Key, Canonical(item.Value)))),
        JsonArray array => new JsonArray(array.Select(Canonical).ToArray()),
        _ => value?.DeepClone()
    };

    public void Dispose() { gate.Dispose(); GC.SuppressFinalize(this); }
}
