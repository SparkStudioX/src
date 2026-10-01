using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class RuntimePropertyBindingChecks
{
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool condition, string name) { if (!condition) throw new Exception("FAILED: " + name); passed++; }
        void Reject(Action action, string name) { try { action(); } catch (ArgumentException) { passed++; return; } throw new Exception("FAILED to reject: " + name); }
        async Task RejectAsync(Func<Task> action, string name) { try { await action(); } catch (ArgumentException) { passed++; return; } throw new Exception("FAILED to reject: " + name); }
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
        var directory = Path.GetFullPath(Path.Combine(root, "SparkStudio.RuntimeProperties." + Guid.NewGuid().ToString("N")));
        if (Path.GetDirectoryName(directory) != root) throw new Exception("Unsafe test path.");
        try
        {
            var catalog = new ProjectCatalog(directory, new EphemeralDataProtectionProvider());
            var generatedImage = JsonNode.Parse("""
            {"id":"generated-image","name":"Generated image","revision":0,"parameters":{},"screens":[{"id":"welcome","name":"Welcome","width":640,"height":480,"state":{"badgeUrl":{"type":"string","value":""}},"components":[
              {"id":"badge","type":"image","x":0,"y":0,"width":400,"height":300,"props":{"imageUrl":"","fit":"contain","alt":"Generated badge","bindings":{"imageUrl":{"expression":"url","references":{"url":{"kind":"screenState","key":"badgeUrl"}}}}}}
            ]}]}
            """)!.AsObject();
            var imageWorkspace = catalog.Create("Generated image", generatedImage, []);
            Check(imageWorkspace.Store.GetProject()["screens"]![0]!["components"]![0]!["props"]!["imageUrl"]!.GetValue<string>() == "", "generated images save an empty authored URL without local assets");
            void InvalidImage(Action<JsonObject> change, string name)
            {
                var draft = imageWorkspace.Store.GetProject(); change(draft);
                Reject(() => imageWorkspace.Store.SaveProject(draft), name);
            }
            foreach (var url in new[] { "https://example.com/badge.png", "data:image/png;base64,AA==", "javascript:alert(1)", "blob:null/badge", "blob:file:///badge", "blob:http://user:password@localhost/badge", "blob:http://localhost/", "blob:http://localhost/badge?query", "blob:http://localhost/badge#fragment", "blob:http://localhost/bad\nge", new string('x', 4097) })
                InvalidImage(draft => draft["screens"]![0]!["components"]![0]!["props"]!["imageUrl"] = url, "generated image source rejects unsupported literal " + url[..Math.Min(url.Length, 40)]);
            InvalidImage(draft => draft["screens"]![0]!["components"]![0]!["props"]!["imageUrl"] = null, "generated image source rejects null");
            InvalidImage(draft => draft["screens"]![0]!["components"]![0]!["props"]!["bindings"]!["imageUrl"]!["expression"] = "'https://example.com/badge.png'", "generated image source rejects remote binding constants");
            Check(imageWorkspace.Publication.Publish(imageWorkspace.Store, imageWorkspace.Store.GetProject()["revision"]!.GetValue<int>())["published"]!.GetValue<bool>(), "generated image binding publishes without uploading temporary PNG bytes");
            var imagePackage = SparkProjectPackage.Export(imageWorkspace);
            var imageImport = SparkProjectPackage.Import(catalog, imagePackage, "Generated image round trip");
            Check(imageImport.Store.GetProject()["screens"]![0]!["components"]![0]!["props"]!["bindings"]!["imageUrl"] is JsonObject &&
                imageImport.Store.GetProject()["screens"]![0]!["state"]!["badgeUrl"]!["value"]!.GetValue<string>() == "", "generated image binding and empty defaults survive portable import");
            Check(imageImport.Publication.Publish(imageImport.Store, imageImport.Store.GetProject()["revision"]!.GetValue<int>())["published"]!.GetValue<bool>() && SparkProjectPackage.Export(imageImport).Length > 0, "generated image package explicitly publishes and re-exports without assets");
            using (var archive = new ZipArchive(new MemoryStream(imagePackage), ZipArchiveMode.Read))
                Check(!archive.Entries.Any(entry => entry.FullName.StartsWith("assets/", StringComparison.Ordinal)), "generated image package never captures transient browser image bytes");
            byte[] ImagePackageWithRemoteUrl()
            {
                using var output = new MemoryStream();
                using (var archive = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
                using (var original = new ZipArchive(new MemoryStream(imagePackage), ZipArchiveMode.Read))
                    foreach (var entry in original.Entries)
                    {
                        using var source = entry.Open(); using var destination = archive.CreateEntry(entry.FullName).Open();
                        if (entry.FullName != "project.json") { source.CopyTo(destination); continue; }
                        var draft = JsonNode.Parse(source)!.AsObject(); draft["screens"]![0]!["components"]![0]!["props"]!["imageUrl"] = "https://example.com/badge.png";
                        destination.Write(Encoding.UTF8.GetBytes(draft.ToJsonString()));
                    }
                return output.ToArray();
            }
            Reject(() => SparkProjectPackage.Import(catalog, ImagePackageWithRemoteUrl()), "portable import rejects generated image remote URLs");
            var unavailableImage = imageWorkspace.Store.GetProject();
            unavailableImage["screens"]![0]!["components"]![0]!["props"]!.AsObject().Remove("bindings");
            imageWorkspace.Store.SaveProject(unavailableImage);
            Reject(() => imageWorkspace.Publication.Publish(imageWorkspace.Store, imageWorkspace.Store.GetProject()["revision"]!.GetValue<int>()), "unconfigured image without an asset or generated binding still cannot publish");
            var storedFallback = imageImport.Store.GetProject(); storedFallback["screens"]![0]!["components"]![0]!["props"]!["assetId"] = new string('a', 64);
            imageImport.Store.SaveProject(storedFallback);
            Reject(() => imageImport.Publication.Publish(imageImport.Store, imageImport.Store.GetProject()["revision"]!.GetValue<int>()), "a generated binding does not bypass stored fallback asset validation");
            catalog.GatewayStore.SaveConnection(new JsonObject { ["id"] = "binding-db", ["name"] = "Binding test", ["type"] = "sqlite", ["database"] = "bindings.db" });
            var queries = JsonNode.Parse("""
            [{"id":"amount","name":"Amount","connectionId":"binding-db","sql":"SELECT @amount + 3 AS amount","parameters":[{"name":"amount","type":"number"}]}]
            """)!.AsArray();
            var project = JsonNode.Parse("""
            {"id":"bindings","name":"Runtime bindings","revision":0,"parameters":{},"screens":[{"id":"main","name":"Main","width":1000,"height":800,"state":{"extra":{"type":"number","value":0}},"components":[
              {"id":"input","type":"numberInput","x":0,"y":0,"width":100,"height":40,"props":{"fieldKey":"amount","defaultValue":4,"min":0,"max":100}},
              {"id":"source","type":"label","x":0,"y":50,"width":100,"height":40,"props":{"customProperties":{"base":{"type":"number","value":1},"derived":{"type":"number","value":0},"tag":{"type":"number","value":0},"query":{"type":"number","value":0}},"bindings":{
                "customProperties.base.value":{"expression":"input + extra","references":{"input":{"kind":"input","key":"amount"},"extra":{"kind":"screenState","key":"extra"}}},
                "customProperties.derived.value":{"expression":"base * 2","references":{"base":{"kind":"custom","key":"base"}}},
                "customProperties.tag.value":{"expression":"tag","references":{"tag":{"kind":"tag","path":"[default]Amount"}}}
              },"queryBindings":{"customProperties.query.value":{"queryId":"amount","column":"amount","parameters":{"amount":{"expression":"derived","references":{"derived":{"kind":"custom","key":"derived"}}}}}}}},
              {"id":"instance","type":"template","x":0,"y":100,"width":200,"height":100,"props":{"templateId":"card","parameterBindings":{"amount":{"expression":"derived + tag + query","references":{"derived":{"kind":"custom","componentId":"source","key":"derived"},"tag":{"kind":"custom","componentId":"source","key":"tag"},"query":{"kind":"custom","componentId":"source","key":"query"}}}}}},
              {"id":"chart","type":"chart","x":250,"y":0,"width":300,"height":200,"props":{"chart":{"kind":"line","xKey":"x","series":[{"key":"y"}]},"data":{"columns":["x","y"],"rows":[{"x":"A","y":1}]},"bindings":{"chart.yMin":{"expression":"10","references":{}},"chart.yMax":{"expression":"20","references":{}},"chart.series":{"expression":"'[{\"key\":\"y\",\"label\":\"Live\"}]'","references":{}}}}},
              {"id":"text","type":"textInput","x":0,"y":220,"width":200,"height":40,"props":{"fieldKey":"text","defaultValue":"","bindings":{"validation.required":{"expression":"true","references":{}},"validation.message":{"expression":"'Enter text'","references":{}}}}},
              {"id":"pipe","type":"pipe","x":300,"y":220,"width":200,"height":40,"props":{"bindings":{"points":{"expression":"'[{\"x\":0,\"y\":50},{\"x\":100,\"y\":50}]'","references":{}}}}}
            ]}],"templates":[{"id":"card","name":"Card","width":200,"height":100,"parameters":{"amount":"0"},"parameterTypes":{"amount":"number"},"components":[{"id":"run","type":"button","x":0,"y":0,"width":150,"height":40,"props":{"action":"script","script":"result = parameters"}}]}]}
            """)!.AsObject();
            var workspace = catalog.Create("Runtime bindings", project, queries);
            JsonObject Draft() => workspace.Store.GetProject();
            JsonObject Component(JsonObject draft, string id) => draft["screens"]![0]!["components"]!.AsArray().OfType<JsonObject>().Single(item => item["id"]!.GetValue<string>() == id);
            void Invalid(Action<JsonObject> change, string name) { var draft = Draft(); change(draft); Reject(() => workspace.Store.SaveProject(draft), name); }
            JsonObject Constant(string expression) => new() { ["expression"] = expression, ["references"] = new JsonObject() };
            Check(Draft()["screens"]![0]!["components"]!.AsArray().Count == 6, "nested, structured and custom binding definitions save");
            foreach (var target in new[] { "unknown", "script", "fieldKey", "defaultValue", "templateId", "queryId", "props.text", "chart.__proto__.key", "customProperties.base.type", "customProperties.missing.value" })
                Invalid(draft => Component(draft, "source")["props"]!["bindings"]![target] = Constant("1"), "reject forbidden or unknown target " + target);
            Invalid(draft => Component(draft, "source")["props"]!["bindings"]!["chart.yMin"] = Constant("1"), "nested target belongs to its component family");
            foreach (var (target, expression) in new[] { ("enabled", "1"), ("width", "0"), ("color", "'red'"), ("customProperties.base.value", "'wrong'") })
                Invalid(draft => Component(draft, "source")["props"]!["bindings"]![target] = Constant(expression), "constant target type and bounds " + target);
            Invalid(draft => Component(draft, "chart")["props"]!["bindings"]!["chart.yMax"] = Constant("5"), "combined chart range rejects inverted bounds");
            Invalid(draft => Component(draft, "chart")["props"]!["bindings"]!["chart.series"] = Constant("'[{\"key\":\"missing\"}]'"), "structured chart series preserve dataset column contract");
            Invalid(draft => Component(draft, "pipe")["props"]!["bindings"]!["points"] = Constant("'[{\"x\":0,\"y\":0},{\"x\":0,\"y\":0}]'"), "structured drawing preserves distinct points");
            Invalid(draft => Component(draft, "pipe")["props"]!["bindings"]!["points"] = Constant("'[{\"x\":0,\"y\":0,\"constructor\":1},{\"x\":100,\"y\":0}]'"), "structured unsafe keys rejected");
            Invalid(draft => Component(draft, "text")["props"]!["bindings"]!["validation.minLength"] = Constant("4097"), "nested input bounds checked");
            Invalid(draft => Component(draft, "source")["props"]!["bindings"]!["customProperties.base.value"] = JsonNode.Parse("""{"expression":"self","references":{"self":{"kind":"custom","key":"derived"}}}"""), "recursive custom cycle rejected on save");
            Invalid(draft => Component(draft, "source")["props"]!["queryBindings"]!["customProperties.query.value"]!["parameters"]!["amount"]!["references"]!["derived"]!["key"] = "query", "query dependency custom cycle rejected");
            Invalid(draft => Component(draft, "source")["props"]!["queryBindings"]!["customProperties.query.value"]!["parameters"]!["amount"]!["references"]!["derived"]!["key"] = "tag", "transitive query tag reference rejected");
            Invalid(draft => Component(draft, "source")["props"]!["queryBindings"]!["customProperties.query.value"]!["transform"] = "'wrong'", "query custom transform preserves declared type");
            Invalid(draft => Component(draft, "source")["props"]!["componentEvents"] = JsonNode.Parse("""{"propertyChange":{"language":"python","code":"result = 1","properties":["customProperties.base.value"]}}"""), "new targets do not implicitly expand scalar Python event authority");
            Invalid(draft =>
            {
                draft["screens"]![0]!["components"]!.AsArray().Add(JsonNode.Parse("""{"id":"secret","type":"passwordInput","x":0,"y":0,"width":100,"height":30,"props":{"fieldKey":"secret","defaultValue":""}}"""));
                Component(draft, "source")["props"]!["customProperties"]!["base"] = JsonNode.Parse("""{"type":"string","value":""}""");
                Component(draft, "source")["props"]!["bindings"]!["customProperties.base.value"] = JsonNode.Parse("""{"expression":"secret","references":{"secret":{"kind":"input","key":"secret"}}}""");
            }, "custom references cannot launder passwords into parameter bindings");

            var layouts = Draft();
            layouts["screens"]![0]!["components"]!.AsArray().Add(JsonNode.Parse("""{"id":"container","type":"viewContainer","x":0,"y":300,"width":400,"height":200,"props":{"viewLayout":{"kind":"split","orientation":"horizontal","ratio":50,"panes":[{"id":"left","label":"Left","templateId":"card"},{"id":"right","label":"Right","templateId":"card"}]},"bindings":{"viewLayout.panes.0.label":{"expression":"'Updated'","references":{}},"viewLayout.ratio":{"expression":"65","references":{}}}}}"""));
            workspace.Store.SaveProject(layouts);
            Check(Component(Draft(), "container")["props"]!["bindings"]!["viewLayout.panes.0.label"] is JsonObject, "existing pane labels support indexed nested targets");
            foreach (var path in new[] { "viewLayout.panes.2.label", "viewLayout.panes.00.label", "viewLayout.panes.0.templateId", "viewLayout.panes.0.size" })
                Invalid(draft => Component(draft, "container")["props"]!["bindings"]![path] = Constant("'Invalid'"), "pane bindings cannot add panes, mutate identity or use inapplicable layout fields " + path);
            var queryChart = Draft();
            Component(queryChart, "chart")["props"]!.AsObject().Remove("bindings");
            Component(queryChart, "chart")["props"]!["queryBindings"] = JsonNode.Parse("""{"chart.yMin":{"queryId":"amount","column":"amount","parameters":{"amount":{"expression":"1","references":{}}},"transform":"10"},"chart.yMax":{"queryId":"amount","column":"amount","parameters":{"amount":{"expression":"1","references":{}}},"transform":"20"}}""");
            workspace.Store.SaveProject(queryChart); passed++;
            Invalid(draft => Component(draft, "chart")["props"]!["queryBindings"]!["chart.yMax"]!["transform"] = "5", "combined query transform constants preserve nested chart range");

            var package = SparkProjectPackage.Export(workspace);
            var imported = SparkProjectPackage.Import(catalog, package, "Imported bindings");
            Check(Component(imported.Store.GetProject(), "source")["props"]!["bindings"]!["customProperties.base.value"] is JsonObject, "valid runtime bindings survive package import");
            byte[] MutatedPackage(Action<JsonObject> change)
            {
                using var output = new MemoryStream();
                using (var archive = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
                using (var original = new ZipArchive(new MemoryStream(package), ZipArchiveMode.Read))
                    foreach (var entry in original.Entries)
                    {
                        using var source = entry.Open(); using var destination = archive.CreateEntry(entry.FullName).Open();
                        if (entry.FullName != "project.json") { source.CopyTo(destination); continue; }
                        var draft = JsonNode.Parse(source)!.AsObject(); change(draft);
                        destination.Write(Encoding.UTF8.GetBytes(draft.ToJsonString()));
                    }
                return output.ToArray();
            }
            Reject(() => SparkProjectPackage.Import(catalog, MutatedPackage(draft => Component(draft, "source")["props"]!["bindings"]!["script"] = Constant("'bad'"))), "package import rejects forbidden targets");
            Reject(() => SparkProjectPackage.Import(catalog, MutatedPackage(draft => Component(draft, "text")["props"]!["bindings"]!["validation.required"] = Constant("1"))), "package import rejects invalid constant types");
            Reject(() => SparkProjectPackage.Import(catalog, MutatedPackage(draft => Component(draft, "source")["props"]!["bindings"]!["customProperties.base.value"] = JsonNode.Parse("""{"expression":"self","references":{"self":{"kind":"custom","key":"derived"}}}"""))), "package import rejects custom dependency cycles");

            var sourceRoot = new DirectoryInfo(AppContext.BaseDirectory);
            while (sourceRoot is not null && !File.Exists(Path.Combine(sourceRoot.FullName, "examples", "runtime-property-bindings.json"))) sourceRoot = sourceRoot.Parent;
            if (sourceRoot is null) throw new Exception("The runtime bindings workshop was not found.");
            var workshop = JsonNode.Parse(File.ReadAllText(Path.Combine(sourceRoot.FullName, "examples", "runtime-property-bindings.json")))!.AsObject();
            var workshopWorkspace = catalog.Create("Runtime bindings workshop", workshop, []);
            var workshopPackage = SparkProjectPackage.Export(workshopWorkspace);
            var workshopImport = SparkProjectPackage.Import(catalog, workshopPackage, "Workshop round trip");
            var workshopPublication = workshopImport.Publication.Publish(workshopImport.Store, workshopImport.Store.GetProject()["revision"]!.GetValue<int>());
            Check(workshopPublication["published"]!.GetValue<bool>() && SparkProjectPackage.Export(workshopImport).Length > 0, "authored workshop imports, explicitly publishes and re-exports");

            var stamp = workspace.Publication.Publish(workspace.Store, Draft()["revision"]!.GetValue<int>())["publishedAt"]!.GetValue<string>();
            var captured = workspace.Publication.GetAction("main", "run", stamp, instanceId: "instance");
            var scope = captured["templateScopes"]![0]!.AsObject();
            Check(scope["bindingInputDefinitions"]!.AsArray().Count == 1 && scope["bindingStateDefinitions"]!["screen"]!["extra"]!.GetValue<string>() == "number", "publication captures indirect custom inputs and state");
            using var connectors = new ConnectorService(directory);
            await connectors.CreateSqliteDatabaseAsync(workspace.Store.GetConnection("binding-db"), false, CancellationToken.None);
            using var tags = new TagEngine(catalog.GatewayStore, connectors, NullLogger<TagEngine>.Instance);
            var queryExecutor = new QueryExecutor(workspace.Store, connectors);
            var python = new PythonRunner(tags, queryExecutor, workspace.Scripts, new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Python:Executable"] = TestEnvironment.PythonExecutable() }).Build());
            var actions = new RuntimeActions(workspace.Publication, python, queryExecutor, _ => JsonSerializer.SerializeToElement(7));
            Dictionary<string, JsonElement>[] inputs = [new() { ["amount"] = JsonSerializer.SerializeToElement(4) }];
            ParameterBindingState[] state = [new() { ["screen"] = new() { ["extra"] = JsonSerializer.SerializeToElement(1) } }];
            var result = await actions.ExecuteAsync("main", "run", null, null, stamp, CancellationToken.None, instanceId: "instance", bindingInputs: inputs, bindingState: state);
            Check(result["success"]!.GetValue<bool>() && result["result"]!["amount"]!.GetValue<double>() == 30, "gateway recursively reconstructs expression, query, input, state and tag custom values");
            await RejectAsync(() => actions.ExecuteAsync("main", "run", null, null, stamp, CancellationToken.None, instanceId: "instance", bindingInputs: inputs), "missing indirect state never falls back to saved custom value");
            var denied = new RuntimeActions(workspace.Publication, python, queryExecutor, _ => throw new ArgumentException("Tag unavailable"));
            await RejectAsync(() => denied.ExecuteAsync("main", "run", null, null, stamp, CancellationToken.None, instanceId: "instance", bindingInputs: inputs, bindingState: state), "missing indirect tag prevents action execution");
            var invalidTag = new RuntimeActions(workspace.Publication, python, queryExecutor, _ => JsonSerializer.SerializeToElement("wrong"));
            await RejectAsync(() => invalidTag.ExecuteAsync("main", "run", null, null, stamp, CancellationToken.None, instanceId: "instance", bindingInputs: inputs, bindingState: state), "runtime custom values preserve declared native types");
        }
        finally
        {
            if (Path.GetDirectoryName(directory) != root) throw new Exception("Unsafe cleanup path.");
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
        return passed;
    }
}
