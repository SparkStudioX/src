using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public sealed record ModelFieldIssue(string Code, string Message, string Expected);
public sealed record ModelUnit(string Code, string Name);

/// <summary>Field contracts annotate a modeled value; they never rewrite its source value or transport quality.</summary>
public static class ModelFieldContract
{
    public static readonly ModelUnit[] Units = [new("1", "Dimensionless"), new("%", "Percent"), new("Cel", "Degrees Celsius"),
        new("K", "Kelvin"), new("[degF]", "Degrees Fahrenheit"), new("Pa", "Pascal"), new("kPa", "Kilopascal"), new("MPa", "Megapascal"),
        new("bar", "Bar"), new("mbar", "Millibar"), new("[psi]", "Pounds per square inch"), new("m", "Metre"), new("cm", "Centimetre"),
        new("mm", "Millimetre"), new("[in_i]", "Inch"), new("s", "Second"), new("min", "Minute"), new("h", "Hour"), new("Hz", "Hertz"),
        new("/min", "Per minute / revolutions per minute"), new("m/s", "Metres per second"), new("m3/s", "Cubic metres per second"),
        new("L/min", "Litres per minute"), new("kg", "Kilogram"), new("g", "Gram"), new("N", "Newton"), new("N.m", "Newton metre"),
        new("W", "Watt"), new("kW", "Kilowatt"), new("V", "Volt"), new("A", "Ampere")];

    public static void Validate(JsonObject field, bool member)
    {
        if (field.ContainsKey("semanticId"))
        {
            var id = TagDefinitionValidator.Text(field, "semanticId");
            if (id.Length > 2048 || id.Any(char.IsWhiteSpace) || !Uri.TryCreate(id, UriKind.Absolute, out _))
                throw new ArgumentException("semanticId must be an absolute URI of at most 2048 characters, such as urn:acme:load or https://example.com/Load.");
        }
        if (!member) return;
        ValidateUnit(field);
        _ = Freshness(field);
        ValidateEnum(field);
        ModelAlarmTemplates.Validate(field);
    }

    private static void ValidateUnit(JsonObject field)
    {
        if (!field.ContainsKey("unitSystem")) return;
        var system = TagDefinitionValidator.Text(field, "unitSystem");
        if (system is not ("ucum" or "custom")) throw new ArgumentException("unitSystem must be ucum or custom.");
        if (system == "ucum" && !Units.Any(unit => unit.Code == ProjectStore.Optional(field, "unit")))
            throw new ArgumentException("Select a supported UCUM unit, or choose Custom for an unvalidated display unit. Units do not automatically convert source values.");
    }

    public static int Freshness(JsonObject field)
    {
        if (!field.ContainsKey("freshnessMs")) return 0;
        if (field["freshnessMs"] is not JsonValue value || !value.TryGetValue<int>(out var ms) || ms is < 0 or > 86400000)
            throw new ArgumentException("freshnessMs must be an integer from 0 through 86400000; 0 disables the freshness rule.");
        return ms;
    }

    private static void ValidateEnum(JsonObject field)
    {
        if (!field.ContainsKey("enumValues")) return;
        var type = TagDefinitionValidator.DataType(field);
        if (type is not ("String" or "Int16" or "UInt16" or "Int32" or "UInt32" or "Int64"))
            throw new ArgumentException("enumValues apply to string or integer fields only.");
        if (field["enumValues"] is not JsonArray items || items.Count > 128)
            throw new ArgumentException("enumValues accepts at most 128 unique values matching the field data type; an empty list disables this rule.");
        var values = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in items)
        {
            var normalized = TagDefinitionValidator.MemoryValue(type, item).ToJsonString();
            if (normalized.Length > 2048 || !values.Add(normalized)) throw new ArgumentException("Enum values must be unique and at most 2048 characters each.");
        }
    }

    public static bool HasRules(JsonObject definition) => definition.ContainsKey("udtInstance") || definition.ContainsKey("range") || definition.ContainsKey("enumValues") || Freshness(definition) > 0;

    public static TagValue Evaluate(JsonObject definition, TagValue reading, DateTimeOffset now)
    {
        var sourceQuality = reading.Quality.StartsWith("Bad", StringComparison.OrdinalIgnoreCase) ? reading.Quality : reading.SourceQuality ?? reading.Quality;
        var issues = new List<ModelFieldIssue>();
        var scalar = JsonSerializer.SerializeToElement(reading.Value);
        if (ValidateType(definition, scalar, sourceQuality, issues))
        {
            EvaluateRange(definition, scalar, issues);
            EvaluateEnum(definition, scalar, issues);
        }
        var freshness = Freshness(definition);
        var receipt = reading.ReceiptTimestamp;
        if (freshness > 0 && receipt is not null && now - receipt.Value > TimeSpan.FromMilliseconds(freshness))
            issues.Add(new("stale", "No new source sample arrived before the freshness deadline.", $"A sample at least every {freshness.ToString(CultureInfo.InvariantCulture)} ms"));
        var quality = sourceQuality;
        if (quality.StartsWith("Good", StringComparison.OrdinalIgnoreCase) && issues.Count > 0)
            quality = issues.Any(issue => issue.Code == "stale") ? "Uncertain_ModelStale" : "Uncertain_ModelValidation";
        return reading with { Quality = quality, SourceQuality = sourceQuality, ModelIssues = issues.ToArray() };
    }

    private static bool ValidateType(JsonObject definition, JsonElement value, string sourceQuality, List<ModelFieldIssue> issues)
    {
        if (!definition.ContainsKey("dataType") || value.ValueKind == JsonValueKind.Null && !sourceQuality.StartsWith("Good", StringComparison.OrdinalIgnoreCase)) return true;
        var dataType = TagDefinitionValidator.DataType(definition);
        try { _ = TagDefinitionValidator.MemoryValue(dataType, value); return true; }
        catch (ArgumentException)
        {
            issues.Add(new("invalidType", "The source value does not match the model's declared scalar type.", dataType));
            return false;
        }
    }

    private static void EvaluateRange(JsonObject definition, JsonElement value, List<ModelFieldIssue> issues)
    {
        if (definition["range"] is not JsonObject range || value.ValueKind != JsonValueKind.Number) return;
        var low = JsonSerializer.SerializeToElement(range["low"]); var high = JsonSerializer.SerializeToElement(range["high"]);
        if (CompareNumeric(value, low) < 0 || CompareNumeric(value, high) > 0)
            issues.Add(new("outOfRange", "The source value is outside the model's allowed range.", low.GetRawText() + " through " + high.GetRawText()));
    }

    public static int CompareNumeric(JsonElement left, JsonElement right)
    {
        if (left.ValueKind != JsonValueKind.Number || right.ValueKind != JsonValueKind.Number)
            throw new ArgumentException("Range boundaries must be numeric values.");
        if (!left.TryGetDouble(out var x) || !right.TryGetDouble(out var y) || !double.IsFinite(x) || !double.IsFinite(y))
            throw new ArgumentException("Range boundaries must be finite values.");
        // Decimal preserves signed Int64 distinctions. Tiny/wide IEEE values
        // must retain double semantics when decimal conversion rounds them away.
        if (left.TryGetDecimal(out var a) && right.TryGetDecimal(out var b) && (double)a == x && (double)b == y) return a.CompareTo(b);
        return x.CompareTo(y);
    }

    private static void EvaluateEnum(JsonObject definition, JsonElement value, List<ModelFieldIssue> issues)
    {
        if (definition["enumValues"] is not JsonArray { Count: > 0 } allowed || value.ValueKind == JsonValueKind.Null) return;
        var type = TagDefinitionValidator.DataType(definition);
        string normalized;
        try { normalized = TagDefinitionValidator.MemoryValue(type, value).ToJsonString(); }
        catch (ArgumentException) { normalized = ""; }
        if (!allowed.Any(item => TagDefinitionValidator.MemoryValue(type, item).ToJsonString() == normalized))
            issues.Add(new("invalidEnum", "The source value is not one of the model's allowed values.", EnumSummary(allowed)));
    }
    private static string EnumSummary(JsonArray allowed)
    {
        var preview = string.Join(", ", allowed.Take(8).Select(value => value?.ToJsonString()));
        if (preview.Length > 1024) preview = preview[..1024] + "…";
        return preview + (allowed.Count > 8 ? $" … ({allowed.Count.ToString(CultureInfo.InvariantCulture)} allowed values; see the field definition)" : "");
    }
}
