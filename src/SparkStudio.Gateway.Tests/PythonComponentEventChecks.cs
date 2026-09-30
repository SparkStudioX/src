using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class PythonComponentEventChecks
{
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool condition, string description) { if (!condition) throw new Exception("FAILED: " + description); passed++; }
        void Reject(Action action, string description)
        {
            try { action(); } catch (Exception error) when (error is ArgumentException or KeyNotFoundException or InvalidOperationException or JsonException) { passed++; return; }
            throw new Exception("FAILED to reject: " + description);
        }
        var temporaryRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
        var directory = Path.GetFullPath(Path.Combine(temporaryRoot, "SparkStudio.PythonComponentEvents." + Guid.NewGuid().ToString("N")));
        if (Path.GetDirectoryName(directory) != temporaryRoot) throw new Exception("Unsafe test directory.");
        try
        {
            var project = Project();
            var catalog = new ProjectCatalog(directory, new EphemeralDataProtectionProvider());
            var workspace = catalog.Create("Python component events", project);
            var saved = workspace.Store.GetProject();
            workspace.Publication.Publish(workspace.Store, saved["revision"]!.GetValue<int>());
            var stamp = workspace.Publication.GetProject()["publishedAt"]!.GetValue<string>();
            PythonComponentEventRequest Request(string family = "input", string? type = "change", string? handler = null) =>
                new(new(family, type, handler), family == "input" ? new JsonObject { ["type"] = type, ["componentId"] = "quantity", ["fieldKey"] = "quantity", ["value"] = 7, ["previousValue"] = 4, ["origin"] = "user" }
                : family == "propertyChange" ? new JsonObject { ["type"] = family, ["componentId"] = "title", ["property"] = "text", ["value"] = "Next", ["previousValue"] = "Before", ["available"] = true, ["previousAvailable"] = true, ["origin"] = "binding" }
                : family == "lifecycle" ? new JsonObject { ["type"] = type, ["componentId"] = "quantity" }
                : new JsonObject { ["type"] = "message", ["componentId"] = "title", ["messageType"] = "refresh", ["scope"] = "screen", ["messageId"] = "test-1", ["payload"] = new JsonObject { ["nested"] = new JsonArray(new JsonObject { ["text"] = "Received" }) } },
                Inputs: new() { ["quantity"] = JsonSerializer.SerializeToElement(7) }, PublishedAt: stamp);
            JsonObject Capture(PythonComponentEventRequest request, string component = "quantity") => workspace.Publication.GetComponentEvent("main", component, request);
            JsonObject Payload(PythonComponentEventRequest request, string component = "quantity")
            {
                var action = Capture(request, component);
                return PythonComponentEvents.Event(action, request, PythonComponentEvents.Inputs(action, request.Inputs), "tester");
            }
            var input = Request(); var property = Request("propertyChange", null); var message = Request("message", null, "refresh");
            var mount = Request("lifecycle", "mount"); var unmount = Request("lifecycle", "unmount");
            var action = Capture(input);
            Check(action["code"]!.GetValue<string>().Contains("event.value"), "captured input code is selected by saved handler");
            Check(action["inputs"]!.AsArray().Count == 2, "password definitions absent from event inputs");
            Check(Payload(input)["actor"]!.GetValue<string>() == "tester", "actor comes from server");
            Check(Payload(property, "title")["property"]!.GetValue<string>() == "text", "property watch matches saved definition");
            var displayEvent = property with { Event = property.Event.DeepClone().AsObject() };
            displayEvent.Event["componentId"] = "display"; displayEvent.Event["property"] = "value";
            displayEvent.Event["value"] = 7; displayEvent.Event["previousValue"] = 4;
            Check(Payload(displayEvent, "display")["value"]!.GetValue<int>() == 7, "numeric process display value uses its own scalar contract");
            var badDisplay = displayEvent with { Event = displayEvent.Event.DeepClone().AsObject() }; badDisplay.Event["value"] = "7";
            Reject(() => Payload(badDisplay, "display"), "numeric process display value rejects text");
            Check(Payload(message, "title")["scope"]!.GetValue<string>() == "screen", "message identity comes from saved receiver");
            foreach (var key in new[] { "componentId", "fieldKey", "type" })
            { var bad = input with { Event = input.Event.DeepClone().AsObject() }; bad.Event[key] = "forged"; Reject(() => Payload(bad), "forged input " + key); }
            foreach (var selector in new[] { new ComponentEventSelector("mount"), new ComponentEventSelector("input", "blur"), new ComponentEventSelector("propertyChange", "change"), new ComponentEventSelector("input", "change", "extra"), new ComponentEventSelector("message", HandlerId: "missing"), new ComponentEventSelector("lifecycle"), new ComponentEventSelector("lifecycle", "change"), new ComponentEventSelector("lifecycle", "mount", "extra") })
                Reject(() => Capture(input with { EventHandler = selector }), "invalid or missing event selector");
            Reject(() => Capture(input with { PublishedAt = null }), "missing publication stamp");
            Reject(() => Capture(input with { PublishedAt = "old" }), "stale publication stamp");
            Reject(() => Capture(input, "title"), "input event on noninput");
            foreach (var key in new[] { "actor", "code", "roles", "uiEffects" })
            { var bad = input with { Event = input.Event.DeepClone().AsObject() }; bad.Event[key] = "forged"; Reject(() => Payload(bad), "unknown event authority " + key); }
            foreach (var value in new JsonNode?[] { null, JsonValue.Create(true), JsonValue.Create(9007199254740992L), new JsonObject() })
            { var bad = input with { Event = input.Event.DeepClone().AsObject() }; bad.Event["value"] = value; Reject(() => Payload(bad), "invalid numeric event value"); }
            var mismatched = input with { Inputs = new() { ["quantity"] = JsonSerializer.SerializeToElement(8) } };
            Reject(() => Payload(mismatched), "mismatched input snapshot");
            foreach (var key in new[] { "secret", "undeclared" })
            { var bad = input with { Inputs = new(input.Inputs!) { [key] = JsonSerializer.SerializeToElement("secret") } }; Reject(() => Payload(bad), "forbidden automatic snapshot " + key); }
            var partial = input with { Inputs = new(input.Inputs!) { ["unfilled"] = JsonSerializer.SerializeToElement(-1000) } };
            Check(Payload(partial)["value"]!.GetValue<int>() == 7, "unrelated out of range inputs do not enforce whole form submission");
            var nullInputSnapshot = new Dictionary<string, JsonElement>(input.Inputs!) { ["unfilled"] = JsonSerializer.SerializeToElement<object?>(null) };
            Check(PythonComponentEvents.Inputs(action, nullInputSnapshot)["unfilled"].ValueKind == JsonValueKind.Null,
                "unavailable unrelated input is preserved as null in the event snapshot");
            Check(Payload(input with { Inputs = nullInputSnapshot })["value"]!.GetValue<int>() == 7,
                "unavailable unrelated input does not block a valid current input event");
            foreach (var text in new[] { "", "-", "not numeric", "9007199254740992" })
            {
                var invalidDraft = input with { Event = input.Event.DeepClone().AsObject(), Inputs = new(input.Inputs!) { ["quantity"] = JsonSerializer.SerializeToElement(text) } };
                invalidDraft.Event["value"] = text;
                Check(Payload(invalidDraft)["value"]!.GetValue<string>() == text, "numeric draft text remains available for authored validation");
            }
            var nullPrevious = input with { Event = input.Event.DeepClone().AsObject() }; nullPrevious.Event["previousValue"] = null;
            Check(Payload(nullPrevious).ContainsKey("previousValue"), "initial input previous value may be null");
            foreach (var key in new[] { "scope", "messageType", "type", "componentId" })
            { var bad = message with { Event = message.Event.DeepClone().AsObject() }; bad.Event[key] = "forged"; Reject(() => Payload(bad, "title"), "forged message " + key); }
            foreach (var value in new JsonNode?[] { null, new JsonArray(), new JsonObject { ["huge"] = new string('x', 70000) }, new JsonObject { ["number"] = 9007199254740992L } })
            { var bad = message with { Event = message.Event.DeepClone().AsObject() }; bad.Event["payload"] = value; Reject(() => Payload(bad, "title"), "invalid message payload"); }
            var badProperty = property with { Event = property.Event.DeepClone().AsObject() }; badProperty.Event["property"] = "visible";
            Reject(() => Payload(badProperty, "title"), "unwatched property");
            var unavailable = property with { Event = property.Event.DeepClone().AsObject() }; unavailable.Event["available"] = false; unavailable.Event["value"] = null; unavailable.Event["error"] = "No sample";
            Check(Payload(unavailable, "title")["available"]!.GetValue<bool>() == false, "unavailable samples preserve null and error");
            unavailable.Event["value"] = "forged"; Reject(() => Payload(unavailable, "title"), "unavailable sample with claimed value");
            var projected = workspace.Publication.GetProject();
            Check(Props(projected, "quantity")["events"]!["change"]!["code"] is null && Props(projected, "quantity")["events"]!["commit"]!["code"] is null, "Python input source hidden from operator");
            Check(Props(projected, "title")["componentEvents"]!["propertyChange"]!["code"] is null && Props(projected, "title")["messageHandlers"]![0]!["code"] is null, "Python property and message source hidden");
            Check(Props(projected, "title")["componentEvents"]!["mount"]!["code"]!.GetValue<string>() == "app.notify('mounted')", "JavaScript source preserved");
            Check(Props(projected, "quantity")["componentEvents"]!["mount"]!["code"] is null && Props(projected, "quantity")["componentEvents"]!["unmount"]!["code"] is null, "Python lifecycle source hidden from operator");
            foreach (var family in new[] { "input", "propertyChange" })
            {
                var invalid = workspace.Store.GetProject(); var secret = Props(invalid, "secret");
                if (family == "input") secret["events"] = Props(invalid, "quantity")["events"]!.DeepClone();
                if (family == "propertyChange") secret["componentEvents"] = Props(invalid, "title")["componentEvents"]!.DeepClone();
                Reject(() => workspace.Store.SaveProject(invalid), "Python password input/caption handler rejected " + family);
            }
            foreach (var phase in new[] { "mount", "unmount" })
            {
                var lifecycle = Request("lifecycle", phase);
                Check(Payload(lifecycle)["type"]!.GetValue<string>() == phase, "lifecycle identity resolved from saved handler " + phase);
                foreach (var key in new[] { "componentId", "type" })
                { var bad = lifecycle with { Event = lifecycle.Event.DeepClone().AsObject() }; bad.Event[key] = "forged"; Reject(() => Payload(bad), "lifecycle identity forgery " + key); }
                var unknown = lifecycle with { Event = lifecycle.Event.DeepClone().AsObject() }; unknown.Event["allowWrites"] = true;
                Reject(() => Payload(unknown), "lifecycle cannot request extra authority");
                Reject(() => Capture(lifecycle with { PublishedAt = "old" }), "lifecycle stale publication " + phase);
                var supported = workspace.Store.GetProject(); Props(supported, "secret")["componentEvents"] = new JsonObject { [phase] = new JsonObject { ["language"] = "python", ["code"] = "result = 1" } };
                workspace.Store.SaveProject(supported); passed++;
            }
            foreach (var wrapper in new[] { "left", "rows" })
                foreach (var family in new[] { "componentEvents", "messageHandlers" })
                {
                    var supported = workspace.Store.GetProject(); Props(supported, wrapper)[family] = Props(supported, "title")[family]!.DeepClone();
                    workspace.Store.SaveProject(supported); passed++;
                }
            var wrapperScript = workspace.Store.GetProject();
            Props(wrapperScript, "left")["componentEvents"] = new JsonObject { ["propertyChange"] = new JsonObject { ["language"] = "javascript", ["code"] = "app.notify('changed')", ["properties"] = new JsonArray("visible") } };
            workspace.Store.SaveProject(wrapperScript); passed++;
            Reject(() => JsonSerializer.Deserialize<PythonComponentEventRequest>("{\"eventHandler\":{\"family\":\"input\",\"type\":\"change\"},\"event\":{},\"code\":\"forged\"}", new JsonSerializerOptions(JsonSerializerDefaults.Web)), "request cannot carry executable source");
            var archive = SparkProjectPackage.Export(workspace);
            var imported = SparkProjectPackage.Import(catalog, archive, "Imported Python events");
            Check(!imported.Publication.Metadata()["published"]!.GetValue<bool>() && Props(imported.Store.GetProject(), "quantity")["events"]!["change"]!["language"]!.GetValue<string>() == "python", "package preserves Python definitions without publishing");

            var pythonPath = TestEnvironment.PythonExecutable();
            if (!File.Exists(pythonPath)) throw new Exception("Actual CPython is required for Python component event checks.");
            using var connectors = new ConnectorService(directory);
            using var tags = new TagEngine(catalog.GatewayStore, connectors, NullLogger<TagEngine>.Instance);
            var queries = new QueryExecutor(workspace.Store, connectors);
            var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Python:Executable"] = pythonPath }).Build();
            var runner = new PythonRunner(tags, queries, workspace.Scripts, configuration);
            var actions = new RuntimeActions(workspace.Publication, runner, queries);
            Task<JsonObject> Run(PythonComponentEventRequest request, string component = "quantity") => actions.ExecuteComponentEventAsync("main", component, request, "tester", CancellationToken.None);
            var result = await Run(input);
            Check(result["success"]!.GetValue<bool>() && result["result"]!["value"]!.GetValue<int>() == 7 && result["uiEffects"]!.AsArray().Count == 1, "actual Python input event exposes typed attribute and dict values and scoped effects");
            var commit = Request("input", "commit"); result = await Run(commit);
            Check(result["success"]!.GetValue<bool>() && result["result"]!.GetValue<string>() == "commit", "actual commit event resolves its own source");
            result = await Run(property, "title");
            Check(result["success"]!.GetValue<bool>() && result["result"]!.GetValue<string>() == "Before:Next", "actual property event receives typed old/new samples");
            result = await Run(displayEvent, "display");
            Check(result["success"]!.GetValue<bool>() && result["result"]!.GetValue<int>() == 3,
                "actual Python progress display property handler receives numeric current and previous values");
            result = await Run(message, "title");
            Check(result["success"]!.GetValue<bool>() && result["uiEffects"]![0]!["value"]!.GetValue<string>() == "Received", "actual message handler supports recursive payload dict and attribute access");
            result = await Run(mount);
            Check(result["success"]!.GetValue<bool>() && result["result"]!.GetValue<string>() == "mount" && result["uiEffects"]![0]!["value"]!.GetValue<string>() == "Mounted Root", "actual mount has the same Python UI and event context");
            var departure = unmount with { Ui = new JsonObject { ["state"] = new JsonObject { ["session"] = new JsonObject(), ["screen"] = new JsonObject { ["title"] = "Departing local value" } }, ["properties"] = new JsonObject() } };
            result = await Run(departure);
            Check(result["success"]!.GetValue<bool>() && result["result"]!.GetValue<string>() == "Departing local value" && result["uiEffects"]!.AsArray().Count == 0, "actual unmount reads captured local state and returns no local effects");
            foreach (var path in new IReadOnlyList<InstancePathStep>[] { new InstancePathStep[] { new("left") }, new InstancePathStep[] { new("rows", "r2") } })
            {
                result = await Run(mount with { InstancePath = path });
                Check(result["success"]!.GetValue<bool>() && result["uiEffects"]![0]!["scope"]!.GetValue<string>() == "instance", "mount resolves nested or repeated instance scope");
                result = await Run(unmount with { InstancePath = path });
                Check(result["success"]!.GetValue<bool>() && result["uiEffects"]!.AsArray().Count == 0, "unmount resolves nested or repeated instance read scope");
            }
            foreach (var wrapper in new[] { "left", "rows" })
            {
                var wrapperMount = mount with { Event = new JsonObject { ["type"] = "mount", ["componentId"] = wrapper } };
                result = await Run(wrapperMount, wrapper);
                Check(result["success"]!.GetValue<bool>() && result["uiEffects"]!.AsArray().Any(effect => effect?["componentId"]?.GetValue<string>() == wrapper) &&
                    result["uiEffects"]!.AsArray().Any(effect => effect?["scope"]?.GetValue<string>() == "screen"), "wrapper mount owns wrapper properties and containing screen state " + wrapper);
                result = await Run(wrapperMount with { EventHandler = new("lifecycle", "unmount"), Event = new JsonObject { ["type"] = "unmount", ["componentId"] = wrapper } }, wrapper);
                Check(result["success"]!.GetValue<bool>() && result["uiEffects"]!.AsArray().Count == 0, "wrapper cleanup has read-only containing scope " + wrapper);
            }
            foreach (var target in new[] { "left", "rows", "secret" })
            {
                var changed = property with { Event = property.Event.DeepClone().AsObject() };
                changed.Event["componentId"] = target; changed.Event["property"] = "enabled"; changed.Event["value"] = false; changed.Event["previousValue"] = true;
                result = await Run(changed, target);
                Check(result["success"]!.GetValue<bool>() && result["uiEffects"]![0]!["property"]!.GetValue<string>() == "backgroundColor", "wrapper/password property event uses bounded presentation context " + target);
                var received = message with { Event = message.Event.DeepClone().AsObject() }; received.Event["componentId"] = target;
                result = await Run(received, target);
                Check(result["success"]!.GetValue<bool>() && result["result"]!.GetValue<string>() == "Received", "wrapper/password Python message receiver uses its saved identity " + target);
                var leaked = received with { Inputs = new(received.Inputs!) { ["secret"] = JsonSerializer.SerializeToElement("must-not-reach-python") } };
                Reject(() => Payload(leaked, target), "all automatic receiver types reject password fields in request snapshot " + target);
            }
            foreach (var phase in new[] { "mount", "unmount" })
            {
                result = await Run(Request("lifecycle", phase) with { Event = new JsonObject { ["type"] = phase, ["componentId"] = "secret" } }, "secret");
                Check(result["success"]!.GetValue<bool>() && result["result"]!.GetValue<string>() == "secret", "password lifecycle has redacted self identity " + phase);
            }
            var safeCaption = workspace.Store.GetProject(); Props(safeCaption, "secret")["componentEvents"] = new JsonObject { ["propertyChange"] = new JsonObject { ["language"] = "javascript", ["code"] = "app.notify(event.value)", ["properties"] = new JsonArray("text") } };
            workspace.Store.SaveProject(safeCaption); passed++;
            foreach (var forbidden in new[] { "text", "value" })
            {
                var invalid = workspace.Store.GetProject(); Props(invalid, "secret")["componentEvents"]!["propertyChange"]!["language"] = "python";
                Props(invalid, "secret")["componentEvents"]!["propertyChange"]!["properties"] = new JsonArray(forbidden);
                Reject(() => workspace.Store.SaveProject(invalid), "password Python watch cannot expose " + forbidden);
            }
            foreach (var forbidden in new[] { "text", "value", "defaultValue" })
            {
                var readSecret = workspace.Store.GetProject(); Props(readSecret, "secret")["componentEvents"] = new JsonObject { ["mount"] = new JsonObject { ["language"] = "python", ["code"] = "result = self.props." + forbidden } };
                workspace.Store.SaveProject(readSecret);
                result = await actions.ExecutePreviewComponentEventAsync(workspace.Store, "main", "secret", false, mount with { PublishedAt = null, Event = new JsonObject { ["type"] = "mount", ["componentId"] = "secret" } }, "designer", CancellationToken.None);
                Check(!result["success"]!.GetValue<bool>() && !result.ContainsKey("uiEffects"), "password self read redacts " + forbidden);
                readSecret = workspace.Store.GetProject(); Props(readSecret, "secret")["componentEvents"]!["mount"]!["code"] = "self.props." + forbidden + " = 'not allowed'"; workspace.Store.SaveProject(readSecret);
                result = await actions.ExecutePreviewComponentEventAsync(workspace.Store, "main", "secret", false, mount with { PublishedAt = null, Event = new JsonObject { ["type"] = "mount", ["componentId"] = "secret" } }, "designer", CancellationToken.None);
                Check(!result["success"]!.GetValue<bool>() && !result.ContainsKey("uiEffects"), "password self write cannot assign " + forbidden);
            }
            result = await actions.ExecuteComponentEventAsync("popup", "quantity", mount with { PopupOrigin = new("main", "open") }, "tester", CancellationToken.None);
            Check(result["success"]!.GetValue<bool>() && result["uiEffects"]![0]!["value"]!.GetValue<string>() == "Mounted Popup", "popup mount preserves opener parameters");
            result = await actions.ExecutePreviewComponentEventAsync(workspace.Store, "panel", "quantity", true, mount with { PublishedAt = null }, "designer", CancellationToken.None);
            Check(result["success"]!.GetValue<bool>() && result["uiEffects"]![0]!["scope"]!.GetValue<string>() == "instance", "standalone template Preview supports Python mount");
            foreach (var source in new[] { "self.text = 'forbidden'", "self.parent.custom.title = 'forbidden'" })
            {
                var draftLifecycle = workspace.Store.GetProject(); Props(draftLifecycle, "quantity")["componentEvents"]!["unmount"]!["code"] = source; workspace.Store.SaveProject(draftLifecycle);
                result = await actions.ExecutePreviewComponentEventAsync(workspace.Store, "main", "quantity", false, unmount with { PublishedAt = null }, "designer", CancellationToken.None);
                Check(!result["success"]!.GetValue<bool>() && result["stderr"]!.GetValue<string>().Contains("read-only") && !result.ContainsKey("uiEffects"), "unmount rejects retired UI writes at gateway");
            }
            foreach (var (request, component) in new[] { (input, "quantity"), (property, "title"), (message, "title") })
            {
                result = await Run(request with { Inputs = nullInputSnapshot }, component);
                Check(result["success"]!.GetValue<bool>(), "actual Python " + request.EventHandler.Family + " event accepts unrelated unavailable inputs");
            }
            var nested = input with { InstancePath = [new("left")] }; result = await Run(nested);
            Check(result["success"]!.GetValue<bool>() && result["result"]!["station"]!.GetValue<string>() == "Left" && result["uiEffects"]![0]!["scope"]!.GetValue<string>() == "instance", "nested instance reconstructs saved parameters and private state");
            result = await Run(input with { InstancePath = [new("rows", "r2")] });
            Check(result["success"]!.GetValue<bool>() && result["result"]!["station"]!.GetValue<string>() == "Row two", "saved repeater row parameters resolved independently");
            var popup = input with { PopupOrigin = new("main", "open") };
            result = await actions.ExecuteComponentEventAsync("popup", "quantity", popup, "tester", CancellationToken.None);
            Check(result["success"]!.GetValue<bool>() && result["result"]!["station"]!.GetValue<string>() == "Popup", "popup event reconstructs opener context");
            Reject(() => workspace.Publication.GetComponentEvent("popup", "quantity", input), "popup event requires opener");
            var preview = input with { PublishedAt = null };
            result = await actions.ExecutePreviewComponentEventAsync(workspace.Store, "panel", "quantity", true, preview, "designer", CancellationToken.None);
            Check(result["success"]!.GetValue<bool>() && result["result"]!["station"]!.GetValue<string>() == "Template", "standalone template Preview uses saved defaults");
            var draft = workspace.Store.GetProject(); Props(draft, "quantity")["events"]!["change"]!["code"] = "self.parent.custom.title = 'draft'; result = 'saved draft'";
            workspace.Store.SaveProject(draft);
            result = await Run(input);
            Check(result["success"]!.GetValue<bool>() && result["result"] is JsonObject, "saved draft does not alter published event source");
            result = await actions.ExecutePreviewComponentEventAsync(workspace.Store, "main", "quantity", false, preview, "designer", CancellationToken.None);
            Check(result["success"]!.GetValue<bool>() && result["result"]!.GetValue<string>() == "saved draft", "saved Preview resolves current draft source");
            async Task<JsonObject> PreviewCode(string code, CancellationToken token = default)
            {
                var next = workspace.Store.GetProject(); Props(next, "quantity")["events"]!["change"]!["code"] = code; workspace.Store.SaveProject(next);
                return await actions.ExecutePreviewComponentEventAsync(workspace.Store, "main", "quantity", false, preview, "designer", token);
            }
            result = await PreviewCode("self.parent.custom.title = 'discard'; raise ValueError('expected')");
            Check(!result["success"]!.GetValue<bool>() && !result.ContainsKey("uiEffects"), "failed Python event discards staged effects");
            result = await PreviewCode("self.parent.custom.title = 'late'; import time; time.sleep(5)");
            Check(!result["success"]!.GetValue<bool>() && result["stderr"]!.GetValue<string>().Contains("2 second"), "automatic event total deadline terminates worker");
            using (var cancel = new CancellationTokenSource(100))
            {
                try { await PreviewCode("import time; time.sleep(5)", cancel.Token); throw new Exception("Cancellation did not stop Python."); }
                catch (OperationCanceledException) { passed++; }
            }
            var slow = workspace.Store.GetProject(); Props(slow, "quantity")["events"]!["change"]!["code"] = "import time; time.sleep(0.4); result = 1"; workspace.Store.SaveProject(slow);
            var running = Enumerable.Range(0, 4).Select(_ => actions.ExecutePreviewComponentEventAsync(workspace.Store, "main", "quantity", false, preview, "designer", CancellationToken.None)).ToArray();
            var fifth = actions.ExecutePreviewComponentEventAsync(workspace.Store, "main", "quantity", false, preview, "designer", CancellationToken.None);
            Check(!fifth.IsCompleted, "fifth simultaneous event waits instead of failing when four workers are occupied");
            Check((await fifth)["success"]!.GetValue<bool>(), "queued fifth event runs after a worker slot releases");
            Check((await Task.WhenAll(running)).All(item => item["success"]!.GetValue<bool>()), "bounded concurrent workers complete and release leases");
            var arrivals = new System.Collections.Concurrent.ConcurrentQueue<int>();
            runner.UiMessageDispatch = (_, payload, _) => { arrivals.Enqueue(payload["marker"]!.GetValue<int>()); return new JsonObject { ["accepted"] = 0 }; };
            PythonComponentEventRequest Marked(int marker) {
                var marked = preview with { Event = preview.Event.DeepClone().AsObject(), Inputs = new(preview.Inputs!) { ["quantity"] = JsonSerializer.SerializeToElement(marker) } };
                marked.Event["value"] = marker; return marked;
            }
            void AdmissionScript(string sleep) {
                var next = workspace.Store.GetProject(); Props(next, "quantity")["events"]!["change"]!["code"] =
                    "import time\nsystem.ui.sendMessage('admission', {'marker': event.value})\ntime.sleep(" + sleep + ")\nresult = event.value";
                workspace.Store.SaveProject(next);
            }
            async Task Drain(IEnumerable<Task<JsonObject>> pending) {
                foreach (var task in pending) try { await task; } catch (OperationCanceledException) { }
            }
            AdmissionScript("5");
            var queued = new RuntimeActions(workspace.Publication, runner, queries);
            using (var runningCancellation = new CancellationTokenSource())
            using (var waitingCancellation = new CancellationTokenSource())
            {
                var active = Enumerable.Range(0, 4).Select(index => queued.ExecutePreviewComponentEventAsync(workspace.Store, "main", "quantity", false, Marked(index), "occupant-" + index, runningCancellation.Token)).ToArray();
                var waiting = queued.ExecutePreviewComponentEventAsync(workspace.Store, "main", "quantity", false, Marked(99), "cancelled-waiter", waitingCancellation.Token);
                waitingCancellation.Cancel();
                try { await waiting; throw new Exception("Queued cancellation was not observed."); } catch (OperationCanceledException) { passed++; }
                runningCancellation.Cancel(); await Drain(active);
                Check(!arrivals.Contains(99), "cancelled queue waiter never enters actual Python code");
            }
            using (var overflowCancellation = new CancellationTokenSource())
            {
                var admitted = Enumerable.Range(0, 36).Select(index => queued.ExecutePreviewComponentEventAsync(workspace.Store, "main", "quantity", false, Marked(index), "overflow-" + index, overflowCancellation.Token)).ToArray();
                try { await queued.ExecutePreviewComponentEventAsync(workspace.Store, "main", "quantity", false, Marked(100), "overflow-rejected", overflowCancellation.Token); throw new Exception("Project admission queue exceeded its bound."); }
                catch (BadHttpRequestException error) when (error.StatusCode == 429 && error.Message.Contains("32 waiting")) { passed++; }
                overflowCancellation.Cancel(); await Drain(admitted);
            }
            using (var globalCancellation = new CancellationTokenSource())
            {
                var projects = Enumerable.Range(0, 5).Select(_ => new RuntimeActions(workspace.Publication, runner, queries)).ToArray();
                var admitted = projects.Take(4).SelectMany((owner, projectIndex) => Enumerable.Range(0, 36).Select(index => owner.ExecutePreviewComponentEventAsync(workspace.Store, "main", "quantity", false, Marked(index), "global-" + projectIndex + "-" + index, globalCancellation.Token))).ToArray();
                try { await projects[4].ExecutePreviewComponentEventAsync(workspace.Store, "main", "quantity", false, Marked(100), "global-overflow", globalCancellation.Token); throw new Exception("Gateway admission queue exceeded its bound."); }
                catch (BadHttpRequestException error) when (error.StatusCode == 429 && error.Message.Contains("128 waiting")) { passed++; }
                globalCancellation.Cancel(); await Drain(admitted);
            }
            AdmissionScript("1.2");
            var deadlineActions = new RuntimeActions(workspace.Publication, runner, queries);
            var elapsed = System.Diagnostics.Stopwatch.StartNew();
            var totalBudget = Enumerable.Range(0, 8).Select(index => deadlineActions.ExecutePreviewComponentEventAsync(workspace.Store, "main", "quantity", false, Marked(index), "deadline-" + index, CancellationToken.None)).ToArray();
            var results = await Task.WhenAll(totalBudget);
            // Interpreter startup belongs to the same deadline. On a busy Windows runner
            // even an initial worker can legitimately time out; its success is not the
            // queue contract. The second wave must never receive a fresh execution budget.
            bool Deadline(JsonObject item) => !item["success"]!.GetValue<bool>() && item["stderr"]!.GetValue<string>().Contains("2 second");
            Check(results.Take(4).All(item => item["success"]!.GetValue<bool>() || Deadline(item)) && results.Skip(4).All(Deadline),
                "queue time consumes the same two-second deadline as actual Python execution: " + string.Join("; ", results.Select(item => item.ToJsonString())));
            Check(elapsed.ElapsedMilliseconds < 5000, "queued execution terminates within a bounded cleanup allowance after its two-second budget");
            AdmissionScript("0");
            result = await queued.ExecutePreviewComponentEventAsync(workspace.Store, "main", "quantity", false, Marked(101), "after-cancellation", CancellationToken.None);
            Check(result["success"]!.GetValue<bool>(), "overflow cancellation and deadlines release all admission and worker reservations");
            var rate = new RuntimeActions(workspace.Publication, runner, queries);
            for (var index = 0; index < 32; index++)
                try { await rate.ExecuteComponentEventAsync("main", "missing", input, "rate-test", CancellationToken.None); } catch (KeyNotFoundException) { }
            try { await rate.ExecuteComponentEventAsync("main", "missing", input, "rate-test", CancellationToken.None); throw new Exception("Rate bound exceeded."); }
            catch (BadHttpRequestException error) when (error.StatusCode == 429) { passed++; }
            Console.WriteLine($"PASS {passed} Python component event model, publication and actual CPython checks.");
        }
        finally
        {
            if (Path.GetDirectoryName(Path.GetFullPath(directory)) != temporaryRoot) throw new Exception("Unsafe cleanup path.");
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
        return passed;
    }

    private static JsonObject Props(JsonObject project, string component) => project["screens"]![0]!["components"]!.AsArray().OfType<JsonObject>().First(item => item["id"]!.GetValue<string>() == component)["props"]!.AsObject();
    private static JsonObject Project()
    {
        var project = JsonNode.Parse("""
        {"id":"python-events","name":"Python events","revision":0,"parameters":{"station":"Root"},"sessionState":{},"screens":[{"id":"main","name":"Main","width":1000,"height":700,"state":{"title":{"type":"string","value":"Initial"}},"components":[{"id":"quantity","type":"numberInput","x":20,"y":20,"width":200,"height":60,"props":{"fieldKey":"quantity","defaultValue":4,"min":0,"max":100,"events":{"change":{"language":"python","code":"self.parent.custom.title = str(event.value); result = {'value': event['value'], 'station': parameters['station']}"},"commit":{"language":"python","code":"result = event.type"}}}},{"id":"unfilled","type":"numberInput","x":20,"y":90,"width":200,"height":60,"props":{"fieldKey":"unfilled","defaultValue":1,"min":0,"max":10}},{"id":"secret","type":"passwordInput","x":20,"y":160,"width":200,"height":60,"props":{"fieldKey":"secret","defaultValue":""}},{"id":"title","type":"label","x":20,"y":230,"width":200,"height":40,"props":{"text":"Initial","componentEvents":{"mount":{"language":"javascript","code":"app.notify('mounted')"},"propertyChange":{"language":"python","properties":["text"],"code":"result = event.previousValue + ':' + event.value"}},"messageHandlers":[{"id":"refresh","messageType":"refresh","scope":"screen","language":"python","code":"self.text = event.payload.nested[0].text; assert event.payload['nested'][0]['text'] == 'Received'"}]}},{"id":"left","type":"template","x":300,"y":20,"width":300,"height":180,"props":{"templateId":"panel","parameters":{"station":"Left"}}},{"id":"rows","type":"repeater","x":300,"y":230,"width":650,"height":200,"props":{"templateId":"panel","parameters":{},"rows":[{"id":"r1","parameters":{"station":"Row one"}},{"id":"r2","parameters":{"station":"Row two"}}],"columns":2,"gap":16}},{"id":"open","type":"button","x":20,"y":290,"width":200,"height":40,"props":{"text":"Open","action":"openPopup","targetScreenId":"popup","parameters":{"station":"Popup"}}}]}],"templates":[]}
        """)!.AsObject();
        var quantity = project["screens"]![0]!["components"]![0]!.DeepClone();
        var lifecycle = new JsonObject { ["mount"] = new JsonObject { ["language"] = "python", ["code"] = "self.parent.custom.title = 'Mounted ' + parameters['station']; result = event.type" },
            ["unmount"] = new JsonObject { ["language"] = "python", ["code"] = "assert event.type == 'unmount'; result = self.parent.custom.title" } };
        project["screens"]![0]!["components"]![0]!["props"]!["componentEvents"] = lifecycle.DeepClone();
        quantity["props"]!["componentEvents"] = lifecycle;
        foreach (var wrapper in new[] { "left", "rows" })
            Props(project, wrapper)["componentEvents"] = new JsonObject {
                ["mount"] = new JsonObject { ["language"] = "python", ["code"] = "self.text = 'Wrapper'; self.parent.custom.title = self.id; result = self.parent.custom.title" },
                ["unmount"] = new JsonObject { ["language"] = "python", ["code"] = "result = self.parent.custom.title" }
            };
        Props(project, "secret")["componentEvents"] = new JsonObject {
            ["mount"] = new JsonObject { ["language"] = "python", ["code"] = "assert 'secret' not in inputs; self.enabled = False; result = self.id" },
            ["unmount"] = new JsonObject { ["language"] = "python", ["code"] = "assert 'secret' not in inputs; assert self.enabled is True; result = self.id" }
        };
        foreach (var target in new[] { "left", "rows", "secret" })
        {
            Props(project, target)["componentEvents"]!["propertyChange"] = new JsonObject { ["language"] = "python", ["properties"] = new JsonArray("enabled"),
                ["code"] = "assert 'secret' not in inputs; self.backgroundColor = '#ddeeff'; result = event.value" };
            Props(project, target)["messageHandlers"] = new JsonArray(new JsonObject { ["id"] = "refresh", ["messageType"] = "refresh", ["scope"] = "screen", ["language"] = "python",
                ["code"] = "assert 'secret' not in inputs; self.foregroundColor = '#abcdef'; result = event.payload.nested[0].text" });
        }
        project["screens"]![0]!["components"]!.AsArray().Add(JsonNode.Parse("""
        {"id":"display","type":"progressBar","x":20,"y":350,"width":200,"height":40,"props":{"value":4,"min":0,"max":100,"componentEvents":{"propertyChange":{"language":"python","properties":["value"],"code":"result = event.value - event.previousValue"}}}}
        """));
        project["templates"]!.AsArray().Add(new JsonObject { ["id"] = "panel", ["name"] = "Panel", ["width"] = 300d, ["height"] = 180d,
            ["parameters"] = new JsonObject { ["station"] = "Template" }, ["instanceState"] = new JsonObject { ["title"] = new JsonObject { ["type"] = "string", ["value"] = "Local" } }, ["components"] = new JsonArray(quantity) });
        project["screens"]!.AsArray().Add(new JsonObject { ["id"] = "popup", ["name"] = "Popup", ["kind"] = "popup", ["width"] = 300d, ["height"] = 180d,
            ["parameters"] = new JsonObject { ["station"] = "Default popup" }, ["state"] = new JsonObject { ["title"] = new JsonObject { ["type"] = "string", ["value"] = "Popup" } }, ["components"] = new JsonArray(quantity.DeepClone()) });
        return project;
    }
}
