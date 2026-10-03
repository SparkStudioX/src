using System.Globalization;
using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using S7.Net;

namespace SparkStudio.Connectors;

public sealed class SiemensS7DeviceSession : IDeviceSession
{
    private readonly DeviceSettings settings;
    private readonly CpuType cpu;
    private bool disposed;

    public SiemensS7DeviceSession(ConnectionDefinition connection)
    {
        settings = connection.Device ?? throw new ArgumentException("S7 device settings are required.");
        if (!Enum.TryParse(settings.ControllerFamily, true, out cpu) || !Enum.IsDefined(cpu))
            throw new ArgumentException("Choose a supported S7 CPU family.");
        foreach (var point in settings.Points) ValidatePoint(point);
    }

    internal readonly record struct Address(DataType Area, int Db, int Start, int? Bit);
    internal static Address Parse(DevicePoint point)
    {
        DeviceScalarCodec.NativeLayout(point);
        var db = Regex.Match(point.Address, @"^DB([0-9]{1,5})\.DB([X B W D])([0-9]{1,7})(?:\.([0-7]))?$".Replace(" ", ""), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        var direct = Regex.Match(point.Address, @"^([MIQE])([BWD]?)([0-9]{1,7})(?:\.([0-7]))?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        string layout;
        Address address;
        if (db.Success)
        {
            layout = db.Groups[2].Value.ToUpperInvariant();
            address = new(DataType.DataBlock, int.Parse(db.Groups[1].Value, CultureInfo.InvariantCulture), int.Parse(db.Groups[3].Value, CultureInfo.InvariantCulture), db.Groups[4].Success ? int.Parse(db.Groups[4].Value, CultureInfo.InvariantCulture) : null);
        }
        else if (direct.Success)
        {
            layout = direct.Groups[2].Value.ToUpperInvariant();
            address = new(direct.Groups[1].Value.ToUpperInvariant() switch { "M" => DataType.Memory, "I" or "E" => DataType.Input, _ => DataType.Output },
                0, int.Parse(direct.Groups[3].Value, CultureInfo.InvariantCulture), direct.Groups[4].Success ? int.Parse(direct.Groups[4].Value, CultureInfo.InvariantCulture) : null);
        }
        else throw new ArgumentException("Use an S7 DB/marker/input/output byte or bit address, such as DB10.DBD20 or DB10.DBX0.3.");
        if (address.Db > 65535 || address.Start > 2_097_151 || address.Start + ByteLength(point) > 2_097_152)
            throw new ArgumentException("The S7 address exceeds the supported address space.");
        if (DeviceScalarCodec.StorageType(point) == "Boolean")
        {
            if (address.Bit is null || layout is not ("X" or "")) throw new ArgumentException("S7 Boolean points require an explicit bit address.");
        }
        else if (address.Bit is not null || layout is "X" or "" || layout == "W" && ByteLength(point) != 2 || layout == "D" && ByteLength(point) != 4)
            throw new ArgumentException("The S7 address width does not match the point type; use DBB/MB/IB for a declared raw-byte layout.");
        if (point.Writable && address.Area is not (DataType.DataBlock or DataType.Memory))
            throw new ArgumentException("This S7 profile permits writes only to DB and marker memory.");
        return address;
    }

    public static void ValidatePoint(DevicePoint point) => _ = Parse(point);
    private static int ByteLength(DevicePoint point) => DeviceScalarCodec.StorageType(point) == "String"
        ? point.StringLength is >= 1 and <= 254 ? point.StringLength + 2 : throw new ArgumentException("S7 STRING capacity must be 1–254 ASCII characters.")
        : DeviceScalarCodec.Width(DeviceScalarCodec.StorageType(point));

    private Plc Client()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        return new Plc(cpu, settings.Host, settings.Port, checked((short)settings.Rack), checked((short)settings.Slot))
        { ReadTimeout = settings.TimeoutMs, WriteTimeout = settings.TimeoutMs };
    }

    public Task TestAsync(CancellationToken cancellation) => DeviceScalarCodec.SdkAsync(() => TestCoreAsync(cancellation), "S7");
    private async Task TestCoreAsync(CancellationToken cancellation)
    {
        using var deadline = DeviceScalarCodec.Deadline(settings.TimeoutMs, cancellation);
        using var client = Client();
        await client.OpenAsync(deadline.Token);
        _ = await client.ReadStatusAsync(deadline.Token);
    }

    public Task<IReadOnlyList<BrowseNode>> BrowseAsync(string? parent, CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(disposed, this); cancellation.ThrowIfCancellationRequested();
        return Task.FromResult(string.IsNullOrEmpty(parent) ? DeviceConfiguration.Map(settings) : (IReadOnlyList<BrowseNode>)Array.Empty<BrowseNode>());
    }

    public Task<IReadOnlyList<ConnectorValue>> ReadAsync(IReadOnlyList<DevicePoint> points, CancellationToken cancellation) =>
        DeviceScalarCodec.SdkAsync(() => ReadCoreAsync(points, cancellation), "S7");
    private async Task<IReadOnlyList<ConnectorValue>> ReadCoreAsync(IReadOnlyList<DevicePoint> points, CancellationToken cancellation)
    {
        using var deadline = DeviceScalarCodec.Deadline(settings.TimeoutMs, cancellation);
        using var client = Client();
        await client.OpenAsync(deadline.Token);
        var result = new List<ConnectorValue>();
        foreach (var point in points)
        {
            deadline.Token.ThrowIfCancellationRequested();
            try
            {
                var address = Parse(point);
                var bytes = await client.ReadBytesAsync(address.Area, address.Db, address.Start, ByteLength(point), deadline.Token);
                result.Add(new(point.Id, DeviceScalarCodec.Decode(point, Decode(point, address.Bit, bytes)), point.DataType, "Good", DateTimeOffset.UtcNow));
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !deadline.IsCancellationRequested)
            { result.Add(DeviceScalarCodec.Bad(point, ex)); }
        }
        return result;
    }

    internal static object Decode(DevicePoint point, int? bit, byte[] bytes)
    {
        if (bytes.Length != ByteLength(point)) throw new ArgumentException("The S7 response length does not match the declared point.");
        return DeviceScalarCodec.StorageType(point) switch
        {
            "Boolean" => (bytes[0] & (1 << bit!.Value)) != 0,
            "Int16" => BinaryPrimitives.ReadInt16BigEndian(bytes), "UInt16" => BinaryPrimitives.ReadUInt16BigEndian(bytes),
            "Int32" => BinaryPrimitives.ReadInt32BigEndian(bytes), "UInt32" => BinaryPrimitives.ReadUInt32BigEndian(bytes),
            "Int64" => BinaryPrimitives.ReadInt64BigEndian(bytes), "Float" => BinaryPrimitives.ReadSingleBigEndian(bytes),
            "Double" => BinaryPrimitives.ReadDoubleBigEndian(bytes), "String" => DecodeString(point, bytes),
            _ => throw new ArgumentException("Unsupported S7 scalar type.")
        };
    }

    private static string DecodeString(DevicePoint point, byte[] bytes)
    {
        if (bytes[0] != point.StringLength || bytes[1] > bytes[0] || bytes.AsSpan(2, bytes[1]).ContainsAnyInRange((byte)128, byte.MaxValue))
            throw new ArgumentException("The S7 STRING header or character encoding differs from its saved layout.");
        return Encoding.ASCII.GetString(bytes, 2, bytes[1]);
    }

    internal static byte[] Encode(DevicePoint point, object value)
    {
        var bytes = new byte[ByteLength(point)];
        switch (DeviceScalarCodec.StorageType(point))
        {
            case "Int16": BinaryPrimitives.WriteInt16BigEndian(bytes, (short)value); break;
            case "UInt16": BinaryPrimitives.WriteUInt16BigEndian(bytes, (ushort)value); break;
            case "Int32": BinaryPrimitives.WriteInt32BigEndian(bytes, (int)value); break;
            case "UInt32": BinaryPrimitives.WriteUInt32BigEndian(bytes, (uint)value); break;
            case "Int64": BinaryPrimitives.WriteInt64BigEndian(bytes, (long)value); break;
            case "Float": BinaryPrimitives.WriteSingleBigEndian(bytes, (float)value); break;
            case "Double": BinaryPrimitives.WriteDoubleBigEndian(bytes, (double)value); break;
            case "String": bytes[0] = (byte)point.StringLength; bytes[1] = (byte)((string)value).Length; Encoding.ASCII.GetBytes((string)value, bytes.AsSpan(2)); break;
            default: throw new ArgumentException("Unsupported S7 byte-write type.");
        }
        return bytes;
    }

    public Task<string> WriteAsync(DevicePoint point, JsonElement value, Action? beforeDispatch, CancellationToken cancellation) =>
        DeviceScalarCodec.SdkAsync(() => WriteCoreAsync(point, value, beforeDispatch, cancellation), "S7");
    private async Task<string> WriteCoreAsync(DevicePoint point, JsonElement value, Action? beforeDispatch, CancellationToken cancellation)
    {
        var address = Parse(point);
        if (!point.Writable) throw new ArgumentException("This point does not permit writes.");
        var raw = DeviceScalarCodec.Encode(point, value);
        using var deadline = DeviceScalarCodec.Deadline(settings.TimeoutMs, cancellation);
        using var client = Client();
        await client.OpenAsync(deadline.Token);
        var bytes = DeviceScalarCodec.StorageType(point) == "Boolean" ? null : Encode(point, raw);
        if (bytes is not null && bytes.Length > client.MaxPDUSize - 64)
            throw new ArgumentException("This scalar write does not fit a single negotiated S7 request.");
        // Confirm the declared STRING capacity before modifying a controller-owned buffer.
        if (DeviceScalarCodec.StorageType(point) == "String")
        {
            var current = await client.ReadBytesAsync(address.Area, address.Db, address.Start, ByteLength(point), deadline.Token);
            _ = DecodeString(point, current);
        }
        deadline.Token.ThrowIfCancellationRequested(); beforeDispatch?.Invoke();
        if (DeviceScalarCodec.StorageType(point) == "Boolean") await client.WriteBitAsync(address.Area, address.Db, address.Start, address.Bit!.Value, (bool)raw, deadline.Token);
        else await client.WriteBytesAsync(address.Area, address.Db, address.Start, bytes!, deadline.Token);
        return "Good";
    }

    public void Dispose() => disposed = true;
}
