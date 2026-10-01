using System.Buffers.Binary;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace SparkStudio.Connectors;

/// <summary>Serialized Modbus TCP transport. Mutations have one dispatch and are never replayed.</summary>
internal sealed class ModbusDeviceSession : IDeviceSession
{
    private readonly DeviceSettings _settings;
    private TcpClient? _client;
    private ushort _transaction;
    public ModbusDeviceSession(ConnectionDefinition connection)
        => _settings = DeviceConfiguration.Validate(connection.Device ?? throw new ArgumentException("Device settings are required."), connection.Type);

    internal readonly record struct Address(byte Function, ushort Offset, int Count);
    internal static Address Parse(DevicePoint point)
    {
        var parts = point.Address.Split(':');
        if (parts.Length != 2 || !ushort.TryParse(parts[1], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var offset))
            throw new ArgumentException("Use a zero-based Modbus address, for example holdingRegister:0 or coil:0.");
        byte function = parts[0] switch { "coil" => 1, "discreteInput" => 2, "holdingRegister" => 3, "inputRegister" => 4, _ => throw new ArgumentException("Unknown Modbus register table.") };
        var rawType = point.RawDataType ?? point.DataType;
        var count = function <= 2 ? 1 : rawType == "String" ? (point.StringLength + 1) / 2 : DeviceScalarCodec.Width(rawType) / 2;
        return new(function, offset, count);
    }
    internal static void ValidatePoint(DevicePoint point)
    {
        var address = Parse(point);
        if ((address.Function <= 2) != ((point.RawDataType ?? point.DataType) == "Boolean")) throw new ArgumentException("Modbus coil/input bits require Boolean; register tables require numeric or String types.");
        if (address.Count is < 1 or > 125 || address.Offset + address.Count > 65536 || point.Writable && address.Count > 123)
            throw new ArgumentException("The Modbus point span exceeds the protocol range or request size.");
        if (point.Writable && address.Function is 2 or 4) throw new ArgumentException("Discrete inputs and input registers are read-only.");
        if (address.Function <= 2 && (point.ByteSwap || point.WordSwap)) throw new ArgumentException("Bit points do not have byte or word order.");
    }
    public async Task TestAsync(CancellationToken cancellation)
    {
        if (_settings.Points.Count > 0)
        {
            var values = await ReadAsync([_settings.Points[0]], cancellation);
            if (!values[0].Quality.StartsWith("Good", StringComparison.Ordinal)) throw new InvalidOperationException("The Modbus endpoint responded, but the first mapped point could not be read.");
        }
        else
        {
            // Read-only Device Identification; older devices may explicitly reject this optional function.
            try
            {
                var identification = await ExchangeAsync([43, 14, 1, 0], cancellation);
                if (identification.Length < 7 || identification[1] != 14 || identification[2] != 1)
                    throw new IOException("Modbus returned an invalid device identification response.");
            }
            catch (ModbusRejection error) when (error.Code is 1 or 2 or 3) { }
        }
    }
    public Task<IReadOnlyList<BrowseNode>> BrowseAsync(string? parent, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        return Task.FromResult<IReadOnlyList<BrowseNode>>(string.IsNullOrEmpty(parent) ? DeviceConfiguration.Map(_settings) : []);
    }
    public async Task<IReadOnlyList<ConnectorValue>> ReadAsync(IReadOnlyList<DevicePoint> points, CancellationToken cancellation)
    {
        var indexed = points.Select((point, index) => (Point: point, Index: index, Address: Parse(point))).OrderBy(item => item.Address.Function).ThenBy(item => item.Address.Offset).ToArray();
        var result = new ConnectorValue[points.Count];
        for (var position = 0; position < indexed.Length;)
        {
            var first = indexed[position];
            var end = first.Address.Offset + first.Address.Count;
            var next = position + 1;
            var limit = first.Address.Function <= 2 ? 2000 : 125;
            // Group only overlapping/adjacent ranges; do not read unconfigured gaps.
            while (next < indexed.Length && indexed[next].Address.Function == first.Address.Function && indexed[next].Address.Offset <= end
                && Math.Max(end, indexed[next].Address.Offset + indexed[next].Address.Count) - first.Address.Offset <= limit)
            { end = Math.Max(end, indexed[next].Address.Offset + indexed[next].Address.Count); next++; }
            var request = new byte[5]; request[0] = first.Address.Function;
            BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(1), first.Address.Offset);
            BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(3), (ushort)(end - first.Address.Offset));
            byte[]? response = null;
            string? rejection = null;
            try
            {
                response = await ExchangeAsync(request, cancellation);
                var expected = first.Address.Function <= 2 ? (end - first.Address.Offset + 7) / 8 : (end - first.Address.Offset) * 2;
                if (response.Length != expected + 2 || response[1] != expected) throw new IOException("Modbus returned an invalid register byte count.");
            }
            catch (ModbusRejection error) { rejection = error.Quality; }
            var timestamp = DateTimeOffset.UtcNow;
            for (var i = position; i < next; i++)
            {
                var item = indexed[i];
                if (rejection is not null) { result[item.Index] = new(item.Point.Id, null, item.Point.DataType, rejection, timestamp); continue; }
                try
                {
                    object raw;
                    var delta = item.Address.Offset - first.Address.Offset;
                    if (item.Address.Function <= 2) raw = (response![2 + delta / 8] & (1 << (delta % 8))) != 0;
                    else raw = Decode(item.Point, response!.AsSpan(2 + delta * 2, item.Address.Count * 2));
                    result[item.Index] = new(item.Point.Id, DeviceScalarCodec.Decode(item.Point, raw), item.Point.DataType, "Good", timestamp);
                }
                catch (Exception error) when (error is ArgumentException or OverflowException) { result[item.Index] = DeviceScalarCodec.Bad(item.Point, error); }
            }
            position = next;
        }
        return result;
    }
    public async Task<string> WriteAsync(DevicePoint point, JsonElement value, Action? beforeDispatch, CancellationToken cancellation)
    {
        ValidatePoint(point);
        if (!point.Writable) throw new ArgumentException("The saved point map does not permit writing this address.");
        var address = Parse(point);
        var raw = DeviceScalarCodec.Encode(point, value);
        byte[] request;
        if (address.Function == 1)
        {
            request = new byte[5]; request[0] = 5;
            BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(1), address.Offset);
            BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(3), (bool)raw ? (ushort)0xff00 : (ushort)0);
        }
        else
        {
            var bytes = Encode(point, raw);
            request = new byte[address.Count == 1 ? 5 : 6 + bytes.Length];
            request[0] = address.Count == 1 ? (byte)6 : (byte)16;
            BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(1), address.Offset);
            if (address.Count == 1) bytes.CopyTo(request, 3);
            else
            {
                BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(3), (ushort)address.Count);
                request[5] = (byte)bytes.Length; bytes.CopyTo(request, 6);
            }
        }
        byte[] response;
        try { response = await ExchangeAsync(request, cancellation, beforeDispatch); }
        catch (ModbusRejection error) { return error.Quality; }
        if (response.Length != 5 || !response.AsSpan().SequenceEqual(request.AsSpan(0, 5)))
            throw new IOException("Modbus write acknowledgement does not match the request; the outcome is uncertain.");
        return "Good";
    }
    private async Task<byte[]> ExchangeAsync(byte[] pdu, CancellationToken cancellation, Action? beforeDispatch = null)
    {
        using var deadline = DeviceScalarCodec.Deadline(cancellation, _settings.TimeoutMs);
        if (_client is null)
        {
            _client = new TcpClient { NoDelay = true };
            try { await _client.ConnectAsync(_settings.Host, _settings.Port, deadline.Token); }
            catch { _client.Dispose(); _client = null; throw; }
        }
        var stream = _client.GetStream();
        var transaction = unchecked(++_transaction);
        var frame = new byte[7 + pdu.Length];
        BinaryPrimitives.WriteUInt16BigEndian(frame, transaction);
        BinaryPrimitives.WriteUInt16BigEndian(frame.AsSpan(4), (ushort)(pdu.Length + 1));
        frame[6] = (byte)_settings.UnitId; pdu.CopyTo(frame, 7);
        deadline.Token.ThrowIfCancellationRequested();
        beforeDispatch?.Invoke();
        await stream.WriteAsync(frame, deadline.Token);
        var header = new byte[7]; await stream.ReadExactlyAsync(header, deadline.Token);
        var length = BinaryPrimitives.ReadUInt16BigEndian(header.AsSpan(4));
        if (BinaryPrimitives.ReadUInt16BigEndian(header) != transaction || BinaryPrimitives.ReadUInt16BigEndian(header.AsSpan(2)) != 0
            || header[6] != _settings.UnitId || length is < 2 or > 254) throw new IOException("Modbus returned an invalid transaction header.");
        var response = new byte[length - 1]; await stream.ReadExactlyAsync(response, deadline.Token);
        if (response[0] == (pdu[0] | 0x80) && response.Length == 2) throw new ModbusRejection(response[1]);
        if (response[0] != pdu[0]) throw new IOException("Modbus response function does not match the request.");
        return response;
    }
    internal static object Decode(DevicePoint point, ReadOnlySpan<byte> wire)
    {
        var bytes = wire.ToArray(); Swap(point, bytes);
        return (point.RawDataType ?? point.DataType) switch
        {
            "Int16" => BinaryPrimitives.ReadInt16BigEndian(bytes), "UInt16" => BinaryPrimitives.ReadUInt16BigEndian(bytes),
            "Int32" => BinaryPrimitives.ReadInt32BigEndian(bytes), "UInt32" => BinaryPrimitives.ReadUInt32BigEndian(bytes),
            "Int64" => BinaryPrimitives.ReadInt64BigEndian(bytes), "Float" => BinaryPrimitives.ReadSingleBigEndian(bytes),
            "Double" => BinaryPrimitives.ReadDoubleBigEndian(bytes),
            "String" => DecodeString(bytes.AsSpan(0, point.StringLength)), _ => throw new ArgumentException("Unsupported Modbus register type.")
        };
    }
    private static string DecodeString(ReadOnlySpan<byte> bytes)
    {
        var zero = bytes.IndexOf((byte)0); if (zero >= 0) bytes = bytes[..zero];
        foreach (var value in bytes) if (value > 127) throw new ArgumentException("Modbus string contains a non-ASCII byte.");
        return Encoding.ASCII.GetString(bytes);
    }
    internal static byte[] Encode(DevicePoint point, object raw)
    {
        var bytes = new byte[Parse(point).Count * 2];
        switch (raw)
        {
            case short value: BinaryPrimitives.WriteInt16BigEndian(bytes, value); break;
            case ushort value: BinaryPrimitives.WriteUInt16BigEndian(bytes, value); break;
            case int value: BinaryPrimitives.WriteInt32BigEndian(bytes, value); break;
            case uint value: BinaryPrimitives.WriteUInt32BigEndian(bytes, value); break;
            case long value: BinaryPrimitives.WriteInt64BigEndian(bytes, value); break;
            case float value: BinaryPrimitives.WriteSingleBigEndian(bytes, value); break;
            case double value: BinaryPrimitives.WriteDoubleBigEndian(bytes, value); break;
            case string value: Encoding.ASCII.GetBytes(value).CopyTo(bytes, 0); break;
            default: throw new ArgumentException("Unsupported Modbus scalar.");
        }
        Swap(point, bytes); return bytes;
    }
    private static void Swap(DevicePoint point, byte[] bytes)
    {
        if (point.ByteSwap) for (var i = 0; i < bytes.Length; i += 2) (bytes[i], bytes[i + 1]) = (bytes[i + 1], bytes[i]);
        if (point.WordSwap) for (int left = 0, right = bytes.Length - 2; left < right; left += 2, right -= 2)
        { (bytes[left], bytes[right]) = (bytes[right], bytes[left]); (bytes[left + 1], bytes[right + 1]) = (bytes[right + 1], bytes[left + 1]); }
    }
    public void Dispose() { _client?.Dispose(); _client = null; }
    private sealed class ModbusRejection(byte code) : IOException($"Modbus exception {code}.")
    {
        public byte Code => code;
        public string Quality => code switch { 1 => "Bad_NotSupported", 2 => "Bad_AddressUnknown", 3 => "Bad_OutOfRange", 6 => "Bad_DeviceBusy", _ => "Bad_DeviceFailure" };
    }
}
