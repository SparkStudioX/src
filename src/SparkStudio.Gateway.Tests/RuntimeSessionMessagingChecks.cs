using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class RuntimeSessionMessagingChecks
{
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.Parse("2026-01-01T00:00:00Z");
        public override DateTimeOffset GetUtcNow() => Now;
        public void Advance(double seconds) => Now = Now.AddSeconds(seconds);
    }
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool condition, string name) { if (!condition) throw new Exception("FAILED session messaging: " + name); passed++; }
        void Reject(Action action, string name)
        {
            try { action(); } catch (Exception error) when (error is ArgumentException or InvalidOperationException or KeyNotFoundException or BadHttpRequestException) { passed++; return; }
            throw new Exception("FAILED to reject session messaging: " + name);
        }
        var clock = new Clock(); var service = new RuntimeSessionMessaging(clock);
        RuntimeSessionMessaging.Session Open(string project = "one", string owner = "login-a", Func<bool>? valid = null)
        {
            var session = service.Register(project, "publication", "user-a", "operator", owner, valid ?? (() => true));
            return service.Connect(project, session.Id, "user-a", owner);
        }
        var first = Open(); var second = Open(); var foreign = Open("two");
        Check(first.Id != second.Id && first.Id != "login-a" && first.Id.Length == 32, "same login receives independent server-issued tab identities");
        Check(service.GetSessionInfo("one").Count == 2 && service.GetSessionInfo("two").Count == 1, "session inventory stays within project");
        Reject(() => service.Connect("one", first.Id, "user-a", "login-b"), "another login of same account cannot use tab identity");
        Reject(() => service.Connect("two", first.Id, "user-a", "login-a"), "other project cannot use tab identity");
        Reject(() => service.Connect("one", first.Id, "user-b", "login-a"), "other actor cannot use tab identity");
        Reject(() => service.Connect("one", first.Id, "user-a", "login-a"), "duplicate stream cannot share mailbox");
        Reject(() => service.Close("two", first.Id, "user-a", "login-a"), "other project cannot close mailbox");
        var payload = new JsonObject { ["value"] = "original" };
        var receipt = service.Send("one", "orders.changed", payload);
        payload["value"] = "modified";
        Check(receipt["queued"]!.GetValue<int>() == 2 && !receipt.ContainsKey("delivered"), "broadcast receipt promises queuing only");
        var a = service.Take(first)!; var b = service.Take(second)!;
        Check(a["payload"]!["value"]!.GetValue<string>() == "original" && a["sessionId"]!.GetValue<string>() == first.Id && b["sessionId"]!.GetValue<string>() == second.Id, "payload and recipient envelopes are detached");
        Check(service.Take(foreign) is null, "broadcast cannot escape project");
        receipt = service.Send("one", "orders.changed", new(), second.Id);
        Check(receipt["queued"]!.GetValue<int>() == 1 && service.Take(first) is null && service.Take(second) is not null, "target sends only to matching active tab");
        Check(service.Send("one", "orders.changed", new(), foreign.Id)["status"]!.GetValue<string>() == "noRecipients", "foreign session target does not reveal or deliver");
        var pending = service.Register("one", "publication", "user-a", "operator", "login-a", () => true);
        Check(service.Send("one", "orders.changed", new(), pending.Id)["queued"]!.GetValue<int>() == 0, "registered but disconnected tab cannot receive");
        foreach (var type in new[] { "", " padded", "bad\nname", new string('a', 81) }) Reject(() => service.Send("one", type, new()), "invalid message type");
        Reject(() => service.Send("one", "orders.changed", new(), "forged"), "invalid session format");
        Reject(() => service.Send("one", "orders.changed", new JsonObject { ["large"] = new string('x', 70000) }), "oversized payload");
        Reject(() => service.Send("one", "orders.changed", new JsonObject { ["unsafe"] = 9007199254740992L }), "unsafe integer");
        JsonNode deep = new JsonObject(); for (var index = 0; index < 18; index++) deep = new JsonObject { ["child"] = deep };
        Reject(() => service.Send("one", "orders.changed", deep.AsObject()), "excessive payload depth");
        service.Send("one", "old", new(), first.Id); clock.Advance(6);
        Check(service.Take(first) is null, "messages expire after five seconds instead of replaying old UI instructions");
        var allowed = true; var revoked = Open(valid: () => allowed);
        service.Send("one", "queued", new(), revoked.Id); allowed = false;
        Check(service.Take(revoked) is null && !service.Refresh(revoked), "revocation discards already queued delivery");
        Reject(() => service.Connect("one", revoked.Id, "user-a", "login-a"), "revoked identity cannot reconnect");
        var activePublication = true; var stale = Open(valid: () => activePublication);
        service.Send("one", "queued", new(), stale.Id); activePublication = false;
        Check(service.GetSessionInfo("one").All(item => item!["sessionId"]!.GetValue<string>() != stale.Id) && service.Take(stale) is null, "publication replacement drops old tabs and queued messages");
        service.Send("one", "queued", new(), second.Id); service.Disconnect(second);
        Check(service.Take(second) is null && service.Send("one", "later", new(), second.Id)["queued"]!.GetValue<int>() == 0, "disconnect closes mailbox immediately");
        Reject(() => service.Connect("one", second.Id, "user-a", "login-a"), "reconnect must register a fresh identity");
        clock.Advance(31);
        Check(service.GetSessionInfo("one").Count == 0 && service.GetSessionInfo("two").Count == 0, "abandoned pending and stalled active tabs expire");
        var bounded = Open();
        for (var index = 0; index < 32; index++) service.Send("one", "bounded", new(), bounded.Id);
        receipt = service.Send("one", "overflow", new(), bounded.Id);
        Check(receipt["queued"]!.GetValue<int>() == 0 && receipt["dropped"]!.GetValue<int>() == 1, "per-tab queue has explicit overflow receipt");
        Check(service.Take(bounded) is not null && service.Send("one", "new", new(), bounded.Id)["queued"]!.GetValue<int>() == 1, "draining returns queue capacity");
        clock.Advance(1);
        for (var index = 0; index < 128; index++) service.Send("one", "rate", new());
        Reject(() => service.Send("one", "rate", new()), "per-project send rate");
        clock.Advance(1);
        Check(service.Send("one", "new-window", new()) is not null, "rate window recovers");
        var capacity = new RuntimeSessionMessaging(clock);
        for (var index = 0; index < 32; index++) capacity.Register("p", "v", "u", "name", "login", () => true);
        Reject(() => capacity.Register("p", "v", "u", "name", "login", () => true), "login tab limit");
        var global = new RuntimeSessionMessaging(clock);
        for (var index = 0; index < 4; index++) for (var send = 0; send < 128; send++) global.Send("p" + index, "bounded", new());
        Reject(() => global.Send("p4", "bounded", new()), "gateway send rate");
        var queues = new RuntimeSessionMessaging(clock);
        for (var index = 0; index < 20; index++) { var tab = queues.Register("p", "v", "u", "name", "owner" + index, () => true); queues.Connect("p", tab.Id, "u", "owner" + index); }
        for (var index = 0; index < 25; index++) queues.Send("p", "bounded", new());
        receipt = queues.Send("p", "bounded", new());
        Check(receipt["queued"]!.GetValue<int>() == 12 && receipt["dropped"]!.GetValue<int>() == 8, "gateway pending bound caps total buffered payloads");
        var temp = Path.GetFullPath(Path.GetTempPath());
        var directory = Path.GetFullPath(Path.Combine(temp, "SparkStudio.SessionMessaging." + Guid.NewGuid().ToString("N")));
        if (Path.GetDirectoryName(directory) != Path.TrimEndingDirectorySeparator(temp)) throw new Exception("Unsafe fixture path.");
        try
        {
            var catalog = new ProjectCatalog(directory, new EphemeralDataProtectionProvider());
            var project = JsonNode.Parse("""
                {"id":"message-test","name":"Messaging test","revision":0,"parameters":{},"screens":[{"id":"main","name":"Main","width":800,"height":600,"components":[
                {"id":"send","type":"button","x":10,"y":10,"width":200,"height":50,"props":{"text":"Send","action":"script","script":"result = system.ui.sendMessage('button.notice', {'text': 'Button'})"}},
                {"id":"input","type":"textInput","x":10,"y":80,"width":200,"height":50,"props":{"fieldKey":"note","defaultValue":"test","events":{"change":{"language":"python","code":"result = system.ui.sendMessage('input.notice', {'text': event.value})"}}}},
                {"id":"numeric","type":"numberInput","x":10,"y":140,"width":200,"height":50,"props":{"fieldKey":"quantity","defaultValue":2,"min":0,"max":10}},
                {"id":"flag","type":"checkbox","x":10,"y":200,"width":200,"height":50,"props":{"fieldKey":"flag","defaultValue":false}},
                {"id":"choice","type":"select","x":10,"y":260,"width":200,"height":50,"props":{"fieldKey":"choice","defaultValue":"a","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}]}},
                {"id":"password","type":"passwordInput","x":10,"y":320,"width":200,"height":50,"props":{"fieldKey":"password","defaultValue":""}}
                ]}],"templates":[]}
                """)!.AsObject();
            var workspace = catalog.Create("Messaging test", project);
            workspace.Publication.Publish(workspace.Store, workspace.Store.GetProject()["revision"]!.GetValue<int>());
            var stamp = workspace.Publication.GetProject()["publishedAt"]!.GetValue<string>();
            var messaging = new RuntimeSessionMessaging();
            var target = messaging.Register(workspace.Id, stamp, "u", "operator", "auth", () => true);
            messaging.Connect(workspace.Id, target.Id, "u", "auth");
            using var connectors = new ConnectorService(directory);
            using var tags = new TagEngine(catalog.GatewayStore, connectors, NullLogger<TagEngine>.Instance);
            var queries = new QueryExecutor(workspace.Store, connectors);
            var pythonPath = OperatingSystem.IsWindows() ? Path.GetFullPath("runtimes/python/windows-x64/python.exe") : "/usr/bin/python3";
            var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Python:Executable"] = pythonPath }).Build();
            var python = new PythonRunner(tags, queries, workspace.Scripts, config)
            {
                UiMessageDispatch = (type, value, id) => messaging.Send(workspace.Id, type, value, id),
                UiSessionInfo = () => messaging.GetSessionInfo(workspace.Id)
            };
            var marker = Path.Combine(directory, "syntax-must-not-execute.txt");
            var syntax = await python.ValidateSyntaxAsync("import definitely_missing_compile_only_module\nfrom project import not_a_real_library\nopen(" + JsonSerializer.Serialize(marker) + ", 'w').write('forbidden')\nsystem.tag.writeBlocking(['[default]never'], [1])\nsystem.db.runNamedQuery('missing')\nsystem.ui.sendMessage('forbidden')\nwhile True:\n    pass", CancellationToken.None);
            Check(syntax["valid"]!.GetValue<bool>() && !File.Exists(marker) && messaging.Take(target) is null, "compile-only validation imports no user modules and executes no writes, messages or infinite loop");
            syntax = await python.ValidateSyntaxAsync("if True print('invalid')", CancellationToken.None);
            Check(!syntax["valid"]!.GetValue<bool>() && syntax["line"]!.GetValue<int>() == 1 && syntax["column"]!.GetValue<int>() > 0 && syntax["message"]!.GetValue<string>().Length > 0, "actual CPython syntax error includes source position and message");
            Check((await python.ValidateSyntaxAsync("", CancellationToken.None))["valid"]!.GetValue<bool>(), "empty Python source compiles without execution");
            Check(!(await python.ValidateSyntaxAsync("nul\0source", CancellationToken.None))["valid"]!.GetValue<bool>(), "invalid null source is reported without executing");
            try { await python.ValidateSyntaxAsync(new string('x', 65537), CancellationToken.None); throw new Exception("Oversized syntax source accepted."); } catch (ArgumentException) { passed++; }
            try { await python.ValidateSyntaxAsync(null!, CancellationToken.None); throw new Exception("Missing syntax source accepted."); } catch (ArgumentException) { passed++; }
            using (var cancelled = new CancellationTokenSource())
            {
                cancelled.Cancel();
                try { await python.ValidateSyntaxAsync("pass", cancelled.Token); throw new Exception("Cancelled syntax validation accepted."); } catch (OperationCanceledException) { passed++; }
            }
            var previousPython = Environment.GetEnvironmentVariable("SPARKSTUDIO_PYTHON");
            PythonRunner unavailable;
            try
            {
                Environment.SetEnvironmentVariable("SPARKSTUDIO_PYTHON", null);
                unavailable = new PythonRunner(tags, queries, workspace.Scripts, new ConfigurationBuilder().AddInMemoryCollection(
                    new Dictionary<string, string?> { ["Python:Executable"] = Path.Combine(directory, "not-installed-python.exe") }).Build());
            }
            finally { Environment.SetEnvironmentVariable("SPARKSTUDIO_PYTHON", previousPython); }
            try { await unavailable.ValidateSyntaxAsync("pass", CancellationToken.None); throw new Exception("Missing compiler runtime accepted."); }
            catch (InvalidOperationException error) when (error.Message.Contains("unavailable", StringComparison.Ordinal)) { passed++; }
            var uiProject = workspace.Store.GetProject(); var uiScreen = uiProject["screens"]![0]!.AsObject();
            var uiDescription = PythonUiContext.Describe(uiProject, uiScreen, uiScreen, "input", false);
            Task<JsonObject> ValueScript(string code, PythonUiContext? context = null) => python.RunWithLibrariesAsync(code, null,
                new() { ["note"] = JsonSerializer.SerializeToElement("Original"), ["quantity"] = JsonSerializer.SerializeToElement("") },
                new Dictionary<string, string>(), CancellationToken.None, uiContext: context ?? new PythonUiContext(uiDescription));
            var valueResult = await ValueScript("assert self.value == 'Original'\nassert self.getSibling('numeric').value == ''\nself.value = 'Edited'\nself.props.value = 'Final'\nassert self.value == 'Final'\nself.getSibling('numeric').value = 7\nself.getSibling('flag').value = True\nself.getSibling('choice').value = 'b'\nresult = inputs['note']");
            Check(valueResult["success"]!.GetValue<bool>() && valueResult["uiEffects"]!.AsArray().Count == 4 && valueResult["uiEffects"]![0]!["kind"]!.GetValue<string>() == "input" && valueResult["uiEffects"]![0]!["value"]!.GetValue<string>() == "Final" && valueResult["result"]!.GetValue<string>() == "Original", "Python input value aliases stage/coalesce typed changes while inputs remains the invocation snapshot");
            foreach (var invalid in new[] { "self.getSibling('numeric').value = 11", "self.getSibling('numeric').value = ''", "self.getSibling('flag').value = 1", "self.getSibling('choice').value = 'unknown'", "self.value = 'x' * 4097", "self.getSibling('password').value = 'secret'", "result = self.getSibling('password').value", "self.getSibling('send').value = 'not an input'", "self.value = 'discard'; raise ValueError('expected')" })
            {
                valueResult = await ValueScript(invalid);
                Check(!valueResult["success"]!.GetValue<bool>() && !valueResult.ContainsKey("uiEffects"), "Python input assignment rejects invalid/bound/secret target without effects: " + invalid[..Math.Min(invalid.Length, 40)]);
            }
            valueResult = await ValueScript("self.value = 'late'", new PythonUiContext(uiDescription, readOnly: true));
            Check(!valueResult["success"]!.GetValue<bool>(), "unmount input assignment is rejected");
            foreach (var binding in new[] { "stateBinding", "tagPath", "optionsSource", "selectionFields", "readOnly", "bindings", "queryBindings" })
            {
                var descriptor = uiDescription.DeepClone().AsObject(); var props = descriptor["components"]![1]!["props"]!.AsObject();
                props[binding] = binding == "tagPath" ? JsonValue.Create("[default]ReadOnly") : binding == "readOnly" ? JsonValue.Create(true) : binding is "bindings" or "queryBindings" ? new JsonObject { ["value"] = new JsonObject() } : new JsonObject();
                valueResult = await ValueScript("self.value = 'bound'", new PythonUiContext(descriptor));
                Check(!valueResult["success"]!.GetValue<bool>(), "Python input writes reject " + binding + " ownership");
            }
            var result = await python.RunAsync("sessions = system.ui.getSessionInfo(); result = system.ui.sendMessage('targeted', {'text':'Python'}, sessionId=sessions[0]['sessionId'])", null, CancellationToken.None);
            Check(result["success"]!.GetValue<bool>() && result["result"]!["queued"]!.GetValue<int>() == 1 && messaging.Take(target)!["messageType"]!.GetValue<string>() == "targeted", "actual CPython inventory and targeted send");
            result = await python.RunAsync("result = system.ui.sendMessage('default')", null, CancellationToken.None);
            Check(result["success"]!.GetValue<bool>() && messaging.Take(target)!["payload"]!.AsObject().Count == 0, "Python defaults to empty JSON payload and same-project broadcast");
            result = await python.RunAsync("system.ui.sendMessage('invalid', [1,2])", null, CancellationToken.None);
            Check(!result["success"]!.GetValue<bool>() && messaging.Take(target) is null, "Python non-object payload rejected");
            result = await python.RunAsync("system.ui.sendMessage('cross', {}, project='other')", null, CancellationToken.None);
            Check(!result["success"]!.GetValue<bool>(), "Python cannot select another project");
            var actions = new RuntimeActions(workspace.Publication, python, queries);
            result = await actions.ExecuteAsync("main", "send", null, null, stamp, CancellationToken.None);
            Check(result["success"]!.GetValue<bool>() && messaging.Take(target)!["messageType"]!.GetValue<string>() == "button.notice", "published button executes session send");
            var input = new PythonComponentEventRequest(new("input", "change"), new JsonObject { ["type"] = "change", ["componentId"] = "input", ["fieldKey"] = "note", ["value"] = "Edited", ["previousValue"] = "test", ["origin"] = "user" },
                Inputs: new() { ["note"] = JsonSerializer.SerializeToElement("Edited") }, PublishedAt: stamp);
            result = await actions.ExecuteComponentEventAsync("main", "input", input, "operator", CancellationToken.None);
            Check(result["success"]!.GetValue<bool>() && messaging.Take(target)!["payload"]!["text"]!.GetValue<string>() == "Edited", "published component Python event executes session send");
            var draft = workspace.Scripts.GetDraft();
            draft["resources"] = new JsonArray(new JsonObject { ["id"] = "started", ["name"] = "started", ["type"] = "gateway", ["event"] = "startup", ["enabled"] = true, ["code"] = "result = system.ui.sendMessage('gateway.started', {'reason': event.type})" });
            var saved = workspace.Scripts.SaveDraft(draft);
            workspace.Publication.Publish(workspace.Store, workspace.Store.GetProject()["revision"]!.GetValue<int>(), ScriptResourceStore.Revision(saved));
            using var events = new ScriptEventService(workspace.Scripts, python, NullLogger<ScriptEventService>.Instance, tags);
            await events.StartAsync(CancellationToken.None);
            JsonObject? notice = null;
            for (var index = 0; index < 100 && notice is null; index++) { notice = messaging.Take(target); if (notice is null) await Task.Delay(25); }
            await events.StopAsync(CancellationToken.None);
            Check(notice?["messageType"]?.GetValue<string>() == "gateway.started" && notice["payload"]!["reason"]!.GetValue<string>() == "startup", "actual automatic gateway startup event sends to an operator session");
            messaging.Disconnect(target);
            result = await python.RunAsync("result = system.ui.sendMessage('no-listeners')", null, CancellationToken.None);
            Check(result["success"]!.GetValue<bool>() && result["result"]!["status"]!.GetValue<string>() == "noRecipients", "Python receives explicit disconnected-recipient result");
        }
        finally
        {
            if (Path.GetDirectoryName(directory) != Path.TrimEndingDirectorySeparator(temp)) throw new Exception("Unsafe fixture cleanup.");
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
        Console.WriteLine($"PASS {passed} runtime session messaging and actual CPython checks.");
        return passed;
    }
}
