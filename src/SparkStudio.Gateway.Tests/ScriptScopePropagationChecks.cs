using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

public static class ScriptScopePropagationChecks
{
    private sealed class Lifetime : IHostApplicationLifetime
    {
        public CancellationToken ApplicationStarted => CancellationToken.None;
        public CancellationToken ApplicationStopping => CancellationToken.None;
        public CancellationToken ApplicationStopped => CancellationToken.None;
        public void StopApplication() { }
    }
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool condition, string description) { if (!condition) throw new Exception(description); passed++; }
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.ScriptScopes." + Guid.NewGuid().ToString("N"));
        try
        {
            var catalog = new ProjectCatalog(directory, new EphemeralDataProtectionProvider());
            using var connectors = new ConnectorService(directory);
            using var tags = new TagEngine(catalog.GatewayStore, connectors, NullLogger<TagEngine>.Instance);
            foreach (var name in new[] { "Allowed", "Restricted" })
                tags.SaveDefinition(new() { ["path"] = "[default]Scopes/" + name, ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = 1 });
            var project = catalog.Create("Scope propagation");
            JsonObject Handler(string id, string code, string trigger = "message") => new()
            { ["id"] = id, ["name"] = id, ["type"] = "gateway", ["event"] = trigger, ["threading"] = "dedicated", ["enabled"] = true, ["code"] = code };
            var draft = project.Scripts.GetDraft();
            draft["resources"] = new JsonArray(
                Handler("startup", "system.tag.writeBlocking(['[default]Scopes/Restricted'], [7])", "startup"),
                Handler("inner", "result = system.tag.readBlocking(['[default]Scopes/Restricted'])[0].value"),
                Handler("outer", "result = system.util.sendRequest(messageHandler='inner')"),
                Handler("allowed", "result = system.tag.readBlocking(['[default]Scopes/Allowed'])[0].value"));
            project.Scripts.SaveDraft(draft); project.Publication.Publish(project.Store, 0);
            var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Python:Executable"] = TestEnvironment.PythonExecutable() }).Build();
            using var registry = new ProjectRuntimeRegistry(catalog, tags, connectors, config, NullLoggerFactory.Instance, new Lifetime());
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            ProjectRuntime runtime;
            using (PythonExecutionAccess.Enter(new(path => path == "[default]Scopes/Allowed", _ => false)))
            {
                // Runtime creation may happen lazily inside an operator HTTP request.
                runtime = registry.Get(project.Id);
                while (runtime.Events.Status()["acceptingEvents"]?.GetValue<bool>() != true) await Task.Delay(20, deadline.Token);
                Check(tags.Read(["[default]Scopes/Restricted"], null)[0].Value is JsonElement startup && startup.GetInt32() == 7,
                    "automatic gateway startup does not inherit the operator that lazily started its runtime");
                var payload = JsonSerializer.SerializeToElement(new { });
                var denied = await runtime.Events.DispatchMessageAsync("outer", payload, "operator", null, deadline.Token);
                Check(denied["success"]?.GetValue<bool>() == false && denied["stderr"]!.GetValue<string>().Contains("scope", StringComparison.OrdinalIgnoreCase),
                    "operator authority survives queueing and nested gateway request dispatch");
                var allowed = await runtime.Events.DispatchMessageAsync("allowed", payload, "operator", null, deadline.Token);
                Check(allowed["success"]?.GetValue<bool>() == true && allowed["result"]!.GetValue<int>() == 1,
                    "queued allowed tag read still succeeds under caller authority");
            }
            Check(PythonExecutionAccess.Current is null, "queued invocation does not leak operator authority back to its caller");
            await registry.StopAsync(CancellationToken.None);
            return passed;
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); }
    }
}
