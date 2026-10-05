using System.Text.Json.Nodes;
using SparkStudio.Gateway;

/// <summary>Large reviewed tool arguments fit in one call while every request stays bounded.</summary>
internal static class AskSparkLimitChecks
{
    public static int Run()
    {
        var passed = 0;
        void Check(bool condition, string name) { if (!condition) throw new InvalidOperationException("Ask Spark limit check failed: " + name); passed++; }
        var schema = new JsonObject { ["type"] = "object", ["additionalProperties"] = false, ["properties"] = new JsonObject { ["packageJson"] = new JsonObject { ["type"] = "string", ["maxLength"] = 400_000 } } };
        AskSparkSchema.Validate(new JsonObject { ["packageJson"] = new string('x', 300_000) }, schema);
        Check(true, "a 300 KB model package argument is accepted");
        try { AskSparkSchema.Validate(new JsonObject { ["packageJson"] = new string('x', 450_000) }, schema); Check(false, "schema maxLength still bounds strings"); }
        catch (ArgumentException) { passed++; }
        var unbounded = new JsonObject { ["type"] = "object", ["additionalProperties"] = false, ["properties"] = new JsonObject { ["items"] = new JsonObject { ["type"] = "array", ["maxItems"] = 1000, ["items"] = new JsonObject { ["type"] = "string", ["maxLength"] = 2000 } } } };
        var huge = new JsonArray(Enumerable.Range(0, 400).Select(_ => (JsonNode)JsonValue.Create(new string('y', 1500))).ToArray());
        try { AskSparkSchema.Validate(new JsonObject { ["items"] = huge }, unbounded); Check(false, "total arguments above 512 KiB are rejected"); }
        catch (ArgumentException error) { Check(error.Message.Contains("512 KiB", StringComparison.Ordinal), "total arguments above 512 KiB are rejected"); }
        Check(AskSparkSchema.MaximumArgumentCharacters == 524_288 && AskSparkGemini.OutputTokenLimit == 32_768, "argument and output limits match the documented values");
        return passed;
    }
}
