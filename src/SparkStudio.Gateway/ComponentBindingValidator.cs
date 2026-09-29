using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Bounds and syntax for declarative component bindings; no executable script is accepted here.</summary>
internal static class ComponentBindingValidator
{
    private const double MaximumSafeInteger = 9007199254740991;
    private static readonly HashSet<string> Targets = new(StringComparer.Ordinal)
    {
        "text", "enabled", "visible", "color", "x", "y", "width", "height", "fontSize",
        "backgroundColor", "foregroundColor", "borderColor", "borderWidth", "tagPath", "stateValue",
        "value", "min", "max", "decimals", "unit", "showValue", "showPercent", "orientation",
        "strokeColor", "strokeWidth", "fillColor", "rotation", "flowing", "flowReverse", "active"
    };
    private static readonly Regex HexColor = new(@"\A#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\z", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> Reserved = new(StringComparer.Ordinal) { "__proto__", "constructor", "prototype", "true", "false", "null" };
    private static readonly Regex Identifier = new(@"\A[A-Za-z_][A-Za-z0-9_]{0,63}\z", RegexOptions.CultureInvariant);
    private static readonly Regex TagParameter = new(@"\{([^{}]+)\}", RegexOptions.CultureInvariant);

    internal static bool SupportsTarget(string type, string target) => Targets.Contains(target)
        && (!ProcessDisplayValidator.Targets.Contains(target) || ProcessDisplayValidator.Supports(type, target))
        && (!DrawingComponentValidator.Targets.Contains(target) || DrawingComponentValidator.Supports(type, target))
        && (target != "stateValue" || type == "multiStateIndicator")
        && (target != "tagPath" || type is "value" or "gauge");

    public static void ValidateDocument(JsonObject document, JsonObject? projectParameters, JsonObject? sessionState, bool template)
    {
        var components = document["components"]!.AsArray().OfType<JsonObject>().ToDictionary(item => item["id"]!.GetValue<string>(), StringComparer.Ordinal);
        var inputs = components.Values.Where(item => InputDefinitionValidator.IsInput(Text(item, "type", 64)))
            .Select(item => Text(item["props"]!.AsObject(), "fieldKey", 64)).ToHashSet(StringComparer.Ordinal);
        var parameters = (projectParameters?.Select(pair => pair.Key) ?? [])
            .Concat((document["parameters"] as JsonObject)?.Select(pair => pair.Key) ?? []).ToHashSet(StringComparer.Ordinal);
        foreach (var component in components.Values)
        {
            if (component["props"] is not JsonObject props) continue;
            foreach (var flag in new[] { "enabled", "visible" })
            {
                if (!props.ContainsKey(flag)) continue;
                if (props[flag] is not JsonValue value || !value.TryGetValue<bool>(out _))
                    throw new ArgumentException($"Component {flag} must be Boolean.");
            }
            foreach (var name in new[] { "backgroundColor", "foregroundColor", "borderColor" })
                if (props.ContainsKey(name) && (props[name] is not JsonValue color || !color.TryGetValue<string>(out var text) || !HexColor.IsMatch(text)))
                    throw new ArgumentException($"Component {name} must be a hex color: #RGB, #RGBA, #RRGGBB or #RRGGBBAA.");
            ValidateNumber(props, "fontSize", 1, 256);
            ValidateNumber(props, "borderWidth", 0, 32);
            if (props.ContainsKey("customProperties")) ValidateCustomProperties(props["customProperties"]);
        }
        foreach (var component in components.Values)
        {
            if (component["props"] is not JsonObject props || !props.ContainsKey("bindings")) continue;
            if (props["bindings"] is not JsonObject bindings || bindings.Count > Targets.Count)
                throw new ArgumentException($"Component bindings must be an object with up to {Targets.Count} supported targets.");
            var type = Text(component, "type", 64);
            var constants = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var (target, raw) in bindings)
            {
                if (!SupportsTarget(type, target))
                    throw new ArgumentException($"The {target} binding is not supported on {type}.");
                if (raw is not JsonObject binding || binding.Any(pair => pair.Key is not ("expression" or "references")))
                    throw new ArgumentException("A binding needs an expression and reference map.");
                var expression = Text(binding, "expression", 2048);
                if (binding["references"] is not JsonObject references || references.Count > 32)
                    throw new ArgumentException("A binding can contain at most 32 references.");
                foreach (var (name, referenceNode) in references)
                {
                    if (!ValidIdentifier(name) || referenceNode is not JsonObject reference)
                        throw new ArgumentException("References need valid identifier names and definitions.");
                    var kind = Text(reference, "kind", 32);
                    var allowed = kind == "custom" ? new[] { "kind", "key", "componentId" } : kind == "tag" ? ["kind", "path"] : ["kind", "key"];
                    if (reference.Any(pair => !allowed.Contains(pair.Key, StringComparer.Ordinal)))
                        throw new ArgumentException($"Reference '{name}' has unsupported fields.");
                    switch (kind)
                    {
                        case "custom":
                            var key = Key(reference);
                            var owner = component;
                            if (reference.ContainsKey("componentId"))
                            {
                                var id = Text(reference, "componentId", 256);
                                if (!SafeKey(id) || !components.TryGetValue(id, out owner))
                                    throw new ArgumentException("Custom property references must stay within their screen or template.");
                            }
                            if (!ValidIdentifier(key) || owner["props"]?["customProperties"] is not JsonObject customs || !customs.ContainsKey(key))
                                throw new ArgumentException($"Custom property '{key}' was not found in the referenced component.");
                            break;
                        case "input":
                            if (!inputs.Contains(Key(reference))) throw new ArgumentException("Input references must name an input in the same screen or template.");
                            break;
                        case "parameter":
                            if (!parameters.Contains(Key(reference))) throw new ArgumentException("Parameter references must name a declared project, screen or template parameter.");
                            break;
                        case "sessionState":
                        case "screenState":
                        case "instanceState":
                            ProjectStateValidator.ValidateReference(kind, Key(reference), sessionState, document, template);
                            break;
                        case "tag":
                            var path = Text(reference, "path", 1024);
                            foreach (Match match in TagParameter.Matches(path))
                                if (!SafeKey(match.Groups[1].Value) || !parameters.Contains(match.Groups[1].Value))
                                    throw new ArgumentException("Tag path parameters must name declared parameters.");
                            break;
                        default: throw new ArgumentException("References support custom properties, inputs, parameters, tags, session state, screen state and private instance state.");
                    }
                }
                var parser = new ExpressionParser(expression, references.Select(pair => pair.Key).ToHashSet(StringComparer.Ordinal));
                parser.Validate();
                if (ProcessDisplayValidator.Targets.Contains(target) && parser.TryConstant(out var constant))
                {
                    ProcessDisplayValidator.ValidateResult(target, constant!);
                    constants.Add(target, constant!);
                }
                if ((DrawingComponentValidator.Targets.Contains(target) || target == "color" && DrawingComponentValidator.Types.Contains(type)) && parser.TryConstant(out var drawingConstant))
                    DrawingComponentValidator.ValidateResult(target, drawingConstant!);
            }
            ProcessDisplayValidator.ValidateConstantRange(type, props, constants);
        }
    }

    internal static (bool Constant, object? Value) ValidateExpression(string expression, IEnumerable<string> references)
    {
        if (!HasContent(expression) || expression.Length > 2048)
            throw new ArgumentException("An expression needs 1 to 2048 characters.");
        var parser = new ExpressionParser(expression, references.ToHashSet(StringComparer.Ordinal));
        parser.Validate();
        var constant = parser.TryConstant(out var value);
        return (constant, value);
    }

    internal static JsonElement EvaluateExpression(string expression, IEnumerable<string> references, Func<string, JsonElement> resolve)
    {
        var parser = new ExpressionParser(expression, references.ToHashSet(StringComparer.Ordinal), name =>
        {
            var value = resolve(name);
            return value.ValueKind switch
            {
                JsonValueKind.String when value.GetString()!.Length <= 4096 => value.GetString()!,
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                JsonValueKind.Number when value.TryGetDouble(out var number) && SafeNumber(number) => number,
                _ => throw new ArgumentException("Binding references must contain bounded text, Boolean values or exact finite numbers.")
            };
        });
        parser.Validate();
        return JsonSerializer.SerializeToElement(parser.Evaluate());
    }

    private static void ValidateNumber(JsonObject props, string key, double minimum, double maximum)
    {
        if (!props.ContainsKey(key)) return;
        if (props[key] is not JsonValue value || !value.TryGetValue<double>(out var number) || !double.IsFinite(number) || number < minimum || number > maximum)
            throw new ArgumentException($"Component {key} must be a finite number between {minimum} and {maximum}.");
    }

    private static void ValidateCustomProperties(JsonNode? raw)
    {
        if (raw is not JsonObject properties || properties.Count > 32)
            throw new ArgumentException("A component can contain at most 32 custom properties.");
        foreach (var (key, node) in properties)
        {
            if (!ValidIdentifier(key) || node is not JsonObject definition || definition.Any(pair => pair.Key is not ("type" or "value")))
                throw new ArgumentException("Custom properties need valid identifier names, a type and a value.");
            var type = Text(definition, "type", 16);
            if (definition["value"] is not JsonValue value || !(type switch
                {
                    "string" => value.TryGetValue<string>(out var text) && text.Length <= 4096,
                    "number" => value.TryGetValue<double>(out var number) && SafeNumber(number),
                    "boolean" => value.TryGetValue<bool>(out _),
                    _ => false
                })) throw new ArgumentException($"Custom property '{key}' must match its declared number, string or Boolean type.");
        }
    }

    private static bool ValidIdentifier(string key) => Identifier.IsMatch(key) && !Reserved.Contains(key);
    private static bool SafeNumber(double value) => double.IsFinite(value) && (value != Math.Truncate(value) || Math.Abs(value) <= MaximumSafeInteger);
    // Keep whitespace recognition aligned with the browser's ECMAScript lexer
    // and String.trim, including BOM and excluding the Unicode NEL character.
    private static bool ExpressionSpace(char value) => value == '\uFEFF' || value != '\u0085' && char.IsWhiteSpace(value);
    private static bool HasContent(string value) => value.Any(character => !ExpressionSpace(character));
    private static bool SafeKey(string key) => HasContent(key) && key.Length <= 256 && key is not ("__proto__" or "constructor" or "prototype");
    private static string Key(JsonObject value)
    {
        var key = Text(value, "key", 256);
        return SafeKey(key) ? key : throw new ArgumentException("A binding reference key is invalid.");
    }
    private static string Text(JsonObject owner, string key, int maximum) => owner[key] is JsonValue value && value.TryGetValue<string>(out var text) &&
        HasContent(text) && text.Length <= maximum ? text : throw new ArgumentException($"Binding {key} must be nonempty text up to {maximum} characters.");

    // The gateway checks the browser's bounded primitive grammar. Only constant
    // expressions for constrained display properties are evaluated; references
    // never read runtime data during saving, import or publication.
    private sealed class ExpressionParser
    {
        private readonly List<Token> tokens = [];
        private readonly HashSet<string> references;
        private int position;
        private Parsed? parsed;
        private readonly Func<string, object>? resolve;
        private readonly record struct Token(string Kind, string Value, object? Scalar = null);
        private sealed record Parsed(int Height, bool Dynamic, Func<object> Evaluate);
        private static readonly Dictionary<string, int> Precedence = new(StringComparer.Ordinal)
        {
            ["||"] = 1, ["&&"] = 2, ["=="] = 3, ["!="] = 3, ["==="] = 3, ["!=="] = 3,
            ["<"] = 4, ["<="] = 4, [">"] = 4, [">="] = 4, ["+"] = 5, ["-"] = 5, ["*"] = 6, ["/"] = 6, ["%"] = 6
        };
        private static readonly Regex Number = new(@"\A(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", RegexOptions.CultureInvariant);
        private static readonly Regex Name = new(@"\A[A-Za-z_][A-Za-z0-9_]*", RegexOptions.CultureInvariant);
        private static readonly Regex Operator = new(@"\A(?:===|!==|==|!=|<=|>=|&&|\|\||[()+\-*/%<>!?:])", RegexOptions.CultureInvariant);

        public ExpressionParser(string expression, HashSet<string> references, Func<string, object>? resolve = null)
        {
            this.references = references;
            this.resolve = resolve;
            for (var index = 0; index < expression.Length;)
            {
                if (ExpressionSpace(expression[index])) { index++; continue; }
                if (tokens.Count >= 256) throw new ArgumentException("An expression can contain at most 256 tokens.");
                var ch = expression[index];
                if (ch is '\'' or '"')
                {
                    var quote = ch;
                    var closed = false;
                    var decoded = new StringBuilder();
                    index++;
                    while (index < expression.Length)
                    {
                        var next = expression[index++];
                        if (next == quote) { closed = true; break; }
                        if (next < 32) throw new ArgumentException("String literals cannot contain unescaped control characters.");
                        if (next != '\\') { decoded.Append(next); continue; }
                        if (index >= expression.Length) throw new ArgumentException("Invalid string escape.");
                        var escape = expression[index++];
                        if (escape == 'u')
                        {
                            if (index + 4 > expression.Length || !expression.AsSpan(index, 4).ToArray().All(Uri.IsHexDigit))
                                throw new ArgumentException("Invalid Unicode escape.");
                            decoded.Append((char)ushort.Parse(expression.AsSpan(index, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            index += 4;
                        }
                        else if (!"nrtbf\\\"'/".Contains(escape)) throw new ArgumentException("Invalid string escape.");
                        else decoded.Append(escape switch { 'n' => '\n', 'r' => '\r', 't' => '\t', 'b' => '\b', 'f' => '\f', _ => escape });
                    }
                    if (!closed) throw new ArgumentException("Unclosed string literal.");
                    tokens.Add(new("literal", "string", decoded.ToString())); continue;
                }
                var tail = expression[index..];
                var number = Number.Match(tail);
                if (number.Success)
                {
                    if (!double.TryParse(number.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var scalar) || !SafeNumber(scalar))
                        throw new ArgumentException("Numeric literals must be finite and within the exact integer range.");
                    tokens.Add(new("literal", "number", scalar)); index += number.Length; continue;
                }
                var name = Name.Match(tail);
                if (name.Success)
                {
                    if (name.Value is "true" or "false") tokens.Add(new("literal", "boolean", name.Value == "true"));
                    else
                    {
                        if (!ValidIdentifier(name.Value) || !references.Contains(name.Value)) throw new ArgumentException($"Reference '{name.Value}' is invalid or not declared.");
                        tokens.Add(new("identifier", name.Value));
                    }
                    index += name.Length; continue;
                }
                var op = Operator.Match(tail);
                if (!op.Success) throw new ArgumentException($"Unsupported expression character at position {index + 1}.");
                tokens.Add(new("operator", op.Value)); index += op.Length;
            }
        }

        public void Validate()
        {
            parsed = Parse();
            if (position != tokens.Count) throw new ArgumentException("Unexpected text after the expression.");
        }
        public bool TryConstant(out object? value)
        {
            if (parsed is null) throw new InvalidOperationException("Validate the expression before evaluating a constant.");
            value = parsed.Dynamic ? null : parsed.Evaluate();
            return !parsed.Dynamic;
        }
        public object Evaluate() => Scalar(parsed?.Evaluate() ?? throw new InvalidOperationException("Validate the expression before evaluation."));
        private bool Matches(string value) => position < tokens.Count && tokens[position].Kind == "operator" && tokens[position].Value == value;
        private void Consume(string value)
        {
            if (!Matches(value)) throw new ArgumentException($"Expected '{value}'.");
            position++;
        }
        private Parsed Parse(int minimum = 0, int depth = 0)
        {
            if (depth > 32) throw new ArgumentException("Expression nesting cannot exceed 32 levels.");
            if (position >= tokens.Count) throw new ArgumentException("An expression value is missing.");
            var token = tokens[position++];
            Parsed left;
            if (token.Kind == "literal") left = new(0, false, () => token.Scalar!);
            else if (token.Kind == "identifier") left = new(0, true, () => resolve?.Invoke(token.Value) ?? throw new ArgumentException("Constant evaluation cannot read a reference."));
            else if (token.Value is "!" or "+" or "-")
            {
                var operand = Parse(7, depth + 1);
                left = new(1 + operand.Height, operand.Dynamic, () => Unary(token.Value, operand.Evaluate()));
            }
            else if (token.Value == "(") { left = Parse(0, depth + 1); Consume(")"); }
            else throw new ArgumentException("Expected a literal, reference, or parenthesized expression.");
            while (position < tokens.Count && tokens[position].Kind == "operator" && Precedence.TryGetValue(tokens[position].Value, out var rank) && rank >= minimum)
            {
                var operation = tokens[position++].Value;
                var first = left;
                var right = Parse(rank + 1, depth + 1);
                left = new(1 + Math.Max(first.Height, right.Height), first.Dynamic || right.Dynamic,
                    () => Binary(operation, first.Evaluate(), right.Evaluate));
                CheckHeight(left.Height);
            }
            if (minimum == 0 && Matches("?"))
            {
                position++;
                var condition = left;
                var yes = Parse(0, depth + 1); Consume(":");
                var no = Parse(0, depth + 1);
                left = new(1 + Math.Max(condition.Height, Math.Max(yes.Height, no.Height)), condition.Dynamic || yes.Dynamic || no.Dynamic,
                    () => Boolean(condition.Evaluate()) ? yes.Evaluate() : no.Evaluate());
            }
            CheckHeight(left.Height);
            return left;
        }
        private static double Numeric(object value) => value is double number ? number : throw new ArgumentException("Binding arithmetic requires numeric values.");
        private static bool Boolean(object value) => value is bool flag ? flag : throw new ArgumentException("A binding condition must be Boolean.");
        private static object Scalar(object value) => value is bool || value is double number && SafeNumber(number) || value is string text && text.Length <= 4096
            ? value : throw new ArgumentException("A binding constant must be finite, within the exact integer range, Boolean or text up to 4096 characters.");
        private static object Unary(string operation, object value) => operation == "!" ? !Boolean(value) : Scalar(operation == "-" ? -Numeric(value) : Numeric(value));
        private static object Binary(string operation, object left, Func<object> evaluateRight)
        {
            if (operation == "&&") return Boolean(left) && Boolean(evaluateRight());
            if (operation == "||") return Boolean(left) || Boolean(evaluateRight());
            var right = evaluateRight();
            if (operation is "==" or "===" or "!=" or "!==")
            {
                if (left.GetType() != right.GetType()) throw new ArgumentException("Binding equality compares values of the same type.");
                return operation is "==" or "===" ? left.Equals(right) : !left.Equals(right);
            }
            if (operation is "<" or "<=" or ">" or ">=")
            {
                if (left.GetType() != right.GetType() || left is bool) throw new ArgumentException("Binding comparison requires two numbers or two strings.");
                var comparison = left is string text ? string.CompareOrdinal(text, (string)right) : Numeric(left).CompareTo(Numeric(right));
                return operation switch { "<" => comparison < 0, "<=" => comparison <= 0, ">" => comparison > 0, _ => comparison >= 0 };
            }
            if (operation == "+" && left is string aText && right is string bText) return Scalar(aText + bText);
            var a = Numeric(left); var b = Numeric(right);
            return Scalar(operation switch { "+" => a + b, "-" => a - b, "*" => a * b, "/" => a / b, "%" => a % b,
                _ => throw new ArgumentException("Unsupported binding operator.") });
        }
        private static void CheckHeight(int height)
        {
            if (height > 32) throw new ArgumentException("Expression nesting cannot exceed 32 levels.");
        }
    }
}
