using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Bounded template graph validation and scoped parameter rules for published projects.</summary>
internal static class ProjectTemplates
{
    public const int MaximumInstanceDepth = 4;
    private const long MaximumExpandedComponents = 10000;
    private static readonly HashSet<string> ComponentTypes = new(StringComparer.Ordinal)
        { "viewContainer", "formattedInput", "barcodeInput", "equipmentCommand", "chart", "sparkline", "label", "value", "gauge", "button", "table", "textInput", "numberInput", "checkbox", "select", "list", "treeView", "template", "repeater", "image", "icon", "textArea", "spinner", "slider", "radioGroup", "dateTimeInput", "toggle", "passwordInput", "multiStateButton", "multiStateIndicator", "ledDisplay", "progressBar", "cylindricalTank", "levelIndicator", "thermometer", "line", "rectangle", "ellipse", "polyline", "pipe", "equipmentSymbol" };
    private static readonly Regex ParameterReference = new(@"\{([^{}]+)\}", RegexOptions.CultureInvariant);

    public static IEnumerable<JsonObject> Templates(JsonObject project) => project["templates"] is JsonArray templates
        ? templates.OfType<JsonObject>() : [];

    public static IEnumerable<JsonObject> Documents(JsonObject project) => project["screens"]!.AsArray().OfType<JsonObject>().Concat(Templates(project));

    public static IEnumerable<JsonObject> Components(JsonObject project) => Documents(project)
        .SelectMany(document => document["components"]!.AsArray().OfType<JsonObject>());

    public static void ValidateStructure(JsonObject project)
    {
        ComponentEventValidator.RejectMisplaced(project);
        if (project["screens"] is not JsonArray screens || screens.Count is < 1 or > 100)
            throw new ArgumentException("A project needs 1 to 100 screens.");
        ProjectStateValidator.ValidateProject(project);
        ValidateDocuments(screens, "Screen", project["parameters"] as JsonObject, project["sessionState"] as JsonObject);
        if (project.ContainsKey("templates"))
        {
            if (project["templates"] is not JsonArray templates || templates.Count > 100)
                throw new ArgumentException("Project templates must be an array containing at most 100 templates.");
            ValidateDocuments(templates, "Template", project["parameters"] as JsonObject, project["sessionState"] as JsonObject);
        }
        TemplateParameterTypes.ValidateProject(project);
        ProjectStyleValidator.ValidateProject(project);
        ProjectLocalizationValidator.ValidateProject(project);
        AuthoringDefaultsValidator.ValidateProject(project);
        TemplateParameterBindings.ValidateProject(project);
        ComponentQueryBindingValidator.ValidateProject(project);
        DatasetBindingValidator.ValidateProject(project);
        QueryRepeaterSource.ValidateStructure(project);
        ProjectNavigation.Validate(project, screens);
        ProjectInteractions.ValidateDrawingActions(project);
        EquipmentCommandDefinitions.Validate(project);
    }

    private static void ValidateDocuments(JsonArray documents, string kind, JsonObject? projectParameters, JsonObject? sessionState)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in documents)
        {
            if (node is not JsonObject document) throw new ArgumentException($"Every {kind.ToLowerInvariant()} must be an object.");
            ProjectStateValidator.ValidateDocument(document, kind == "Template");
            if (!ids.Add(RequiredText(document, "id"))) throw new ArgumentException($"{kind} IDs must be unique.");
            if (document["components"] is not JsonArray components || components.Count > 500)
                throw new ArgumentException($"A {kind.ToLowerInvariant()} can contain up to 500 components.");
            var componentIds = new HashSet<string>(StringComparer.Ordinal);
            var inputFields = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in components)
            {
                if (item is not JsonObject component) throw new ArgumentException("Every component must be an object.");
                if (!componentIds.Add(RequiredText(component, "id"))) throw new ArgumentException($"Component IDs must be unique within a {kind.ToLowerInvariant()}.");
                var type = RequiredText(component, "type");
                if (!ComponentTypes.Contains(type)) throw new ArgumentException("Unsupported component type.");
                if (InputDefinitionValidator.IsInput(type))
                {
                    if (component["props"] is not JsonObject props) throw new ArgumentException("Every input needs a properties object.");
                    InputDefinitionValidator.ValidateDefinition(type, props, inputFields);
                }
                if (type == "multiStateIndicator") StateControlValidator.ValidateIndicator(component["props"]);
                if (ProcessDisplayValidator.Types.Contains(type)) ProcessDisplayValidator.Validate(type, component["props"]);
                if (DrawingComponentValidator.Types.Contains(type)) DrawingComponentValidator.Validate(type, component["props"]);
                TableColumnValidator.Validate(type, component["props"]);
                ChartValidator.Validate(type, component["props"]);
                ViewContainerValidator.Validate(type, component["props"]);
                if (!InputDefinitionValidator.IsInput(type) && component["props"] is JsonObject inputProps && inputProps.Any(pair => pair.Key is "validation" or "formatMask" or "textCase" or "scanTerminator")) InputConstraints.ValidateDefinition(type, inputProps);
                TableEditValidator.Validate(type, component["props"]);
                if (component["props"] is JsonObject tableProps && tableProps.ContainsKey("pageSize"))
                {
                    if (type != "table" || tableProps["pageSize"] is not JsonValue page || !page.TryGetValue<double>(out var size) ||
                        !double.IsFinite(size) || size != Math.Truncate(size) || size is < 1 or > 100)
                        throw new ArgumentException("Only tables support a pageSize integer from 1 to 100.");
                }
            }
            ProjectStateValidator.ValidateInputBindings(document, sessionState, kind == "Template");
            ComponentBindingValidator.ValidateDocument(document, projectParameters, sessionState, kind == "Template");
            ComponentEventValidator.ValidateDocument(document);
            InputDefinitionValidator.ValidateSelectionMappings(components.OfType<JsonObject>(), inputFields);
        }
    }

    public static void ValidateComposition(JsonObject project)
    {
        var rootParameters = StringParameters(project["parameters"], "Project parameters");
        var screens = project["screens"]!.AsArray().OfType<JsonObject>().ToDictionary(screen => RequiredText(screen, "id"), StringComparer.Ordinal);
        if (!screens.Values.Any(screen => ScreenKind(screen) == "screen")) throw new ArgumentException("A project must contain at least one regular screen.");
        foreach (var screen in screens.Values)
        {
            ScreenKind(screen);
            ValidateReferences(ScreenParameters(screen), rootParameters);
        }
        var templates = Templates(project).ToDictionary(template => RequiredText(template, "id"), StringComparer.Ordinal);
        foreach (var template in templates.Values)
            StringParameters(template["parameters"], "Template parameters");

        // Check every saved template, even an unplaced one or a child behind an
        // empty repeater. Drafts may contain cycles; no cyclic graph is published.
        var visiting = new HashSet<string>(StringComparer.Ordinal);
        var metrics = new Dictionary<string, (int Depth, long Count)>(StringComparer.Ordinal);
        (int Depth, long Count) MeasureTemplate(string id)
        {
            if (metrics.TryGetValue(id, out var cached)) return cached;
            if (!visiting.Add(id)) throw new ArgumentException("Template cycles are not supported in a published project.");
            var depth = 1;
            long count = 0;
            foreach (var component in templates[id]["components"]!.AsArray().OfType<JsonObject>())
            {
                count++;
                foreach (var placement in ViewContainerValidator.Placements(component))
                {
                    var (child, repetitions) = Instance(placement, templates, nested: true);
                    var childMetrics = MeasureTemplate(RequiredText(child, "id"));
                    depth = Math.Max(depth, childMetrics.Depth + 1);
                    count += childMetrics.Count * repetitions;
                }
                // Saturate unused template counts so malicious branching cannot
                // overflow while zero-row ancestors still contribute no children.
                count = Math.Min(count, MaximumExpandedComponents + 1);
            }
            if (depth > MaximumInstanceDepth) throw new ArgumentException("Published template instances are limited to 4 nested levels.");
            visiting.Remove(id);
            return metrics[id] = (depth, count);
        }
        foreach (var id in templates.Keys) MeasureTemplate(id);

        long expandedCount = 0;
        foreach (var screen in screens.Values)
            foreach (var component in screen["components"]!.AsArray().OfType<JsonObject>())
            {
                expandedCount++;
                foreach (var placement in ViewContainerValidator.Placements(component))
                {
                    var (template, repetitions) = Instance(placement, templates, nested: false);
                    expandedCount += metrics[RequiredText(template, "id")].Count * repetitions;
                }
                if (expandedCount > MaximumExpandedComponents)
                    throw new ArgumentException("A published project is limited to 10,000 expanded components, including instance containers.");
            }

        foreach (var screen in screens.Values)
        {
            var contexts = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
            void ValidateScope(JsonObject document, JsonObject context, bool templateScope)
            {
                ProjectInteractions.ValidatePlacement(document, screen, context, screens);
                if (templateScope) ProjectStateValidator.ValidatePlacement(document, screen);
                foreach (var component in document["components"]!.AsArray().OfType<JsonObject>().SelectMany(ViewContainerValidator.Placements))
                {
                    var props = component["props"]!.AsObject();
                    var template = templates[RequiredText(props, "templateId")];
                    var defaults = template["parameters"]!.AsObject();
                    ValidateReferences(defaults, context);
                    ValidateOverrides(props, defaults, context, "Template instance parameters");
                    if (props["rows"] is JsonArray rows)
                        foreach (var row in rows.OfType<JsonObject>())
                            ValidateOverrides(row, defaults, context, "Repeater row parameters");
                    var templateId = RequiredText(template, "id");
                    var childContext = MergeDeclarations(context, defaults);
                    if (!contexts.TryGetValue(templateId, out var prior)) contexts.Add(templateId, childContext);
                    else
                        foreach (var key in prior.Select(pair => pair.Key).Where(key => !childContext.ContainsKey(key)).ToArray())
                            prior.Remove(key);
                }
            }
            ValidateScope(screen, MergeDeclarations(rootParameters, ScreenParameters(screen)), templateScope: false);
            // Parents have strictly greater measured depths than their children.
            // Intersect their declarations before checking a shared child, so a
            // reference must work in every placement without expanding a huge
            // number of paths hidden behind empty repeaters.
            foreach (var template in templates.Values.OrderByDescending(template => metrics[RequiredText(template, "id")].Depth))
                if (contexts.TryGetValue(RequiredText(template, "id"), out var context))
                    ValidateScope(template, context, templateScope: true);
        }
    }

    private static (JsonObject Template, int Repetitions) Instance(JsonObject component, IReadOnlyDictionary<string, JsonObject> templates, bool nested)
    {
        if (component["props"] is not JsonObject props) throw new ArgumentException("Every template instance needs a properties object.");
        if (!templates.TryGetValue(RequiredText(props, "templateId"), out var template))
            throw new ArgumentException("Every template instance must reference an existing template before publishing.");
        if (RequiredText(component, "type") != "repeater") return (template, 1);
        ValidateNumber(props, "columns", 1, 12, integer: true);
        ValidateNumber(props, "gap", 0, 64, integer: false);
        if (props["rowsSource"] is JsonObject source)
        {
            return (template, QueryRepeaterSource.RowLimit(source));
        }
        if (props["rows"] is not JsonArray rows || rows.Count > 100)
            throw new ArgumentException("Repeater rows must be an array containing at most 100 rows.");
        var rowIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in rows)
        {
            if (node is not JsonObject row || !rowIds.Add(RequiredText(row, "id")))
                throw new ArgumentException("Repeater rows need unique, nonempty string IDs.");
            if (!row.ContainsKey("parameters")) throw new ArgumentException("Every repeater row needs a parameters object.");
            StringParameters(row["parameters"], "Repeater row parameters");
        }
        return (template, rows.Count);
    }

    public static string ScreenKind(JsonObject screen)
    {
        var kind = screen.ContainsKey("kind") ? RequiredText(screen, "kind") : "screen";
        return kind is "screen" or "popup" ? kind : throw new ArgumentException("Screen kind must be screen or popup.");
    }

    public static JsonObject ScreenParameters(JsonObject screen) => screen.ContainsKey("parameters")
        ? StringParameters(screen["parameters"], "Screen parameters") : new JsonObject();

    public static JsonObject MergeDeclarations(JsonObject context, JsonObject local)
    {
        var result = context.DeepClone().AsObject();
        foreach (var (key, value) in local) result[key] = value!.DeepClone();
        return result;
    }

    private static void ValidateOverrides(JsonObject owner, JsonObject declared, JsonObject rootParameters, string description)
    {
        if (!owner.ContainsKey("parameters")) return;
        var parameters = StringParameters(owner["parameters"], description);
        if (parameters.Any(pair => !declared.ContainsKey(pair.Key)))
            throw new ArgumentException($"{description} may override only keys declared by the template.");
        ValidateReferences(parameters, rootParameters);
    }

    public static JsonObject StringParameters(JsonNode? value, string description)
    {
        if (value is not JsonObject parameters || parameters.Any(pair => pair.Value is not JsonValue scalar || !scalar.TryGetValue<string>(out _)))
            throw new ArgumentException($"{description} must be an object containing string values.");
        return parameters;
    }

    public static void ValidateReferences(JsonObject parameters, JsonObject rootParameters)
    {
        foreach (var (_, value) in parameters)
            foreach (Match match in ParameterReference.Matches(value!.GetValue<string>()))
                if (!rootParameters.ContainsKey(match.Groups[1].Value))
                    throw new ArgumentException("Parameter references may name only keys declared in the calling context.");
    }

    private static void ValidateNumber(JsonObject props, string key, double minimum, double maximum, bool integer)
    {
        if (!props.ContainsKey(key)) return;
        if (props[key] is not JsonValue value || !value.TryGetValue<double>(out var number) || !double.IsFinite(number) ||
            number < minimum || number > maximum || integer && number != Math.Truncate(number))
            throw new ArgumentException($"Repeater {key} must be {(integer ? "an integer" : "a number")} between {minimum} and {maximum}.");
    }

    public static JsonObject MergeParameters(JsonObject template, JsonObject instance, JsonObject? row)
    {
        var result = template["parameters"]!.DeepClone().AsObject();
        foreach (var overrides in new[] { instance["props"]?["parameters"] as JsonObject, row?["parameters"] as JsonObject })
            if (overrides is not null)
                foreach (var (key, value) in overrides) result[key] = value!.DeepClone();
        return result;
    }

    public static Dictionary<string, JsonElement> ResolveParameters(JsonObject parameters, IReadOnlyDictionary<string, JsonElement> rootParameters)
    {
        var result = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var (key, value) in parameters)
        {
            // Regex.Replace visits only the original string; substituted text is never
            // parsed a second time or resolved against another template parameter.
            var resolved = ParameterReference.Replace(value!.GetValue<string>(), match => rootParameters.TryGetValue(match.Groups[1].Value, out var root)
                ? TemplateParameterTypes.ScalarText(root) : throw new ArgumentException("A required project parameter is missing."));
            result[key] = JsonSerializer.SerializeToElement(resolved);
        }
        return result;
    }

    private static string RequiredText(JsonObject value, string key) => value[key] is JsonValue scalar && scalar.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text)
        ? text : throw new ArgumentException($"{key} must be a nonempty string.");
}
