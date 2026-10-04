using System.Text.Json.Nodes;
using SparkStudio.Gateway;
using Microsoft.AspNetCore.Http;

internal static class ModelReadChecks
{
    private static int checks;
    private const string Root = "[default]Acme/Line1";
    public static int Run()
    {
        checks = 0;
        var (model, expanded) = Fixture();
        var index = new ModelReadIndex(17, model, expanded);
        var stamp = DateTimeOffset.Parse("2026-10-04T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var path = Root + "/CNC01/Spindle/Speed";
        var values = new Dictionary<string, TagValue>(StringComparer.Ordinal)
        { [path] = new(path, 7200d, "Double", "Uncertain_Retained", stamp, "reference", SourceTimestamp: stamp.AddSeconds(-2), ReceiptTimestamp: stamp) };
        bool Allowed(string candidate) => candidate.StartsWith(Root + "/CNC01/", StringComparison.Ordinal) && !candidate.EndsWith("/PartCount", StringComparison.Ordinal);
        var instance = index.ReadObject(Root + "/CNC01", Allowed, values);
        Check(instance["restrictedMembers"]!.GetValue<int>() == 1 && instance["members"]!["PartCount"] is null, "restricted leaves are omitted and counted");
        var speed = instance["members"]!["Spindle"]!["Speed"]!;
        Check(speed["value"]!.GetValue<double>() == 7200 && speed["quality"]!.GetValue<string>() == "Uncertain_Retained", "object reads use current engine value and quality");
        Check(speed["sourceTimestamp"]!.GetValue<DateTimeOffset>() == stamp.AddSeconds(-2) && speed["receiptTimestamp"]!.GetValue<DateTimeOffset>() == stamp, "source and receipt timestamps are retained independently");
        values[path] = values[path] with { SourceTimestamp = null, ReceiptTimestamp = null };
        var untimed = index.ReadObject(Root + "/CNC01", Allowed, values)["members"]!["Spindle"]!["Speed"]!;
        Check(untimed["sourceTimestamp"] is null && untimed["receiptTimestamp"] is null && !untimed.AsObject().ContainsKey("serverTimestamp") && untimed["timestamp"]!.GetValue<DateTimeOffset>() == stamp,
            "unknown source and receipt timestamps remain null instead of being invented from the gateway timestamp");
        Check(speed["path"]!.GetValue<string>() == path && speed["metadata"]!["unit"]!.GetValue<string>() == "rev/min", "nested leaf retains ordinary path and metadata");
        Reject<KeyNotFoundException>(() => index.ReadObject(Root + "/CNC02", Allowed, values), "fully denied instance looks absent");
        Reject<KeyNotFoundException>(() => index.ReadObject(Root + "/Missing", Allowed, values), "unknown instance looks absent");
        var instances = index.Instances(Allowed, "CNC", 1, Root, 0, 1);
        Check(instances["total"]!.GetValue<int>() == 1 && instances["items"]![0]!["path"]!.GetValue<string>().EndsWith("CNC01", StringComparison.Ordinal), "instance filters paginate after scopes");
        var tree = index.Tree(Allowed, false, values, "[default]", 8, 0, 200).ToJsonString();
        Check(tree.Contains("CNC01", StringComparison.Ordinal) && !tree.Contains("CNC02", StringComparison.Ordinal) && !tree.Contains("PartCount", StringComparison.Ordinal), "tree hides denied instances and leaves");
        var top = index.Tree(Allowed, false, values, "[default]", 1, 0, 200);
        var pagePlan = index.PrepareTree(Allowed, false, Root + "/CNC01", 2, 1, 1);
        Check(pagePlan.Paths.SequenceEqual(new[] { path }) && pagePlan.Render(values)["items"]!.AsArray().Count == 1, "tree plans capture only the requested page's readable leaf values");
        Check(index.PrepareObject(Root + "/CNC01", Allowed).Paths.SequenceEqual(new[] { path }), "object plans capture only readable instance members");
        Check(top["items"]!.AsArray().Count == 1 && top["items"]![0]!["path"]!.GetValue<string>() == "[default]Acme", "tree depth is relative to provider root");
        Check(index.Tree(_ => false, false, values, null, 8, 0, 200)["total"]!.GetValue<int>() == 0, "fully denied hierarchy is hidden");
        Check(index.Tree(_ => false, true, values, null, 8, 0, 200)["total"]!.GetValue<int>() > 0, "engineering can author empty declared hierarchy");
        var types = index.Types(Allowed, false, null, 0, 200);
        Check(types["items"]!.AsArray().Count == 2, "readable composed assets expose both pinned type versions");
        var cnc = types["items"]!.AsArray().OfType<JsonObject>().Single(item => item["id"]!.GetValue<string>() == "CNC");
        Check(cnc["members"]!.AsArray().Count == 1 && cnc["restrictedMembers"]!.GetValue<int>() == 1, "operator type projection omits denied members");
        Check(index.Types(_ => false, false, null, 0, 200)["total"]!.GetValue<int>() == 0, "operator cannot enumerate unused types");
        Check(index.Types(_ => false, true, null, 0, 200)["total"]!.GetValue<int>() == 3, "engineering can select unused types");
        var first = index.Types(_ => true, true, null, 0, 1);
        var second = index.Types(_ => true, true, null, 1, 1);
        Check(first["nextOffset"]!.GetValue<int>() == 1 && first["items"]![0]!["id"]!.GetValue<string>() != second["items"]![0]!["id"]!.GetValue<string>(), "pages return stable nonoverlapping sorted definitions");
        Reject<ArgumentException>(() => index.Types(_ => true, true, null, -1, 1), "negative offset");
        Reject<ArgumentException>(() => index.Types(_ => true, true, null, 0, 201), "unbounded page");
        Reject<ArgumentException>(() => index.Tree(_ => true, true, values, null, 9, 0, 10), "unbounded tree depth");
        Reject<ArgumentException>(() => index.Tree(_ => true, true, values, "[default]../escape", 1, 0, 10), "invalid tree path");
        first["items"]![0]!["id"] = "tampered"; model["udtDefinitions"]!.AsArray().Clear(); expanded.Clear();
        Check(index.Types(_ => true, true, null, 0, 200)["total"]!.GetValue<int>() == 3 && !index.Types(_ => true, true, null, 0, 200).ToJsonString().Contains("tampered", StringComparison.Ordinal), "index and returned pages are isolated from caller mutation");
        values[path] = values[path] with { Value = 9600d, Quality = "Good" };
        Check(index.ReadObject(Root + "/CNC01", Allowed, values)["members"]!["Spindle"]!["Speed"]!["value"]!.GetValue<double>() == 9600d && index.Generation == 17, "live value changes do not require rebuilding the configuration index");
        ParameterProjectionChecks();
        ConfigurationProjectionChecks();
        InferredDataTypeChecks();
        HierarchyAnnotationChecks();
        AskModelApplyChecks();
        return checks;
    }

    private static void InferredDataTypeChecks()
    {
        var (model, expanded) = Fixture();
        var path = Root + "/CNC01/PartCount";
        var leaf = expanded.OfType<JsonObject>().Single(item => item["path"]!.GetValue<string>() == path);
        leaf["kind"] = "opcua"; leaf.Remove("dataType");
        var index = new ModelReadIndex(20, model, expanded);
        var values = new Dictionary<string, TagValue>(StringComparer.Ordinal);
        var waiting = index.ReadObject(Root + "/CNC01", _ => true, values)["members"]!["PartCount"]!;
        Check(waiting["dataType"]!.GetValue<string>() == "Unknown" && waiting["value"] is null,
            "legacy OPC UA members without a declared type retain an explicit unknown type before acquisition");
        values[path] = new(path, long.MaxValue, "Int64", "Good", DateTimeOffset.UtcNow, "opcua");
        var acquired = index.ReadObject(Root + "/CNC01", _ => true, values)["members"]!["PartCount"]!;
        Check(acquired["dataType"]!.GetValue<string>() == "Int64" && acquired["value"]!.GetValue<string>() == "9223372036854775807",
            "inferred OPC UA runtime type retains the exact Int64 wire value");
    }

    private static void HierarchyAnnotationChecks()
    {
        var (model, expanded) = Fixture();
        var instancePath = Root + "/CNC01";
        var leafPath = instancePath + "/Spindle/Speed";
        model["hierarchy"]!.AsArray().Add(new JsonObject { ["path"] = instancePath, ["level"] = "WorkCenter" });
        model["hierarchy"]!.AsArray().Add(new JsonObject { ["path"] = leafPath, ["level"] = "Custom" });
        var index = new ModelReadIndex(19, model, expanded);
        var values = new Dictionary<string, TagValue>(StringComparer.Ordinal)
        { [leafPath] = new(leafPath, 7200d, "Double", "Good", DateTimeOffset.UtcNow, "reference") };
        var nodes = index.Tree(_ => true, true, values, Root, 8, 0, 200)["items"]!.AsArray().OfType<JsonObject>().ToDictionary(node => node["path"]!.GetValue<string>(), StringComparer.Ordinal);
        Check(nodes[instancePath]["kind"]!.GetValue<string>() == "instance" && nodes[instancePath]["definitionId"]!.GetValue<string>() == "CNC" && nodes[instancePath]["level"]!.GetValue<string>() == "WorkCenter", "hierarchy at an instance preserves type identity and adds its level");
        Check(nodes[leafPath]["kind"]!.GetValue<string>() == "member" && nodes[leafPath]["value"]!.GetValue<double>() == 7200 && nodes[leafPath]["level"]!.GetValue<string>() == "Custom", "hierarchy at a member preserves its live value and adds its level");
    }

    private static void ParameterProjectionChecks()
    {
        var (model, expanded) = Fixture();
        var definition = model["udtDefinitions"]![0]!.AsObject();
        definition["parameters"] = JsonNode.Parse("""[{"name":"SecretValue","type":"String","default":"private-value"},{"name":"Counter","type":"Int64","default":9223372036854775807}]""");
        definition["members"]![1]!["parameters"] = JsonNode.Parse("""{"SecretValue":"nested-private-value"}""");
        var index = new ModelReadIndex(18, model, expanded);
        bool Allowed(string path) => path.EndsWith("/Speed", StringComparison.Ordinal);
        var values = new Dictionary<string, TagValue>(StringComparer.Ordinal);
        var partial = index.ReadObject(Root + "/CNC01", Allowed, values);
        Check(partial["parameters"]!.AsObject().Count == 0 && partial["parameterValuesRestricted"]!.GetValue<bool>(), "partially readable objects redact parameter values");
        foreach (var output in new[] { partial, index.Instances(Allowed, null, null, null, 0, 200), index.Tree(Allowed, false, values, null, 8, 0, 200), index.Types(Allowed, false, null, 0, 200) })
            Check(!output.ToJsonString().Contains("private-value", StringComparison.Ordinal), "scoped model response does not expose hidden parameter defaults or nested arguments");
        var full = index.ReadObject(Root + "/CNC01", _ => true, values, includeConfiguration: true);
        Check(full["parameters"]!["Counter"]!.GetValue<string>() == "9223372036854775807", "resolved Int64 parameter retains exact wire value");
        var types = index.Types(_ => true, true, "CNC", 0, 200, includeConfiguration: true);
        Check(types["items"]![0]!["parameters"]![1]!["default"]!.GetValue<string>() == "9223372036854775807", "engineering type defaults retain exact Int64 wire values");
        var countPath = Root + "/CNC01/PartCount";
        values[countPath] = new(countPath, long.MaxValue, "Int64", "Good", DateTimeOffset.UtcNow, "reference");
        Check(index.ReadObject(Root + "/CNC01", _ => true, values)["members"]!["PartCount"]!["value"]!.GetValue<string>() == "9223372036854775807", "runtime Int64 model member retains exact wire value");
    }

    private static void ConfigurationProjectionChecks()
    {
        var (model, expanded) = ConfigurationFixture();
        var index = new ModelReadIndex(21, model, expanded);
        var values = new Dictionary<string, TagValue>(StringComparer.Ordinal);
        foreach (var includeUnused in new[] { false, true })
        {
            var response = index.Types(_ => true, includeUnused, null, 0, 200);
            foreach (var definition in response["items"]!.AsArray().OfType<JsonObject>())
            {
                foreach (var member in definition["members"]!.AsArray().OfType<JsonObject>())
                    Check(new[] { "connectionId", "nodeId", "target", "expression", "inputs", "value", "parameters", "scanGroup", "publishingIntervalMs", "absoluteDeadband", "queueSize", "writable", "enabled" }.All(field => !member.ContainsKey(field)),
                        "non-configuring full-scope type reads expose logical members without acquisition settings");
                foreach (var parameter in (definition["parameters"] as JsonArray ?? []).OfType<JsonObject>())
                    Check(parameter.ContainsKey("name") && parameter.ContainsKey("type") && !parameter.ContainsKey("default"), "parameter declarations retain their shape without saved values");
            }
            var cnc = response["items"]!.AsArray().OfType<JsonObject>().Single(item => item["id"]!.GetValue<string>() == "CNC");
            var reference = cnc["members"]!.AsArray().OfType<JsonObject>().Single(item => item["path"]!.GetValue<string>() == "PartCount");
            Check(reference["kind"]!.GetValue<string>() == "reference" && reference["dataType"]!.GetValue<string>() == "Int64" && reference["unit"]!.GetValue<string>() == "count", "logical type member identity and units survive configuration redaction");
            var nested = cnc["members"]!.AsArray().OfType<JsonObject>().Single(item => item["path"]!.GetValue<string>() == "Spindle");
            Check(nested["definitionId"]!.GetValue<string>() == "Spindle" && nested["version"]!.GetValue<int>() == 1, "nested type identity survives configuration redaction");
        }
        var instance = index.ReadObject(Root + "/CNC01", _ => true, values);
        Check(instance["restrictedMembers"]!.GetValue<int>() == 0 && instance["parameters"]!.AsObject().Count == 0 && instance["parameterValuesRestricted"]!.GetValue<bool>(), "full tag scope does not grant access to instance parameter values");
        foreach (var response in new[] { index.Instances(_ => true, null, null, null, 0, 200), index.Tree(_ => true, true, values, null, 8, 0, 200) })
            Check(!response.ToJsonString().Contains("private-", StringComparison.Ordinal), "list and tree cannot bypass parameter-value restrictions");
        var configured = index.Types(_ => true, true, "CNC", 0, 200, includeConfiguration: true)["items"]![0]!;
        Check(configured["parameters"]![0]!["default"]!.GetValue<string>() == "private-default", "configuration access retains type defaults");
        Check(configured["members"]![0]!["target"]!.GetValue<string>() == "[default]Private/Count", "configuration access retains reference source addresses");
        Check(index.ReadObject(Root + "/CNC01", _ => true, values, includeConfiguration: true)["parameters"]!["Source"]!.GetValue<string>() == "private-instance", "configuration access retains explicit instance values");
    }

    private static (JsonObject Model, JsonArray Expanded) ConfigurationFixture()
    {
        var (model, expanded) = Fixture();
        var cnc = model["udtDefinitions"]![0]!.AsObject();
        cnc["parameters"] = JsonNode.Parse("""[{"name":"Source","type":"String","required":true,"default":"private-default"}]""");
        cnc["members"]![0]!["target"] = "[default]Private/Count"; cnc["members"]![0]!["unit"] = "count";
        cnc["members"]![1]!["parameters"] = JsonNode.Parse("""{"Source":"private-nested-argument"}""");
        model["udtDefinitions"]![1]!["parameters"] = JsonNode.Parse("""[{"name":"Source","type":"String","default":"private-nested-default"}]""");
        var authored = JsonNode.Parse("""
            [{"path":"Memory","kind":"memory","dataType":"String","value":"private-memory","enabled":false},
             {"path":"Expression","kind":"expression","dataType":"Double","expression":"speed * 2","inputs":{"speed":"[default]Private/Speed"}},
             {"path":"Opc","kind":"opcua","dataType":"Double","connectionId":"private-opc","nodeId":"ns=2;s=Private.Speed","scanGroup":"private-scan","publishingIntervalMs":500,"absoluteDeadband":1,"queueSize":4},
             {"path":"Device","kind":"device","dataType":"Double","connectionId":"private-device","nodeId":"private-point","writable":true}]
            """)!.AsArray();
        foreach (var member in authored.OfType<JsonObject>()) cnc["members"]!.AsArray().Add(member.DeepClone());
        foreach (var instance in model["instances"]!.AsArray().OfType<JsonObject>())
        {
            instance["parameters"] = JsonNode.Parse("""{"Source":"private-instance"}""");
            foreach (var member in authored.OfType<JsonObject>())
                expanded.Add(new JsonObject { ["path"] = instance["path"]!.GetValue<string>() + "/" + member["path"]!.GetValue<string>(),
                    ["udtInstance"] = instance["path"]!.DeepClone(), ["modelPath"] = member["path"]!.DeepClone(),
                    ["kind"] = member["kind"]!.DeepClone(), ["dataType"] = member["dataType"]!.DeepClone() });
        }
        return (model, expanded);
    }

    private static void AskModelApplyChecks()
    {
        foreach (var field in new[] { "udtDefinitions", "instances", "hierarchy", "removeUdtDefinitions", "removeInstances", "removeHierarchy" })
        {
            var arguments = new JsonObject { ["package"] = new JsonObject { [field] = new JsonArray(new JsonObject()) } };
            Reject<BadHttpRequestException>(() => AskSparkModelTools.RequireUserModelApply("tags_import_apply", arguments), "model mutation requires manual apply: " + field);
        }
        Reject<BadHttpRequestException>(() => AskSparkModelTools.RequireUserModelApply("tags_import_apply", JsonNode.Parse("""{"package":{"provider":{"requireDeclaredHierarchy":false}}}""")!.AsObject()), "hierarchy policy is also a manually reviewed model change");
        AskSparkModelTools.RequireUserModelApply("tags_import_apply", JsonNode.Parse("""{"package":{"tags":[{"path":"[default]Value"}],"instances":[],"udtDefinitions":[]}}""")!.AsObject());
        Check(true, "ordinary raw tag imports retain their existing confirmation flow");
    }

    private static (JsonObject Model, JsonArray Expanded) Fixture()
    {
        var model = JsonNode.Parse("""
        {"udtDefinitions":[
          {"id":"CNC","version":1,"semanticType":"isa95:WorkUnit","members":[{"path":"PartCount","kind":"reference","dataType":"Int64"},{"path":"Spindle","kind":"type","definitionId":"Spindle","version":1}]},
          {"id":"Spindle","version":1,"members":[{"path":"Speed","kind":"reference","dataType":"Double","unit":"rev/min"}]},
          {"id":"Unused","version":1,"members":[{"path":"Value","kind":"memory","dataType":"Double","value":0}]}],
         "instances":[{"path":"[default]Acme/Line1/CNC01","definitionId":"CNC","version":1},{"path":"[default]Acme/Line1/CNC02","definitionId":"CNC","version":1}],
         "hierarchy":[{"path":"[default]Acme","level":"Enterprise"},{"path":"[default]Acme/Line1","level":"Line"}]}
        """)!.AsObject();
        var expanded = new JsonArray();
        foreach (var instance in model["instances"]!.AsArray().OfType<JsonObject>())
            foreach (var member in new[] { "Spindle/Speed", "PartCount" })
                expanded.Add(new JsonObject { ["path"] = instance["path"]!.GetValue<string>() + "/" + member, ["udtInstance"] = instance["path"]!.DeepClone(),
                    ["modelPath"] = member, ["udtDefinition"] = "CNC", ["udtVersion"] = 1, ["kind"] = "reference",
                    ["dataType"] = member == "PartCount" ? "Int64" : "Double", ["unit"] = member == "PartCount" ? "count" : "rev/min" });
        return (model, expanded);
    }

    private static void Check(bool condition, string description) { if (!condition) throw new Exception(description); checks++; }
    private static void Reject<T>(Action action, string description) where T : Exception
    { try { action(); } catch (T) { checks++; return; } throw new Exception("Expected rejection: " + description); }
}
