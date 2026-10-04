using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using SparkStudio.Gateway;

internal static class AskSparkCacheChecks
{
    private const string Key = "fixture.cache-key/+=!";
    private static int checks;

    public static async Task<int> RunAsync()
    {
        checks = 0;
        UsageChecks();
        await ScopeChecks();
        await LifecycleChecks();
        await FallbackChecks();
        await ConcurrentChecks();
        await ProviderChecks();
        await BudgetChecks();
        await RejectedBodyChecks();
        return checks;
    }

    private static async Task ScopeChecks()
    {
        var clock = new FixtureClock();
        using var handler = new FixtureHandler(clock);
        using var client = new HttpClient(handler);
        using var cache = new AskSparkCache(client, clock);
        var body = Body();
        var first = await cache.GetAsync(body, "gemini-3.8-flash", Key, "revision1", "actor-project-page", CancellationToken.None);
        Check(first is not null && handler.Creates.Count == 1, "first authorized prefix creates provider cache");
        Check(handler.Creates[0]["ttl"]?.GetValue<string>() == "3600s", "cache creation uses one-hour TTL");
        Check(handler.Creates[0]["contents"] is null && !handler.Creates[0].ToJsonString().Contains("private-fixture", StringComparison.Ordinal), "cache excludes private messages and images");
        Check(handler.Headers.All(value => value == Key) && handler.Uris.All(uri => uri.Host == "generativelanguage.googleapis.com" && uri.Query.Length == 0), "cache requests use fixed origin and header-only key");
        var repeat = await cache.GetAsync(body, "gemini-3.8-flash", Key, "revision1", "actor-project-page", CancellationToken.None);
        Check(repeat == first && handler.Creates.Count == 1, "identical prefix and scope reuse cache");
        var reordered = JsonNode.Parse("{\"toolConfig\":{\"functionCallingConfig\":{\"mode\":\"AUTO\"}},\"tools\":[{\"functionDeclarations\":[]}],\"systemInstruction\":{\"parts\":[{\"text\":\"Synthetic instructions\"}]}}")!.AsObject();
        Check(await cache.GetAsync(reordered, "gemini-3.8-flash", Key, "revision1", "actor-project-page", CancellationToken.None) == first, "canonical object ordering does not duplicate cache");
        await cache.GetAsync(body, "gemini-3.8-flash", Key, "revision1", "other-actor-project-page", CancellationToken.None);
        await cache.GetAsync(body, "gemini-3.8-flash", Key, "revision2", "actor-project-page", CancellationToken.None);
        await cache.GetAsync(body, "gemini-3.8-pro", Key, "revision1", "actor-project-page", CancellationToken.None);
        await cache.GetAsync(body, "gemini-3.8-flash", Key + "-rotated", "revision1", "actor-project-page", CancellationToken.None);
        Check(handler.Creates.Count == 5, "scope, revision, model and credential changes isolate caches");
        body["tools"]![0]!["functionDeclarations"]!.AsArray().Add(new JsonObject { ["name"] = "added_fixture" });
        await cache.GetAsync(body, "gemini-3.8-flash", Key, "revision1", "actor-project-page", CancellationToken.None);
        Check(handler.Creates.Count == 6, "progressive schema changes create separate cache");
        var reference = AskSparkCache.Reference(body, first!);
        Check(reference["cachedContent"]?.GetValue<string>() == first && reference["tools"] is null && reference["systemInstruction"] is null && reference["toolConfig"] is null, "cached request does not override immutable prefix");
        Check(JsonNode.DeepEquals(reference["contents"], body["contents"]), "cached request preserves private dynamic contents exactly");
    }

    private static async Task LifecycleChecks()
    {
        var clock = new FixtureClock();
        using var handler = new FixtureHandler(clock);
        using var client = new HttpClient(handler);
        using var cache = new AskSparkCache(client, clock);
        for (var index = 0; index < 9; index++)
        {
            await cache.GetAsync(Body(), "gemini-3.8-flash", Key, "revision", "scope" + index, CancellationToken.None);
            clock.Advance(TimeSpan.FromSeconds(1));
        }
        Check(handler.Creates.Count == 9 && handler.Deletes.Count == 1 && handler.MaximumLive == 8, "LRU deletion precedes ninth cache creation");
        handler.DeleteStatus = HttpStatusCode.ServiceUnavailable;
        Check(await cache.GetAsync(Body(), "gemini-3.8-flash", Key, "revision", "scope10", CancellationToken.None) is null && handler.Creates.Count == 9, "failed eviction falls back without exceeding cache cap");
        clock.Advance(TimeSpan.FromHours(1));
        handler.DeleteStatus = HttpStatusCode.OK;
        await cache.GetAsync(Body(), "gemini-3.8-flash", Key, "revision", "scope10", CancellationToken.None);
        Check(handler.Creates.Count == 10, "expired entries release their bounded slots");
    }

    private static async Task FallbackChecks()
    {
        var clock = new FixtureClock();
        using var handler = new FixtureHandler(clock) { CreateStatus = HttpStatusCode.BadRequest };
        using var client = new HttpClient(handler);
        using var cache = new AskSparkCache(client, clock);
        Check(await cache.GetAsync(Body(), "gemini-3.8-flash", Key, "revision", "scope", CancellationToken.None) is null, "below-minimum or unsupported cache falls back");
        await cache.GetAsync(Body(), "gemini-3.8-flash", Key, "revision", "scope", CancellationToken.None);
        Check(handler.Creates.Count == 1, "rejected prefix has bounded retry cooldown");
        clock.Advance(TimeSpan.FromMinutes(6));
        handler.CreateStatus = HttpStatusCode.OK;
        handler.InvalidName = true;
        Check(await cache.GetAsync(Body(), "gemini-3.8-flash", Key, "revision", "scope", CancellationToken.None) is null, "provider cache path injection is rejected");
        handler.InvalidName = false;
        await cache.GetAsync(Body(), "gemini-3.8-flash", Key, "revision", "scope", CancellationToken.None);
        Check(handler.Creates.Count == 2, "uncertain creation occupies slot until TTL rather than retrying");
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await RejectAsync(() => cache.GetAsync(Body(), "gemini-3.8-flash", Key, "revision", "cancelled", cancelled.Token), "cache respects caller cancellation");
    }

    private static async Task ProviderChecks()
    {
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.AskSparkCache." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var settings = new AskSparkSettings(directory, new EphemeralDataProtectionProvider());
            settings.Save(new("0", true, AskSparkSettings.DefaultModel, ApiKey: Key));
            using var handler = new FixtureHandler(new FixtureClock(DateTimeOffset.UtcNow));
            using var client = new HttpClient(handler);
            using var provider = new AskSparkGemini(client, settings);
            var context = new AskSparkModelContext("read_fixture — Synthetic read", "private-scope-hash");
            var contents = Body()["contents"]!.DeepClone().AsArray();
            var result = await provider.GenerateAsync(contents, [Tool()], false, context, CancellationToken.None);
            Check(handler.Creates.Count == 1 && handler.Generations.Single()["cachedContent"] is not null, "provider uses explicit cache for scoped requests");
            Check(result.Usage == new AskSparkTokenUsage(100, 60, 5, 7, 112) && result.Tokens == 112, "provider reports prompt, cached, output, thought and total usage");
            Check(result.Content.ToJsonString().Contains("signature-fixture", StringComparison.Ordinal), "usage extraction preserves signed raw model content");
            Check(handler.Creates.Single()["systemInstruction"]!["parts"]![0]!["text"]!.GetValue<string>().Contains(context.ToolDirectory, StringComparison.Ordinal), "stable discovery directory joins cached system prompt");
            await provider.GenerateAsync(contents, [Tool()], true, context, CancellationToken.None);
            Check(handler.Creates.Count == 1 && handler.Generations.Last()["cachedContent"] is null && handler.Generations.Last()["tools"] is null, "forced final answer bypasses cached tool definitions");
            handler.ExpireNext = true;
            var before = handler.Generations.Count;
            await provider.GenerateAsync(contents, [Tool()], false, context, CancellationToken.None);
            Check(handler.Generations.Count == before + 2 && handler.Generations.Last()["systemInstruction"] is not null && handler.Generations.Last()["cachedContent"] is null, "explicit cache expiration safely retries uncached once");
            handler.GenerationStatus = HttpStatusCode.ServiceUnavailable;
            before = handler.Generations.Count;
            await RejectAsync(() => provider.GenerateAsync(contents, [Tool()], false, context, CancellationToken.None), "provider server failure");
            Check(handler.Generations.Count == before + 1, "ambiguous generation failure is never retried");
        }
        finally { Directory.Delete(directory, true); }
    }

    private static async Task ConcurrentChecks()
    {
        using var handler = new FixtureHandler(new FixtureClock()) { CreateGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously) };
        using var client = new HttpClient(handler);
        using var cache = new AskSparkCache(client);
        var first = cache.GetAsync(Body(), "gemini-3.8-flash", Key, "revision", "scope", CancellationToken.None);
        Check(await cache.GetAsync(Body(), "gemini-3.8-flash", Key, "revision", "scope", CancellationToken.None) is null, "concurrent cache creation uses uncached fallback rather than blocking or duplicating");
        handler.CreateGate.SetResult();
        await first;
        Check(handler.Creates.Count == 1, "cache creation concurrency is bounded to one request");
    }

    private static async Task BudgetChecks()
    {
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.AskSparkBudget." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var settings = new AskSparkSettings(directory, new EphemeralDataProtectionProvider());
            settings.Save(new("0", true, AskSparkSettings.DefaultModel, ApiKey: Key, MonthlyTokenLimit: 20_000));
            var usage = new AskSparkUsage(directory);
            using var handler = new FixtureHandler(new FixtureClock(DateTimeOffset.UtcNow));
            using var client = new HttpClient(handler);
            using var provider = new AskSparkGemini(client, settings, usage: usage);
            var contents = new JsonArray(AskSparkGemini.TextContent("user", "Synthetic budget request"));
            await provider.GenerateAsync(contents, [Tool()], false, new("fixture directory", "scope"), CancellationToken.None);
            var counted = handler.Counts.Single()["generateContentRequest"]!;
            Check(counted["systemInstruction"] is not null && counted["tools"] is not null && counted["cachedContent"] is null && counted["model"]?.GetValue<string>() == "models/gemini-3.8-flash", "budget counts complete uncached prompt including authorized tools");
            await provider.TestAsync(CancellationToken.None);
            await provider.TranscribeAsync(new("AQ==", "audio/webm"), CancellationToken.None);
            var measured = usage.Snapshot(20_000);
            Check(measured.Requests == 3 && measured.UsedTokens == 156 && measured.CachedTokens == 180 && measured.UncertainRequests == 0, "chat, provider test and transcription record measured uncached usage");
            handler.GenerationStatus = HttpStatusCode.BadRequest;
            await RejectAsync(() => provider.TestAsync(CancellationToken.None), "known provider rejection");
            Check(usage.Snapshot(20_000).UsedTokens == measured.UsedTokens && usage.Snapshot(20_000).UncertainRequests == 0, "known provider rejection releases reservation");
            handler.GenerationStatus = HttpStatusCode.ServiceUnavailable;
            await RejectAsync(() => provider.TestAsync(CancellationToken.None), "ambiguous provider failure");
            Check(usage.Snapshot(20_000).UsedTokens == measured.UsedTokens + 132 && usage.Snapshot(20_000).UncertainRequests == 1, "ambiguous dispatched failure keeps conservative reservation");
            await BudgetFailureChecks(settings, usage, handler, provider);
        }
        finally { Directory.Delete(directory, true); }
    }

    private static async Task BudgetFailureChecks(AskSparkSettings settings, AskSparkUsage usage, FixtureHandler handler, AskSparkGemini provider)
    {
        handler.GenerationStatus = HttpStatusCode.OK;
        settings.Save(new(settings.Snapshot().Revision, true, AskSparkSettings.DefaultModel, MonthlyTokenLimit: 100));
        var before = handler.Generations.Count;
        await RejectAsync(() => provider.TestAsync(CancellationToken.None), "insufficient monthly headroom");
        Check(handler.Generations.Count == before, "exhausted allowance stops before generation dispatch");
        settings.Save(new(settings.Snapshot().Revision, true, AskSparkSettings.DefaultModel, MonthlyTokenLimit: 20_000));
        var used = usage.Snapshot(20_000).UsedTokens;
        handler.CountStatus = HttpStatusCode.ServiceUnavailable;
        await RejectAsync(() => provider.TestAsync(CancellationToken.None), "token measurement failure");
        Check(usage.Snapshot(20_000).UsedTokens == used && handler.Generations.Count == before, "failed measurement creates no allowance reservation or generation");
        settings.Save(new(settings.Snapshot().Revision, true, AskSparkSettings.DefaultModel));
        var countCalls = handler.Counts.Count;
        await provider.TestAsync(CancellationToken.None);
        Check(handler.Counts.Count == countCalls && usage.Snapshot(0).UsedTokens == used + 52, "unlimited allowance skips counting request while retaining actual usage");
    }

    private static async Task RejectedBodyChecks()
    {
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.AskSparkRejectedBody." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var settings = new AskSparkSettings(directory, new EphemeralDataProtectionProvider());
            settings.Save(new("0", true, AskSparkSettings.DefaultModel, ApiKey: Key, MonthlyTokenLimit: 20_000));
            var usage = new AskSparkUsage(directory);
            using var rawLog = new AskSparkRawLog(directory, settings);
            using var handler = new FixtureHandler(new FixtureClock(DateTimeOffset.UtcNow));
            using var client = new HttpClient(handler);
            using var provider = new AskSparkGemini(client, settings, usage: usage, rawLog: rawLog);
            var oversized = new string('x', 2 * 1024 * 1024 + 32);
            handler.GenerationReplies.Enqueue((HttpStatusCode.BadRequest, oversized));
            await RejectAsync(() => provider.TestAsync(CancellationToken.None), "known 400 with oversized diagnostic body");
            Check(usage.Snapshot(20_000).UsedTokens == 0 && usage.Snapshot(20_000).UncertainRequests == 0, "oversized 400 body preserves known rejection and releases its token reservation");
            Check(handler.Generations.Count == 1, "oversized rejection does not retry generation");
            Check(Directory.EnumerateFiles(Path.Combine(directory, AskSparkRawLog.DirectoryName), "*.txt")
                .Any(path => File.ReadAllText(path).Contains("response-incomplete", StringComparison.Ordinal)), "bounded rejected body remains marked in raw diagnostics");
            var contents = new JsonArray(AskSparkGemini.TextContent("user", "Synthetic capture error"));
            var context = new AskSparkModelContext("Fixture directory", "rejected-body-scope");
            handler.GenerationReplies.Enqueue((HttpStatusCode.BadRequest, "{malformed provider error"));
            await RejectAsync(() => provider.GenerateAsync(contents, [Tool()], false, context, CancellationToken.None), "cached 400 with malformed diagnostic JSON");
            Check(handler.Generations.Count == 2 && handler.Generations.Last()["cachedContent"] is not null, "malformed cached 400 cannot prove cache expiration and is not retried");
            Check(usage.Snapshot(20_000).UsedTokens == 0 && usage.Snapshot(20_000).UncertainRequests == 0, "malformed cached rejection releases its token reservation");
            foreach (var diagnostic in new[] { "{\"error\":{\"message\":42}}", "{\"error\":\"bad\"}" })
            {
                handler.GenerationReplies.Enqueue((HttpStatusCode.BadRequest, diagnostic));
                var attempts = handler.Generations.Count;
                await RejectAsync(() => provider.GenerateAsync(contents, [Tool()], false, context, CancellationToken.None), "cached 400 with wrong-shaped diagnostic JSON");
                Check(handler.Generations.Count == attempts + 1 && usage.Snapshot(20_000).UsedTokens == 0 && usage.Snapshot(20_000).UncertainRequests == 0,
                    "wrong-shaped cached error stays a known rejection without retry or uncertain token charge");
            }
            handler.GenerationReplies.Enqueue((HttpStatusCode.NotFound, oversized));
            var before = handler.Generations.Count;
            await provider.GenerateAsync(contents, [Tool()], false, context, CancellationToken.None);
            Check(handler.Generations.Count == before + 2 && handler.Generations.Last()["cachedContent"] is null, "known cached 404 retains the single safe fallback even when its body exceeds the diagnostic limit");
            Check(usage.Snapshot(20_000).UsedTokens == 52 && usage.Snapshot(20_000).UncertainRequests == 0, "cache fallback accounts only the measured successful generation");
        }
        finally { Directory.Delete(directory, true); }
    }

    private static void UsageChecks()
    {
        Check(AskSparkGemini.ReadUsage(new JsonObject()) is null, "absent usage does not release uncertain allowance");
        Check(AskSparkGemini.ReadUsage(new JsonObject { ["usageMetadata"] = new JsonObject() }) is null, "missing total usage does not become a zero charge");
        Check(AskSparkGemini.ReadUsage(new JsonObject { ["usageMetadata"] = new JsonObject { ["totalTokenCount"] = -1 } }) is null, "negative total usage is rejected");
        Check(AskSparkGemini.ReadUsage(new JsonObject { ["usageMetadata"] = new JsonObject { ["totalTokenCount"] = "100" } }) is null, "non-integer total usage is rejected");
        Check(AskSparkGemini.ReadUsage(new JsonObject { ["usageMetadata"] = new JsonObject { ["totalTokenCount"] = 0 } })?.TotalTokens == 0, "explicit zero usage remains valid");
    }

    private static JsonObject Body() => new()
    {
        ["systemInstruction"] = new JsonObject { ["parts"] = new JsonArray(new JsonObject { ["text"] = "Synthetic instructions" }) },
        ["tools"] = new JsonArray(new JsonObject { ["functionDeclarations"] = new JsonArray() }),
        ["toolConfig"] = new JsonObject { ["functionCallingConfig"] = new JsonObject { ["mode"] = "AUTO" } },
        ["contents"] = new JsonArray(new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = "private-fixture" }, new JsonObject { ["inlineData"] = new JsonObject { ["mimeType"] = "image/png", ["data"] = "private-fixture" } }) })
    };

    private static AskSparkTool Tool() => new("read_fixture", "Synthetic read", new JsonObject { ["type"] = "object", ["properties"] = new JsonObject() }, "fixture", "read", "gateway", "signedIn", false, true);
    private static void Check(bool passed, string name) { if (!passed) throw new InvalidOperationException("Ask Spark cache check failed: " + name); checks++; }
    private static async Task RejectAsync(Func<Task> action, string name)
    {
        try { await action(); }
        catch (Exception error) when (error is BadHttpRequestException or AskSparkProviderException or OperationCanceledException) { checks++; return; }
        throw new InvalidOperationException("Ask Spark cache check did not reject: " + name);
    }

    private sealed class FixtureClock(DateTimeOffset? initial = null) : TimeProvider
    {
        private DateTimeOffset now = initial ?? DateTimeOffset.Parse("2026-10-03T12:00:00Z", global::System.Globalization.CultureInfo.InvariantCulture);
        public override DateTimeOffset GetUtcNow() => now;
        public void Advance(TimeSpan duration) => now += duration;
    }

    private sealed class FixtureHandler(FixtureClock clock) : HttpMessageHandler
    {
        public List<JsonObject> Creates { get; } = [];
        public List<JsonObject> Generations { get; } = [];
        public List<JsonObject> Counts { get; } = [];
        public Queue<(HttpStatusCode Status, string Body)> GenerationReplies { get; } = new();
        public List<string> Deletes { get; } = [];
        public List<string> Headers { get; } = [];
        public List<Uri> Uris { get; } = [];
        private readonly Dictionary<string, DateTimeOffset> live = new(StringComparer.Ordinal);
        public HttpStatusCode CreateStatus { get; set; } = HttpStatusCode.OK;
        public HttpStatusCode DeleteStatus { get; set; } = HttpStatusCode.OK;
        public HttpStatusCode GenerationStatus { get; set; } = HttpStatusCode.OK;
        public HttpStatusCode CountStatus { get; set; } = HttpStatusCode.OK;
        public bool InvalidName { get; set; }
        public bool ExpireNext { get; set; }
        public int MaximumLive { get; private set; }
        public TaskCompletionSource? CreateGate { get; init; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Headers.Add(request.Headers.GetValues("x-goog-api-key").Single()); Uris.Add(request.RequestUri!);
            if (request.Method == HttpMethod.Delete)
            {
                Deletes.Add(request.RequestUri!.AbsolutePath);
                if (DeleteStatus == HttpStatusCode.OK) live.Remove(request.RequestUri.AbsolutePath[8..]);
                return Response(DeleteStatus, new JsonObject());
            }
            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject();
            if (request.RequestUri!.AbsolutePath.EndsWith(":countTokens", StringComparison.Ordinal))
            { Counts.Add(body); return Response(CountStatus, new JsonObject { ["totalTokens"] = 100 }); }
            if (request.RequestUri!.AbsolutePath.EndsWith("/cachedContents", StringComparison.Ordinal))
            {
                if (CreateGate is not null) await CreateGate.Task.WaitAsync(cancellationToken);
                return Create(body);
            }
            Generations.Add(body);
            if (GenerationReplies.TryDequeue(out var reply)) return new HttpResponseMessage(reply.Status) { Content = new StringContent(reply.Body) };
            if (ExpireNext && body["cachedContent"] is not null)
            { ExpireNext = false; return Response(HttpStatusCode.NotFound, new JsonObject()); }
            return Response(GenerationStatus, new JsonObject
            {
                ["candidates"] = new JsonArray(new JsonObject { ["content"] = new JsonObject { ["role"] = "model", ["parts"] = new JsonArray(new JsonObject { ["text"] = "Synthetic answer", ["thoughtSignature"] = "signature-fixture" }) } }),
                ["usageMetadata"] = new JsonObject { ["promptTokenCount"] = 100, ["cachedContentTokenCount"] = 60, ["candidatesTokenCount"] = 5, ["thoughtsTokenCount"] = 7, ["totalTokenCount"] = 112 }
            });
        }

        private HttpResponseMessage Create(JsonObject body)
        {
            Creates.Add(body);
            if (CreateStatus != HttpStatusCode.OK) return Response(CreateStatus, new JsonObject());
            foreach (var item in live.Where(item => item.Value <= clock.GetUtcNow()).ToArray()) live.Remove(item.Key);
            var name = "cachedContents/fixture-" + Creates.Count;
            var expires = clock.GetUtcNow().AddHours(1);
            live[name] = expires;
            MaximumLive = Math.Max(MaximumLive, live.Count);
            return Response(CreateStatus, new JsonObject { ["name"] = InvalidName ? "https://wrong.invalid/cache" : name, ["expireTime"] = expires.ToString("O") });
        }

        private static HttpResponseMessage Response(HttpStatusCode status, JsonObject body) => new(status) { Content = new StringContent(body.ToJsonString()) };
    }
}
