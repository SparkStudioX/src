using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class EquipmentCommandChecks
{
    private sealed class Clock : TimeProvider { public DateTimeOffset Now = DateTimeOffset.UtcNow; public override DateTimeOffset GetUtcNow() => Now; }
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool value, string description) { if (!value) throw new Exception("FAILED: " + description); passed++; }
        async Task Reject(Func<Task> action, string description)
        {
            try { await action(); } catch (Exception error) when (error is ArgumentException or InvalidOperationException or BadHttpRequestException or OperationCanceledException) { passed++; return; }
            throw new Exception("FAILED to reject: " + description);
        }
        var temp = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
        var directory = Path.Combine(temp, "SparkStudio.EquipmentCommands." + Guid.NewGuid().ToString("N"));
        try
        {
            var catalog = new ProjectCatalog(directory, new EphemeralDataProtectionProvider());
            var workspace = catalog.Create("Command fixture"); var store = workspace.Store;
            var definition = JsonNode.Parse("""{"id":"speed","name":"Set synthetic speed","tagPath":"[default]Fixture/Speed","dataType":"Int32","min":0,"max":100,"confirmation":"Set the synthetic speed?","timeoutMs":150}""")!.AsObject();
            var project = store.GetProject(); project["commands"] = new JsonArray(definition.DeepClone()); store.SaveProject(project);
            string Publish() => workspace.Publication.Publish(store, store.GetProject()["revision"]!.GetValue<int>())["publishedAt"]!.GetValue<string>();
            var stamp = Publish();
            using var connectors = new ConnectorService(directory);
            using var tags = new TagEngine(catalog.GatewayStore, connectors, NullLogger<TagEngine>.Instance);
            var security = new SecurityStore(directory); var setup = File.ReadAllText(Path.Combine(directory, "security", "setup-code.txt")).Trim();
            var admin = security.Setup(setup, new("command-admin", "Synthetic-fixture-password-123"));
            var operatorUser = security.CreateUser(new("command-user", "Synthetic-fixture-password-456", ProjectGrants: new() { [workspace.Id] = new(Commands: true) }));
            var viewer = security.CreateUser(new("operate-only", "Synthetic-fixture-password-789", ProjectGrants: new() { [workspace.Id] = new(Operate: true, View: true) }));
            DefaultHttpContext Context(SecurityUser user, string? projectId = null)
            {
                var context = new DefaultHttpContext(); context.Items["spark.actor"] = user; context.Items["spark.project"] = projectId ?? workspace.Id; context.Items["spark.audience"] = "operator"; return context;
            }
            var context = Context(operatorUser); var clock = new Clock();
            var commands = new EquipmentCommands(connectors, tags, security, new RecoveryQuarantine(directory), clock);
            const string path = "[default]Fixture/Speed";
            void Tag(string name, int value, bool enabled = true) => tags.SaveDefinition(new JsonObject { ["path"] = name, ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = value, ["enabled"] = enabled });
            Tag(path, 10); Tag("[default]Fixture/Readback", 0);
            JsonObject Node(object value) => JsonSerializer.SerializeToNode(value, ProjectStore.Json)!.AsObject();
            async Task<JsonObject> Review(int value, HttpContext? actor = null) => Node(await commands.Review(actor ?? context, store, workspace.Publication, "speed", new(stamp, JsonSerializer.SerializeToElement(value)), CancellationToken.None));
            async Task<JsonObject> Execute(JsonObject review, HttpContext? actor = null, CancellationToken cancellation = default) => Node(await commands.Execute(actor ?? context, store, workspace.Publication, "speed", new(review["token"]!.GetValue<string>(), true), cancellation));
            int Value() => catalog.GatewayStore.GetRuntimeTagDefinitions().OfType<JsonObject>().Single(tag => tag["path"]!.GetValue<string>() == path)["value"]!.GetValue<int>();
            await Reject(() => Review(20), "Commands grant cannot bypass project tag-read scope");
            security.UpdateSettings(new(security.Settings.Revision, null, new() { [workspace.Id] = ["[default]Fixture/"] }));
            await Reject(() => Review(20, Context(viewer)), "Operate permission alone does not grant commands");
            await Reject(() => Review(101), "command range");
            await Reject(async () => await commands.Review(context, store, workspace.Publication, "speed", new("", JsonSerializer.SerializeToElement(20)), CancellationToken.None), "missing publication stamp");
            var review = await Review(20);
            await Reject(async () => await commands.Execute(context, store, workspace.Publication, "speed", new(review["token"]!.GetValue<string>(), false), CancellationToken.None), "unconfirmed intent");
            await Reject(() => Execute(review, Context(admin)), "ticket bound to actor");
            await Reject(() => Execute(review, Context(operatorUser, "different-project")), "ticket bound to project");
            Check(Value() == 10, "rejected review/confirmation/ownership attempts do not write");
            Check((await Execute(review))["status"]!.GetValue<string>() == "confirmed" && Value() == 20, "valid reviewed command writes once and confirms readback");
            await Reject(() => Execute(review), "one-use ticket replay");
            review = await Review(30); Tag(path, 21);
            Check((await Execute(review))["status"]!.GetValue<string>() == "rejected" && Value() == 21, "changed value after review rejects without writing");
            await Reject(() => Execute(review), "failed command also consumes intent");
            review = await Review(30); Tag(path, 21, false);
            Check((await Execute(review))["status"]!.GetValue<string>() == "rejected" && Value() == 21, "disabled tag/configuration change rejects without writing"); Tag(path, 21);
            review = await Review(30); stamp = Publish();
            Check((await Execute(review))["status"]!.GetValue<string>() == "rejected" && Value() == 21, "new application invalidates reviewed command");
            review = await Review(30); clock.Now += TimeSpan.FromSeconds(31);
            await Reject(() => Execute(review), "expired ticket"); Check(Value() == 21, "expired ticket does not write");
            review = await Review(30);
            using (var cancelled = new CancellationTokenSource())
            {
                cancelled.Cancel(); await Reject(() => Execute(review, cancellation: cancelled.Token), "cancelled before dispatch");
                Check(Value() == 21, "cancelled request cannot write memory");
            }
            review = await Review(30);
            using (var cancelled = new CancellationTokenSource())
            {
                void CancelAfterWrite(TagValue? previous, TagValue current) { if (current.Path == path && JsonSerializer.SerializeToElement(current.Value).GetInt32() == 30) cancelled.Cancel(); }
                tags.ValueChanged += CancelAfterWrite;
                try { Check((await Execute(review, cancellation: cancelled.Token))["status"]!.GetValue<string>() == "uncertain" && Value() == 30, "cancellation after write reports uncertain and preserves evidence that value changed"); }
                finally { tags.ValueChanged -= CancelAfterWrite; }
            }
            await Reject(() => Execute(review), "uncertain intent is never retried");
            project = store.GetProject(); project["commands"]![0]!["readbackPath"] = "[default]Fixture/Readback"; store.SaveProject(project); stamp = Publish();
            var first = await Review(40); var second = await Review(50); var started = System.Diagnostics.Stopwatch.StartNew();
            var pending = Execute(first);
            await Reject(() => Execute(second), "same-path concurrent command rejected without waiting");
            var result = await pending;
            Check(result["status"]!.GetValue<string>() == "notConfirmed" && Value() == 40 && started.Elapsed < TimeSpan.FromSeconds(2), "mismatching readback respects configured bound and reports accepted but not confirmed");
            await Reject(() => Execute(second), "busy-path refusal consumes second intent");
            var largeTag = new JsonObject { ["path"] = "[default]Fixture/Large", ["kind"] = "memory", ["dataType"] = "Int64", ["value"] = 9007199254740992L };
            tags.SaveDefinition(largeTag);
            project = store.GetProject(); project["commands"]![0] = definition.DeepClone(); project["commands"]![0]!["tagPath"] = "[default]Fixture/Large"; project["commands"]![0]!["dataType"] = "Int64"; store.SaveProject(project); stamp = Publish();
            review = await Review(50); largeTag["value"] = 9007199254740993L; tags.SaveDefinition(largeTag);
            Check((await Execute(review))["status"]!.GetValue<string>() == "rejected", "distinct device Int64 values never collapse through double precision in the stale-state check");
            project = store.GetProject(); project["commands"]![0] = definition.DeepClone(); store.SaveProject(project); stamp = Publish();
            review = await Review(60);
            security.UpdateUser(operatorUser.Id, new(operatorUser.Revision, operatorUser.DisplayName, false, false, new() { [workspace.Id] = new(Operate: true, View: true) }));
            Check((await Execute(review))["status"]!.GetValue<string>() == "rejected" && Value() == 40, "revoked permission on request-local identity is rechecked before dispatch");
            var audit = File.ReadAllText(Path.Combine(directory, "security", "audit.jsonl"));
            Check(audit.Contains("equipment.review") && audit.Contains("uncertain") && audit.Contains("notConfirmed") && !audit.Contains("Synthetic-fixture-password"), "audit records review and explicit command outcomes without credentials");
            return passed;
        }
        finally { if (Path.GetDirectoryName(directory) == temp && Directory.Exists(directory)) Directory.Delete(directory, true); }
    }
}
