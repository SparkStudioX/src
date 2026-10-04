using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public static class AskSparkModelTools
{
    public static void RequireUserModelApply(string name, JsonObject arguments)
    {
        if (name != "tags_import_apply" || arguments["package"] is not JsonObject package) return;
        var fields = new[] { "udtDefinitions", "instances", "hierarchy", "removeUdtDefinitions", "removeInstances", "removeHierarchy" };
        if (fields.Any(field => package[field] is JsonArray { Count: > 0 }) || package["provider"]?["requireDeclaredHierarchy"] is not null)
            throw new BadHttpRequestException("Model changes must be reviewed and applied by the user in Models. Use model_draft to prepare a draft.", 403);
    }
}
