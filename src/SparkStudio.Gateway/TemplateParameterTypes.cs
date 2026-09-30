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
                    !declared.ContainsKey(pair.Key) || pair.Value is not JsonValue value || !value.TryGetValue<string>(out var type) || type is not ("string" or "number" or "boolean")))
                    throw new ArgumentException("Template parameterTypes must contain at most 64 declared parameter names with string, number or boolean types.");
            }
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
        if (owner.ContainsKey("parameterTypes")) throw new ArgumentException("Parameter type definitions belong only to templates.");
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
        if (type == "string") return JsonSerializer.SerializeToElement(ScalarText(value));
        if (type == "boolean")
        {
            if (value.ValueKind is JsonValueKind.True or JsonValueKind.False) return value.Clone();
            if (value.ValueKind == JsonValueKind.String && value.GetString() is "true" or "false")
                return JsonSerializer.SerializeToElement(value.GetString() == "true");
            throw new ArgumentException($"Template parameter '{key}' must be true or false.");
        }
        if (type == "number")
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
        throw new ArgumentException("Unsupported template parameter type.");
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
