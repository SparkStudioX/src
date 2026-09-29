using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Explicit operator navigation, shared by draft saves, publication and portable packages.</summary>
internal static class ProjectNavigation
{
    public static void Validate(JsonObject project, JsonArray screens)
    {
        // Older projects deliberately retain no navigation object. The runtime
        // starts their first regular screen without inventing a menu of resources.
        if (!project.ContainsKey("navigation")) return;
        if (project["navigation"] is not JsonObject navigation)
            throw new ArgumentException("Project navigation must be an object.");
        Only(navigation, ["startupScreenId", "mode", "items"], "Project navigation");
        var regularScreens = screens.OfType<JsonObject>()
            .Where(screen => ProjectTemplates.ScreenKind(screen) == "screen")
            .Select(screen => screen["id"]!.GetValue<string>()).ToHashSet(StringComparer.Ordinal);
        var startup = Text(navigation, "startupScreenId");
        if (!regularScreens.Contains(startup))
            throw new ArgumentException("The startup screen must reference an existing regular screen.");
        var mode = Text(navigation, "mode");
        if (mode is not ("none" or "menu"))
            throw new ArgumentException("Navigation mode must be none or menu.");
        if (navigation["items"] is not JsonArray items || items.Count > 100)
            throw new ArgumentException("Navigation items must be an array containing at most 100 destinations.");
        var destinations = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in items)
        {
            if (node is not JsonObject item)
                throw new ArgumentException("Every navigation item must be an object.");
            Only(item, ["screenId", "label"], "Navigation item");
            var screenId = Text(item, "screenId");
            if (!regularScreens.Contains(screenId))
                throw new ArgumentException("Every navigation destination must reference an existing regular screen.");
            if (!destinations.Add(screenId))
                throw new ArgumentException("Navigation destinations must be unique.");
            var label = Text(item, "label");
            if (label.Length > 120 || label.Any(char.IsControl))
                throw new ArgumentException("Navigation labels must contain 1 to 120 characters without control characters.");
        }
    }

    private static string Text(JsonObject value, string key) => value[key] is JsonValue scalar &&
        scalar.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text)
        ? text : throw new ArgumentException($"Navigation {key} must be a nonempty string.");

    private static void Only(JsonObject value, string[] allowed, string description)
    {
        if (value.Any(pair => !allowed.Contains(pair.Key, StringComparer.Ordinal)))
            throw new ArgumentException($"{description} contains an unsupported property.");
    }
}
