using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class PythonUiChecks
{
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool condition, string description) { if (!condition) throw new Exception("FAILED: " + description); passed++; }
        void Reject(Action action, string description)
        {
            try { action(); } catch (ArgumentException) { passed++; return; }
            throw new Exception("FAILED to reject: " + description);
        }
        var temporaryRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
        var directory = Path.GetFullPath(Path.Combine(temporaryRoot, "SparkStudio.PythonUi." + Guid.NewGuid().ToString("N")));
        if (Path.GetDirectoryName(directory) != temporaryRoot) throw new Exception("Unsafe test directory.");
        try
        {
            var project = Project();
            var catalog = new ProjectCatalog(directory, new EphemeralDataProtectionProvider());
            var workspace = catalog.Create("Python UI tests", project);
            workspace.Publication.Publish(workspace.Store, workspace.Store.GetProject()["revision"]!.GetValue<int>());
            var publication = workspace.Publication.GetProject();
            var stamp = publication["publishedAt"]!.GetValue<string>();
            var description = workspace.Publication.GetAction("main", "run", stamp)["uiContext"]!.AsObject();
            PythonUiContext Context(JsonObject? snapshot = null) => new(description, snapshot);
            var ui = Context();
            Check(ui.GetState("screen", "title").GetValue<string>() == "Main", "missing snapshot uses published screen defaults");
            Check(ui.GetState("session", "title").GetValue<string>() == "Session", "session defaults are separate");
            Check(ui.GetProperty("direct-title", "text")!.GetValue<string>() == "Original", "property reads authored text");
            Check(ui.GetProperty("direct-title", "enabled")!.GetValue<bool>() && ui.GetProperty("direct-title", "visible")!.GetValue<bool>(), "missing flags default true");
            Check(ui.GetProperty("direct-title", "fontSize") is null, "absent optional visual values read as null");
            Reject(() => ui.GetState("instance", "title"), "root context has no private instance state");
            Reject(() => ui.GetState("screen", "unknown"), "undeclared state read");
            Reject(() => ui.SetState("screen", "title", JsonValue.Create(42)), "state type mismatch");
            Reject(() => ui.SetState("screen", "title", JsonValue.Create(new string('x', 4097))), "state text bound");
            Reject(() => ui.SetState("screen", "count", JsonValue.Create(9007199254740992L)), "unsafe numeric state");
            foreach (var id in new[] { "foreign", "secret" })
            {
                Reject(() => ui.GetProperty(id, "text"), "forbidden property read " + id);
                Reject(() => ui.SetProperty(id, "text", JsonValue.Create("x")), "forbidden property write " + id);
            }
            foreach (var id in new[] { "panel", "rows" })
            {
                ui.SetProperty(id, "text", JsonValue.Create("Wrapper"));
                Check(ui.GetProperty(id, "text")!.GetValue<string>() == "Wrapper", "same-form wrapper presentation property " + id);
                foreach (var property in new[] { "templateId", "rows", "parameters", "children" }) Reject(() => ui.GetProperty(id, property), "wrapper structural property " + property);
            }
            foreach (var property in new[] { "x", "value", "script", "unknown" }) Reject(() => ui.GetProperty("direct-title", property), "unsupported property " + property);
            Reject(() => ui.GetProperty("bound-title", "text"), "expression-bound property read");
            Reject(() => ui.SetProperty("bound-title", "text", JsonValue.Create("x")), "expression-bound property write");
            var queryDescription = description.DeepClone().AsObject();
            queryDescription["components"]!.AsArray().OfType<JsonObject>().First(item => item["id"]!.GetValue<string>() == "direct-title")["props"]!["queryBindings"] = new JsonObject { ["text"] = new JsonObject() };
            var queryUi = new PythonUiContext(queryDescription);
            Reject(() => queryUi.GetProperty("direct-title", "text"), "query-bound property read");
            Reject(() => queryUi.SetProperty("direct-title", "text", JsonValue.Create("x")), "query-bound property write");
            foreach (var (property, value) in new (string, JsonNode?)[] { ("text", null), ("text", JsonValue.Create(42)), ("text", JsonValue.Create(new string('x', 4097))), ("enabled", JsonValue.Create("true")), ("color", JsonValue.Create("red")), ("borderWidth", JsonValue.Create(33)), ("fontSize", JsonValue.Create(0)), ("fontSize", JsonValue.Create(257)) })
                Reject(() => ui.SetProperty("direct-title", property, value), "invalid " + property + " value");
            foreach (var (property, value) in new (string, JsonNode)[] { ("color", JsonValue.Create("#abC")), ("backgroundColor", JsonValue.Create("#abcd")), ("foregroundColor", JsonValue.Create("#112233")), ("borderColor", JsonValue.Create("#11223344")), ("borderWidth", JsonValue.Create(32)), ("fontSize", JsonValue.Create(256)), ("enabled", JsonValue.Create(false)), ("visible", JsonValue.Create(false)) })
            { ui.SetProperty("direct-title", property, value); Check(JsonNode.DeepEquals(ui.GetProperty("direct-title", property), value), "supported property read-own-write " + property); }

            foreach (var mutate in new Action<JsonObject>[] {
                snapshot => snapshot["extra"] = true,
                snapshot => snapshot.Remove("state"), snapshot => snapshot["state"] = null,
                snapshot => snapshot["properties"] = new JsonArray(), snapshot => snapshot["state"]!["session"] = null,
                snapshot => snapshot["state"]!.AsObject().Remove("screen"), snapshot => snapshot["state"]!["instance"] = new JsonObject(),
                snapshot => snapshot["state"]!["screen"]!["unknown"] = "x", snapshot => snapshot["state"]!["screen"]!["title"] = 1,
                snapshot => snapshot["properties"]!["foreign"] = new JsonObject(), snapshot => snapshot["properties"]!["direct-title"] = new JsonArray(),
                snapshot => snapshot["properties"]!["bound-title"] = new JsonObject { ["text"] = "x" },
                snapshot => snapshot["properties"]!["direct-title"] = new JsonObject { ["color"] = "red" }
            }) { var snapshot = Snapshot(); mutate(snapshot); Reject(() => Context(snapshot), "invalid UI snapshot"); }
            var validSnapshot = Snapshot(); validSnapshot["state"]!["screen"]!["title"] = "Current";
            validSnapshot["properties"]!["direct-title"] = new JsonObject { ["text"] = "Previous override" };
            var captured = Context(validSnapshot);
            validSnapshot["state"]!["screen"]!["title"] = "Mutated input";
            Check(captured.GetState("screen", "title").GetValue<string>() == "Current" && captured.GetProperty("direct-title", "text")!.GetValue<string>() == "Previous override", "validated snapshot is detached and retains previous overrides");
            var emojiSnapshot = Snapshot();
            var emoji = string.Concat(Enumerable.Repeat("\U0001f600", 1024));
            for (var i = 0; i < 60; i++) emojiSnapshot["properties"]!["label" + i] = new JsonObject { ["text"] = emoji };
            Context(emojiSnapshot); passed++;
            for (var i = 60; i < 64; i++) emojiSnapshot["properties"]!["label" + i] = new JsonObject { ["text"] = emoji };
            Reject(() => Context(emojiSnapshot), "snapshot 256KiB UTF-8 limit with supplementary characters");

            var effects = Context();
            effects.SetState("screen", "title", JsonValue.Create("First")); effects.SetState("screen", "title", JsonValue.Create("Last"));
            effects.SetProperty("direct-title", "text", JsonValue.Create("One")); effects.SetProperty("direct-title", "text", JsonValue.Create("Two"));
            Check(effects.GetState("screen", "title").GetValue<string>() == "Last" && effects.GetProperty("direct-title", "text")!.GetValue<string>() == "Two", "staged state and properties support read-own-writes");
            var completed = PythonUiContext.CompleteResponse(new JsonObject { ["success"] = true, ["uiEffects"] = new JsonArray("forged") }, effects);
            Check(completed["uiEffects"]!.AsArray().Count == 2 && completed["uiEffects"]![0]!["value"]!.GetValue<string>() == "Last", "repeat targets coalesce and worker effects are replaced");
            var noContext = PythonUiContext.CompleteResponse(new JsonObject { ["success"] = true, ["uiEffects"] = new JsonArray("forged") }, null);
            Check(!noContext.ContainsKey("uiEffects"), "worker effects stripped without UI context");
            effects = Context(); effects.SetState("screen", "title", JsonValue.Create("Lost"));
            Check(!PythonUiContext.CompleteResponse(new JsonObject { ["success"] = false, ["uiEffects"] = new JsonArray("forged") }, effects).ContainsKey("uiEffects"), "failed responses discard all effects");
            Check(PythonUiContext.CompleteResponse(new JsonObject { ["success"] = true }, effects)["uiEffects"]!.AsArray().Count == 0, "discarded effects cannot leak into a later completion");
            var many = Context();
            for (var i = 0; i < 128; i++) many.SetProperty("label" + i, "text", JsonValue.Create("x"));
            Reject(() => many.SetProperty("label128", "text", JsonValue.Create("x")), "effect target limit");
            Check(many.GetProperty("label128", "text")!.GetValue<string>() == "Original", "rejected effect does not mutate staged state");
            Check(PythonUiContext.CompleteResponse(new JsonObject { ["success"] = true }, many)["uiEffects"]!.AsArray().Count == 128, "128 effects accepted exactly");
            var large = Context();
            for (var i = 0; i < 15; i++) large.SetProperty("label" + i, "text", JsonValue.Create(emoji));
            Reject(() => large.SetProperty("label15", "text", JsonValue.Create(emoji)), "effect 64KiB UTF-8 limit");

            var nestedDescription = workspace.Publication.GetAction("main", "run", stamp, instanceId: "panel")["uiContext"]!.AsObject();
            var nested = new PythonUiContext(nestedDescription);
            Check(nested.GetState("instance", "title").GetValue<string>() == "Local" && nested.GetState("screen", "title").GetValue<string>() == "Main", "template instance and containing screen declarations captured separately");
            Reject(() => nested.GetProperty("root-only", "text"), "nested scope cannot access root properties");
            var row = new PythonUiContext(workspace.Publication.GetAction("main", "run", stamp, instanceId: "rows", rowId: "r1")["uiContext"]!.AsObject());
            row.SetState("instance", "title", JsonValue.Create("Row one"));
            Check(new PythonUiContext(workspace.Publication.GetAction("main", "run", stamp, instanceId: "rows", rowId: "r2")["uiContext"]!.AsObject()).GetState("instance", "title").GetValue<string>() == "Local", "row contexts retain independent state");
            var preview = PythonUiContext.ForPreview(workspace.Store, new JsonObject { ["screenId"] = "main", ["componentId"] = "run" }, null)!;
            Check(preview.WorkerContext()["selfId"]!.GetValue<string>() == "run", "Preview resolves saved button identity");
            var standalone = PythonUiContext.ForPreview(workspace.Store, new JsonObject { ["templateId"] = "panel", ["componentId"] = "run" }, null)!;
            Check(standalone.GetState("instance", "title").GetValue<string>() == "Local", "standalone template Preview includes private state");
            Reject(() => standalone.GetState("screen", "title"), "standalone template Preview does not invent containing screen state");
            Reject(() => PythonUiContext.ForPreview(workspace.Store, new JsonObject { ["screenId"] = "main", ["templateId"] = "panel", ["componentId"] = "run" }, null), "ambiguous Preview owner");
            Reject(() => PythonUiContext.ForPreview(workspace.Store, new JsonObject { ["screenId"] = "main", ["componentId"] = "missing" }, null), "unsaved Preview component");
            Reject(() => PythonUiContext.ForPreview(workspace.Store, null, Snapshot()), "UI snapshot without Preview identity");
            Check(PythonUiContext.ForPreview(workspace.Store, null, null) is null, "generic console has no UI context");
            Reject(() => ui.Dispatch("ui.setState", new JsonObject { ["scope"] = "screen", ["key"] = "title", ["value"] = "x", ["selfId"] = "forged" }), "RPC cannot forge UI identity");

            var pythonPath = Path.GetFullPath(Path.Combine(Environment.CurrentDirectory, "runtimes", "python", "windows-x64", "python.exe"));
            if (!OperatingSystem.IsWindows()) pythonPath = "/usr/bin/python3";
            if (File.Exists(pythonPath))
            {
                using var connectors = new ConnectorService(directory);
                using var tags = new TagEngine(catalog.GatewayStore, connectors, NullLogger<TagEngine>.Instance);
                var queries = new QueryExecutor(workspace.Store, connectors);
                var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Python:Executable"] = pythonPath }).Build();
                var runner = new PythonRunner(tags, queries, workspace.Scripts, configuration);
                Task<JsonObject> Run(string code, PythonUiContext? context = null, int timeout = 10000) => runner.RunWithLibrariesAsync(code, null, null, new Dictionary<string, string>(), CancellationToken.None, uiContext: context, timeoutMs: timeout);
                var execution = await Run("""
                assert self.id == 'run' and self.name == 'run'
                assert self.parent.id == 'main'
                assert self.parent.custom.title == 'Main'
                self.parent.custom.title = 'Changed state'
                assert self.parent.custom['title'] == 'Changed state'
                self.getSibling('direct-title').props.text = 'Changed text'
                assert self.parent.getChild('direct-title').props['text'] == 'Changed text'
                system.ui.setProperty('direct-title', 'visible', False)
                assert system.ui.getProperty('direct-title', 'visible') is False
                system.ui.setState('session', 'title', 'Changed session')
                result = system.ui.getState('session', 'title')
                """, Context());
                Check(execution["success"]!.GetValue<bool>() && execution["result"]!.GetValue<string>() == "Changed session" && execution["uiEffects"]!.AsArray().Count == 4, "actual CPython proxies read, write and return validated effects");
                execution = await Run("self.text = 'hi'; assert self.text == 'hi'; assert self.props.text == 'hi'; result = self.id", Context());
                Check(execution["success"]!.GetValue<bool>() && execution["result"]!.GetValue<string>() == "run" &&
                    execution["uiEffects"]!.AsArray().Count == 1 && execution["uiEffects"]![0]!["componentId"]!.GetValue<string>() == "run" && execution["uiEffects"]![0]!["value"]!.GetValue<string>() == "hi",
                    "self.text alias changes the clicked button through a validated property effect");
                execution = await Run("""
                self.text = 'first'
                self.props.text = 'second'
                assert self.text == 'second'
                self.text = 'final'
                assert self.props.text == 'final'
                self.getSibling('direct-title').text = 'Sibling changed'
                assert self.parent.getChild('direct-title').text == 'Sibling changed'
                assert self.getSibling('direct-title').props.text == 'Sibling changed'
                """, Context());
                Check(execution["success"]!.GetValue<bool>() && execution["uiEffects"]!.AsArray().Count == 2 && execution["uiEffects"]![0]!["value"]!.GetValue<string>() == "final",
                    "direct and props aliases read each other's writes and coalesce by component target");
                execution = await Run("""
                values = {'text': 'Title', 'enabled': False, 'visible': False, 'color': '#abc',
                          'backgroundColor': '#abcd', 'foregroundColor': '#123456', 'borderColor': '#12345678',
                          'borderWidth': 32, 'fontSize': 256}
                for property, value in values.items():
                    setattr(self, property, value)
                    assert getattr(self, property) == value
                    assert self.props[property] == value
                assert self.id == 'run' and self.name == 'run' and self.parent.id == 'main'
                """, Context());
                Check(execution["success"]!.GetValue<bool>() && execution["uiEffects"]!.AsArray().Count == 9, "every supported UI property has a consistent direct alias");
                foreach (var attribute in new[] { "id", "name", "props", "parent", "getSibling", "_component_id", "_parent", "__class__" })
                {
                    execution = await Run("setattr(self, '" + attribute + "', 'forbidden')", Context());
                    Check(!execution["success"]!.GetValue<bool>() && execution["stderr"]!.GetValue<string>().Contains("read-only", StringComparison.Ordinal) && !execution.ContainsKey("uiEffects"), "read-only UI alias assignment " + attribute);
                }
                foreach (var code in new[] { "self.unknown = 'x'", "result = self.unknown" })
                {
                    execution = await Run(code, Context());
                    Check(!execution["success"]!.GetValue<bool>() && execution["stderr"]!.GetValue<string>().Contains("Unknown UI component", StringComparison.Ordinal) && !execution.ContainsKey("uiEffects"), "unknown UI aliases fail instead of creating worker attributes");
                }
                foreach (var code in new[] { "self.getSibling('bound-title').text = 'Denied'", "result = self.getSibling('bound-title').text" })
                {
                    execution = await Run(code, Context());
                    Check(!execution["success"]!.GetValue<bool>() && execution["stderr"]!.GetValue<string>().Contains("has a binding", StringComparison.Ordinal) && !execution.ContainsKey("uiEffects"), "direct aliases obey expression binding read/write protection");
                }
                execution = await Run("self.getSibling('direct-title').text = 'Denied'", new PythonUiContext(queryDescription));
                Check(!execution["success"]!.GetValue<bool>() && !execution.ContainsKey("uiEffects"), "direct aliases obey query binding protection");
                execution = await Run("self.fontSize = 0", Context());
                Check(!execution["success"]!.GetValue<bool>() && !execution.ContainsKey("uiEffects"), "direct aliases retain server property value validation");
                execution = await Run("self.text = 'Discard'; self.getSibling('direct-title').text = 'Discard sibling'; raise RuntimeError('intentional')", Context());
                Check(!execution["success"]!.GetValue<bool>() && !execution.ContainsKey("uiEffects"), "script failure discards all staged direct alias effects");
                execution = await Run("""
                custom = self.parent.custom
                custom._scope = 'declared value'
                assert custom._scope == 'declared value'
                assert custom['_scope'] == 'declared value'
                custom['_scope'] = 'second value'
                assert custom._scope == 'second value'
                assert system.ui.getState('screen', '_scope') == 'second value'
                assert custom.__class__.__name__ == 'UiState'
                assert isinstance(custom.__dict__, dict)
                assert custom['__class__'] == 'Declared class value'
                assert custom['__dict__'] == 'Declared dictionary value'
                result = system.ui.getState('screen', '__class__')
                """, Context());
                Check(execution["success"]!.GetValue<bool>() && execution["result"]!.GetValue<string>() == "Declared class value" &&
                    execution["uiEffects"]!.AsArray().Count == 1 && execution["uiEffects"]![0]!["value"]!.GetValue<string>() == "second value",
                    "declared _scope works through dot and mapping while Python introspection remains intact");
                foreach (var value in new[] { "object()", "__import__('datetime').datetime.now()", "float('nan')", "float('inf')", "9007199254740992" })
                {
                    execution = await Run("system.ui.setState('screen', 'title', " + value + ")", Context());
                    Check(!execution["success"]!.GetValue<bool>() && !execution.ContainsKey("uiEffects"), "direct Python setter rejects nonscalar or inexact value " + value);
                    execution = await Run("system.ui.setProperty('direct-title', 'text', " + value + ")", Context());
                    Check(!execution["success"]!.GetValue<bool>() && !execution.ContainsKey("uiEffects"), "direct Python property setter rejects nonscalar or inexact value " + value);
                }
                execution = await Run("system.ui.setState('screen', 'title', str(__import__('datetime').datetime.now()))", Context());
                Check(execution["success"]!.GetValue<bool>() && execution["uiEffects"]!.AsArray().Count == 1, "explicit Python conversion to text remains valid");
                execution = await Run("self.parent.custom.title = 'Nested'; result = system.ui.getState('instance', 'title')", new PythonUiContext(nestedDescription));
                Check(execution["success"]!.GetValue<bool>() && execution["uiEffects"]![0]!["scope"]!.GetValue<string>() == "instance", "Python parent.custom maps to private template state");
                foreach (var code in new[] { "self.parent.custom.title = 'x'", "system.ui.getState('screen', 'title')", "self.text = 'x'" })
                { execution = await Run(code); Check(!execution["success"]!.GetValue<bool>() && execution["stderr"]!.GetValue<string>().Contains("UI helpers are available only", StringComparison.Ordinal) && !execution.ContainsKey("uiEffects"), "console UI access fails usefully"); }
                execution = await Run("system.ui.setState('screen', 'title', 'Lost'); system.tag.writeBlocking(['[default]Setpoints/TargetSpeed'], [88]); raise RuntimeError('deliberate')", Context());
                Check(!execution["success"]!.GetValue<bool>() && !execution.ContainsKey("uiEffects") && Convert.ToDouble(tags.Read(["[default]Setpoints/TargetSpeed"], null)[0].Value) == 88, "script failure discards UI effects but preserves existing tag side effects");
                execution = await Run("system.ui.setState('screen', 'title', 'Late'); import time; time.sleep(1)", Context(), 100);
                Check(!execution["success"]!.GetValue<bool>() && !execution.ContainsKey("uiEffects"), "script timeout discards staged UI effects");
                execution = await Run("self.getSibling('bound-title').props.text = 'Denied'", Context());
                Check(!execution["success"]!.GetValue<bool>() && !execution.ContainsKey("uiEffects"), "Python bound property write fails without effects");
                execution = await Run("import __main__ as worker; worker.send({'type':'result','success':True,'uiEffects':[{'kind':'property','componentId':'foreign','property':'text','value':'forged'}]})", Context());
                Check(execution["success"]!.GetValue<bool>() && execution["uiEffects"]!.AsArray().Count == 0, "actual worker protocol cannot supply its own UI effects");
                var invalidSnapshot = Snapshot(); invalidSnapshot["properties"]!["bound-title"] = new JsonObject { ["text"] = "forged" };
                var actions = new RuntimeActions(workspace.Publication, runner, queries);
                try { await actions.ExecuteAsync("main", "run", null, null, stamp, CancellationToken.None, ui: invalidSnapshot); throw new Exception("Invalid action snapshot accepted."); }
                catch (ArgumentException) { passed++; }
                Check(Convert.ToDouble(tags.Read(["[default]Setpoints/TargetSpeed"], null)[0].Value) == 88, "bad UI snapshot is rejected before action Python can change tags");
            }
            else Console.WriteLine("SKIP CPython UI integration: bundled Python runtime is unavailable.");
        }
        finally
        {
            if (Path.GetDirectoryName(Path.GetFullPath(directory)) != temporaryRoot) throw new Exception("Unsafe test cleanup path.");
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
        return passed;
    }
    private static JsonObject Snapshot() => new() { ["state"] = new JsonObject { ["session"] = new JsonObject(), ["screen"] = new JsonObject() }, ["properties"] = new JsonObject() };
    private static JsonObject Project()
    {
        var project = JsonNode.Parse("""
        {"id":"python-ui","name":"Python UI","revision":0,"parameters":{},"sessionState":{"title":{"type":"string","value":"Session"}},"screens":[{"id":"main","name":"Main","width":1000,"height":700,"state":{"title":{"type":"string","value":"Main"},"count":{"type":"number","value":0}},"components":[{"id":"run","type":"button","x":20,"y":20,"width":200,"height":40,"props":{"action":"script","script":"system.tag.writeBlocking(['[default]Setpoints/TargetSpeed'], [99]); result = 1"}},{"id":"direct-title","type":"label","x":20,"y":80,"width":200,"height":40,"props":{"text":"Original"}},{"id":"root-only","type":"label","x":20,"y":120,"width":200,"height":40,"props":{"text":"Root"}},{"id":"bound-title","type":"label","x":20,"y":160,"width":200,"height":40,"props":{"text":"Main","bindings":{"text":{"expression":"title","references":{"title":{"kind":"screenState","key":"title"}}}}}},{"id":"secret","type":"passwordInput","x":20,"y":210,"width":200,"height":60,"props":{"fieldKey":"secret","text":"Secret","defaultValue":""}},{"id":"panel","type":"template","x":300,"y":20,"width":300,"height":180,"props":{"templateId":"panel","parameters":{}}},{"id":"rows","type":"repeater","x":300,"y":230,"width":650,"height":200,"props":{"templateId":"panel","parameters":{},"rows":[{"id":"r1","parameters":{}},{"id":"r2","parameters":{}}],"columns":2,"gap":16}}]}],"templates":[{"id":"panel","name":"Panel","width":300,"height":180,"parameters":{},"instanceState":{"title":{"type":"string","value":"Local"}},"components":[{"id":"run","type":"button","x":20,"y":20,"width":200,"height":40,"props":{"action":"script","script":"result = 1"}},{"id":"direct-title","type":"label","x":20,"y":80,"width":200,"height":40,"props":{"text":"Nested"}}]}]}
        """)!.AsObject();
        var components = project["screens"]![0]!["components"]!.AsArray();
        project["screens"]![0]!["state"]!["_scope"] = new JsonObject { ["type"] = "string", ["value"] = "Initial scope value" };
        project["screens"]![0]!["state"]!["__class__"] = new JsonObject { ["type"] = "string", ["value"] = "Declared class value" };
        project["screens"]![0]!["state"]!["__dict__"] = new JsonObject { ["type"] = "string", ["value"] = "Declared dictionary value" };
        for (var i = 0; i < 160; i++) { var label = components[1]!.DeepClone().AsObject(); label["id"] = "label" + i; components.Add(label); }
        return project;
    }
}
