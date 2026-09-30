using System.Text.Json;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

internal static class TagBindingAddress
{
    private static readonly Regex Placeholder = new(@"\{([^{}]+)\}", RegexOptions.CultureInvariant);
    public static void Validate(string path, IEnumerable<string>? parameters = null)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 1024 || path.Any(character => character < 32 || character == 127))
            throw new ArgumentException("Tag addresses need 1–1024 characters without control characters.");
        var allowed = parameters?.ToHashSet(StringComparer.Ordinal);
        var count = 0;
        var literal = Placeholder.Replace(path, match =>
        {
            count++;
            var key = match.Groups[1].Value;
            if (key.Length > 256 || string.IsNullOrWhiteSpace(key) || key is "__proto__" or "constructor" or "prototype" || allowed is not null && !allowed.Contains(key))
                throw new ArgumentException("Tag address placeholders must name declared parent parameters.");
            return "";
        });
        if (count > 16 || literal.Contains('{') || literal.Contains('}'))
            throw new ArgumentException("Tag addresses support at most 16 complete parameter placeholders.");
    }
    public static string Resolve(string path, IReadOnlyDictionary<string, JsonElement> parameters)
    {
        Validate(path, parameters.Keys);
        var result = Placeholder.Replace(path, match =>
        {
            var value = parameters[match.Groups[1].Value];
            return value.ValueKind switch
            {
                JsonValueKind.String => value.GetString()!,
                JsonValueKind.True => "true", JsonValueKind.False => "false",
                JsonValueKind.Number when value.TryGetDouble(out var number) && double.IsFinite(number)
                    && (number != Math.Truncate(number) || Math.Abs(number) <= 9007199254740991) => number.ToString("G", System.Globalization.CultureInfo.InvariantCulture),
                _ => throw new ArgumentException("Tag address parameters must be bounded native scalars.")
            };
        });
        Validate(result);
        if (result.Contains('{') || result.Contains('}')) throw new ArgumentException("Tag addresses cannot contain recursive substitutions.");
        return result;
    }
}
