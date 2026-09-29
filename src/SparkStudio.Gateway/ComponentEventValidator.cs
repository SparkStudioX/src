using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Saved browser events and flat canvas groups share one publication contract.</summary>
internal static class ComponentEventValidator
{
    private static readonly Regex GroupIdentifier = new(@"\A[A-Za-z_][A-Za-z0-9_-]{0,63}\z", RegexOptions.CultureInvariant);

    public static void ValidateDocument(JsonObject document)
    {
        var groupCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var component in document["components"]!.AsArray().OfType<JsonObject>())
        {
            if (component.ContainsKey("groupId"))
            {
                if (component["groupId"] is not JsonValue value || !value.TryGetValue<string>(out var groupId) || !GroupIdentifier.IsMatch(groupId))
                    throw new ArgumentException("A group ID must contain 1 to 64 ASCII letters, digits, underscores or hyphens, starting with a letter or underscore.");
                groupCounts[groupId] = groupCounts.GetValueOrDefault(groupId) + 1;
            }
            if (component["props"] is not JsonObject props || !props.ContainsKey("events")) continue;
            if (!InputDefinitionValidator.IsInput(component["type"]!.GetValue<string>()))
                throw new ArgumentException("Browser change and commit events are supported only on input components.");
            if (props["events"] is not JsonObject events || events.Count > 2)
                throw new ArgumentException("Input events must be an object containing change and/or commit definitions.");
            foreach (var (name, node) in events)
            {
                if (name is not ("change" or "commit"))
                    throw new ArgumentException("Input event names must be change or commit.");
                if (node is not JsonObject definition || definition.Count != 2 ||
                    definition["language"] is not JsonValue language || !language.TryGetValue<string>(out var languageName) || languageName != "javascript" ||
                    definition["code"] is not JsonValue source || !source.TryGetValue<string>(out var code) || string.IsNullOrWhiteSpace(code) || code.Length > 65_536)
                    throw new ArgumentException("An input event needs exactly language 'javascript' and nonempty code up to 65,536 characters.");
            }
        }
        if (groupCounts.Any(pair => pair.Value < 2))
            throw new ArgumentException("Each canvas group must contain at least two components in the same screen or template.");
    }
}
