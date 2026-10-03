using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using SparkStudio.Gateway;

internal static class AskSparkToolSearchChecks
{
    private static int checks;
    public static async Task<int> RunAsync()
    {
        checks = 0;
        using var fixture = new Fixture();
        CatalogChecks(fixture);
        SearchChecks(fixture);
        await DiscoveryChecks(fixture);
        await MixedChecks(fixture);
        await HiddenInvocationChecks(fixture);
        await UnloadedArgumentsChecks(fixture);
        await AssetRecoveryChecks(fixture);
        await RecoveryBatchChecks(fixture);
        await InvalidBatchChecks(fixture);
        await RecoveryLimitChecks(fixture);
        await RoundPolicyChecks(fixture);
        await ServerRoundLimitChecks(fixture);
        await RefilterChecks(fixture);
        await SessionChecks(fixture);
        return checks;
    }

    private static void CatalogChecks(Fixture fixture)
    {
        Check(fixture.Settings.Snapshot().ModelStepLimit == 100, "model step limit defaults to one hundred");
        var shipped = new AskSparkCatalog().Allowed(fixture.Security, fixture.Actor, fixture.Projects.DefaultId, true);
        var conversation = new AskSparkConversation { ProjectId = fixture.Projects.DefaultId };
        var loaded = AskSparkToolSearch.LoadForRound(conversation, shipped);
        Check(loaded.Length <= 9 && loaded.Any(tool => tool.Name == "find_tools"), "initial model has a bounded core of at most nine declarations");
        Check(!loaded.Any(tool => tool.Name == "connections_delete"), "hidden mutation schemas are not eagerly declared");
        conversation.ToolContext = new JsonObject { ["section"] = "connections" };
        loaded = AskSparkToolSearch.LoadForRound(conversation, shipped);
        Check(loaded.Any(tool => tool.Name == "connections_delete") && loaded.Any(tool => tool.Name == "mqtt_mapping_save"), "current connections pane loads connection and source categories");
        foreach (var section in new[] { "designer", "screens", "templates" })
        {
            var designer = new AskSparkConversation { ProjectId = fixture.Projects.DefaultId,
                ToolContext = new JsonObject { ["section"] = section, ["editorAvailable"] = true } };
            var designerTools = AskSparkToolSearch.LoadForRound(designer, shipped);
            Check(!designerTools.Any(tool => tool.Category == "assets"), section + " keeps asset tools available through discovery without preloading the category");
        }
        var directory = AskSparkToolSearch.Directory(shipped);
        Check(shipped.All(tool => directory.Contains(tool.Name + " [", StringComparison.Ordinal)), "directory names every allowed tool");
        Check(!directory.Contains("\"properties\"", StringComparison.Ordinal), "directory omits parameter schemas");
        var navigation = new AskSparkCatalog().Require("navigate_workspace", new JsonObject { ["destination"] = "designer", ["projectId"] = "other-project" }, fixture.Security, fixture.Actor, null, false);
        Check(navigation.Kind == "read", "pure local navigation links may name a different project without granting access to it");
    }

    private static void SearchChecks(Fixture fixture)
    {
        var conversation = new AskSparkConversation();
        var allowed = fixture.Catalog.Allowed(fixture.Security, fixture.Actor, null, false);
        Check(!AskSparkToolSearch.Directory(allowed).Contains("final important qualifier", StringComparison.Ordinal), "directory uses concise first-sentence summaries instead of full descriptions");
        var found = AskSparkToolSearch.Find(new JsonObject { ["query"] = "hidden_read" }, conversation, allowed);
        Check(found["tools"]!.AsArray().Count == 1 && found["total"]!.GetValue<int>() == 1,
            "exact-name discovery loads only the requested definition instead of unrelated fuzzy matches");
        var definition = found["tools"]![0]!.AsObject();
        Check(definition["description"]!.GetValue<string>() == Fixture.Description, "discovery preserves the complete long description");
        Check(JsonNode.DeepEquals(definition["parameters"], Tool("hidden_read", "remote").Parameters), "discovery preserves the entire parameter schema");
        Check(conversation.LoadedTools.Contains("hidden_read", StringComparer.Ordinal), "returned definitions become loaded names");
        var page = AskSparkToolSearch.Find(new JsonObject { ["query"] = "*", ["limit"] = 1 }, conversation, allowed);
        Check(page["tools"]!.AsArray().Count == 1 && page["nextOffset"]!.GetValue<int>() == 1, "discovery is bounded and has an exact continuation offset");
        Check(AskSparkToolSearch.Find(new JsonObject { ["query"] = "nonexistentquuxcapability" }, conversation, allowed)["tools"]!.AsArray().Count == 0, "unmatched search invents no capability");
        Reject(() => AskSparkToolSearch.Find(new JsonObject { ["query"] = " " }, conversation, allowed), "blank discovery search");
        Reject(() => AskSparkToolSearch.Find(new JsonObject { ["query"] = "*", ["limit"] = 9 }, conversation, allowed), "unbounded discovery count");
    }

    private static async Task DiscoveryChecks(Fixture fixture)
    {
        var model = new FakeModel();
        model.Replies.Enqueue(Calls(Call("find_tools", new JsonObject { ["query"] = "hidden_read" }, "native-discovery")));
        model.Replies.Enqueue(Calls(Call("hidden_read", id: "native-discovered")));
        var service = fixture.Service(model);
        var first = await service.TurnAsync(fixture.Actor, new(Message: "Find the remote read"), CancellationToken.None);
        Check(first.ToolCalls.Single().Name == "hidden_read", "discovery is handled on server and only subsequent client call reaches browser");
        Check(!model.Seen[0].Tools.Any(tool => tool.Name == "hidden_read") && model.Seen[1].Tools.Any(tool => tool.Name == "hidden_read"), "found schemas become available in the next round");
        var result = model.Seen[1].Contents.Last()!["parts"]![0]!["functionResponse"]!;
        Check(result["id"]!.GetValue<string>() == "native-discovery" && result["response"]!["result"]!["tools"]![0]!["description"]!.GetValue<string>() == Fixture.Description, "server result preserves native ID and full definition");
        Check(model.Seen[1].Contents.ToJsonString().Contains("synthetic-thought-signature", StringComparison.Ordinal), "discovery preserves signed provider parts");
        Check(model.Seen[0].Context!.ToolDirectory.Contains("hidden_read", StringComparison.Ordinal), "model context provides the permission-filtered tool directory");
        Check(model.Seen[0].Context!.CacheScope.Length == 64 && !model.Seen[0].Context!.CacheScope.Contains(fixture.Actor.Id, StringComparison.Ordinal), "model cache scope is opaque");
        model.Replies.Enqueue(Text("Read complete"));
        await Continue(service, fixture.Actor, first);
        model.Replies.Enqueue(Calls(Call("hidden_read")));
        var next = await service.TurnAsync(fixture.Actor, new(first.ConversationId, Message: "Read again"), CancellationToken.None);
        Check(next.ToolCalls.Single().Name == "hidden_read", "loaded tools persist across messages in the same conversation");
    }

    private static async Task MixedChecks(Fixture fixture)
    {
        var model = new FakeModel();
        model.Replies.Enqueue(Calls(Call("find_tools", new JsonObject { ["query"] = "hidden_read" }, "native-find"), Call("write_core", id: "native-write")));
        var service = fixture.Service(model);
        var turn = await service.TurnAsync(fixture.Actor, new(Message: "Find and propose"), CancellationToken.None);
        var call = turn.ToolCalls.Single();
        Check(call.Name == "write_core" && call.Confirmation && !call.Authorized, "mixed discovery retains exact client approval requirements");
        await RejectAsync(() => Continue(service, fixture.Actor, turn), "unapproved mixed result");
        service.Confirm(fixture.Actor, new(turn.ConversationId, call.ApprovalToken!, true));
        var pending = fixture.Conversations.Read(fixture.Actor.Id, turn.ConversationId).Pending;
        Check(pending.Length == 2 && pending[0].ServerHandled, "mixed pending round retains trusted server receipt separately");
        await RejectAsync(() => service.TurnAsync(fixture.Actor, new(turn.ConversationId, ToolResults:
            [new(call.Id, call.Name, new JsonObject()), new(pending[0].Call.Id, "find_tools", new JsonObject())], ContinuationToken: turn.ContinuationToken), CancellationToken.None), "client cannot supply a forged discovery receipt");
        model.Replies.Enqueue(Text("Done"));
        await Continue(service, fixture.Actor, turn);
        var parts = model.Seen.Last().Contents.Last()!["parts"]!.AsArray();
        Check(parts.Count == 2 && parts[0]!["functionResponse"]!["id"]!.GetValue<string>() == "native-find"
            && parts[1]!["functionResponse"]!["id"]!.GetValue<string>() == "native-write", "mixed receipts retain the model call order and native identifiers");
    }

    private static async Task HiddenInvocationChecks(Fixture fixture)
    {
        var direct = new FakeModel();
        direct.Replies.Enqueue(Calls(Call("hidden_read", new JsonObject(), "native-unloaded")));
        direct.Replies.Enqueue(Calls(Call("find_tools", new JsonObject { ["query"] = "hidden_read" }, "native-recovery-find")));
        direct.Replies.Enqueue(Calls(Call("hidden_read", id: "native-retry")));
        var service = fixture.Service(direct);
        var recovered = await service.TurnAsync(fixture.Actor, new(Message: "Recover an undeclared read"), CancellationToken.None);
        Check(recovered.ToolCalls.Single().Name == "hidden_read" && direct.Seen.Count == 3, "undeclared authorized call automatically continues through discovery to a fresh invocation");
        Check(!direct.Seen[1].Tools.Any(tool => tool.Name == "hidden_read") && direct.Seen[2].Tools.Any(tool => tool.Name == "hidden_read"), "recovery never loads a definition before successful explicit discovery");
        var response = Responses(direct.Seen[1]).Single();
        Check(response["id"]!.GetValue<string>() == "native-unloaded" && RecoveryResult(response, "hidden_read"), "unloaded invocation with missing arguments returns a paired native-ID receipt with discovery instructions");
        Check(direct.Seen[1].Contents.ToJsonString().Contains("synthetic-thought-signature", StringComparison.Ordinal), "recovery preserves the provider thought signature");
        var pending = fixture.Conversations.Read(fixture.Actor.Id, recovered.ConversationId).Pending.Single();
        Check(pending.NativeId == "native-retry" && pending.Call.Authorized, "only the newly declared retry is authorized for client execution");
        direct.Replies.Enqueue(Text("Recovered read complete"));
        var completed = await Continue(service, fixture.Actor, recovered);
        Check(completed.Reply == "Recovered read complete", "recovered read completes through the normal client receipt path");
        var mixed = new FakeModel();
        mixed.Replies.Enqueue(Calls(Call("find_tools", new JsonObject { ["query"] = "hidden_read" }, "native-too-early-find"), Call("hidden_read", id: "native-too-early-read")));
        mixed.Replies.Enqueue(Text("I must discover before invoking"));
        var deferred = await fixture.Service(mixed).TurnAsync(fixture.Actor, new(Message: "Discover and invoke too early"), CancellationToken.None);
        Check(deferred.ToolCalls.Length == 0 && !mixed.Seen[1].Tools.Any(tool => tool.Name == "hidden_read"), "same-round discovery and invocation executes neither call and loads nothing");
        var receipts = Responses(mixed.Seen[1]);
        Check(receipts.Length == 2 && receipts[0]["id"]!.GetValue<string>() == "native-too-early-find"
            && receipts[1]["id"]!.GetValue<string>() == "native-too-early-read" && receipts.All(item => RecoveryResult(item, "hidden_read")), "same-round discovery failure pairs every receipt in original native-ID order");
        var excessive = new FakeModel(); excessive.Replies.Enqueue(Calls(Enumerable.Range(0, 17).Select(index => Call("read_core", id: "call-" + index)).ToArray()));
        await RejectAsync(() => fixture.Service(excessive).TurnAsync(fixture.Actor, new(Message: "Too many calls"), CancellationToken.None), "per-response sixteen-call bound");
    }

    private static async Task RecoveryBatchChecks(Fixture fixture)
    {
        var model = new FakeModel();
        model.Replies.Enqueue(Calls(Call("write_core", id: "native-deferred-write"), Call("hidden_read", id: "native-deferred-read")));
        model.Replies.Enqueue(Text("Inspect before proposing the write again"));
        var turn = await fixture.Service(model).TurnAsync(fixture.Actor, new(Message: "Batch a loaded write and an undeclared read"), CancellationToken.None);
        Check(turn.ToolCalls.Length == 0 && turn.ContinuationToken is null, "loaded mutation is not offered for approval or execution when its batch contains an undeclared call");
        var receipts = Responses(model.Seen[1]);
        Check(receipts.Length == 2 && receipts[0]["name"]!.GetValue<string>() == "write_core"
            && receipts[0]["id"]!.GetValue<string>() == "native-deferred-write" && receipts[1]["id"]!.GetValue<string>() == "native-deferred-read"
            && receipts.All(item => RecoveryResult(item, "hidden_read")), "mixed recovery states that neither the loaded write nor undeclared read executed");
        var saved = fixture.Conversations.Read(fixture.Actor.Id, turn.ConversationId);
        Check(saved.Pending.Length == 0 && saved.ContinuationToken is null && saved.Actions.Count == 2
            && saved.Actions.All(action => action.Status == "error"), "recovery leaves no approval token or pending calls and records both actions as errors");
    }

    private static async Task UnloadedArgumentsChecks(Fixture fixture)
    {
        var model = new FakeModel();
        model.Replies.Enqueue(Calls(Call("hidden_read", new JsonObject { ["label"] = 7 }, "native-unseen-schema")));
        model.Replies.Enqueue(Text("Load the declaration before supplying arguments"));
        var turn = await fixture.Service(model).TurnAsync(fixture.Actor, new(Message: "Recover arguments for an unseen tool"), CancellationToken.None);
        Check(turn.ToolCalls.Length == 0 && model.Seen.Count == 2 && RecoveryResult(Responses(model.Seen[1]).Single(), "hidden_read"),
            "an undeclared allowed tool with wrong argument types can discover its schema without executing the invalid call");
    }

    private static async Task AssetRecoveryChecks(Fixture fixture)
    {
        var model = new FakeModel();
        model.Replies.Enqueue(Calls(Call("assets_list", new JsonObject(), "native-assets-unloaded")));
        model.Replies.Enqueue(Calls(Call("find_tools", new JsonObject { ["query"] = "assets_list", ["limit"] = 1 }, "native-assets-discovery")));
        model.Replies.Enqueue(Calls(Call("assets_list", new JsonObject(), "native-assets-retry")));
        var service = new AskSparkService(fixture.Settings, fixture.Conversations, new AskSparkCatalog(), model, fixture.Security, fixture.Projects);
        var turn = await service.TurnAsync(fixture.Actor, new(Message: "Reuse project images in this screen", Context: new JsonObject
            { ["projectId"] = fixture.Projects.DefaultId, ["editorAvailable"] = true, ["section"] = "designer" }), CancellationToken.None);
        Check(turn.ToolCalls.Single().Name == "assets_list" && model.Seen.Count == 3
            && !model.Seen[0].Tools.Any(tool => tool.Name == "assets_list") && model.Seen[2].Tools.Any(tool => tool.Name == "assets_list"),
            "real Designer asset inspection recovers by discovery rather than enlarging the initial tool set");
        Check(RecoveryResult(Responses(model.Seen[1]).Single(), "assets_list")
            && !model.Seen[2].Tools.Any(tool => tool.Name == "assets_upload"), "exact asset lookup reports the missing tool and does not load unrelated asset mutations");
    }

    private static async Task InvalidBatchChecks(Fixture fixture)
    {
        foreach (var invalid in new[] { Call("unknown_tool"), Call("write_core", new JsonObject { ["label"] = 7 }) })
        {
            var model = new FakeModel();
            model.Replies.Enqueue(Calls(Call("find_tools", new JsonObject { ["query"] = "hidden_read" }, "native-rejected-find"), Call("write_core", id: "native-rejected-write"), invalid));
            await RejectAsync(() => fixture.Service(model).TurnAsync(fixture.Actor, new(Message: "Reject the whole invalid batch"), CancellationToken.None), "unknown tool or malformed loaded tool");
            Check(model.Seen.Count == 1, "unknown tools and malformed loaded calls cannot trigger automatic recovery or further provider rounds");
        }
        var engineer = fixture.Security.CreateUser(new("recovery-engineer", "Synthetic-recovery-password-123", ProjectGrants: new() { [fixture.Projects.DefaultId] = new(Design: true) }));
        var unauthorized = new FakeModel();
        unauthorized.Replies.Enqueue(Calls(Call("find_tools", new JsonObject { ["query"] = "hidden_read" }, "native-forbidden-find"), Call("hidden_read", id: "native-forbidden-read")));
        await RejectAsync(() => fixture.Service(unauthorized).TurnAsync(engineer, new(Message: "Recover a forbidden read",
            Context: new JsonObject { ["projectId"] = fixture.Projects.DefaultId, ["editorAvailable"] = true }), CancellationToken.None), "unauthorized undeclared tool");
        Check(unauthorized.Seen.Count == 1, "permission rejection never becomes a discovery recovery round");
    }

    private static async Task RecoveryLimitChecks(Fixture fixture)
    {
        try
        {
            foreach (var stepLimit in new[] { 100, 1 })
            {
                fixture.Settings.Save(new(fixture.Settings.Snapshot().Revision, true, AskSparkSettings.DefaultModel, ModelStepLimit: stepLimit));
                var attempts = Math.Min(3, stepLimit);
                var model = new FakeModel();
                for (var index = 0; index < attempts; index++) model.Replies.Enqueue(Calls(Call("hidden_read", id: "native-repeated-" + index)));
                model.Replies.Enqueue(Text("Unable to recover this request"));
                var turn = await fixture.Service(model).TurnAsync(fixture.Actor, new(Message: "Repeated undeclared calls"), CancellationToken.None);
                Check(turn.ToolCalls.Length == 0 && turn.Reply == "Unable to recover this request" && model.Seen.Count == attempts + 1,
                    "repeated recovery stops after three attempts or the smaller configured step budget and receives a final answer round");
                Check(model.Seen.Take(attempts).All(round => !round.FinalAnswer) && model.Seen[attempts].FinalAnswer
                    && model.Seen.All(round => !round.Tools.Any(tool => tool.Name == "hidden_read")), "recovery cannot bypass either limit or silently load repeated tool names");
                var saved = fixture.Conversations.Read(fixture.Actor.Id, turn.ConversationId);
                Check(saved.Calls == attempts && saved.Pending.Length == 0 && saved.Actions.Count == attempts && saved.Actions.All(action => action.Status == "error"),
                    "unexecuted recovery attempts count toward the bounded conversation and remain recorded as errors");
            }
        }
        finally { fixture.Settings.Save(new(fixture.Settings.Snapshot().Revision, true, AskSparkSettings.DefaultModel)); }
    }

    private static async Task RoundPolicyChecks(Fixture fixture)
    {
        fixture.Settings.Save(new(fixture.Settings.Snapshot().Revision, true, AskSparkSettings.DefaultModel, ModelStepLimit: 20));
        var model = new FakeModel();
        for (var round = 0; round < 20; round++)
            model.Replies.Enqueue(Calls(Enumerable.Range(0, 6).Select(index => Call("read_core", id: "round-" + round + "-call-" + index)).ToArray()));
        model.Replies.Enqueue(Text("Final answer after twenty tool rounds"));
        var service = fixture.Service(model);
        var turn = await service.TurnAsync(fixture.Actor, new(Message: "Run bounded rounds"), CancellationToken.None);
        fixture.Settings.Save(new(fixture.Settings.Snapshot().Revision, true, AskSparkSettings.DefaultModel, ModelStepLimit: 1));
        for (var round = 0; round < 20; round++)
        {
            Check(turn.ToolCalls.Length == 6, "tool round " + (round + 1) + " remains available despite aggregate calls or tokens");
            turn = await Continue(service, fixture.Actor, turn);
        }
        Check(turn.ToolCalls.Length == 0 && turn.Reply == "Final answer after twenty tool rounds", "twenty-first response is allowed to answer");
        Check(model.Seen.Count == 21 && model.Seen.Take(20).All(item => !item.FinalAnswer) && model.Seen[20].FinalAnswer, "only the twenty-first response is forced tool-free");
        var saved = fixture.Conversations.Read(fixture.Actor.Id, turn.ConversationId);
        Check(saved.Calls == 120 && saved.Tokens > 160_000, "old aggregate call and message token ceilings are removed");
        Check(saved.StepLimit == 20, "message snapshots its configured limit even when settings change mid-message");
    }

    private static async Task ServerRoundLimitChecks(Fixture fixture)
    {
        var model = new FakeModel();
        model.Replies.Enqueue(Calls(Call("find_tools", new JsonObject { ["query"] = "hidden_read" })));
        model.Replies.Enqueue(Text("Discovery reached the configured step limit"));
        var turn = await fixture.Service(model).TurnAsync(fixture.Actor, new(Message: "One configured step"), CancellationToken.None);
        Check(turn.ToolCalls.Length == 0 && model.Seen.Count == 2 && model.Seen[1].FinalAnswer, "server discovery counts toward configured tool steps and receives a final answer round");
        Check(fixture.Conversations.Read(fixture.Actor.Id, turn.ConversationId).StepLimit == 1, "next message picks up the new configured limit");
        fixture.Settings.Save(new(fixture.Settings.Snapshot().Revision, true, AskSparkSettings.DefaultModel));
    }

    private static async Task RefilterChecks(Fixture fixture)
    {
        var engineer = fixture.Security.CreateUser(new("search-engineer", "Synthetic-engineer-password-123", ProjectGrants: new() { [fixture.Projects.DefaultId] = new(Design: true) }));
        var allowed = fixture.Catalog.Allowed(fixture.Security, engineer, fixture.Projects.DefaultId, true);
        Check(!AskSparkToolSearch.Directory(allowed).Contains("hidden_read", StringComparison.Ordinal), "directory never advertises forbidden admin tools");
        Check(!AskSparkToolSearch.Find(new JsonObject { ["query"] = "hidden_read" }, new(), allowed)["tools"]!.AsArray()
            .Any(tool => tool?["name"]?.GetValue<string>() == "hidden_read"), "search cannot reveal forbidden definitions");
        var conversation = new AskSparkConversation { ProjectId = fixture.Projects.DefaultId, LoadedTools = ["designer_hidden", "hidden_read"] };
        var loaded = AskSparkToolSearch.LoadForRound(conversation, allowed);
        Check(loaded.Any(tool => tool.Name == "designer_hidden") && !loaded.Any(tool => tool.Name == "hidden_read"), "persisted names are rechecked against current role");
        loaded = AskSparkToolSearch.LoadForRound(conversation, fixture.Catalog.Allowed(fixture.Security, engineer, fixture.Projects.DefaultId, false));
        Check(!loaded.Any(tool => tool.Name == "designer_hidden"), "inactive editor removes previously discovered designer tools");
        var model = new FakeModel(); model.Replies.Enqueue(Calls(Call("designer_hidden"))); model.Replies.Enqueue(Text("Discover the Designer tool first"));
        var recovered = await fixture.Service(model).TurnAsync(engineer, new(Message: "Undiscovered designer call", Context: new JsonObject { ["projectId"] = fixture.Projects.DefaultId, ["editorAvailable"] = true }), CancellationToken.None);
        Check(recovered.ToolCalls.Length == 0 && model.Seen.Count == 2 && RecoveryResult(Responses(model.Seen[1]).Single(), "designer_hidden"), "allowed but unloaded designer call can recover without granting broader permissions");
        var scope = AskSparkToolSearch.Scope(fixture.Actor, conversation);
        conversation.ToolContext["section"] = "connections";
        Check(scope != AskSparkToolSearch.Scope(fixture.Actor, conversation), "page change separates model cache scope");
        Check(scope != AskSparkToolSearch.Scope(engineer, conversation), "identity separates model cache scope");
    }

    private static async Task SessionChecks(Fixture fixture)
    {
        var valid = true;
        var model = new FakeModel { AfterGenerate = () => valid = false };
        model.Replies.Enqueue(Calls(Call("find_tools", new JsonObject { ["query"] = "hidden_read" })));
        await RejectAsync(() => fixture.Service(model).TurnAsync(fixture.Actor, new(Message: "Revoke during discovery"), CancellationToken.None, () => valid), "session change before server discovery execution");
        Check(model.Seen.Count == 1, "revoked session cannot trigger another discovery/model round");
    }

    private static Task<AskSparkTurnResponse> Continue(AskSparkService service, SecurityUser actor, AskSparkTurnResponse turn)
        => service.TurnAsync(actor, new(turn.ConversationId, ToolResults: turn.ToolCalls.Select(call => new AskSparkToolResult(call.Id, call.Name, new JsonObject { ["ok"] = true })).ToArray(),
            ContinuationToken: turn.ContinuationToken), CancellationToken.None);
    private static JsonObject[] Responses(SeenRound round)
        => round.Contents.Last()!["parts"]!.AsArray().Select(part => part!["functionResponse"]!.AsObject()).ToArray();
    private static bool RecoveryResult(JsonObject response, string requiredTool)
    {
        if (response["response"]?["result"] is not JsonObject result) return false;
        return result["code"]?.GetValue<string>() == "tool_not_loaded" && result["executed"]?.GetValue<bool>() == false
            && result["error"]?.GetValue<string>() is { Length: > 0 }
            && result["requiredTools"]!.AsArray().Any(name => name?.GetValue<string>() == requiredTool)
            && result["nextStep"]?["tool"]?.GetValue<string>() == "find_tools";
    }
    private static AskSparkTool Tool(string name, string category, string target = "gateway", string permission = "admin", bool write = false)
        => new(name, Fixture.Description, new JsonObject { ["type"] = "object", ["properties"] = new JsonObject { ["label"] = new JsonObject { ["type"] = "string", ["description"] = "Complete nested argument guidance." } },
            ["required"] = new JsonArray("label"), ["additionalProperties"] = false }, category, write ? "write" : "read", target, permission, write, !write);
    private static JsonObject Call(string name, JsonObject? args = null, string id = "native-call") => new()
    {
        ["thoughtSignature"] = "synthetic-thought-signature", ["functionCall"] = new JsonObject
        { ["id"] = id, ["name"] = name, ["args"] = args ?? new JsonObject { ["label"] = "fixture" } }
    };
    private static AskSparkModelReply Calls(params JsonObject[] calls) => new(new JsonObject { ["role"] = "model", ["parts"] = new JsonArray(calls.Select(call => (JsonNode)call).ToArray()) }, 200_000);
    private static AskSparkModelReply Text(string text) => new(AskSparkGemini.TextContent("model", text), 200_000);
    private static void Check(bool condition, string description) { if (!condition) throw new InvalidOperationException("Tool discovery: " + description); checks++; }
    private static void Reject(Action action, string description)
    {
        try { action(); } catch (Exception error) when (error is ArgumentException or BadHttpRequestException) { checks++; return; }
        throw new InvalidOperationException("Tool discovery accepted " + description);
    }
    private static async Task RejectAsync(Func<Task> action, string description)
    {
        try { await action(); } catch (Exception error) when (error is ArgumentException or BadHttpRequestException) { checks++; return; }
        throw new InvalidOperationException("Tool discovery accepted " + description);
    }

    private sealed class Fixture : IDisposable
    {
        public const string Description = "Complete fixture description with all prerequisite and effect details. Discovery must preserve this sentence and its final important qualifier; it must never abbreviate the declaration.";
        private readonly string directory = Path.Combine(Path.GetTempPath(), "SparkStudio.AskSparkDiscovery." + Guid.NewGuid().ToString("N"));
        public SecurityStore Security { get; }
        public SecurityUser Actor { get; }
        public ProjectCatalog Projects { get; }
        public AskSparkConversations Conversations { get; }
        public AskSparkCatalog Catalog { get; }
        public AskSparkSettings Settings { get; }
        public Fixture()
        {
            Directory.CreateDirectory(directory);
            var protection = new EphemeralDataProtectionProvider();
            Settings = new(directory, protection);
            Settings.Save(new("0", true, AskSparkSettings.DefaultModel, ApiKey: "synthetic-discovery-key"));
            Security = new(directory);
            Actor = Security.Setup(File.ReadAllText(Path.Combine(directory, "security", "setup-code.txt")).Trim(), new("discovery-admin", "Synthetic-discovery-password-123"));
            Projects = new(directory, protection); Conversations = new(directory, protection);
            Catalog = new([Tool("read_core", "core"), Tool("write_core", "core", write: true), Tool("hidden_read", "remote"),
                Tool("designer_hidden", "remote", "designer", "design")]);
        }
        public AskSparkService Service(FakeModel model) => new(Settings, Conversations, Catalog, model, Security, Projects);
        public void Dispose() { Security.Dispose(); Directory.Delete(directory, true); }
    }

    private sealed record SeenRound(JsonArray Contents, AskSparkTool[] Tools, bool FinalAnswer, AskSparkModelContext? Context);
    private sealed class FakeModel : IAskSparkModel
    {
        public Queue<AskSparkModelReply> Replies { get; } = new();
        public List<SeenRound> Seen { get; } = [];
        public Action? AfterGenerate { get; init; }
        public Task<AskSparkModelReply> GenerateAsync(JsonArray contents, IReadOnlyList<AskSparkTool> tools, bool finalAnswer, CancellationToken cancellation)
            => GenerateAsync(contents, tools, finalAnswer, null, cancellation);
        public Task<AskSparkModelReply> GenerateAsync(JsonArray contents, IReadOnlyList<AskSparkTool> tools, bool finalAnswer, AskSparkModelContext? context, CancellationToken cancellation)
        {
            Seen.Add(new(contents.DeepClone().AsArray(), tools.ToArray(), finalAnswer, context));
            AfterGenerate?.Invoke();
            return Task.FromResult(Replies.Dequeue());
        }
        public Task<string> TranscribeAsync(AskSparkAudioRequest audio, CancellationToken cancellation) => Task.FromResult("Fixture");
        public Task TestAsync(CancellationToken cancellation) => Task.CompletedTask;
    }
}
