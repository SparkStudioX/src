using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class SecurityHardeningChecks
{
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool condition, string description) { if (!condition) throw new Exception("FAILED: " + description); passed++; }
        void Reject(Action action, string description)
        {
            try { action(); } catch (Exception error) when (error is BadHttpRequestException or UnauthorizedAccessException) { passed++; return; }
            throw new Exception("FAILED to reject: " + description);
        }
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.SecurityHardening." + Guid.NewGuid().ToString("N"));
        try
        {
            var security = new SecurityStore(directory);
            var admin = security.Setup(File.ReadAllText(Path.Combine(directory, "security", "setup-code.txt")).Trim(), new("fixture-admin", "Synthetic-password-12345"));
            for (var i = 0; i < 5; i++) Reject(() => security.Login(admin.Username, "wrong", "192.0.2.10"), "wrong password");
            Reject(() => security.Login(admin.Username, "Synthetic-password-12345", "192.0.2.10"), "bad source remains throttled");
            Check(security.Login(admin.Username, "Synthetic-password-12345", "192.0.2.11").Id == admin.Id, "one source cannot lock other workstations out");
            using var locked = new ManualResetEventSlim(); using var release = new ManualResetEventSlim();
            var holder = Task.Run(() => { lock (GatewayConfigurationLock.SyncRoot) { locked.Set(); release.Wait(); } });
            locked.Wait();
            try
            {
                var login = Task.Run(() => security.Login(admin.Username, "Synthetic-password-12345", "192.0.2.12"));
                Check(await login.WaitAsync(TimeSpan.FromSeconds(5)) is not null, "authentication is independent of configuration lock");
            }
            finally { release.Set(); await holder; }

            var context = new DefaultHttpContext();
            context.Connection.RemoteIpAddress = IPAddress.Loopback;
            context.Request.Scheme = "https";
            Check(!GatewaySecurity.IsLoopback(context) && !GatewaySecurity.IsSecureTransport(context), "rewritten HTTP peer/scheme cannot confer transport trust");
            var peer = typeof(GatewayReadiness).Assembly.GetType("SparkStudio.Gateway.GatewayReadinessPeer")!;
            context.Features[peer] = Activator.CreateInstance(peer, IPAddress.Loopback);
            Check(GatewaySecurity.IsLoopback(context), "captured direct local peer is accepted");
            context.Request.Headers["X-Original-For"] = "192.0.2.1";
            Check(!GatewaySecurity.IsLoopback(context), "loopback proxy cannot grant local setup authority");

            JsonObject Snapshot(string? code) => new() { ["project"] = new JsonObject { ["name"] = "Fixture", ["code"] = code }, ["queries"] = new JsonArray() };
            var first = Snapshot(null); var scripted = Snapshot("result = 1");
            Check(!ExecutablePublication.Changed(null, first), "layout-only initial publication needs no script approval");
            Reject(() => ExecutablePublication.RequireAllowed(first, scripted, false), "project Publish cannot introduce code");
            ExecutablePublication.RequireAllowed(first, scripted, true); passed++;
            var layout = scripted.DeepClone().AsObject(); layout["title"] = "New title";
            Check(!ExecutablePublication.Changed(scripted, layout), "layout outside executable definition remains publishable");
            Reject(() => ExecutablePublication.RequireAllowed(scripted, Snapshot("result = 2"), false), "rollback or source replacement requires approval");
            var resource = first.DeepClone().AsObject(); resource["scripts"] = JsonNode.Parse("""{"resources":[{"id":"event","code":"pass","enabled":true,"event":"startup"}]}""");
            Reject(() => ExecutablePublication.RequireAllowed(first, resource, false), "automatic gateway resources need approval");
            var queryOrder = scripted.DeepClone().AsObject();
            queryOrder["queries"] = JsonNode.Parse("""[{"id":"a","sql":"SELECT 1"},{"id":"b","sql":"SELECT 2"}]""");
            var reordered = queryOrder.DeepClone().AsObject();
            reordered["queries"] = JsonNode.Parse("""[{"id":"b","sql":"SELECT 2"},{"id":"a","sql":"SELECT 1"}]""");
            Check(!ExecutablePublication.Changed(queryOrder, reordered), "query order alone does not change executable authority");
            reordered["queries"]![0]!["sql"] = "DELETE FROM data";
            Reject(() => ExecutablePublication.RequireAllowed(queryOrder, reordered, false), "changed captured query requires executable approval");
            var safeEvent = JsonNode.Parse("""{"project":{"props":{"componentEvents":{"mount":{"code":"pass"}}}},"queries":[]}""")!.AsObject();
            var aliasedEvent = safeEvent.DeepClone().AsObject();
            aliasedEvent["project"]!["props"]!["componentEvents"]!["mount"]!["code"] = "dangerous()";
            aliasedEvent["project"]!["props"]!["componentEvents/mount"] = JsonNode.Parse("""{"code":"pass"}""");
            Reject(() => ExecutablePublication.RequireAllowed(safeEvent, aliasedEvent, false), "slash-bearing properties cannot conceal changed event code");

            var leases = Enumerable.Range(0, PythonProcessAdmission.Capacity).Select(_ => PythonProcessAdmission.Acquire(CancellationToken.None)).ToArray();
            try { Reject(() => PythonProcessAdmission.Acquire(CancellationToken.None), "global Python spawn cap"); }
            finally { foreach (var lease in leases) lease.Dispose(); }
            using (PythonProcessAdmission.Acquire(CancellationToken.None)) passed++;

            var store = new ProjectStore(Path.Combine(directory, "project"), new EphemeralDataProtectionProvider());
            using var connectors = new ConnectorService(directory);
            using var tags = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance);
            foreach (var line in new[] { "Line1", "Line2" }) tags.SaveDefinition(new JsonObject { ["path"] = "[default]FixtureLines/" + line + "/Speed", ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = 10, ["enabled"] = true });
            var scripts = new ScriptResourceStore(Path.Combine(directory, "project"));
            var python = new PythonRunner(tags, new QueryExecutor(store, connectors), scripts, new ConfigurationBuilder().Build());
            Check(python.Available, "CPython is present for security integration checks");
            var native = await python.RunAsync("import os, subprocess, sys\nos.write(1, b'native output\\n')\nsubprocess.run([sys.executable, '-c', 'print(123)'], check=True)\nresult = 42", null, CancellationToken.None);
            Check(native["success"]!.GetValue<bool>() && native["result"]!.GetValue<int>() == 42, "native and subprocess stdout cannot corrupt worker protocol");
            using (PythonExecutionAccess.Enter(new(path => path.StartsWith("[default]FixtureLines/Line1/", StringComparison.Ordinal), _ => false)))
            {
                var allowed = await python.RunAsync("result = system.tag.readBlocking(['[default]FixtureLines/{line}/Speed'])[0].value", new() { ["line"] = JsonSerializer.SerializeToElement("Line1") }, CancellationToken.None);
                Check(allowed["success"]!.GetValue<bool>(), "permitted indirect Python tag read");
                var denied = await python.RunAsync("result = system.tag.readBlocking(['[default]FixtureLines/{line}/Speed'])[0].value", new() { ["line"] = JsonSerializer.SerializeToElement("Line2") }, CancellationToken.None);
                Check(!denied["success"]!.GetValue<bool>(), "forged indirect path is denied before tag read");
                var write = await python.RunAsync("result = system.tag.writeBlocking(['[default]FixtureLines/Line1/Speed'], [20])", null, CancellationToken.None);
                Check(!write["success"]!.GetValue<bool>(), "read-only Python scope cannot write");
            }
            Check(PythonExecutionAccess.Current is null, "authority scope restored after invocation");
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
        return passed;
    }
}
