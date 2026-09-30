using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Bounded input rules shared by operator actions, bindings and Python UI assignments.</summary>
internal static class InputConstraints
{
    private static readonly HashSet<string> TextTypes = ["textInput", "formattedInput", "barcodeInput", "textArea", "passwordInput"];
    private static bool Email(string text)
    {
        var at = text.IndexOf('@'); var dot = text.LastIndexOf('.');
        return at > 0 && at == text.LastIndexOf('@') && dot > at + 1 && dot < text.Length - 1 &&
            !text.Any(character => InputDefinitionValidator.BlankOption(character.ToString()));
    }
    private readonly record struct Position(char Value, bool Literal);
    private static List<Position> Mask(string mask)
    {
        if (mask.Length is < 1 or > 256) throw new ArgumentException("Use a mask of 1–128 positions.");
        var positions = new List<Position>();
        for (var index = 0; index < mask.Length; index++)
        {
            var character = mask[index];
            var literal = character is not ('#' or 'A' or '*');
            if (character == '\\')
            {
                if (++index == mask.Length) throw new ArgumentException("A mask escape must be followed by a literal character.");
                character = mask[index]; literal = true;
            }
            if (character is < ' ' or > '~') throw new ArgumentException("Mask positions must use printable ASCII characters.");
            positions.Add(new(character, literal));
        }
        if (positions.Count > 128 || positions.All(position => position.Literal)) throw new ArgumentException("Use up to 128 positions including # (digit), A (letter), or * (letter/digit).");
        return positions;
    }
    private static string Text(JsonObject value, string name)
    {
        if (value[name] is not JsonValue scalar || !scalar.TryGetValue<string>(out var text)) throw new ArgumentException($"Input {name} must be text.");
        return text;
    }
    private static int? Bound(JsonObject value, string name)
    {
        if (!value.ContainsKey(name)) return null;
        if (value[name] is not JsonValue scalar || !scalar.TryGetValue<int>(out var bound) || bound is < 0 or > 4096) throw new ArgumentException("Text length bounds must be whole numbers from 0 to 4096.");
        return bound;
    }
    public static void ValidateDefinition(string type, JsonObject props)
    {
        if (props.ContainsKey("formatMask"))
        {
            if (type != "formattedInput") throw new ArgumentException("Masks belong to formatted inputs.");
            Mask(Text(props, "formatMask"));
        }
        if (props.ContainsKey("textCase") && (type != "formattedInput" || Text(props, "textCase") is not ("preserve" or "upper" or "lower"))) throw new ArgumentException("Choose a supported formatted-input letter case.");
        if (props.ContainsKey("scanTerminator") && (type != "barcodeInput" || Text(props, "scanTerminator") is not ("enter" or "tab"))) throw new ArgumentException("Choose Enter or Tab for the barcode terminator.");
        if (!props.ContainsKey("validation")) return;
        if (!InputDefinitionValidator.IsInput(type) || props["validation"] is not JsonObject validation || validation.Any(pair => pair.Key is not ("required" or "minLength" or "maxLength" or "format" or "message"))) throw new ArgumentException("Use a supported input validation definition.");
        if (validation.ContainsKey("required") && (validation["required"] is not JsonValue required || !required.TryGetValue<bool>(out _))) throw new ArgumentException("Required must be Boolean.");
        var minimum = Bound(validation, "minLength"); var maximum = Bound(validation, "maxLength");
        if ((minimum != null || maximum != null || validation.ContainsKey("format")) && !TextTypes.Contains(type)) throw new ArgumentException("Text length and format rules belong to text inputs.");
        if ((minimum ?? 0) > (maximum ?? 4096)) throw new ArgumentException("Minimum length cannot exceed maximum length.");
        if (validation.ContainsKey("format") && Text(validation, "format") is not ("text" or "email" or "digits" or "alphanumeric")) throw new ArgumentException("Choose a supported text validation format.");
        if (validation.ContainsKey("message") && Text(validation, "message").Length > 200) throw new ArgumentException("Validation messages must be text up to 200 characters.");
    }
    private static bool Letter(char value) => value is >= 'A' and <= 'Z' or >= 'a' and <= 'z';
    public static void ValidateValue(string key, string type, JsonObject props, JsonElement value)
    {
        var rules = props["validation"] as JsonObject;
        void Reject(string reason) => throw new ArgumentException($"Input field '{key}': {(rules?["message"]?.GetValue<string>() is { Length: > 0 } message ? message : reason)}");
        if (rules?["required"]?.GetValue<bool>() == true && (value.ValueKind is JsonValueKind.Null or JsonValueKind.False || value.ValueKind == JsonValueKind.String && InputDefinitionValidator.BlankOption(value.GetString()))) Reject("A value is required.");
        if (!TextTypes.Contains(type) || value.ValueKind != JsonValueKind.String) return;
        var text = value.GetString()!;
        if (text.Length < (rules?["minLength"]?.GetValue<int>() ?? 0)) Reject("The value is shorter than its minimum length.");
        if (text.Length > (rules?["maxLength"]?.GetValue<int>() ?? 4096)) Reject("The value exceeds its maximum length.");
        if (text.Length == 0) return;
        switch (rules?["format"]?.GetValue<string>())
        {
            case "email": if (!Email(text)) Reject("Enter an email address."); break;
            case "digits": if (text.Any(character => character is < '0' or > '9')) Reject("Use digits only."); break;
            case "alphanumeric": if (text.Any(character => !Letter(character) && character is not (>= '0' and <= '9'))) Reject("Use ASCII letters and digits only."); break;
        }
        if (type != "formattedInput") return;
        if (props["textCase"]?.GetValue<string>() == "upper" && text.Any(character => character is >= 'a' and <= 'z') || props["textCase"]?.GetValue<string>() == "lower" && text.Any(character => character is >= 'A' and <= 'Z')) Reject("The value does not match the configured letter case.");
        if (props["formatMask"] is not JsonValue mask) return;
        var positions = Mask(mask.GetValue<string>());
        if (positions.Count != text.Length) { Reject("Complete the configured input format."); return; }
        for (var index = 0; index < positions.Count; index++)
        {
            var part = positions[index]; var character = text[index];
            if (!(part.Literal ? part.Value == character : part.Value == '#' ? character is >= '0' and <= '9' : part.Value == 'A' ? Letter(character) : Letter(character) || character is >= '0' and <= '9')) Reject("Complete the configured input format.");
        }
    }
}
