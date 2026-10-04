using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class UnsModelChecks
{
    private static int checks;
    public static async Task<int> RunAsync()
    {
        checks = 0;
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.Uns." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            ParametersAndComposition(directory);
            SharedParameterGrammar();
            ExactIntegerWire(directory);
            Validation(directory);
            ValidationDiagnostics(directory);
            HierarchyOrdering();
            CurrentFormat(directory);
            await SourceReferences(directory);
            ReferenceValues();
            await Runtime(directory);
            await RuntimeSnapshots(directory);
            Scale(directory);
            return checks;
        }
        finally { Directory.Delete(directory, true); }
    }
    private static ProjectStore Store(string directory, string name) => new(Path.Combine(directory, name), new EphemeralDataProtectionProvider(), gatewayOnly: true);
    private static void SharedParameterGrammar()
    {
        using var stream = typeof(TagModel).Assembly.GetManifestResourceStream("SparkStudio.ModelParameterContract.json");
        Check(stream is not null, "gateway embeds the browser model parameter contract");
        using var contract = JsonDocument.Parse(stream!);
        Check(contract.RootElement.GetProperty("version").GetInt32() == 1, "shared model parameter contract version");
        string[] valid = ["A", "Device-ID_2", "A" + new string('z', 63)];
        foreach (var name in valid)
        {
            Check(TagModel.Name(new JsonObject { ["name"] = name }, "name") == name, "shared grammar accepts " + name);
            Check(TagModelParameters.Placeholders("[default]Raw/{" + name + "}/Speed", valid).SequenceEqual([name]), "shared placeholder grammar accepts " + name);
        }
        foreach (var name in new[] { "_Device", "9Device", "Device.name", "Device name", "A" + new string('z', 64) })
        {
            Reject(() => TagModel.Name(new JsonObject { ["name"] = name }, "name"), "invalid shared name " + name);
            Reject(() => TagModelParameters.Placeholders("{" + name + "}", [name]), "invalid shared placeholder " + name);
        }
        var maximum = contract.RootElement.GetProperty("maximumPlaceholders").GetInt32();
        Check(TagModelParameters.Placeholders(string.Concat(Enumerable.Repeat("{A}", maximum)), ["A"]).Length == maximum, "shared placeholder maximum is accepted");
        Reject(() => TagModelParameters.Placeholders(string.Concat(Enumerable.Repeat("{A}", maximum + 1)), ["A"]), "shared placeholder maximum is enforced");
    }
    private static JsonObject Read(string json) => JsonNode.Parse(json)!.AsObject();
    private static JsonObject Package() => TagModel.Empty();
    private static JsonObject Memory(string path, long value = 1) => new() { ["path"] = path, ["kind"] = "memory", ["dataType"] = "Int64", ["value"] = value };
    private static JsonObject Reference(string path, string target) => new() { ["path"] = path, ["kind"] = "reference", ["dataType"] = "Int64", ["target"] = target };
    private static JsonObject Definition(string id, params JsonObject[] members) => new() { ["id"] = id, ["version"] = 1, ["members"] = new JsonArray(members.Cast<JsonNode?>().ToArray()) };
    private static JsonObject Instance(string path, string id) => new() { ["path"] = path, ["definitionId"] = id, ["version"] = 1, ["overrides"] = new JsonObject() };
    private static JsonObject Nested(string path, string id) => new() { ["path"] = path, ["kind"] = "type", ["definitionId"] = id, ["version"] = 1 };
    private static void Check(bool condition, string message)
    { if (!condition) throw new InvalidOperationException("UNS: " + message); checks++; }
    private static void Reject(Action action, string message)
    { try { action(); } catch (Exception error) when (error is ArgumentException or InvalidOperationException) { checks++; return; } throw new InvalidOperationException("UNS accepted " + message); }
    private static TagImportPreview Apply(ProjectStore store, JsonObject package)
    {
        var preview = store.PreviewTagImport(package);
        Check(preview.CanApply, "valid model preview: " + string.Join("; ", preview.Conflicts ?? []));
        return store.ApplyTagImport(new(package, preview.Revision, preview.PreviewToken));
    }
    private static void Conflict(ProjectStore store, JsonObject package, string message)
    {
        var before = store.ExportTags().ToJsonString();
        try
        {
            var preview = store.PreviewTagImport(package);
            Check(!preview.CanApply, message);
            Reject(() => store.ApplyTagImport(new(package, preview.Revision, preview.PreviewToken)), message + " apply");
        }
        catch (ArgumentException) { checks++; }
        Check(store.ExportTags().ToJsonString() == before, message + " leaves saved model unchanged");
    }
    private static Dictionary<string, JsonObject> Tags(ProjectStore store) => store.GetTagDefinitions().OfType<JsonObject>().ToDictionary(tag => tag["path"]!.GetValue<string>(), StringComparer.Ordinal);
    private static void ParametersAndComposition(string directory)
    {
        var store = Store(directory, "parameters"); var package = Package();
        var motor = Definition("Motor", Read("""{"path":"Speed","kind":"memory","dataType":"Int64","value":"{Initial}","unit":"rpm","description":"Spindle speed","range":{"low":0,"high":12000},"semanticType":"RotationalSpeed","attributes":{"critical":true,"rank":1}}"""), Reference("Observed", "./Speed"));
        motor["parameters"] = Read("""{"items":[{"name":"Initial","type":"Int64","default":5,"required":true}]}""")["items"]!.DeepClone();
        var nested = Nested("Spindle", "Motor"); nested["parameters"] = new JsonObject { ["Initial"] = "{Start}" };
        var machine = Definition("Machine", nested); machine["parameters"] = Read("""{"items":[{"name":"Start","type":"Int64","default":7}]}""")["items"]!.DeepClone();
        package["udtDefinitions"]!.AsArray().Add(motor); package["udtDefinitions"]!.AsArray().Add(machine);
        package["instances"]!.AsArray().Add(Instance("[default]Plant/A", "Machine"));
        var b = Instance("[default]Plant/B", "Machine"); b["parameters"] = new JsonObject { ["Start"] = 9L };
        b["overrides"]!["Spindle/Speed"] = new JsonObject { ["value"] = 11L, ["unit"] = "r/min" }; package["instances"]!.AsArray().Add(b);
        package["hierarchy"]!.AsArray().Add(new JsonObject { ["path"] = "[default]Plant", ["level"] = "Site", ["attributes"] = new JsonObject { ["timezone"] = "UTC" } });
        package["provider"]!["requireDeclaredHierarchy"] = true;
        var preview = store.PreviewTagImport(package);
        Check(preview.CanApply && preview.ExpandedTags?.Count == 4 && store.GetTagDefinitions().Count == 0, "preview exposes resolved leaves without writes");
        Apply(store, package); var tags = Tags(store); var aSpeed = tags["[default]Plant/A/Spindle/Speed"];
        Check(aSpeed["value"]!.ToJsonString() == "7" && tags["[default]Plant/B/Spindle/Speed"]["value"]!.ToJsonString() == "11", "nested defaults and explicit overrides have correct precedence");
        Check(aSpeed["fieldProvenance"]!["value"]!.GetValue<string>() == "parameter-default" && tags["[default]Plant/B/Spindle/Speed"]["fieldProvenance"]!["value"]!.GetValue<string>() == "override", "nested parameter provenance preserves default versus override");
        Check(aSpeed["modelPath"]!.GetValue<string>() == "Spindle/Speed" && aSpeed["udtInstance"]!.GetValue<string>() == "[default]Plant/A", "expanded leaves carry complete model path and root instance");
        Check(tags["[default]Plant/A/Spindle/Observed"]["target"]!.GetValue<string>() == "[default]Plant/A/Spindle/Speed", "nested relative target resolves within its own type instance");
        Check(aSpeed["unit"]!.GetValue<string>() == "rpm" && aSpeed["attributes"]!["critical"]!.GetValue<bool>(), "metadata survives normalization");
        Check(store.ExportTags()["version"]!.GetValue<int>() == TagModel.FormatVersion, "export uses the current tag format");
        var changed = Package(); var revision = (JsonObject)motor.DeepClone(); revision["version"] = 2; revision["parameters"]![0]!["default"] = 50L; changed["udtDefinitions"]!.AsArray().Add(revision); Apply(store, changed);
        Check(store.ExportTags()["provider"]!["requireDeclaredHierarchy"]!.GetValue<bool>(), "enabled-only provider updates retain hierarchy governance");
        var outside = Package(); outside["instances"]!.AsArray().Add(Instance("[default]Outside", "Motor")); Conflict(store, outside, "omitted governance cannot bypass hierarchy policy");
        Check(Tags(store)["[default]Plant/A/Spindle/Speed"]["value"]!.ToJsonString() == "7", "new type revision does not alter pinned nested type");
        var stale = store.PreviewTagImport(Package()); var edit = Package(); edit["tags"]!.AsArray().Add(Memory("[default]Unrelated")); Apply(store, edit);
        Reject(() => store.ApplyTagImport(new(Package(), stale.Revision, stale.PreviewToken)), "stale model snapshot");
        var immutable = Package(); revision["members"]![0]!["unit"] = "changed"; immutable["udtDefinitions"]!.AsArray().Add(revision.DeepClone());
        Conflict(store, immutable, "type revisions remain immutable");
        var binding = new Dictionary<string, JsonElement> { ["machine"] = JsonSerializer.SerializeToElement("[default]Plant/A") };
        Check(TagEngine.Resolve("{machine}/Spindle/Speed", binding) == "[default]Plant/A/Spindle/Speed", "runtime template binding accepts a concrete model root");
        Reject(() => TagEngine.Resolve("[default]Elsewhere/{machine}", binding), "provider injection into interior binding segment");
    }
    private static void ExactIntegerWire(string directory)
    {
        var store = Store(directory, "integers"); var package = Package();
        var child = Definition("ExactChild", Read("""{"path":"Value","kind":"memory","dataType":"Int64","value":"{Count}"}"""));
        child["parameters"] = new JsonArray(new JsonObject { ["name"] = "Count", ["type"] = "Int64", ["default"] = "9223372036854775807" });
        var nested = Nested("Child", "ExactChild"); nested["parameters"] = new JsonObject { ["Count"] = "9007199254740993" };
        package["udtDefinitions"]!.AsArray().Add(child); package["udtDefinitions"]!.AsArray().Add(Definition("ExactRoot", nested));
        package["instances"]!.AsArray().Add(Instance("[default]Default", "ExactChild"));
        var minimum = Instance("[default]Minimum", "ExactChild"); minimum["parameters"] = new JsonObject { ["Count"] = "-9223372036854775808" }; package["instances"]!.AsArray().Add(minimum);
        var overridden = Instance("[default]Nested", "ExactRoot"); overridden["overrides"]!["Child/Value"] = new JsonObject { ["value"] = "9223372036854775806" }; package["instances"]!.AsArray().Add(overridden);
        package["tags"]!.AsArray().Add(Memory("[default]Direct", long.MaxValue));
        var preview = Apply(store, package);
        Check(Tags(store)["[default]Default/Value"]["value"]!.GetValue<long>() == long.MaxValue && Tags(store)["[default]Minimum/Value"]["value"]!.GetValue<long>() == long.MinValue, "Int64 defaults and supplied parameters preserve both 64-bit limits");
        Check(Tags(store)["[default]Nested/Child/Value"]["value"]!.GetValue<long>() == long.MaxValue - 1, "nested Int64 override remains exact");
        var exported = store.ExportTags();
        Check(exported["udtDefinitions"]![0]!["parameters"]![0]!["default"]!.GetValue<string>() == "9223372036854775807", "Int64 definition default exports as exact decimal string");
        Check(exported["udtDefinitions"]![1]!["members"]![0]!["parameters"]!["Count"]!.GetValue<string>() == "9007199254740993", "nested Int64 constant exports as exact decimal string");
        Check(exported["instances"]![1]!["parameters"]!["Count"]!.GetValue<string>() == "-9223372036854775808" && exported["instances"]![2]!["overrides"]!["Child/Value"]!["value"]!.GetValue<string>() == "9223372036854775806", "instance values and nested overrides export exact Int64 strings");
        var wire = JsonSerializer.SerializeToNode(preview, ProjectStore.Json)!;
        Check(wire["expandedTags"]!.AsArray().OfType<JsonObject>().Single(tag => tag["path"]!.GetValue<string>() == "[default]Direct")["value"]!.GetValue<string>() == "9223372036854775807", "expanded preview avoids JsonNode converter bypass");
        Apply(store, exported);
        Check(Tags(store)["[default]Minimum/Value"]["value"]!.GetValue<long>() == long.MinValue, "export/import roundtrip retains immutable pins and exact values");
        foreach (var invalid in new[] { "4", "+9223372036854775807", "09223372036854775807", "9223372036854775808", "-9223372036854775809", "9007199254740993.0" })
            Reject(() => TagDefinitionValidator.MemoryValue("Int64", JsonValue.Create(invalid)), "invalid Int64 wire string " + invalid);
        var definition = exported["udtDefinitions"]![0]!.AsObject(); var values = TagModelParameters.Bind(definition, new JsonObject()).Values;
        Check(TagModelWire.Parameters(definition, values)["Count"]!.GetValue<string>() == "9223372036854775807", "resolved model-object parameters retain exact Int64 wire shape");
    }
    private static void Validation(string directory)
    {
        var store = Store(directory, "validation");
        void InvalidDefinition(JsonObject definition, string description)
        { var package = Package(); package["udtDefinitions"]!.AsArray().Add(definition); Conflict(store, package, description); }
        var parameterized = Definition("InvalidMetadata", Memory("Value")); parameterized["parameters"] = new JsonArray(new JsonObject { ["name"] = "Unused", ["type"] = "String" });
        parameterized["members"]![0]!["range"] = new JsonObject { ["low"] = 9, ["high"] = 2 }; InvalidDefinition(parameterized, "unused parameterized type still validates metadata");
        InvalidDefinition(Definition("Prefix", Memory("A"), Memory("A/B")), "leaf prefix collision");
        InvalidDefinition(Definition("Missing", Reference("Read", "./Absent")), "missing relative reference in unused type");
        InvalidDefinition(Definition("Cycle", Reference("A", "./B"), Reference("B", "./A")), "reference cycle in unused type");
        var mismatch = Definition("Mismatch", Memory("A"), Reference("B", "./A")); mismatch["members"]![1]!["dataType"] = "Double"; InvalidDefinition(mismatch, "reference exact type in unused type");
        InvalidDefinition(Definition("Self", Nested("Child", "Self")), "composition cycle");
        var deep = Package();
        for (var i = 0; i < 5; i++) deep["udtDefinitions"]!.AsArray().Add(Definition("Depth" + i, i == 4 ? Memory("Value") : Nested("Child", "Depth" + (i + 1))));
        Conflict(store, deep, "composition beyond four levels");
        var hierarchy = Package(); hierarchy["hierarchy"]!.AsArray().Add(new JsonObject { ["path"] = "[default]A", ["level"] = "Line" }); hierarchy["hierarchy"]!.AsArray().Add(new JsonObject { ["path"] = "[default]A/B", ["level"] = "Site" }); Conflict(store, hierarchy, "hierarchy parent ordering");
        var required = Definition("Required", Read("""{"path":"Value","kind":"memory","dataType":"Int64","value":"{Number}"}""")); required["parameters"] = new JsonArray(new JsonObject { ["name"] = "Number", ["type"] = "Int64", ["required"] = true });
        var missing = Package(); missing["udtDefinitions"]!.AsArray().Add(required); missing["instances"]!.AsArray().Add(Instance("[default]A", "Required")); Conflict(store, missing, "required parameter absent");
        var wrong = (JsonObject)missing.DeepClone(); wrong["instances"]![0]!["parameters"] = new JsonObject { ["Number"] = "4" }; Conflict(store, wrong, "parameters enforce declared scalar type");
        var injection = Definition("Injection", Read("""{"path":"Value","kind":"reference","dataType":"Int64","target":"[default]{Target}"}""")); injection["parameters"] = new JsonArray(new JsonObject { ["name"] = "Target", ["type"] = "String", ["default"] = "{Other}" });
        var injected = Package(); injected["udtDefinitions"]!.AsArray().Add(injection); injected["instances"]!.AsArray().Add(Instance("[default]A", "Injection")); Conflict(store, injected, "recursive placeholder injection");
        var tooMany = Definition("Many", Memory("A")); tooMany["parameters"] = new JsonArray(Enumerable.Range(0, 33).Select(i => (JsonNode?)new JsonObject { ["name"] = "P" + i, ["type"] = "String" }).ToArray()); InvalidDefinition(tooMany, "parameter count bound");
        var strict = Package(); strict["provider"]!["requireDeclaredHierarchy"] = true; strict["udtDefinitions"]!.AsArray().Add(Definition("One", Memory("Value"))); strict["instances"]!.AsArray().Add(Instance("[default]Undeclared/A", "One")); Conflict(store, strict, "required declared hierarchy");
        var refs = Package(); refs["tags"]!.AsArray().Add(Memory("[default]Target")); var reference = Reference("[default]Ref", "[default]Target"); reference["dataType"] = "Double"; refs["tags"]!.AsArray().Add(reference); Conflict(store, refs, "reference type must exactly match");
        Reject(() => TagModelParameters.Placeholders(string.Concat(Enumerable.Repeat("{P}", 17)), ["P"]), "placeholder count bound");
        var mixed = Package(); var child = Definition("Child", Memory("A"));
        child["parameters"] = new JsonArray(new JsonObject { ["name"] = "Device", ["type"] = "String" }, new JsonObject { ["name"] = "Count", ["type"] = "Double" });
        var member = Nested("Child", "Child"); member["parameters"] = new JsonObject { ["Device"] = "{Device}", ["Count"] = true };
        var parent = Definition("Parent", member); parent["parameters"] = new JsonArray(new JsonObject { ["name"] = "Device", ["type"] = "String" });
        mixed["udtDefinitions"]!.AsArray().Add(child); mixed["udtDefinitions"]!.AsArray().Add(parent); Conflict(store, mixed, "unused nested type validates constants alongside placeholders");
        var chain = Definition("Chain", Memory("Base"));
        for (var i = 0; i < 64; i++) chain["members"]!.AsArray().Add(Reference("R" + i, i == 0 ? "./Base" : "./R" + (i - 1)));
        var validChain = Package(); validChain["udtDefinitions"]!.AsArray().Add(chain); Apply(store, validChain);
        var excessive = (JsonObject)chain.DeepClone(); excessive["id"] = "Excessive"; excessive["members"]!.AsArray().Add(Reference("R64", "./R63")); InvalidDefinition(excessive, "dependency chain beyond 64");
        var overlapping = Package(); overlapping["udtDefinitions"]!.AsArray().Add(Definition("Alpha", Memory("x"))); overlapping["udtDefinitions"]!.AsArray().Add(Definition("Beta", Memory("z")));
        overlapping["udtDefinitions"]!.AsArray().Add(Definition("Overlap", Nested("A", "Alpha"), Nested("A/B", "Beta")));
        Conflict(store, overlapping, "nested type owns its descendant namespace");
        overlapping["udtDefinitions"]![2]!["members"]![1] = Memory("A/y"); Conflict(store, overlapping, "sibling leaf cannot inject into another nested type namespace");
        InvalidDefinition(Definition("LeafParentFirst", Memory("A"), Memory("A/B")), "scalar leaf cannot also be a parent folder");
        InvalidDefinition(Definition("LeafChildFirst", Memory("A/B"), Memory("A")), "leaf namespace collision rejected regardless of declaration order");
        overlapping["udtDefinitions"]![2] = Definition("LeafAboveType", Memory("A"), Nested("A/B", "Beta"));
        Conflict(store, overlapping, "scalar leaf cannot contain a nested type namespace");
        var folders = Package(); folders["udtDefinitions"]!.AsArray().Add(Definition("Folders", Memory("A/B"), Memory("A/C"))); Apply(store, folders);
    }
    private static string ValidationMessage(ProjectStore store, JsonObject package)
    {
        try
        {
            var preview = store.PreviewTagImport(package);
            if (!preview.CanApply) return string.Join(" ", preview.Conflicts ?? []);
        }
        catch (ArgumentException error) { return error.Message; }
        throw new InvalidOperationException("Expected a model validation failure.");
    }
    private static void ValidationDiagnostics(string directory)
    {
        var store = Store(directory, "validation-diagnostics");
        store.SaveConnection(new JsonObject { ["id"] = "opc", ["name"] = "Synthetic disabled OPC", ["type"] = "opcua", ["endpoint"] = "opc.tcp://127.0.0.1:1", ["enabled"] = false });
        var source = Read("""{"path":"[default]Source/Speed","kind":"opcua","connectionId":"opc","nodeId":"ns=2;s=Speed"}""");
        store.SaveTag(source);
        Check(!Tags(store)["[default]Source/Speed"].ContainsKey("dataType"), "OPC UA fixture has no declared data type");
        var references = Package(); references["tags"]!.AsArray().Add(Reference("[default]Model/Speed", "[default]Source/Speed"));
        var missingType = ValidationMessage(store, references);
        Check(missingType.Contains("[default]Source/Speed", StringComparison.Ordinal) && missingType.Contains("Declare its dataType in tag configuration", StringComparison.Ordinal)
            && missingType.Contains("not inferred from live values", StringComparison.Ordinal), "undeclared reference target reports the explicit configuration fix and does not infer live type");
        source["dataType"] = "Double"; store.SaveTag(source);
        Check(ValidationMessage(store, references).Contains("must exactly match target", StringComparison.Ordinal), "declared reference type mismatch remains a separate validation error");
        references["tags"]![0]!["dataType"] = "Double"; Apply(store, references);
        var duplicate = Package(); duplicate["udtDefinitions"]!.AsArray().Add(Definition("Duplicate", Memory("Spindle/Speed"), Memory("Spindle/Speed")));
        var duplicateMessage = ValidationMessage(store, duplicate);
        Check(duplicateMessage.Contains("Duplicate UDT member path: Spindle/Speed", StringComparison.Ordinal) && duplicateMessage.Contains("Duplicate@1", StringComparison.Ordinal), "duplicate UDT member diagnostic names the path and type revision");
    }
    private static void HierarchyOrdering()
    {
        static JsonObject Model(params (string Path, string Level)[] declarations)
        {
            var model = Package();
            foreach (var (path, level) in declarations) model["hierarchy"]!.AsArray().Add(new JsonObject { ["path"] = path, ["level"] = level });
            return model;
        }
        foreach (var level in new[] { "Enterprise", "Site", "Line" })
        {
            var folders = Model(("[default]Plant/Plain/Folder/Child", level), ("[default]Plant", "Line"));
            Reject(() => TagModelMetadata.Hierarchy(folders), "hierarchy cannot reverse or repeat levels across undeclared folders: " + level);
            var custom = Model(("[default]Plant/Custom/Folder/Child", level), ("[default]Plant/Custom", "Custom"), ("[default]Plant", "Line"));
            Reject(() => TagModelMetadata.Hierarchy(custom), "Custom hierarchy nodes cannot reset declared ancestor ordering: " + level);
        }
        var valid = Model(("[default]Plant", "Line"), ("[default]Plant/Group", "Custom"), ("[default]Plant/Group/Other", "Custom"),
            ("[default]Plant/Group/Other/Plain/Machine", "WorkCenter"), ("[default]Plant/Group/Other/Plain/Machine/Detail", "Custom"));
        Check(TagModelMetadata.Hierarchy(valid).Count == 5, "Custom nodes remain valid at any depth and standard descendants can skip levels across folders");
        var customRoot = Model(("[default]Group", "Custom"), ("[default]Group/Plain/Plant", "Enterprise"));
        Check(TagModelMetadata.Hierarchy(customRoot).Count == 2, "Custom root imposes no level when there is no declared standard ancestor");
        var nearest = Model(("[default]Plant", "Enterprise"), ("[default]Plant/Line", "Line"), ("[default]Plant/Line/Custom", "Custom"), ("[default]Plant/Line/Custom/Area", "Area"));
        Reject(() => TagModelMetadata.Hierarchy(nearest), "hierarchy checks the nearest non-Custom declared ancestor rather than a higher ancestor");
    }
    private static void CurrentFormat(string directory)
    {
        var importStore = Store(directory, "current-import");
        foreach (var version in new[] { 1, 2, 4 })
        {
            var path = Path.Combine(directory, "unsupported-format" + version); Directory.CreateDirectory(path);
            var old = Package(); old["version"] = version; old["tags"]!.AsArray().Add(Memory("[default]Original", 17));
            var bytes = Encoding.UTF8.GetBytes("  " + old.ToJsonString() + "\r\n"); File.WriteAllBytes(Path.Combine(path, "tags.json"), bytes);
            Reject(() => new ProjectStore(path, new EphemeralDataProtectionProvider(), gatewayOnly: true), "stored unsupported tag format " + version);
            Reject(() => importStore.PreviewTagImport(old), "import unsupported tag format " + version);
            Check(File.ReadAllBytes(Path.Combine(path, "tags.json")).SequenceEqual(bytes) && !Directory.Exists(Path.Combine(path, "migration-backups")), "unsupported tags are rejected without migration or rewrite");
        }
        var flatPath = Path.Combine(directory, "flat-array"); Directory.CreateDirectory(flatPath); File.WriteAllText(Path.Combine(flatPath, "tags.json"), "[]");
        Reject(() => new ProjectStore(flatPath, new EphemeralDataProtectionProvider(), gatewayOnly: true), "stored flat tag arrays");
        var checkpointPath = Path.Combine(directory, "checkpoint"); Directory.CreateDirectory(checkpointPath);
        var model = Package(); model["udtDefinitions"]!.AsArray().Add(Definition("Memory", Memory("Value", 1))); model["instances"]!.AsArray().Add(Instance("[default]Machine", "Memory"));
        File.WriteAllText(Path.Combine(checkpointPath, "tags.json"), model.ToJsonString());
        var originalStore = new ProjectStore(checkpointPath, new EphemeralDataProtectionProvider(), gatewayOnly: true);
        var tag = Tags(originalStore)["[default]Machine/Value"];
        var state = new JsonObject { ["version"] = 1, ["values"] = new JsonObject { ["[default]Machine/Value"] = new JsonObject { ["dataType"] = "Int64", ["value"] = 99L, ["configuration"] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(tag.ToJsonString()))).ToLowerInvariant() } } };
        File.WriteAllText(Path.Combine(checkpointPath, "tag-values.json"), state.ToJsonString());
        Check(Tags(new ProjectStore(checkpointPath, new EphemeralDataProtectionProvider(), gatewayOnly: true))["[default]Machine/Value"]["value"]!.ToJsonString() == "99", "current UDT checkpoint matches its exact definition hash");
        tag.Remove("modelPath"); tag.Remove("fieldProvenance");
        state["values"]!["[default]Machine/Value"]!["configuration"] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(tag.ToJsonString()))).ToLowerInvariant();
        File.WriteAllText(Path.Combine(checkpointPath, "tag-values.json"), state.ToJsonString());
        Check(Tags(new ProjectStore(checkpointPath, new EphemeralDataProtectionProvider(), gatewayOnly: true))["[default]Machine/Value"]["value"]!.ToJsonString() == "1", "obsolete checkpoint hash is ignored without compatibility fallback");
        var literalStore = Store(directory, "literal-node");
        literalStore.SaveConnection(new JsonObject { ["id"] = "opc", ["name"] = "Synthetic disabled OPC", ["type"] = "opcua", ["endpoint"] = "opc.tcp://127.0.0.1:1", ["enabled"] = false });
        var literal = Package();
        literal["udtDefinitions"]!.AsArray().Add(Definition("Literal", Read("""{"path":"Node","kind":"opcua","connectionId":"opc","nodeId":"ns=2;s=Literal.{braces}","dataType":"Double"}"""), Read("""{"path":"Text","kind":"memory","dataType":"String","value":"{literal}"}""")));
        literal["instances"]!.AsArray().Add(Instance("[default]Literal", "Literal")); Apply(literalStore, literal);
        Check(Tags(literalStore)["[default]Literal/Node"]["nodeId"]!.GetValue<string>() == "ns=2;s=Literal.{braces}" && Tags(literalStore)["[default]Literal/Text"]["value"]!.GetValue<string>() == "{literal}", "parameter-free node IDs and string values preserve literal braces");
    }
    private static async Task SourceReferences(string directory)
    {
        var store = Store(directory, "owned"); var mapping = new SourceMqttMapping("tree", "factory/#", "[default]Auto", Tags: "automatic", PruneAfterSeconds: 1);
        var settings = new SourceSettings("mqtt://127.0.0.1:1883", "subscribe", Mqtt: new(ClientId: "synthetic-uns", Mappings: [mapping]));
        store.SaveConnection(new JsonObject { ["id"] = "mqtt", ["name"] = "MQTT", ["type"] = "mqtt", ["source"] = JsonSerializer.SerializeToNode(settings, ProjectStore.Json) });
        var path = SourceConfiguration.TopicPath(mapping, "factory/value");
        store.ApplySourceDiscovery("mqtt", [new SourceDiscoveryItem("tree", "factory/value", null, "factory/value", "Int64", path, 1L)]);
        var package = Package(); var definition = Definition("Source", Reference("Reading", "{Target}")); definition["parameters"] = new JsonArray(new JsonObject { ["name"] = "Target", ["type"] = "String", ["required"] = true });
        package["udtDefinitions"]!.AsArray().Add(definition); var instance = Instance("[default]Line/Source", "Source"); instance["parameters"] = new JsonObject { ["Target"] = path }; package["instances"]!.AsArray().Add(instance); Apply(store, package);
        Check(Tags(store).ContainsKey(path) && Tags(store)["[default]Line/Source/Reading"]["target"]!.GetValue<string>() == path, "parameterized reference can resolve an existing source-owned MQTT tag");
        Reject(() => store.DeleteTag(path), "deleting a source-owned tag targeted by parameterized reference");
        await Task.Delay(1100);
        Check(store.PruneSourceLeaves("mqtt", true, DateTimeOffset.UtcNow.AddMinutes(-5)).Contains(path, StringComparer.Ordinal) && Tags(store).ContainsKey(path), "source pruning reports but retains referenced target");
    }
    private static void ReferenceValues()
    {
        var target = Memory("[default]Target"); var reference = Reference("[default]Reference", "[default]Target"); var plan = TagExpressions.Order([target, reference]).Single();
        var now = DateTimeOffset.UtcNow; var value = new TagValue("[default]Target", 9007199254740993L, "Int64", "Uncertain_Retained", now, "mqtt", true, now.AddSeconds(-5), now.AddSeconds(-1), "native", 4, 5, 6);
        var result = TagExpressions.Evaluate(plan, new Dictionary<string, TagValue> { [value.Path] = value }, now.AddSeconds(10));
        Check(result.Value is long exact && exact == 9007199254740993L && result.Quality == value.Quality && !result.Writable, "reference preserves exact value and uncertain quality while remaining read-only");
        Check(result.Timestamp == value.Timestamp && result.SourceTimestamp == value.SourceTimestamp && result.ReceiptTimestamp == value.ReceiptTimestamp && result.NativeStatus == value.NativeStatus, "reference preserves all target timestamps and status");
        foreach (var quality in new[] { "Good", "Bad_NoCommunication", "Uncertain_Stale" })
            Check(TagExpressions.Evaluate(plan, new Dictionary<string, TagValue> { [value.Path] = value with { Quality = quality } }, now, result).Quality == quality, "reference propagates " + quality);
        Check(TagExpressions.Evaluate(plan with { Enabled = false }, new Dictionary<string, TagValue> { [value.Path] = value }, now).Quality == "Bad_Disabled", "disabled reference reports disabled");
        Check(TagExpressions.Evaluate(plan, new Dictionary<string, TagValue>(), now).Quality == "Bad_NotFound", "missing runtime target reports not found");
    }
    private static async Task Runtime(string directory)
    {
        var store = Store(directory, "runtime"); var package = Package(); package["tags"]!.AsArray().Add(Memory("[default]Base", 17)); package["tags"]!.AsArray().Add(Reference("[default]Ref", "[default]Base")); package["tags"]!.AsArray().Add(Reference("[default]Chain", "[default]Ref")); Apply(store, package);
        using var connectors = new ConnectorService(Path.Combine(directory, "runtime")); using var engine = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance);
        await engine.StartAsync(default);
        try
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            while (engine.Read(["[default]Chain"], null).Single().Value is not JsonElement number || number.ValueKind != JsonValueKind.Number || number.GetInt64() != 17) await Task.Delay(20, deadline.Token);
            Check(engine.Read(["[default]Chain"], null).Single() is { Writable: false, Quality: "Good" }, "runtime evaluates reference chains without device connections");
            Reject(() => store.WriteMemoryTag("[default]Ref", JsonSerializer.SerializeToElement(2)), "memory write through reference");
            var remove = Package(); remove["removeTags"] = new JsonArray("[default]Base"); Conflict(store, remove, "target deletion dependency");
        }
        finally { await engine.StopAsync(default); }
    }
    private static async Task RuntimeSnapshots(string directory)
    {
        var store = Store(directory, "snapshots"); var package = Package();
        package["udtDefinitions"]!.AsArray().Add(Definition("Counter", Memory("Value")));
        var decimalType = Definition("Counter", new JsonObject { ["path"] = "Value", ["kind"] = "memory", ["dataType"] = "Double", ["value"] = 1.5 });
        decimalType["version"] = 2; package["udtDefinitions"]!.AsArray().Add(decimalType);
        package["instances"]!.AsArray().Add(Instance("[default]Snapshot", "Counter"));
        using var connectors = new ConnectorService(Path.Combine(directory, "snapshots"));
        using var engine = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance);
        void Import(JsonObject change)
        {
            var preview = store.PreviewTagImport(change);
            if (!preview.CanApply) throw new InvalidOperationException("Snapshot fixture import failed.");
            engine.ApplyImport(new(change, preview.Revision, preview.PreviewToken));
        }
        Import(package);
        var original = engine.ModelSnapshot();
        var writer = Task.Run(() =>
        {
            for (var i = 0; i < 40; i++)
            {
                var change = Package(); var instance = Instance("[default]Snapshot", "Counter");
                instance["version"] = i % 2 + 1; change["instances"]!.AsArray().Add(instance); Import(change);
            }
        });
        try
        {
            for (var i = 0; i < 120; i++)
            {
                var snapshot = engine.ModelSnapshot();
                var leaf = snapshot.Index.ReadObject("[default]Snapshot", _ => true, snapshot.Values)["members"]!["Value"]!;
                var type = leaf["dataType"]!.GetValue<string>(); var value = leaf["value"]!.ToJsonString();
                Check(type == "Int64" && value == "1" || type == "Double" && value == "1.5", "concurrent import snapshot keeps runtime values and model types in one revision");
                await Task.Delay(1);
            }
        }
        finally { await writer; }
        var latest = engine.ModelSnapshot();
        Check(latest.Index.ReadObject("[default]Snapshot", _ => true, latest.Values)["members"]!["Value"]!["dataType"]!.GetValue<string>() == "Double", "snapshot writer completed the type upgrade");
        Check(original.Index.ReadObject("[default]Snapshot", _ => true, original.Values)["members"]!["Value"]!["dataType"]!.GetValue<string>() == "Int64", "captured snapshot remains unchanged after later imports");
        var attempts = 0;
        var read = engine.ReadModel(index =>
        {
            var plan = index.PrepareObject("[default]Snapshot", _ => true);
            // Deliberately invalidate every optimistic capture. The fallback
            // must retain one coherent generation even if prepare commits again.
            var change = Package(); var instance = Instance("[default]Snapshot", "Counter");
            instance["version"] = ++attempts % 2 + 1; change["instances"]!.AsArray().Add(instance); Import(change);
            return plan;
        });
        Check(attempts == 5, "repeated configuration races use the bounded atomic model-read fallback");
        Check(read["members"]!["Value"]!["dataType"]!.GetValue<string>() == "Int64" && read["members"]!["Value"]!["value"]!.ToJsonString() == "1",
            "model-read fallback pairs immutable metadata and values despite a later import");
    }
    private static void Scale(string directory)
    {
        var model = Package(); model["udtDefinitions"]!.AsArray().Add(Definition("Five", Enumerable.Range(0, 5).Select(i => Memory("M" + i)).ToArray()));
        for (var i = 0; i < 2000; i++) model["instances"]!.AsArray().Add(Instance("[default]Scale/I" + i, "Five"));
        JsonObject Normalize(JsonObject node) { var result = (JsonObject)node.DeepClone(); result["enabled"] = TagDefinitionValidator.Enabled(node); return result; }
        Check(TagModel.Expand(model, Normalize).Count == 10000, "2,000 instances expand to the complete 10,000-leaf budget");
        var timer = Stopwatch.StartNew(); var expanded = TagModel.Expand(model, Normalize); timer.Stop();
        Console.WriteLine($"UNS expansion qualification: 2000 instances / {expanded.Count} leaves in {timer.Elapsed.TotalMilliseconds:F1} ms (target 250 ms).");
        var path = Path.Combine(directory, "scale"); Directory.CreateDirectory(path); File.WriteAllText(Path.Combine(path, "tags.json"), model.ToJsonString());
        var store = new ProjectStore(path, new EphemeralDataProtectionProvider(), gatewayOnly: true);
        var allocated = GC.GetAllocatedBytesForCurrentThread(); timer.Restart(); var concrete = store.GetTagDefinitions(); timer.Stop();
        Console.WriteLine($"UNS production normalization + returned clone: {concrete.Count} leaves in {timer.Elapsed.TotalMilliseconds:F1} ms; allocated {GC.GetAllocatedBytesForCurrentThread() - allocated:N0} bytes.");
        var preview = store.PreviewTagImport(Package());
        Check(preview.CanApply && preview.TotalTags == 10000, "production preview validates complete maximum-size model");
        Console.WriteLine($"UNS 2000-instance preview: {JsonSerializer.SerializeToUtf8Bytes(preview, ProjectStore.Json).Length:N0} bytes.");
        var excess = (JsonObject)model.DeepClone(); excess["instances"]!.AsArray().Add(Instance("[default]Scale/Extra", "Five")); Reject(() => TagModel.Expand(excess, Normalize), "instance cap 2,000");
        excess = (JsonObject)model.DeepClone(); excess["tags"]!.AsArray().Add(Memory("[default]Extra")); Reject(() => TagModel.Expand(excess, Normalize), "expanded tag cap 10,000");
    }
}
