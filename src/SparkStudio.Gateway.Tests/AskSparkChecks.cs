using System.Net;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
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
            await RawLogChecks(directory, settings, protection);
            SchemaChecks();
            ContextProjectionChecks();
            ModelWorkspaceContextChecks();
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

    private static void ModelWorkspaceContextChecks()
    {
        var context = new JsonObject { ["modelView"] = "build", ["modelType"] = "CNC@2", ["modelDraftSummary"] = "2 types, 2 instances", ["modelSelection"] = new JsonArray("CNC01"), ["modelResolution"] = new JsonArray("CNC02: missing Speed"), ["password"] = "excluded" };
        var bounded = AskSparkContext.ModelWorkspace(context);
        Check(bounded["modelType"]!.GetValue<string>() == "CNC@2" && bounded.Count == 5 && bounded["password"] is null, "Model context retains only the five display fields");
        context["modelSelection"]!.AsArray().Add("CNC02");
        Check(bounded["modelSelection"]!.AsArray().Count == 1, "Model context lists are copied");
        Reject(() => AskSparkContext.ModelWorkspace(new() { ["modelView"] = new string('x', 513) }), "oversized model text");
        Reject(() => AskSparkContext.ModelWorkspace(new() { ["modelSelection"] = new JsonArray(1) }), "non-string model selection");
        Reject(() => AskSparkContext.ModelWorkspace(new() { ["modelResolution"] = new JsonArray(Enumerable.Range(0, 101).Select(_ => (JsonNode?)JsonValue.Create("x")).ToArray()) }), "oversized model resolution list");
    }

    private static void ContextProjectionChecks()
    {
        var tool = Tool("read_fixture", "read", false, true);
        var definition = JsonSerializer.SerializeToNode(tool, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        var contents = new JsonArray(
            new JsonObject { ["role"] = "model", ["parts"] = new JsonArray(new JsonObject
            { ["thoughtSignature"] = "fixture-signed-part", ["functionCall"] = new JsonObject { ["id"] = "discover-1", ["name"] = "find_tools", ["args"] = new JsonObject { ["query"] = "read_fixture" } } }) },
            new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject
            { ["functionResponse"] = new JsonObject { ["id"] = "discover-1", ["name"] = "find_tools", ["response"] = new JsonObject
                { ["result"] = new JsonObject { ["tools"] = new JsonArray(definition), ["total"] = 1, ["availableFrom"] = "next model round" } } } }) });
        var before = contents.ToJsonString();
        var projected = AskSparkContext.ForProvider(contents, [tool]);
        var response = projected[1]!["parts"]![0]!["functionResponse"]!;
        var compact = response["response"]!["result"]!["tools"]![0]!;
        Check(compact["parameters"] is null && compact["description"] is null && compact["definitionSource"] is not null
            && compact["name"]!.GetValue<string>() == tool.Name, "loaded discovery definitions are not repeated in provider history");
        Check(JsonNode.DeepEquals(projected[0], contents[0]) && response["id"]!.GetValue<string>() == "discover-1"
            && before == contents.ToJsonString(), "projection preserves signed model parts, call pairing and complete stored discovery results");
        Check(AskSparkContext.ForProvider(contents, []).ToJsonString() == before, "undeclared or final-answer tool definitions remain available in history");
        Check(AskSparkContext.ForProvider(contents, [tool with { Description = "Changed definition" }]).ToJsonString() == before,
            "a different current definition cannot silently replace the historical definition");
    }

    private static AskSparkSettings Settings(string directory, IDataProtectionProvider protection)
    {
        var settings = new AskSparkSettings(directory, protection);
        Check(settings.Snapshot().Model == "gemini-3.8-flash" && !settings.Snapshot().HasApiKey && settings.Snapshot().LoggingEnabled, "default model, empty key and enabled raw logging");
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
        try { await provider.TestAsync(CancellationToken.None); throw new InvalidOperationException("Ask Spark accepted provider auth error"); }
        catch (AskSparkProviderException error)
        {
            Check(error.Error.HttpStatus == 403 && !error.Error.Retryable, "provider auth error preserves structured access failure");
        }
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
        Check(report.ExcludedPaths?.Contains(AskSparkRawLog.DirectoryName + "/") == true, "configuration backup excludes raw provider exchange logs");
        Check(report.ExcludedPaths?.Contains("ask-spark-provider.log") == true, "configuration backup also excludes any retained legacy rolling log");
        var restored = Path.Combine(directory, "restored-fixture");
        await GatewayRecovery.RestoreAsync(archive, restored, "Synthetic-Ask-Backup-Passphrase-123");
        var settings = new AskSparkSettings(restored, protection);
        Check(settings.Credentials().Key == FixtureApiKey && !Directory.Exists(Path.Combine(restored, "ask-spark-conversations")), "configuration restore retains protected AI settings without private chat history");
        Check(!Directory.Exists(Path.Combine(restored, AskSparkRawLog.DirectoryName)) && !File.Exists(Path.Combine(restored, "ask-spark-provider.log")),
            "configuration restore includes neither per-exchange nor legacy provider payload logs");
    }

    private static async Task RawLogChecks(string directory, AskSparkSettings settings, IDataProtectionProvider protection)
    {
        using var log = new AskSparkRawLog(directory, settings);
        var legacyDirectory = Path.Combine(directory, "raw-log-legacy"); Directory.CreateDirectory(legacyDirectory);
        var legacy = JsonNode.Parse(File.ReadAllText(Path.Combine(directory, "ask-spark-settings.json")))!.AsObject();
        legacy.Remove("loggingEnabled");
        File.WriteAllText(Path.Combine(legacyDirectory, "ask-spark-settings.json"), legacy.ToJsonString());
        Check(new AskSparkSettings(legacyDirectory, protection).Snapshot().LoggingEnabled, "existing AI settings without a logging field default to enabled");
        var legacyLog = Path.Combine(directory, "ask-spark-provider.log");
        const string legacyContent = "Synthetic legacy rolling log: preserve this file unchanged.\n";
        File.WriteAllText(legacyLog, legacyContent);
        const string payload = " {\n  \"text\": \"Synthetic Ω image data and script output\",\n  \"inlineData\": \"YWJjZA==\"\n}\n";
        var started = DateTimeOffset.UtcNow;
        await log.WriteAsync("generateContent", "synthetic-exchange", "request", payload);
        await log.WriteAsync("generateContent", "synthetic-exchange", "response", "{\"text\":\"fixture response\"}", 200);
        var folder = Path.Combine(directory, AskSparkRawLog.DirectoryName);
        var path = Directory.GetFiles(folder, "*.txt").Single();
        var records = ReadRawLog(path);
        Check(records.Count == 2 && records[0].Body == payload, "one exchange file retains exact request whitespace, Unicode and base64 plus its reply");
        Check(records.All(record => record.Header["exchangeId"]!.GetValue<string>() == "synthetic-exchange")
            && records[0].Header["direction"]!.GetValue<string>() == "request"
            && records[1].Header["direction"]!.GetValue<string>() == "response"
            && records[1].Header["statusCode"]!.GetValue<int>() == 200, "request and status-bearing reply correlate in the same text file");
        RawLogFilenameCheck(path, "synthetic-exchange", started, DateTimeOffset.UtcNow);
        RawLogPermissionCheck(folder, path);
        await RawLogExistingPermissionsCheck(directory, settings);
        await log.WriteAsync("countTokens", "second-exchange", "request", "{\"synthetic\":true}");
        await log.WriteAsync("countTokens", "second-exchange", "response", "{\"totalTokens\":12}", 200);
        Check(Directory.GetFiles(folder, "*.txt").Length == 2 && ReadRawLog(path).Count == 2,
            "two exchanges create two files without mixing or appending to an earlier completed exchange");
        await RawLogDisabledChecks(log, directory, folder, path, settings, protection);
        await RawLogProviderHeadersCheck(log, folder, settings);
        var large = await RawLogLargeExchangeChecks(log, folder);
        await RawLogConcurrentChecks(log, folder);
        Check(large.Digest.SequenceEqual(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(large.Path))),
            "subsequent requests never trim, replace or delete earlier full exchange logs");
        Check(File.ReadAllText(legacyLog) == legacyContent, "per-exchange logging leaves the old rolling log untouched");
        var blocked = Path.Combine(directory, "raw-log-blocked"); Directory.CreateDirectory(blocked);
        var blockedFolder = Path.Combine(blocked, AskSparkRawLog.DirectoryName);
        File.WriteAllText(blockedFolder, "synthetic file blocks log directory creation");
        using var unavailable = new AskSparkRawLog(blocked, settings);
        await unavailable.WriteAsync("generateContent", "unwritable", "request", "fixture");
        Check(File.ReadAllText(blockedFolder) == "synthetic file blocks log directory creation", "filesystem logging failure does not fail the provider operation");
    }

    private static async Task RawLogDisabledChecks(AskSparkRawLog log, string directory, string folder, string path,
        AskSparkSettings settings, IDataProtectionProvider protection)
    {
        settings.Save(new(settings.Snapshot().Revision, true, AskSparkSettings.DefaultModel, LoggingEnabled: false));
        Check(!new AskSparkSettings(directory, protection).Snapshot().LoggingEnabled, "disabled raw logging persists");
        var before = File.ReadAllBytes(path);
        var fileCount = Directory.GetFiles(folder, "*.txt").Length;
        await log.WriteAsync("countTokens", "disabled", "request", "must not be logged");
        await log.WriteAsync("countTokens", "disabled", "response", "must not be logged", 200);
        Check(before.SequenceEqual(File.ReadAllBytes(path)) && Directory.GetFiles(folder, "*.txt").Length == fileCount,
            "disabled logging creates no exchange file and preserves existing logs");
        settings.Save(new(settings.Snapshot().Revision, true, AskSparkSettings.DefaultModel, LoggingEnabled: true));
        using var canceled = new CancellationTokenSource(); canceled.Cancel();
        await log.WriteAsync("generateContent", "canceled", "request", "not logged", cancellation: canceled.Token);
        Check(before.SequenceEqual(File.ReadAllBytes(path)) && Directory.GetFiles(folder, "*.txt").Length == fileCount,
            "canceled diagnostic writes do not fail the caller or create a file");
    }

    private static async Task RawLogExistingPermissionsCheck(string directory, AskSparkSettings settings)
    {
        var existing = Path.Combine(directory, "raw-log-existing");
        var folder = Path.Combine(existing, AskSparkRawLog.DirectoryName);
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "previous-exchange.txt");
        const string payload = "Previously captured exchange remains unchanged.";
        File.WriteAllText(path, payload);
        using var log = new AskSparkRawLog(existing, settings);
        await log.WriteAsync("generateContent", "upgraded", "request", "synthetic request");
        RawLogPermissionCheck(folder, path);
        Check(File.ReadAllText(path) == payload, "securing an existing log folder preserves historical exchange contents");
    }

    private static void RawLogPermissionCheck(string folder, string path)
    {
        if (OperatingSystem.IsWindows())
        {
            var identities = new[] { WindowsIdentity.GetCurrent().User!.Value,
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null).Value,
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null).Value }.ToHashSet(StringComparer.Ordinal);
            var directoryAcl = new DirectoryInfo(folder).GetAccessControl();
            var fileAcl = new FileInfo(path).GetAccessControl();
            foreach (var acl in new FileSystemSecurity[] { directoryAcl, fileAcl })
            {
                var rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToArray();
                Check(acl.AreAccessRulesProtected && rules.Length > 0 && rules.All(rule =>
                    rule.AccessControlType == AccessControlType.Allow && identities.Contains(rule.IdentityReference.Value)
                    && rule.FileSystemRights == FileSystemRights.FullControl), "provider logs allow only service identity, Administrators and SYSTEM");
            }
        }
        else
        {
            Check(File.GetUnixFileMode(folder) == (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
                && File.GetUnixFileMode(path) == (UnixFileMode.UserRead | UnixFileMode.UserWrite), "provider logs use private 0700 directories and 0600 files");
        }
    }

    private static async Task RawLogProviderHeadersCheck(AskSparkRawLog log, string folder, AskSparkSettings settings)
    {
        var before = Directory.GetFiles(folder, "*.txt").ToHashSet(StringComparer.Ordinal);
        using var handler = new FixtureHandler();
        using var client = new HttpClient(handler);
        using var provider = new AskSparkGemini(client, settings, rawLog: log);
        await provider.TestAsync(CancellationToken.None);
        var path = Directory.GetFiles(folder, "*.txt").Single(file => !before.Contains(file));
        var text = File.ReadAllText(path);
        Check(handler.Key == FixtureApiKey && ReadRawLog(path).Count == 2,
            "fake provider receives the authentication header while its actual request and reply bodies share a log file");
        Check(!text.Contains(FixtureApiKey, StringComparison.Ordinal)
            && !text.Contains("x-goog-api-key", StringComparison.OrdinalIgnoreCase)
            && !text.Contains("Authorization", StringComparison.OrdinalIgnoreCase), "provider traffic logs omit API keys and authentication headers");
    }

    private static async Task<(string Path, byte[] Digest)> RawLogLargeExchangeChecks(AskSparkRawLog log, string folder)
    {
        var request = " {\"image\":\"" + new string('A', 12 * 1024 * 1024 + 123) + "\",\"unicode\":\"Ω🙂\",\"tail\":\"retained\"}\n";
        var reply = "\n{\"text\":\"" + new string('r', 1_000_001) + "Ω\"}\n";
        var before = Directory.GetFiles(folder, "*.txt").Length;
        await log.WriteAsync("generateContent", "large-image-exchange", "request", request);
        await log.WriteAsync("generateContent", "large-image-exchange", "response", reply, 200);
        var path = Directory.GetFiles(folder, "*-large-image-exchange.txt").Single();
        var records = ReadRawLog(path);
        Check(Directory.GetFiles(folder, "*.txt").Length == before + 1 && records.Count == 2
            && records[0].Body == request && records[1].Body == reply,
            "a request larger than 12 MiB and its complete reply remain together without truncation");
        Check(new FileInfo(path).Length > 13_000_000 && records.All(record => record.Header["omittedBytes"]!.GetValue<int>() == 0
            && record.Header["bodyBytes"]!.GetValue<int>() == Encoding.UTF8.GetByteCount(record.Body)
            && record.Header["retainedBytes"]!.GetValue<int>() == Encoding.UTF8.GetByteCount(record.Body)),
            "per-exchange logs retain every UTF-8 payload byte without the former 10 MB cap");
        return (path, System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path)));
    }

    private static async Task RawLogConcurrentChecks(AskSparkRawLog log, string folder)
    {
        var before = Directory.GetFiles(folder, "*.txt").Length;
        var started = DateTimeOffset.UtcNow;
        await Task.WhenAll(Enumerable.Range(0, 20).Select(index => Task.Run(async () =>
        {
            var exchangeId = "parallel-" + index;
            await log.WriteAsync("cache.create", exchangeId, "request", "request-" + index);
            await Task.Yield();
            await log.WriteAsync("cache.create", exchangeId, "response", "reply-" + index, 200);
        })));
        var completed = DateTimeOffset.UtcNow;
        var files = Directory.GetFiles(folder, "*-parallel-*.txt");
        Check(files.Length == 20 && Directory.GetFiles(folder, "*.txt").Length == before + 20,
            "concurrent exchanges each create a unique timestamped file");
        for (var index = 0; index < 20; index++)
        {
            var exchangeId = "parallel-" + index;
            var path = Directory.GetFiles(folder, "*-" + exchangeId + ".txt").Single();
            var records = ReadRawLog(path);
            Check(records.Count == 2 && records[0].Body == "request-" + index && records[1].Body == "reply-" + index
                && records.All(record => record.Header["exchangeId"]!.GetValue<string>() == exchangeId),
                "interleaved requests and replies retain their own exchange correlation");
            RawLogFilenameCheck(path, exchangeId, started, completed);
        }
        await log.WriteAsync("cache.delete", "empty-exchange", "request", null);
        await log.WriteAsync("cache.delete", "empty-exchange", "response", null, 204);
        var empty = ReadRawLog(Directory.GetFiles(folder, "*-empty-exchange.txt").Single());
        Check(empty.Count == 2 && empty.All(record => record.Body.Length == 0)
            && empty[1].Header["statusCode"]!.GetValue<int>() == 204, "empty request and reply bodies still form a complete exchange file");
    }

    private static void RawLogFilenameCheck(string path, string exchangeId, DateTimeOffset started, DateTimeOffset completed)
    {
        var name = Path.GetFileName(path);
        Check(name.Length > 25 && name[24] == '-' && name.EndsWith("-" + exchangeId + ".txt", StringComparison.Ordinal)
            && DateTimeOffset.TryParseExact(name[..24], "yyyyMMdd'T'HHmmss.fffffff'Z'", System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out var timestamp)
            && timestamp.Offset == TimeSpan.Zero && timestamp >= started && timestamp <= completed,
            "exchange filename carries a precise UTC request timestamp and its unique exchange ID");
    }

    private static List<(JsonObject Header, string Body)> ReadRawLog(string path)
    {
        var data = File.ReadAllBytes(path);
        var records = new List<(JsonObject Header, string Body)>();
        var utf8 = new UTF8Encoding(false, true);
        var offset = 0;
        while (offset < data.Length)
        {
            var end = Array.IndexOf(data, (byte)'\n', offset);
            var line = utf8.GetString(data, offset, end - offset);
            if (!line.StartsWith("ASK_SPARK_RAW_V1 ", StringComparison.Ordinal)) throw new InvalidDataException("Invalid raw log fixture header.");
            var header = JsonNode.Parse(line["ASK_SPARK_RAW_V1 ".Length..])!.AsObject();
            var count = header["retainedBytes"]!.GetValue<int>();
            records.Add((header, utf8.GetString(data, end + 1, count)));
            offset = end + 1 + count + 1;
            if (data[offset - 1] != (byte)'\n') throw new InvalidDataException("Invalid raw log fixture frame.");
        }
        return records;
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
        ModelPermissionChecks(security, engineer, projectId);
    }

    private static void ModelPermissionChecks(SecurityStore security, SecurityUser engineer, string projectId)
    {
        var configurator = security.CreateUser(new("ask-config-only", "Synthetic-configuration-12345", GatewayCapabilities: new(Configuration: true)));
        var diagnostic = security.CreateUser(new("ask-diagnostic-only", "Synthetic-diagnostics-12345", GatewayCapabilities: new(Diagnostics: true)));
        var shipped = new AskSparkCatalog();
        var names = new[] { "model_types", "model_tree", "model_instances", "model_object" };
        var gateway = shipped.Allowed(security, configurator, null, false);
        Check(names.All(name => gateway.Any(tool => tool.Name == name)), "Configuration-only users can inspect models from the projectless workspace");
        Check(!gateway.Any(tool => tool.Name == "project_get"), "gateway model inspection grants no unrelated project read tools");
        foreach (var actor in new[] { engineer, diagnostic })
            Check(!shipped.Allowed(security, actor, null, false).Any(tool => names.Contains(tool.Name)), "projectless model inspection still requires Configuration permission");
        Check(!shipped.Allowed(security, configurator, projectId, false).Any(tool => names.Contains(tool.Name)), "Configuration permission does not replace Design for an explicit project context");
        Check(names.All(name => shipped.Allowed(security, engineer, projectId, false).Any(tool => tool.Name == name)), "project-scoped designers retain all model read tools without Configuration");
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
