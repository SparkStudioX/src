using System.Globalization;
using System.Text.Json;

namespace SparkStudio.Connectors;

// Conversion stays outside transport code so range checks precede every dispatch.
internal static class DeviceScalarCodec
{
    internal static string StorageType(DevicePoint point) => point.RawDataType ?? point.DataType;
    internal static Type ClrType(string type) => type switch
    {
        "Boolean" => typeof(bool), "Int16" => typeof(short), "UInt16" => typeof(ushort),
        "Int32" => typeof(int), "UInt32" => typeof(uint), "Int64" => typeof(long),
        "Float" => typeof(float), "Double" => typeof(double), "String" => typeof(string),
        _ => throw new ArgumentException("Unsupported device scalar type.")
    };

    internal static int Width(string type) => type switch
    {
        "Boolean" => 1, "Int16" or "UInt16" => 2, "Int32" or "UInt32" or "Float" => 4,
        "Int64" or "Double" => 8, _ => throw new ArgumentException("This type has no fixed scalar width.")
    };

    internal static void NativeLayout(DevicePoint point)
    {
        if (point.ByteSwap || point.WordSwap) throw new ArgumentException("This driver uses the controller's native scalar layout; byte and word swapping are not supported.");
        _ = ClrType(point.DataType);
        _ = ClrType(StorageType(point));
        if ((point.DataType is "Boolean" or "String" || StorageType(point) is "Boolean" or "String") && StorageType(point) != point.DataType)
            throw new ArgumentException("Boolean and String points must retain the same raw and engineering type.");
    }

    internal static object Encode(DevicePoint point, JsonElement value)
    {
        if (point.DataType == "Boolean") return value.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? value.GetBoolean() : throw new ArgumentException("A Boolean value is required.");
        if (point.DataType == "String")
        {
            var text = value.ValueKind == JsonValueKind.String ? value.GetString()! : throw new ArgumentException("A string value is required.");
            if (text.Length > point.StringLength || text.Any(ch => ch > 127 || ch == '\0'))
                throw new ArgumentException("Device strings must fit the configured capacity and contain non-NUL ASCII characters.");
            return text;
        }
        if (value.ValueKind != JsonValueKind.Number) throw new ArgumentException("A numeric value is required.");
        try
        {
            object engineering;
            if (point.DataType == "Float") engineering = (float)Floating(point.DataType, value.GetDouble());
            else if (point.DataType == "Double") engineering = Floating(point.DataType, value.GetDouble());
            else engineering = Integer(point.DataType, JsonDecimal(value));
            var storage = StorageType(point);
            if (storage is "Float" or "Double") {
                var raw = Floating(storage, (Convert.ToDouble(engineering, CultureInfo.InvariantCulture) - point.Offset) / point.Scale);
                if (storage == "Float") return (float)raw;
                return raw;
            }
            return Integer(storage, (Decimal(engineering) - Decimal(point.Offset)) / Decimal(point.Scale));
        }
        catch (OverflowException) { throw new ArgumentException("The encoded device integer is outside its range."); }
    }

    internal static object Decode(DevicePoint point, object raw)
    {
        if (point.DataType == "Boolean") return raw is bool boolean ? boolean : throw new ArgumentException("The device returned a non-Boolean value.");
        if (point.DataType == "String")
            return raw is string text && text.Length <= point.StringLength && !text.Any(character => character > 127 || character == '\0')
                ? text : throw new ArgumentException("The device string does not fit the saved ASCII layout.");
        if (point.DataType is "Float" or "Double") {
            var engineering = Floating(point.DataType, Convert.ToDouble(raw, CultureInfo.InvariantCulture) * point.Scale + point.Offset);
            if (point.DataType == "Float") return (float)engineering;
            return engineering;
        }
        return Integer(point.DataType, Decimal(raw) * Decimal(point.Scale) + Decimal(point.Offset));
    }

    private static decimal JsonDecimal(JsonElement value)
    {
        var number = value.GetDecimal();
        if (number == 0 && value.GetRawText().Split('e', 'E')[0].Any(character => character is >= '1' and <= '9'))
            throw new ArgumentException("The numeric value is too small for exact integer scaling.");
        return number;
    }

    private static decimal Decimal(object value)
    {
        var number = Convert.ToDecimal(value, CultureInfo.InvariantCulture);
        if (number == 0 && Convert.ToDouble(value, CultureInfo.InvariantCulture) != 0)
            throw new ArgumentException("A scale, offset or value is too small for exact integer scaling.");
        return number;
    }

    private static double Floating(string type, double value)
    {
        if (!double.IsFinite(value) || type == "Float" && (value > float.MaxValue || value < -float.MaxValue))
            throw new ArgumentException("The device floating-point value is outside its finite range.");
        return type == "Float" ? (float)value : value;
    }

    private static object Integer(string type, decimal value)
    {
        if (decimal.Truncate(value) != value) throw new ArgumentException("Scaling must produce an exact whole number for an integer point.");
        return type switch
        {
            "Int16" => (object)checked((short)value), "UInt16" => (object)checked((ushort)value),
            "Int32" => (object)checked((int)value), "UInt32" => (object)checked((uint)value), "Int64" => (object)checked((long)value),
            _ => throw new ArgumentException("Unsupported device integer type.")
        };
    }

    internal static CancellationTokenSource Deadline(int timeoutMs, CancellationToken token)
    {
        var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(timeoutMs);
        return deadline;
    }

    // Vendor exception messages may contain endpoint or symbol details. Keep the public
    // failure stable while retaining the original exception for local diagnostics.
    internal static async Task<T> SdkAsync<T>(Func<Task<T>> operation, string protocol)
    {
        try { return await operation(); }
        catch (Exception error) when (IsSdkFailure(error))
        { throw new InvalidOperationException($"The {protocol} SDK operation failed. Check the device status and connection settings.", error); }
    }

    internal static async Task SdkAsync(Func<Task> operation, string protocol)
    {
        await SdkAsync(async () => { await operation(); return true; }, protocol);
    }

    private static bool IsSdkFailure(Exception error)
    {
        var area = error.GetType().Namespace ?? "";
        return area.StartsWith("libplctag", StringComparison.Ordinal) || area.StartsWith("S7.Net", StringComparison.Ordinal) ||
            area.StartsWith("TwinCAT", StringComparison.Ordinal) || error is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException;
    }

    internal static ConnectorValue Bad(DevicePoint point, Exception error) => new(point.Id, null, point.DataType,
        error is OperationCanceledException or TimeoutException ? "Bad_Timeout" : error is ArgumentException or OverflowException ? "Bad_DecodingError" : "Bad_CommunicationError", DateTimeOffset.UtcNow);
}
