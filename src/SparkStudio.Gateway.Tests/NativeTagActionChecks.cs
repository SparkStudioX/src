using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class NativeTagActionChecks
{
    private sealed class Clock : TimeProvider { public DateTimeOffset Now = DateTimeOffset.UtcNow; public override DateTimeOffset GetUtcNow() => Now; }
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool value, string description) { if (!value) throw new Exception("FAILED: " + description); passed++; }
        void Reject(Action action, string description)
        {
            try { action(); } catch (Exception error) when (error is ArgumentException or InvalidOperationException or KeyNotFoundException) { passed++; return; }
            throw new Exception("FAILED to reject: " + description);
        }
        async Task RejectAsync(Func<Task> action, string description)
        {
            try { await action(); } catch (Exception error) when (error is ArgumentException or InvalidOperationException or KeyNotFoundException or BadHttpRequestException or OperationCanceledException) { passed++; return; }
            throw new Exception("FAILED to reject: " + description);
        }
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.NativeTagActions." + Guid.NewGuid().ToString("N"));
        var protection = new EphemeralDataProtectionProvider();
        try
        {
            var catalog = new ProjectCatalog(directory, protection); var workspace = catalog.Create("Native tag action fixture"); var store = workspace.Store;
            var project = store.GetProject(); project["parameters"] = new JsonObject();
            project["screens"] = JsonNode.Parse("""
            [{"id":"main","name":"Main","width":800,"height":600,"components":[
              {"id":"boolean","type":"button","x":0,"y":0,"width":150,"height":40,"props":{"text":"Start","action":"setTagValue","tagWrite":{"tagPath":"[default]Native/Running","dataType":"Boolean","value":true}}},
              {"id":"number","type":"button","x":0,"y":50,"width":150,"height":40,"props":{"action":"setTagValue","tagWrite":{"tagPath":"[default]Native/Amount","dataType":"Int32","value":12,"confirmation":"Apply saved amount?"}}},
              {"id":"text","type":"button","x":0,"y":100,"width":150,"height":40,"props":{"action":"setTagValue","tagWrite":{"tagPath":"[default]Native/Note","dataType":"String","value":"Authored value"}}},
              {"id":"open","type":"button","x":0,"y":150,"width":150,"height":40,"props":{"action":"openPopup","targetScreenId":"popup"}},
              {"id":"rows","type":"repeater","x":200,"y":0,"width":400,"height":300,"props":{"templateId":"card","rows":[{"id":"first","parameters":{}},{"id":"second","parameters":{}}]}}
            ]},{"id":"popup","name":"Popup","kind":"popup","width":300,"height":200,"components":[
              {"id":"write","type":"button","x":0,"y":0,"width":150,"height":40,"props":{"action":"setTagValue","tagWrite":{"tagPath":"[default]Native/Running","dataType":"Boolean","value":false}}}
            ]}]
            """);
            project["templates"] = JsonNode.Parse("""
            [{"id":"card","name":"Card","width":200,"height":100,"parameters":{},"components":[
              {"id":"write","type":"button","x":0,"y":0,"width":150,"height":40,"props":{"action":"setTagValue","tagWrite":{"tagPath":"[default]Native/Amount","dataType":"Int32","value":14}}}
            ]}]
            """);
            store.SaveProject(project);
            string Publish() => workspace.Publication.Publish(store, store.GetProject()["revision"]!.GetValue<int>())["publishedAt"]!.GetValue<string>();
            var stamp = Publish();
            using var connectors = new ConnectorService(directory); using var tags = new TagEngine(catalog.GatewayStore, connectors, NullLogger<TagEngine>.Instance);
            var queries = new QueryExecutor(store, connectors); var python = new PythonRunner(tags, queries, workspace.Scripts, new ConfigurationBuilder().Build());
            var actions = new RuntimeActions(workspace.Publication, python, queries);
            var security = new SecurityStore(directory); var setup = File.ReadAllText(Path.Combine(directory, "security", "setup-code.txt")).Trim();
            var admin = security.Setup(setup, new("native-admin", "Synthetic-native-fixture-password-123"));
            var operatorUser = security.CreateUser(new("native-operator", "Synthetic-native-fixture-password-456", ProjectGrants: new() { [workspace.Id] = new(Commands: true) }));
            var operateOnly = security.CreateUser(new("native-operate", "Synthetic-native-fixture-password-789", ProjectGrants: new() { [workspace.Id] = new(View: true, Operate: true) }));
            DefaultHttpContext Context(SecurityUser user, string? projectId = null, string audience = "operator")
            { var context = new DefaultHttpContext(); context.Items["spark.actor"] = user; context.Items["spark.project"] = projectId ?? workspace.Id; context.Items["spark.audience"] = audience; return context; }
            var context = Context(operatorUser); var clock = new Clock(); var commands = new EquipmentCommands(connectors, tags, security, new RecoveryQuarantine(directory), clock);
            void Tag(string path, string type, object value, bool enabled = true) => tags.SaveDefinition(new JsonObject { ["path"] = path, ["kind"] = "memory", ["dataType"] = type, ["value"] = JsonSerializer.SerializeToNode(value), ["enabled"] = enabled });
            Tag("[default]Native/Running", "Boolean", false); Tag("[default]Native/Amount", "Int32", 0); Tag("[default]Native/Note", "String", "");
            JsonObject Node(object value) => JsonSerializer.SerializeToNode(value, ProjectStore.Json)!.AsObject();
            string Resource(string screen, string component) => "tag-action:" + JsonSerializer.Serialize(new[] { screen, component });
            RuntimeActionRequest Request(string? instance = null, string? row = null, PopupOrigin? popup = null) => new(null, null, stamp, instance, row, popup);
            Task<JsonObject> Capture(string component = "boolean", RuntimeActionRequest? request = null, string screen = "main") => actions.CaptureTagActionAsync(screen, component, request ?? Request(), CancellationToken.None);
            async Task<JsonObject> Review(string component = "boolean", RuntimeActionRequest? request = null, string screen = "main", HttpContext? actor = null, Func<bool>? session = null)
            {
                var saved = request ?? Request();
                return Node(await commands.ReviewNative(actor ?? context, store, Resource(screen, component), saved.PublishedAt!, token => actions.CaptureTagActionAsync(screen, component, saved, token), CancellationToken.None, session));
            }
            async Task<JsonObject> Execute(JsonObject ticket, string component = "boolean", string screen = "main", HttpContext? actor = null, CancellationToken cancellation = default)
                => Node(await commands.ExecuteNative(actor ?? context, store, workspace.Publication, Resource(screen, component), new(ticket["token"]!.GetValue<string>(), true), cancellation));
            JsonNode Value(string name) => catalog.GatewayStore.GetRuntimeTagDefinitions().OfType<JsonObject>().Single(tag => tag["path"]!.GetValue<string>() == "[default]Native/" + name)["value"]!;
            await RejectAsync(() => Review(), "project tag scope precedes write");
            security.UpdateSettings(new(security.Settings.Revision, null, new() { [workspace.Id] = ["[default]Native/"] }));
            await RejectAsync(() => Review(actor: Context(operateOnly)), "Operate cannot substitute for Commands");
            await RejectAsync(() => Review(actor: Context(admin, audience: "engineering")), "engineering sessions cannot run operator writes");
            await RejectAsync(() => Review(session: () => false), "ended operator session cannot create review");
            var boolean = await Review(); Check(boolean["confirmation"]!.GetValue<string>() == "" && boolean["requestedValue"]!.GetValue<bool>(), "native optional confirmation is empty and target value comes from saved declaration");
            await RejectAsync(() => Execute(boolean, component: "number"), "opaque ticket binds its component route");
            await RejectAsync(() => Execute(boolean, actor: Context(admin)), "opaque ticket binds actor");
            await RejectAsync(() => Execute(boolean, actor: Context(operatorUser, "other")), "opaque ticket binds project");
            await RejectAsync(async () => await commands.Execute(context, store, workspace.Publication, "native-tag", new(boolean["token"]!.GetValue<string>(), true), CancellationToken.None), "native ticket cannot bypass normal command route");
            Check((await Execute(boolean))["status"]!.GetValue<string>() == "confirmed" && Value("Running").GetValue<bool>(), "saved Boolean native action dispatches once and confirms memory readback");
            await RejectAsync(() => Execute(boolean), "native ticket replay rejected");
            var number = await Review("number"); Check(number["confirmation"]!.GetValue<string>() == "Apply saved amount?", "native confirmation is preserved");
            Check((await Execute(number, "number"))["status"]!.GetValue<string>() == "confirmed" && Value("Amount").GetValue<int>() == 12, "numeric native write is typed and confirmed");
            var text = await Review("text"); Check((await Execute(text, "text"))["status"]!.GetValue<string>() == "confirmed" && Value("Note").GetValue<string>() == "Authored value", "text native write is literal and confirmed");
            await RejectAsync(() => Capture(request: Request() with { Inputs = new() { ["value"] = JsonSerializer.SerializeToElement(false) } }), "runtime form cannot override native literal");
            await RejectAsync(() => Capture(request: Request() with { Ui = new JsonObject() }), "runtime UI cannot replace native action");
            await RejectAsync(() => Capture(request: Request() with { Parameters = new() { ["tagPath"] = JsonSerializer.SerializeToElement("[default]Native/Other") } }), "undeclared parameter cannot override native path");
            await RejectAsync(() => Capture("write"), "template leaf cannot be invoked without placement identity");
            await RejectAsync(() => Capture("write", Request("rows", "forged")), "forged repeater row rejected");
            var rowTicket = await Review("write", Request("rows", "first")); Check((await Execute(rowTicket, "write"))["status"]!.GetValue<string>() == "confirmed" && Value("Amount").GetValue<int>() == 14, "saved repeater row native action uses validated placement");
            await RejectAsync(() => Capture("write", screen: "popup"), "popup action requires published opener");
            var popupTicket = await Review("write", Request(popup: new("main", "open")), "popup"); Check((await Execute(popupTicket, "write", "popup"))["status"]!.GetValue<string>() == "confirmed" && !Value("Running").GetValue<bool>(), "popup native action reconstructs published opener");
            var liveSession = true; boolean = await Review(session: () => liveSession); liveSession = false;
            Check((await Execute(boolean))["status"]!.GetValue<string>() == "rejected" && !Value("Running").GetValue<bool>(), "session revocation after review prevents dispatch");
            boolean = await Review(); Tag("[default]Native/Running", "Boolean", true);
            Check((await Execute(boolean))["status"]!.GetValue<string>() == "rejected", "value changed after review rejects without dispatch");
            boolean = await Review(); Tag("[default]Native/Running", "Boolean", true, false);
            Check((await Execute(boolean))["status"]!.GetValue<string>() == "rejected", "disabled configuration invalidates review");
            await RejectAsync(() => Review(), "disabled tag cannot create review"); Tag("[default]Native/Running", "Boolean", false);
            boolean = await Review(); stamp = Publish(); Check((await Execute(boolean))["status"]!.GetValue<string>() == "rejected", "new publication invalidates native ticket");
            await RejectAsync(() => Capture(request: Request() with { PublishedAt = "stale" }), "stale runtime stamp cannot capture action");
            boolean = await Review(); clock.Now += TimeSpan.FromSeconds(31); await RejectAsync(() => Execute(boolean), "expired native ticket rejected");
            boolean = await Review(); using (var cancelled = new CancellationTokenSource()) { cancelled.Cancel(); await RejectAsync(() => Execute(boolean, cancellation: cancelled.Token), "cancelled native ticket cannot dispatch"); }
            Check(!Value("Running").GetValue<bool>(), "all rejected native requests leave memory unchanged");
            var props = store.GetProject()["screens"]![0]!["components"]![0]!["props"]!.AsObject();
            foreach (var mutation in new Action<JsonObject>[] {
                item => item["tagWrite"]!["value"] = "true", item => item["tagWrite"]!["tagPath"] = "[default]../Bad", item => item["tagWrite"]!["tagPath"] = "[default]{parameter}/Target",
                item => item["tagWrite"]!["dataType"] = "Unknown", item => item["tagWrite"]!["extra"] = true, item => item["tagWrite"]!["confirmation"] = "",
                item => item["tagWrite"]!["value"] = new JsonObject(), item => item["tagWrite"]!["value"] = null })
            { var bad = props.DeepClone().AsObject(); mutation(bad); Reject(() => NativeTagActionDefinitions.Validate(bad["tagWrite"]), "strict native tag declaration rejects invalid path/type/value/unknown fields"); }
            var normal = store.GetProject(); normal["commands"] = JsonNode.Parse("""[{"id":"amount","name":"Bounded amount","tagPath":"[default]Native/Amount","dataType":"Int32","min":0,"max":20,"confirmation":"Existing reviewed amount?","timeoutMs":100}]"""); store.SaveProject(normal); stamp = Publish();
            number = await Review("number"); Check(number["commandId"]!.GetValue<string>() == "amount" && number["confirmation"]!.GetValue<string>() == "Existing reviewed amount?", "native action preserves declared equipment command identity and confirmation");
            var outOfBounds = store.GetProject(); outOfBounds["screens"]![0]!["components"]![1]!["props"]!["tagWrite"]!["value"] = 21;
            Reject(() => store.SaveProject(outOfBounds), "native action cannot bypass existing command bounds at save");
            var conflicting = store.GetProject(); conflicting["screens"]![0]!["components"]![1]!["props"]!["tagWrite"]!["dataType"] = "Double";
            Reject(() => store.SaveProject(conflicting), "native action cannot conflict with existing command type");
            var duplicate = store.GetProject(); var second = duplicate["commands"]![0]!.DeepClone().AsObject(); second["id"] = "other"; duplicate["commands"]!.AsArray().Add(second);
            Reject(() => store.SaveProject(duplicate), "ambiguous existing commands cannot be bypassed");
            var inheritedReadback = store.GetProject(); inheritedReadback["commands"]![0]!["readbackPath"] = "[default]Native/Readback"; store.SaveProject(inheritedReadback); stamp = Publish(); Tag("[default]Native/Readback", "Int32", 0);
            number = await Review("number"); Check((await Execute(number, "number"))["status"]!.GetValue<string>() == "notConfirmed", "native action preserves declared command readback and timeout");
            Tag("[default]Native/Running", "Int32", 0); await RejectAsync(() => Review(), "changed gateway tag type prevents native review"); Tag("[default]Native/Running", "Boolean", false);
            var package = SparkProjectPackage.Export(workspace); var imported = SparkProjectPackage.Import(catalog, package, "Native roundtrip");
            var importedStamp = imported.Publication.Publish(imported.Store, imported.Store.GetProject()["revision"]!.GetValue<int>())["publishedAt"]!.GetValue<string>();
            Check(imported.Publication.GetTagAction("main", "boolean", importedStamp)["tagWrite"]!["value"]!.GetValue<bool>() && SparkProjectPackage.Export(imported).Length > 0, "native declaration survives import publication and re-export");
            catalog.GatewayStore.FlushMemoryValues(); var reloaded = new ProjectCatalog(directory, protection);
            Check(reloaded.GatewayStore.GetRuntimeTagDefinitions().OfType<JsonObject>().Single(tag => tag["path"]!.GetValue<string>() == "[default]Native/Note")["value"]!.GetValue<string>() == "Authored value", "native memory writes survive durable checkpoint and gateway reload");
            var audit = File.ReadAllText(Path.Combine(directory, "security", "audit.jsonl"));
            Check(audit.Contains("equipment.review") && audit.Contains("confirmed") && audit.Contains("rejected") && !audit.Contains("Authored value") && !audit.Contains("Synthetic-native-fixture-password"), "native audit records correlation and outcomes without scalar secrets or credentials");

            // A property reference supplies the source identity, never an authored
            // snapshot of its displayed value or a browser-selected destination.
            var dynamic = store.GetProject();
            dynamic["commands"]![0]!.AsObject().Remove("readbackPath");
            dynamic["screens"]![0]!["state"] = JsonNode.Parse("""{"offset":{"type":"number","value":0}}""");
            dynamic["screens"]![0]!["components"]!.AsArray().Add(JsonNode.Parse("""{"id":"amount-input","type":"numberInput","x":0,"y":200,"width":150,"height":40,"props":{"fieldKey":"requested","defaultValue":0,"min":0,"max":20}}"""));
            dynamic["screens"]![0]!["components"]![1]!["props"]!["tagWrite"]!.AsObject().Remove("value");
            dynamic["screens"]![0]!["components"]![1]!["props"]!["tagWrite"]!["valueReference"] = JsonNode.Parse("""{"kind":"property","componentId":"amount-input","property":"value"}""");
            store.SaveProject(dynamic); stamp = Publish();
            RuntimeActionRequest DynamicInput(object value) => Request() with { Inputs = new() { ["requested"] = JsonSerializer.SerializeToElement(value) } };
            number = await Review("number", DynamicInput(17));
            Check(number["requestedValue"]!.GetValue<int>() == 17 && (await Execute(number, "number"))["status"]!.GetValue<string>() == "confirmed" && Value("Amount").GetValue<int>() == 17, "native sibling input reference writes current validated scoped value");
            await RejectAsync(() => Review("number"), "dynamic source input cannot silently use its authored default");
            await RejectAsync(() => Review("number", DynamicInput("17")), "dynamic number input requires native number instead of numeric text");
            await RejectAsync(() => Review("number", DynamicInput(21)), "dynamic source enforces authored input and existing command bounds");
            var both = store.GetProject(); both["screens"]![0]!["components"]![1]!["props"]!["tagWrite"]!["value"] = 12;
            Reject(() => store.SaveProject(both), "native declaration requires exactly one literal or property value source");
            foreach (var invalid in new[] {
                """{"kind":"property","componentId":"write","property":"value"}""",
                """{"kind":"property","componentId":"amount-input","property":"script"}""",
                """{"kind":"property","componentId":"amount-input","property":"__proto__.text"}""",
                """{"kind":"parentProperty","property":"secret"}""",
                """{"kind":"parentProperty","componentId":"amount-input","property":"name"}""",
                """{"kind":"property","componentId":"amount-input","property":"value","value":99}""" })
            {
                var bad = store.GetProject(); bad["screens"]![0]!["components"]![1]!["props"]!["tagWrite"]!["valueReference"] = JsonNode.Parse(invalid);
                Reject(() => store.SaveProject(bad), "native source rejects cross-form identities, unsupported paths and client value fields");
            }
            var secret = store.GetProject(); secret["screens"]![0]!["components"]!.AsArray().Add(JsonNode.Parse("""{"id":"secret","type":"passwordInput","x":0,"y":250,"width":150,"height":40,"props":{"fieldKey":"secret"}}"""));
            secret["screens"]![0]!["components"]![1]!["props"]!["tagWrite"]!["valueReference"] = JsonNode.Parse("""{"kind":"property","componentId":"secret","property":"value"}""");
            Reject(() => store.SaveProject(secret), "native property sources cannot read passwords");
            var parent = store.GetProject(); var textProps = parent["screens"]![0]!["components"]![2]!["props"]!.AsObject();
            textProps["tagWrite"]!.AsObject().Remove("value"); textProps["tagWrite"]!["valueReference"] = JsonNode.Parse("""{"kind":"parentProperty","property":"name"}""");
            store.SaveProject(parent); stamp = Publish(); text = await Review("text");
            Check(text["requestedValue"]!.GetValue<string>() == "Main" && (await Execute(text, "text"))["status"]!.GetValue<string>() == "confirmed", "parent metadata reference reads authored containing screen name");
            var self = store.GetProject(); textProps = self["screens"]![0]!["components"]![2]!["props"]!.AsObject(); textProps["text"] = "Authored caption";
            textProps["tagWrite"]!["valueReference"] = JsonNode.Parse("""{"kind":"property","property":"text"}"""); store.SaveProject(self); stamp = Publish();
            var uiSnapshot = JsonNode.Parse("""{"state":{"session":{},"screen":{"offset":0}},"properties":{"text":{"text":"Runtime caption"}}}""")!.AsObject();
            text = await Review("text", Request() with { Ui = uiSnapshot });
            Check(text["requestedValue"]!.GetValue<string>() == "Runtime caption" && (await Execute(text, "text"))["status"]!.GetValue<string>() == "confirmed", "self property reads validated Python UI override instead of stale authored caption");

            catalog.GatewayStore.SaveConnection(new JsonObject { ["id"] = "native-query", ["name"] = "Native read source", ["type"] = "sqlite", ["database"] = "native-query.db" });
            await connectors.CreateSqliteDatabaseAsync(store.GetConnection("native-query"), false, CancellationToken.None);
            store.SaveQuery("native-read", JsonNode.Parse("""{"id":"native-read","name":"Native read","connectionId":"native-query","sql":"SELECT @amount * 2 AS amount","parameters":[{"name":"amount","type":"number"}]}""")!.AsObject());
            var bound = store.GetProject(); var numberProps = bound["screens"]![0]!["components"]![1]!["props"]!.AsObject();
            numberProps["customProperties"] = JsonNode.Parse("""{"base":{"type":"number","value":0},"queried":{"type":"number","value":0},"derived":{"type":"number","value":0}}""");
            numberProps["bindings"] = JsonNode.Parse("""{"customProperties.base.value":{"expression":"input + offset","references":{"input":{"kind":"input","key":"requested"},"offset":{"kind":"screenState","key":"offset"}}},"customProperties.derived.value":{"expression":"queried / 2 + tag","references":{"queried":{"kind":"custom","key":"queried"},"tag":{"kind":"tag","path":"[default]Native/Source"}}}}""");
            numberProps["queryBindings"] = JsonNode.Parse("""{"customProperties.queried.value":{"queryId":"native-read","column":"amount","refresh":{"mode":"onChange"},"parameters":{"amount":{"expression":"base","references":{"base":{"kind":"custom","key":"base"}}}}}}""");
            numberProps["tagWrite"]!["valueReference"] = JsonNode.Parse("""{"kind":"property","property":"customProperties.derived.value"}""");
            store.SaveProject(bound); stamp = Publish(); Tag("[default]Native/Source", "Int32", 3);
            actions = new RuntimeActions(workspace.Publication, python, queries, path => JsonSerializer.SerializeToElement(tags.Read([path], null)[0].Value));
            RuntimeActionRequest BoundRequest() => DynamicInput(6) with { Ui = JsonNode.Parse("""{"state":{"session":{},"screen":{"offset":1}},"properties":{}}""")!.AsObject() };
            number = await Review("number", BoundRequest());
            Check(number["requestedValue"]!.GetValue<int>() == 10 && (await Execute(number, "number"))["status"]!.GetValue<string>() == "confirmed", "bound custom property recursively reconstructs current input, state, gateway tag and query values");
            await RejectAsync(() => Review("number", DynamicInput(6)), "bound state dependency requires current UI source snapshot");
            number = await Review("number", BoundRequest()); Tag("[default]Native/Source", "Int32", 4);
            Check((await Execute(number, "number"))["status"]!.GetValue<string>() == "rejected" && Value("Amount").GetValue<int>() == 10, "changed external source after review rejects instead of writing a re-evaluated value");
            var deniedActions = new RuntimeActions(workspace.Publication, python, queries, _ => throw new ArgumentException("Source tag unavailable"));
            await RejectAsync(() => deniedActions.CaptureTagActionAsync("main", "number", BoundRequest(), CancellationToken.None), "unavailable transitive source tag prevents native action capture");
            var dynamicExport = SparkProjectPackage.Export(workspace); var dynamicImport = SparkProjectPackage.Import(catalog, dynamicExport, "Dynamic native roundtrip");
            var dynamicStamp = dynamicImport.Publication.Publish(dynamicImport.Store, dynamicImport.Store.GetProject()["revision"]!.GetValue<int>())["publishedAt"]!.GetValue<string>();
            Check(dynamicImport.Publication.GetTagAction("main", "number", dynamicStamp)["tagWrite"]?["valueReference"]?["property"]?.GetValue<string>() == "customProperties.derived.value", "dynamic property source survives package roundtrip and explicit publication");

            var presentation = store.GetProject();
            presentation["parameters"]!["station"] = "West";
            textProps = presentation["screens"]![0]!["components"]![2]!["props"]!.AsObject();
            textProps["text"] = "Station {station}";
            store.SaveProject(presentation); stamp = Publish();
            text = await Review("text");
            Check(text["requestedValue"]!.GetValue<string>() == "Station West", "authored caption source expands current declared parameters once");
            uiSnapshot["properties"]!["text"]!["text"] = "Literal {station}";
            text = await Review("text", Request() with { Ui = uiSnapshot });
            Check(text["requestedValue"]!.GetValue<string>() == "Literal {station}", "script UI override text preserves literal braces instead of expanding parameters");
            presentation = store.GetProject(); presentation["styles"] = JsonNode.Parse("""[{"id":"native-palette","name":"Native palette","properties":{"color":"#123456"}}]""");
            textProps = presentation["screens"]![0]!["components"]![2]!["props"]!.AsObject(); textProps["styleId"] = "native-palette";
            textProps["tagWrite"]!["valueReference"]!["property"] = "color";
            store.SaveProject(presentation); stamp = Publish(); text = await Review("text");
            Check(text["requestedValue"]!.GetValue<string>() == "#123456", "appearance property uses its saved assigned visual style when local property is absent");
            presentation = store.GetProject(); presentation["screens"]![0]!["components"]![2]!["props"]!["tagWrite"]!["valueReference"]!["property"] = "borderColor";
            store.SaveProject(presentation); stamp = Publish();
            await RejectAsync(() => Review("text"), "theme or inherited appearance without an explicit source cannot be used as a native tag value");
            var narrowed = store.GetProject(); narrowed["screens"]![0]!["components"]![1]!["props"]!["tagWrite"]!["valueReference"] = JsonNode.Parse("""{"kind":"property","componentId":"amount-input","property":"value"}""");
            narrowed["screens"]![0]!["components"]!.AsArray().OfType<JsonObject>().Single(item => item["id"]!.GetValue<string>() == "amount-input")["props"]!["bindings"] = JsonNode.Parse("""{"max":{"expression":"15","references":{}}}""");
            store.SaveProject(narrowed); stamp = Publish();
            await RejectAsync(() => Review("number", DynamicInput(17)), "current input source also respects reconstructed runtime bounds that narrow authored bounds");
            number = await Review("number", DynamicInput(12));
            Check(number["requestedValue"]!.GetValue<int>() == 12, "current input source accepts value inside authored and bound display constraints");
            var auditAction = typeof(GatewayAccess).GetMethod("AuditAction", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!;
            var longRoute = "POST /api/projects/{projectId}/runtime/screens/{screenId}/components/{componentId}/tag-action/";
            var reviewAudit = (string)auditAction.Invoke(null, [longRoute + "review"])!;
            var executeAudit = (string)auditAction.Invoke(null, [longRoute + "execute"])!;
            Check(reviewAudit.Length <= 100 && executeAudit.Length <= 100 && reviewAudit.EndsWith("review") && executeAudit.EndsWith("execute") && reviewAudit != executeAudit, "long audit event names preserve operation prefix and distinct route suffix");
            var mismatchedSource = store.GetProject(); mismatchedSource["screens"]![0]!["components"]![1]!["props"]!["tagWrite"]!["valueReference"] = JsonNode.Parse("""{"kind":"parentProperty","property":"name"}""");
            Reject(() => store.SaveProject(mismatchedSource), "authored String property cannot be published as numeric tag value");
            await RejectAsync(() => Capture("number", DynamicInput(new string('x', 270000))), "oversized native source snapshot cannot be retained in a reviewed ticket");
            var passwordSnapshot = store.GetProject(); passwordSnapshot["screens"]![0]!["components"]!.AsArray().Add(JsonNode.Parse("""{"id":"password-field","type":"passwordInput","x":0,"y":300,"width":150,"height":40,"props":{"fieldKey":"secret"}}"""));
            store.SaveProject(passwordSnapshot); stamp = Publish();
            await RejectAsync(() => Review("boolean", Request() with { Inputs = new() { ["secret"] = JsonSerializer.SerializeToElement("private") } }), "native request cannot retain unused password input values");
            boolean = await Review("boolean", DynamicInput("partially entered number"));
            Check(boolean["requestedValue"]!.GetValue<bool>(), "fixed native action remains independent of an unrelated input's transient editing buffer");
            return passed;
        }
        finally { if (Directory.Exists(directory) && Path.GetDirectoryName(directory) == Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()))) Directory.Delete(directory, true); }
    }
}
