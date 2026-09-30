using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Project Publish is not authority to introduce service-account or same-origin code.</summary>
public static class ExecutablePublication
{
    public static void RequireAllowed(JsonObject? previous, JsonObject candidate, bool allowExecutableChanges)
    {
        if (!allowExecutableChanges && Changed(previous, candidate))
            throw new BadHttpRequestException("A gateway administrator must approve publication or restoration of changed Python or JavaScript. Project Publish permits layout and data changes that do not change executable resources.", 403);
    }

    public static bool Changed(JsonObject? previous, JsonObject candidate)
        => !JsonNode.DeepEquals(Capture(previous), Capture(candidate));

    private static JsonObject Capture(JsonObject? snapshot)
    {
        var result = new JsonObject();
        if (snapshot is null) return result;
        var executable = new JsonObject();
        CaptureCode(snapshot["project"], "project", executable);
        if (snapshot["scripts"] is JsonObject scripts && scripts["resources"] is JsonArray resources)
        {
            // Include schedules, enabled flags and parameter defaults, not only source text.
            foreach (var resource in resources.OfType<JsonObject>().OrderBy(item => ProjectStore.Optional(item, "id"), StringComparer.Ordinal))
                executable["resource:" + ProjectStore.Required(resource, "id")] = resource.DeepClone();
        }
        if (executable.Count == 0) return result;
        result["executable"] = executable;
        // Queries can be invoked from trusted Python. Changing one can change that code's effects.
        var queries = new JsonObject();
        if ((snapshot["scriptQueries"] ?? snapshot["queries"]) is JsonArray definitions)
            foreach (var query in definitions.OfType<JsonObject>())
                queries[ProjectStore.Required(query, "id")] = query.DeepClone();
        result["queries"] = queries;
        return result;
    }

    private static void CaptureCode(JsonNode? node, string path, JsonObject result)
    {
        if (node is JsonObject obj)
        {
            if (obj.Any(pair => pair.Key is "code" or "script" && pair.Value is JsonValue value && value.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text)))
            {
                // The nearest executable definition also carries language, triggers and enabled state.
                // For button props this intentionally includes action parameters and targets.
                result[path] = obj.DeepClone();
                return;
            }
            foreach (var pair in obj.OrderBy(pair => pair.Key, StringComparer.Ordinal))
                CaptureCode(pair.Value, path + "/property:" + Escape(pair.Key), result);
        }
        else if (node is JsonArray array)
            for (var index = 0; index < array.Count; index++)
            {
                var identity = array[index] is JsonObject child && child["id"] is JsonValue id && id.TryGetValue<string>(out var key)
                    ? "id:" + Escape(key) : "index:" + index.ToString(System.Globalization.CultureInfo.InvariantCulture);
                CaptureCode(array[index], path + "/" + identity, result);
            }
    }

    private static string Escape(string segment) => segment.Replace("~", "~0", StringComparison.Ordinal).Replace("/", "~1", StringComparison.Ordinal);
}
