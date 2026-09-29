using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Bounded, independently authored vector primitives and equipment symbols.</summary>
internal static class DrawingComponentValidator
{
    public static readonly HashSet<string> Types = new(StringComparer.Ordinal)
        { "line", "rectangle", "ellipse", "polyline", "pipe", "equipmentSymbol" };
    public static readonly HashSet<string> Targets = new(StringComparer.Ordinal)
        { "strokeColor", "strokeWidth", "fillColor", "rotation", "flowing", "flowReverse", "active" };
    private static readonly HashSet<string> Fields = new(Targets, StringComparer.Ordinal)
        { "points", "symbol", "cornerRadius" };
    private static readonly Regex Color = new(@"\A#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\z", RegexOptions.CultureInvariant);

    public static bool Supports(string type, string target) => Types.Contains(type) && target switch
    {
        "strokeColor" or "strokeWidth" or "rotation" => true,
        "fillColor" => type is "rectangle" or "ellipse" or "pipe" or "equipmentSymbol",
        "flowing" or "flowReverse" => type == "pipe",
        "active" or "symbol" => type == "equipmentSymbol",
        "points" => type is "line" or "polyline" or "pipe",
        "cornerRadius" => type == "rectangle",
        _ => false
    };

    public static void Validate(string type, JsonNode? node)
    {
        if (node is not JsonObject props) throw new ArgumentException("A drawing component needs a properties object.");
        if (props.ContainsKey("color") && (props["color"] is not JsonValue accent || !accent.TryGetValue<string>(out var accentColor) || !Color.IsMatch(accentColor)))
            throw new ArgumentException("Drawing accent color must be a hex color.");
        foreach (var key in new[] { "svg", "path", "d", "markup", "src", "url", "href", "script", "tagPath" })
            if (props.ContainsKey(key)) throw new ArgumentException($"Drawing components do not support {key}; use their structured properties and bindings.");
        foreach (var field in Fields)
        {
            if (!props.ContainsKey(field)) continue;
            if (!Supports(type, field)) throw new ArgumentException($"The {field} property is not supported on {type}.");
            if (field == "points") { ValidatePoints(type, props[field]); continue; }
            if (props[field] is not JsonValue value) throw new ArgumentException($"Drawing {field} must contain a scalar value.");
            object scalar = value.TryGetValue<string>(out var text) ? text : value.TryGetValue<bool>(out var flag) ? flag :
                value.TryGetValue<double>(out var number) ? number : throw new ArgumentException($"Invalid drawing {field}.");
            ValidateResult(field, scalar);
        }
        if (props.ContainsKey("action"))
        {
            if (type != "equipmentSymbol" || props["action"] is not JsonValue action || !action.TryGetValue<string>(out var name) || name is not ("navigate" or "openPopup"))
                throw new ArgumentException("Only equipment symbols support drawing actions: navigate or openPopup.");
        }
    }

    public static void ValidateResult(string target, object value)
    {
        switch (target)
        {
            case "color": case "strokeColor": case "fillColor":
                if (value is not string color || !(Color.IsMatch(color) || target == "fillColor" && color == "none"))
                    throw new ArgumentException($"Drawing {target} must be a hex color{(target == "fillColor" ? " or none" : "")}.");
                break;
            case "strokeWidth": ValidateNumber(target, value, 1, 32); break;
            case "rotation": ValidateNumber(target, value, 0, 360); break;
            case "cornerRadius": ValidateNumber(target, value, 0, 50); break;
            case "flowing": case "flowReverse": case "active":
                if (value is not bool) throw new ArgumentException($"Drawing {target} must be Boolean.");
                break;
            case "symbol":
                if (value is not string symbol || symbol is not ("pump" or "valve" or "motor"))
                    throw new ArgumentException("Equipment symbol must be pump, valve or motor.");
                break;
        }
    }

    private static void ValidateNumber(string target, object value, double minimum, double maximum)
    {
        if (value is not double number || !double.IsFinite(number) || number < minimum || number > maximum)
            throw new ArgumentException($"Drawing {target} must be a finite number between {minimum} and {maximum}.");
    }

    private static void ValidatePoints(string type, JsonNode? node)
    {
        if (node is not JsonArray points || points.Count < 2 || points.Count > (type == "line" ? 2 : 64))
            throw new ArgumentException(type == "line" ? "A line needs exactly two points." : "A drawing path needs 2 to 64 points.");
        (double X, double Y)? previous = null;
        foreach (var point in points)
        {
            if (point is not JsonObject coordinates || coordinates.Count != 2 || !coordinates.ContainsKey("x") || !coordinates.ContainsKey("y"))
                throw new ArgumentException("Drawing points contain exactly x and y coordinates.");
            var x = Coordinate(coordinates["x"]); var y = Coordinate(coordinates["y"]);
            if (previous is { } before && before.X == x && before.Y == y)
                throw new ArgumentException("Consecutive drawing points must be distinct.");
            previous = (x, y);
        }
    }

    private static double Coordinate(JsonNode? value) => value is JsonValue scalar && scalar.TryGetValue<double>(out var number) && double.IsFinite(number) && number is >= 0 and <= 100
        ? number : throw new ArgumentException("Drawing point coordinates must be finite numbers from 0 to 100.");
}
