using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using SparkStudio.Gateway;

internal static class ModelManagementChecks
{
    private static int checks;
    private const string Equipment = "[default]Plant/Assembly01";
    public static int Run()
    {
        checks = 0;
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.ModelManagement." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var store = new ProjectStore(Path.Combine(directory, "main"), new EphemeralDataProtectionProvider(), gatewayOnly: true);
            MappingChecks(store); OmittedOverrideChecks(directory); ComparisonChecks(); ComparisonEdgeChecks(); ExportChecks(store, directory); DependencyChecks(store); DependencyDepthChecks(store); StarterChecks(directory);
            return checks;
        }
        finally { Directory.Delete(directory, true); }
    }

    private static JsonObject Memory(string path, long value = 0) => new() { ["path"] = path, ["kind"] = "memory", ["dataType"] = "Int64", ["value"] = value };
    private static JsonObject Type(string id, params JsonObject[] fields) => new() { ["id"] = id, ["version"] = 1, ["members"] = new JsonArray(fields.Cast<JsonNode>().ToArray()) };
    private static JsonObject Fixture()
    {
        var model = TagModel.Empty();
        model["tags"] = new JsonArray(Memory("[default]Raw/A", long.MaxValue), Memory("[default]Raw/B", long.MinValue), Memory("[default]Unrelated/Value"));
        var member = Memory("Count"); member["unit"] = "counts"; member["semanticId"] = "urn:sparkstudio:example:count";
        var assembly = Type("Assembly", new JsonObject { ["path"] = "Motor", ["kind"] = "type", ["definitionId"] = "Counter", ["version"] = 1 }, Memory("Total"));
        assembly["parameters"] = new JsonArray(new JsonObject { ["name"] = "Device", ["type"] = "String", ["default"] = "A" },
            new JsonObject { ["name"] = "Seed", ["type"] = "Int64", ["default"] = long.MaxValue },
            new JsonObject { ["name"] = "SourceRoot", ["type"] = "String", ["default"] = "[default]Raw" });
        model["udtDefinitions"] = new JsonArray(Type("Counter", member), assembly, Type("Unrelated", Memory("Value")));
        model["mappingProfiles"] = new JsonArray(new JsonObject { ["id"] = "Panel", ["definitionId"] = "Assembly", ["version"] = 1,
            ["bindings"] = new JsonObject { ["Motor/Count"] = new JsonObject { ["kind"] = "reference", ["target"] = "[default]Raw/{Device}" } } });
        model["instances"] = new JsonArray(new JsonObject { ["path"] = Equipment, ["definitionId"] = "Assembly", ["version"] = 1,
            ["mappingProfileId"] = "Panel", ["parameters"] = new JsonObject(), ["overrides"] = new JsonObject {
                ["Motor/Count"] = new JsonObject { ["target"] = "[default]Raw/B" } } });
        model["hierarchy"] = new JsonArray(new JsonObject { ["path"] = "[default]Plant", ["level"] = "Enterprise" });
        return model;
    }

    private static void MappingChecks(ProjectStore store)
    {
        var model = Fixture(); Apply(store, model);
        var leaf = store.GetTagDefinitions().OfType<JsonObject>().Single(item => Text(item, "path") == Equipment + "/Motor/Count");
        Check(Text(leaf, "kind") == "reference" && Text(leaf, "target") == "[default]Raw/B" && !leaf.ContainsKey("value"), "mapping changes source kind, drops old source value and lets equipment override win");
        Check(Text(leaf, "unit") == "counts" && Text(leaf, "semanticId") == "urn:sparkstudio:example:count", "mapping preserves field contract metadata");
        Check(Text(leaf["fieldProvenance"]!.AsObject(), "target") == "override" && Text(leaf["fieldProvenance"]!.AsObject(), "kind") == "mapping-profile", "review provenance distinguishes mapping and equipment override");
        var staleOverride = Fixture(); staleOverride["instances"]![0]!["overrides"]!["Motor/Count"]!["value"] = 7;
        var rejected = store.PreviewTagImport(staleOverride);
        Check(!rejected.CanApply && rejected.Conflicts!.Any(message => message.Contains("value", StringComparison.Ordinal) && message.Contains(Equipment + "/Motor/Count", StringComparison.Ordinal)), "source-kind changes reject stale equipment overrides with the field and equipment path");
        Check(store.GetTagDefinitions().OfType<JsonObject>().Single(item => Text(item, "path") == Equipment + "/Motor/Count")["target"]!.GetValue<string>() == "[default]Raw/B", "rejected source-kind override leaves applied model intact");
        var instance = model["instances"]![0]!.AsObject(); instance["overrides"] = new JsonObject();
        var resolved = ModelMappingProfiles.Resolve(model, instance, "Motor/Count", model["udtDefinitions"]![0]!["members"]![0]!.AsObject());
        Check(Text(resolved, "target") == "[default]Raw/A", "nested field mapping resolves root equipment parameters");
        resolved["unit"] = "changed";
        Check(Text(model["udtDefinitions"]![0]!["members"]![0]!.AsObject(), "unit") == "counts", "mapping resolution does not mutate immutable definition");
        var invalid = Fixture(); invalid["mappingProfiles"]![0]!["bindings"]!["Removed"] = new JsonObject { ["kind"] = "memory", ["value"] = 1 };
        Reject(() => ModelMappingProfiles.Validate(invalid), "mapping references removed field");
        invalid = Fixture(); invalid["instances"]![0]!["mappingProfileId"] = "Missing";
        Reject(() => ModelMappingProfiles.Validate(invalid), "equipment missing mapping profile");
        invalid = Fixture(); invalid["mappingProfiles"]![0]!["definitionId"] = "Counter";
        Reject(() => ModelMappingProfiles.Validate(invalid), "profile model mismatch");
        invalid = Fixture(); invalid["instances"]!.AsArray().Clear(); invalid["mappingProfiles"]![0]!["bindings"]!["Motor/Count"] = new JsonObject { ["kind"] = "expression", ["expression"] = "unknown_function()", ["inputs"] = new JsonObject() };
        Reject(() => ModelMappingProfiles.Validate(invalid), "unused profile malformed expression");
        invalid = Fixture(); invalid["instances"]!.AsArray().Clear(); invalid["mappingProfiles"]![0]!["bindings"]!["Motor/Count"] = new JsonObject { ["kind"] = "opcua", ["connectionId"] = "Kepware", ["nodeId"] = "ns=not-a-number;s=Value" };
        Reject(() => ModelMappingProfiles.Validate(invalid), "unused profile malformed static OPC address");
        var rooted = Fixture(); rooted["mappingProfiles"]![0]!["bindings"]!["Motor/Count"]!["target"] = "{SourceRoot}/{Device}";
        ModelMappingProfiles.Validate(rooted);
        var resolvedRoot = ModelMappingProfiles.Resolve(rooted, rooted["instances"]![0]!.AsObject(), "Motor/Count", rooted["udtDefinitions"]![0]!["members"]![0]!.AsObject());
        Check(Text(resolvedRoot, "target") == "[default]Raw/A", "source-root and device parameters resolve in mapping paths");
        var wide = Fixture(); wide["mappingProfiles"]![0]!["bindings"]!["Motor/Count"] = new JsonObject { ["kind"] = "memory", ["value"] = long.MaxValue };
        var wire = TagModelWire.Package(wide);
        Check(wire["mappingProfiles"]![0]!["bindings"]!["Motor/Count"]!["value"]!.GetValue<string>() == "9223372036854775807", "profile memory value exports exact Int64 string");
        Check(TagModelWire.NormalizePackage(wire, TagModel.Empty())["mappingProfiles"]![0]!["bindings"]!["Motor/Count"]!["value"]!.GetValue<long>() == long.MaxValue, "profile memory value imports exact Int64");
    }

    private static void ComparisonChecks()
    {
        var model = Fixture(); var previous = model["udtDefinitions"]![1]!.AsObject();
        JsonObject Next() { var next = (JsonObject)previous.DeepClone(); next["version"] = 2; return next; }
        var same = ModelVersionComparison.Compare(model, Next());
        Check(same.Classification == "unchanged" && same.RequiresReview && same.Usage.Single().Path == Equipment, "unchanged shape still reports equipment usage and requires reviewed upgrade");
        var added = Next(); added["members"]!.AsArray().Add(Memory("Added"));
        Check(ModelVersionComparison.Compare(model, added).Classification == "compatible", "new field compatible with existing paths");
        var removed = Next(); removed["members"]!.AsArray().RemoveAt(1);
        Check(ModelVersionComparison.Compare(model, removed).Classification == "breaking", "removed field breaking");
        var required = Next(); required["parameters"]!.AsArray().Add(new JsonObject { ["name"] = "RequiredNew", ["type"] = "String", ["required"] = true });
        Check(ModelVersionComparison.Compare(model, required).Classification == "breaking", "new required parameter without default breaking");
        var child = (JsonObject)model["udtDefinitions"]![0]!.DeepClone(); child["version"] = 2; model["udtDefinitions"]!.AsArray().Add(child);
        var repinned = Next(); repinned["members"]![0]!["version"] = 2;
        Check(ModelVersionComparison.Compare(model, repinned).Classification == "breaking", "nested pin changes require behavior review even if current flattened fields match");
        var scalar = Type("Range", Memory("Value")); scalar["members"]![0]!["range"] = new JsonObject { ["low"] = 0, ["high"] = 100 }; model["udtDefinitions"]!.AsArray().Add(scalar);
        var widened = (JsonObject)scalar.DeepClone(); widened["version"] = 2; widened["members"]![0]!["range"]!["high"] = 200;
        Check(ModelVersionComparison.Compare(model, widened).Classification == "compatible", "widening range compatible");
        widened["members"]![0]!["range"]!["high"] = 50;
        Check(ModelVersionComparison.Compare(model, widened).Classification == "breaking", "narrowing range breaking");
    }

    private static void OmittedOverrideChecks(string directory)
    {
        var store = new ProjectStore(Path.Combine(directory, "optional-overrides"), new EphemeralDataProtectionProvider(), gatewayOnly: true);
        var model = Fixture(); model["instances"]![0]!.AsObject().Remove("overrides");
        Apply(store, model);
        Check(store.GetTagDefinitions().OfType<JsonObject>().Single(item => Text(item, "path") == Equipment + "/Motor/Count")["target"]!.GetValue<string>() == "[default]Raw/A", "omitted equipment overrides inherit source mapping unchanged");
        model["instances"]![0]!["overrides"] = null;
        Check(!store.PreviewTagImport(model).CanApply, "explicit null override object is rejected rather than silently discarded");
    }

    private static void ComparisonEdgeChecks()
    {
        var model = Fixture(); var next = (JsonObject)model["udtDefinitions"]![1]!.DeepClone(); next["version"] = 2;
        next["members"]![1]!["range"] = new JsonObject { ["low"] = 0 };
        Reject(() => ModelVersionComparison.Compare(model, next), "incomplete candidate range rejects with an argument error");
        next["members"]![1]!.AsObject().Remove("range");
        next["members"]![0]!["definitionId"] = "DraftCounter";
        var child = Type("DraftCounter", Memory("Count"));
        Check(ModelVersionComparison.Compare(model, next, proposedDefinitions: [next, child]).Classification == "breaking", "comparison resolves new nested types from one unsaved proposed batch");
        Reject(() => ModelVersionComparison.Compare(model, next), "comparison reports missing nested draft dependency");
        var exact = Type("Exact", Memory("Count")); exact["members"]![0]!["range"] = new JsonObject { ["low"] = 0, ["high"] = long.MaxValue };
        model["udtDefinitions"]!.AsArray().Add(exact);
        var narrow = (JsonObject)exact.DeepClone(); narrow["version"] = 2; narrow["members"]![0]!["range"]!["high"] = long.MaxValue - 1;
        Check(ModelVersionComparison.Compare(model, narrow).Classification == "breaking", "range narrowing distinguishes adjacent Int64 limits");
        var enumeration = Type("Enum", Memory("State")); enumeration["members"]![0]!["enumValues"] = new JsonArray(0, 1); model["udtDefinitions"]!.AsArray().Add(enumeration);
        var removedEnum = (JsonObject)enumeration.DeepClone(); removedEnum["version"] = 2; removedEnum["members"]![0]!["enumValues"] = new JsonArray();
        Check(ModelVersionComparison.Compare(model, removedEnum).Classification == "compatible", "empty enum list removes constraint compatibly");
    }

    private static void ExportChecks(ProjectStore store, string directory)
    {
        var result = ModelSelectiveExport.Export(store.ExportTags(), store.GetTagDefinitions(), new(InstancePaths: [Equipment]));
        Check(result.Summary.Types == 2 && result.Summary.Instances == 1 && result.Summary.Locations == 1 && result.Summary.Mappings == 1, "selective export includes composed definitions, equipment, ancestors and mappings");
        Check(result.Summary.Tags == 1 && Text(result.Package["tags"]![0]!.AsObject(), "path") == "[default]Raw/B", "selective export follows effective source override and omits unrelated tags");
        Check(!result.Package.ContainsKey("provider") && result.ExternalDependencies.Length == 0, "partial export preserves destination provider and has no unresolved authored dependencies");
        var destination = new ProjectStore(Path.Combine(directory, "destination"), new EphemeralDataProtectionProvider(), gatewayOnly: true);
        Apply(destination, result.Package);
        Check(destination.GetTagDefinitions().OfType<JsonObject>().Any(item => Text(item, "path") == Equipment + "/Motor/Count"), "selective model package imports with transitive dependencies");
        var external = ModelSelectiveExport.Export(store.ExportTags(), store.GetTagDefinitions(), new(InstancePaths: [Equipment], IncludeSourceTags: false));
        Check(external.Summary.Tags == 0 && external.ExternalDependencies.Any(item => item.Id == "[default]Raw/B"), "source exclusion lists destination requirements explicitly");
        Reject(() => ModelSelectiveExport.Export(store.ExportTags(), store.GetTagDefinitions(), new()), "empty export selection");
        Reject(() => ModelSelectiveExport.Export(store.ExportTags(), store.GetTagDefinitions(), new(DefinitionKeys: ["Missing@1"])), "missing model export selection");
    }

    private static void DependencyChecks(ProjectStore store)
    {
        var documents = new[] { new ModelDependencyDocument("draft:p1/s1", "Screen", "screen", new JsonObject { ["binding"] = Equipment + "/Motor/Count", ["missing"] = "[default]Missing/Value" }, "p1") };
        var result = ModelDependencies.Build(store.ExportTags(), store.GetTagDefinitions(), new JsonArray(), documents);
        Check(result.Edges.Any(edge => edge.From == "tag:[default]Raw/B" && edge.To == "tag:" + Equipment + "/Motor/Count"), "dependency graph follows effective source references");
        Check(result.Edges.Any(edge => edge.From == "tag:" + Equipment + "/Motor/Count" && edge.To == "screen:draft:p1/s1"), "dependency graph reaches designer screen binding");
        Check(result.Issues.Any(issue => issue.Kind == "missing-source" && issue.Message.Contains("[default]Missing/Value", StringComparison.Ordinal)), "missing screen source is an issue rather than silently omitted");
        Check(result.Issues.Any(issue => issue.Kind == "unused-type" && issue.Id == "type:Unrelated@1"), "unused model detected");
        var filtered = ModelDependencies.Build(store.ExportTags(), store.GetTagDefinitions(), new JsonArray(), documents, type: "Assembly");
        Check(filtered.Nodes.Any(node => node.Id == "screen:draft:p1/s1") && !filtered.Nodes.Any(node => node.Id == "type:Unrelated@1"), "model filter follows graph while excluding unrelated models");
    }

    private static void DependencyDepthChecks(ProjectStore store)
    {
        var model = store.ExportTags(); var expanded = store.GetTagDefinitions();
        expanded.Add(new JsonObject { ["path"] = "[default]LongChain/0", ["kind"] = "device", ["connectionId"] = "plc", ["nodeId"] = "Speed", ["dataType"] = "Int64" });
        for (var index = 1; index <= 12; index++) expanded.Add(new JsonObject { ["path"] = "[default]LongChain/" + index, ["kind"] = "reference", ["target"] = "[default]LongChain/" + (index - 1), ["dataType"] = "Int64" });
        expanded.OfType<JsonObject>().Single(item => Text(item, "path") == Equipment + "/Motor/Count")["target"] = "[default]LongChain/12";
        var connections = new JsonArray(new JsonObject { ["id"] = "plc", ["name"] = "Fixture PLC" });
        var graph = ModelDependencies.Build(model, expanded, connections, [], type: "Assembly", instance: Equipment);
        Check(graph.Nodes.Any(node => node.Id == "instance:" + Equipment) && graph.Nodes.Any(node => node.Id == "connection:plc"), "combined model/equipment filter follows the complete long-chain dependency closure");
        Check(graph.Nodes.Any(node => node.Id == "tag:[default]LongChain/0") && !graph.Truncated, "dependency graph does not silently stop at six hops");
        Check(ModelDependencies.Build(model, expanded, connections, [], type: "Unrelated", instance: Equipment).Nodes.Length == 0, "incompatible model and equipment filters return no unrelated graph");
        var searched = ModelDependencies.Build(model, expanded, connections, [], type: "Assembly", query: "Fixture PLC");
        Check(searched.Nodes.Length == 1 && searched.Nodes[0].Id == "connection:plc", "search filters the expanded model dependency scope");
    }

    private static void StarterChecks(string directory)
    {
        var items = ModelStarters.Items(); Check(items.Select(item => item.Id).SequenceEqual(new[] { "Motor", "Pump", "Press", "OEE" }), "four independently authored starters present");
        foreach (var starter in items)
        {
            var model = TagModel.Empty(); model["udtDefinitions"]!.AsArray().Add(starter.Definition.DeepClone());
            model["instances"]!.AsArray().Add(new JsonObject { ["path"] = "[default]Demo/" + starter.Id, ["definitionId"] = starter.Id, ["version"] = 1, ["overrides"] = new JsonObject() });
            var store = new ProjectStore(Path.Combine(directory, "starter-" + starter.Id), new EphemeralDataProtectionProvider(), gatewayOnly: true);
            Apply(store, model);
            Check(store.GetTagDefinitions().Count >= 3 && starter.Walkthrough.Length >= 4, "starter " + starter.Id + " imports and provides actionable walkthrough");
        }
    }

    private static void Apply(ProjectStore store, JsonObject model)
    {
        var preview = store.PreviewTagImport(model); Check(preview.CanApply, "valid management fixture: " + string.Join("; ", preview.Conflicts ?? []));
        store.ApplyTagImport(new(model, preview.Revision, preview.PreviewToken));
    }
    private static string Text(JsonObject value, string field) => value[field]?.GetValue<string>() ?? "";
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("Model management: " + message); checks++; }
    private static void Reject(Action action, string message)
    {
        try { action(); } catch (ArgumentException) { checks++; return; }
        throw new InvalidOperationException("Model management accepted " + message);
    }
}
