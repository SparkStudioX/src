using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Bounded display states; indicator values never imply a device write.</summary>
internal static class StateControlValidator
{
    private static readonly Regex Color = new(@"\A#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\z", RegexOptions.CultureInvariant);

    public static void ValidateIndicator(JsonNode? value)
    {
        if (value is not JsonObject props) throw new ArgumentException("A multi-state indicator needs a properties object.");
        if (props.ContainsKey("tagPath")) throw new ArgumentException("Multi-state indicators read tags through a stateValue property binding.");
        if (props.ContainsKey("stateValue") && (props["stateValue"] is not JsonValue state || !state.TryGetValue<string>(out var text) || text.Length > 4096))
            throw new ArgumentException("An indicator state value must be text up to 4096 characters.");
        if (props["states"] is not JsonArray states || states.Count is < 1 or > 32)
            throw new ArgumentException("A multi-state indicator needs 1 to 32 states.");
        var values = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in states)
        {
            if (node is not JsonObject item || item.Count != 3 || item.Any(pair => pair.Key is not ("value" or "label" or "color")))
                throw new ArgumentException("Indicator states contain exactly value, label and color.");
            var key = Text(item, "value");
            Text(item, "label");
            if (!values.Add(key)) throw new ArgumentException("Indicator state values must be unique.");
            if (item["color"] is not JsonValue color || !color.TryGetValue<string>(out var colorText) || !Color.IsMatch(colorText))
                throw new ArgumentException("Indicator state colors must be hex colors: #RGB, #RGBA, #RRGGBB or #RRGGBBAA.");
        }
    }

    private static string Text(JsonObject owner, string key) => owner[key] is JsonValue value && value.TryGetValue<string>(out var text) &&
        !InputDefinitionValidator.BlankOption(text) && text.Length <= 128 ? text
        : throw new ArgumentException("Indicator state values and labels must be nonempty text up to 128 characters.");
}
