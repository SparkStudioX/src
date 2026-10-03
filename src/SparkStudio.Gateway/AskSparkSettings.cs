using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;

namespace SparkStudio.Gateway;

/// <summary>Saved gateway provider configuration. API keys never enter a settings response.</summary>
public sealed class AskSparkSettings
{
    public const string DefaultModel = "gemini-3.8-flash";
    private sealed record Document(string Revision, bool Enabled, string Model, int ParallelLimit, string? ProtectedApiKey, long MonthlyTokenLimit = 0, int ModelStepLimit = 100);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly Regex ModelName = new(@"\Agemini-[a-zA-Z0-9][a-zA-Z0-9._-]{0,90}\z", RegexOptions.CultureInvariant);
    private readonly string path;
    private readonly IDataProtector protector;
    private Document document;

    public AskSparkSettings(string directory, IDataProtectionProvider protection)
    {
        path = Path.Combine(directory, "ask-spark-settings.json");
        protector = protection.CreateProtector("SparkStudio.AskSpark.ApiKey.v1");
        document = new("0", false, DefaultModel, 4, null);
        if (!File.Exists(path)) return;
        RecoveryFileSystem.RejectLinks(path);
        if (new FileInfo(path).Length > 32_768) throw new InvalidDataException("Ask Spark settings exceed the allowed size.");
        document = JsonSerializer.Deserialize<Document>(File.ReadAllText(path), Json) ?? throw new InvalidDataException("Ask Spark settings are invalid.");
        Validate(document.Model, document.ParallelLimit, document.MonthlyTokenLimit, document.ModelStepLimit);
    }

    public AskSparkSettingsSnapshot Snapshot()
    {
        lock (GatewayConfigurationLock.SyncRoot)
            return new(document.Revision, document.Enabled, document.Model, document.ProtectedApiKey is not null, document.ParallelLimit, document.MonthlyTokenLimit, document.ModelStepLimit);
    }

    public AskSparkSettingsSnapshot Save(AskSparkSettingsRequest request)
    {
        Validate(request.Model, request.ParallelLimit, request.MonthlyTokenLimit, request.ModelStepLimit);
        var key = NormalizeKey(request);
        lock (GatewayConfigurationLock.SyncRoot)
        {
            if (request.Revision != document.Revision) throw new BadHttpRequestException("AI settings changed. Reload before saving.", 409);
            var secret = request.ClearApiKey ? null : document.ProtectedApiKey;
            if (!string.IsNullOrEmpty(key)) secret = protector.Protect(key);
            if (request.Enabled && secret is null) throw new ArgumentException("Configure an API key before enabling Ask Spark.");
            var next = new Document(Guid.NewGuid().ToString("N"), request.Enabled, request.Model, request.ParallelLimit, secret, request.MonthlyTokenLimit, request.ModelStepLimit);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            DurableJsonFile.Write(path, JsonSerializer.SerializeToNode(next, Json)!);
            document = next;
            return Snapshot();
        }
    }

    public (string Model, string Key) Credentials(bool requireEnabled = true)
    {
        lock (GatewayConfigurationLock.SyncRoot)
        {
            if (requireEnabled && !document.Enabled) throw new BadHttpRequestException("Ask Spark is disabled in Gateway Settings → AI.", 409);
            if (document.ProtectedApiKey is null) throw new BadHttpRequestException("Configure an API key in Gateway Settings → AI.", 409);
            try { return (document.Model, protector.Unprotect(document.ProtectedApiKey)); }
            catch (CryptographicException) { throw new BadHttpRequestException("The saved AI key cannot be decrypted. An administrator must replace it.", 409); }
        }
    }

    private static void Validate(string model, int parallelLimit, long monthlyTokenLimit, int modelStepLimit)
    {
        if (string.IsNullOrWhiteSpace(model) || !ModelName.IsMatch(model)) throw new ArgumentException("Choose a valid Gemini model identifier.");
        if (parallelLimit is < 1 or > 8) throw new ArgumentException("Parallel tool reads must be between 1 and 8.");
        if (monthlyTokenLimit is < 0 or > 1_000_000_000_000) throw new ArgumentException("Monthly AI tokens must be between 0 (unlimited) and 1,000,000,000,000.");
        if (modelStepLimit is < 1 or > 1000) throw new ArgumentException("Model steps per message must be between 1 and 1000.");
    }

    private static string? NormalizeKey(AskSparkSettingsRequest request)
    {
        if (request.ClearApiKey && !string.IsNullOrEmpty(request.ApiKey)) throw new ArgumentException("Replace or clear the API key, not both.");
        if (string.IsNullOrEmpty(request.ApiKey)) return request.ApiKey;
        var key = request.ApiKey.Trim();
        if (key.Length is 0 or > 512 || key.Any(character => character is < '!' or > '~'))
            throw new ArgumentException("The API key must contain 1 to 512 visible ASCII characters without embedded whitespace.");
        return key;
    }
}
