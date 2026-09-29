using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Saved browser events and flat canvas groups share one publication contract.</summary>
internal static class ComponentEventValidator
{
    private static readonly Regex GroupIdentifier = new(@"\A[A-Za-z_][A-Za-z0-9_-]{0,63}\z", RegexOptions.CultureInvariant);

    public static void ValidateDocument(JsonObject document)
    {
        RejectMisplaced(document);
        var groupCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var component in document["components"]!.AsArray().OfType<JsonObject>())
        {
            RejectMisplaced(component);
            if (component.ContainsKey("groupId"))
            {
                if (component["groupId"] is not JsonValue value || !value.TryGetValue<string>(out var groupId) || !GroupIdentifier.IsMatch(groupId))
                    throw new ArgumentException("A group ID must contain 1 to 64 ASCII letters, digits, underscores or hyphens, starting with a letter or underscore.");
                groupCounts[groupId] = groupCounts.GetValueOrDefault(groupId) + 1;
            }
            if (component["props"] is not JsonObject props) continue;
            if (props.ContainsKey("componentEvents")) ValidateLifecycle(component["type"]!.GetValue<string>(), props["componentEvents"]);
            if (!props.ContainsKey("events")) continue;
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

    internal static void RejectMisplaced(JsonObject value)
    {
        if (value.ContainsKey("componentEvents"))
            throw new ArgumentException("Component lifecycle events belong only in a component's props.componentEvents object.");
    }

    private static void ValidateLifecycle(string type, JsonNode? raw)
    {
        if (raw is not JsonObject events || events.Count > 3)
            throw new ArgumentException("Component lifecycle events must be an object containing mount, unmount and/or propertyChange definitions.");
        foreach (var (name, node) in events)
        {
            if (name is not ("mount" or "unmount" or "propertyChange"))
                throw new ArgumentException("Component lifecycle event names must be mount, unmount or propertyChange.");
            var watched = name == "propertyChange";
            if (node is not JsonObject definition || definition.Count != (watched ? 3 : 2) ||
                definition.Any(pair => pair.Key is not ("language" or "code") && !(watched && pair.Key == "properties")) ||
                definition["language"] is not JsonValue language || !language.TryGetValue<string>(out var languageName) || languageName != "javascript" ||
                definition["code"] is not JsonValue source || !source.TryGetValue<string>(out var code) || code.Length > 65_536 ||
                !code.Any(character => character != '\uFEFF' && (character == '\u0085' || !char.IsWhiteSpace(character))))
                throw new ArgumentException("A component lifecycle event needs language 'javascript' and nonempty code up to 65,536 characters; propertyChange also needs properties.");
            if (!watched) continue;
            if (definition["properties"] is not JsonArray properties || properties.Count is < 1 or > 16)
                throw new ArgumentException("A propertyChange event must watch 1 to 16 supported scalar properties.");
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in properties)
            {
                if (property is not JsonValue value || !value.TryGetValue<string>(out var target) || !seen.Add(target) ||
                    !(ComponentBindingValidator.SupportsTarget(type, target) ||
                        target == "value" && type != "passwordInput" && InputDefinitionValidator.IsInput(type)))
                    throw new ArgumentException($"Watched properties must be unique scalar targets supported on {type}; password values cannot be watched.");
            }
        }
    }
}
