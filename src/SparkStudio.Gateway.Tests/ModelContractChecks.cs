using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class ModelContractChecks
{
    private static int checks;
    private const string Source = "[default]Sources/Press/Load";
    private const string Field = "[default]Factory/Press01/Load";
    public static async Task<int> RunAsync()
    {
        checks = 0;
        Validation(); Evaluation(); ExactEnumWire(); IssuePermissions();
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.ModelContracts." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try { await Runtime(directory); }
        finally { Directory.Delete(directory, true); }
        return checks;
    }

    private static JsonObject Member() => new() { ["path"] = "Load", ["kind"] = "reference", ["dataType"] = "Int32", ["target"] = Source,
        ["range"] = new JsonObject { ["low"] = 0, ["high"] = 100 }, ["freshnessMs"] = 600, ["unit"] = "%", ["unitSystem"] = "ucum",
        ["semanticId"] = "urn:sparkstudio:examples:load", ["alarms"] = new JsonArray(new JsonObject {
            ["id"] = "high", ["name"] = "Motor load high", ["mode"] = "high", ["setpoint"] = 90, ["deadband"] = 5, ["priority"] = 3, ["message"] = "Inspect motor load." }) };

    private static JsonObject Model()
    {
        var model = TagModel.Empty();
        model["tags"]!.AsArray().Add(new JsonObject { ["path"] = Source, ["kind"] = "memory", ["dataType"] = "Int32", ["value"] = 91 });
        model["udtDefinitions"]!.AsArray().Add(new JsonObject { ["id"] = "Press", ["version"] = 1, ["members"] = new JsonArray(Member()) });
        model["instances"]!.AsArray().Add(new JsonObject { ["path"] = "[default]Factory/Press01", ["definitionId"] = "Press", ["version"] = 1, ["overrides"] = new JsonObject() });
        return model;
    }

    private static void Validation()
    {
        TagModelMetadata.Validate(Member()); Check(true, "valid numeric contract and alarm template");
        foreach (var (field, value) in new (string, JsonNode?)[] { ("freshnessMs", JsonValue.Create(-1)), ("freshnessMs", JsonValue.Create(1.5)),
            ("unit", JsonValue.Create("made-up")), ("semanticId", JsonValue.Create("relative/name")), ("semanticId", JsonValue.Create("urn:space invalid")),
            ("enumValues", new JsonArray(1, 1)), ("enumValues", new JsonArray(1.2)) })
        {
            var member = Member(); member[field] = value;
            Reject(() => TagModelMetadata.Validate(member), "reject invalid " + field);
        }
        var custom = Member(); custom["unitSystem"] = "custom"; custom["unit"] = "widgets/batch";
        TagModelMetadata.Validate(custom); Check(true, "custom display units remain explicit and supported");
        var unrestricted = Member(); unrestricted["enumValues"] = new JsonArray();
        TagModelMetadata.Validate(unrestricted); Check(true, "empty enum list explicitly disables inherited enum rules");
        var wide = new JsonObject { ["dataType"] = "Int64", ["enumValues"] = new JsonArray("9223372036854775807", "-9223372036854775808") };
        ModelFieldContract.Validate(wide, true); Check(true, "Int64 enum values validate exactly beyond browser precision");
        wide["range"] = new JsonObject { ["low"] = long.MaxValue, ["high"] = long.MaxValue - 1 };
        Reject(() => TagModelMetadata.Validate(wide), "adjacent reversed Int64 range bounds beyond double precision");
        var invalidAlarm = Member(); invalidAlarm["alarms"]![0]!["deadband"] = -1;
        Reject(() => TagModelMetadata.Validate(invalidAlarm), "negative model alarm deadband");
        invalidAlarm = Member(); invalidAlarm["alarms"]!.AsArray().Add(invalidAlarm["alarms"]![0]!.DeepClone());
        Reject(() => TagModelMetadata.Validate(invalidAlarm), "duplicate template identifiers");
    }

    private static void Evaluation()
    {
        var now = DateTimeOffset.UtcNow; var definition = Member();
        var source = new TagValue(Source, 120, "Int32", "Good", now, "memory", ReceiptTimestamp: now);
        var modeled = ModelFieldContract.Evaluate(definition, source with { Path = Field, Source = "reference" }, now);
        Check(modeled.Quality == "Uncertain_ModelValidation" && modeled.SourceQuality == "Good" && Equals(modeled.Value, 120), "invalid value remains visible with model quality and original source quality");
        Check(source.Quality == "Good" && source.ModelIssues is null, "contract leaves shared source untouched");
        Check(modeled.ModelIssues!.Single().Code == "outOfRange", "range reason provided");
        var stale = ModelFieldContract.Evaluate(definition, source with { Value = 50 }, now.AddSeconds(2));
        Check(stale.Quality == "Uncertain_ModelStale" && stale.ModelIssues!.Single().Code == "stale", "stale samples have separate cause");
        var fresh = ModelFieldContract.Evaluate(definition, stale with { ReceiptTimestamp = now.AddSeconds(2) }, now.AddSeconds(2));
        Check(fresh.Quality == "Good" && fresh.ModelIssues!.Length == 0 && fresh.Timestamp == stale.Timestamp, "same-valued sample refreshes using receipt time rather than value timestamp");
        foreach (var quality in new[] { "Bad_CommunicationError", "Uncertain_Retained" })
        {
            var result = ModelFieldContract.Evaluate(definition, source with { Quality = quality }, now.AddSeconds(2));
            Check(result.Quality == quality && result.SourceQuality == quality && result.ModelIssues!.Length == 2, "source quality is never upgraded: " + quality);
        }
        var disconnected = ModelFieldContract.Evaluate(definition, modeled with { Quality = "Bad_CommunicationError" }, now);
        Check(disconnected.Quality == "Bad_CommunicationError" && disconnected.SourceQuality == "Bad_CommunicationError", "source failure overrides earlier good source provenance");
        var unknown = ModelFieldContract.Evaluate(definition, source with { ReceiptTimestamp = null, Value = null, Quality = "Bad_WaitingForInitialData" }, now.AddDays(1));
        Check(unknown.ModelIssues!.Length == 0, "unknown receipt is not invented and missing values are not out-of-range");
        foreach (var invalid in new object[] { "NaN", "Infinity", "120", true })
        {
            var result = ModelFieldContract.Evaluate(definition, source with { Value = invalid }, now);
            Check(result.Quality == "Uncertain_ModelValidation" && result.SourceQuality == "Good" && Equals(result.Value, invalid) && result.ModelIssues!.Single().Code == "invalidType", "wrong-typed/nonfinite source value remains visible with declared-type issue: " + invalid);
        }
        definition["enumValues"] = new JsonArray(10, 20);
        var enumResult = ModelFieldContract.Evaluate(definition, source with { Value = 30 }, now);
        Check(enumResult.ModelIssues!.Single().Code == "invalidEnum", "integer enum membership enforced");
        var text = new JsonObject { ["dataType"] = "String", ["enumValues"] = new JsonArray("Running", "Stopped") };
        Check(ModelFieldContract.Evaluate(text, source with { Value = "running", DataType = "String" }, now).ModelIssues!.Single().Code == "invalidEnum", "string enums use exact case-sensitive values");
        text["enumValues"] = new JsonArray();
        Check(ModelFieldContract.Evaluate(text, source with { Value = "anything", DataType = "String" }, now).ModelIssues!.Length == 0, "empty enum override accepts any correctly typed value");
        var wide = new JsonObject { ["dataType"] = "Int64", ["range"] = new JsonObject { ["low"] = 0, ["high"] = long.MaxValue - 1 } };
        Check(ModelFieldContract.Evaluate(wide, source with { Value = long.MaxValue, DataType = "Int64" }, now).ModelIssues!.Single().Code == "outOfRange", "Int64 range enforcement preserves adjacent integer distinctions beyond double precision");
        var tiny = new JsonObject { ["dataType"] = "Double", ["range"] = new JsonObject { ["low"] = -1, ["high"] = 0 } };
        Check(ModelFieldContract.Evaluate(tiny, source with { Value = 1e-30, DataType = "Double" }, now).ModelIssues!.Single().Code == "outOfRange", "tiny floating values are not rounded into a zero bound by decimal comparison");
    }

    private static void ExactEnumWire()
    {
        var model = Model(); var member = model["udtDefinitions"]![0]!["members"]![0]!.AsObject();
        member["dataType"] = "Int64"; member["enumValues"] = new JsonArray(long.MaxValue, long.MinValue);
        var wire = TagModelWire.Package(model);
        Check(wire["udtDefinitions"]![0]!["members"]![0]!["enumValues"]![0]!.GetValue<string>() == "9223372036854775807", "enum export preserves exact Int64 decimal strings");
        var normalized = TagModelWire.NormalizePackage(wire, TagModel.Empty());
        Check(normalized["udtDefinitions"]![0]!["members"]![0]!["enumValues"]![1]!.GetValue<long>() == long.MinValue, "enum import recovers exact signed Int64 minimum");
        var patch = new JsonObject { ["enumValues"] = new JsonArray(long.MaxValue) };
        model["instances"]![0]!["overrides"]!["Load"] = patch;
        Check(TagModelWire.Package(model)["instances"]![0]!["overrides"]!["Load"]!["enumValues"]![0]!.GetValue<string>() == "9223372036854775807", "equipment enum overrides use same exact Int64 wire contract");
    }

    private static void IssuePermissions()
    {
        var model = Model(); var field = Member(); field["path"] = Field; field["udtInstance"] = "[default]Factory/Press01";
        field["modelPath"] = "Load"; field["udtDefinition"] = "Press"; field["udtVersion"] = 1;
        var index = new ModelReadIndex(7, model, new JsonArray(field));
        var now = DateTimeOffset.UtcNow;
        var value = ModelFieldContract.Evaluate(field, new(Field, 120, "Int32", "Good", now, "reference", ReceiptTimestamp: now), now);
        var values = new Dictionary<string, TagValue> { [Field] = value };
        Check(index.PrepareIssues(_ => false, null, 0, 100, true).Render(values)["total"]!.GetValue<int>() == 0, "denied model issues are omitted before paging");
        var limited = index.PrepareIssues(_ => true, null, 0, 1).Render(values);
        Check(limited["total"]!.GetValue<int>() == 1 && !limited.ToJsonString().Contains(Source, StringComparison.Ordinal), "read-only issue projection does not expose hidden reference target");
        Check(index.PrepareIssues(_ => true, null, 0, 1, true).Render(values)["items"]![0]!["target"]!.GetValue<string>() == Source, "configuration users can inspect reference target");
        var objectValue = index.ReadObject("[default]Factory/Press01", _ => true, values)["members"]!["Load"]!;
        Check(objectValue["sourceQuality"]!.GetValue<string>() == "Good" && objectValue["modelIssues"]!.AsArray().Count == 1, "model object contains quality provenance and issues");
        Reject(() => index.PrepareIssues(_ => true, null, -1, 100), "negative issue offset");
    }

    private static async Task Runtime(string directory)
    {
        var store = new ProjectStore(directory, new EphemeralDataProtectionProvider(), gatewayOnly: true);
        using var connectors = new ConnectorService(directory);
        using var tags = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance);
        var model = Model(); var preview = store.PreviewTagImport(model);
        Check(preview.CanApply, "contract import preview is valid"); tags.ApplyImport(new(model, preview.Revision, preview.PreviewToken));
        await tags.StartAsync(CancellationToken.None);
        try
        {
            await Until(() => tags.Read([Field], null)[0].Quality == "Good");
            using var service = new ProcessDataService(directory, tags, new RecoveryQuarantine(directory), NullLogger<ProcessDataService>.Instance);
            service.Sample(); var alarm = service.Alarms(_ => true).Single();
            Check(alarm.Active && alarm.Message == "Inspect motor load.", "expanded template activates existing process alarm engine with message");
            Check(service.Configuration().Alarms.Length == 0 && service.ModelAlarms().Length == 1, "generated alarms do not duplicate persisted manual alarm configuration");
            service.Acknowledge(alarm.Id, alarm.EventId, "model-test", _ => true);
            Check(service.Journal(_ => true, 100).Any(item => item.Kind == "acknowledged" && item.Message == alarm.Message), "model alarms use existing acknowledgement and durable journal");
            await Until(() => tags.Read([Field], null)[0].Quality == "Uncertain_ModelStale");
            var original = tags.Read([Source], null)[0];
            Check(original.Quality == "Good", "model freshness does not change source tag quality");
            tags.WriteMemory([Source], [JsonSerializer.SerializeToElement(91)]);
            await Until(() => tags.Read([Field], null)[0].Quality == "Good");
            Check(tags.Read([Field], null)[0].ReceiptTimestamp > original.ReceiptTimestamp, "unchanged source value resets model freshness at runtime");
            tags.WriteMemory([Source], [JsonSerializer.SerializeToElement(120)]);
            await Until(() => tags.Read([Field], null)[0].Quality == "Uncertain_ModelValidation");
            service.Sample();
            Check(service.Alarms(_ => true).Single().Active, "bad model data does not spuriously clear an active process alarm");
            await OverrideAlarm(store, tags, service);
        }
        finally { await tags.StopAsync(CancellationToken.None); }
    }

    private static async Task OverrideAlarm(ProjectStore store, TagEngine tags, ProcessDataService service)
    {
        var model = store.ExportTags();
        var instance = model["instances"]![0]!.AsObject();
        var alarm = Member()["alarms"]![0]!.DeepClone(); alarm["setpoint"] = 150; alarm["deadband"] = 10;
        instance["overrides"] = new JsonObject { ["Load"] = new JsonObject { ["alarms"] = new JsonArray(alarm), ["range"] = new JsonObject { ["low"] = 0, ["high"] = 200 }, ["freshnessMs"] = 0 } };
        var preview = store.PreviewTagImport(model); Check(preview.CanApply, "equipment alarm override preview valid");
        tags.ApplyImport(new(model, preview.Revision, preview.PreviewToken));
        await Until(() => tags.Read([Field], null)[0].Quality == "Good");
        service.Sample();
        Check(service.Alarms(_ => true).Length == 1 && !service.Alarms(_ => true).Single().Active, "equipment override replaces alarm template without duplicate alarm");
        Check(service.ModelAlarms().Single().Setpoint == 150 && service.ModelAlarms().Single().Deadband == 10, "effective threshold and deadband follow override");
        Check(service.Journal(_ => true, 100).Any(item => item.Kind == "reconfigured"), "threshold changes reconcile previous occurrence in durable journal");
    }

    private static async Task Until(Func<bool> condition)
    {
        for (var attempt = 0; attempt < 100; attempt++) { if (condition()) return; await Task.Delay(25); }
        throw new InvalidOperationException("Timed out waiting for model contract runtime.");
    }
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("Model contract: " + message); checks++; }
    private static void Reject(Action action, string message)
    {
        try { action(); } catch (ArgumentException) { checks++; return; }
        throw new InvalidOperationException("Model contract accepted " + message);
    }
}
