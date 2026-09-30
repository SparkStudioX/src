using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Operators use an explicitly published, persisted snapshot of screens and named queries.</summary>
public sealed partial class PublicationStore
{
    private readonly object gate = GatewayConfigurationLock.SyncRoot;
    private readonly string path;
    private readonly LocalAssetStore assets;
    private JsonObject? publication;
    private bool hasPersistedHistory;
    private ScriptResourceStore? scripts;

    public void AttachScripts(ScriptResourceStore resources) { lock (gate) scripts = resources; }

    public PublicationStore(string dataDirectory, LocalAssetStore assets)
    {
        this.assets = assets;
        path = Path.Combine(dataDirectory, "published.json");
        if (File.Exists(path))
        {
            if (new FileInfo(path).Length > MaximumPublicationBytes) throw new InvalidOperationException("The published project exceeds its file-size limit.");
            publication = JsonNode.Parse(File.ReadAllText(path))?.AsObject()
                ?? throw new InvalidOperationException("The published project is invalid.");
            if (publication["project"] is not JsonObject publishedProject || publication["queries"] is not JsonArray ||
                publishedProject["name"] is not JsonValue name || !name.TryGetValue<string>(out _) ||
                publishedProject["revision"] is not JsonValue revision || !revision.TryGetValue<int>(out _) ||
                publication["publishedAt"] is not JsonValue stamp || !stamp.TryGetValue<string>(out var date) || !DateTimeOffset.TryParse(date, out _))
                throw new InvalidOperationException("The stored publication metadata is invalid.");
            // Running screens keep only the active application. Historical DOMs are
            // loaded on demand and weakly cached, not retained by every workspace.
            hasPersistedHistory = publication.Remove("history");
        }
    }

    public JsonObject Metadata()
    {
        lock (gate)
            return publication is null ? new JsonObject { ["published"] = false }
                : new JsonObject { ["published"] = true, ["revision"] = publication["project"]!["revision"]!.DeepClone(), ["scriptsRevision"] = publication["scripts"]?["revision"]?.DeepClone(), ["complete"] = publication["scripts"] is JsonObject && publication["legacyScriptCompatibility"]?.GetValue<bool>() != true, ["publishedAt"] = publication["publishedAt"]!.DeepClone(), ["warnings"] = PublicationWarnings() };
    }

    public JsonObject Publish(ProjectStore store, int revision, int? scriptsRevision = null, string? reviewToken = null, bool onlyWhenChanged = false, bool allowExecutableChanges = true)
    {
        JsonObject result;
        lock (gate)
        {
            if (reviewToken is not null && Review(store)["reviewToken"]!.GetValue<string>() != reviewToken)
                throw new InvalidOperationException("The saved application or active publication changed. Review the application again before publishing.");
            var snapshot = store.CapturePublication(revision);
            snapshot["scripts"] = scripts?.CaptureDraftForPublication(scriptsRevision) ?? new JsonObject { ["revision"] = 0, ["resources"] = new JsonArray() };
            ExecutablePublication.RequireAllowed(publication, snapshot, allowExecutableChanges);
            // Preserve the legacy script endpoint's retry behavior, but only when
            // every application resource is unchanged, including query definitions.
            if (onlyWhenChanged && publication is not null && publication["legacyScriptCompatibility"]?.GetValue<bool>() != true &&
                JsonNode.DeepEquals(snapshot["project"], publication["project"]) && JsonNode.DeepEquals(snapshot["scripts"], publication["scripts"]) &&
                JsonNode.DeepEquals(snapshot["queries"], publication["scriptQueries"] ?? publication["queries"])) return Metadata();
            var project = snapshot["project"]!.AsObject();
            ValidateScreens(project);
            ComponentQueryBindingValidator.ValidateQueries(project, snapshot["queries"]!.AsArray());
            TableEditValidator.ValidateQueries(project, snapshot["queries"]!.AsArray(), store);
            var referenced = ProjectTemplates.Components(project)
                .SelectMany(component => new[] { component["props"] is not JsonObject props ? null
                    : ProjectStore.Optional(component, "type") == "table" ? ProjectStore.Optional(props, "queryId")
                    : InputDefinitionValidator.IsQuerySelection(ProjectStore.Optional(component, "type")) && props["optionsSource"] is JsonObject source ? ProjectStore.Optional(source, "queryId")
                    : ProjectStore.Optional(component, "type") == "repeater" && props["rowsSource"] is JsonObject rowsSource ? ProjectStore.Optional(rowsSource, "queryId") : null }
                    .Concat(ComponentQueryBindingValidator.Bindings(component).Select(binding => ProjectStore.Optional(binding, "queryId"))))
                .Where(id => !string.IsNullOrWhiteSpace(id)).ToHashSet(StringComparer.Ordinal);
            var queries = snapshot["queries"]!.AsArray().OfType<JsonObject>().Where(query => referenced.Contains(ProjectStore.Optional(query, "id"))).ToArray();
            if (queries.Length != referenced.Count)
                throw new ArgumentException("Every table, query-backed selection, query-backed repeater and property query binding must reference an existing named query before publishing.");
            if (queries.Any(query => ProjectStore.Optional(query, "kind") == "update"))
                throw new ArgumentException("Tables, query-backed selections, query-backed repeaters and property query bindings require read queries, not update queries.");
            snapshot["scriptQueries"] = snapshot["queries"]!.DeepClone();
            snapshot["queries"] = new JsonArray(queries.Select(query => query.DeepClone()).ToArray());
            snapshot["publishedAt"] = DateTimeOffset.UtcNow.ToString("O");
            snapshot["schemaVersion"] = 2;
            CommitWithHistory(snapshot);
            result = Metadata();
        }
        scripts?.NotifyPublished();
        return result;
    }

    private void ValidateScreens(JsonObject project)
    {
        ProjectStore.Required(project, "name");
        ProjectTemplates.ValidateStructure(project);
        ProjectTemplates.ValidateComposition(project);
        var screens = project["screens"]!.AsArray().OfType<JsonObject>().ToArray();
        var screenIds = screens.ToDictionary(screen => ProjectStore.Required(screen, "id"), StringComparer.Ordinal);
        foreach (var screen in ProjectTemplates.Documents(project))
        {
            ProjectStore.Required(screen, "name");
            Dimension(screen, "width", 1); Dimension(screen, "height", 1);
            foreach (var component in screen["components"]!.AsArray().OfType<JsonObject>())
            {
                Dimension(component, "x", 0); Dimension(component, "y", 0);
                Dimension(component, "width", 1); Dimension(component, "height", 1);
                if (component["props"] is not JsonObject props) throw new ArgumentException("Every published component needs a properties object.");
                var type = ProjectStore.Required(component, "type");
                if (type == "button")
                    ProjectInteractions.ValidateButton(props, screenIds);
                if (type == "image")
                {
                    if (!assets.Contains(ProjectStore.Required(props, "assetId"))) throw new ArgumentException("Every published image must reference an uploaded local asset.");
                    if ((ProjectStore.Optional(props, "fit") ?? "contain") is not ("contain" or "cover" or "fill")) throw new ArgumentException("Image fit must be contain, cover or fill.");
                    if ((ProjectStore.Optional(props, "alt") ?? "").Length > 4096) throw new ArgumentException("Image alternate text is limited to 4096 characters.");
                    if (props.ContainsKey("src") || props.ContainsKey("url")) throw new ArgumentException("Images use local asset IDs; remote URLs are not supported.");
                }
                if (type == "icon" && !ProjectInteractions.Icons.Contains(ProjectStore.Required(props, "icon"))) throw new ArgumentException("Choose one of the built-in icon names.");
                if (type == "table") ProjectStore.Required(props, "queryId");
            }
        }
        if (project["parameters"] is not JsonObject parameters || parameters.Any(pair => pair.Value is not JsonValue value || !value.TryGetValue<string>(out _)))
            throw new ArgumentException("Published context parameters must be an object containing text values.");
    }

    private static void Dimension(JsonObject node, string key, double minimum)
    {
        if (node[key] is not JsonValue value || !value.TryGetValue<double>(out var number) || !double.IsFinite(number) || number < minimum || number > 8192)
            throw new ArgumentException($"Published {key} must be a number between {minimum} and 8192.");
    }

    private JsonObject RequirePublication() => publication ?? throw new KeyNotFoundException("No project is published. Save and publish a project from the designer first.");

    private JsonObject RequirePublication(string? publishedAt)
    {
        var current = RequirePublication();
        if (publishedAt is not null && current["publishedAt"]!.GetValue<string>() != publishedAt)
            throw new InvalidOperationException("A new version is published. Load the new version before reading this application's data.");
        return current;
    }

    public JsonObject GetProject()
    {
        lock (gate)
        {
            var current = RequirePublication();
            var result = current["project"]!.DeepClone().AsObject();
            foreach (var component in ProjectTemplates.Components(result))
                if (component["props"] is JsonObject props)
                {
                    props.Remove("script");
                    if (props["tableEdit"] is JsonObject edit) edit.Remove("script");
                    PythonComponentEvents.HideSources(props);
                }
            result["publishedAt"] = current["publishedAt"]!.DeepClone();
            return result;
        }
    }

    public JsonObject GetAction(string screenId, string componentId, string publishedAt, string? instanceId = null, string? rowId = null, PopupOrigin? popupOrigin = null, IReadOnlyList<InstancePathStep>? instancePath = null)
        => GetExecutable(false, screenId, componentId, publishedAt, instanceId, rowId, popupOrigin, instancePath);

    public JsonObject GetTableEdit(string screenId, string componentId, string publishedAt, string? instanceId = null, string? rowId = null, PopupOrigin? popupOrigin = null, IReadOnlyList<InstancePathStep>? instancePath = null)
        => GetExecutable(true, screenId, componentId, publishedAt, instanceId, rowId, popupOrigin, instancePath);

    private JsonObject GetExecutable(bool tableEdit, string screenId, string componentId, string publishedAt, string? instanceId, string? rowId, PopupOrigin? popupOrigin, IReadOnlyList<InstancePathStep>? instancePath)
    {
        lock (gate)
        {
            var current = RequirePublication();
            if (current["publishedAt"]!.GetValue<string>() != publishedAt)
                throw new InvalidOperationException("A new version is published. Load the new version before running this action.");
            var project = current["project"]!.AsObject();
            var screen = project["screens"]!.AsArray().OfType<JsonObject>().FirstOrDefault(screen => ProjectStore.Optional(screen, "id") == screenId)
                ?? throw new KeyNotFoundException("Published screen not found.");
            JsonObject? opener = null;
            if (ProjectTemplates.ScreenKind(screen) == "popup")
            {
                if (popupOrigin is null || string.IsNullOrWhiteSpace(popupOrigin.ScreenId) || string.IsNullOrWhiteSpace(popupOrigin.ComponentId))
                    throw new ArgumentException("Popup actions require their published opener identity.");
                var originScreen = project["screens"]!.AsArray().OfType<JsonObject>().FirstOrDefault(item => ProjectStore.Optional(item, "id") == popupOrigin.ScreenId)
                    ?? throw new KeyNotFoundException("Published popup opener screen not found.");
                if (ProjectTemplates.ScreenKind(originScreen) != "screen") throw new ArgumentException("A popup opener must belong to a regular screen.");
                var origin = ProjectInteractions.ResolveLeaf(project, originScreen, popupOrigin.ComponentId, popupOrigin.InstanceId, popupOrigin.RowId, popupOrigin.InstancePath);
                if (ProjectStore.Optional(origin.Component, "type") is not ("button" or "equipmentSymbol") || origin.Component["props"] is not JsonObject originProps ||
                    ProjectStore.Optional(originProps, "action") != "openPopup" || ProjectStore.Optional(originProps, "targetScreenId") != screenId)
                    throw new ArgumentException("The published opener does not open this popup.");
                opener = new JsonObject
                {
                    ["screenParameters"] = ProjectTemplates.ScreenParameters(originScreen).DeepClone(),
                    ["templateScopes"] = origin.TemplateScopes,
                    ["parameters"] = originProps["parameters"]?.DeepClone() ?? new JsonObject()
                };
            }
            else if (popupOrigin is not null) throw new ArgumentException("Regular screen actions must not include a popup opener.");
            var (component, scope, templateScopes) = ProjectInteractions.ResolveLeaf(project, screen, componentId, instanceId, rowId, instancePath);
            if (component["props"] is not JsonObject props || (tableEdit
                ? ProjectStore.Optional(component, "type") != "table" || props["tableEdit"] is not JsonObject
                : ProjectStore.Optional(component, "type") != "button" || ProjectStore.Optional(props, "action") != "script"))
                throw new KeyNotFoundException("This published component has no executable action.");
            var inputs = scope["components"]!.AsArray().OfType<JsonObject>().Where(item => !tableEdit && InputDefinitionValidator.IsInput(ProjectStore.Required(item, "type")))
                .Select(item =>
                {
                    var definition = new JsonObject { ["type"] = item["type"]!.DeepClone() };
                    var properties = item["props"]!.AsObject();
                    foreach (var key in new[] { "fieldKey", "defaultValue", "min", "max", "step", "options", "optionsSource", "tagPath", "validation", "formatMask", "textCase", "scanTerminator" })
                        // Browser state is never supplied by gateway defaults.
                        // Bound fields must arrive as explicit, validated inputs.
                        if (!(key == "defaultValue" && properties.ContainsKey("stateBinding")) && properties[key] is { } value)
                            definition[key] = value.DeepClone();
                    return (JsonNode)definition;
                }).ToArray();
            var result = new JsonObject { ["code"] = (tableEdit ? props["tableEdit"]!["script"] : props["script"])?.DeepClone(), ["projectParameters"] = project["parameters"]!.DeepClone(),
                ["screenParameters"] = ProjectTemplates.ScreenParameters(screen).DeepClone(), ["popupOrigin"] = opener,
                ["templateScopes"] = templateScopes, ["inputs"] = new JsonArray(inputs),
                ["queries"] = (current["scriptQueries"] ?? current["queries"])!.DeepClone(), ["libraries"] = CaptureLibraries(current) };
            if (!tableEdit) result["uiContext"] = PythonUiContext.Describe(project, screen, scope, componentId, templateScopes.Count > 0);
            if (tableEdit)
            {
                result["table"] = props.DeepClone();
                result["query"] = current["queries"]!.AsArray().OfType<JsonObject>()
                    .FirstOrDefault(query => ProjectStore.Optional(query, "id") == ProjectStore.Required(props, "queryId"))?.DeepClone()
                    ?? throw new ArgumentException("The editable table's read query is missing from this publication.");
            }
            return result;
        }
    }

    public JsonArray GetQueries(string? publishedAt = null)
    {
        lock (gate)
            return new JsonArray(RequirePublication(publishedAt)["queries"]!.AsArray().OfType<JsonObject>().Select(query => (JsonNode)new JsonObject
            {
                ["id"] = query["id"]!.DeepClone(), ["name"] = query["name"]!.DeepClone(),
                ["parameters"] = query["parameters"]?.DeepClone() ?? new JsonArray()
            }).ToArray());
    }

    public JsonObject GetQuery(string id, string? publishedAt = null)
    {
        lock (gate)
            return RequirePublication(publishedAt)["queries"]!.AsArray().OfType<JsonObject>()
                .FirstOrDefault(query => ProjectStore.Optional(query, "id") == id)?.DeepClone().AsObject()
                ?? throw new KeyNotFoundException("This query is not part of the published project.");
    }
}
