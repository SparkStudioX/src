using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record TableEditRequest(string? PublishedAt, Dictionary<string, JsonElement>? Parameters, JsonElement Key,
    JsonElement Version, string? Column, JsonElement Value, string? InstanceId = null, string? RowId = null, PopupOrigin? PopupOrigin = null,
    IReadOnlyList<InstancePathStep>? InstancePath = null, IReadOnlyList<Dictionary<string, JsonElement>>? BindingInputs = null);

/// <summary>Authoring bounds and fresh published-row preflight; the authored script owns the atomic database write.</summary>
internal static class TableEditValidator
{
    private const double MaximumSafeInteger = 9007199254740991d;
    private static readonly HashSet<string> ColumnFields = new(StringComparer.Ordinal)
        { "key", "type", "required", "min", "max", "integer", "maxLength" };

    public static void Validate(string type, JsonNode? properties)
    {
        if (properties is not JsonObject props || !props.ContainsKey("tableEdit")) return;
        if (type != "table") throw new ArgumentException("Only tables support tableEdit configuration.");
        if (props["tableEdit"] is not JsonObject edit || edit.Count != 3 || edit.Any(pair => pair.Key is not ("versionColumn" or "columns" or "script")))
            throw new ArgumentException("Table editing requires exactly versionColumn, columns and script.");
        TableColumnValidator.SourceKey(props, "queryId");
        var rowKey = TableColumnValidator.SourceKey(props, "rowKey");
        var version = TableColumnValidator.SourceKey(edit, "versionColumn");
        if (rowKey == version) throw new ArgumentException("A table's row key and version column must be different.");
        if (edit["script"] is not JsonValue code || !code.TryGetValue<string>(out var script) || InputDefinitionValidator.BlankOption(script) || script.Length > 64000)
            throw new ArgumentException("Table edit scripts must contain 1–64,000 characters.");
        if (edit["columns"] is not JsonArray columns || columns.Count is < 1 or > 64)
            throw new ArgumentException("Table editing requires between 1 and 64 editable column definitions.");
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in columns)
        {
            if (item is not JsonObject column || column.Any(pair => !ColumnFields.Contains(pair.Key)))
                throw new ArgumentException("Editable columns must contain only supported typed constraints.");
            var key = TableColumnValidator.SourceKey(column, "key");
            if (key == rowKey || key == version || !keys.Add(key))
                throw new ArgumentException("Editable column keys must be unique and cannot change the row key or version column.");
            var columnType = column["type"] is JsonValue scalar && scalar.TryGetValue<string>(out var name) ? name : null;
            if (columnType is not ("string" or "number" or "boolean")) throw new ArgumentException("Editable column type must be string, number or boolean.");
            foreach (var field in new[] { "required", "maxLength", "min", "max", "integer" })
                if (column.ContainsKey(field) && (field is "required" or "maxLength" ? columnType != "string" : columnType != "number"))
                    throw new ArgumentException($"The {field} constraint is not supported on {columnType} columns.");
            foreach (var field in new[] { "required", "integer" })
                if (column.ContainsKey(field) && (column[field] is not JsonValue flag || !flag.TryGetValue<bool>(out _)))
                    throw new ArgumentException($"Editable column {field} must be Boolean.");
            if (column.ContainsKey("maxLength"))
            {
                var maximum = Number(column, "maxLength");
                if (maximum != Math.Truncate(maximum) || maximum is < 1 or > 4096)
                    throw new ArgumentException("Editable string maxLength must be an integer from 1 to 4096.");
            }
            var minimum = column.ContainsKey("min") ? Number(column, "min") : -MaximumSafeInteger;
            var maximumValue = column.ContainsKey("max") ? Number(column, "max") : MaximumSafeInteger;
            if (minimum > maximumValue) throw new ArgumentException("Editable numeric minimum cannot exceed its maximum.");
        }
    }

    public static Dictionary<string, JsonElement> Inputs(JsonObject table, QueryResult result, TableEditRequest request)
    {
        var edit = table["tableEdit"]!.AsObject();
        var rowKey = ProjectStore.Required(table, "rowKey");
        var versionColumn = ProjectStore.Required(edit, "versionColumn");
        var definitions = edit["columns"]!.AsArray().OfType<JsonObject>().ToArray();
        var definition = definitions.FirstOrDefault(item => ProjectStore.Optional(item, "key") == request.Column)
            ?? throw new ArgumentException("This published table column is not editable.");
        ValidateValue(definition, request.Value);
        var requestedKey = Identity(request.Key);
        var requestedVersion = Version(request.Version);
        if (result.Rows.Count > ConnectorService.MaximumQueryRows)
            throw new ArgumentException("An editable table can load at most 1,000 rows. Narrow its published query.");
        if (result.Columns.Distinct(StringComparer.Ordinal).Count() != result.Columns.Length)
            throw new ArgumentException("Editable table queries must return unique column names.");
        var required = definitions.Select(item => ProjectStore.Required(item, "key")).Append(rowKey).Append(versionColumn).Distinct(StringComparer.Ordinal).ToArray();
        if (required.Any(key => !result.Columns.Contains(key, StringComparer.Ordinal)))
            throw new ArgumentException("The editable table query is missing a configured key, version or editable column.");
        var keys = new HashSet<string>(StringComparer.Ordinal);
        JsonElement? selected = null;
        foreach (var row in result.Rows)
        {
            if (required.Any(key => !row.ContainsKey(key))) throw new ArgumentException("The editable table query returned an incomplete row.");
            var encoded = JsonSerializer.SerializeToElement(row);
            var key = Identity(encoded.GetProperty(rowKey));
            if (!keys.Add(key)) throw new ArgumentException("Every editable table row must have a unique stable key.");
            Version(encoded.GetProperty(versionColumn));
            if (key == requestedKey) selected = encoded;
        }
        if (selected is null || Version(selected.Value.GetProperty(versionColumn)) != requestedVersion)
            throw new ArgumentException("This table row is stale or no longer available. Reload the table before editing again.");
        return new(StringComparer.Ordinal)
        {
            ["column"] = JsonSerializer.SerializeToElement(request.Column), ["value"] = request.Value.Clone(),
            ["oldValue"] = selected.Value.GetProperty(request.Column!).Clone(), ["rowKey"] = selected.Value.GetProperty(rowKey).Clone(),
            ["version"] = selected.Value.GetProperty(versionColumn).Clone(), ["row"] = selected.Value.Clone()
        };
    }

    private static void ValidateValue(JsonObject definition, JsonElement value)
    {
        var type = ProjectStore.Required(definition, "type");
        if (type == "string")
        {
            if (value.ValueKind != JsonValueKind.String) throw new ArgumentException("This table edit requires a text value.");
            var text = value.GetString()!;
            var maximum = definition.ContainsKey("maxLength") ? Number(definition, "maxLength") : 4096;
            if (text.Length > maximum || definition["required"]?.GetValue<bool>() == true && InputDefinitionValidator.BlankOption(text))
                throw new ArgumentException("The edited text is blank or exceeds the published length limit.");
        }
        else if (type == "boolean")
        {
            if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw new ArgumentException("This table edit requires a Boolean value.");
        }
        else
        {
            var number = SafeNumber(value);
            if (definition.ContainsKey("min") && number < Number(definition, "min") || definition.ContainsKey("max") && number > Number(definition, "max")
                || definition["integer"]?.GetValue<bool>() == true && number != Math.Truncate(number))
                throw new ArgumentException("The edited number is outside its published bounds or must be an integer.");
        }
    }

    private static string Identity(JsonElement key)
    {
        if (key.ValueKind == JsonValueKind.String)
        {
            var text = key.GetString()!;
            if (InputDefinitionValidator.BlankOption(text) || text.Length > 4096)
                throw new ArgumentException("Editable row keys must be nonblank text up to 4096 characters or safe integers.");
            return "string:" + text;
        }
        var number = SafeNumber(key);
        if (number != Math.Truncate(number)) throw new ArgumentException("Numeric editable row keys must be safe integers.");
        return "number:" + (number == 0 ? "0" : number.ToString("R", CultureInfo.InvariantCulture));
    }
    private static double Version(JsonElement value)
    {
        var number = SafeNumber(value);
        if (number < 0 || number != Math.Truncate(number)) throw new ArgumentException("Every editable table row needs a nonnegative safe integer version.");
        return number;
    }
    private static double Number(JsonObject owner, string key) => SafeNumber(JsonSerializer.SerializeToElement(owner[key]));
    private static double SafeNumber(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number) || !double.IsFinite(number) || Math.Abs(number) > MaximumSafeInteger)
            throw new ArgumentException("Table edit numbers must be finite and within the browser's safe numeric range.");
        return number;
    }
}
