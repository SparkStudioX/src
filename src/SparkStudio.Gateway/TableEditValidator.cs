using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record TableEditRequest(string? PublishedAt, Dictionary<string, JsonElement>? Parameters, JsonElement Key,
    JsonElement Version, string? Column, JsonElement Value, string? InstanceId = null, string? RowId = null, PopupOrigin? PopupOrigin = null,
    IReadOnlyList<InstancePathStep>? InstancePath = null, IReadOnlyList<Dictionary<string, JsonElement>>? BindingInputs = null,
    IReadOnlyList<ParameterBindingState>? BindingState = null, IReadOnlyList<TableCellEditRequest>? Edits = null);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record TableCellEditRequest(JsonElement Key, JsonElement Version, string? Column, JsonElement Value);

/// <summary>Authoring bounds and fresh published-row checks for script and atomic database editing.</summary>
internal static class TableEditValidator
{
    private const double MaximumSafeInteger = 9007199254740991d;
    private static readonly HashSet<string> ColumnFields = new(StringComparer.Ordinal)
        { "key", "type", "required", "min", "max", "integer", "maxLength" };

    public static void ValidateQueries(JsonObject project, JsonArray queries, ProjectStore store)
    {
        foreach (var component in ProjectTemplates.Components(project))
        {
            if (component["props"] is not JsonObject props || props["tableEdit"]?["batch"] is not JsonObject) continue;
            var query = queries.OfType<JsonObject>().SingleOrDefault(query => ProjectStore.Optional(query, "id") == ProjectStore.Optional(props, "queryId"))
                ?? throw new ArgumentException("An atomic table requires an existing read query.");
            var connectionId = ProjectStore.Required(query, "connectionId");
            if (connectionId == "sample" || ProjectStore.Optional(query, "kind") == "update") throw new ArgumentException("Atomic tables require a read query on a SQLite or SQL Server connection.");
            var connection = store.GetConnection(connectionId);
            if (connection.Type is not ("sqlite" or "sqlserver")) throw new ArgumentException("Atomic tables require a SQLite or SQL Server connection.");
        }
    }

    public static void Validate(string type, JsonNode? properties)
    {
        if (properties is not JsonObject props) return;
        if (props.ContainsKey("selectionMode"))
        {
            if (type != "table" || props["selectionMode"] is not JsonValue mode || !mode.TryGetValue<string>(out var selection) || selection is not ("single" or "multiple"))
                throw new ArgumentException("Only tables support single or multiple selectionMode.");
            if (selection == "multiple" && props["selectionFields"] is JsonObject mappings && mappings.Count > 0)
                throw new ArgumentException("Multiple table selection cannot map several rows into scalar form fields.");
        }
        if (!props.ContainsKey("tableEdit")) return;
        if (type != "table") throw new ArgumentException("Only tables support tableEdit configuration.");
        if (props["tableEdit"] is not JsonObject edit || edit.Count != 3 || edit.Any(pair => pair.Key is not ("versionColumn" or "columns" or "script" or "batch")))
            throw new ArgumentException("Table editing requires versionColumn, columns and either a script or atomic batch target.");
        TableColumnValidator.SourceKey(props, "queryId");
        var rowKey = TableColumnValidator.SourceKey(props, "rowKey");
        var version = TableColumnValidator.SourceKey(edit, "versionColumn");
        if (rowKey == version) throw new ArgumentException("A table's row key and version column must be different.");
        var batch = edit["batch"] as JsonObject;
        if (edit.ContainsKey("batch"))
        {
            if (batch is null || batch.Count != 1 || !batch.ContainsKey("table") || edit.ContainsKey("script"))
                throw new ArgumentException("Atomic batch editing requires one declared table and cannot execute Python.");
            ConnectorService.ValidateTableIdentifier(ProjectStore.Required(batch, "table"));
            ConnectorService.ValidateTableIdentifier(rowKey); ConnectorService.ValidateTableIdentifier(version);
            if (rowKey.Equals(version, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Batch row key and version must differ.");
            if (props["selectionFields"] is JsonObject mappings && mappings.Count > 0) throw new ArgumentException("Atomic batches cannot map selections into scalar form fields.");
        }
        else if (edit["script"] is not JsonValue code || !code.TryGetValue<string>(out var script) || InputDefinitionValidator.BlankOption(script) || script.Length > 64000)
            throw new ArgumentException("Table edit scripts must contain 1–64,000 characters.");
        if (edit["columns"] is not JsonArray columns || columns.Count is < 1 or > 64)
            throw new ArgumentException("Table editing requires between 1 and 64 editable column definitions.");
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in columns)
        {
            if (item is not JsonObject column || column.Any(pair => !ColumnFields.Contains(pair.Key)))
                throw new ArgumentException("Editable columns must contain only supported typed constraints.");
            var key = TableColumnValidator.SourceKey(column, "key");
            if (batch is not null)
            {
                ConnectorService.ValidateTableIdentifier(key);
                if (key.Equals(rowKey, StringComparison.OrdinalIgnoreCase) || key.Equals(version, StringComparison.OrdinalIgnoreCase) || keys.Any(existing => existing.Equals(key, StringComparison.OrdinalIgnoreCase)))
                    throw new ArgumentException("Batch editable columns must have unique database identifiers distinct from row key and version.");
            }
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

    public static Dictionary<string, JsonElement> Inputs(JsonObject table, QueryResult result, TableEditRequest request, IReadOnlyDictionary<string, JsonElement>? validatedRows = null, bool includeRowContext = true)
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
        var rows = validatedRows ?? ValidatedRows(table, result);
        if (!rows.TryGetValue(requestedKey, out var selected) || Version(selected.GetProperty(versionColumn)) != requestedVersion)
            throw new ArgumentException("This table row is stale or no longer available. Reload the table before editing again.");
        var inputs = new Dictionary<string, JsonElement>(StringComparer.Ordinal)
        {
            ["column"] = JsonSerializer.SerializeToElement(request.Column), ["value"] = request.Value.Clone(),
            ["rowKey"] = selected.GetProperty(rowKey).Clone(), ["version"] = selected.GetProperty(versionColumn).Clone()
        };
        // Only Python handlers consume complete row context. A batch validates
        // the source once and avoids copying large rows for every staged cell.
        if (includeRowContext) { inputs["oldValue"] = selected.GetProperty(request.Column!).Clone(); inputs["row"] = selected.Clone(); }
        return inputs;
    }

    private static Dictionary<string, JsonElement> ValidatedRows(JsonObject table, QueryResult result)
    {
        var edit = table["tableEdit"]!.AsObject();
        var rowKey = ProjectStore.Required(table, "rowKey");
        var versionColumn = ProjectStore.Required(edit, "versionColumn");
        var definitions = edit["columns"]!.AsArray().OfType<JsonObject>();
        if (result.Rows.Count > ConnectorService.MaximumQueryRows)
            throw new ArgumentException("An editable table can load at most 1,000 rows. Narrow its published query.");
        if (result.Columns.Distinct(StringComparer.Ordinal).Count() != result.Columns.Length)
            throw new ArgumentException("Editable table queries must return unique column names.");
        var required = definitions.Select(item => ProjectStore.Required(item, "key")).Append(rowKey).Append(versionColumn).Distinct(StringComparer.Ordinal).ToArray();
        if (required.Any(key => !result.Columns.Contains(key, StringComparer.Ordinal)))
            throw new ArgumentException("The editable table query is missing a configured key, version or editable column.");
        var rows = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var row in result.Rows)
        {
            if (required.Any(key => !row.ContainsKey(key))) throw new ArgumentException("The editable table query returned an incomplete row.");
            var encoded = JsonSerializer.SerializeToElement(row);
            var key = Identity(encoded.GetProperty(rowKey));
            if (!rows.TryAdd(key, encoded)) throw new ArgumentException("Every editable table row must have a unique stable key.");
            Version(encoded.GetProperty(versionColumn));
        }
        return rows;
    }

    public static IReadOnlyList<AtomicTableRow> BatchRows(JsonObject table, QueryResult result, TableEditRequest request)
    {
        if (request.Edits is not { Count: >= 1 and <= 100 } edits) throw new ArgumentException("An atomic table batch requires 1–100 explicit cell edits.");
        if (request.Key.ValueKind != JsonValueKind.Undefined || request.Version.ValueKind != JsonValueKind.Undefined || request.Column is not null || request.Value.ValueKind != JsonValueKind.Undefined)
            throw new ArgumentException("Batch requests must contain only edits, never a second cell intent.");
        if (table["tableEdit"]?["batch"] is not JsonObject) throw new ArgumentException("This published table does not permit atomic batches.");
        var validatedRows = ValidatedRows(table, result);
        var cells = new HashSet<(string Key, string Column)>();
        var rows = new Dictionary<string, (QueryParameter Key, long Version, List<QueryParameter> Values)>(StringComparer.Ordinal);
        foreach (var cell in edits)
        {
            if (cell is null) throw new ArgumentException("Every batch edit must be an explicit cell object.");
            var input = Inputs(table, result, request with { Key = cell.Key, Version = cell.Version, Column = cell.Column, Value = cell.Value, Edits = null }, validatedRows, includeRowContext: false);
            var identity = Identity(input["rowKey"]); var version = checked((long)Version(input["version"]));
            if (!cells.Add((identity, cell.Column!))) throw new ArgumentException("A batch cannot repeat the same row and column.");
            if (version >= 9007199254740991L) throw new ArgumentException("A row version cannot be advanced beyond the safe integer range.");
            if (!rows.TryGetValue(identity, out var row)) row = (new QueryParameter("rowKey", cell.Key.ValueKind == JsonValueKind.String ? "string" : "long", input["rowKey"]), version, []);
            if (row.Version != version) throw new ArgumentException("Every edit of a row must carry the same captured version.");
            var definition = table["tableEdit"]!["columns"]!.AsArray().OfType<JsonObject>().Single(item => ProjectStore.Required(item, "key") == cell.Column);
            row.Values.Add(new QueryParameter(cell.Column!, ProjectStore.Required(definition, "type"), input["value"])); rows[identity] = row;
        }
        return rows.Values.Select(row => new AtomicTableRow(row.Key, row.Version, row.Values)).ToArray();
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
