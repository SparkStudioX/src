using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using SparkStudio.Gateway;

internal static class AskSparkProviderErrorChecks
{
    private const string Key = "fixture.provider-key/+=!";
    private const string HighDemand = "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.";
    private static int checks;

    public static async Task<int> RunAsync()
    {
        checks = 0;
        await StatusChecks();
        await RedactionChecks();
        await UnreadableBodyChecks();
        await OperationChecks();
        await AccountingChecks();
        await CacheChecks();
        return checks;
    }

    private static async Task StatusChecks()
    {
        foreach (var (status, code, message, summary, retryable) in new[]
        {
            (503, "UNAVAILABLE", HighDemand, "temporarily unavailable (503)", true),
            (429, "RESOURCE_EXHAUSTED", "Quota exceeded for this model.", "quota or rate limit", true),
            (400, "INVALID_ARGUMENT", "Invalid value at tools[0].function_declarations[2].parameters.", "rejected the request (400)", false),
            (401, "UNAUTHENTICATED", "API key not valid.", "API key or model access (401)", false),
            (403, "PERMISSION_DENIED", "Permission denied for this model.", "API key or model access (403)", false),
            (404, "NOT_FOUND", "Model models/synthetic-model not found.", "model or resource was not found", false),
            (502, "INTERNAL", "Synthetic upstream failure.", "temporary server error (502)", true),
            (408, "DEADLINE_EXCEEDED", "Synthetic timeout.", "timed out (408)", true),
            (418, "UNKNOWN", "Synthetic other rejection.", "rejected the request (418)", false)
        })
        {
            using var fixture = new Fixture();
            fixture.Handler.Replies.Enqueue(((HttpStatusCode)status, Envelope(code, message)));
            var failure = await Failure(() => fixture.Provider.TestAsync(CancellationToken.None));
            Check(failure.Error == new AskSparkProviderError("Gemini", status, code, message, retryable), "structured provider status and message survive HTTP " + status);
            Check(failure.Message.Contains(summary, StringComparison.Ordinal), "actionable summary for HTTP " + status);
            Check(fixture.Handler.Generations.Count == 1, "provider HTTP error never automatically retries " + status);
            var payload = JsonSerializer.SerializeToNode(new { error = failure.Message, aiProviderError = failure.Error }, JsonSerializerOptions.Web)!;
            Check(payload["error"]!.GetValue<string>() == failure.Message && payload["aiProviderError"]!["httpStatus"]!.GetValue<int>() == status,
                "API retains error summary and camel-case provider metadata");
        }
    }

    private static async Task RedactionChecks()
    {
        using var fixture = new Fixture(logged: true);
        var message = "Invalid field tools[0]. " + Key + " " + Uri.EscapeDataString(Key)
            + " password='fixture password with spaces' api_key=fixture-other-key Authorization: Bearer fixture-auth-token"
            + " client_secret=fixture-client-secret access_token=fixture-access-token Basic Zml4dHVyZTpwdw=="
            + " https://fixture-user:fixture-uri-password@example.invalid AIzaFixtureKey012345678901234567890 <script>fixture text</script>";
        var envelope = JsonNode.Parse(Envelope("INVALID_ARGUMENT", message))!.AsObject();
        envelope["error"]!["details"] = new JsonArray(new JsonObject { ["password"] = "fixture-details-secret", ["request"] = Key });
        fixture.Handler.Replies.Enqueue((HttpStatusCode.BadRequest, envelope.ToJsonString()));
        var failure = await Failure(() => fixture.Provider.TestAsync(CancellationToken.None));
        var visible = JsonSerializer.Serialize(new { error = failure.Message, aiProviderError = failure.Error }, JsonSerializerOptions.Web);
        foreach (var secret in new[] { Key, Uri.EscapeDataString(Key), "fixture password with spaces", "fixture-other-key", "fixture-auth-token", "fixture-client-secret",
            "fixture-access-token", "Zml4dHVyZTpwdw==", "fixture-uri-password", "AIzaFixtureKey012345678901234567890", "fixture-details-secret" })
            Check(!visible.Contains(secret, StringComparison.Ordinal), "provider diagnostic omits configured and recognizable credentials");
        Check(failure.Error.Message!.Contains("Invalid field tools[0].", StringComparison.Ordinal)
            && failure.Error.Message.Contains("<script>fixture text</script>", StringComparison.Ordinal), "non-secret provider text remains text for the UI to escape");
        Check(Directory.EnumerateFiles(Path.Combine(fixture.DirectoryPath, AskSparkRawLog.DirectoryName), "*.txt")
            .Any(path => File.ReadAllText(path).Contains("fixture-client-secret", StringComparison.Ordinal)), "UI redaction preserves the deliberately unfiltered on-disk exchange log");
        fixture.Handler.Replies.Enqueue((HttpStatusCode.BadRequest, Envelope(Key, new string('x', 2038) + Key + " end")));
        failure = await Failure(() => fixture.Provider.TestAsync(CancellationToken.None));
        Check(failure.Error.Status is null && failure.Error.Message!.Length <= 2048
            && !failure.Error.Message.Contains("fixture.provider", StringComparison.Ordinal), "redaction precedes truncation and removes credentials from provider status");
    }

    private static async Task UnreadableBodyChecks()
    {
        foreach (var body in new[] { "<html>proxy failure</html>", "{broken", "{}", "[]", "{\"error\":\"wrong shape\"}", "{\"error\":{\"message\":7,\"status\":false}}",
            Envelope("UNAVAILABLE", new string('x', 70_000)) })
        {
            using var fixture = new Fixture();
            fixture.Handler.Replies.Enqueue((HttpStatusCode.ServiceUnavailable, body));
            var failure = await Failure(() => fixture.Provider.TestAsync(CancellationToken.None));
            Check(failure.Error.HttpStatus == 503 && failure.Error.Retryable && failure.Error.Status is null && failure.Error.Message is null,
                "malformed, wrong-shaped or oversized response retains useful status fallback");
            var payload = JsonSerializer.SerializeToNode(failure.Error, JsonSerializerOptions.Web)!.AsObject();
            Check(!payload.ContainsKey("status") && !payload.ContainsKey("message"), "absent provider detail is omitted from the API");
        }
        foreach (var cancellation in new[] { false, true })
        {
            using var fixture = new Fixture();
            fixture.Handler.GenerationContent = () => new StreamContent(new UnreadableStream(cancellation));
            fixture.Handler.Replies.Enqueue((HttpStatusCode.TooManyRequests, "unused"));
            var failure = await Failure(() => fixture.Provider.TestAsync(CancellationToken.None));
            Check(failure.Error.HttpStatus == 429 && failure.Error.Message is null, "known rejection survives response-stream failure or timeout");
        }
        using var chunked = new Fixture();
        chunked.Handler.GenerationContent = () => new StreamContent(new NonSeekableStream(Encoding.UTF8.GetBytes(Envelope("UNAVAILABLE", new string('x', 70_000)))));
        chunked.Handler.Replies.Enqueue((HttpStatusCode.ServiceUnavailable, "unused"));
        Check((await Failure(() => chunked.Provider.TestAsync(CancellationToken.None))).Error.Message is null, "unknown-length diagnostic body is bounded while streaming");
    }

    private static async Task OperationChecks()
    {
        using var fixture = new Fixture();
        Func<Task>[] operations = [() => fixture.Provider.GenerateAsync(Contents(), [], false, CancellationToken.None),
            () => fixture.Provider.TestAsync(CancellationToken.None), () => fixture.Provider.TranscribeAsync(new("AQ==", "audio/webm"), CancellationToken.None)];
        foreach (var operation in operations)
        {
            fixture.Handler.Replies.Enqueue((HttpStatusCode.ServiceUnavailable, Envelope("UNAVAILABLE", HighDemand)));
            var failure = await Failure(operation);
            Check(failure.Error.Message == HighDemand && failure.Error.Status == "UNAVAILABLE", "chat, connection test and transcription retain provider diagnostics");
        }
        Check(fixture.Handler.Generations.Count == 3, "each failing operation sends exactly one provider request");
    }

    private static async Task AccountingChecks()
    {
        foreach (var status in new[] { 400, 401, 403, 404, 429, 500, 503 })
        {
            using var fixture = new Fixture(limited: true);
            fixture.Handler.Replies.Enqueue(((HttpStatusCode)status, Envelope("SYNTHETIC_ERROR", "Synthetic provider rejection")));
            var failure = await Failure(() => fixture.Provider.TestAsync(CancellationToken.None));
            var snapshot = fixture.Usage.Snapshot(20_000);
            Check(failure.Error.HttpStatus == status && snapshot.UsedTokens == (status < 500 ? 0 : 132)
                && snapshot.UncertainRequests == (status < 500 ? 0 : 1), "diagnostics preserve known rejection versus uncertain dispatch accounting " + status);
        }
        foreach (var status in new[] { HttpStatusCode.BadRequest, HttpStatusCode.ServiceUnavailable })
        {
            using var fixture = new Fixture(limited: true);
            fixture.Handler.CountReply = (status, Envelope("SYNTHETIC_ERROR", "Could not count this request."));
            var failure = await Failure(() => fixture.Provider.TestAsync(CancellationToken.None));
            Check(failure.Error.HttpStatus == (int)status && failure.Error.Message == "Could not count this request.", "countTokens exposes provider detail");
            Check(fixture.Handler.CountCalls == 1 && fixture.Handler.Generations.Count == 0
                && fixture.Usage.Snapshot(20_000).UsedTokens == 0 && fixture.Usage.Snapshot(20_000).UncertainRequests == 0,
                "failed token measurement neither dispatches generation nor creates an uncertain reservation");
        }
    }

    private static async Task CacheChecks()
    {
        foreach (var logged in new[] { false, true })
        {
            using var fixture = new Fixture(limited: true, logged: logged);
            var context = new AskSparkModelContext("Synthetic directory", "provider-error-fixture");
            var tool = new AskSparkTool("read_fixture", "Synthetic read", new JsonObject { ["type"] = "object" }, "fixture", "read", "gateway", "signedIn", false, true);
            Task<AskSparkModelReply> Generate() => fixture.Provider.GenerateAsync(Contents(), [tool], false, context, CancellationToken.None);
            fixture.Handler.Replies.Enqueue((HttpStatusCode.BadRequest, Envelope("INVALID_ARGUMENT", "Invalid function_response reference name.")));
            var failure = await Failure(Generate);
            Check(failure.Error.Message == "Invalid function_response reference name." && fixture.Handler.Generations.Count == 1
                && fixture.Handler.Generations[0]["cachedContent"] is not null, "cached non-cache rejection retains detail without rereading its stream or retrying");
            Check(fixture.Usage.Snapshot(20_000).UncertainRequests == 0, "cached known rejection releases reservation");
            fixture.Handler.Replies.Enqueue((HttpStatusCode.BadRequest, Envelope("INVALID_ARGUMENT", "The cached content has expired.")));
            fixture.Handler.Replies.Enqueue((HttpStatusCode.ServiceUnavailable, Envelope("UNAVAILABLE", HighDemand)));
            failure = await Failure(Generate);
            Check(fixture.Handler.Generations.Count == 3 && fixture.Handler.Generations[1]["cachedContent"] is not null
                && fixture.Handler.Generations[2]["cachedContent"] is null && failure.Error.Message == HighDemand,
                "explicit cache rejection retries uncached exactly once and reports final provider failure");
            Check(fixture.Usage.Snapshot(20_000).UsedTokens == 8292 && fixture.Usage.Snapshot(20_000).UncertainRequests == 1,
                "failed uncached retry retains one conservative reservation");
            if (logged)
                Check(Directory.EnumerateFiles(Path.Combine(fixture.DirectoryPath, AskSparkRawLog.DirectoryName), "*.txt")
                    .Any(path => File.ReadAllText(path).Contains(HighDemand, StringComparison.Ordinal)), "raw exchange logging still records original provider detail");
        }
    }

    private static string Envelope(string status, string message) => new JsonObject { ["error"] = new JsonObject { ["code"] = 503, ["status"] = status, ["message"] = message } }.ToJsonString();
    private static JsonArray Contents() => new(AskSparkGemini.TextContent("user", "Synthetic provider diagnostic request"));
    private static void Check(bool passed, string name) { if (!passed) throw new InvalidOperationException("Ask Spark provider error check failed: " + name); checks++; }
    private static async Task<AskSparkProviderException> Failure(Func<Task> operation)
    {
        try { await operation(); }
        catch (AskSparkProviderException error) { checks++; return error; }
        throw new InvalidOperationException("Expected a structured Ask Spark provider error.");
    }

    private sealed class Fixture : IDisposable
    {
        public string DirectoryPath { get; } = Path.Combine(Path.GetTempPath(), "SparkStudio.ProviderError." + Guid.NewGuid().ToString("N"));
        public FixtureHandler Handler { get; } = new();
        public AskSparkUsage Usage { get; }
        public AskSparkGemini Provider { get; }
        private readonly HttpClient client;
        private readonly AskSparkRawLog? rawLog;
        public Fixture(bool limited = false, bool logged = false)
        {
            Directory.CreateDirectory(DirectoryPath);
            var settings = new AskSparkSettings(DirectoryPath, new EphemeralDataProtectionProvider());
            settings.Save(new("0", true, AskSparkSettings.DefaultModel, ApiKey: Key, MonthlyTokenLimit: limited ? 20_000 : 0));
            Usage = new AskSparkUsage(DirectoryPath);
            client = new HttpClient(Handler);
            rawLog = logged ? new AskSparkRawLog(DirectoryPath, settings) : null;
            Provider = new AskSparkGemini(client, settings, usage: Usage, rawLog: rawLog);
        }
        public void Dispose() { Provider.Dispose(); client.Dispose(); rawLog?.Dispose(); Directory.Delete(DirectoryPath, true); }
    }

    private sealed class FixtureHandler : HttpMessageHandler
    {
        public Queue<(HttpStatusCode Status, string Body)> Replies { get; } = new();
        public List<JsonObject> Generations { get; } = [];
        public (HttpStatusCode Status, string Body)? CountReply { get; set; }
        public Func<HttpContent>? GenerationContent { get; set; }
        public int CountCalls { get; private set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith(":countTokens", StringComparison.Ordinal))
            {
                CountCalls++;
                return CountReply is { } count ? Response(count.Status, count.Body) : Response(HttpStatusCode.OK, "{\"totalTokens\":100}");
            }
            if (path.EndsWith("/cachedContents", StringComparison.Ordinal))
                return Response(HttpStatusCode.OK, new JsonObject { ["name"] = "cachedContents/provider-fixture", ["expireTime"] = DateTimeOffset.UtcNow.AddHours(1).ToString("O") }.ToJsonString());
            Generations.Add(JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject());
            if (Replies.TryDequeue(out var reply)) return new(reply.Status) { Content = GenerationContent?.Invoke() ?? new StringContent(reply.Body) };
            return Response(HttpStatusCode.OK, "{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"Synthetic reply\"}]}}],\"usageMetadata\":{\"totalTokenCount\":112,\"promptTokenCount\":100,\"cachedContentTokenCount\":60,\"candidatesTokenCount\":12}}");
        }
        private static HttpResponseMessage Response(HttpStatusCode status, string body) => new(status) { Content = new StringContent(body) };
    }

    private sealed class UnreadableStream(bool cancellation) : MemoryStream
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            => ValueTask.FromException<int>(cancellation ? new OperationCanceledException("Synthetic body timeout") : new IOException("Synthetic truncated response"));
    }
    private sealed class NonSeekableStream(byte[] bytes) : MemoryStream(bytes)
    {
        public override bool CanSeek => false;
    }
}
