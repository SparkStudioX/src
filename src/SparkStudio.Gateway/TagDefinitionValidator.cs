using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Opc.Ua;

namespace SparkStudio.Gateway;

/// <summary>Validation shared by tag configuration and persisted memory-tag writes.</summary>
public static class TagDefinitionValidator
{
    private static readonly HashSet<string> DataTypes = new(StringComparer.Ordinal)
    { "Boolean", "Int16", "UInt16", "Int32", "UInt32", "Int64", "Float", "Double", "String" };

    public static string Path(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 512 || !path.StartsWith("[default]", StringComparison.Ordinal))
            throw new ArgumentException("Use a concrete [default] tag path of at most 512 characters.");
        var relative = path[9..];
        if (relative.Any(char.IsControl) || relative.IndexOfAny(['[', ']', '{', '}', '\\']) >= 0)
            throw new ArgumentException("Tag paths cannot contain control characters, brackets, braces or backslashes.");
        var segments = relative.Split('/');
        if (segments.Any(segment => string.IsNullOrWhiteSpace(segment) || segment is "." or ".."))
            throw new ArgumentException("Tag paths cannot contain empty, dot or parent segments.");
        return path;
    }

    public static string Text(JsonObject value, string name, bool required = true)
    {
        if (!value.TryGetPropertyValue(name, out var node))
            return required ? throw new ArgumentException($"{name} is required.") : "";
        if (node is not JsonValue scalar || !scalar.TryGetValue<string>(out var text) || string.IsNullOrWhiteSpace(text))
            throw new ArgumentException($"{name} must be a nonempty string.");
        return text;
    }

    public static string Kind(JsonObject value) => value.ContainsKey("kind") ? Text(value, "kind") : "opcua";

    public static bool IsDeviceSource(JsonObject value) => Kind(value) is "opcua" or "device";

    public static string DevicePointIdentifier(JsonObject value)
    {
        var identifier = Text(value, "nodeId");
        if (identifier.Length > 256 || identifier.Any(char.IsControl))
            throw new ArgumentException("A device point ID must contain at most 256 characters without control characters.");
        return identifier;
    }

    public static bool Enabled(JsonObject value)
    {
        if (!value.TryGetPropertyValue("enabled", out var node)) return true;
        if (node is not JsonValue scalar || !scalar.TryGetValue<bool>(out var enabled))
            throw new ArgumentException("enabled must be a Boolean.");
        return enabled;
    }

    public static int PublishingInterval(JsonObject value)
    {
        if (!value.TryGetPropertyValue("publishingIntervalMs", out var node)) return 1000;
        if (node is not JsonValue scalar || !scalar.TryGetValue<int>(out var interval) || interval is < 100 or > 60000)
            throw new ArgumentException("publishingIntervalMs must be an integer from 100 through 60000.");
        return interval;
    }

    public static string DataType(JsonObject value)
    {
        var type = Text(value, "dataType");
        if (!DataTypes.Contains(type))
            throw new ArgumentException("dataType must be Boolean, Int16, UInt16, Int32, UInt32, Int64, Float, Double or String.");
        return type;
    }
    public static double AbsoluteDeadband(JsonObject value)
    {
        if (value["absoluteDeadband"] is null) return 0;
        if (value["absoluteDeadband"] is not JsonValue scalar || !scalar.TryGetValue<double>(out var deadband) || !double.IsFinite(deadband) || deadband < 0)
            throw new ArgumentException("absoluteDeadband must be a finite nonnegative number.");
        return deadband;
    }
    public static uint MonitorQueueSize(JsonObject value)
    {
        if (value["queueSize"] is null) return 16;
        if (value["queueSize"] is not JsonValue scalar || !scalar.TryGetValue<uint>(out var size) || size is < 1 or > 1000)
            throw new ArgumentException("queueSize must be an integer from 1 through 1000.");
        return size;
    }

    public static string NodeIdentifier(JsonObject value)
    {
        var identifier = Text(value, "nodeId");
        if (identifier.Length > 4096 || identifier.Any(char.IsControl))
            throw new ArgumentException("nodeId must be at most 4096 characters and cannot contain control characters.");
        try { return NodeId.Parse(identifier).ToString(); }
        catch (Exception error) when (error is ServiceResultException or FormatException or ArgumentException)
        { throw new ArgumentException("nodeId must be a valid OPC UA node identifier.", error); }
    }

    public static JsonNode MemoryValue(string type, JsonNode? node)
    {
        if (node is null) throw new ArgumentException("A memory tag needs a non-null value matching its dataType.");
        JsonElement value;
        try { value = JsonSerializer.SerializeToElement(node); }
        catch (Exception error) when (error is ArgumentException or JsonException)
        { throw new ArgumentException("Memory tag values must be finite JSON scalar values.", error); }
        return MemoryValue(type, value);
    }

    public static JsonNode MemoryValue(string type, JsonElement value)
    {
        if (!DataTypes.Contains(type)) throw new ArgumentException("Unsupported memory tag dataType.");
        if (type == "Boolean")
        {
            if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw new ArgumentException("Boolean tags require a Boolean value.");
            return JsonValue.Create(value.GetBoolean())!;
        }
        if (type == "String")
        {
            if (value.ValueKind != JsonValueKind.String) throw new ArgumentException("String tags require a string value.");
            return JsonValue.Create(value.GetString())!;
        }
        if (value.ValueKind != JsonValueKind.Number) throw new ArgumentException($"{type} tags require a numeric value.");
        if (type is "Int16" or "UInt16" or "Int32" or "UInt32" or "Int64")
        {
            var number = Integer(value);
            var minimum = type is "UInt16" or "UInt32" ? 0 : type == "Int16" ? short.MinValue : type == "Int32" ? int.MinValue : long.MinValue;
            var maximum = type == "UInt16" ? ushort.MaxValue : type == "UInt32" ? uint.MaxValue : type == "Int16" ? short.MaxValue : type == "Int32" ? int.MaxValue : long.MaxValue;
            if (number < minimum || number > maximum) throw new ArgumentException($"Memory tag value is outside the {type} range.");
            return type switch
            {
                "Int16" => JsonValue.Create((short)number)!,
                "UInt16" => JsonValue.Create((ushort)number)!,
                "Int32" => JsonValue.Create((int)number)!,
                "UInt32" => JsonValue.Create((uint)number)!,
                _ => JsonValue.Create((long)number)!
            };
        }
        if (!value.TryGetDouble(out var floating) || !double.IsFinite(floating))
            throw new ArgumentException($"{type} tags require a finite numeric value.");
        if (type == "Float")
        {
            if (floating < -float.MaxValue || floating > float.MaxValue) throw new ArgumentException("Memory tag value is outside the Float range.");
            return JsonValue.Create((float)floating)!;
        }
        return JsonValue.Create(floating)!;
    }

    private static long Integer(JsonElement value)
    {
        if (value.TryGetInt64(out var direct)) return direct;
        // Check the decimal representation exactly: floating/decimal conversion can round away a fractional part.
        var raw = value.GetRawText();
        var exponentAt = raw.IndexOfAny(['e', 'E']);
        var coefficient = exponentAt < 0 ? raw : raw[..exponentAt];
        var negative = coefficient.StartsWith('-');
        if (negative) coefficient = coefficient[1..];
        var point = coefficient.IndexOf('.');
        var fractionDigits = point < 0 ? 0 : coefficient.Length - point - 1;
        var digits = coefficient.Replace(".", "").TrimStart('0');
        if (digits.Length == 0) return 0;
        var exponent = 0;
        if (exponentAt >= 0 && !int.TryParse(raw[(exponentAt + 1)..], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out exponent))
            throw new ArgumentException("Integer tag value is outside the supported range.");
        var shift = (long)exponent - fractionDigits;
        if (shift < 0)
        {
            var discard = -shift;
            if (discard > digits.Length || digits.AsSpan(digits.Length - (int)discard).ContainsAnyExcept('0'))
                throw new ArgumentException("Integer tags require a value without a fractional part.");
            digits = digits[..(digits.Length - (int)discard)];
        }
        else
        {
            if (digits.Length + shift > 19) throw new ArgumentException("Integer tag value is outside the Int64 range.");
            digits += new string('0', (int)shift);
        }
        if (!long.TryParse((negative ? "-" : "") + digits, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var result))
            throw new ArgumentException("Integer tag value is outside the Int64 range.");
        return result;
    }

    public static JsonObject WithLegacyDefaults(JsonObject value)
    {
        var result = (JsonObject)value.DeepClone();
        if (!result.ContainsKey("kind")) result["kind"] = "opcua";
        if (!result.ContainsKey("enabled")) result["enabled"] = true;
        if (!result.ContainsKey("publishingIntervalMs")) result["publishingIntervalMs"] = 1000;
        return result;
    }
}
