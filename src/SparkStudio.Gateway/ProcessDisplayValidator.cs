using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Read-only numeric display fields and bounded constant binding results.</summary>
internal static class ProcessDisplayValidator
{
    private static readonly string[] RangeFields = ["min", "max"];
    private const double MaximumSafeInteger = 9007199254740991d;
    public static readonly HashSet<string> Types = new(StringComparer.Ordinal)
        { "ledDisplay", "progressBar", "cylindricalTank", "levelIndicator", "thermometer" };
    public static readonly HashSet<string> Targets = new(StringComparer.Ordinal)
        { "value", "min", "max", "decimals", "unit", "showValue", "showPercent", "orientation" };

    public static bool Supports(string type, string target) => Types.Contains(type) && target switch
    {
        "value" or "decimals" or "unit" => true,
        "min" or "max" or "showValue" or "showPercent" => type != "ledDisplay",
        "orientation" => type is "progressBar" or "levelIndicator",
        _ => false
    };

    public static void Validate(string type, JsonNode? node)
    {
        if (node is not JsonObject props) throw new ArgumentException("A process display needs a properties object.");
        if (props.ContainsKey("tagPath")) throw new ArgumentException("Process displays read tags through value property bindings.");
        foreach (var target in Targets)
        {
            if (!props.ContainsKey(target)) continue;
            if (!Supports(type, target)) throw new ArgumentException($"The {target} property is not supported on {type}.");
            if (props[target] is not JsonValue value) throw new ArgumentException($"Process display {target} must contain a scalar value.");
            object scalar = value.TryGetValue<string>(out var text) ? text : value.TryGetValue<bool>(out var flag) ? flag :
                value.TryGetValue<double>(out var number) ? number : throw new ArgumentException($"Invalid process display {target}.");
            ValidateResult(target, scalar);
        }
        if (type != "ledDisplay") ValidateRange(Number(props, "min", 0), Number(props, "max", 100));
    }

    public static void ValidateResult(string target, object value)
    {
        switch (target)
        {
            case "value": case "min": case "max":
                if (value is not double number || !SafeNumber(number))
                    throw new ArgumentException($"Process display {target} must be a finite number within the browser's exact integer range.");
                break;
            case "decimals":
                if (value is not double places || places != Math.Truncate(places) || places is < 0 or > 6)
                    throw new ArgumentException("Process display decimals must be an integer from 0 to 6.");
                break;
            case "unit":
                if (value is not string unit || unit.Length > 32) throw new ArgumentException("Process display unit must be text up to 32 characters.");
                break;
            case "showValue": case "showPercent":
                if (value is not bool) throw new ArgumentException($"Process display {target} must be Boolean.");
                break;
            case "orientation":
                if (value is not string orientation || orientation is not ("horizontal" or "vertical"))
                    throw new ArgumentException("Process display orientation must be horizontal or vertical.");
                break;
        }
    }

    public static void ValidateConstantRange(string type, JsonObject props, IReadOnlyDictionary<string, object> constants)
    {
        if (!Types.Contains(type) || type == "ledDisplay") return;
        var bindings = props["bindings"] as JsonObject;
        var queryBindings = props["queryBindings"] as JsonObject;
        if (RangeFields.Any(key => (bindings?.ContainsKey(key) == true || queryBindings?.ContainsKey(key) == true) && !constants.ContainsKey(key))) return;
        var minimum = constants.TryGetValue("min", out var min) ? (double)min : Number(props, "min", 0);
        var maximum = constants.TryGetValue("max", out var max) ? (double)max : Number(props, "max", 100);
        ValidateRange(minimum, maximum);
    }

    private static double Number(JsonObject props, string key, double fallback) => props[key]?.GetValue<double>() ?? fallback;
    private static bool SafeNumber(double number) => double.IsFinite(number) && (number != Math.Truncate(number) || Math.Abs(number) <= MaximumSafeInteger);
    private static void ValidateRange(double minimum, double maximum)
    {
        if (minimum >= maximum) throw new ArgumentException("A process display's minimum must be below its maximum.");
    }
}
