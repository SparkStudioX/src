using System.Buffers.Binary;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace SparkStudio.Connectors;

public sealed record SourceScriptRequest(string Payload, string Topic, bool Retained, string Received,
    string Script, string? TimestampExpression = null, string? SequenceExpression = null,
    string? EpochExpression = null, int ResultBytes = 256 * 1024, int ResultDepth = 16,
    int ResultMembers = 4096, int ResultLeaves = 1024, int ValueBytes = 64 * 1024,
    int DecodeNodes = 65536, int DecodeBytes = 32 * 1024 * 1024, bool OrderByTimestamp = false, bool MetadataOnly = false);
public sealed record SourceScriptResponse(bool Success, JsonElement? Result = null, string? Error = null,
    string? Timestamp = null, ulong? Sequence = null, string? Epoch = null, bool Skip = false);

// Framed IPC checks length before allocation. This file is linked into the worker, avoiding
// loading protocol connectors/native dependencies in the extraction process.
public static class SourceScriptProtocol
{
    // JSON escaping can expand a 256 KiB admitted UTF-8 payload to 1.5 MiB.
    public const int MaximumFrameBytes = 2 * 1024 * 1024;
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly JsonSerializerOptions ReadOptions = new() { MaxDepth = 64 };
    public static async Task WriteAsync<T>(Stream stream, T value, CancellationToken ct)
    {
        var data = JsonSerializer.SerializeToUtf8Bytes(value);
        if (data.Length > MaximumFrameBytes) throw new InvalidDataException("Script IPC frame exceeds its byte limit.");
        var header = new byte[4]; BinaryPrimitives.WriteInt32BigEndian(header, data.Length);
        await stream.WriteAsync(header, ct); await stream.WriteAsync(data, ct); await stream.FlushAsync(ct);
    }
    public static async Task<T> ReadAsync<T>(Stream stream, CancellationToken ct)
    {
        var header = new byte[4]; await stream.ReadExactlyAsync(header, ct);
        var length = BinaryPrimitives.ReadInt32BigEndian(header);
        if (length is < 1 or > MaximumFrameBytes) throw new InvalidDataException("Script IPC frame exceeds its byte limit.");
        var data = new byte[length]; await stream.ReadExactlyAsync(data, ct);
        return JsonSerializer.Deserialize<T>(data, ReadOptions) ?? throw new InvalidDataException("Invalid script IPC response.");
    }
    public static object? Scalar(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Null => null, JsonValueKind.True => true, JsonValueKind.False => false,
        JsonValueKind.String => value.GetString(),
        JsonValueKind.Number => Number(value),
        _ => throw new InvalidDataException("A scalar value was required.")
    };
    private static object Number(JsonElement value)
    {
        var raw = value.GetRawText();
        if (!raw.Contains('.') && !raw.Contains('e') && !raw.Contains('E'))
        {
            if (value.TryGetInt64(out var integer)) return integer;
            throw new InvalidDataException("JSON integer is outside Int64 range.");
        }
        if (value.TryGetDouble(out var number) && double.IsFinite(number)) return number;
        throw new InvalidDataException("JSON number is nonfinite or outside Double range.");
    }
    public static string DecodeUtf8(ReadOnlySpan<byte> payload, int cap)
    { if (payload.Length > cap) throw new InvalidDataException("Payload exceeds its local byte limit."); return Utf8.GetString(payload); }
    public static object? DecodeScalar(ReadOnlySpan<byte> payload, int cap)
    {
        var text = DecodeUtf8(payload, cap); var trimmed = text.Trim();
        if (trimmed.Length == 0) return text;
        try
        {
            using var document = JsonDocument.Parse(trimmed, new JsonDocumentOptions { MaxDepth = 64 });
            if (document.RootElement.ValueKind is JsonValueKind.Object or JsonValueKind.Array) throw new InvalidDataException("Scalar mapping cannot accept a JSON object or array.");
            var value = Scalar(document.RootElement);
            if (value is string decoded && Utf8.GetByteCount(decoded) > cap) throw new InvalidDataException("Decoded string exceeds its byte limit.");
            return value;
        }
        catch (JsonException)
        {
            // Scalar text is deliberately accepted; structured-looking malformed JSON is a decode error.
            if (trimmed[0] is '{' or '[' or '"') throw new InvalidDataException("Malformed JSON scalar.");
            if (bool.TryParse(trimmed, out var flag)) return flag;
            if (long.TryParse(trimmed, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var integer)) return integer;
            if (double.TryParse(trimmed, NumberStyles.Float, CultureInfo.InvariantCulture, out var number))
            {
                if (!double.IsFinite(number)) throw new InvalidDataException("Nonfinite scalar.");
                if (trimmed.All(character => char.IsDigit(character) || character is '+' or '-')) throw new InvalidDataException("Integer exceeds Int64 range.");
                return number;
            }
            return text;
        }
    }
    public static object Coerce(object value, string? dataType)
    {
        if (string.IsNullOrEmpty(dataType)) return value;
        if (dataType == "String") return value switch { string text => text, bool flag => flag ? "true" : "false", long integer => integer.ToString(CultureInfo.InvariantCulture), double number when double.IsFinite(number) => number.ToString("R", CultureInfo.InvariantCulture), _ => throw new InvalidDataException("Value cannot be represented as String.") };
        if (value is string encoded && dataType != "String")
        {
            if (dataType == "Boolean") value = bool.TryParse(encoded, out var parsed) ? parsed : throw new InvalidDataException("Expected Boolean text.");
            else if (dataType is "Int64" or "Int32" or "Int16" or "UInt32" or "UInt16") value = long.TryParse(encoded, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var integer) ? integer : throw new InvalidDataException("Expected an exact Int64 integer string.");
            else if (long.TryParse(encoded, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var integer)) value = integer;
            else value = double.TryParse(encoded, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) && double.IsFinite(number) ? number : throw new InvalidDataException("Expected finite numeric text.");
        }
        if (dataType is "Int64" or "Int32" or "Int16" or "UInt32" or "UInt16" && value is double numberValue)
        {
            if (numberValue != Math.Truncate(numberValue) || Math.Abs(numberValue) > 9007199254740992d) throw new InvalidDataException("Floating-point integer conversion cannot be proven exact.");
            value = (long)numberValue;
        }
        try
        {
            return dataType switch
            {
                "Boolean" when value is bool => value,
                "Int64" when value is long => value,
                "Int32" when value is long integer && integer is >= int.MinValue and <= int.MaxValue => (int)integer,
                "Int16" when value is long integer && integer is >= short.MinValue and <= short.MaxValue => (short)integer,
                "UInt16" when value is long integer && integer is >= ushort.MinValue and <= ushort.MaxValue => (ushort)integer,
                "UInt32" when value is long integer && integer is >= uint.MinValue and <= uint.MaxValue => (uint)integer,
                "Double" when value is double => value,
                "Double" when value is long integer && (long)(double)integer == integer => (double)integer,
                "Float" when value is double number && double.IsFinite(number) && float.IsFinite((float)number) => (float)number,
                "Float" when value is long integer && (long)(float)integer == integer => (float)integer,
                _ => throw new InvalidDataException("Value cannot be represented exactly as " + dataType + ".")
            };
        }
        catch (OverflowException error) { throw new InvalidDataException("Value exceeds its declared type.", error); }
    }
    public static string DataType(object value) => value switch { bool => "Boolean", string => "String", long => "Int64", int => "Int32", short => "Int16", ushort => "UInt16", uint => "UInt32", float => "Float", double => "Double", _ => throw new InvalidDataException("Unsupported scalar type.") };
}
