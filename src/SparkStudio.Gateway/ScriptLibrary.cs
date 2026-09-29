using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Detached library sources captured from one script publication.</summary>
public static class ScriptLibrary
{
    public static IReadOnlyDictionary<string, string> Capture(JsonObject? publication) =>
        ScriptResourceStore.Resources(publication)
            .Where(resource => ProjectStore.Required(resource, "type") == "library" && ScriptResourceStore.Enabled(resource))
            .ToDictionary(resource => ProjectStore.Required(resource, "name"), resource => ProjectStore.Optional(resource, "code") ?? "", StringComparer.Ordinal);
}
