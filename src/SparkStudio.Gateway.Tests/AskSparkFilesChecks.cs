using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using SparkStudio.Gateway;

/// <summary>Pasted images are uploaded once and referenced by URI; every provider problem keeps the inline bytes.</summary>
internal static class AskSparkFilesChecks
{
    private const string Key = "AIzaFilesFixtureKey00000000000000000000";
    private static int checks;

    public static async Task<int> RunAsync()
    {
        checks = 0;
        await ReferenceChecks();
        await FallbackChecks();
        await GeminiChecks();
        return checks;
    }

    private static async Task ReferenceChecks()
    {
        var handler = new UploadHandler();
        using var client = new HttpClient(handler);
        var files = new AskSparkFiles(client);
        var image = LargeImage(1);
        var body = Body(image, SmallImage());
        var referenced = await files.ReferenceImagesAsync(body, Key, CancellationToken.None);
        var parts = referenced["contents"]![0]!["parts"]!.AsArray();
        Check(handler.Starts == 1 && handler.Uploads == 1, "one large image is uploaded once");
        Check(parts[1]!["fileData"]?["fileUri"]?.GetValue<string>() == UploadHandler.FileUri && parts[1]!["inlineData"] is null, "large pasted image becomes a file reference");
        Check(parts[2]!["inlineData"] is not null, "small images stay inline");
        Check(body["contents"]![0]!["parts"]![1]!["inlineData"] is not null, "the caller's request is not modified");
        Check(handler.UploadedBytes.SequenceEqual(Convert.FromBase64String(image)), "the exact image bytes are uploaded");
        Check(handler.StartKey == Key && handler.UploadKey == Key, "both upload steps authenticate with the API key header");
        var again = await files.ReferenceImagesAsync(Body(image), Key, CancellationToken.None);
        Check(handler.Uploads == 1 && again["contents"]![0]!["parts"]![1]!["fileData"] is not null, "a resent image reuses its earlier upload");
        await files.ReferenceImagesAsync(Body(image), "AIzaOtherFixtureKey000000000000000000000", CancellationToken.None);
        Check(handler.Uploads == 2, "another API key never reuses an upload");
        files.Forget(Key);
        await files.ReferenceImagesAsync(Body(image), Key, CancellationToken.None);
        Check(handler.Uploads == 3, "forgetting uploads forces a fresh upload");
        var model = Body(image); model["contents"]![0]!["role"] = "model";
        Check(ReferenceEquals(await files.ReferenceImagesAsync(model, Key, CancellationToken.None), model), "only user images are uploaded");
    }

    private static async Task FallbackChecks()
    {
        foreach (var failure in new[] { "start", "upload", "origin", "processing" })
        {
            var handler = new UploadHandler { Failure = failure };
            using var client = new HttpClient(handler);
            var body = Body(LargeImage(2));
            var result = await new AskSparkFiles(client).ReferenceImagesAsync(body, Key, CancellationToken.None);
            Check(ReferenceEquals(result, body), $"{failure} failure keeps the image inline");
            if (failure == "origin") Check(handler.Uploads == 0, "an upload URL outside the provider origin never receives image bytes");
        }
    }

    private static async Task GeminiChecks()
    {
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.AskSparkFiles." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var settings = new AskSparkSettings(directory, new EphemeralDataProtectionProvider());
            settings.Save(new("0", true, AskSparkSettings.DefaultModel, ApiKey: Key, MonthlyTokenLimit: 0));
            var handler = new UploadHandler { RejectFileReference = true };
            using var client = new HttpClient(handler);
            using var provider = new AskSparkGemini(client, settings);
            var reply = await provider.GenerateAsync(Body(LargeImage(3))["contents"]!.AsArray(), [], false, CancellationToken.None);
            Check(handler.Generations.Count == 2 && handler.Generations[0].ToJsonString().Contains("fileData", StringComparison.Ordinal)
                && handler.Generations[1].ToJsonString().Contains("inlineData", StringComparison.Ordinal) && !handler.Generations[1].ToJsonString().Contains("fileData", StringComparison.Ordinal),
                "a rejected file reference is retried once with the inline image");
            Check(AskSparkGemini.VisibleText(reply.Content) == "Synthetic answer", "the conversation continues after the inline retry");
        }
        finally { Directory.Delete(directory, true); }
    }

    private static string LargeImage(byte seed) => Convert.ToBase64String(Enumerable.Range(0, 90_000).Select(index => (byte)(index * 7 + seed)).ToArray());
    private static string SmallImage() => Convert.ToBase64String(new byte[] { 137, 80, 78, 71 });
    private static JsonObject Body(params string[] images)
    {
        var parts = new JsonArray(new JsonObject { ["text"] = "Recreate this screen." });
        foreach (var image in images) parts.Add(new JsonObject { ["inlineData"] = new JsonObject { ["mimeType"] = "image/png", ["data"] = image } });
        return new JsonObject { ["contents"] = new JsonArray(new JsonObject { ["role"] = "user", ["parts"] = parts }) };
    }
    private static void Check(bool passed, string name) { if (!passed) throw new InvalidOperationException("Ask Spark files check failed: " + name); checks++; }

    private sealed class UploadHandler : HttpMessageHandler
    {
        public const string FileUri = "https://generativelanguage.googleapis.com/v1beta/files/fixture-image";
        public string? Failure { get; init; }
        public bool RejectFileReference { get; init; }
        public int Starts { get; private set; }
        public int Uploads { get; private set; }
        public string? StartKey { get; private set; }
        public string? UploadKey { get; private set; }
        public byte[] UploadedBytes { get; private set; } = [];
        public List<JsonObject> Generations { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            var command = request.Headers.TryGetValues("X-Goog-Upload-Command", out var values) ? values.Single() : null;
            if (command == "start")
            {
                Starts++; StartKey = request.Headers.GetValues("x-goog-api-key").Single();
                if (Failure == "start") return new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("{\"error\":{\"message\":\"denied\"}}") };
                var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}") };
                response.Headers.Add("X-Goog-Upload-URL", Failure == "origin" ? "https://attacker.invalid/upload" : "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=fixture");
                return response;
            }
            if (command == "upload, finalize")
            {
                if (path != "/upload/v1beta/files" || !request.RequestUri.Query.Contains("upload_id", StringComparison.Ordinal)) throw new InvalidOperationException("Unexpected upload destination.");
                Uploads++; UploadKey = request.Headers.GetValues("x-goog-api-key").Single();
                UploadedBytes = await request.Content!.ReadAsByteArrayAsync(cancellationToken);
                if (Failure == "upload") return new HttpResponseMessage(HttpStatusCode.InternalServerError) { Content = new StringContent("{}") };
                var state = Failure == "processing" ? "PROCESSING" : "ACTIVE";
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(new JsonObject { ["file"] = new JsonObject
                    { ["name"] = "files/fixture-image", ["uri"] = FileUri, ["mimeType"] = "image/png", ["state"] = state, ["expirationTime"] = DateTimeOffset.UtcNow.AddHours(48).ToString("O") } }.ToJsonString()) };
            }
            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject();
            Generations.Add(body);
            if (RejectFileReference && body.ToJsonString().Contains("fileData", StringComparison.Ordinal))
                return new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent("{\"error\":{\"code\":400,\"message\":\"File not found\",\"status\":\"INVALID_ARGUMENT\"}}") };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(new JsonObject
            {
                ["candidates"] = new JsonArray(new JsonObject { ["content"] = new JsonObject { ["role"] = "model", ["parts"] = new JsonArray(new JsonObject { ["text"] = "Synthetic answer" }) }, ["finishReason"] = "STOP" }),
                ["usageMetadata"] = new JsonObject { ["promptTokenCount"] = 10, ["candidatesTokenCount"] = 2, ["totalTokenCount"] = 12 }
            }.ToJsonString()) };
        }
    }
}
