using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

internal static class DatasetBindingValidator
{
    public static void ValidateProject(JsonObject project)
    {
        JsonObject? expressions = null;
        foreach (var component in ProjectTemplates.Components(project))
        {
            if (component["props"] is not JsonObject props) continue;
            if (!props.ContainsKey("data") && !props.ContainsKey("dataSource")) continue;
            var type = ProjectStore.Required(component, "type");
            if (type is not ("chart" or "sparkline" or "table"))
                throw new ArgumentException("Datasets are supported by chart, sparkline and table components.");
            if (props.ContainsKey("data")) ValidateData(props["data"]);
            if (type == "table" && props.ContainsKey("data") && props.ContainsKey("tableEdit"))
                throw new ArgumentException("A table with supplied data cannot expose query-backed table edits.");
            if (!props.ContainsKey("dataSource")) continue;
            if (type == "table") throw new ArgumentException("Table queries use the existing queryId source contract.");
            if (props["dataSource"] is not JsonObject source || source.Any(pair => pair.Key is not ("queryId" or "parameters" or "refresh")))
                throw new ArgumentException("Dataset sources need queryId, optional parameters and refresh policy only.");
            expressions ??= project.DeepClone().AsObject();
        }
        if (expressions is null) return;
        // Reuse precisely the scalar source mapping rules; only result cardinality differs.
        foreach (var component in ProjectTemplates.Components(expressions))
        {
            var props = component["props"]!.AsObject();
            props.Remove("queryBindings");
            if (props["dataSource"] is not JsonObject source) continue;
            var binding = source.DeepClone().AsObject(); binding["column"] = "dataset";
            props["queryBindings"] = new JsonObject { ["text"] = binding };
            if (props["bindings"] is JsonObject scalarBindings) scalarBindings.Remove("text");
        }
        ComponentQueryBindingValidator.ValidateProject(expressions);
    }

    public static void ValidateData(JsonNode? raw)
    {
        if (raw is not JsonObject data || data.Any(pair => pair.Key is not ("columns" or "rows")) || data["columns"] is not JsonArray columns
            || columns.Count > 64 || data["rows"] is not JsonArray rows || rows.Count > 1000)
            throw new ArgumentException("Datasets need up to 64 columns and 1,000 rows.");
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in columns)
            if (node is not JsonValue value || !value.TryGetValue<string>(out var name) || string.IsNullOrWhiteSpace(name) || name.Length > 128
                || name is "__proto__" or "constructor" or "prototype" || !names.Add(name))
                throw new ArgumentException("Dataset columns need unique nonempty names up to 128 characters.");
        foreach (var row in rows)
        {
            if (row is not JsonObject cells || cells.Count != names.Count || cells.Any(pair => !names.Contains(pair.Key)))
                throw new ArgumentException("Dataset rows must contain exactly the declared columns.");
            foreach (var (_, cell) in cells)
                if (cell is not null && (cell is not JsonValue scalar || !(scalar.TryGetValue<bool>(out _)
                    || scalar.TryGetValue<string>(out var text) && text.Length <= 4096
                    || scalar.TryGetValue<double>(out var number) && double.IsFinite(number) && (number != Math.Truncate(number) || Math.Abs(number) <= 9007199254740991))))
                    throw new ArgumentException("Dataset cells support null, bounded text, Boolean values and exact finite numbers.");
        }
    }
}
