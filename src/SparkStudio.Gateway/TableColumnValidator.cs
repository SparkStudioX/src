using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Saved table presentation uses exact source keys without changing query rows or action inputs.</summary>
internal static class TableColumnValidator
{
    private static readonly HashSet<string> Fields = new(StringComparer.Ordinal)
        { "key", "label", "visible", "width", "align", "format", "precision", "suffix" };

    public static void Validate(string type, JsonNode? properties)
    {
        if (properties is not JsonObject props || !props.ContainsKey("tableColumns")) return;
        if (type != "table") throw new ArgumentException("Only tables support tableColumns configuration.");
        if (props["tableColumns"] is not JsonArray columns || columns.Count > 64)
            throw new ArgumentException("Table columns must be an array with at most 64 entries. Omit it or use an empty array for automatic columns.");
        var keys = new HashSet<string>(StringComparer.Ordinal);
        var hasVisibleColumn = false;
        foreach (var node in columns)
        {
            if (node is not JsonObject column || column.Any(field => !Fields.Contains(field.Key)))
                throw new ArgumentException("Every table column must be an object containing only supported presentation fields.");
            var key = SourceKey(column, "key");
            if (!keys.Add(key)) throw new ArgumentException("Table column source keys must be unique.");
            if (column.ContainsKey("label")) Text(column, "label", 120, nonblank: true);
            if (column.ContainsKey("visible") && (column["visible"] is not JsonValue visible || !visible.TryGetValue<bool>(out _)))
                throw new ArgumentException("Table column visible must be Boolean.");
            hasVisibleColumn |= !column.ContainsKey("visible") || column["visible"]!.GetValue<bool>();
            if (column.ContainsKey("width")) Integer(column, "width", 40, 1200);
            if (column.ContainsKey("align") && Text(column, "align", 6) is not ("left" or "center" or "right"))
                throw new ArgumentException("Table column alignment must be left, center or right.");
            var format = column.ContainsKey("format") ? Text(column, "format", 8) : "auto";
            if (format is not ("auto" or "text" or "number" or "boolean" or "datetime"))
                throw new ArgumentException("Unsupported table column format.");
            if ((column.ContainsKey("precision") || column.ContainsKey("suffix")) && format != "number")
                throw new ArgumentException("Table column precision and suffix require number format.");
            if (column.ContainsKey("precision")) Integer(column, "precision", 0, 10);
            if (column.ContainsKey("suffix")) Text(column, "suffix", 32);
        }
        if (columns.Count > 0 && !hasVisibleColumn) throw new ArgumentException("An explicit table column list must contain at least one visible column.");
    }

    internal static string SourceKey(JsonObject owner, string property)
    {
        var key = Text(owner, property, 128, nonblank: true);
        if (OuterWhitespace(key[0]) || OuterWhitespace(key[^1]))
            throw new ArgumentException("Table source keys cannot have leading or trailing whitespace.");
        return key;
    }

    private static string Text(JsonObject owner, string key, int maximum, bool nonblank = false)
    {
        if (owner[key] is not JsonValue value || !value.TryGetValue<string>(out var text) || text.Length > maximum
            || text.Any(character => character <= '\u001f' || character is >= '\u007f' and <= '\u009f')
            || nonblank && text.All(OuterWhitespace))
            throw new ArgumentException($"Table column {key} must be {(nonblank ? "nonblank " : "")}text up to {maximum} characters, without control characters.");
        return text;
    }

    // Include the byte-order mark treated as whitespace by JavaScript String.trim.
    private static bool OuterWhitespace(char character) => char.IsWhiteSpace(character) || character == '\ufeff';
    private static void Integer(JsonObject owner, string key, int minimum, int maximum)
    {
        if (owner[key] is not JsonValue value || !value.TryGetValue<double>(out var number) || !double.IsFinite(number)
            || number != Math.Truncate(number) || number < minimum || number > maximum)
            throw new ArgumentException($"Table column {key} must be an integer from {minimum} to {maximum}.");
    }
}
