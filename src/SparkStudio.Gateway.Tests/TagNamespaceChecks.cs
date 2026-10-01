using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class TagNamespaceChecks
{
    private const string Temperature = "[default]Line/Line2/Temperature";
    private const string Target = "[default]Setpoints/TargetSpeed";
    private static JsonObject Memory(string path, string type, JsonNode value, bool enabled = true) => new()
    {
        ["path"] = path, ["kind"] = "memory", ["dataType"] = type, ["value"] = value,
        ["enabled"] = enabled
    };
    private static JsonObject Expression(string path) => new()
    {
        ["path"] = path, ["kind"] = "expression", ["dataType"] = "Int32",
        ["expression"] = "1 + 2", ["inputs"] = new JsonObject(), ["publishingIntervalMs"] = 100
    };
    private static JsonObject Opc(string path) => new()
    {
        ["path"] = path, ["kind"] = "opcua", ["dataType"] = "Int32",
        ["connectionId"] = "disabled-fixture", ["nodeId"] = "ns=2;s=Fixture", ["enabled"] = false
    };
    private static JsonElement Scalar(object? value) => JsonSerializer.SerializeToElement(value);
    private static async Task Until(Func<bool> condition, string message)
    {
        var timer = Stopwatch.StartNew();
        while (!condition())
        {
            if (timer.Elapsed > TimeSpan.FromSeconds(5)) throw new InvalidOperationException(message);
            await Task.Delay(25);
        }
    }

    public static async Task<int> RunAsync()
    {
        var checks = 0;
        void Check(bool condition, string description)
        {
            if (!condition) throw new InvalidOperationException(description);
            checks++;
        }
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.TagNamespace." + Guid.NewGuid().ToString("N"));
        var protection = new EphemeralDataProtectionProvider();
        Directory.CreateDirectory(directory);
        try
        {
            var productionDirectory = Path.Combine(directory, "production");
            var productionStore = new ProjectStore(productionDirectory, protection);
            using var productionConnectors = new ConnectorService(productionDirectory);
            using var production = new TagEngine(productionStore, productionConnectors, NullLogger<TagEngine>.Instance);
            var saved = production.SaveDefinition(Memory(Temperature, "Double", JsonValue.Create(666)!));
            Check(saved["value"]!.GetValue<double>() == 666 && Scalar(production.Read([Temperature], null)[0].Value).GetDouble() == 666,
                "the exact reported Line/Line2/Temperature memory tag saves and is immediately readable as 666");
            Check(!production.DemoMode && production.Snapshot().Length == 1 && production.Snapshot().All(tag => tag.Source != "simulated"),
                "a default production engine has only the authored tag and no generated demo values");
            var reloaded = new ProjectStore(productionDirectory, protection);
            Check(reloaded.GetTagDefinitions().OfType<JsonObject>().Single(tag => ProjectStore.Required(tag, "path") == Temperature)["value"]!.GetValue<double>() == 666,
                "the authored sample-path memory definition survives store reload");
            foreach (var path in new[] { "[default]Line", "[default]Setpoints", "[default]Line/Custom", "[default]Setpoints/Custom" })
                Check(TagDefinitionValidator.Path(path) == path, "ordinary authored tag paths are allowed: " + path);
            foreach (var path in new[] { "[other]Line/Tag", "[default]", "[default]/Tag", "[default]Line//Tag", "[default]Line/../Tag", "[default]Line/{parameter}", "[default]Line/Tag\n" })
            {
                try { TagDefinitionValidator.Path(path); }
                catch (ArgumentException) { checks++; continue; }
                throw new InvalidOperationException("Removing demo reservations weakened concrete path validation: " + path);
            }
            Check(production.WriteMemory([Target], [Scalar(88)])[0] == "Bad_NotFound",
                "production mode does not create an unconfigured demo setpoint during a write");

            var demoDirectory = Path.Combine(directory, "demo");
            var store = new ProjectStore(demoDirectory, protection);
            store.SaveConnection(new JsonObject { ["id"] = "disabled-fixture", ["name"] = "Disabled fixture", ["type"] = "opcua", ["endpoint"] = "opc.tcp://127.0.0.1:1", ["enabled"] = false });
            using var connectors = new ConnectorService(demoDirectory);
            using var tags = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance, enableDemoTags: true);
            var sampleMethod = typeof(TagEngine).GetMethod("UpdateSamples", BindingFlags.NonPublic | BindingFlags.Instance)!;
            void Tick() => sampleMethod.Invoke(tags, null);
            TagValue Read(string path) => tags.Read([path], null)[0];
            string Write(string path, object value) => tags.WriteMemory([path], [Scalar(value)])[0];
            Tick();
            Check(tags.Snapshot().Length == 9 && Read(Temperature).Source == "simulated", "explicit demo mode still generates the nine unconfigured example values");
            tags.SaveDefinition(Memory(Temperature, "Double", JsonValue.Create(666)!));
            var disabledSpeed = "[default]Line/Line1/Speed";
            tags.SaveDefinition(Memory(disabledSpeed, "Double", JsonValue.Create(33)!, enabled: false));
            var expressionStatus = "[default]Line/Line2/Status";
            tags.SaveDefinition(Expression(expressionStatus));
            var opcCount = "[default]Line/Line2/ProductionCount";
            tags.SaveDefinition(Opc(opcCount));
            Tick(); Tick();
            Check(Read(Temperature).Source == "memory" && Scalar(Read(Temperature).Value).GetDouble() == 666,
                "demo ticks cannot overwrite a same-path authored memory tag");
            Check(Read(disabledSpeed).Quality == "Bad_Disabled" && Scalar(Read(disabledSpeed).Value).GetDouble() == 33,
                "a disabled authored memory tag does not fall back to good simulated data");
            Check(Read(expressionStatus).Source == "expression" && Read(expressionStatus).Quality != "Good",
                "a pending authored expression is not replaced by a demo value");
            Check(Read(opcCount).Quality == "Bad_Disabled" && Read(opcCount).Value is null,
                "a disabled authored OPC tag is not replaced by a demo value");

            tags.SaveDefinition(Memory(Target, "String", JsonValue.Create("manual")!));
            Check(Write(Target, "updated") == "Good" && Scalar(Read(Target).Value).GetString() == "updated",
                "authored TargetSpeed uses its String datatype instead of demo numeric validation");
            store.DeleteTag(Target); Tick();
            Check(Read(Target).DataType == "Double" && Read(Target).Quality == "Good" && Scalar(Read(Target).Value).GetDouble() == 85,
                "direct configuration deletion of a String override restores the independent numeric demo setpoint");
            tags.SaveDefinition(Memory(Target, "Int32", JsonValue.Create(900)!));
            Check(Write(Target, 901) == "Good" && Write(Target, 1.5) == "Bad_NotWritable",
                "authored TargetSpeed uses Int32 validation without the unrelated demo 0–500 range");
            Tick(); store.FlushMemoryValues();
            var restarted = new ProjectStore(demoDirectory, protection);
            Check(restarted.GetTagDefinitions().OfType<JsonObject>().Single(tag => ProjectStore.Required(tag, "path") == Target)["value"]!.GetValue<int>() == 901,
                "same-path authored setpoint writes persist across reload");
            tags.SaveDefinition(Memory(Target, "Int32", JsonValue.Create(17)!, enabled: false));
            Check(Write(Target, 18) == "Bad_NotWritable", "disabled authored setpoint writes cannot fall back to the demo writer");
            Tick();
            Check(Read(Target).Quality == "Bad_Disabled" && Scalar(Read(Target).Value).GetInt32() == 17,
                "demo ticks leave an authored disabled setpoint disabled");
            tags.SaveDefinition(Expression(Target));
            Check(Write(Target, 18) == "Bad_NotWritable", "authored expression setpoints cannot fall back to the demo writer");
            tags.SaveDefinition(Opc(Target));
            Check(Write(Target, 18) == "Bad_NotWritable", "authored OPC setpoints cannot fall back to the demo writer");
            Tick();
            Check(Read(Target).Quality == "Bad_Disabled" && Read(Target).Value is null, "demo ticks cannot restore a disabled OPC setpoint to good");
            store.DeleteTag(Target); Tick();
            Check(Read(Target).DataType == "Double" && Read(Target).Quality == "Good" && Scalar(Read(Target).Value).GetDouble() == 85,
                "direct configuration deletion of a disabled OPC override cannot leak its stale type, null value or bad quality into the demo");

            var customPaths = new[] { "[default]Line/Custom", "[default]Setpoints/Custom" };
            foreach (var path in customPaths) tags.SaveDefinition(Memory(path, "Int32", JsonValue.Create(7)!));
            await tags.StartAsync(CancellationToken.None);
            try
            {
                await Until(() => Read(expressionStatus).Quality == "Good", "Authored expression did not evaluate.");
                Tick();
                Check(Read(expressionStatus).Source == "expression" && Scalar(Read(expressionStatus).Value).GetInt32() == 3,
                    "an evaluated authored expression keeps its result through demo ticks");
                foreach (var path in customPaths) store.DeleteTag(path);
                await Until(() => customPaths.All(path => Read(path).Quality == "Bad_NotFound"), "Deleted Line/Setpoints runtime values were retained as fake demo tags.");
                Check(customPaths.All(path => Read(path).Quality == "Bad_NotFound"), "runtime cleanup exempts exact demo paths, not entire Line or Setpoints namespaces");
                tags.DeleteDefinition(Temperature); Tick();
                Check(Read(Temperature).Source == "simulated", "deleting an authored override exposes the original sample only in explicit demo mode");
                tags.DeleteDefinition(Target); Tick();
                Check(Write(Target, 501) == "Bad_OutOfRange" && Write(Target, 88) == "Good", "unconfigured demo setpoints keep their original bounded write behavior");
                Tick();
                Check(Scalar(Read(Target).Value).GetDouble() == 88, "demo ticks retain the writable sample setpoint");
            }
            finally { await tags.StopAsync(CancellationToken.None); }
        }
        finally
        {
            var full = Path.GetFullPath(directory);
            var prefix = Path.Combine(Path.GetFullPath(Path.GetTempPath()), "SparkStudio.TagNamespace.");
            if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Unexpected test directory.");
            Directory.Delete(full, recursive: true);
        }
        return checks;
    }
}
