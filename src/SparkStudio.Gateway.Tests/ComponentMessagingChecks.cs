using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using SparkStudio.Gateway;

internal static class ComponentMessagingChecks
{
    public static int Run()
    {
        var passed = 0;
        void Check(bool condition, string description)
        {
            if (!condition) throw new Exception("FAILED: " + description);
            passed++;
        }
        void Reject(Action action, string description)
        {
            try { action(); } catch (ArgumentException) { passed++; return; }
            throw new Exception("FAILED to reject: " + description);
        }
        var temporaryRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
        var directory = Path.GetFullPath(Path.Combine(temporaryRoot, "SparkStudio.ComponentMessaging." + Guid.NewGuid().ToString("N")));
        if (Path.GetDirectoryName(directory) != temporaryRoot) throw new Exception("Unsafe test directory.");
        try
        {
            var catalog = new ProjectCatalog(directory, new EphemeralDataProtectionProvider());
            var workspace = catalog.Create("Message test", Project());
            JsonObject Draft() => workspace.Store.GetProject();
            JsonObject Props(JsonObject draft) => draft["screens"]![0]!["components"]![0]!["props"]!.AsObject();
            JsonObject Button(JsonObject draft) => draft["screens"]![0]!["components"]![1]!["props"]!.AsObject();
            void Invalid(Action<JsonObject> mutate, string description)
            {
                var before = Draft().ToJsonString();
                var draft = Draft(); mutate(draft);
                Reject(() => workspace.Store.SaveProject(draft), description);
                Check(Draft().ToJsonString() == before, description + " leaves the saved draft unchanged");
            }
            void InvalidHandler(string key, JsonNode? value, string description) => Invalid(draft => Props(draft)["messageHandlers"]![0]![key] = value?.DeepClone(), description);

            foreach (var invalid in new JsonNode?[] { null, new JsonObject(), JsonValue.Create("not an array") })
                Invalid(draft => Props(draft)["messageHandlers"] = invalid?.DeepClone(), "non-array message handlers");
            Invalid(draft => Props(draft)["messageHandlers"] = new JsonArray(Enumerable.Range(0, 17).Select(index => (JsonNode)Handler("h" + index, "type" + index)).ToArray()), "more than sixteen handlers");
            Invalid(draft => Props(draft)["messageHandlers"]!.AsArray().Add(null), "null handler");
            Invalid(draft => Props(draft)["messageHandlers"]![0]!["extra"] = true, "unknown handler field");
            Invalid(draft => Props(draft)["messageHandlers"]![0]!.AsObject().Remove("code"), "missing handler field");
            foreach (var id in new[] { "", "1startsWithDigit", "has space", "a/b", new string('a', 81) }) InvalidHandler("id", JsonValue.Create(id), "invalid handler ID");
            InvalidHandler("id", JsonValue.Create(42), "nontext handler ID");
            Invalid(draft => Props(draft)["messageHandlers"]!.AsArray().Add(Handler("receive", "another")), "duplicate handler ID");
            foreach (var type in new[] { "", " ", " leading", "trailing ", "line\nbreak", "control\u007f", "control\u0085", "\uFEFFtype", "type\uFEFF", new string('x', 81) })
                InvalidHandler("messageType", JsonValue.Create(type), "invalid message type");
            InvalidHandler("messageType", JsonValue.Create(42), "nontext message type");
            foreach (var scope in new[] { "project", "gateway", "Screen", "" }) InvalidHandler("scope", JsonValue.Create(scope), "unknown handler scope");
            Invalid(draft => Props(draft)["messageHandlers"]!.AsArray().Add(Handler("duplicate")), "duplicate type and scope subscription");
            InvalidHandler("language", JsonValue.Create("ruby"), "unsupported handler language");
            foreach (var code in new[] { "", " \r\n\t", "\uFEFF", new string('x', 65_537) }) InvalidHandler("code", JsonValue.Create(code), "empty or oversized handler code");
            InvalidHandler("code", JsonValue.Create(42), "nontext handler code");
            Invalid(draft => draft["messageHandlers"] = new JsonArray(), "project-level handler placement");
            Invalid(draft => draft["screens"]![0]!["messageHandlers"] = new JsonArray(), "screen-level handler placement");
            Invalid(draft => draft["screens"]![0]!["components"]![0]!["messageHandlers"] = new JsonArray(), "component-level handler placement");
            Invalid(draft => draft["templates"]![0]!["components"]![0]!["props"]!["messageHandlers"]![0]!["scope"] = "gateway", "template handler validation");

            Invalid(draft => Button(draft).Remove("message"), "message action without configuration");
            Invalid(draft => Button(draft)["message"]!["extra"] = true, "unknown native message field");
            Invalid(draft => Button(draft)["message"]!.AsObject().Remove("scope"), "incomplete native message action");
            Invalid(draft => Button(draft)["message"]!["messageType"] = " padded ", "invalid native message type");
            Invalid(draft => Button(draft)["message"]!["scope"] = "gateway", "invalid native message scope");
            Invalid(draft => Props(draft)["message"] = Button(draft)["message"]!.DeepClone(), "native sender on a label");
            Invalid(draft => Props(draft)["action"] = "message", "native message action on a label");
            foreach (var payload in new JsonNode?[] { null, new JsonArray(), JsonValue.Create("text"), JsonValue.Create(42) })
                Invalid(draft => Button(draft)["message"]!["payload"] = payload?.DeepClone(), "non-object native payload");
            Invalid(draft => Button(draft)["message"]!["payload"] = new JsonObject { ["text"] = new string('x', 65_530) }, "native payload above UTF-8 limit");
            Invalid(draft => Button(draft)["message"]!["payload"] = new JsonObject { ["text"] = new string('\u00e9', 32_765) }, "UTF-8 bytes rather than character count limit");
            Invalid(draft => Button(draft)["message"]!["payload"] = new JsonObject { ["text"] = string.Concat(Enumerable.Repeat("\U0001f600", 16_382)) }, "supplementary UTF-8 payload over limit");
            Invalid(draft => Button(draft)["message"]!["payload"] = new JsonObject { ["value"] = 9007199254740992L }, "unsafe native integer");
            Invalid(draft => Button(draft)["message"]!["payload"] = NestedPayload(17), "native payload depth limit");
            Invalid(draft => Button(draft)["message"]!["payload"] = new JsonObject { ["items"] = new JsonArray(Enumerable.Range(0, 4095).Select(_ => (JsonNode?)null).ToArray()) }, "native payload node limit");

            var valid = Draft();
            Props(valid)["messageHandlers"]!.AsArray().Add(Handler("sameTypeDifferentScope", scope: "session"));
            Props(valid)["messageHandlers"]!.AsArray().Add(Handler(new string('a', 80), new string('t', 80), "instance", new string('x', 65_536)));
            Button(valid)["message"]!["payload"] = new JsonObject
            {
                ["text"] = "Independent authored test", ["number"] = 42, ["fraction"] = 0.25,
                ["safe"] = 9007199254740991L, ["nested"] = new JsonArray(true, null, "text", new JsonObject { ["value"] = false })
            };
            var saved = workspace.Store.SaveProject(valid);
            Check(Props(saved)["messageHandlers"]!.AsArray().Count == 3, "distinct scopes, maximum IDs/types and maximum code accepted");
            var definitions = Props(saved)["messageHandlers"]!.ToJsonString();
            var sender = Button(saved)["message"]!.ToJsonString();
            workspace.Publication.Publish(workspace.Store, saved["revision"]!.GetValue<int>());
            Check(Props(workspace.Publication.GetProject())["messageHandlers"]!.ToJsonString() == definitions, "publication preserves authored JavaScript verbatim without executing it");
            Check(Button(workspace.Publication.GetProject())["message"]!.ToJsonString() == sender, "publication preserves native sender configuration");

            var archive = SparkProjectPackage.Export(workspace);
            var imported = SparkProjectPackage.Import(catalog, archive, "Imported message test");
            Check(!imported.Publication.Metadata()["published"]!.GetValue<bool>(), "message project import remains unpublished");
            Check(Props(imported.Store.GetProject())["messageHandlers"]!.ToJsonString() == definitions, "package import preserves handlers");
            Check(Button(imported.Store.GetProject())["message"]!.ToJsonString() == sender, "package import preserves sender configuration");
            imported.Publication.Publish(imported.Store, imported.Store.GetProject()["revision"]!.GetValue<int>());
            var twice = SparkProjectPackage.Import(catalog, SparkProjectPackage.Export(imported), "Re-exported message test");
            Check(Props(twice.Store.GetProject())["messageHandlers"]!.ToJsonString() == definitions, "re-export and second import preserve all handler scopes");
            var count = catalog.List().Count;
            Reject(() => SparkProjectPackage.Import(catalog, RewriteProject(archive, project => Props(project)["messageHandlers"]![0]!["language"] = "ruby")), "malformed imported handler");
            Reject(() => SparkProjectPackage.Import(catalog, RewriteProject(archive, project => Button(project)["message"]!["payload"] = new JsonArray())), "malformed imported sender");
            Check(catalog.List().Count == count, "invalid packages do not create catalog entries");

            var edge = Draft(); Props(edge)["messageHandlers"] = new JsonArray();
            Button(edge)["message"]!["payload"] = NestedPayload(16);
            workspace.Store.SaveProject(edge); passed++;
            edge = Draft(); Button(edge)["message"]!["payload"] = new JsonObject { ["items"] = new JsonArray(Enumerable.Range(0, 4094).Select(_ => (JsonNode?)null).ToArray()) };
            workspace.Store.SaveProject(edge); passed++;
            edge = Draft(); Button(edge)["message"]!["payload"] = new JsonObject { ["text"] = new string('x', 65_525) };
            workspace.Store.SaveProject(edge); passed++;
            edge = Draft(); Button(edge)["message"]!["payload"] = new JsonObject { ["text"] = string.Concat(Enumerable.Repeat("\U0001f600", 16_381)) + "x" };
            workspace.Store.SaveProject(edge); passed++;
            edge = Draft(); Button(edge)["message"]!["payload"] = new JsonObject { ["text"] = new string('x', 65_502), ["number"] = 0.000001 };
            workspace.Store.SaveProject(edge); passed++;
            edge = Draft(); Button(edge)["action"] = "navigate"; Button(edge)["targetScreenId"] = "main";
            workspace.Store.SaveProject(edge); passed++;
        }
        finally
        {
            if (Path.GetDirectoryName(Path.GetFullPath(directory)) != temporaryRoot) throw new Exception("Unsafe test cleanup path.");
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
        return passed;
    }

    private static JsonObject Handler(string id = "receive", string type = "workshop.note", string scope = "screen", string code = "app.state.set('screen', 'note', event.payload.text);") => new()
    { ["id"] = id, ["messageType"] = type, ["scope"] = scope, ["language"] = "javascript", ["code"] = code };

    private static JsonObject Project()
    {
        var project = JsonNode.Parse("""
        {"id":"message-test","name":"Message test","revision":0,"parameters":{},"screens":[{"id":"main","name":"Main","width":800,"height":600,"state":{"note":{"type":"string","value":"Waiting"}},"components":[{"id":"label","type":"label","x":20,"y":20,"width":200,"height":40,"props":{"text":"Waiting"}},{"id":"send","type":"button","x":20,"y":100,"width":200,"height":40,"props":{"text":"Send","action":"message","message":{"messageType":"workshop.note","scope":"screen","payload":{"text":"Hello"}}}}]}],"templates":[{"id":"panel","name":"Panel","width":300,"height":100,"parameters":{},"components":[{"id":"label","type":"label","x":20,"y":20,"width":200,"height":40,"props":{"text":"Template receiver"}}]}]}
        """)!.AsObject();
        project["screens"]![0]!["components"]![0]!["props"]!["messageHandlers"] = new JsonArray(Handler());
        project["templates"]![0]!["components"]![0]!["props"]!["messageHandlers"] = new JsonArray(Handler());
        return project;
    }

    private static JsonObject NestedPayload(int depth)
    {
        JsonNode node = JsonValue.Create("leaf")!;
        for (var index = 0; index < depth; index++) node = new JsonObject { ["child"] = node };
        return node.AsObject();
    }

    private static byte[] RewriteProject(byte[] archive, Action<JsonObject> mutate)
    {
        using var input = new MemoryStream(archive);
        using var zip = new ZipArchive(input, ZipArchiveMode.Read);
        using var output = new MemoryStream();
        using (var rewritten = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
            foreach (var entry in zip.Entries)
            {
                using var source = entry.Open();
                using var destination = rewritten.CreateEntry(entry.FullName).Open();
                if (entry.FullName != "project.json") { source.CopyTo(destination); continue; }
                using var reader = new StreamReader(source);
                var project = JsonNode.Parse(reader.ReadToEnd())!.AsObject(); mutate(project);
                destination.Write(Encoding.UTF8.GetBytes(project.ToJsonString()));
            }
        return output.ToArray();
    }
}
