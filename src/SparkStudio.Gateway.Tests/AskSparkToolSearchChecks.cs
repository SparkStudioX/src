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
        var direct = new FakeModel(); direct.Replies.Enqueue(Calls(Call("hidden_read")));
        await RejectAsync(() => fixture.Service(direct).TurnAsync(fixture.Actor, new(Message: "Bypass discovery"), CancellationToken.None), "undeclared tool invocation");
        var mixed = new FakeModel();
        mixed.Replies.Enqueue(Calls(Call("find_tools", new JsonObject { ["query"] = "hidden_read" }), Call("hidden_read")));
        await RejectAsync(() => fixture.Service(mixed).TurnAsync(fixture.Actor, new(Message: "Discover and invoke too early"), CancellationToken.None), "newly discovered tool cannot be invoked in the same response");
        var excessive = new FakeModel(); excessive.Replies.Enqueue(Calls(Enumerable.Range(0, 17).Select(index => Call("read_core", id: "call-" + index)).ToArray()));
        await RejectAsync(() => fixture.Service(excessive).TurnAsync(fixture.Actor, new(Message: "Too many calls"), CancellationToken.None), "per-response sixteen-call bound");
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
        var model = new FakeModel(); model.Replies.Enqueue(Calls(Call("designer_hidden")));
        await RejectAsync(() => fixture.Service(model).TurnAsync(engineer, new(Message: "Undiscovered designer call", Context: new JsonObject { ["projectId"] = fixture.Projects.DefaultId, ["editorAvailable"] = true }), CancellationToken.None), "allowed but unloaded designer call");
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
