using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Reusable appearance only; styles cannot carry actions, visibility or access authority.</summary>
internal static class ProjectStyleValidator
{
    private static readonly HashSet<string> Properties = new(StringComparer.Ordinal)
        { "color", "backgroundColor", "foregroundColor", "borderColor", "borderWidth", "fontSize" };
    private static readonly Regex Id = new("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\\z", RegexOptions.CultureInvariant);
    private static readonly Regex Color = new("^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\\z", RegexOptions.CultureInvariant);

    public static void ValidateProject(JsonObject project)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        if (project.ContainsKey("styles"))
        {
            if (project["styles"] is not JsonArray styles || styles.Count > 100)
                throw new ArgumentException("A project can contain at most 100 visual styles.");
            foreach (var node in styles)
            {
                if (node is not JsonObject style || style.Any(pair => pair.Key is not ("id" or "name" or "properties")))
                    throw new ArgumentException("Every style needs only an ID, name and properties.");
                if (!Text(style["id"], out var id) || !Id.IsMatch(id) || !ids.Add(id))
                    throw new ArgumentException("Style IDs must be unique, 1–64 letters, numbers, dashes or underscores, beginning with a letter or number.");
                if (!Text(style["name"], out var name) || string.IsNullOrWhiteSpace(name) || name.Trim() != name || name.Length > 80 || name.Any(char.IsControl))
                    throw new ArgumentException("Style names need 1–80 characters without outer whitespace or control characters.");
                if (style["properties"] is not JsonObject properties || properties.Count == 0 || properties.Any(pair => !Properties.Contains(pair.Key)))
                    throw new ArgumentException("Styles need at least one supported appearance property.");
                foreach (var (key, value) in properties)
                {
                    if (key is "fontSize" or "borderWidth")
                    {
                        if (value is not JsonValue number || !number.TryGetValue<double>(out var size) || !double.IsFinite(size) || size < (key == "fontSize" ? 1 : 0) || size > (key == "fontSize" ? 256 : 32))
                            throw new ArgumentException($"Style {key} is outside its supported range.");
                    }
                    else if (!Text(value, out var color) || !Color.IsMatch(color))
                        throw new ArgumentException($"Style {key} must be a hexadecimal color.");
                }
            }
        }
        foreach (var component in ProjectTemplates.Components(project))
        {
            if (component["props"] is JsonObject props && props.ContainsKey("styleId") &&
                (!Text(props["styleId"], out var styleId) || !ids.Contains(styleId)))
                throw new ArgumentException("An assigned visual style is missing. Remove its component assignments before deleting the style.");
        }
    }

    private static bool Text(JsonNode? node, out string value)
    {
        value = "";
        return node is JsonValue scalar && scalar.TryGetValue<string>(out value!);
    }
}
