using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public sealed record ModelStarter(string Id, string Name, string Description, JsonObject Definition, string[] Walkthrough);

/// <summary>Original teaching examples, not copied profiles or claims of standards certification.</summary>
public static class ModelStarters
{
    public static ModelStarter[] Items() => [
        Starter("Motor", "Motor", "Running state, speed and motor temperature.",
            Field("Running", "Boolean", JsonValue.Create(false)), Field("Speed", "Double", JsonValue.Create(0), "/min", 0, 10000), Field("Temperature", "Double", JsonValue.Create(25), "Cel", -40, 200)),
        Starter("Pump", "Pump", "Pump operating state, pressure and flow.",
            State(), Field("Pressure", "Double", JsonValue.Create(0), "kPa", 0, 2000), Field("Flow", "Double", JsonValue.Create(0), "L/min", 0, 1000)),
        Starter("Press", "Press", "Press state, load and cycle counter, with an example high-load alarm.",
            State(), PressLoad(), Field("CycleCount", "Int64", JsonValue.Create(0))),
        Starter("OEE", "OEE", "Availability × Performance × Quality, each supplied as a percentage. Supply interval-consistent inputs.",
            Field("Availability", "Double", JsonValue.Create(0), "%", 0, 100), Field("Performance", "Double", JsonValue.Create(0), "%", 0, 100),
            Field("Quality", "Double", JsonValue.Create(0), "%", 0, 100), Oee())
    ];
    private static ModelStarter Starter(string id, string name, string description, params JsonObject[] members) => new(id, name, description,
        new() { ["id"] = id, ["version"] = 1, ["description"] = description, ["semanticId"] = "urn:sparkstudio:example:" + id.ToLowerInvariant(), ["parameters"] = new JsonArray(), ["members"] = new JsonArray(members.Select(member => (JsonNode)member).ToArray()) },
        ["Add this starter to your draft. Choose a new name if that model already exists.",
         "Inspect the example fields, units, limits and alarm thresholds; adjust them for your equipment.",
         "Add equipment to try the synthetic memory values, or create a source mapping to your saved tags.",
         "Review and apply once. Open the live object and Issues to verify the mapped values.",
         "Try an out-of-range value on disposable test equipment, then restore it. Configure MQTT publishing only after checking the payload preview."]);
    private static JsonObject Field(string path, string type, JsonNode? value, string? unit = null, double? low = null, double? high = null)
    {
        var field = new JsonObject { ["path"] = path, ["kind"] = "memory", ["dataType"] = type, ["value"] = value, ["description"] = "Synthetic example: " + path };
        if (unit is not null) { field["unit"] = unit; field["unitSystem"] = "ucum"; }
        if (low is not null && high is not null) field["range"] = new JsonObject { ["low"] = low, ["high"] = high };
        return field;
    }
    private static JsonObject State()
    {
        var field = Field("State", "String", JsonValue.Create("idle")); field["enumValues"] = new JsonArray("idle", "running", "fault"); return field;
    }
    private static JsonObject PressLoad()
    {
        var field = Field("Load", "Int32", JsonValue.Create(0), "%", 0, 100);
        field["alarms"] = new JsonArray(new JsonObject { ["id"] = "HighLoad", ["name"] = "High press load", ["enabled"] = true, ["mode"] = "high", ["setpoint"] = 80, ["deadband"] = 2, ["priority"] = 2, ["message"] = "Inspect the press load; this is an example threshold." });
        return field;
    }
    private static JsonObject Oee() => new()
    {
        ["path"] = "OEE", ["kind"] = "expression", ["dataType"] = "Double", ["unit"] = "%", ["unitSystem"] = "ucum",
        ["range"] = new JsonObject { ["low"] = 0, ["high"] = 100 }, ["expression"] = "availability * performance * quality / 10000",
        ["inputs"] = new JsonObject { ["availability"] = "./Availability", ["performance"] = "./Performance", ["quality"] = "./Quality" }
    };
}
