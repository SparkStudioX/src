using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class InteractionEventChecks
{
    private static readonly string[] Names = ["focus", "blur", "keyDown", "keyUp", "doubleClick", "pointerDown", "pointerUp"];
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool condition, string message) { if (!condition) throw new Exception("FAILED: " + message); passed++; }
        void Reject(Action run, string message) { try { run(); } catch (Exception error) when (error is ArgumentException or KeyNotFoundException or InvalidOperationException or JsonException) { passed++; return; } throw new Exception("FAILED to reject: " + message); }
        var root = Path.GetFullPath(Path.GetTempPath());
        var directory = Path.Combine(root, "SparkStudio.Interactions." + Guid.NewGuid().ToString("N"));
        try
        {
            var catalog = new ProjectCatalog(directory, new EphemeralDataProtectionProvider());
            var workspace = catalog.Create("Interaction event checks", Project());
            var saved = workspace.Store.GetProject();
            workspace.Publication.Publish(workspace.Store, saved["revision"]!.GetValue<int>());
            var stamp = workspace.Publication.GetProject()["publishedAt"]!.GetValue<string>();
            PythonComponentEventRequest Request(string type, string component = "entry") => new(new("interaction", type), Payload(type, component),
                Inputs: new() { ["entry"] = JsonSerializer.SerializeToElement("visible input") }, PublishedAt: stamp);
            JsonObject Capture(PythonComponentEventRequest request, string component = "entry") => workspace.Publication.GetComponentEvent("main", component, request);
            JsonObject Event(PythonComponentEventRequest request, string component = "entry") { var action = Capture(request, component); return PythonComponentEvents.Event(action, request, PythonComponentEvents.Inputs(action, request.Inputs), "operator"); }
            foreach (var name in Names)
            {
                var request = Request(name); var action = Capture(request); var value = Event(request);
                Check(value["type"]!.GetValue<string>() == name && value["actor"]!.GetValue<string>() == "operator" && action["inputs"]!.AsArray().Count == 1, "saved interaction identity and redacted form " + name);
                Check(workspace.Publication.GetProject()["screens"]![0]!["components"]![0]!["props"]!["componentEvents"]![name]!["code"] is null, "published Python interaction source is hidden " + name);
                var unknown = request with { Event = request.Event.DeepClone().AsObject() }; unknown.Event["target"] = "forged DOM";
                Reject(() => Event(unknown), "interaction payload rejects DOM or authority fields " + name);
            }
            foreach (var selector in new[] { new ComponentEventSelector("interaction"), new ComponentEventSelector("interaction", "click"), new ComponentEventSelector("interaction", "focus", "extra"), new ComponentEventSelector("lifecycle", "focus") })
                Reject(() => Capture(Request("focus") with { EventHandler = selector }), "unsupported interaction selector");
            Reject(() => Capture(Request("focus") with { PublishedAt = "stale" }), "stale interaction publication");
            Reject(() => Capture(Request("focus") with { PublishedAt = null }), "missing interaction publication");
            foreach (var (key, value) in new (string, JsonNode?)[] { ("key", JsonValue.Create(new string('a', 129))), ("code", JsonValue.Create(new string('b', 65))), ("repeat", JsonValue.Create("true")), ("origin", JsonValue.Create("script")), ("componentId", JsonValue.Create("other")), ("isComposing", null) })
            { var request = Request("keyDown"); request.Event[key] = value; Reject(() => Event(request), "keyboard payload bound " + key); }
            foreach (var (key, value) in new (string, JsonNode?)[] { ("pointerType", JsonValue.Create("device")), ("pointerId", JsonValue.Create(1.5)), ("clientX", JsonValue.Create(10_000_001)), ("buttons", JsonValue.Create(64)), ("button", JsonValue.Create(-2)), ("clientY", JsonValue.Create("3")) })
            { var request = Request("pointerUp"); request.Event[key] = value; Reject(() => Event(request), "pointer payload bound " + key); }
            var password = Request("keyDown", "secret"); password.Event["key"] = ""; password.Event["code"] = ""; password.Event["redacted"] = true;
            Check(Event(password, "secret")["redacted"]!.GetValue<bool>(), "password key event accepts only redacted keys");
            var leakedKey = password with { Event = password.Event.DeepClone().AsObject() }; leakedKey.Event["key"] = "s";
            Reject(() => Event(leakedKey, "secret"), "password keystroke cannot reach Python");
            Reject(() => Event(password with { Inputs = new(password.Inputs!) { ["secret"] = JsonSerializer.SerializeToElement("secret") } }, "secret"), "interaction snapshots reject password fields");
            var invalid = workspace.Store.GetProject(); invalid["screens"]![0]!["components"]![0]!["props"]!["componentEvents"]!["click"] = new JsonObject { ["language"] = "python", ["code"] = "pass" };
            Reject(() => workspace.Store.SaveProject(invalid), "unsupported authored interaction name");
            invalid = workspace.Store.GetProject(); invalid["screens"]![0]!["components"]![0]!["props"]!["componentEvents"]!["focus"]!["properties"] = new JsonArray("text");
            Reject(() => workspace.Store.SaveProject(invalid), "interaction definitions cannot smuggle property watch fields");
            var imported = SparkProjectPackage.Import(catalog, SparkProjectPackage.Export(workspace), "Imported interactions");
            Check(!imported.Publication.Metadata()["published"]!.GetValue<bool>() && imported.Store.GetProject()["screens"]![0]!["components"]![0]!["props"]!["componentEvents"]!.AsObject().Count == 7, "portable roundtrip retains all interaction handlers unpublished");

            var python = TestEnvironment.PythonExecutable();
            if (!File.Exists(python)) throw new Exception("Actual CPython is required for interaction checks.");
            using var connectors = new ConnectorService(directory);
            using var tags = new TagEngine(catalog.GatewayStore, connectors, NullLogger<TagEngine>.Instance);
            var queries = new QueryExecutor(workspace.Store, connectors);
            var runner = new PythonRunner(tags, queries, workspace.Scripts, new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Python:Executable"] = python }).Build());
            var actions = new RuntimeActions(workspace.Publication, runner, queries);
            foreach (var name in Names)
            {
                var result = await actions.ExecuteComponentEventAsync("main", "entry", Request(name), "operator", CancellationToken.None);
                Check(result["success"]!.GetValue<bool>() && result["result"]!["type"]!.GetValue<string>() == name && result["uiEffects"]!.AsArray().Count == 2, "actual Python interaction stages typed UI effects " + name);
            }
            JsonObject Ui(int count) => new() { ["state"] = new JsonObject { ["session"] = new JsonObject(), ["screen"] = new JsonObject { ["last"] = "local", ["count"] = count } }, ["properties"] = new JsonObject() };
            foreach (var count in new[] { 4, 20 })
            {
                var result = await actions.ExecuteComponentEventAsync("main", "entry", Request("focus") with { Ui = Ui(count) }, "operator", CancellationToken.None);
                Check(result["result"]!["count"]!.GetValue<int>() == count + 1, "two receiving sessions retain independent local state " + count);
            }
            Check(workspace.Store.GetProject()["screens"]![0]!["state"]!["count"]!["value"]!.GetValue<int>() == 0, "interaction UI changes never mutate saved screen state");
            var secretResult = await actions.ExecuteComponentEventAsync("main", "secret", password, "operator", CancellationToken.None);
            Check(secretResult["success"]!.GetValue<bool>() && secretResult["result"]!["redacted"]!.GetValue<bool>(), "actual Python password interaction receives redaction marker and no key");
            foreach (var path in new IReadOnlyList<InstancePathStep>[] { [new("panel")], [new("rows", "second")] })
            {
                var result = await actions.ExecuteComponentEventAsync("main", "entry", Request("pointerDown") with { InstancePath = path }, "operator", CancellationToken.None);
                Check(result["success"]!.GetValue<bool>() && result["uiEffects"]!.AsArray().All(effect => effect!["scope"]!.GetValue<string>() == "instance"), "template and repeated row interaction uses private state");
            }
            var popup = await actions.ExecuteComponentEventAsync("dialog", "entry", Request("focus") with { PopupOrigin = new("main", "open") }, "operator", CancellationToken.None);
            Check(popup["success"]!.GetValue<bool>() && popup["result"]!["station"]!.GetValue<string>() == "Popup", "popup interaction retains saved opener parameters");
            var preview = await actions.ExecutePreviewComponentEventAsync(workspace.Store, "form", "entry", true, Request("keyUp") with { PublishedAt = null }, "designer", CancellationToken.None);
            Check(preview["success"]!.GetValue<bool>() && preview["result"]!["station"]!.GetValue<string>() == "Template", "saved template Preview executes its own interaction context");
            using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
            try { await actions.ExecuteComponentEventAsync("main", "entry", Request("focus"), "operator", cancelled.Token); throw new Exception("Cancelled event started"); } catch (OperationCanceledException) { passed++; }
        }
        finally { if (Path.GetDirectoryName(directory) == Path.TrimEndingDirectorySeparator(root) && Directory.Exists(directory)) Directory.Delete(directory, true); }
        Console.WriteLine($"{passed} interaction event checks passed."); return passed;
    }

    private static JsonObject Payload(string type, string component)
    {
        var value = new JsonObject { ["type"] = type, ["componentId"] = component, ["origin"] = "user" };
        if (type is "focus" or "blur") return value;
        foreach (var modifier in new[] { "altKey", "ctrlKey", "metaKey", "shiftKey" }) value[modifier] = false;
        if (type is "keyDown" or "keyUp") { value["key"] = "Enter"; value["code"] = "Enter"; value["repeat"] = false; value["isComposing"] = false; value["redacted"] = false; }
        else { value["button"] = 0; value["buttons"] = 1; value["clientX"] = 12.5; value["clientY"] = 30; if (type != "doubleClick") { value["pointerType"] = "mouse"; value["pointerId"] = 1; } }
        return value;
    }
    private static JsonObject Project()
    {
        var project = JsonNode.Parse("""
        {"id":"interaction-events","name":"Interaction events","revision":0,"parameters":{"station":"Main"},"sessionState":{},"screens":[{"id":"main","name":"Main","width":1000,"height":700,"state":{},"components":[{"id":"entry","type":"textInput","x":20,"y":20,"width":220,"height":60,"props":{"fieldKey":"entry","defaultValue":"Hello"}},{"id":"secret","type":"passwordInput","x":20,"y":100,"width":220,"height":60,"props":{"fieldKey":"secret"}},{"id":"panel","type":"template","x":300,"y":20,"width":300,"height":180,"props":{"templateId":"form","parameters":{}}},{"id":"rows","type":"repeater","x":300,"y":220,"width":650,"height":180,"props":{"templateId":"form","columns":2,"gap":10,"rows":[{"id":"first","parameters":{}},{"id":"second","parameters":{}}]}},{"id":"open","type":"button","x":20,"y":210,"width":200,"height":40,"props":{"action":"openPopup","targetScreenId":"dialog","parameters":{"station":"Popup"}}}]}],"templates":[]}
        """)!.AsObject();
        JsonObject State() => new() { ["last"] = new JsonObject { ["type"] = "string", ["value"] = "" }, ["count"] = new JsonObject { ["type"] = "number", ["value"] = 0 } };
        var events = new JsonObject(); foreach (var name in Names) events[name] = new JsonObject { ["language"] = "python", ["code"] = "assert 'secret' not in inputs\nself.parent.custom.last = event.type\nself.parent.custom.count = self.parent.custom.count + 1\nresult = {'type': event.type, 'count': self.parent.custom.count, 'station': parameters['station']}" };
        var main = project["screens"]![0]!.AsObject(); main["state"] = State(); main["components"]![0]!["props"]!["componentEvents"] = events;
        main["components"]![1]!["props"]!["componentEvents"] = new JsonObject { ["keyDown"] = new JsonObject { ["language"] = "python", ["code"] = "assert 'secret' not in inputs\nassert event.key == '' and event.code == ''\nresult = {'redacted': event.redacted}" } };
        var input = main["components"]![0]!.DeepClone();
        project["templates"]!.AsArray().Add(new JsonObject { ["id"] = "form", ["name"] = "Form", ["width"] = 300, ["height"] = 180, ["parameters"] = new JsonObject { ["station"] = "Template" }, ["instanceState"] = State(), ["components"] = new JsonArray(input) });
        project["screens"]!.AsArray().Add(new JsonObject { ["id"] = "dialog", ["name"] = "Dialog", ["kind"] = "popup", ["width"] = 300, ["height"] = 180, ["parameters"] = new JsonObject { ["station"] = "Default" }, ["state"] = State(), ["components"] = new JsonArray(input.DeepClone()) });
        return JsonNode.Parse(project.ToJsonString())!.AsObject();
    }
}
