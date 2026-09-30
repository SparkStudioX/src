using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

public static class ChartValidator
{
    private static readonly HashSet<string> Kinds = ["line", "area", "bar", "scatter", "timeSeries", "pie", "radar", "status", "box", "gantt"];
    private static readonly HashSet<string> Fields = ["kind", "xKey", "series", "endKey", "qualityKey", "yMin", "yMax", "showLegend", "rangeSelector"];
    public static void Validate(string type, JsonNode? node)
    {
        if (node is not JsonObject props) return;
        if (type is not ("chart" or "sparkline"))
        {
            if (props.ContainsKey("chart")) throw new ArgumentException("Chart settings require a chart or sparkline component.");
            return;
        }
        if (props["chart"] is not JsonObject chart || chart.Any(pair => !Fields.Contains(pair.Key))) throw new ArgumentException("A chart requires supported chart settings.");
        var kind = ProjectStore.Required(chart, "kind");
        if (!Kinds.Contains(kind)) throw new ArgumentException("Unsupported chart kind.");
        Name(chart["xKey"]);
        if (chart["series"] is not JsonArray series || series.Count is < 1 or > 8) throw new ArgumentException("A chart requires 1–8 series.");
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in series)
        {
            if (entry is not JsonObject item || item.Any(pair => pair.Key is not ("key" or "label" or "color")) || !keys.Add(Name(item["key"]))) throw new ArgumentException("Chart series require unique column keys.");
            if (item.ContainsKey("label") && (item["label"] is not JsonValue label || !label.TryGetValue<string>(out var text) || text.Length > 128)) throw new ArgumentException("Chart labels support 128 characters.");
            if (item.ContainsKey("color") && (item["color"] is not JsonValue color || !color.TryGetValue<string>(out var value) || !Regex.IsMatch(value, @"\A#[0-9a-fA-F]{6}\z", RegexOptions.CultureInvariant))) throw new ArgumentException("Chart colors require six hex digits.");
        }
        foreach (var key in new[] { "endKey", "qualityKey" }) if (chart.ContainsKey(key)) Name(chart[key]);
        foreach (var key in new[] { "yMin", "yMax" }) if (chart.ContainsKey(key) && !Number(chart[key], out _)) throw new ArgumentException("Chart axis bounds must be finite exact numbers.");
        if (Number(chart["yMin"], out var min) && Number(chart["yMax"], out var max) && min >= max) throw new ArgumentException("Chart minimum must be less than maximum.");
        foreach (var key in new[] { "showLegend", "rangeSelector" }) if (chart.ContainsKey(key) && (chart[key] is not JsonValue flag || !flag.TryGetValue<bool>(out _))) throw new ArgumentException("Chart switches must be Boolean.");
        if (kind == "gantt" && !chart.ContainsKey("endKey")) throw new ArgumentException("Gantt requires a finish column.");
        if (kind == "box" && series.Count != 5) throw new ArgumentException("Box plots require minimum, Q1, median, Q3 and maximum series in that order.");
        if (kind == "pie" && series.Count != 1) throw new ArgumentException("Pie charts require one series.");
        if (props.ContainsKey("dataSource")) return; // A query's actual values are checked on arrival.
        if (props["data"] is not JsonObject data || data["columns"] is not JsonArray columns || data["rows"] is not JsonArray rows || rows.Count > 1000 || columns.Count > 64) throw new ArgumentException("Chart data needs at most 1,000 rows and 64 columns.");
        var names = columns.Select(Name).ToHashSet(StringComparer.Ordinal);
        if (names.Count != columns.Count) throw new ArgumentException("Dataset columns must be unique.");
        var xKey = Name(chart["xKey"]);
        var qualityKey = chart.ContainsKey("qualityKey") ? Name(chart["qualityKey"]) : null;
        var endKey = kind == "gantt" ? Name(chart["endKey"]) : null;
        var required = keys.Concat(new[] { xKey, qualityKey, endKey }.OfType<string>()).ToArray();
        if (required.Any(key => !names.Contains(key))) throw new ArgumentException("A chart column is missing from its dataset.");
        foreach (var entry in rows)
        {
            if (entry is not JsonObject row || required.Any(key => !row.ContainsKey(key))) throw new ArgumentException("Every row must contain the chart's columns.");
            if (row[xKey] is not JsonValue x || !(x.TryGetValue<string>(out _) || Number(x, out _))) throw new ArgumentException("Chart categories must be text or numbers.");
            if (kind == "scatter" && !Number(x, out _)) throw new ArgumentException("Scatter X must be numeric.");
            if (kind is "timeSeries" or "gantt" && !Instant(x, out _)) throw new ArgumentException("Chart times need epoch milliseconds or ISO timestamps with a time zone.");
            if (kind == "gantt" && (!Instant(row[endKey!], out var end) || !Instant(x, out var start) || end < start)) throw new ArgumentException("Gantt finish must be at or after start.");
            var good = qualityKey is null || row[qualityKey] is JsonValue quality && quality.TryGetValue<string>(out var qualityText) && Regex.IsMatch(qualityText, @"\Agood(?:\z|_)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            var values = new List<double?>();
            foreach (var column in series.OfType<JsonObject>())
            {
                var cell = row[Name(column["key"])];
                if (!good || cell is null) { values.Add(null); continue; }
                if (!Number(cell, out var value) || kind is "pie" or "radar" && value < 0) throw new ArgumentException("Chart observations must be numeric, with nonnegative pie/radar values.");
                values.Add(value);
            }
            if (kind == "box" && values.All(value => value.HasValue) && values.Skip(1).Where((value, index) => value < values[index]).Any()) throw new ArgumentException("Box statistics must be ordered.");
        }
    }
    private static string Name(JsonNode? node)
    {
        if (node is not JsonValue value || !value.TryGetValue<string>(out var text) || text.Length is < 1 or > 128 || text is "__proto__" or "constructor" or "prototype") throw new ArgumentException("Chart columns need valid names up to 128 characters.");
        return text;
    }
    private static bool Number(JsonNode? node, out double number)
    {
        number = 0;
        return node is JsonValue value && value.TryGetValue<double>(out number) && double.IsFinite(number) && (number != Math.Truncate(number) || Math.Abs(number) <= 9007199254740991d);
    }
    private static bool Instant(JsonNode? node, out double instant)
    {
        if (Number(node, out instant)) return true;
        if (node is JsonValue value && value.TryGetValue<string>(out var text) && Regex.IsMatch(text, @"\A\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})\z", RegexOptions.CultureInvariant) && DateTimeOffset.TryParse(text, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var date)) { instant = date.ToUnixTimeMilliseconds(); return true; }
        return false;
    }
}
