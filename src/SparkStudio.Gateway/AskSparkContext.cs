using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Reduce repeated application data on the wire without changing signed model history.</summary>
public static class AskSparkContext
{
    public static JsonObject ModelWorkspace(JsonObject context)
    {
        var result = new JsonObject();
        foreach (var key in new[] { "modelView", "modelType", "modelDraftSummary" })
        {
            if (context[key] is null) continue;
            if (context[key] is not JsonValue value || !value.TryGetValue<string>(out var text) || text.Length > 512)
                throw new ArgumentException("Assistant model context text must contain at most 512 characters.");
            result[key] = text;
        }
        foreach (var key in new[] { "modelSelection", "modelResolution" })
        {
            if (context[key] is null) continue;
            if (context[key] is not JsonArray items || items.Count > 100 || items.Any(item =>
                item is not JsonValue value || !value.TryGetValue<string>(out var text) || text.Length > 512))
                throw new ArgumentException("Assistant model context lists allow at most 100 strings of 512 characters.");
            result[key] = items.DeepClone();
        }
        return result;
    }

    public static JsonArray ForProvider(JsonArray contents, IReadOnlyList<AskSparkTool> declarations)
    {
        var copy = AskSparkToolImages.ForProvider(contents);
        var loaded = declarations.ToDictionary(tool => tool.Name, StringComparer.Ordinal);
        foreach (var content in copy.OfType<JsonObject>())
        {
            if (content["role"]?.GetValue<string>() != "user" || content["parts"] is not JsonArray parts) continue;
            foreach (var part in parts.OfType<JsonObject>())
            {
                if (part["functionResponse"] is not JsonObject response || response["name"]?.GetValue<string>() != "find_tools"
                    || response["response"]?["result"] is not JsonObject result || result.ContainsKey("error")
                    || result["tools"] is not JsonArray tools) continue;
                CompactDefinitions(tools, loaded);
            }
        }
        return copy;
    }

    private static void CompactDefinitions(JsonArray definitions, Dictionary<string, AskSparkTool> loaded)
    {
        foreach (var definition in definitions.OfType<JsonObject>())
        {
            if (definition["name"] is not JsonValue name || !name.TryGetValue<string>(out var toolName)
                || !loaded.TryGetValue(toolName, out var tool)
                || !JsonNode.DeepEquals(definition["parameters"], tool.Parameters)
                || !JsonNode.DeepEquals(definition["description"], JsonValue.Create(tool.Description))) continue;
            // The exact complete definition is already present in this request's declarations
            // (or its explicit cache). Keep discovery/permission metadata and the paired receipt.
            definition.Remove("parameters");
            definition.Remove("description");
            definition["definitionSource"] = "Complete description and parameters are in the currently loaded function declaration.";
        }
    }
}
