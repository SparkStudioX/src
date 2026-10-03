using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Primitives;
using SparkStudio.Gateway;

internal static class AskSparkWorkspaceChecks
{
    private const string Pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
    private static int checks;
    public static async Task<int> RunAsync()
    {
        checks = 0;
        using var fixture = new Fixture();
        ImageChecks();
        PermissionChecks(fixture);
        IdentityFenceChecks(fixture.Actor);
        await OpenProjectChecks(fixture);
        await ProjectGuardChecks(fixture);
        await ImageRoundChecks(fixture);
        return checks;
    }

    private static void ImageChecks()
    {
        var image = new AskSparkImage(Pixel, "image/png", "Fixture", "image-opaque-id");
        var message = AskSparkData.MessageParts("Inspect image", [image]);
        Check(message.Images[0].Width == 1 && message.Images[0].Height == 1 && message.Images[0].Id == image.Id, "input image dimensions and opaque identity come from validated pixels");
        Check(message.Parts.ToJsonString().Contains("image-opaque-id", StringComparison.Ordinal), "model receives image identity annotation");
        Reject(() => AskSparkData.MessageParts("Duplicate", [image, image]), "duplicate image identity");
        Reject(() => AskSparkData.MessageParts("Unsafe", [image with { Id = "../file.png" }]), "path-shaped image identity");
        var pending = CapturePending();
        var response = new JsonObject { ["response"] = new JsonObject { ["result"] = new JsonObject { ["captured"] = true } } };
        AskSparkToolImages.Add(response, pending, [image]);
        Check(response["parts"]![0]!["inlineData"]!["data"]!.GetValue<string>() == Pixel, "validated pixels use nested Gemini functionResponse inlineData");
        Check(response["response"]!["images"]![0]!["image"]!["$ref"]!.GetValue<string>() == response["parts"]![0]!["inlineData"]!["displayName"]!.GetValue<string>(), "image reference uniquely matches the inline part");
        Check(!response["response"]!.ToJsonString().Contains(Pixel, StringComparison.Ordinal), "structured result contains metadata instead of encoded pixels");
        Reject(() => AskSparkToolImages.Add(response, pending, [image, image]), "multiple frames from one capture");
        Reject(() => AskSparkToolImages.Add(response, pending, [image with { Data = "not-base64" }]), "invalid image encoding");
        Reject(() => AskSparkToolImages.Add(response, pending, [image with { MimeType = "image/svg+xml" }]), "unsupported active image format");
        Reject(() => AskSparkToolImages.Add(response, pending, [image with { Data = Convert.ToBase64String(new byte[5 * 1024 * 1024 + 1]) }]), "oversized image frame");
        Reject(() => AskSparkToolImages.Add(response, pending with { Call = pending.Call with { Name = "read_core" } }, [image]), "image on a non-capture tool");
        Reject(() => AskSparkToolImages.Add(response, pending with { Declined = true }, [image]), "declined image capture");
        Reject(() => AskSparkToolImages.ValidateTurn(Enumerable.Range(0, 5).Select(index => new AskSparkToolResult(index.ToString(System.Globalization.CultureInfo.InvariantCulture), "capture", null, [image])).ToArray()), "too many frames in a tool round");
    }

    private static void PermissionChecks(Fixture fixture)
    {
        var catalog = new AskSparkCatalog();
        SecurityUser Create(string name, SecurityProjectGrant grant) => fixture.Security.CreateUser(new(name, "Synthetic-runtime-password-123", ProjectGrants: new() { [fixture.ProjectId] = grant }));
        var designer = Create("design-only", new(Design: true));
        var viewer = Create("design-view", new(View: true, Design: true));
        var operatorOnly = Create("operator-only", new(View: true, Operate: true, Commands: true));
        var tester = Create("design-operate", new(View: true, Operate: true, Design: true));
        var controls = Create("design-controls", new(View: true, Operate: true, Design: true, Commands: true));
        AskSparkTool[] Allowed(SecurityUser actor) => catalog.Allowed(fixture.Security, actor, fixture.ProjectId, false);
        Check(!Allowed(designer).Any(tool => tool.Permission is "view" or "operate" or "command"), "design alone grants no operator testing capability");
        Check(Allowed(viewer).Any(tool => tool.Name == "runtime_project") && !Allowed(viewer).Any(tool => tool.Permission is "operate" or "command"), "view and design grant only published read tests");
        Check(!Allowed(operatorOnly).Any(tool => tool.Permission is "view" or "operate" or "command"), "operator grants alone do not grant engineering tools");
        Check(Allowed(tester).Any(tool => tool.Name == "runtime_action") && !Allowed(tester).Any(tool => tool.Permission == "command"), "operate remains separate from equipment command grants");
        Check(Allowed(controls).Any(tool => tool.Name == "commands_execute"), "all existing grants permit reviewed command testing");
        Reject(() => catalog.Require("spark_open_project", new JsonObject { ["projectId"] = fixture.OtherId }, fixture.Security, designer, fixture.ProjectId, false), "opening a project without its design grant");
        Check(Allowed(designer).Any(tool => tool.Name == "spark_open_project"), "project opening is discoverable without an active editor");
    }

    private static void IdentityFenceChecks(SecurityUser actor)
    {
        var context = new DefaultHttpContext();
        context.Request.Headers["X-SPARK-EXPECTED-USER"] = actor.Id;
        GatewayAccess.RequireExpectedUser(context, actor);
        Check(!context.User.Identity!.IsAuthenticated, "expected-user header cannot authenticate or grant a principal");
        Reject(() => GatewayAccess.RequireExpectedUser(context, null), "expected-user header cannot replace authentication");
        Reject(() => GatewayAccess.RequireExpectedUser(context, actor with { Id = "other-user" }), "operator cookie switching to a different account");
        context.Request.Headers["X-SPARK-EXPECTED-USER"] = new StringValues([actor.Id, actor.Id]);
        Reject(() => GatewayAccess.RequireExpectedUser(context, actor), "multiple expected-user headers");
    }

    private static async Task OpenProjectChecks(Fixture fixture)
    {
        var model = new FakeModel(); model.Replies.Enqueue(Call("spark_open_project", new JsonObject { ["projectId"] = fixture.OtherId }));
        var service = fixture.Service(model);
        var turn = await service.TurnAsync(fixture.Actor, new(Message: "Open other project"), CancellationToken.None);
        Check(turn.ToolCalls.Single().Authorized && turn.ToolCalls.Single().Name == "spark_open_project", "server authorizes exact permitted project navigation without an editor");
        var call = turn.ToolCalls.Single();
        var next = Context(fixture.OtherId);
        await RejectAsync(() => service.TurnAsync(fixture.Actor, new(turn.ConversationId, Context: next, ToolResults: [new(call.Id, call.Name, new JsonObject { ["opened"] = false, ["projectId"] = fixture.OtherId })], ContinuationToken: turn.ContinuationToken), CancellationToken.None), "project switch without successful receipt");
        model.Replies.Enqueue(Text("Opened"));
        await service.TurnAsync(fixture.Actor, new(turn.ConversationId, Context: next, ToolResults: [new(call.Id, call.Name, new JsonObject { ["opened"] = true, ["projectId"] = fixture.OtherId })], ContinuationToken: turn.ContinuationToken), CancellationToken.None);
        Check(fixture.Conversations.Read(fixture.Actor.Id, turn.ConversationId).ProjectId == fixture.OtherId, "exact successful navigation binds subsequent tools to destination project");
    }

    private static async Task ProjectGuardChecks(Fixture fixture)
    {
        var model = new FakeModel(); model.Replies.Enqueue(Call("read_core"));
        var service = fixture.Service(model);
        var turn = await service.TurnAsync(fixture.Actor, new(Message: "Read current", Context: Context(fixture.ProjectId)), CancellationToken.None);
        var call = turn.ToolCalls.Single();
        await RejectAsync(() => service.TurnAsync(fixture.Actor, new(turn.ConversationId, Context: Context(fixture.OtherId), ToolResults: [new(call.Id, call.Name, new JsonObject { ["opened"] = true, ["projectId"] = fixture.OtherId })], ContinuationToken: turn.ContinuationToken), CancellationToken.None), "ordinary tool cannot authorize project transition");
        var mixed = new FakeModel();
        var first = Call("spark_open_project", new JsonObject { ["projectId"] = fixture.OtherId }).Content;
        first["parts"]!.AsArray().Add(Call("read_core").Content["parts"]![0]!.DeepClone()); mixed.Replies.Enqueue(new(first, 1));
        await RejectAsync(() => fixture.Service(mixed).TurnAsync(fixture.Actor, new(Message: "Mixed project scope"), CancellationToken.None), "project opening cannot mix with other browser calls");
    }

    private static async Task ImageRoundChecks(Fixture fixture)
    {
        var model = new FakeModel(); model.Replies.Enqueue(Call("spark_designer_capture_canvas"));
        var service = fixture.Service(model);
        var turn = await service.TurnAsync(fixture.Actor, new(Message: "Inspect canvas", Context: Context(fixture.ProjectId)), CancellationToken.None);
        var call = turn.ToolCalls.Single(); model.Replies.Enqueue(Text("Canvas observed"));
        await service.TurnAsync(fixture.Actor, new(turn.ConversationId, ToolResults: [new(call.Id, call.Name, new JsonObject { ["captured"] = true }, [new(Pixel, "image/png", "Canvas")])], ContinuationToken: turn.ContinuationToken), CancellationToken.None);
        var response = model.LastContents!.Last()!["parts"]![0]!["functionResponse"]!;
        Check(response["id"]!.GetValue<string>() == "native-call" && response["parts"]![0]!["inlineData"]!["data"]!.GetValue<string>() == Pixel, "continuation forwards image under original native function-response ID");
        Check(!System.Text.Json.JsonSerializer.Serialize(fixture.Conversations.Read(fixture.Actor.Id, turn.ConversationId).Messages).Contains(Pixel, StringComparison.Ordinal), "tool frame bytes are not exposed through public message history");
    }

    private static JsonObject Context(string id) => new() { ["projectId"] = id, ["editorAvailable"] = true, ["surface"] = "designer", ["section"] = "designer" };
    private static AskSparkPending CapturePending() => new(new("receipt-id", "spark_designer_capture_canvas", new(), "read", "designer", false, false, null, true), null, DateTimeOffset.UtcNow.AddMinutes(1), true);
    private static AskSparkModelReply Call(string name, JsonObject? args = null) => new(new JsonObject { ["role"] = "model", ["parts"] = new JsonArray(new JsonObject
    { ["thoughtSignature"] = "signed-fixture", ["functionCall"] = new JsonObject { ["name"] = name, ["id"] = "native-call", ["args"] = args ?? new JsonObject() } }) }, 1);
    private static AskSparkModelReply Text(string text) => new(AskSparkGemini.TextContent("model", text), 1);
    private static void Check(bool condition, string description) { if (!condition) throw new InvalidOperationException("Workspace tools: " + description); checks++; }
    private static void Reject(Action action, string description)
    {
        try { action(); } catch (Exception error) when (error is ArgumentException or BadHttpRequestException) { checks++; return; }
        throw new InvalidOperationException("Workspace tools accepted " + description);
    }
    private static async Task RejectAsync(Func<Task> action, string description)
    {
        try { await action(); } catch (Exception error) when (error is ArgumentException or BadHttpRequestException) { checks++; return; }
        throw new InvalidOperationException("Workspace tools accepted " + description);
    }

    private sealed class Fixture : IDisposable
    {
        private readonly string directory = Path.Combine(Path.GetTempPath(), "SparkStudio.AskSparkWorkspace." + Guid.NewGuid().ToString("N"));
        private AskSparkSettings Settings { get; }
        public SecurityStore Security { get; }
        public SecurityUser Actor { get; }
        public ProjectCatalog Projects { get; }
        public AskSparkConversations Conversations { get; }
        public string ProjectId => Projects.DefaultId;
        public string OtherId { get; }
        private AskSparkCatalog Catalog { get; }
        public Fixture()
        {
            Directory.CreateDirectory(directory); var protection = new EphemeralDataProtectionProvider();
            Settings = new(directory, protection); Settings.Save(new("0", true, AskSparkSettings.DefaultModel, ApiKey: "synthetic-workspace-key"));
            Security = new(directory); Actor = Security.Setup(File.ReadAllText(Path.Combine(directory, "security", "setup-code.txt")).Trim(), new("workspace-admin", "Synthetic-workspace-password-123"));
            Projects = new(directory, protection); OtherId = Projects.Create("Other fixture").Id; Conversations = new(directory, protection);
            var schema = new JsonObject { ["type"] = "object", ["properties"] = new JsonObject(), ["additionalProperties"] = false };
            Catalog = new([new("read_core", "Read fixture", schema, "core", "read", "gateway", "signedIn", false, true),
                new("spark_designer_capture_canvas", "Capture fixture", schema.DeepClone().AsObject(), "core", "read", "designer", "design", false, false)]);
        }
        public AskSparkService Service(FakeModel model) => new(Settings, Conversations, Catalog, model, Security, Projects);
        public void Dispose() { Security.Dispose(); Directory.Delete(directory, true); }
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
}
