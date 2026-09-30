using System.Text.Json.Nodes;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SparkStudio.Gateway;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record InstancePathStep(string InstanceId, string? RowId = null);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record PopupOrigin(string ScreenId, string ComponentId, string? InstanceId = null, string? RowId = null,
    IReadOnlyList<InstancePathStep>? InstancePath = null, IReadOnlyList<Dictionary<string, JsonElement>>? BindingInputs = null,
    IReadOnlyList<ParameterBindingState>? BindingState = null);

internal static class ProjectInteractions
{
    public static readonly HashSet<string> Icons = new(StringComparer.Ordinal)
    {
        "spark", "grid", "design", "plug", "database", "code", "settings", "arrow", "down", "plus", "close", "check", "play", "stop", "save", "monitor", "layers", "tag", "search", "text", "value", "gauge", "button", "table", "folder", "trash", "copy", "refresh", "external", "link", "move", "undo", "info", "clock", "shield", "upload", "download", "activity", "worker", "forklift", "warehouse", "pallet", "route", "drawing-line", "drawing-rectangle", "drawing-ellipse", "drawing-polyline", "drawing-pipe", "equipment-symbol"
    };

    public static void ValidateButton(JsonObject props, IReadOnlyDictionary<string, JsonObject> screens)
    {
        var action = ProjectStore.Optional(props, "action") ?? "navigate";
        if (action is "navigate" or "openPopup")
        {
            if (!screens.TryGetValue(ProjectStore.Required(props, "targetScreenId"), out var target))
                throw new ArgumentException("Every navigation or popup button must reference an existing screen.");
            var expected = action == "openPopup" ? "popup" : "screen";
            if (ProjectTemplates.ScreenKind(target) != expected)
                throw new ArgumentException($"The {action} target must be a {expected} screen.");
            if (props.ContainsKey("parameters"))
            {
                var overrides = ProjectTemplates.StringParameters(props["parameters"], "Popup parameter overrides");
                if (action == "navigate" && overrides.Count > 0) throw new ArgumentException("Regular navigation uses the target screen's saved defaults; parameter overrides are supported only for openPopup.");
                var declared = ProjectTemplates.ScreenParameters(target);
                if (overrides.Any(pair => !declared.ContainsKey(pair.Key))) throw new ArgumentException("Popup overrides may name only parameters declared by the target popup.");
            }
        }
        else if (action == "script")
        {
            if (ProjectStore.Required(props, "script").Length > 65536) throw new ArgumentException("Button scripts are limited to 64 KB.");
        }
        else if (action == "message") ComponentEventValidator.ValidateMessageAction(props["message"]);
        else if (action != "closePopup") throw new ArgumentException("Button action must be navigate, script, openPopup, closePopup or message.");
    }

    public static void ValidateDrawingActions(JsonObject project)
    {
        var screens = project["screens"]!.AsArray().OfType<JsonObject>().ToDictionary(screen => ProjectStore.Required(screen, "id"), StringComparer.Ordinal);
        foreach (var symbol in ProjectTemplates.Components(project).Where(component => ProjectStore.Optional(component, "type") == "equipmentSymbol"))
            if (symbol["props"] is JsonObject props && props.ContainsKey("action")) ValidateButton(props, screens);
    }

    public static void ValidatePlacement(JsonObject document, JsonObject screen, JsonObject context, IReadOnlyDictionary<string, JsonObject> screens)
    {
        foreach (var button in document["components"]!.AsArray().OfType<JsonObject>().Where(item =>
            ProjectStore.Optional(item, "type") == "button" || ProjectStore.Optional(item, "type") == "equipmentSymbol" && item["props"] is JsonObject symbol && symbol.ContainsKey("action")))
        {
            if (button["props"] is not JsonObject props) throw new ArgumentException("Every published button needs a properties object.");
            ValidateButton(props, screens);
            var action = ProjectStore.Optional(props, "action") ?? "navigate";
            if (action == "openPopup")
            {
                if (ProjectTemplates.ScreenKind(screen) == "popup") throw new ArgumentException("Opening a popup from another popup is not supported.");
                if (props["parameters"] is JsonObject parameters) ProjectTemplates.ValidateReferences(parameters, context);
            }
            else if (action == "closePopup" && ProjectTemplates.ScreenKind(screen) != "popup")
                throw new ArgumentException("A closePopup button can be placed only on a popup screen.");
        }
    }

    public static (JsonObject Component, JsonObject Scope, JsonArray TemplateScopes) ResolveLeaf(JsonObject project, JsonObject screen,
        string componentId, string? instanceId, string? rowId, IReadOnlyList<InstancePathStep>? instancePath = null)
    {
        if (instancePath is not null && (instanceId is not null || rowId is not null))
            throw new ArgumentException("Use instancePath or legacy instanceId and rowId, not both.");
        if (instancePath is not null && instancePath.Count is < 1 or > ProjectTemplates.MaximumInstanceDepth)
            throw new ArgumentException("An instancePath must contain between 1 and 4 instance steps.");
        if (instancePath is null && instanceId is null && rowId is not null)
            throw new ArgumentException("A row ID requires a repeater instance ID.");
        var path = instancePath ?? (instanceId is null ? [] : new[] { new InstancePathStep(instanceId, rowId) });
        var scope = screen;
        var scopes = new JsonArray();
        var visited = new HashSet<string>(StringComparer.Ordinal);
        foreach (var step in path)
        {
            var parent = scope;
            if (step is null || string.IsNullOrWhiteSpace(step.InstanceId)) throw new ArgumentException("Every instance path step needs a nonempty template instance ID.");
            var instance = scope["components"]!.AsArray().OfType<JsonObject>().FirstOrDefault(component => ProjectStore.Optional(component, "id") == step.InstanceId)
                ?? throw new KeyNotFoundException("Published template instance not found.");
            var kind = ProjectStore.Required(instance, "type");
            if (kind is not ("template" or "repeater")) throw new ArgumentException("The selected component is not a template instance or repeater.");
            var templateId = ProjectStore.Required(instance["props"]!.AsObject(), "templateId");
            if (!visited.Add(templateId)) throw new ArgumentException("Template instance paths cannot contain a template cycle.");
            scope = ProjectTemplates.Templates(project).FirstOrDefault(template => ProjectStore.Optional(template, "id") == templateId)
                ?? throw new KeyNotFoundException("Published template not found.");
            JsonObject? row = null;
            JsonObject? rowsSource = null;
            if (kind == "repeater")
            {
                if (instance["props"]!["rowsSource"] is JsonObject source)
                {
                    if (scopes.Count != 0) throw new ArgumentException("Query-backed repeaters are supported only at a screen's root.");
                    QueryRepeaterSource.ValidateRowId(step.RowId);
                    rowsSource = source.DeepClone().AsObject();
                }
                else
                {
                    if (string.IsNullOrWhiteSpace(step.RowId)) throw new ArgumentException("A repeater action requires a saved row ID.");
                    row = instance["props"]!["rows"]!.AsArray().OfType<JsonObject>().FirstOrDefault(item => ProjectStore.Optional(item, "id") == step.RowId)
                        ?? throw new KeyNotFoundException("Published repeater row not found.");
                }
            }
            else if (step.RowId is not null) throw new ArgumentException("A row ID is valid only for a repeater action.");
            var captured = new JsonObject
            {
                ["templateParameters"] = ProjectTemplates.MergeParameters(scope, instance, null),
                ["rowParameters"] = row?["parameters"]?.DeepClone(),
                ["templateParameterTypes"] = scope["parameterTypes"]?.DeepClone(),
                ["rowsSource"] = rowsSource,
                ["rowId"] = rowsSource is null ? null : step.RowId
            };
            TemplateParameterBindings.Capture(captured, project, screen, parent, instance);
            scopes.Add(captured);
        }
        var leaf = scope["components"]!.AsArray().OfType<JsonObject>().FirstOrDefault(component => ProjectStore.Optional(component, "id") == componentId)
            ?? throw new KeyNotFoundException("Published component not found.");
        return (leaf, scope, scopes);
    }
}
