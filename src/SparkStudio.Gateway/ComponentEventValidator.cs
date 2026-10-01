using System.Text.Json.Nodes;
using System.Globalization;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Saved browser events and flat canvas groups share one publication contract.</summary>
internal static class ComponentEventValidator
{
    internal static readonly HashSet<string> InteractionNames = new(StringComparer.Ordinal) { "focus", "blur", "keyDown", "keyUp", "doubleClick", "pointerDown", "pointerUp" };
    private static readonly Regex GroupIdentifier = new(@"\A[A-Za-z_][A-Za-z0-9_-]{0,63}\z", RegexOptions.CultureInvariant);
    private static readonly Regex MessageHandlerIdentifier = new(@"\A[A-Za-z_][A-Za-z0-9_-]{0,79}\z", RegexOptions.CultureInvariant);

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
            if (props.ContainsKey("messageHandlers")) ValidateMessageHandlers(props["messageHandlers"]);
            if (ProjectStore.Optional(component, "type") == "passwordInput" && props["events"] is JsonObject inputEvents &&
                inputEvents.Any(pair => pair.Value is JsonObject item && ProjectStore.Optional(item, "language") == "python"))
                throw new ArgumentException("Password change/commit events remain browser-only. Automatic Python events never receive password input values; submit a password explicitly with a Python button.");
            if (props.ContainsKey("message") || ProjectStore.Optional(props, "action") == "message")
            {
                if (ProjectStore.Optional(component, "type") != "button") throw new ArgumentException("Native message actions are supported only on buttons.");
                ValidateMessageAction(props["message"]);
            }
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
                    definition["language"] is not JsonValue language || !language.TryGetValue<string>(out var languageName) || languageName is not ("javascript" or "python") ||
                    definition["code"] is not JsonValue source || !source.TryGetValue<string>(out var code) || string.IsNullOrWhiteSpace(code) || code.Length > 65_536)
                    throw new ArgumentException("An input event needs exactly language 'javascript' or 'python' and nonempty code up to 65,536 characters.");
            }
        }
        if (groupCounts.Any(pair => pair.Value < 2))
            throw new ArgumentException("Each canvas group must contain at least two components in the same screen or template.");
    }

    internal static void RejectMisplaced(JsonObject value)
    {
        if (value.ContainsKey("componentEvents"))
            throw new ArgumentException("Component lifecycle events belong only in a component's props.componentEvents object.");
        if (value.ContainsKey("messageHandlers"))
            throw new ArgumentException("Component message handlers belong only in a component's props.messageHandlers array.");
    }

    private static void ValidateMessageHandlers(JsonNode? raw)
    {
        if (raw is not JsonArray handlers || handlers.Count > 16)
            throw new ArgumentException("Component message handlers must be an array of at most 16 definitions.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var subscriptions = new HashSet<(string MessageType, string Scope)>();
        foreach (var node in handlers)
        {
            if (node is not JsonObject handler || handler.Count != 5 ||
                handler.Any(pair => pair.Key is not ("id" or "messageType" or "scope" or "language" or "code")))
                throw new ArgumentException("A component message handler needs exactly id, messageType, scope, language and code.");
            if (handler["id"] is not JsonValue idValue || !idValue.TryGetValue<string>(out var id) || !MessageHandlerIdentifier.IsMatch(id) || !ids.Add(id))
                throw new ArgumentException("Message handler IDs must be unique within a component and contain 1 to 80 ASCII letters, digits, underscores or hyphens, starting with a letter or underscore.");
            var messageType = MessageType(handler["messageType"]);
            var scope = MessageScope(handler["scope"]);
            if (!subscriptions.Add((messageType, scope)))
                throw new ArgumentException("A component can subscribe to each message type and scope only once.");
            if (handler["language"] is not JsonValue languageValue || !languageValue.TryGetValue<string>(out var language) || language is not ("javascript" or "python") ||
                handler["code"] is not JsonValue codeValue || !codeValue.TryGetValue<string>(out var code) || code.Length > 65_536 ||
                !code.Any(character => character != '\uFEFF' && (character == '\u0085' || !char.IsWhiteSpace(character))))
                throw new ArgumentException("A component message handler needs language 'javascript' or 'python' and nonempty code up to 65,536 characters.");
        }
    }

    internal static void ValidateMessageAction(JsonNode? raw)
    {
        if (raw is not JsonObject message || message.Count != 3 || message.Any(pair => pair.Key is not ("messageType" or "scope" or "payload")))
            throw new ArgumentException("A message action needs exactly messageType, scope and payload.");
        MessageType(message["messageType"]);
        MessageScope(message["scope"]);
        if (message["payload"] is not JsonObject payload)
            throw new ArgumentException("A message payload must be a JSON object.");
        var nodes = 0;
        long bytes = 0;
        void Validate(JsonNode? value, int depth)
        {
            if (++nodes > 4096 || depth > 16) throw new ArgumentException("Message payloads support at most 4,096 values and 16 nested levels.");
            if (value is null) { bytes += 4; return; }
            if (value is JsonObject obj)
            {
                bytes += 2 + Math.Max(0, obj.Count - 1);
                foreach (var pair in obj) { bytes += JsonStringBytes(pair.Key) + 1; Validate(pair.Value, depth + 1); }
                return;
            }
            if (value is JsonArray array)
            {
                bytes += 2 + Math.Max(0, array.Count - 1);
                foreach (var item in array) Validate(item, depth + 1);
                return;
            }
            if (value is JsonValue scalar)
            {
                if (scalar.TryGetValue<string>(out var text)) { bytes += JsonStringBytes(text); return; }
                if (scalar.TryGetValue<bool>(out var flag)) { bytes += flag ? 4 : 5; return; }
            }
            var number = System.Text.Json.JsonSerializer.SerializeToElement(value);
            if (number.ValueKind == System.Text.Json.JsonValueKind.Number && number.TryGetDouble(out var numeric) && double.IsFinite(numeric) &&
                (Math.Truncate(numeric) != numeric || Math.Abs(numeric) <= 9007199254740991d)) { bytes += JsonNumberBytes(numeric); return; }
            throw new ArgumentException("Message payloads must contain JSON values with finite numbers and exact safe integers.");
        }
        Validate(payload, 0);
        if (bytes > 65_536) throw new ArgumentException("Message payloads are limited to 64 KiB of UTF-8 JSON.");
    }

    // Match JSON.stringify's UTF-8 representation, including literal supplementary
    // characters. System.Text.Json escapes those even with UnsafeRelaxedJsonEscaping.
    internal static long JsonStringBytes(string text)
    {
        long bytes = 2;
        for (var index = 0; index < text.Length; index++)
        {
            var character = text[index];
            if (character is '"' or '\\' or '\b' or '\t' or '\n' or '\f' or '\r') bytes += 2;
            else if (character < 32) bytes += 6;
            else if (char.IsHighSurrogate(character) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1])) { bytes += 4; index++; }
            else if (char.IsSurrogate(character)) bytes += 6;
            else bytes += character <= 0x7f ? 1 : character <= 0x7ff ? 2 : 3;
        }
        return bytes;
    }

    internal static int JsonNumberBytes(double number)
    {
        if (number == 0) return 1; // JSON.stringify normalizes negative zero.
        var sign = number < 0 ? 1 : 0;
        var text = Math.Abs(number).ToString("R", CultureInfo.InvariantCulture);
        var exponentAt = text.IndexOf('E');
        var exponent = exponentAt < 0 ? 0 : int.Parse(text[(exponentAt + 1)..], CultureInfo.InvariantCulture);
        var mantissa = exponentAt < 0 ? text : text[..exponentAt];
        var decimalAt = mantissa.IndexOf('.');
        var digits = mantissa.Replace(".", "", StringComparison.Ordinal);
        var position = (decimalAt < 0 ? mantissa.Length : decimalAt) + exponent;
        // JavaScript chooses decimal notation from 1e-6 (inclusive) to 1e21
        // (exclusive); scientific notation has lowercase e and no padded exponent.
        if (number is > -1e21 and < 1e21 && Math.Abs(number) >= 1e-6)
            return sign + (position <= 0 ? 2 - position + digits.Length : position >= digits.Length ? position : digits.Length + 1);
        var first = 0;
        while (first < digits.Length - 1 && digits[first] == '0') first++;
        var scientificExponent = position - first - 1;
        var significant = digits.Length - first;
        return sign + significant + (significant > 1 ? 1 : 0) + 2 + Math.Abs(scientificExponent).ToString(CultureInfo.InvariantCulture).Length;
    }

    private static string MessageType(JsonNode? raw)
    {
        if (raw is not JsonValue value || !value.TryGetValue<string>(out var text) || text.Length is < 1 or > 80 ||
            text != text.Trim() || text[0] == '\uFEFF' || text[^1] == '\uFEFF' || text.Any(char.IsControl))
            throw new ArgumentException("Message types must be trimmed text of 1 to 80 characters without control characters.");
        return text;
    }

    private static string MessageScope(JsonNode? raw) => raw is JsonValue value && value.TryGetValue<string>(out var scope) && scope is "instance" or "screen" or "session"
        ? scope : throw new ArgumentException("Component message scope must be instance, screen or session.");

    private static void ValidateLifecycle(string type, JsonNode? raw)
    {
        if (raw is not JsonObject events || events.Count > 10)
            throw new ArgumentException("Component events must contain supported lifecycle, property-change or interaction definitions.");
        foreach (var (name, node) in events)
        {
            if (name is not ("mount" or "unmount" or "propertyChange") && !InteractionNames.Contains(name))
                throw new ArgumentException("Component event names must be mount, unmount, propertyChange, focus, blur, keyDown, keyUp, doubleClick, pointerDown or pointerUp.");
            var watched = name == "propertyChange";
            if (node is not JsonObject definition || definition.Count != (watched ? 3 : 2) ||
                definition.Any(pair => pair.Key is not ("language" or "code") && !(watched && pair.Key == "properties")) ||
                definition["language"] is not JsonValue language || !language.TryGetValue<string>(out var languageName) || languageName is not ("javascript" or "python") ||
                definition["code"] is not JsonValue source || !source.TryGetValue<string>(out var code) || code.Length > 65_536 ||
                !code.Any(character => character != '\uFEFF' && (character == '\u0085' || !char.IsWhiteSpace(character))))
                throw new ArgumentException("Component events need JavaScript or Python with nonempty code up to 65,536 characters; propertyChange also needs properties.");
            if (!watched) continue;
            if (definition["properties"] is not JsonArray properties || properties.Count is < 1 or > 16)
                throw new ArgumentException("A propertyChange event must watch 1 to 16 supported scalar properties.");
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in properties)
            {
                if (property is not JsonValue value || !value.TryGetValue<string>(out var target) || !seen.Add(target) ||
                    type == "passwordInput" && (target == "value" || languageName == "python" && target == "text") ||
                    !(ComponentBindingValidator.SupportsLegacyScalarTarget(type, target) ||
                        target == "value" && type != "passwordInput" && InputDefinitionValidator.IsInput(type)))
                    throw new ArgumentException($"Watched properties must be unique scalar targets supported on {type}; password values cannot be watched.");
            }
        }
    }
}
