using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class BindingDataChecks
{
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool condition, string name) { if (!condition) throw new Exception("FAILED: " + name); passed++; }
        void Reject(Action action, string name) { try { action(); } catch (ArgumentException) { passed++; return; } throw new Exception("FAILED to reject: " + name); }
        async Task RejectAsync(Func<Task> action, string name) { try { await action(); } catch (ArgumentException) { passed++; return; } throw new Exception("FAILED to reject: " + name); }
        var root = Path.GetFullPath(Path.GetTempPath());
        var directory = Path.GetFullPath(Path.Combine(root, "SparkStudio.BindingData." + Guid.NewGuid().ToString("N")));
        if (Path.GetDirectoryName(directory) != Path.TrimEndingDirectorySeparator(root)) throw new Exception("Unsafe test path.");
        try
        {
            var catalog = new ProjectCatalog(directory, new EphemeralDataProtectionProvider());
            catalog.GatewayStore.SaveConnection(new JsonObject { ["id"] = "binding-data", ["name"] = "Disposable binding data", ["type"] = "sqlite", ["database"] = "binding-data.db" });
            var queryDefinitions = JsonNode.Parse("""
            [{"id":"groups","name":"Groups","connectionId":"binding-data","sql":"SELECT 'A' AS row_key, 'A' AS groupName UNION ALL SELECT 'B','B'","parameters":[]},
             {"id":"items","name":"Items","connectionId":"binding-data","sql":"SELECT @groupName || ':one' AS row_key, @groupName || ' item' AS itemName","parameters":[{"name":"groupName","type":"string","defaultValue":"A"}]}]
            """)!.AsArray();
            var project = JsonNode.Parse("""
            {"id":"binding-data","name":"Binding data","revision":0,"parameters":{"machine":"A"},"screens":[{"id":"main","name":"Main","width":800,"height":600,"components":[
              {"id":"outer","type":"template","x":0,"y":0,"width":700,"height":500,"props":{"templateId":"outer","parameterBindings":{"amount":{"expression":"tag","references":{"tag":{"kind":"tag","path":"[default]{machine}/Amount"}}}}}}
            ]}],"templates":[
              {"id":"outer","name":"Outer","width":700,"height":500,"parameters":{"amount":"0"},"parameterTypes":{"amount":"number"},"components":[
                {"id":"groups","type":"repeater","x":0,"y":0,"width":650,"height":450,"props":{"templateId":"group","rowsSource":{"queryId":"groups","rowKey":"row_key","parameterMap":{"groupName":"groupName"},"maxRows":2}}}]},
              {"id":"group","name":"Group","width":600,"height":210,"parameters":{"groupName":"A","amount":"{amount}"},"parameterTypes":{"amount":"number"},"components":[
                {"id":"items","type":"repeater","x":0,"y":0,"width":580,"height":200,"props":{"templateId":"item","rowsSource":{"queryId":"items","rowKey":"row_key","parameterMap":{"itemName":"itemName"},"maxRows":2}}}]},
              {"id":"item","name":"Item","width":280,"height":180,"parameters":{"itemName":"Item"},"components":[
                {"id":"run","type":"button","x":0,"y":0,"width":180,"height":50,"props":{"action":"script","script":"result = parameters"}}]}]}
            """)!.AsObject();
            var workspace = catalog.Create("Binding data", project, queryDefinitions);
            JsonObject Draft() => workspace.Store.GetProject();
            void Invalid(Action<JsonObject> change, string label) { var draft = Draft(); change(draft); Reject(() => workspace.Store.SaveProject(draft), label); }
            foreach (var address in new[] { "[default]{missing}/Amount", "[default]{machine", "[default]A\nAmount", string.Concat(Enumerable.Repeat("{machine}", 17)), new string('x', 1025) })
                Invalid(draft => draft["screens"]![0]!["components"]![0]!["props"]!["parameterBindings"]!["amount"]!["references"]!["tag"]!["path"] = address, "malformed or undeclared indirect tag address");
            foreach (var limit in new JsonNode?[] { JsonValue.Create(0), JsonValue.Create(101), JsonValue.Create(2.5), JsonValue.Create("2"), null })
                Invalid(draft => draft["templates"]![1]!["components"]![0]!["props"]!["rowsSource"]!["maxRows"] = limit?.DeepClone(), "invalid nested query row budget");
            var stamp = workspace.Publication.Publish(workspace.Store, Draft()["revision"]!.GetValue<int>())["publishedAt"]!.GetValue<string>();
            var path = new[] { new InstancePathStep("outer", null), new InstancePathStep("groups", "B"), new InstancePathStep("items", "B:one") };
            var captured = workspace.Publication.GetAction("main", "run", stamp, instancePath: path);
            Check(captured["templateScopes"]!.AsArray().Count == 3 && captured["templateScopes"]![1]!["rowsSource"] is JsonObject && captured["templateScopes"]![2]!["rowsSource"] is JsonObject, "publication reconstructs every nested query boundary");
            var excessive = Draft(); excessive["templates"]![0]!["components"]![0]!["props"]!["rowsSource"]!.AsObject().Remove("maxRows"); excessive["templates"]![1]!["components"]![0]!["props"]!["rowsSource"]!.AsObject().Remove("maxRows");
            var oversized = catalog.Create("Oversized binding data", excessive, queryDefinitions);
            Reject(() => oversized.Publication.Publish(oversized.Store, oversized.Store.GetProject()["revision"]!.GetValue<int>()), "multiplicative query expansion still bounded");
            var pythonPath = OperatingSystem.IsWindows() ? Path.GetFullPath("runtimes/python/windows-x64/python.exe") : "/usr/bin/python3";
            if (!File.Exists(pythonPath)) throw new Exception("Binding reconstruction tests require the bundled Python runtime.");
            using var connectors = new ConnectorService(directory);
            await connectors.CreateSqliteDatabaseAsync(workspace.Store.GetConnection("binding-data"), false, CancellationToken.None);
            using var tags = new TagEngine(catalog.GatewayStore, connectors, NullLogger<TagEngine>.Instance);
            var queries = new QueryExecutor(workspace.Store, connectors);
            var runner = new PythonRunner(tags, queries, workspace.Scripts, new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Python:Executable"] = pythonPath }).Build());
            var reads = new List<string>();
            var actions = new RuntimeActions(workspace.Publication, runner, queries, address => { reads.Add(address); return JsonSerializer.SerializeToElement(12.5); });
            var result = await actions.ExecuteAsync("main", "run", null, null, stamp, CancellationToken.None, instancePath: path);
            Check(result["success"]!.GetValue<bool>() && result["result"]!["groupName"]!.GetValue<string>() == "B" && result["result"]!["itemName"]!.GetValue<string>() == "B item" && result["result"]!["amount"]!.GetValue<double>() == 12.5, "gateway queries each level with reconstructed typed parent context");
            Check(reads.SequenceEqual(new[] { "[default]A/Amount" }), "gateway resolves published indirect tag address independently");
            await RejectAsync(() => actions.ExecuteAsync("main", "run", null, null, stamp, CancellationToken.None, instancePath: [path[0], path[1], new("items", "A:one")]), "forged cross-parent query row identity");
            var denied = new RuntimeActions(workspace.Publication, runner, queries, _ => throw new ArgumentException("Tag read denied"));
            await RejectAsync(() => denied.ExecuteAsync("main", "run", null, null, stamp, CancellationToken.None, instancePath: path), "unavailable tag prevents Python execution");
            await RejectAsync(() => actions.ExecuteAsync("main", "run", new() { ["machine"] = JsonSerializer.SerializeToElement("{recursive}") }, null, stamp, CancellationToken.None, instancePath: path), "recursive tag address values cannot select an action context");
            var wrongRow = new[] { path[0], new InstancePathStep("groups", "deleted"), path[2] };
            await RejectAsync(() => actions.ExecuteAsync("main", "run", null, null, stamp, CancellationToken.None, instancePath: wrongRow), "missing ancestor rejects all descendants");

            var chart = JsonNode.Parse("""{"id":"chart","type":"chart","x":0,"y":0,"width":400,"height":200,"props":{"chart":{"kind":"line","xKey":"x","series":[{"key":"y"}]},"data":{"columns":["x","y"],"rows":[{"x":"A","y":2},{"x":"B","y":null}]},"dataSource":{"queryId":"groups"}}} """)!.AsObject();
            var chartDraft = Draft(); chartDraft["screens"]![0]!["components"]!.AsArray().Add(chart);
            workspace.Store.SaveProject(chartDraft);
            var metadata = workspace.Publication.Publish(workspace.Store, Draft()["revision"]!.GetValue<int>());
            Check(metadata["published"]!.GetValue<bool>(), "dataset query source and nullable saved data publish together");
            Invalid(draft => draft["screens"]![0]!["components"]![1]!["props"]!["data"]!["rows"]![0]!.AsObject().Remove("y"), "incomplete static dataset row");
            Invalid(draft => draft["screens"]![0]!["components"]![1]!["props"]!["dataSource"]!["parameters"] = JsonNode.Parse("""{"bad":{"expression":"tag","references":{"tag":{"kind":"tag","path":"[default]A/Amount"}}}}"""), "dataset query mappings cannot read tags");
            Invalid(draft => draft["screens"]![0]!["components"]![1]!["props"]!["dataSource"]!["queryId"] = "missing", "dataset queries must exist in the project");
        }
        finally { if (Path.GetDirectoryName(directory) != Path.TrimEndingDirectorySeparator(root)) throw new Exception("Unsafe cleanup path."); if (Directory.Exists(directory)) Directory.Delete(directory, true); }
        return passed;
    }
}
