using System.Text.Json;
using System.Text.Json.Nodes;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

/// <summary>Saved query sources and fresh server-side row identities for template repeaters.</summary>
internal static class QueryRepeaterSource
{
    public const int MaximumRows = 100;

    public static void ValidateStructure(JsonObject project)
    {
        var templates = ProjectTemplates.Templates(project).ToDictionary(template => ProjectStore.Required(template, "id"), StringComparer.Ordinal);
        foreach (var component in ProjectTemplates.Components(project))
        {
            if (component["props"] is not JsonObject props || !props.ContainsKey("rowsSource")) continue;
            if (ProjectStore.Optional(component, "type") != "repeater" || props["rowsSource"] is not JsonObject source || source.Count != 3 ||
                source.Any(pair => pair.Key is not ("queryId" or "rowKey" or "parameterMap")))
                throw new ArgumentException("Only repeaters support a rows source containing exactly queryId, rowKey and parameterMap.");
            Column(source, "queryId");
            Column(source, "rowKey");
            if (props.ContainsKey("rows") && (props["rows"] is not JsonArray rows || rows.Count != 0))
                throw new ArgumentException("A query-backed repeater cannot also contain static rows. Omit rows or use an empty array.");
            if (!templates.TryGetValue(ProjectStore.Required(props, "templateId"), out var template))
                throw new ArgumentException("A query-backed repeater must reference an existing template.");
            var declared = ProjectTemplates.StringParameters(template["parameters"], "Template parameters");
            if (source["parameterMap"] is not JsonObject map || map.Count > 64)
                throw new ArgumentException("Repeater parameterMap must be an object containing at most 64 template-parameter mappings.");
            foreach (var (parameter, _) in map)
            {
                if (!declared.ContainsKey(parameter))
                    throw new ArgumentException("Repeater mappings may target only parameters declared by their template.");
                Column(map, parameter);
            }
        }
    }

    private static string Column(JsonObject value, string property)
    {
        if (value[property] is not JsonValue scalar || !scalar.TryGetValue<string>(out var text) ||
            InputDefinitionValidator.BlankOption(text) || text.Length > 128)
            throw new ArgumentException("Repeater query IDs and column names must be nonempty text up to 128 characters.");
        return text;
    }

    public static void ValidateRowId(string? rowId)
    {
        if (InputDefinitionValidator.BlankOption(rowId) || rowId!.Length > 200)
            throw new ArgumentException("A query-backed repeater action requires a nonempty text row ID up to 200 characters.");
    }

    public static Dictionary<string, JsonElement> ResolveRow(JsonObject source, QueryResult result, string rowId, JsonObject? parameterTypes = null)
    {
        ValidateRowId(rowId);
        if (result.Rows.Count > MaximumRows)
            throw new ArgumentException("A query-backed repeater returned more than 100 rows. Narrow its named query.");
        var rowKey = ProjectStore.Required(source, "rowKey");
        var map = source["parameterMap"]!.AsObject();
        var required = map.Select(pair => pair.Value!.GetValue<string>()).Append(rowKey).Distinct(StringComparer.Ordinal);
        if (required.Any(column => !result.Columns.Contains(column, StringComparer.Ordinal)))
            throw new ArgumentException("The repeater query is missing a configured row-key or parameter column.");
        var keys = new HashSet<string>(StringComparer.Ordinal);
        Dictionary<string, JsonElement>? selected = null;
        foreach (var row in result.Rows)
        {
            if (!row.TryGetValue(rowKey, out var value) || value is not string key)
                throw new ArgumentException("Repeater row keys must be text, not numeric, Boolean or null values.");
            ValidateRowId(key);
            if (!keys.Add(key)) throw new ArgumentException("Repeater query row keys must be unique.");
            var parameters = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            foreach (var (parameter, column) in map)
            {
                if (!row.TryGetValue(column!.GetValue<string>(), out var raw))
                    throw new ArgumentException("The repeater query returned an incomplete row.");
                var text = raw is bool flag ? flag ? "true" : "false" : InputDefinitionValidator.OptionText(raw);
                if (text is null || text.Length > 4096)
                    throw new ArgumentException("Repeater parameter values must be text up to 4096 characters, Boolean values or finite numbers within the browser's exact integer range.");
                parameters.Add(parameter, TemplateParameterTypes.Coerce(parameter, JsonSerializer.SerializeToElement(raw), parameterTypes));
            }
            if (key == rowId) selected = parameters;
        }
        // Validate the complete result even if the selected row occurred first.
        return selected ?? throw new ArgumentException("This repeater row is no longer available. Refresh the screen before running its action.");
    }
}
