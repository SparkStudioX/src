using System.IO.Compression;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using SparkStudio.Gateway;

internal static class ModelTemplateParameterChecks
{
    public static int Run()
    {
        var checks = 0;
        void Check(bool valid, string message) { if (!valid) throw new InvalidOperationException(message); checks++; }
        var temporary = Path.GetFullPath(Path.GetTempPath());
        var directory = Path.GetFullPath(Path.Combine(temporary, "SparkStudio.ModelTemplate." + Guid.NewGuid().ToString("N")));
        if (Path.GetDirectoryName(directory) != Path.TrimEndingDirectorySeparator(temporary)) throw new InvalidOperationException("Invalid test directory.");
        try
        {
            var catalog = new ProjectCatalog(directory, new EphemeralDataProtectionProvider());
            var project = JsonNode.Parse("""
                {"id":"model-template","name":"Model template fixture","revision":0,"parameters":{},
                "screens":[{"id":"main","name":"Main","width":800,"height":600,"components":[
                  {"id":"machine","type":"template","x":0,"y":0,"width":300,"height":150,"props":{"templateId":"cnc","parameters":{"machine":"[default]Acme/CNC02"}}}]}],
                "templates":[{"id":"cnc","name":"CNC faceplate","width":300,"height":150,
                  "parameters":{"machine":"[default]Acme/CNC01"},"parameterTypes":{"machine":"model"},
                  "modelParameters":{"machine":{"definitionId":"CNC","minVersion":1,"maxVersion":2}},
                  "components":[{"id":"speed","type":"value","x":0,"y":0,"width":250,"height":120,"props":{"text":"Spindle speed","unit":"rev/min","tagPath":"{machine}/Spindle/Speed"}}]}]}
                """)!.AsObject();
            var workspace = catalog.Create("Model template fixture", project, []);
            JsonObject Template(JsonObject draft) => draft["templates"]![0]!.AsObject();
            void Reject(Action<JsonObject> change)
            {
                var draft = workspace.Store.GetProject(); change(draft);
                try { workspace.Store.SaveProject(draft); }
                catch (ArgumentException) { checks++; return; }
                throw new InvalidOperationException("Invalid Model instance parameter was accepted.");
            }
            Check(Template(workspace.Store.GetProject())["modelParameters"]!["machine"]!["definitionId"]!.GetValue<string>() == "CNC", "Requirements save even when the gateway type is not configured.");
            Reject(draft => Template(draft).Remove("modelParameters"));
            Reject(draft => Template(draft)["modelParameters"] = null);
            Reject(draft => Template(draft)["modelParameters"]!["machine"]!["definitionId"] = "bad/type");
            Reject(draft => Template(draft)["modelParameters"]!["machine"]!["maxVersion"] = 0);
            Reject(draft => Template(draft)["modelParameters"]!["machine"]!["minVersion"] = 3);
            Reject(draft => Template(draft)["modelParameters"]!["machine"]!["unknown"] = true);
            Reject(draft => Template(draft)["parameterTypes"]!["machine"] = "string");
            Reject(draft => draft["screens"]![0]!["modelParameters"] = new JsonObject());
            foreach (var path in new[] { "[default]Acme//CNC", "[default]Acme/../CNC", "[other]CNC", "[default]Acme\\CNC", "" })
                Reject(draft => Template(draft)["parameters"]!["machine"] = path);
            Reject(draft => draft["screens"]![0]!["components"]![0]!["props"]!["parameters"]!["machine"] = "not-a-model-path");
            var package = SparkProjectPackage.Export(workspace);
            using (var archive = new ZipArchive(new MemoryStream(package), ZipArchiveMode.Read))
                Check(!archive.Entries.Any(entry => entry.FullName.EndsWith("tags.json", StringComparison.Ordinal)), "A faceplate package excludes gateway models and tag data.");
            var imported = SparkProjectPackage.Import(catalog, package, "Imported model template");
            var restored = Template(imported.Store.GetProject());
            Check(restored["modelParameters"]!.ToJsonString() == Template(workspace.Store.GetProject())["modelParameters"]!.ToJsonString(), "Missing model requirements survive package import unchanged.");
            Check(restored["components"]![0]!["props"]!["tagPath"]!.GetValue<string>() == "{machine}/Spindle/Speed", "Ordinary indirect member bindings survive import.");
            Check(SparkProjectPackage.Export(imported).Length > 0, "Imported model-dependent template can be re-exported without gateway setup.");
            return checks;
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }
}
