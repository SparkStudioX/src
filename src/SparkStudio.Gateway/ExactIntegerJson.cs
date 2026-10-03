using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SparkStudio.Gateway;

// The wire response preserves integer values that JavaScript cannot represent exactly.
// Persistence and source-protocol JSON retain their native integer representation.
public sealed class ExactInt64JsonConverter : JsonConverter<long>
{
    private const long Safe = 9007199254740991;
    public override long Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.TokenType == JsonTokenType.String ? long.Parse(reader.GetString()!, CultureInfo.InvariantCulture) : reader.GetInt64();
    public override void Write(Utf8JsonWriter writer, long value, JsonSerializerOptions options)
    {
        if (value is >= -Safe and <= Safe) writer.WriteNumberValue(value);
        else writer.WriteStringValue(value.ToString(CultureInfo.InvariantCulture));
    }
}
public sealed class ExactUInt64JsonConverter : JsonConverter<ulong>
{
    public override ulong Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.TokenType == JsonTokenType.String ? ulong.Parse(reader.GetString()!, CultureInfo.InvariantCulture) : reader.GetUInt64();
    public override void Write(Utf8JsonWriter writer, ulong value, JsonSerializerOptions options)
    {
        if (value <= 9007199254740991UL) writer.WriteNumberValue(value);
        else writer.WriteStringValue(value.ToString(CultureInfo.InvariantCulture));
    }
}
