using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Public template types; saved authored values remain one-pass text expressions.</summary>
internal static class TemplateParameterTypes
{
    private const double MaximumSafeInteger = 9007199254740991d;
    private static readonly Regex NumberSyntax = new(@"\A-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?\z", RegexOptions.CultureInvariant);
    private static readonly Regex Reference = new(@"\{([^{}]+)\}", RegexOptions.CultureInvariant);

    public static void ValidateProject(JsonObject project)
    {
        RejectMetadata(project);
        foreach (var screen in project["screens"]!.AsArray().OfType<JsonObject>()) RejectMetadata(screen);
        foreach (var component in ProjectTemplates.Components(project))
        {
            RejectMetadata(component);
            if (component["props"] is JsonObject props) RejectMetadata(props);
        }
        var templates = ProjectTemplates.Templates(project).ToDictionary(template => ProjectStore.Required(template, "id"), StringComparer.Ordinal);
        foreach (var template in templates.Values)
        {
            var declared = ProjectTemplates.StringParameters(template["parameters"], "Template parameters");
            if (template.ContainsKey("parameterTypes"))
            {
                if (template["parameterTypes"] is not JsonObject types || types.Count > 64 || types.Any(pair =>
                    !declared.ContainsKey(pair.Key) || pair.Value is not JsonValue value || !value.TryGetValue<string>(out var type) || type is not ("string" or "number" or "boolean" or "model")))
                    throw new ArgumentException("Template parameterTypes must contain at most 64 declared parameter names with string, number, boolean or model types.");
            }
            ValidateModelRequirements(template, declared);
            ValidateConstants(declared, template["parameterTypes"] as JsonObject);
        }
        foreach (var component in ProjectTemplates.Components(project).SelectMany(ViewContainerValidator.Placements))
        {
            if (ProjectStore.Optional(component, "type") is not ("template" or "repeater") || component["props"] is not JsonObject props ||
                !templates.TryGetValue(ProjectStore.Optional(props, "templateId") ?? "", out var template)) continue;
            var declared = template["parameters"]!.AsObject();
            ValidateOverrides(props, declared, template["parameterTypes"] as JsonObject);
            if (props["rows"] is JsonArray rows)
                foreach (var row in rows.OfType<JsonObject>())
                {
                    RejectMetadata(row);
                    ValidateOverrides(row, declared, template["parameterTypes"] as JsonObject);
                }
        }
    }

    private static void RejectMetadata(JsonObject owner)
    {
        if (owner.ContainsKey("parameterTypes") || owner.ContainsKey("modelParameters")) throw new ArgumentException("Parameter type definitions and model requirements belong only to templates.");
    }

    // Requirements are portable metadata. Gateway model existence is diagnosed in Designer,
    // never checked here: importing a project on a new gateway must remain possible.
    private static void ValidateModelRequirements(JsonObject template, JsonObject declared)
    {
        var types = template["parameterTypes"] as JsonObject;
        if (template.ContainsKey("modelParameters") && (template["modelParameters"] is not JsonObject requirements || requirements.Count > 64))
            throw new ArgumentException("Model parameter requirements must be an object with at most 64 declared parameters.");
        var models = template["modelParameters"] as JsonObject ?? [];
        foreach (var (name, node) in models)
        {
            if (!declared.ContainsKey(name) || types?[name]?.GetValue<string>() != "model" || node is not JsonObject requirement)
                throw new ArgumentException("Model requirements belong to declared Model instance parameters only.");
            TagModel.Fields(requirement, "definitionId", "minVersion", "maxVersion");
            TagModel.Name(requirement, "definitionId");
            var minimum = ModelVersion(requirement, "minVersion");
            var maximum = ModelVersion(requirement, "maxVersion");
            if (minimum.HasValue && maximum.HasValue && minimum > maximum) throw new ArgumentException("Minimum model version cannot exceed maximum model version.");
        }
        foreach (var (name, type) in types ?? [])
            if (type?.GetValue<string>() == "model" && !models.ContainsKey(name)) throw new ArgumentException("Each Model instance parameter requires a definitionId and optional version bounds.");
    }

    private static int? ModelVersion(JsonObject requirement, string key)
    {
        if (!requirement.ContainsKey(key)) return null;
        if (requirement[key] is JsonValue value && value.TryGetValue<int>(out var version) && version is >= 1 and <= 1000000) return version;
        throw new ArgumentException("Model version bounds must be integers from 1 through 1000000.");
    }

    private static void ValidateOverrides(JsonObject owner, JsonObject declared, JsonObject? types)
    {
        if (!owner.ContainsKey("parameters")) return;
        var values = ProjectTemplates.StringParameters(owner["parameters"], "Template overrides");
        if (values.Any(pair => !declared.ContainsKey(pair.Key))) throw new ArgumentException("Template overrides may name only declared template parameters.");
        ValidateConstants(values, types);
    }

    private static void ValidateConstants(JsonObject values, JsonObject? types)
    {
        if (types is null) return;
        foreach (var (key, value) in values)
        {
            var text = value!.GetValue<string>();
            if (!Reference.IsMatch(text)) Coerce(key, JsonSerializer.SerializeToElement(text), types);
        }
    }

    public static JsonElement Coerce(string key, JsonElement value, JsonObject? types)
    {
        var type = types?[key]?.GetValue<string>() ?? "string";
        if (type == "model")
        {
            if (value.ValueKind != JsonValueKind.String) throw new ArgumentException($"Template parameter '{key}' requires a concrete model instance path.");
            return JsonSerializer.SerializeToElement(TagDefinitionValidator.Path(value.GetString()));
        }
        if (type == "string") return JsonSerializer.SerializeToElement(ScalarText(value));
        if (type == "boolean")
        {
            if (value.ValueKind is JsonValueKind.True or JsonValueKind.False) return value.Clone();
            if (value.ValueKind == JsonValueKind.String && value.GetString() is "true" or "false")
                return JsonSerializer.SerializeToElement(value.GetString() == "true");
            throw new ArgumentException($"Template parameter '{key}' must be true or false.");
        }
        if (type == "number") return CoerceNumber(key, value);
        throw new ArgumentException("Unsupported template parameter type.");
    }
    private static JsonElement CoerceNumber(string key, JsonElement value)
    {
            var number = double.NaN;
            var parsed = false;
            if (value.ValueKind == JsonValueKind.Number) parsed = value.TryGetDouble(out number);
            else if (value.ValueKind == JsonValueKind.String && value.GetString() is { } text && NumberSyntax.IsMatch(text))
                parsed = double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out number);
            if (parsed && double.IsFinite(number) && !(number == Math.Truncate(number) && Math.Abs(number) > MaximumSafeInteger))
                return JsonSerializer.SerializeToElement(number == 0 ? 0d : number);
            throw new ArgumentException($"Template parameter '{key}' must be a finite decimal number within the browser's exact integer range, without whitespace.");
    }

    public static string ScalarText(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString()!,
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        JsonValueKind.Number => InputDefinitionValidator.OptionText(value.GetDouble())
            ?? throw new ArgumentException("Parameter numbers must be finite and within the browser's exact integer range."),
        _ => throw new ArgumentException("Parameters must contain text, Boolean values or finite numbers.")
    };
}
