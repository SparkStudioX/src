using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Authored pane identities reuse the template path boundary; browser layout state grants no authority.</summary>
internal static class ViewContainerValidator
{
    private static readonly Regex Identity = new(@"\A[A-Za-z][A-Za-z0-9_-]{0,63}\z", RegexOptions.CultureInvariant);
    public static void Validate(string type, JsonNode? node)
    {
        if (type != "viewContainer")
        {
            if (node is JsonObject other && other.ContainsKey("viewLayout")) throw new ArgumentException("Only view containers support viewLayout.");
            return;
        }
        if (node is not JsonObject props || props["viewLayout"] is not JsonObject layout || layout.Any(pair => pair.Key is not ("kind" or "panes" or "initialPaneId" or "orientation" or "ratio")))
            throw new ArgumentException("View containers need a layout with pane definitions.");
        if (props.Any(pair => pair.Key is "templateId" or "parameters" or "parameterBindings" or "rows" or "rowsSource")) throw new ArgumentException("Configure template references and parameter overrides on each container pane.");
        var kind = Text(layout, "kind", 16);
        if (kind is not ("embedded" or "tabs" or "split" or "dock")) throw new ArgumentException("View layout must be embedded, tabs, split, or dock.");
        if (layout["panes"] is not JsonArray panes || panes.Count is < 1 or > 16 || kind == "embedded" && panes.Count != 1 || kind == "split" && panes.Count != 2 || kind == "dock" && panes.Count > 5)
            throw new ArgumentException("Embedded views need one pane, splits two, tabs 1–16, and docks a center plus up to four sides.");
        if (layout.ContainsKey("orientation") && (kind != "split" || Text(layout, "orientation", 16) is not ("horizontal" or "vertical"))) throw new ArgumentException("Only splits support horizontal or vertical orientation.");
        if (layout.ContainsKey("ratio")) { if (kind != "split") throw new ArgumentException("Only splits support a ratio."); Number(layout, "ratio", 10, 90); }
        var ids = new HashSet<string>(StringComparer.Ordinal); var edges = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in panes)
        {
            if (entry is not JsonObject pane || pane.Any(pair => pair.Key is not ("id" or "label" or "templateId" or "parameters" or "edge" or "size" or "initiallyOpen"))) throw new ArgumentException("Pane definitions contain unsupported fields.");
            var id = Text(pane, "id", 64);
            if (!Identity.IsMatch(id) || !ids.Add(id)) throw new ArgumentException("Pane IDs must be unique identifiers beginning with a letter.");
            Text(pane, "label", 120); Text(pane, "templateId", 256);
            if (pane.ContainsKey("parameters"))
            {
                var parameters = ProjectTemplates.StringParameters(pane["parameters"], "Pane overrides");
                if (parameters.Count > 64 || parameters.Any(pair => pair.Key.Length > 256 || pair.Value!.GetValue<string>().Length > 4096)) throw new ArgumentException("Pane overrides support at most 64 names and text values up to 4,096 characters.");
            }
            if (kind == "dock")
            {
                var edge = Text(pane, "edge", 16);
                if (edge is not ("center" or "left" or "right" or "top" or "bottom") || !edges.Add(edge)) throw new ArgumentException("Dock edges must be unique center, left, right, top, or bottom.");
                if (pane.ContainsKey("initiallyOpen") && (edge == "center" || pane["initiallyOpen"] is not JsonValue flag || !flag.TryGetValue<bool>(out _))) throw new ArgumentException("Only side docks support a Boolean initial open state.");
                if (pane.ContainsKey("size")) { if (edge == "center") throw new ArgumentException("The center dock fills remaining space."); Number(pane, "size", 80, 1600); }
            }
            else if (pane.Any(pair => pair.Key is "edge" or "size" or "initiallyOpen")) throw new ArgumentException("Dock settings belong only to dock panes.");
        }
        if (kind == "dock" && !edges.Contains("center")) throw new ArgumentException("A dock needs one center pane.");
        if (layout.ContainsKey("initialPaneId") && (kind != "tabs" || !ids.Contains(Text(layout, "initialPaneId", 64)))) throw new ArgumentException("The initial tab must name a saved pane.");
    }
    public static IEnumerable<JsonObject> Placements(JsonObject component)
    {
        var type = ProjectStore.Optional(component, "type");
        if (type is "template" or "repeater") { yield return component; yield break; }
        if (type != "viewContainer") yield break;
        foreach (var pane in component["props"]?["viewLayout"]?["panes"]?.AsArray().OfType<JsonObject>() ?? []) yield return Placement(component, pane);
    }
    public static JsonObject ResolvePlacement(JsonObject component, string? paneId)
    {
        if (string.IsNullOrEmpty(paneId)) throw new ArgumentException("A container action requires a saved pane ID.");
        var pane = component["props"]?["viewLayout"]?["panes"]?.AsArray().OfType<JsonObject>().FirstOrDefault(pane => ProjectStore.Optional(pane, "id") == paneId)
            ?? throw new KeyNotFoundException("Published container pane not found.");
        return Placement(component, pane);
    }
    private static JsonObject Placement(JsonObject component, JsonObject pane) => new()
    {
        ["id"] = ProjectStore.Required(component, "id"), ["type"] = "template",
        ["props"] = new JsonObject { ["templateId"] = pane["templateId"]?.DeepClone(), ["parameters"] = pane["parameters"]?.DeepClone() ?? new JsonObject() }
    };
    private static string Text(JsonObject value, string key, int maximum) => value[key] is JsonValue scalar && scalar.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text) && text.Length <= maximum
        ? text : throw new ArgumentException($"Container {key} needs nonempty text up to {maximum} characters.");
    private static void Number(JsonObject owner, string key, double min, double max)
    {
        if (owner[key] is not JsonValue scalar || !scalar.TryGetValue<double>(out var value) || !double.IsFinite(value) || value < min || value > max) throw new ArgumentException($"Container {key} must be between {min} and {max}.");
    }
}
