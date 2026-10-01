using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>A bounded scalar language. No functions, reflection, scripts, assignments or external I/O.</summary>
public static class TagExpressions
{
    public sealed record Plan(string Path, string DataType, bool Enabled, int Interval, IReadOnlyDictionary<string, string> Inputs, Node Expression);
    public abstract record Node { public abstract object Evaluate(IReadOnlyDictionary<string, object> inputs); }
    private sealed record Literal(object Value) : Node { public override object Evaluate(IReadOnlyDictionary<string, object> inputs) => Value; }
    private sealed record Reference(string Name) : Node { public override object Evaluate(IReadOnlyDictionary<string, object> inputs) => inputs[Name]; }
    private sealed record Unary(string Operator, Node Operand) : Node
    {
        public override object Evaluate(IReadOnlyDictionary<string, object> inputs) => Operator switch
        {
            "!" => !Boolean(Operand.Evaluate(inputs)), "-" => -Number(Operand.Evaluate(inputs)), _ => Number(Operand.Evaluate(inputs))
        };
    }
    private sealed record Binary(string Operator, Node Left, Node Right) : Node
    {
        public override object Evaluate(IReadOnlyDictionary<string, object> inputs)
        {
            var left = Left.Evaluate(inputs);
            // Boolean evaluation is short-circuiting, but every declared input must have good quality.
            if (Operator == "&&") return Boolean(left) && Boolean(Right.Evaluate(inputs));
            if (Operator == "||") return Boolean(left) || Boolean(Right.Evaluate(inputs));
            var right = Right.Evaluate(inputs);
            if (Operator is "==" or "!=")
            {
                if (left.GetType() != right.GetType()) throw new ArgumentException("Equality operands must have the same scalar type.");
                return Operator == "==" ? Equals(left, right) : !Equals(left, right);
            }
            var a = Number(left); var b = Number(right);
            return Operator switch
            {
                "+" => Finite(a + b), "-" => Finite(a - b), "*" => Finite(a * b),
                "/" => b == 0 ? throw new ArithmeticException("Division by zero.") : Finite(a / b),
                "%" => b == 0 ? throw new ArithmeticException("Division by zero.") : Finite(a % b),
                "<" => a < b, "<=" => a <= b, ">" => a > b, ">=" => a >= b,
                _ => throw new ArgumentException("Unsupported expression operator.")
            };
        }
    }
    private static double Finite(double value) => double.IsFinite(value) ? value : throw new ArithmeticException("Expression result is not finite.");
    private static double Number(object value) => value is double number ? number : throw new ArgumentException("A numeric operand is required.");
    private static bool Boolean(object value) => value is bool boolean ? boolean : throw new ArgumentException("A Boolean operand is required.");

    public static IReadOnlyDictionary<string, string> Inputs(JsonObject definition)
    {
        if (definition["inputs"] is not JsonObject inputs || inputs.Count > 32)
            throw new ArgumentException("Expression inputs must be an object with at most 32 named tag paths.");
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in inputs)
        {
            if (!Regex.IsMatch(pair.Key, "^[A-Za-z_][A-Za-z0-9_]{0,31}$", RegexOptions.CultureInvariant) || pair.Key is "true" or "false")
                throw new ArgumentException("Expression input names must be identifiers of at most 32 characters, excluding true and false.");
            if (pair.Value is not JsonValue scalar || !scalar.TryGetValue<string>(out var path))
                throw new ArgumentException("Expression inputs must be concrete tag paths.");
            TagDefinitionValidator.Path(path);
            result.Add(pair.Key, path);
        }
        return result;
    }

    public static Plan Compile(JsonObject definition)
    {
        var inputs = Inputs(definition);
        var text = TagDefinitionValidator.Text(definition, "expression");
        if (text.Length > 2048) throw new ArgumentException("Expressions are limited to 2048 characters.");
        return new(TagDefinitionValidator.Text(definition, "path"), TagDefinitionValidator.DataType(definition), TagDefinitionValidator.Enabled(definition),
            TagDefinitionValidator.PublishingInterval(definition), inputs, new Parser(text, inputs.Keys.ToHashSet(StringComparer.Ordinal)).Parse());
    }

    public static Plan[] Order(JsonObject[] definitions)
    {
        var paths = definitions.Select(item => TagDefinitionValidator.Text(item, "path")).ToHashSet(StringComparer.Ordinal);
        var plans = definitions.Where(item => TagDefinitionValidator.Kind(item) == "expression").Select(Compile).ToDictionary(item => item.Path, StringComparer.Ordinal);
        var state = new Dictionary<string, int>(StringComparer.Ordinal);
        var heights = new Dictionary<string, int>(StringComparer.Ordinal);
        var ordered = new List<Plan>();
        int Visit(Plan plan, int depth)
        {
            if (depth > 64) throw new ArgumentException("Expression dependency chains are limited to 64 tags.");
            if (state.TryGetValue(plan.Path, out var seen))
            {
                if (seen == 1) throw new ArgumentException($"Expression dependency cycle at {plan.Path}.");
                return heights[plan.Path];
            }
            state[plan.Path] = 1;
            var height = 1;
            foreach (var path in plan.Inputs.Values)
            {
                if (!paths.Contains(path) && !SamplePath(path)) throw new ArgumentException($"Expression input tag does not exist: {path}.");
                if (plans.TryGetValue(path, out var dependency)) height = Math.Max(height, 1 + Visit(dependency, depth + 1));
            }
            if (height > 64) throw new ArgumentException("Expression dependency chains are limited to 64 tags.");
            state[plan.Path] = 2; heights[plan.Path] = height; ordered.Add(plan); return height;
        }
        foreach (var plan in plans.Values) Visit(plan, 1);
        return ordered.ToArray();
    }

    internal static bool SamplePath(string path) => path == "[default]Setpoints/TargetSpeed"
        || Regex.IsMatch(path, "^\\[default\\]Line/Line[12]/(Speed|Temperature|ProductionCount|Status)$", RegexOptions.CultureInvariant);

    public static TagValue Evaluate(Plan plan, IReadOnlyDictionary<string, TagValue> values, DateTimeOffset now, TagValue? previous = null)
    {
        var timestamp = previous?.Timestamp ?? now;
        TagValue Bad(string quality) => new(plan.Path, null, plan.DataType, quality, timestamp, "expression");
        if (!plan.Enabled) return Bad("Bad_Disabled");
        var sources = plan.Inputs.Select(pair => (pair.Key, Value: values.GetValueOrDefault(pair.Value))).ToArray();
        if (sources.Any(item => item.Value is null)) return Bad("Bad_NotFound");
        if (sources.Length > 0) timestamp = sources.Max(item => item.Value!.Timestamp);
        var bad = sources.FirstOrDefault(item => !item.Value!.Quality.StartsWith("Good", StringComparison.OrdinalIgnoreCase));
        if (bad.Value is not null) return Bad(bad.Value.Quality);
        try
        {
            var input = sources.ToDictionary(item => item.Key, item => Scalar(item.Value!.Value), StringComparer.Ordinal);
            var result = plan.Expression.Evaluate(input);
            var typed = TagDefinitionValidator.MemoryValue(plan.DataType, JsonSerializer.SerializeToElement(result));
            if (sources.Length == 0 && (previous?.Quality != "Good" || JsonSerializer.Serialize(previous.Value) != typed.ToJsonString())) timestamp = now;
            return new(plan.Path, typed.Deserialize<JsonElement>(), plan.DataType, "Good", timestamp, "expression");
        }
        catch (ArithmeticException) { return Bad("Bad_ExpressionError"); }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or JsonException) { return Bad("Bad_TypeMismatch"); }
    }

    private static object Scalar(object? value)
    {
        var scalar = JsonSerializer.SerializeToElement(value);
        return scalar.ValueKind switch
        {
            JsonValueKind.True => true, JsonValueKind.False => false, JsonValueKind.String => scalar.GetString()!,
            // The language uses IEEE-754 doubles; reject integers that would silently lose precision.
            JsonValueKind.Number when scalar.TryGetDouble(out var number) && double.IsFinite(number)
                && (Math.Truncate(number) != number || Math.Abs(number) <= 9007199254740991d) => number,
            _ => throw new ArgumentException("Expression inputs must be finite scalars, with integers inside the exact double range.")
        };
    }

    private sealed class Parser(string source, HashSet<string> names)
    {
        private int offset;
        private int count;
        private string token = "";
        private object? literal;
        public Node Parse()
        {
            Next(); var result = Expression(0, 0);
            if (token != "end") throw new ArgumentException("Unexpected expression token.");
            return result;
        }
        private Node Expression(int minimum, int depth)
        {
            if (depth > 64) throw new ArgumentException("Expression nesting is limited to 64 levels.");
            Node left;
            if (token is "!" or "+" or "-") { var op = token; Next(); left = new Unary(op, Expression(7, depth + 1)); }
            else if (token == "(") { Next(); left = Expression(0, depth + 1); if (token != ")") throw new ArgumentException("Missing closing parenthesis."); Next(); }
            else if (token == "literal") { left = new Literal(literal!); Next(); }
            else if (token == "name")
            {
                var name = (string)literal!;
                if (!names.Contains(name)) throw new ArgumentException($"Unknown expression input: {name}.");
                left = new Reference(name); Next();
            }
            else throw new ArgumentException("Expected a scalar, named input or parenthesized expression.");
            while (Priority(token) is var priority && priority >= minimum)
            {
                var op = token; Next(); left = new Binary(op, left, Expression(priority + 1, depth + 1));
            }
            return left;
        }
        private static int Priority(string token) => token switch { "||" => 0, "&&" => 1, "==" or "!=" => 2, "<" or "<=" or ">" or ">=" => 3, "+" or "-" => 4, "*" or "/" or "%" => 5, _ => -1 };
        private void Next()
        {
            if (++count > 256) throw new ArgumentException("Expressions are limited to 256 tokens.");
            while (offset < source.Length && char.IsWhiteSpace(source[offset])) offset++;
            if (offset == source.Length) { token = "end"; return; }
            var start = offset; var character = source[offset++];
            if (character == '"')
            {
                var escaped = false;
                while (offset < source.Length)
                {
                    var next = source[offset++];
                    if (next == '"' && !escaped)
                    {
                        try { literal = JsonSerializer.Deserialize<string>(source[start..offset])!; }
                        catch (JsonException) { throw new ArgumentException("Invalid quoted expression string."); }
                        token = "literal"; return;
                    }
                    escaped = next == '\\' && !escaped;
                }
                throw new ArgumentException("Unterminated expression string.");
            }
            if (char.IsAsciiDigit(character) || character == '.')
            {
                while (offset < source.Length && (char.IsAsciiDigit(source[offset]) || source[offset] == '.')) offset++;
                if (offset < source.Length && source[offset] is 'e' or 'E')
                {
                    offset++; if (offset < source.Length && source[offset] is '+' or '-') offset++;
                    while (offset < source.Length && char.IsAsciiDigit(source[offset])) offset++;
                }
                if (!double.TryParse(source[start..offset], NumberStyles.Float, CultureInfo.InvariantCulture, out var number) || !double.IsFinite(number)
                    || Math.Truncate(number) == number && Math.Abs(number) > 9007199254740991d)
                    throw new ArgumentException("Expression numbers must be finite and integer literals must fit the exact double range.");
                token = "literal"; literal = number; return;
            }
            if (char.IsAsciiLetter(character) || character == '_')
            {
                while (offset < source.Length && (char.IsAsciiLetterOrDigit(source[offset]) || source[offset] == '_')) offset++;
                var name = source[start..offset];
                token = name is "true" or "false" ? "literal" : "name";
                literal = name is "true" or "false" ? name == "true" : name; return;
            }
            token = character.ToString();
            if (offset < source.Length && source.Substring(start, 2) is "&&" or "||" or "==" or "!=" or "<=" or ">=") token = source[start..++offset];
            if (token is not ("+" or "-" or "*" or "/" or "%" or "!" or "(" or ")" or "<" or ">" or "&&" or "||" or "==" or "!=" or "<=" or ">="))
                throw new ArgumentException("Unsupported expression syntax.");
        }
    }
}
