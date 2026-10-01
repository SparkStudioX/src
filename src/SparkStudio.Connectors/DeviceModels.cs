using System.Text.Json;
using System.Text.RegularExpressions;

namespace SparkStudio.Connectors;

public sealed record DeviceSettings
{
    public string Host { get; init; } = "";
    public int Port { get; init; } = 502;
    public int UnitId { get; init; } = 1;
    public string ControllerFamily { get; init; } = "ControlLogix";
    public string Route { get; init; } = "1,0";
    public int Rack { get; init; }
    public int Slot { get; init; }
    public string LocalAmsNetId { get; init; } = "";
    public string TargetAmsNetId { get; init; } = "";
    public int TimeoutMs { get; init; } = 2000;
    public string ContentionDomain { get; init; } = "";
    public IReadOnlyList<DevicePoint> Points { get; init; } = Array.Empty<DevicePoint>();
}

public sealed record DevicePoint
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public string Address { get; init; } = "";
    public string DataType { get; init; } = "Double";
    public string? RawDataType { get; init; }
    public bool Writable { get; init; }
    public bool ByteSwap { get; init; }
    public bool WordSwap { get; init; }
    public int StringLength { get; init; } = 32;
    public double Scale { get; init; } = 1;
    public double Offset { get; init; }
}

public interface IDeviceSession : IDisposable
{
    Task TestAsync(CancellationToken cancellation);
    Task<IReadOnlyList<BrowseNode>> BrowseAsync(string? parent, CancellationToken cancellation);
    Task<IReadOnlyList<ConnectorValue>> ReadAsync(IReadOnlyList<DevicePoint> points, CancellationToken cancellation);
    Task<string> WriteAsync(DevicePoint point, JsonElement value, Action? beforeDispatch, CancellationToken cancellation);
}

public sealed record DeviceDriverDescriptor(string Type, string Name, string BrowseMode, int DefaultPort,
    bool CanRead = true, bool CanWrite = true);

public static class DeviceConfiguration
{
    public const int MaximumMapBytes = 768 * 1024;
    private static readonly JsonSerializerOptions MapSizeJson = new()
    { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    public static readonly IReadOnlyList<DeviceDriverDescriptor> Drivers = new DeviceDriverDescriptor[]
    {
        new("modbus-tcp", "Modbus TCP", "configured", 502),
        new("ab-eip", "Allen Bradley EtherNet/IP", "native/configured", 44818),
        new("siemens-s7", "Siemens S7", "configured", 102),
        new("beckhoff-ads", "Beckhoff ADS", "native/configured", 851),
    };
    public static bool IsDevice(string type) => Drivers.Any(driver => driver.Type == type);
    public static bool IsDevice(ConnectionDefinition connection) => IsDevice(connection.Type);
    public static DeviceSettings Validate(DeviceSettings settings, string type)
    {
        ArgumentNullException.ThrowIfNull(settings);
        if (!IsDevice(type)) throw new ArgumentException("Unsupported industrial driver.");
        if (string.IsNullOrWhiteSpace(settings.Host) || settings.Host.Length > 253 || settings.Host.Any(char.IsControl)
            || settings.Host.IndexOfAny(['/', '\\', '@', '&', '?', '#', '=']) >= 0 || settings.Host != settings.Host.Trim())
            throw new ArgumentException("Supply a device host name or IP address without credentials or a URL.");
        if (Uri.CheckHostName(settings.Host) == UriHostNameType.Unknown) throw new ArgumentException("Device host is invalid.");
        if (settings.Port is < 1 or > 65535 || settings.TimeoutMs is < 100 or > 30000)
            throw new ArgumentException("Choose a valid device port and a timeout from 100 through 30000 ms.");
        if (settings.UnitId is < 0 or > 255 || settings.Rack is < 0 or > 255 || settings.Slot is < 0 or > 255)
            throw new ArgumentException("Device unit, rack and slot must fit an unsigned byte.");
        if (settings.ControllerFamily is null || settings.Route is null || settings.ControllerFamily.Length > 32 || settings.Route.Length > 128 || settings.Route.Any(char.IsControl)
            || settings.Route.IndexOfAny(['&', '=', ';']) >= 0) throw new ArgumentException("Invalid controller family or routing path.");
        if (settings.ContentionDomain is null || settings.ContentionDomain.Length > 128 || settings.ContentionDomain.Any(char.IsControl)
            || settings.ContentionDomain != settings.ContentionDomain.Trim()) throw new ArgumentException("Use a bounded physical device command domain without surrounding whitespace.");
        if (type == "ab-eip") EthernetIpDeviceSession.ValidateSettings(settings);
        if (type == "siemens-s7" && (!Enum.TryParse<S7.Net.CpuType>(settings.ControllerFamily, true, out var cpu) || !Enum.IsDefined(cpu)))
            throw new ArgumentException("Choose a supported S7 CPU family.");
        if (type == "beckhoff-ads")
        {
            foreach (var netId in new[] { settings.LocalAmsNetId, settings.TargetAmsNetId })
                if (netId is null || !Regex.IsMatch(netId, @"^\d{1,3}(\.\d{1,3}){5}$") || netId.Split('.').Any(part => !byte.TryParse(part, out _)))
                    throw new ArgumentException("ADS requires local and target AMS Net IDs with six byte components.");
        }
        if (settings.Points is null || settings.Points.Count > 10000) throw new ArgumentException("Configure at most 10000 device points.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var point in settings.Points)
        {
            if (point is null || point.Id is null || !Regex.IsMatch(point.Id, "^[A-Za-z][A-Za-z0-9_-]{0,63}$") || !ids.Add(point.Id))
                throw new ArgumentException("Point IDs must be unique names of at most 64 letters, digits, underscores or hyphens.");
            if (string.IsNullOrWhiteSpace(point.Name) || point.Name.Length > 256 || point.Name.Any(char.IsControl)
                || string.IsNullOrWhiteSpace(point.Address) || point.Address.Length > 512 || point.Address.Any(char.IsControl)
                || point.Address.IndexOfAny(['&', '=', ';']) >= 0) throw new ArgumentException("Supply a bounded point name and native address.");
            if (point.DataType is not ("Boolean" or "Int16" or "UInt16" or "Int32" or "UInt32" or "Int64" or "Float" or "Double" or "String"))
                throw new ArgumentException("Unsupported device point type.");
            var rawType = point.RawDataType ?? point.DataType;
            if (rawType is not ("Boolean" or "Int16" or "UInt16" or "Int32" or "UInt32" or "Int64" or "Float" or "Double" or "String")
                || (rawType is "Boolean" or "String" || point.DataType is "Boolean" or "String") && rawType != point.DataType)
                throw new ArgumentException("Choose a supported raw encoding; Boolean and String storage must match their engineering type.");
            if (point.StringLength is < 1 or > 1024 || !double.IsFinite(point.Scale) || !double.IsFinite(point.Offset) || point.Scale == 0
                || (point.DataType is "Boolean" or "String") && (point.Scale != 1 || point.Offset != 0))
                throw new ArgumentException("Point encoding requires a bounded length and finite, invertible numeric scaling.");
            if (rawType.StartsWith("Int", StringComparison.Ordinal) || rawType.StartsWith("UInt", StringComparison.Ordinal)
                || point.DataType.StartsWith("Int", StringComparison.Ordinal) || point.DataType.StartsWith("UInt", StringComparison.Ordinal))
            {
                try
                {
                    if (Math.Abs(point.Scale) < 1e-28 || point.Offset != 0 && Math.Abs(point.Offset) < 1e-28)
                        throw new ArgumentException("Integer encodings require nonzero scale/offset magnitudes of at least 1e-28.");
                    if ((decimal)point.Scale == 0) throw new ArgumentException("Integer encodings require a scale representable as a nonzero decimal.");
                    _ = (decimal)point.Offset;
                }
                catch (OverflowException) { throw new ArgumentException("Integer encodings require scale and offset within the decimal range."); }
            }
            if (type == "modbus-tcp") ModbusDeviceSession.ValidatePoint(point);
            else if (type == "ab-eip") EthernetIpDeviceSession.ValidatePoint(point, settings.ControllerFamily);
            else if (type == "siemens-s7") SiemensS7DeviceSession.ValidatePoint(point);
            else if (type == "beckhoff-ads") BeckhoffAdsDeviceSession.ValidatePoint(point);
        }
        if (JsonSerializer.SerializeToUtf8Bytes(settings.Points, MapSizeJson).Length > MaximumMapBytes)
            throw new ArgumentException("The saved point map exceeds 768 KiB. Split it into smaller connections.");
        return settings;
    }
    public static DevicePoint Point(ConnectionDefinition connection, string id)
        => connection.Device?.Points.FirstOrDefault(point => point.Id == id)
            ?? throw new ArgumentException("The device point is not in this connection's saved map.");
    public static string ContentionKey(ConnectionDefinition connection)
        => IsDevice(connection) ? $"device:{(string.IsNullOrEmpty(connection.Device!.ContentionDomain) ? connection.Device.Host : connection.Device.ContentionDomain).ToLowerInvariant()}" : $"opc:{connection.Endpoint}";
    public static IReadOnlyList<BrowseNode> Map(DeviceSettings settings)
        => settings.Points.Select(point => new BrowseNode(point.Id, point.Name, true, point.DataType, point.Writable, "configured", point.Id, point.Address,
            point.DataType == "String" ? point.StringLength : null)).ToArray();
}
