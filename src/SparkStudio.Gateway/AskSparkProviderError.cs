using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

public sealed record AskSparkProviderError(string Provider, int HttpStatus,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Status,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Message, bool Retryable);

/// <summary>A bounded, redacted provider diagnostic; the gateway still returns HTTP 502.</summary>
public sealed partial class AskSparkProviderException : Exception
{
    private const int MaximumBodyBytes = 65_536;
    private const int MaximumMessageCharacters = 2048;
    private static readonly string[] CacheRejectionWords = ["expired", "not found", "invalid", "deleted", "unsupported"];
    public AskSparkProviderError Error { get; }
    internal bool RejectsCachedContent { get; }

    private AskSparkProviderException(HttpStatusCode status, string? providerStatus, string? message, bool rejectsCache)
        : base(Summary(status))
    {
        Error = new("Gemini", (int)status, providerStatus, message, status is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests || (int)status is >= 500 and <= 599);
        RejectsCachedContent = rejectsCache;
    }

    internal static async Task<AskSparkProviderException> ReadAsync(HttpResponseMessage response, string key, CancellationToken cancellation)
    {
        // A known rejection remains authoritative even when its diagnostic body is unreadable.
        // Read once so cache classification and UI diagnostics also work without raw logging.
        using var document = await ReadBodyAsync(response, cancellation);
        var details = document?.RootElement;
        if (details is { ValueKind: JsonValueKind.Object } root && root.TryGetProperty("error", out var error)) details = error;
        else details = null;
        var rawMessage = StringProperty(details, "message");
        var status = Redact(StringProperty(details, "status"), key);
        if (status is not { Length: > 0 and <= 64 } || !status.All(character => character is >= 'A' and <= 'Z' or >= '0' and <= '9' or '_')) status = null;
        var rejectsCache = response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone
            || response.StatusCode == HttpStatusCode.BadRequest && rawMessage is not null
                && rawMessage.Contains("cached", StringComparison.OrdinalIgnoreCase)
                && CacheRejectionWords.Any(word => rawMessage.Contains(word, StringComparison.OrdinalIgnoreCase));
        return new(response.StatusCode, status, Redact(rawMessage, key), rejectsCache);
    }

    private static async Task<JsonDocument?> ReadBodyAsync(HttpResponseMessage response, CancellationToken cancellation)
    {
        if (response.Content.Headers.ContentLength > MaximumBodyBytes) return null;
        try
        {
            await using var stream = await response.Content.ReadAsStreamAsync(cancellation);
            using var memory = new MemoryStream();
            var buffer = new byte[4096];
            int count;
            while ((count = await stream.ReadAsync(buffer, cancellation)) > 0)
            {
                if (memory.Length + count > MaximumBodyBytes) return null;
                await memory.WriteAsync(buffer.AsMemory(0, count), cancellation);
            }
            return JsonDocument.Parse(memory.ToArray(), new JsonDocumentOptions { MaxDepth = 16 });
        }
        catch (Exception failure) when (failure is JsonException or IOException or HttpRequestException or OperationCanceledException)
        { return null; }
    }

    private static string? StringProperty(JsonElement? details, string name)
        => details is { ValueKind: JsonValueKind.Object } value && value.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String
            ? property.GetString() : null;

    private static string? Redact(string? value, string key)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        // Sanitize before truncation so an echoed key cannot leak as a partial prefix at the boundary.
        if (key.Length > 0)
            value = value.Replace(key, "[credential omitted]", StringComparison.Ordinal)
                .Replace(Uri.EscapeDataString(key), "[credential omitted]", StringComparison.OrdinalIgnoreCase);
        try
        {
            value = CredentialAssignment().Replace(value, "[credential omitted]");
            value = AuthorizationValue().Replace(value, "[credential omitted]");
            value = GoogleApiKey().Replace(value, "[credential omitted]");
            value = UriCredentials().Replace(value, "[credential omitted]@");
        }
        catch (RegexMatchTimeoutException) { return "Provider detail omitted because it could not be safely redacted."; }
        value = new string(value.Select(character => char.IsControl(character) && character is not '\n' and not '\t' ? ' ' : character).ToArray()).Trim();
        return value.Length <= MaximumMessageCharacters ? value : value[..(MaximumMessageCharacters - 1)] + "…";
    }

    private static string Summary(HttpStatusCode status) => status switch
    {
        HttpStatusCode.ServiceUnavailable => "Gemini is temporarily unavailable (503), often because the model is in high demand. Try again shortly.",
        HttpStatusCode.TooManyRequests => "Gemini's quota or rate limit was reached (429). Wait before trying again, or review the provider account's quota and billing.",
        HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => $"Gemini rejected the API key or model access ({(int)status}). Check Gateway Settings → AI and the key's permissions.",
        HttpStatusCode.BadRequest => "Gemini rejected the request (400). Review the provider details for invalid inputs or unsupported model/tool settings.",
        HttpStatusCode.NotFound => "The configured Gemini model or resource was not found (404). Check the model in Gateway Settings → AI.",
        HttpStatusCode.RequestTimeout or HttpStatusCode.GatewayTimeout => $"Gemini timed out ({(int)status}). Try again shortly.",
        _ when (int)status is >= 500 and <= 599 => $"Gemini returned a temporary server error ({(int)status}). Try again shortly.",
        _ => $"Gemini rejected the request ({(int)status}). Review the provider details and Gateway Settings → AI."
    };

    [GeneratedRegex("""\b(?:api[ _-]?key|x-goog-api-key|authorization|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|password|passwd|secret)\b["']?\s*(?::|=|\bis\b)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:Bearer|Basic)\s+[^\s,;]+|[^\s,;]+)""", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking, 100)]
    private static partial Regex CredentialAssignment();
    [GeneratedRegex(@"\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=\-]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking, 100)]
    private static partial Regex AuthorizationValue();
    [GeneratedRegex(@"\bAIza[0-9A-Za-z_-]{20,}\b", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking, 100)]
    private static partial Regex GoogleApiKey();
    [GeneratedRegex(@"\b[a-z][a-z0-9+.\-]*://[^/\s:@]+:[^/\s@]+@", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking, 100)]
    private static partial Regex UriCredentials();
}
