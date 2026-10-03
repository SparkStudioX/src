using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using SparkStudio.Gateway;

internal static class AskSparkChecks
{
    private const string FixtureApiKey = "fixture.synthetic-key/+=:!~";
    private static int checks;
    public static async Task<int> RunAsync()
    {
        checks = 0;
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.AskSpark." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var protection = new EphemeralDataProtectionProvider();
            var settings = Settings(directory, protection);
            using var security = new SecurityStore(directory);
            var admin = security.Setup(File.ReadAllText(Path.Combine(directory, "security", "setup-code.txt")).Trim(), new("ask-fixture", "Synthetic-password-12345"));
            var projects = new ProjectCatalog(directory, protection);
            var conversations = new AskSparkConversations(directory, protection);
            var catalog = new AskSparkCatalog([Tool("read_fixture", "read", false, true), Tool("write_fixture", "write", true, false)]);
            var model = new FakeModel();
            var service = new AskSparkService(settings, conversations, catalog, model, security, projects);
            await ApprovalChecks(service, model, conversations, admin, directory);
            await ParallelChecks(service, model, conversations, admin);
            await ContextChecks(service, model, conversations, admin, projects.DefaultId);
            CorruptedHistoryChecks(conversations, admin, directory);
            await ProviderChecks(settings);
            SchemaChecks();
            AuthoringChecks(projects.Get(projects.DefaultId).Store);
            await BackupChecks(directory, protection);
            PermissionChecks(security, admin, projects.DefaultId);
            using var registration = new ServiceCollection().AddAskSpark(directory).BuildServiceProvider();
            Check(registration.GetRequiredService<AskSparkCatalog>().Allowed(security, admin, projects.DefaultId, true).Length > 30, "DI loads shipped declarations rather than an empty enumerable");
            Check(!catalog.Allowed(security, admin, null, false).Any(tool => tool.Permission == "operate"), "runtime tools require an explicit project context");
            await RejectAsync(() => service.TurnAsync(admin, new(Message: "revoked"), CancellationToken.None, () => false), "revoked session");
            return checks;
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    private static AskSparkSettings Settings(string directory, IDataProtectionProvider protection)
    {
        var settings = new AskSparkSettings(directory, protection);
        Check(settings.Snapshot().Model == "gemini-3.8-flash" && !settings.Snapshot().HasApiKey, "default model and empty key");
        Reject(() => settings.Save(new("0", true, AskSparkSettings.DefaultModel)), "enabled without key");
        var saved = settings.Save(new("0", true, AskSparkSettings.DefaultModel, ApiKey: " \t" + FixtureApiKey + "\r\n "));
        Check(settings.Credentials().Key == FixtureApiKey, "pasted dotted key trims surrounding whitespace before encryption");
        Check(saved.HasApiKey && !JsonSerializer.Serialize(saved).Contains(FixtureApiKey, StringComparison.Ordinal), "settings redact key");
        Check(!File.ReadAllText(Path.Combine(directory, "ask-spark-settings.json")).Contains(FixtureApiKey, StringComparison.Ordinal), "key encrypted on disk");
        Reject(() => settings.Save(new("0", false, AskSparkSettings.DefaultModel)), "stale settings revision");
        var reloaded = new AskSparkSettings(directory, protection);
        Check(reloaded.Credentials().Key == FixtureApiKey, "protected dotted key survives reload");
        KeyNormalizationChecks(settings);
        return settings;
    }

    private static void KeyNormalizationChecks(AskSparkSettings settings)
    {
        var revision = settings.Snapshot().Revision;
        Reject(() => settings.Save(new(revision, true, AskSparkSettings.DefaultModel, ApiKey: " \t\r\n ")), "whitespace-only replacement key");
        Reject(() => settings.Save(new(revision, true, AskSparkSettings.DefaultModel, ApiKey: "fixture key")), "internal key whitespace");
        Reject(() => settings.Save(new(revision, true, AskSparkSettings.DefaultModel, ApiKey: "fixture\tkey")), "internal key tab");
        Reject(() => settings.Save(new(revision, true, AskSparkSettings.DefaultModel, ApiKey: "fixture\r\nkey")), "internal key line break");
        Reject(() => settings.Save(new(revision, true, AskSparkSettings.DefaultModel, ApiKey: "fixture\0key")), "key control character");
        Reject(() => settings.Save(new(revision, true, AskSparkSettings.DefaultModel, ApiKey: "fixture\u007fkey")), "key delete character");
        Reject(() => settings.Save(new(revision, true, AskSparkSettings.DefaultModel, ApiKey: "fixture\u00e9key")), "non-ASCII key character");
        Reject(() => settings.Save(new(revision, true, AskSparkSettings.DefaultModel, ApiKey: new string('x', 513))), "key length limit");
        Check(settings.Snapshot().Revision == revision && settings.Credentials().Key == FixtureApiKey, "invalid replacements leave saved key and revision unchanged");
        var kept = settings.Save(new(revision, true, AskSparkSettings.DefaultModel));
        Check(settings.Credentials().Key == FixtureApiKey, "omitted key preserves saved credential");
        settings.Save(new(kept.Revision, true, AskSparkSettings.DefaultModel, ApiKey: ""));
        Check(settings.Credentials().Key == FixtureApiKey, "empty key preserves saved credential");
        KeyCharacterChecks(settings);
    }

    private static void KeyCharacterChecks(AskSparkSettings settings)
    {
        var visibleAscii = string.Concat(Enumerable.Range(0x21, 0x7e - 0x21 + 1).Select(value => (char)value));
        var saved = settings.Save(new(settings.Snapshot().Revision, true, AskSparkSettings.DefaultModel, ApiKey: visibleAscii));
        Check(settings.Credentials().Key == visibleAscii, "all visible ASCII punctuation is preserved in opaque keys");
        var maximum = new string('x', 512);
        saved = settings.Save(new(saved.Revision, true, AskSparkSettings.DefaultModel, ApiKey: " " + maximum + " "));
        Check(settings.Credentials().Key == maximum, "512-character normalized key is accepted");
        Reject(() => settings.Save(new(saved.Revision, false, AskSparkSettings.DefaultModel, ApiKey: FixtureApiKey, ClearApiKey: true)), "replace and clear key conflict");
        saved = settings.Save(new(saved.Revision, false, AskSparkSettings.DefaultModel, ClearApiKey: true));
        Check(!saved.HasApiKey, "explicit key clearing still removes credential");
        settings.Save(new(saved.Revision, true, AskSparkSettings.DefaultModel, ApiKey: FixtureApiKey));
    }

    private static async Task ApprovalChecks(AskSparkService service, FakeModel model, AskSparkConversations conversations, SecurityUser actor, string directory)
    {
        model.Replies.Enqueue(Calls("write_fixture"));
        var first = await service.TurnAsync(actor, new(Message: "Create fixture"), CancellationToken.None);
        var call = first.ToolCalls.Single();
        Check(call.Confirmation && !call.Authorized && call.ApprovalToken is not null, "write requires exact-call approval");
        var result = new AskSparkToolResult(call.Id, call.Name, new JsonObject { ["ok"] = true });
        await RejectAsync(() => service.TurnAsync(actor, new(first.ConversationId, ToolResults: [result], ContinuationToken: first.ContinuationToken), CancellationToken.None), "unapproved result");
        var confirmation = JsonSerializer.SerializeToNode(service.Confirm(actor, new(first.ConversationId, call.ApprovalToken!, true)), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Check(confirmation!["toolCalls"]![0]!["authorized"]!.GetValue<bool>(), "explicit approval releases exact call");
        Reject(() => service.Confirm(actor, new(first.ConversationId, call.ApprovalToken!, true)), "approval replay");
        model.Replies.Enqueue(Text("Created fixture"));
        var done = await service.TurnAsync(actor, new(first.ConversationId, ToolResults: [result], ContinuationToken: first.ContinuationToken), CancellationToken.None);
        Check(done.Reply == "Created fixture" && done.Actions.Single().Status == "completed", "authorized result completes");
        await RejectAsync(() => service.TurnAsync(actor, new(first.ConversationId, ToolResults: [result], ContinuationToken: first.ContinuationToken), CancellationToken.None), "continuation replay");
        Reject(() => conversations.Read("another-user", first.ConversationId), "cross-user history");
        Check(Directory.EnumerateFiles(Path.Combine(directory, "ask-spark-conversations"), "*.json", SearchOption.AllDirectories)
            .All(file => !File.ReadAllText(file).Contains("Create fixture", StringComparison.Ordinal)), "conversation encrypted on disk");
        model.Replies.Enqueue(Calls("write_fixture"));
        var denied = await service.TurnAsync(actor, new(Message: "Propose another fixture"), CancellationToken.None);
        var pending = denied.ToolCalls.Single();
        service.Confirm(actor, new(denied.ConversationId, pending.ApprovalToken!, false));
        model.Replies.Enqueue(Text("Declined"));
        var declined = await service.TurnAsync(actor, new(denied.ConversationId,
            ToolResults: [new(pending.Id, pending.Name, new JsonObject { ["ok"] = true })], ContinuationToken: denied.ContinuationToken), CancellationToken.None);
        Check(declined.Actions.Single().Status == "declined" && model.LastContents!.ToJsonString().Contains("user declined", StringComparison.Ordinal), "decline cannot be replaced by fabricated success");
    }

    private static async Task ParallelChecks(AskSparkService service, FakeModel model, AskSparkConversations conversations, SecurityUser actor)
    {
        model.Replies.Enqueue(Calls("read_fixture", "read_fixture"));
        var first = await service.TurnAsync(actor, new(Message: "Read two fixtures"), CancellationToken.None);
        Check(first.ToolCalls.Length == 2 && first.ToolCalls.All(call => call.Authorized && call.ParallelSafe), "all model function calls returned");
        var results = first.ToolCalls.Select(call => new AskSparkToolResult(call.Id, call.Name, new JsonObject { ["value"] = 7, ["password"] = "do-not-forward" })).ToArray();
        await RejectAsync(() => service.TurnAsync(actor, new(first.ConversationId, ToolResults: [results[0], results[0]], ContinuationToken: first.ContinuationToken), CancellationToken.None), "duplicate result IDs");
        model.Replies.Enqueue(Text("Both read"));
        await service.TurnAsync(actor, new(first.ConversationId, ToolResults: results.Reverse().ToArray(), ContinuationToken: first.ContinuationToken), CancellationToken.None);
        var history = model.LastContents!.ToJsonString();
        Check(history.Contains("thoughtSignature", StringComparison.Ordinal) && history.Contains("fixture-signature", StringComparison.Ordinal), "raw signed model parts preserved");
        Check(!history.Contains("do-not-forward", StringComparison.Ordinal), "known credential fields redacted in model results");
        var parts = model.LastContents.Last()!["parts"]!.AsArray();
        Check(parts[0]!["functionResponse"]!["id"]!.GetValue<string>() == "native-0" && parts[1]!["functionResponse"]!["id"]!.GetValue<string>() == "native-1", "parallel results replay in original call order");
        using (conversations.Enter(actor.Id, first.ConversationId))
            Reject(() => conversations.Enter(actor.Id, first.ConversationId), "concurrent turn lease");
    }

    private static async Task ProviderChecks(AskSparkSettings settings)
    {
        using var handler = new FixtureHandler();
        using var client = new HttpClient(handler);
        using var provider = new AskSparkGemini(client, settings);
        var reply = await provider.GenerateAsync(new JsonArray(AskSparkGemini.TextContent("user", "Read fixture")), [Tool("read_fixture", "read", false, true)], false, CancellationToken.None);
        Check(handler.Uri?.Host == "generativelanguage.googleapis.com" && !handler.Uri.AbsoluteUri.Contains("fixture.synthetic", StringComparison.Ordinal), "fixed provider origin and no URL credential");
        Check(handler.Key == FixtureApiKey && reply.Content["parts"] is JsonArray, "provider header preserves dotted credential and content parsed");
        Check(handler.Body!["tools"]![0]!["functionDeclarations"]![0]!["name"]!.GetValue<string>() == "read_fixture", "trusted declarations sent");
        Check(handler.Body["tools"]![0]!["functionDeclarations"]![0]!["parametersJsonSchema"] is JsonObject, "declarations use supported JSON Schema field");
        handler.Status = HttpStatusCode.Forbidden;
        await RejectAsync(() => provider.TestAsync(CancellationToken.None), "provider auth error");
    }

    private static void SchemaChecks()
    {
        var schema = Tool("read_fixture", "read", false, true).Parameters;
        AskSparkSchema.Validate(new JsonObject { ["label"] = "ok" }, schema);
        Reject(() => AskSparkSchema.Validate(new JsonObject { ["label"] = 42 }, schema), "wrong argument type");
        Reject(() => AskSparkSchema.Validate(new JsonObject { ["label"] = "ok", ["confirm"] = true }, schema), "model-invented confirmation argument");
        AskSparkSchema.Validate(new JsonObject { ["value"] = new JsonArray(new JsonObject { ["nested"] = true }) },
            new JsonObject { ["type"] = "object", ["properties"] = new JsonObject { ["value"] = new JsonObject() } });
        Check(true, "unconstrained section values accept arrays and objects for domain validation");
        var nullable = new JsonObject { ["type"] = "object", ["properties"] = new JsonObject { ["value"] = new JsonObject { ["type"] = new JsonArray("string", "null") } } };
        AskSparkSchema.Validate(new JsonObject { ["value"] = null }, nullable);
        Reject(() => AskSparkSchema.Validate(new JsonObject { ["value"] = 1 }, nullable), "union type mismatch");
        Reject(() => AskSparkGemini.ValidateAudio(new("not base64", "audio/webm")), "invalid audio");
        Reject(() => AskSparkData.MessageParts("image", [new("dGV4dA==", "image/png")]), "fake image signature");
        Reject(() => AskSparkData.MessageParts("image", [new(null!, "image/png")]), "missing image data");
    }

    private static async Task ContextChecks(AskSparkService service, FakeModel model, AskSparkConversations conversations, SecurityUser actor, string projectId)
    {
        var selected = new JsonObject { ["projectId"] = projectId, ["editorAvailable"] = true };
        model.Replies.Enqueue(Text("Project selected"));
        var first = await service.TurnAsync(actor, new(Message: "Inspect this project", Context: selected), CancellationToken.None);
        Check(conversations.Read(actor.Id, first.ConversationId).ProjectId == projectId, "selected project is bound to the turn");
        model.Replies.Enqueue(Text("Gateway context"));
        await service.TurnAsync(actor, new(first.ConversationId, "Inspect the gateway", new JsonObject { ["surface"] = "gateway" }), CancellationToken.None);
        Check(conversations.Read(actor.Id, first.ConversationId).ProjectId is null, "new gateway message clears prior project");
        Check(model.LastContents!.Last()!["parts"]![0]!["text"]!.GetValue<string>().Contains("\"projectId\":null", StringComparison.Ordinal), "model sees explicitly cleared project context");
        model.Replies.Enqueue(Calls("read_fixture"));
        var pending = await service.TurnAsync(actor, new(first.ConversationId, "Read this project", selected), CancellationToken.None);
        var result = new AskSparkToolResult(pending.ToolCalls[0].Id, pending.ToolCalls[0].Name, new JsonObject { ["ok"] = true });
        await RejectAsync(() => service.TurnAsync(actor, new(pending.ConversationId, Context: new JsonObject(), ToolResults: [result], ContinuationToken: pending.ContinuationToken), CancellationToken.None), "cleared context during pending project round");
        model.Replies.Enqueue(Text("Read completed"));
        await service.TurnAsync(actor, new(pending.ConversationId, ToolResults: [result], ContinuationToken: pending.ContinuationToken), CancellationToken.None);
        Check(conversations.Read(actor.Id, first.ConversationId).ProjectId == projectId, "continuation may omit unchanged project context");
        model.Replies.Enqueue(Text("No project"));
        await service.TurnAsync(actor, new(first.ConversationId, "A general question"), CancellationToken.None);
        Check(conversations.Read(actor.Id, first.ConversationId).ProjectId is null, "new message without context does not inherit a project");
    }

    private static void CorruptedHistoryChecks(AskSparkConversations conversations, SecurityUser actor, string directory)
    {
        var folder = Directory.GetDirectories(Path.Combine(directory, "ask-spark-conversations")).Single();
        var id = Guid.NewGuid().ToString("N");
        File.WriteAllText(Path.Combine(folder, id + ".json"), "{\"protectedConversation\":\"corrupted\"}");
        File.WriteAllText(Path.Combine(folder, "not-a-conversation.json"), "invalid");
        var summaries = conversations.List(actor.Id).Cast<AskSparkConversationSummary>().ToArray();
        Check(summaries.Single(item => item.Id == id).Unreadable && summaries.Any(item => !item.Unreadable), "one corrupt conversation does not block healthy history or its deletable identity");
        Check(summaries.Length <= 20 && summaries.All(item => item.Id.Length == 32), "history list is bounded and filters invalid filenames");
        conversations.Delete(actor.Id, id);
        Check(!conversations.List(actor.Id).Cast<AskSparkConversationSummary>().Any(item => item.Id == id), "unreadable conversation can be deleted");
    }

    private static void AuthoringChecks(ProjectStore store)
    {
        var before = store.GetProject().ToJsonString();
        var candidate = store.GetProject(); candidate["name"] = "Uncommitted validation";
        Check(store.ValidateAuthoringProject(candidate)["valid"]!.GetValue<bool>() && store.GetProject().ToJsonString() == before, "authoring validation does not persist");
        var query = JsonNode.Parse("""{"name":"Ask review","connectionId":"sample","sql":"SELECT 1 AS value","parameters":[]}""")!.AsObject();
        Check(store.ReviewQuery("ask-review")["fingerprint"]!.GetValue<string>() == "missing", "missing query has explicit review identity");
        store.SaveReviewedQuery("ask-review", query, "missing");
        Reject(() => store.SaveReviewedQuery("ask-review", query, "missing"), "stale create query fingerprint");
        var fingerprint = store.ReviewQuery("ask-review")["fingerprint"]!.GetValue<string>();
        query["name"] = "Updated ask review";
        store.SaveReviewedQuery("ask-review", query, fingerprint);
        Check(store.GetQuery("ask-review")["name"]!.GetValue<string>() == "Updated ask review", "reviewed update saved");
        Reject(() => store.DeleteReviewedQuery("ask-review", fingerprint), "stale query deletion");
        candidate = store.GetProject();
        candidate["screens"]![0]!["components"]!.AsArray().Add(JsonNode.Parse("""{"id":"ask-query-label","type":"label","x":0,"y":0,"width":100,"height":40,"props":{"text":"Query","queryBindings":{"text":{"queryId":"ask-review","column":"value"}}}}"""));
        store.SaveProject(candidate);
        var current = store.ReviewQuery("ask-review")["fingerprint"]!.GetValue<string>();
        Reject(() => store.DeleteReviewedQuery("ask-review", current), "deleting referenced query");
        Check(store.GetQuery("ask-review") is not null, "blocked deletion retains query");
    }

    private static async Task BackupChecks(string directory, IDataProtectionProvider protection)
    {
        var work = Path.Combine(directory, "backup-work"); Directory.CreateDirectory(work);
        var archive = Path.Combine(work, "ask-fixture.sparkbak");
        var report = await ConfigurationBackupSnapshot.CreateAsync(directory, archive, "Synthetic-Ask-Backup-Passphrase-123");
        Check(report.ExcludedPaths?.Contains("ask-spark-conversations/") == true, "configuration backup excludes private conversations");
        var restored = Path.Combine(directory, "restored-fixture");
        await GatewayRecovery.RestoreAsync(archive, restored, "Synthetic-Ask-Backup-Passphrase-123");
        var settings = new AskSparkSettings(restored, protection);
        Check(settings.Credentials().Key == FixtureApiKey && !Directory.Exists(Path.Combine(restored, "ask-spark-conversations")), "configuration restore retains protected AI settings without private chat history");
    }

    private static void PermissionChecks(SecurityStore security, SecurityUser admin, string projectId)
    {
        var engineer = security.CreateUser(new("ask-designer", "Synthetic-designer-12345", ProjectGrants: new() { [projectId] = new(Design: true) }));
        var read = Tool("read_project", "read", false, true) with { Permission = "read" };
        var draft = Tool("edit_draft", "draft", false, false) with { Permission = "design", Target = "designer" };
        var operate = Tool("operator_action", "write", true, false) with { Permission = "operate" };
        var adminOnly = Tool("admin_action", "write", true, false);
        var catalog = new AskSparkCatalog([read, draft, operate, adminOnly]);
        Check(catalog.Allowed(security, engineer, projectId, true).Where(tool => tool.Permission != "signedIn").Count() == 2, "project designer without operator grants only sees project read/draft capabilities");
        Check(catalog.Allowed(security, engineer, projectId, false).Single(tool => tool.Permission != "signedIn").Name == "read_project", "draft tools require active editor bridge");
        Check(catalog.Allowed(security, admin, projectId, true).Any(tool => tool.Permission == "operate"), "engineering administrator can discover runtime tests which still require a separate same-account operator session");
        Reject(() => catalog.Require("admin_action", new JsonObject { ["label"] = "fixture" }, security, engineer, projectId, true), "forged admin call");
        Check(new AskSparkCatalog().Allowed(security, admin, projectId, true).Length > 30, "embedded manifests are valid and loaded");
    }

    private static AskSparkTool Tool(string name, string kind, bool confirmation, bool parallelSafe) => new(name, "Synthetic fixture tool", new JsonObject
    {
        ["type"] = "object", ["properties"] = new JsonObject { ["label"] = new JsonObject { ["type"] = "string" } },
        ["required"] = new JsonArray("label"), ["additionalProperties"] = false
    }, "core", kind, "gateway", "admin", confirmation, parallelSafe);

    private static AskSparkModelReply Calls(params string[] names)
    {
        var parts = new JsonArray(names.Select((name, index) => (JsonNode)new JsonObject
        {
            ["thoughtSignature"] = "fixture-signature", ["functionCall"] = new JsonObject
            { ["id"] = "native-" + index, ["name"] = name, ["args"] = new JsonObject { ["label"] = "fixture" } }
        }).ToArray());
        return new(new JsonObject { ["role"] = "model", ["parts"] = parts }, 10);
    }

    private static AskSparkModelReply Text(string text) => new(AskSparkGemini.TextContent("model", text), 10);
    private static void Check(bool value, string message) { if (!value) throw new InvalidOperationException("Ask Spark: " + message); checks++; }
    private static void Reject(Action action, string message)
    {
        try { action(); } catch (Exception error) when (error is ArgumentException or BadHttpRequestException or KeyNotFoundException or InvalidOperationException) { checks++; return; }
        throw new InvalidOperationException("Ask Spark accepted " + message);
    }
    private static async Task RejectAsync(Func<Task> action, string message)
    {
        try { await action(); } catch (Exception error) when (error is ArgumentException or BadHttpRequestException or KeyNotFoundException) { checks++; return; }
        throw new InvalidOperationException("Ask Spark accepted " + message);
    }

    private sealed class FakeModel : IAskSparkModel
    {
        public Queue<AskSparkModelReply> Replies { get; } = new();
        public JsonArray? LastContents { get; private set; }
        public Task<AskSparkModelReply> GenerateAsync(JsonArray contents, IReadOnlyList<AskSparkTool> tools, bool finalAnswer, CancellationToken cancellation)
        { LastContents = contents.DeepClone().AsArray(); return Task.FromResult(Replies.Dequeue()); }
        public Task<string> TranscribeAsync(AskSparkAudioRequest audio, CancellationToken cancellation) => Task.FromResult("Fixture");
        public Task TestAsync(CancellationToken cancellation) => Task.CompletedTask;
    }

    private sealed class FixtureHandler : HttpMessageHandler
    {
        public Uri? Uri { get; private set; }
        public string? Key { get; private set; }
        public JsonObject? Body { get; private set; }
        public HttpStatusCode Status { get; set; } = HttpStatusCode.OK;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Uri = request.RequestUri; Key = request.Headers.GetValues("x-goog-api-key").Single();
            Body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject();
            return new(Status) { Content = new StringContent("{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"OK\"}]}}]}") };
        }
    }
}
