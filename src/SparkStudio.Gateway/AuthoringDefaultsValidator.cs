using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Authoring-only defaults never resize existing saved documents.</summary>
internal static class AuthoringDefaultsValidator
{
    private static readonly string[] Keys = ["screenWidth", "screenHeight", "templateWidth", "templateHeight", "gridSize"];

    public static void ValidateProject(JsonObject project)
    {
        if (!project.ContainsKey("authoringDefaults")) return;
        if (project["authoringDefaults"] is not JsonObject settings || settings.Count != Keys.Length || settings.Any(pair => !Keys.Contains(pair.Key, StringComparer.Ordinal)))
            throw new ArgumentException("Authoring defaults must contain only the four document dimensions and grid size.");
        foreach (var key in Keys)
        {
            if (settings[key] is not JsonValue scalar || !scalar.TryGetValue<double>(out var number) || !double.IsFinite(number) || number != Math.Truncate(number) || number < (key == "gridSize" ? 0 : 1) || number > (key == "gridSize" ? 128 : 8192))
                throw new ArgumentException(key == "gridSize" ? "Grid size must be a whole number from 0 to 128 pixels." : "Document dimensions must be whole numbers from 1 to 8,192 pixels.");
        }
    }
}
