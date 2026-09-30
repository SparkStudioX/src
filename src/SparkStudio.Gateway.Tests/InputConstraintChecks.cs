using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class InputConstraintChecks
{
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool condition, string label) { if (!condition) throw new Exception("FAILED: " + label); passed++; }
        void Reject(Action action, string label) { try { action(); } catch (ArgumentException) { passed++; return; } throw new Exception("FAILED to reject: " + label); }
        async Task RejectAsync(Func<Task> action, string label) { try { await action(); } catch (ArgumentException) { passed++; return; } throw new Exception("FAILED to reject: " + label); }
        var props = JsonNode.Parse("""{"fieldKey":"part","defaultValue":"","formatMask":"AA-####","textCase":"upper","validation":{"required":true,"minLength":7,"maxLength":7,"message":"Enter a complete part code."}}""")!.AsObject();
        var barcode = JsonNode.Parse("""{"fieldKey":"scan","defaultValue":"","scanTerminator":"enter","validation":{"required":true,"format":"digits","minLength":6,"maxLength":12}}""")!.AsObject();

        var parent = Path.GetFullPath(Path.GetTempPath());
        var directory = Path.Combine(parent, "SparkStudio.InputConstraints." + Guid.NewGuid().ToString("N"));
        try
        {
            var catalog = new ProjectCatalog(directory, new EphemeralDataProtectionProvider());
            var project = JsonNode.Parse("""
            {"id":"input-rules","name":"Input rules","revision":0,"parameters":{},"screens":[{"id":"main","name":"Main","width":600,"height":400,
              "state":{"part":{"type":"string","value":""}},"components":[
              {"id":"part","type":"formattedInput","x":0,"y":0,"width":250,"height":100,"props":{}},
              {"id":"save","type":"button","x":0,"y":150,"width":250,"height":50,"props":{"text":"Submit","action":"script","script":"result = inputs['part']"}}
            ]}],"templates":[]}
            """)!.AsObject();
            project["screens"]![0]!["components"]![0]!["props"] = props.DeepClone();
            project["screens"]![0]!["components"]![0]!["props"]!["stateBinding"] = JsonNode.Parse("""{"scope":"screen","key":"part"}""");
            var workspace = catalog.Create("Input rules", project);
            void Invalid(Action<JsonObject> change) { var draft = workspace.Store.GetProject(); change(draft["screens"]![0]!["components"]![0]!["props"]!.AsObject()); Reject(() => workspace.Store.SaveProject(draft), "invalid authored input definition"); }
            foreach (var mask in new[] { "fixed", "#\\", new string('#', 129), "#\n" }) Invalid(value => value["formatMask"] = mask);
            foreach (var rule in new[] { "{\"minLength\":3,\"maxLength\":2}", "{\"maxLength\":4097}", "{\"required\":\"yes\"}", "{\"pattern\":\".*\"}" }) Invalid(value => value["validation"] = JsonNode.Parse(rule));
            Check(workspace.Store.GetProject()["screens"]![0]!["state"]!["part"]!["value"]!.GetValue<string>() == "", "required blank state is an editable draft");
            var publication = workspace.Publication.Publish(workspace.Store, workspace.Store.GetProject()["revision"]!.GetValue<int>());
            var stamp = publication["publishedAt"]!.GetValue<string>();
            var captured = workspace.Publication.GetAction("main", "save", stamp);
            Check(captured["inputs"]![0]!["validation"]!["required"]!.GetValue<bool>() && captured["inputs"]![0]!["formatMask"]!.GetValue<string>() == "AA-####", "published actions capture input rules");
            var python = OperatingSystem.IsWindows() ? Path.GetFullPath("runtimes/python/windows-x64/python.exe") : "/usr/bin/python3";
            using var connectors = new ConnectorService(directory);
            using var tags = new TagEngine(catalog.GatewayStore, connectors, NullLogger<TagEngine>.Instance);
            var queries = new QueryExecutor(workspace.Store, connectors);
            var runner = new PythonRunner(tags, queries, workspace.Scripts, new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Python:Executable"] = python }).Build());
            var actions = new RuntimeActions(workspace.Publication, runner, queries);
            foreach (var invalid in new[] { "", "AB0012", "ab-0012", "AB-1", "AB-001Z", "AB-00123", "\ufeff" })
                await RejectAsync(() => actions.ExecuteAsync("main", "save", null, new() { ["part"] = JsonSerializer.SerializeToElement(invalid) }, stamp, CancellationToken.None), "direct gateway submission rejects invalid input");
            var result = await actions.ExecuteAsync("main", "save", null, new() { ["part"] = JsonSerializer.SerializeToElement("AB-0012") }, stamp, CancellationToken.None);
            Check(result["success"]!.GetValue<bool>() && result["result"]!.GetValue<string>() == "AB-0012", "valid formatted input reaches Python without coercion");
            var scanDraft = workspace.Store.GetProject();
            var scanComponent = scanDraft["screens"]![0]!["components"]![0]!.AsObject(); scanComponent["type"] = "barcodeInput"; scanComponent["props"] = barcode.DeepClone();
            scanDraft["screens"]![0]!["components"]![1]!["props"]!["script"] = "result = inputs['scan']";
            workspace.Store.SaveProject(scanDraft);
            stamp = workspace.Publication.Publish(workspace.Store, workspace.Store.GetProject()["revision"]!.GetValue<int>())["publishedAt"]!.GetValue<string>();
            foreach (var invalid in new object[] { 123, "ABC123", "", "00001", "1234567890123" })
                await RejectAsync(() => actions.ExecuteAsync("main", "save", null, new() { ["scan"] = JsonSerializer.SerializeToElement(invalid) }, stamp, CancellationToken.None), "invalid direct barcode submission");
            result = await actions.ExecuteAsync("main", "save", null, new() { ["scan"] = JsonSerializer.SerializeToElement("000123") }, stamp, CancellationToken.None);
            Check(result["success"]!.GetValue<bool>() && result["result"]!.GetValue<string>() == "000123", "barcode preserves leading zeroes through Python");
        }
        finally
        {
            if (Path.GetDirectoryName(directory) != Path.TrimEndingDirectorySeparator(parent)) throw new Exception("Unsafe input test cleanup.");
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
        return passed;
    }
}
