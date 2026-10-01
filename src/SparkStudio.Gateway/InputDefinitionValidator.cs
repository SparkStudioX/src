using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

/// <summary>One contract for saved definitions, publications and operator action values.</summary>
internal static class InputDefinitionValidator
{
    private const double MaximumSafeInteger = 9007199254740991;
    private static readonly HashSet<string> Types = new(StringComparer.Ordinal)
    {
        "textInput", "formattedInput", "barcodeInput", "textArea", "passwordInput", "computerCamera", "numberInput", "spinner", "slider", "checkbox", "toggle", "select", "list", "treeView", "radioGroup", "multiStateButton", "dateTimeInput"
    };
    private static readonly Regex FieldKey = new(@"\A[A-Za-z_][A-Za-z0-9_]{0,63}\z", RegexOptions.CultureInvariant);
    private static readonly Regex LocalDateTime = new(@"\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}\z", RegexOptions.CultureInvariant);

    public static bool IsInput(string type) => Types.Contains(type);
    public static bool IsQuerySelection(string? type) => type is "select" or "list" or "treeView";
    public static bool HasQueryOptions(JsonObject props) => props["optionsSource"] is JsonObject;

    public static void ValidateDefinition(string type, JsonObject props, HashSet<string> fields)
    {
        InputConstraints.ValidateDefinition(type, props);
        var key = ProjectStore.Required(props, "fieldKey");
        if (!FieldKey.IsMatch(key) || !fields.Add(key))
            throw new ArgumentException("Input field names must be unique within their screen or template and use letters, digits and underscores, starting with a letter or underscore.");
        if (type == "passwordInput")
        {
            if (props.ContainsKey("tagPath") || props.ContainsKey("optionsSource"))
                throw new ArgumentException("Password inputs cannot read saved tag or query values.");
            if (props.ContainsKey("defaultValue") && (props["defaultValue"] is not JsonValue initial || !initial.TryGetValue<string>(out var secret) || secret.Length != 0))
                throw new ArgumentException("A password input's saved default must be omitted or empty.");
        }
        if (type == "computerCamera")
        {
            if (props.ContainsKey("tagPath") || props.ContainsKey("optionsSource") || props.ContainsKey("selectionFields"))
                throw new ArgumentException("Computer cameras capture browser photos and cannot read tags, queries or selection mappings.");
            if (props.ContainsKey("defaultValue") && (props["defaultValue"] is not JsonValue initial || !initial.TryGetValue<string>(out var photo) || photo.Length != 0))
                throw new ArgumentException("A computer camera's saved default must be omitted or empty.");
        }
        if (props.ContainsKey("tagPath") && (props["tagPath"] is not JsonValue path || !path.TryGetValue<string>(out _)))
            throw new ArgumentException("An input tag binding must be text.");
        if (type is "numberInput" or "spinner" or "slider")
        {
            var minimum = NumberOption(props, "min");
            var maximum = NumberOption(props, "max");
            if (minimum > maximum) throw new ArgumentException("A numeric input's minimum cannot exceed its maximum.");
            if (type == "slider" && (minimum is null || maximum is null || minimum >= maximum))
                throw new ArgumentException("A slider requires finite minimum and maximum bounds with minimum below maximum.");
            var step = NumberOption(props, "step");
            if (step <= 0) throw new ArgumentException("A numeric input step must be a positive finite number.");
        }
        if (props.ContainsKey("optionsSource"))
        {
            var columns = type == "treeView" ? new[] { "queryId", "valueColumn", "labelColumn", "parentColumn" } : ["queryId", "valueColumn", "labelColumn"];
            if (!IsQuerySelection(type) || props["optionsSource"] is not JsonObject source || source.Count != columns.Length ||
                source.Any(pair => !columns.Contains(pair.Key, StringComparer.Ordinal)))
                throw new ArgumentException("Selection query sources need queryId, valueColumn and labelColumn; tree sources additionally require parentColumn.");
            foreach (var property in columns)
                if (source[property] is not JsonValue value || !value.TryGetValue<string>(out var text) ||
                    (type is "list" or "treeView" ? BlankOption(text) : string.IsNullOrWhiteSpace(text)) || text.Length > 128)
                    throw new ArgumentException("Selection query IDs and column names must be nonempty text up to 128 characters.");
        }
        if (type is "select" or "list" or "treeView" or "radioGroup" or "multiStateButton" && !HasQueryOptions(props))
        {
            var minimum = type == "multiStateButton" ? 2 : 1;
            var maximum = type == "multiStateButton" ? 32 : 100;
            if (props["options"] is not JsonArray options || options.Count < minimum || options.Count > maximum)
                throw new ArgumentException($"A {type} needs {minimum} to {maximum} options.");
            var values = new HashSet<string>(StringComparer.Ordinal);
            foreach (var option in options)
            {
                if (option is not JsonObject item) throw new ArgumentException("Selection options must be objects.");
                if (type is "list" or "treeView" && item.Any(pair => pair.Key is not ("value" or "label") && !(type == "treeView" && pair.Key == "parentValue")))
                    throw new ArgumentException("List options contain value and label; only tree options support parentValue.");
                if (type != "treeView" && item.ContainsKey("parentValue")) throw new ArgumentException("Only tree options support parentValue.");
                var value = type is "multiStateButton" or "list" or "treeView" ? StateOption(item, "value") : ProjectStore.Required(item, "value");
                var label = type is "multiStateButton" or "list" or "treeView" ? StateOption(item, "label") : ProjectStore.Required(item, "label");
                if (value.Length > 4096 || label.Length > 200 || !values.Add(value))
                    throw new ArgumentException("Selection options need unique nonempty values up to 4096 characters and labels up to 200 characters.");
            }
            if (type == "treeView") TreeSelectionValidator.ValidateStatic(options);
        }
        if (props.ContainsKey("defaultValue"))
        {
            // Explicit null is malformed. An omitted default means that the operator
            // action must supply the field, including a valid bound value.
            ValidateValue(key, type, props, JsonSerializer.SerializeToElement(props["defaultValue"]), enforceConstraints: false);
        }
    }

    public static void ValidateValue(string key, string type, JsonObject definition, JsonElement value, bool enforceConstraints = true)
    {
        switch (type)
        {
            case "computerCamera":
                if (value.ValueKind != JsonValueKind.String || value.GetString() is not { } photo || photo.Length > 4096 ||
                    photo.Length != 0 && (!photo.StartsWith("blob:", StringComparison.Ordinal) || !Uri.TryCreate(photo[5..], UriKind.Absolute, out var address) || address.Scheme is not ("http" or "https") || address.Host.Length == 0 || address.UserInfo.Length != 0 || address.Query.Length != 0 || address.Fragment.Length != 0 || address.AbsolutePath.Length <= 1 || photo.Any(char.IsWhiteSpace)))
                    throw new ArgumentException($"Input field '{key}' must be empty or a temporary browser photo URL.");
                break;
            case "textInput":
            case "formattedInput":
            case "barcodeInput":
            case "textArea":
            case "passwordInput":
                if (value.ValueKind != JsonValueKind.String || value.GetString()!.Length > 4096)
                    throw new ArgumentException($"Input field '{key}' must be text up to 4096 characters.");
                break;
            case "numberInput":
            case "spinner":
            case "slider":
                if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number) || !double.IsFinite(number))
                    throw new ArgumentException($"Input field '{key}' must be a finite number.");
                if (number == Math.Truncate(number) && Math.Abs(number) > MaximumSafeInteger)
                    throw new ArgumentException($"Input field '{key}' exceeds the browser's exact integer range.");
                if (number < NumberOption(definition, "min") || number > NumberOption(definition, "max"))
                    throw new ArgumentException($"Input field '{key}' is outside its permitted range.");
                // Step is an editing increment, not a divisibility constraint.
                break;
            case "checkbox":
            case "toggle":
                if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    throw new ArgumentException($"Input field '{key}' must be Boolean.");
                break;
            case "select":
            case "list":
            case "treeView":
            case "radioGroup":
            case "multiStateButton":
                if (IsQuerySelection(type) && HasQueryOptions(definition))
                {
                    // A draft can use an empty initial selection. Published actions
                    // additionally check membership using their captured read query.
                    if (value.ValueKind != JsonValueKind.String || value.GetString()!.Length > 4096)
                        throw new ArgumentException($"Input field '{key}' must be text up to 4096 characters.");
                    break;
                }
                if (value.ValueKind != JsonValueKind.String ||
                    !definition["options"]!.AsArray().OfType<JsonObject>().Any(option => option["value"]!.GetValue<string>() == value.GetString()))
                    throw new ArgumentException($"Input field '{key}' must match one of its permitted options.");
                break;
            case "dateTimeInput":
                if (value.ValueKind != JsonValueKind.String || !ValidLocalDateTime(value.GetString()!))
                    throw new ArgumentException($"Input field '{key}' must be empty or a valid local date and time in YYYY-MM-DDTHH:mm format, without a timezone.");
                break;
            default:
                throw new ArgumentException($"Input field '{key}' has an unsupported type.");
        }
        if (enforceConstraints) InputConstraints.ValidateValue(key, type, definition, value);
    }

    public static void ValidateSelectionMappings(IEnumerable<JsonObject> components, HashSet<string> fields)
    {
        foreach (var component in components)
        {
            var type = ProjectStore.Optional(component, "type");
            if (type != "table" && !IsQuerySelection(type) || component["props"] is not JsonObject props || !props.ContainsKey("selectionFields")) continue;
            if (type != "table" && !HasQueryOptions(props))
                throw new ArgumentException("Selection input mappings require a named-query options source.");
            if (props["selectionFields"] is not JsonObject mapping || mapping.Count > 64 ||
                mapping.Any(pair => !fields.Contains(pair.Key) || pair.Value is not JsonValue value || !value.TryGetValue<string>(out var column) || string.IsNullOrWhiteSpace(column) || column.Length > 128))
                throw new ArgumentException("Selection mappings target existing input fields and column names in the same screen or template.");
            if (type != "table" && mapping.ContainsKey(ProjectStore.Required(props, "fieldKey")))
                throw new ArgumentException("A selection mapping cannot overwrite its own input field.");
            if (type == "table" && mapping.Count > 0) ProjectStore.Required(props, "rowKey");
        }
    }

    public static void ValidateQuerySelection(string key, string type, JsonObject source, QueryResult result, string selected)
    {
        // Do not silently truncate a choice set: an operator must see the complete
        // set that the gateway validates. Connector results also reject truncation.
        if (result.Rows.Count > 500)
            throw new ArgumentException($"Selection '{key}' returned more than 500 options. Narrow its named query.");
        var valueColumn = ProjectStore.Required(source, "valueColumn");
        var labelColumn = ProjectStore.Required(source, "labelColumn");
        var parentColumn = type == "treeView" ? ProjectStore.Required(source, "parentColumn") : null;
        if (!result.Columns.Contains(valueColumn, StringComparer.Ordinal) || !result.Columns.Contains(labelColumn, StringComparer.Ordinal) ||
            parentColumn is not null && !result.Columns.Contains(parentColumn, StringComparer.Ordinal))
            throw new ArgumentException($"Selection '{key}' requires all configured value, label and parent columns.");
        var values = new HashSet<string>(StringComparer.Ordinal);
        var parents = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var row in result.Rows)
        {
            if (!row.TryGetValue(valueColumn, out var rawValue) || !row.TryGetValue(labelColumn, out var rawLabel))
                throw new ArgumentException($"Selection '{key}' returned an incomplete option.");
            var value = OptionText(rawValue);
            var label = OptionText(rawLabel);
            if (BlankOption(value) || value!.Length > 4096 || BlankOption(label) || label!.Length > 200 || !values.Add(value))
                throw new ArgumentException($"Selection '{key}' requires unique nonempty values up to 4096 characters and nonempty labels up to 200 characters, each text or a finite number.");
            if (parentColumn is not null)
            {
                if (!row.TryGetValue(parentColumn, out var rawParent)) throw new ArgumentException($"Tree '{key}' returned an incomplete parent column.");
                var parent = rawParent is null ? "" : OptionText(rawParent);
                if (parent is null || parent.Length > 4096) throw new ArgumentException($"Tree '{key}' parent values must be null, text or an exact finite number.");
                parents.Add(value, parent.Length == 0 ? null : parent);
            }
        }
        if (parentColumn is not null) TreeSelectionValidator.Validate(parents);
        if (!values.Contains(selected))
            throw new ArgumentException($"Input field '{key}' no longer matches its query options. Refresh and select an available option.");
    }

    // ECMAScript String.trim whitespace, including BOM but excluding NEL. This
    // matches the operator's option validation without changing stored values.
    internal static bool BlankOption(string? value) => value is null || value.All(character =>
        character is >= '\u0009' and <= '\u000d' or '\u0020' or '\u00a0' or '\u1680'
            or >= '\u2000' and <= '\u200a' or '\u2028' or '\u2029' or '\u202f' or '\u205f' or '\u3000' or '\ufeff');

    private static string StateOption(JsonObject item, string key) => item[key] is JsonValue value && value.TryGetValue<string>(out var text) && !BlankOption(text)
        ? text : throw new ArgumentException("State-button option values and labels must be nonempty text.");

    internal static string? OptionText(object? value)
    {
        if (value is string text) return text;
        if (value is not (byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal)) return null;
        if (!double.IsFinite(Convert.ToDouble(value, CultureInfo.InvariantCulture))) return null;
        // JSON writes Single/Decimal with their own round-trip representation;
        // interpreting that JSON as Double mirrors JavaScript's wire decoding.
        var number = JsonSerializer.SerializeToElement(value).GetDouble();
        if (!double.IsFinite(number) || number == Math.Truncate(number) && Math.Abs(number) > MaximumSafeInteger) return null;
        if (number == 0) return "0";
        // Match browser String(number): shortest round-trip digits, fixed notation
        // from 1e-6 through values below 1e21, otherwise a normalized exponent.
        var formatted = Math.Abs(number).ToString("R", CultureInfo.InvariantCulture);
        var pieces = formatted.Split('E', 'e');
        var exponent = pieces.Length == 2 ? int.Parse(pieces[1], CultureInfo.InvariantCulture) : 0;
        var point = pieces[0].IndexOf('.');
        var digits = pieces[0].Replace(".", "");
        var decimalPosition = (point < 0 ? digits.Length : point) + exponent;
        while (digits.Length > 1 && digits[^1] == '0') digits = digits[..^1];
        string normalized;
        if (Math.Abs(number) >= 1e-6 && Math.Abs(number) < 1e21)
            normalized = decimalPosition <= 0 ? "0." + new string('0', -decimalPosition) + digits
                : decimalPosition >= digits.Length ? digits + new string('0', decimalPosition - digits.Length)
                : digits.Insert(decimalPosition, ".");
        else
        {
            var power = decimalPosition - 1;
            normalized = digits.Length == 1 ? digits : digits.Insert(1, ".");
            normalized += "e" + (power >= 0 ? "+" : "") + power.ToString(CultureInfo.InvariantCulture);
        }
        return number < 0 ? "-" + normalized : normalized;
    }

    private static double? NumberOption(JsonObject props, string key)
    {
        if (!props.ContainsKey(key)) return null;
        if (props[key] is not JsonValue value || !value.TryGetValue<double>(out var number) || !double.IsFinite(number))
            throw new ArgumentException($"Numeric input {key} must be a finite number.");
        if (key is "min" or "max" && number == Math.Truncate(number) && Math.Abs(number) > MaximumSafeInteger)
            throw new ArgumentException($"Numeric input {key} exceeds the browser's exact integer range.");
        return number;
    }

    private static bool ValidLocalDateTime(string value) => value.Length == 0 ||
        LocalDateTime.IsMatch(value) && DateTime.TryParseExact(value, "yyyy-MM-dd'T'HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out _);
}
