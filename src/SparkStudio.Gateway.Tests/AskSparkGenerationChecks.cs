using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using SparkStudio.Gateway;

internal static class AskSparkGenerationChecks
{
    private static int checks;

    public static async Task<int> RunAsync()
    {
        checks = 0;
        using var fixture = new Fixture();
        await ProviderStatusChecks(fixture);
        await RepairChecks(fixture);
        await AcceptedHistoryChecks(fixture);
        await TruncatedTextChecks(fixture);
        await RepeatedFailureChecks(fixture);
        await StepLimitChecks(fixture);
        await FinalAnswerFailureChecks(fixture);
        await BlockedStatusChecks(fixture);
        await EmptyReplyChecks(fixture);
        await ProseChecks(fixture);
        return checks;
    }

    private static async Task ProviderStatusChecks(Fixture fixture)
    {
        using var handler = new FixtureHandler();
        using var client = new HttpClient(handler);
        using var provider = new AskSparkGemini(client, fixture.Settings);
        foreach (var reason in new[] { "MALFORMED_FUNCTION_CALL", "MAX_TOKENS", "SAFETY", "STOP" })
        {
            handler.Candidate = new JsonObject { ["finishReason"] = reason };
            var reply = await provider.GenerateAsync(new JsonArray(AskSparkGemini.TextContent("user", "Inspect a synthetic screen")),
                [], false, CancellationToken.None);
            Check(reply.FinishReason == reason && reply.Content["parts"] is JsonArray,
                "provider finish status survives absent content: " + reason);
        }
        var signed = CallContent("write_fixture", "provider-call", "provider-signature");
        handler.Candidate = new JsonObject { ["finishReason"] = "MALFORMED_FUNCTION_CALL", ["content"] = signed.DeepClone() };
        var partial = await provider.GenerateAsync(new JsonArray(AskSparkGemini.TextContent("user", "Create synthetic controls")),
            [], false, CancellationToken.None);
        Check(partial.FinishReason == "MALFORMED_FUNCTION_CALL" && JsonNode.DeepEquals(partial.Content, signed),
            "provider exposes malformed status without rewriting signed candidate content");
        Check(partial.Usage is { PromptTokens: 10, OutputTokens: 2, TotalTokens: 12 },
            "failed generation still reports provider token usage");
        handler.Candidate = null;
        var missing = await provider.GenerateAsync(new JsonArray(AskSparkGemini.TextContent("user", "Synthetic missing candidate")),
            [], false, CancellationToken.None);
        Check(missing.FinishReason == "EMPTY_RESPONSE" && missing.Content["parts"] is JsonArray,
            "missing provider candidate has explicit empty-response status");
        handler.PromptBlockReason = "SAFETY";
        var blocked = await provider.GenerateAsync(new JsonArray(AskSparkGemini.TextContent("user", "Synthetic blocked fixture")),
            [], false, CancellationToken.None);
        Check(blocked.FinishReason == "BLOCKED_PROMPT", "prompt-level blocking is distinct from retryable empty output");
    }

    private static async Task RepairChecks(Fixture fixture)
    {
        var model = new FakeModel();
        model.Replies.Enqueue(Call("write_fixture", "failed-call", "failed-signature", "MALFORMED_FUNCTION_CALL"));
        model.Replies.Enqueue(Call("write_fixture", "repaired-call", "repaired-signature"));
        var service = fixture.Service(model);
        var turn = await service.TurnAsync(fixture.Actor, new(Message: "Add the requested controls"), CancellationToken.None);
        var call = turn.ToolCalls.Single();
        Check(model.Seen.Count == 2 && call.Name == "write_fixture" && call.Confirmation && !call.Authorized,
            "malformed candidate is retried before any approval or browser execution is offered");
        var saved = fixture.Conversations.Read(fixture.Actor.Id, turn.ConversationId);
        Check(saved.Pending.Length == 1 && saved.Pending[0].NativeId == "repaired-call" && saved.Actions.Count == 0,
            "only the fresh repaired proposal creates pending state and an approval token");
        var retry = model.Seen[1].Contents.ToJsonString();
        Check(!retry.Contains("failed-call", StringComparison.Ordinal) && !retry.Contains("failed-signature", StringComparison.Ordinal),
            "a rejected generation never enters executable conversation history");
        Check(model.Seen[1].Contents.Last()?["role"]?.GetValue<string>() == "user"
            && model.Seen[1].Contents.Last()?["parts"] is JsonArray { Count: > 2 },
            "repair guidance is appended to trusted user history before regeneration");
        Check(saved.Rounds == 2 && saved.Messages.All(message => !message.Text.Contains("failed-signature", StringComparison.Ordinal)),
            "rejected generation consumes a model step without becoming a successful assistant message");
        service.Confirm(fixture.Actor, new(turn.ConversationId, call.ApprovalToken!, true));
        model.Replies.Enqueue(Text("Synthetic controls added"));
        var done = await Continue(service, fixture.Actor, turn);
        Check(done.Reply == "Synthetic controls added" && done.Actions.Single().Status == "completed",
            "fresh repaired call completes only through normal approval and receipt handling");
    }

    private static async Task AcceptedHistoryChecks(Fixture fixture)
    {
        var model = new FakeModel();
        var accepted = Call("read_fixture", "accepted-call", "accepted-signature");
        model.Replies.Enqueue(accepted);
        var service = fixture.Service(model);
        var first = await service.TurnAsync(fixture.Actor, new(Message: "Inspect then add controls"), CancellationToken.None);
        model.Replies.Enqueue(Call("write_fixture", "discarded-call", "discarded-signature", "MALFORMED_FUNCTION_CALL"));
        model.Replies.Enqueue(Call("write_fixture", "next-call", "next-signature"));
        var second = await Continue(service, fixture.Actor, first);
        var retry = model.Seen[2].Contents;
        var acceptedModel = retry.OfType<JsonObject>().Single(item => item["role"]?.GetValue<string>() == "model");
        Check(JsonNode.DeepEquals(acceptedModel, accepted.Content), "prior successful signed model content is byte-shape preserved during repair");
        var receipts = retry.OfType<JsonObject>().SelectMany(item => (item["parts"] as JsonArray ?? []).OfType<JsonObject>())
            .Where(part => part["functionResponse"] is JsonObject).Select(part => part["functionResponse"]!.AsObject()).ToArray();
        Check(receipts.Length == 1 && receipts[0]["id"]?.GetValue<string>() == "accepted-call"
            && receipts[0]["response"]?["result"]?["snapshotToken"]?.GetValue<string>() == "snapshot-after-read",
            "the accepted receipt and authoritative snapshot survive repair without replaying its call");
        Check(!retry.ToJsonString().Contains("discarded-call", StringComparison.Ordinal)
            && fixture.Conversations.Read(fixture.Actor.Id, second.ConversationId).Actions.Count == 1,
            "repair neither records rejected actions nor repeats the earlier successful action");
    }

    private static async Task TruncatedTextChecks(Fixture fixture)
    {
        var model = new FakeModel();
        model.Replies.Enqueue(Text("UNFINISHED_SYNTHETIC_OUTPUT", "MAX_TOKENS"));
        model.Replies.Enqueue(Text("Recovered concise answer"));
        var turn = await fixture.Service(model).TurnAsync(fixture.Actor, new(Message: "Complete the synthetic layout"), CancellationToken.None);
        Check(model.Seen.Count == 2 && turn.Reply == "Recovered concise answer" && turn.ToolCalls.Length == 0,
            "MAX_TOKENS text is repaired instead of exposed as a successful final answer");
        var saved = fixture.Conversations.Read(fixture.Actor.Id, turn.ConversationId);
        Check(!saved.Contents.ToJsonString().Contains("UNFINISHED_SYNTHETIC_OUTPUT", StringComparison.Ordinal)
            && saved.Messages.All(message => !message.Text.Contains("UNFINISHED_SYNTHETIC_OUTPUT", StringComparison.Ordinal)),
            "truncated text remains outside executable and user-visible histories");
    }

    private static async Task EmptyReplyChecks(Fixture fixture)
    {
        var thoughtOnly = new AskSparkModelReply(new JsonObject { ["role"] = "model", ["parts"] = new JsonArray(new JsonObject
            { ["thought"] = true, ["text"] = "INTERNAL_SYNTHETIC_THOUGHT", ["thoughtSignature"] = "discarded-empty-signature" }) }, 12, FinishReason: "STOP");
        foreach (var empty in new[] { Text("", "STOP"), Text("", null), thoughtOnly })
        {
            var model = new FakeModel();
            model.Replies.Enqueue(empty);
            model.Replies.Enqueue(Text("Answer after empty response"));
            var turn = await fixture.Service(model).TurnAsync(fixture.Actor, new(Message: "Answer the synthetic question"), CancellationToken.None);
            Check(model.Seen.Count == 2 && turn.Reply == "Answer after empty response",
                "empty or thought-only visible content receives bounded repair");
            Check(!model.Seen[1].Contents.ToJsonString().Contains("INTERNAL_SYNTHETIC_THOUGHT", StringComparison.Ordinal),
                "thought-only failed output is not promoted into visible or executable history");
        }
    }

    private static async Task RepeatedFailureChecks(Fixture fixture)
    {
        var model = new FakeModel();
        for (var index = 0; index < 3; index++)
            model.Replies.Enqueue(Call("write_fixture", "never-executed-" + index, "never-accepted-" + index, "MALFORMED_FUNCTION_CALL"));
        var turn = await fixture.Service(model).TurnAsync(fixture.Actor, new(Message: "Repeated malformed controls"), CancellationToken.None);
        Check(model.Seen.Count == 3 && model.Seen.All(round => !round.FinalAnswer),
            "repeated failed generations stop after three attempts without another provider summary request");
        Check(Stopped(turn, "MALFORMED_FUNCTION_CALL"), "exhausted repair reports incomplete work and the provider reason");
        var saved = fixture.Conversations.Read(fixture.Actor.Id, turn.ConversationId);
        Check(saved.Rounds == 3 && saved.Pending.Length == 0 && saved.Actions.Count == 0
            && !saved.Contents.ToJsonString().Contains("never-executed", StringComparison.Ordinal),
            "exhausted repair leaves no executable call, approval token or fabricated action history");
    }

    private static async Task StepLimitChecks(Fixture fixture)
    {
        fixture.SetSteps(1);
        try
        {
            var model = new FakeModel();
            model.Replies.Enqueue(Text("UNFINISHED_STEP_LIMIT", "MAX_TOKENS"));
            var turn = await fixture.Service(model).TurnAsync(fixture.Actor, new(Message: "Respect one model step"), CancellationToken.None);
            Check(model.Seen.Count == 1 && Stopped(turn, "MAX_TOKENS"), "configured one-step limit prevents a generation retry");
            Check(turn.Reply!.Contains("limit", StringComparison.OrdinalIgnoreCase), "failure reports the configured step budget stopping reason");
        }
        finally { fixture.SetSteps(100); }
    }

    private static async Task FinalAnswerFailureChecks(Fixture fixture)
    {
        fixture.SetSteps(1);
        try
        {
            var model = new FakeModel();
            model.Replies.Enqueue(Call("read_fixture", "completed-before-limit", "preserved-before-limit"));
            var service = fixture.Service(model);
            var first = await service.TurnAsync(fixture.Actor, new(Message: "Inspect before the final answer"), CancellationToken.None);
            model.Replies.Enqueue(Text("INCOMPLETE_FINAL_SUMMARY", "MAX_TOKENS"));
            var turn = await Continue(service, fixture.Actor, first);
            Check(model.Seen.Count == 2 && model.Seen[1].FinalAnswer && Stopped(turn, "MAX_TOKENS"),
                "failed forced final answer stops without retrying beyond the step budget");
            var saved = fixture.Conversations.Read(fixture.Actor.Id, turn.ConversationId);
            Check(saved.Actions.Single().Status == "completed" && !turn.Reply!.Contains("INCOMPLETE_FINAL_SUMMARY", StringComparison.Ordinal),
                "a failed final answer preserves completed receipts and does not expose partial summary as success");
        }
        finally { fixture.SetSteps(100); }
    }

    private static async Task BlockedStatusChecks(Fixture fixture)
    {
        foreach (var reason in new[] { "SAFETY", "RECITATION", "BLOCKED_PROMPT", "OTHER", "UNKNOWN_SYNTHETIC_REASON" })
        {
            var model = new FakeModel();
            model.Replies.Enqueue(Call("write_fixture", "blocked-call", "blocked-signature", reason));
            var turn = await fixture.Service(model).TurnAsync(fixture.Actor, new(Message: "Respect provider stop status"), CancellationToken.None);
            Check(model.Seen.Count == 1 && Stopped(turn, reason == "UNKNOWN_SYNTHETIC_REASON" ? "OTHER" : reason),
                "blocked or unknown provider status is not retried: " + reason);
            var saved = fixture.Conversations.Read(fixture.Actor.Id, turn.ConversationId);
            Check(saved.Pending.Length == 0 && saved.Actions.Count == 0
                && !saved.Contents.ToJsonString().Contains("blocked-call", StringComparison.Ordinal),
                "a blocked valid-looking call cannot receive approval or execution: " + reason);
        }
    }

    private static bool Stopped(AskSparkTurnResponse turn, string reason)
        => turn.ToolCalls.Length == 0 && turn.ContinuationToken is null && turn.Reply is { } text
            && text.Contains(reason, StringComparison.Ordinal) && text.Contains("not complete", StringComparison.OrdinalIgnoreCase)
            && text.Contains("No tools from the failed response were executed", StringComparison.OrdinalIgnoreCase);

    private static async Task ProseChecks(Fixture fixture)
    {
        foreach (var reason in new string?[] { "STOP", null })
        {
            var model = new FakeModel();
            model.Replies.Enqueue(Text("Select which layout you prefer.", reason));
            var turn = await fixture.Service(model).TurnAsync(fixture.Actor, new(Message: "Discuss layout choices"), CancellationToken.None);
            Check(model.Seen.Count == 1 && turn.Reply == "Select which layout you prefer." && turn.ToolCalls.Length == 0,
                "ordinary complete prose is not automatically repeated or converted to tool work");
        }
    }

    private static Task<AskSparkTurnResponse> Continue(AskSparkService service, SecurityUser actor, AskSparkTurnResponse turn)
        => service.TurnAsync(actor, new(turn.ConversationId,
            ToolResults: turn.ToolCalls.Select(call => new AskSparkToolResult(call.Id, call.Name,
                new JsonObject { ["ok"] = true, ["snapshotToken"] = "snapshot-after-read" })).ToArray(),
            ContinuationToken: turn.ContinuationToken), CancellationToken.None);

    private static AskSparkTool Tool(string name, bool write = false) => new(name, "Synthetic generation recovery fixture.",
        new JsonObject { ["type"] = "object", ["properties"] = new JsonObject(), ["additionalProperties"] = false },
        "core", write ? "write" : "read", "gateway", "admin", write, !write);

    private static JsonObject CallContent(string name, string nativeId, string signature) => new()
    {
        ["role"] = "model", ["parts"] = new JsonArray(new JsonObject
        {
            ["thoughtSignature"] = signature,
            ["functionCall"] = new JsonObject { ["name"] = name, ["id"] = nativeId, ["args"] = new JsonObject() }
        })
    };

    private static AskSparkModelReply Call(string name, string nativeId, string signature, string reason = "STOP")
        => new(CallContent(name, nativeId, signature), 12, FinishReason: reason);
    private static AskSparkModelReply Text(string value, string? reason = "STOP")
        => new(AskSparkGemini.TextContent("model", value), 12, FinishReason: reason);
    private static void Check(bool condition, string description)
    {
        if (!condition) throw new InvalidOperationException("Generation recovery: " + description);
        checks++;
    }

    private sealed class Fixture : IDisposable
    {
        private readonly string directory = Path.Combine(Path.GetTempPath(), "SparkStudio.AskSparkGeneration." + Guid.NewGuid().ToString("N"));
        public AskSparkSettings Settings { get; }
        public SecurityStore Security { get; }
        public SecurityUser Actor { get; }
        public ProjectCatalog Projects { get; }
        public AskSparkConversations Conversations { get; }
        public AskSparkCatalog Catalog { get; } = new([Tool("read_fixture"), Tool("write_fixture", true)]);

        public Fixture()
        {
            Directory.CreateDirectory(directory);
            var protection = new EphemeralDataProtectionProvider();
            Settings = new(directory, protection);
            Settings.Save(new("0", true, AskSparkSettings.DefaultModel, ApiKey: "synthetic-generation-key"));
            Security = new(directory);
            Actor = Security.Setup(File.ReadAllText(Path.Combine(directory, "security", "setup-code.txt")).Trim(),
                new("generation-admin", "Synthetic-generation-password-123"));
            Projects = new(directory, protection);
            Conversations = new(directory, protection);
        }

        public AskSparkService Service(FakeModel model) => new(Settings, Conversations, Catalog, model, Security, Projects);
        public void SetSteps(int steps) => Settings.Save(new(Settings.Snapshot().Revision, true, AskSparkSettings.DefaultModel, ModelStepLimit: steps));
        public void Dispose() { Security.Dispose(); Directory.Delete(directory, true); }
    }

    private sealed record SeenRound(JsonArray Contents, bool FinalAnswer);
    private sealed class FakeModel : IAskSparkModel
    {
        public Queue<AskSparkModelReply> Replies { get; } = new();
        public List<SeenRound> Seen { get; } = [];
        public Task<AskSparkModelReply> GenerateAsync(JsonArray contents, IReadOnlyList<AskSparkTool> tools, bool finalAnswer, CancellationToken cancellation)
        {
            Seen.Add(new(contents.DeepClone().AsArray(), finalAnswer));
            return Task.FromResult(Replies.Dequeue());
        }
        public Task<string> TranscribeAsync(AskSparkAudioRequest audio, CancellationToken cancellation) => Task.FromResult("Synthetic transcript");
        public Task TestAsync(CancellationToken cancellation) => Task.CompletedTask;
    }

    private sealed class FixtureHandler : HttpMessageHandler
    {
        public JsonObject? Candidate { get; set; } = new();
        public string? PromptBlockReason { get; set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var response = new JsonObject
            {
                ["candidates"] = Candidate is null ? new JsonArray() : new JsonArray(Candidate.DeepClone()),
                ["usageMetadata"] = new JsonObject { ["promptTokenCount"] = 10, ["candidatesTokenCount"] = 2, ["totalTokenCount"] = 12 }
            };
            if (PromptBlockReason is not null) response["promptFeedback"] = new JsonObject { ["blockReason"] = PromptBlockReason };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(response.ToJsonString()) });
        }
    }
}
