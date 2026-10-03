using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public static class AskSparkProjectNavigation
{
    public static AskSparkTool Declaration() => new("spark_open_project",
        "Open a permitted project in the live Designer workspace and wait for its editor bridge. Optionally open a screen or template by its stable document ID (documentKind defaults to screen). This is real application navigation, not a link. Invoke it as the only browser tool in its round, then use the returned context and latest snapshotToken. Existing unsaved-change protection still applies.",
        new JsonObject
        {
            ["type"] = "object", ["properties"] = new JsonObject
            {
                ["projectId"] = new JsonObject { ["type"] = "string", ["pattern"] = "^[a-z][a-z0-9-]{0,63}$", ["maxLength"] = 64 },
                ["documentId"] = new JsonObject { ["type"] = "string", ["minLength"] = 1, ["maxLength"] = 128 },
                ["documentKind"] = new JsonObject { ["type"] = "string", ["enum"] = new JsonArray("screen", "template"), ["default"] = "screen" }
            },
            ["required"] = new JsonArray("projectId"), ["additionalProperties"] = false
        }, "core", "read", "gateway", "signedIn", false, false);
}
