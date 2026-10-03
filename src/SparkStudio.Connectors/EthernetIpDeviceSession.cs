using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using libplctag;
using libplctag.DataTypes;

namespace SparkStudio.Connectors;

public sealed class EthernetIpDeviceSession : IDeviceSession
{
    private readonly DeviceSettings settings;
    private readonly string dataDirectory;
    private readonly PlcType plcType;
    private bool disposed;

    public EthernetIpDeviceSession(ConnectionDefinition connection, string dataDirectory)
    {
        this.dataDirectory = EmbeddedPlcRuntime.NormalizeDataDirectory(dataDirectory);
        settings = connection.Device ?? throw new ArgumentException("EtherNet/IP device settings are required.");
        ValidateSettings(settings);
        plcType = settings.ControllerFamily is "ControlLogix" or "CompactLogix" ? PlcType.ControlLogix : Enum.Parse<PlcType>(settings.ControllerFamily);
        foreach (var point in settings.Points) ValidatePoint(point, settings.ControllerFamily);
    }

    public static bool HasNativeBrowse(string family) => family is "ControlLogix" or "CompactLogix";
    private static bool IsPccc(string family) => family is "MicroLogix" or "Slc500" or "Plc5";

    public static void ValidateSettings(DeviceSettings settings)
    {
        if (settings.ControllerFamily is not ("ControlLogix" or "CompactLogix" or "Micro800" or "MicroLogix" or "Slc500" or "Plc5"))
            throw new ArgumentException("Choose a supported Allen Bradley controller family.");
        if (HasNativeBrowse(settings.ControllerFamily))
        {
            if (settings.Route is null || !Regex.IsMatch(settings.Route, @"^\d{1,3}(,\d{1,3})+$") ||
                settings.Route.Split(',').Length % 2 != 0 || settings.Route.Split(',').Any(part => !byte.TryParse(part, out _)))
                throw new ArgumentException("Supply numeric CIP port/link pairs, such as 1,0.");
        }
        else if (!string.IsNullOrEmpty(settings.Route))
            throw new ArgumentException("This family profile uses direct Ethernet access and requires an empty routing path; DH+ bridges are not supported.");
    }

    internal readonly record struct PcccAddress(string Prefix, int File, int Element, int? Bit)
    {
        internal int Width => Prefix is "N" or "B" ? 2 : Prefix == "ST" ? 84 : 4;
        internal string Canonical => $"{Prefix}{File}:{Element}" + (Bit is int bit ? $"/{bit}" : "");
    }

    internal static PcccAddress ParsePccc(DevicePoint point, string family)
    {
        var match = Regex.Match(point.Address, @"^(ST|N|B|F|L)(\d{1,3}):(\d{1,5})(?:/(\d{1,2}))?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        if (!match.Success) throw new ArgumentException("Use a supported PCCC file address such as N7:0, B3:0/2, F8:0 or ST9:0.");
        var address = new PcccAddress(match.Groups[1].Value.ToUpperInvariant(), int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture), int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture),
            match.Groups[4].Success ? int.Parse(match.Groups[4].Value, CultureInfo.InvariantCulture) : null);
        if (address.File > 255 || address.Element > 65535 || address.Bit > 15)
            throw new ArgumentException("PCCC files must be 0–255, elements 0–65535 and word bits 0–15.");
        var raw = DeviceScalarCodec.StorageType(point);
        var valid = address.Prefix switch
        {
            "N" or "B" => address.Bit is null ? raw is "Int16" or "UInt16" : raw == "Boolean",
            "F" => address.Bit is null && raw == "Float",
            "L" => family == "MicroLogix" && address.Bit is null && raw is "Int32" or "UInt32",
            "ST" => address.Bit is null && raw == "String" && point.StringLength is >= 1 and <= 82,
            _ => false
        };
        if (!valid) throw new ArgumentException("The PCCC file/bit address does not match its raw type or controller family. L files require MicroLogix; ST strings hold at most 82 ASCII characters.");
        return address;
    }

    public static void ValidatePoint(DevicePoint point, string family = "ControlLogix")
    {
        DeviceScalarCodec.NativeLayout(point);
        if (IsPccc(family)) { _ = ParsePccc(point, family); return; }
        if (!HasNativeBrowse(family) && family != "Micro800") throw new ArgumentException("Unsupported Allen Bradley controller family.");
        if (!Regex.IsMatch(point.Address, @"^(?:Program:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*(?:\[\d+(?:,\d+)*\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\d+(?:,\d+)*\])?)*$", RegexOptions.CultureInvariant))
            throw new ArgumentException("Use a Logix symbolic tag, optional Program scope, member path or array element. Numeric bit selectors require a separate qualified profile.");
        if (family == "Micro800" && (point.Address.Contains(':') || DeviceScalarCodec.StorageType(point) == "String"))
            throw new ArgumentException("This Micro800 profile supports global symbolic numeric/Boolean values. Program scopes and the distinct Micro800 STRING layout are not supported.");
        if (DeviceScalarCodec.StorageType(point) == "String")
            throw new ArgumentException("String storage is outside the qualified ControlLogix/CompactLogix profile until the controller structure schema is verified; use numeric/Boolean symbols.");
    }

    private string Gateway => settings.Host.Contains(':') ? $"[{settings.Host}]:{settings.Port}" : $"{settings.Host}:{settings.Port}";

    internal Tag CreateTag(DevicePoint point)
    {
        ObjectDisposedException.ThrowIf(disposed, this); ValidatePoint(point, settings.ControllerFamily);
        var pccc = IsPccc(settings.ControllerFamily) ? ParsePccc(point, settings.ControllerFamily) : (PcccAddress?)null;
        return new Tag
        {
            Name = pccc?.Canonical ?? point.Address, Gateway = Gateway, Path = string.IsNullOrEmpty(settings.Route) ? null : settings.Route, PlcType = plcType,
            ElementSize = pccc?.Width,
            Protocol = Protocol.ab_eip, ElementCount = 1, Timeout = TimeSpan.FromMilliseconds(settings.TimeoutMs),
            // Pinned core 2.6.0 misclassifies valid UCMM write replies. Logix and
            // Micro800 scalar access uses the SDK's connected CIP transport.
            ReadCacheMillisecondDuration = 0, AllowPacking = false, UseConnectedMessaging = !IsPccc(settings.ControllerFamily),
            AutoSyncReadInterval = TimeSpan.Zero, AutoSyncWriteInterval = TimeSpan.Zero
        };
    }

    public Task TestAsync(CancellationToken cancellation) => DeviceScalarCodec.SdkAsync(() => TestCoreAsync(cancellation), "EtherNet/IP");
    private async Task TestCoreAsync(CancellationToken cancellation)
    {
        if (HasNativeBrowse(settings.ControllerFamily)) { _ = await BrowseNativeAsync(null, cancellation); return; }
        var point = (settings.Points.Count > 0 ? settings.Points[0] : null) ?? throw new ArgumentException("Add a saved point before testing this family; the connection test reads that point.");
        using var deadline = DeviceScalarCodec.Deadline(settings.TimeoutMs, cancellation);
        deadline.Token.ThrowIfCancellationRequested(); EmbeddedPlcRuntime.EnsureAvailable(dataDirectory);
        using var tag = CreateTag(point);
        await tag.ReadAsync(deadline.Token);
        ValidateNativeType(tag, point);
        _ = DeviceScalarCodec.Decode(point, ReadNativeValue(tag, point));
    }

    public Task<IReadOnlyList<BrowseNode>> BrowseAsync(string? parent, CancellationToken cancellation) =>
        DeviceScalarCodec.SdkAsync(() => BrowseCoreAsync(parent, cancellation), "EtherNet/IP");
    private async Task<IReadOnlyList<BrowseNode>> BrowseCoreAsync(string? parent, CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(disposed, this); cancellation.ThrowIfCancellationRequested();
        if (parent == "@configured") return DeviceConfiguration.Map(settings);
        if (!HasNativeBrowse(settings.ControllerFamily))
            return string.IsNullOrEmpty(parent) ? DeviceConfiguration.Map(settings) : Array.Empty<BrowseNode>();
        var entries = await BrowseNativeAsync(parent, cancellation);
        if (string.IsNullOrEmpty(parent) && settings.Points.Count != 0)
            return new[] { new BrowseNode("@configured", "Saved point map", false, null, false, "configured") }.Concat(entries).ToArray();
        return entries;
    }

    private Task<IReadOnlyList<BrowseNode>> BrowseNativeAsync(string? parent, CancellationToken cancellation) =>
        DeviceScalarCodec.SdkAsync(() => BrowseNativeCoreAsync(parent, cancellation), "EtherNet/IP");
    private async Task<IReadOnlyList<BrowseNode>> BrowseNativeCoreAsync(string? parent, CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (!string.IsNullOrEmpty(parent) && !Regex.IsMatch(parent, @"^Program:[A-Za-z_][A-Za-z0-9_]*$"))
            throw new ArgumentException("Choose a controller or program symbol catalog.");
        cancellation.ThrowIfCancellationRequested(); EmbeddedPlcRuntime.EnsureAvailable(dataDirectory);
        using var deadline = DeviceScalarCodec.Deadline(settings.TimeoutMs, cancellation);
        using var listing = new Tag<TagInfoPlcMapper, TagInfo[]>
        {
            Name = string.IsNullOrEmpty(parent) ? "@tags" : parent + ".@tags", Gateway = Gateway,
            Path = settings.Route, PlcType = PlcType.ControlLogix, Protocol = Protocol.ab_eip,
            Timeout = TimeSpan.FromMilliseconds(settings.TimeoutMs), ReadCacheMillisecondDuration = 0,
            AllowPacking = false, UseConnectedMessaging = false,
            AutoSyncReadInterval = TimeSpan.Zero, AutoSyncWriteInterval = TimeSpan.Zero
        };
        var symbols = await listing.ReadAsync(deadline.Token);
        if (symbols.Length > 10000) throw new InvalidOperationException("The controller catalog exceeds the 10000-symbol browse limit. Select a narrower program scope.");
        return symbols.Select(symbol =>
        {
            var address = string.IsNullOrEmpty(parent) ? symbol.Name : parent + "." + symbol.Name;
            var program = symbol.Name.StartsWith("Program:", StringComparison.Ordinal);
            var mapped = settings.Points.FirstOrDefault(point => point.Address == address);
            // Native type metadata is informative; only a reviewed saved map grants writability.
            var scalar = (symbol.Type & 0xE000) == 0 && !(symbol.Dimensions?.Any(d => d != 0) ?? false);
            return new BrowseNode(address, symbol.Name, !program, mapped?.DataType ?? (scalar ? TypeName((ushort)(symbol.Type & 0xFF)) : "Structure/Array"),
                mapped?.Writable ?? false, "native", mapped?.Id, address, mapped?.DataType == "String" ? mapped.StringLength : null);
        }).ToArray();
    }

    internal static string? TypeName(ushort code) => code switch
    {
        0xC1 => "Boolean", 0xC3 => "Int16", 0xC7 or 0xD2 => "UInt16", 0xC4 => "Int32", 0xC8 or 0xD3 => "UInt32",
        0xC5 => "Int64", 0xCA => "Float", 0xCB => "Double", _ => null
    };

    internal static void ValidatePcccSize(DevicePoint point, string family, int byteSize)
    {
        if (ParsePccc(point, family).Width != byteSize)
            throw new ArgumentException("The PCCC response width differs from the saved file encoding.");
    }

    private void ValidateNativeType(Tag tag, DevicePoint point)
    {
        if (IsPccc(settings.ControllerFamily))
        {
            // PCCC has no native symbolic type catalog. The SDK derives the type from
            // the reviewed file prefix; validate the actual buffer width, not CIP metadata.
            ValidatePcccSize(point, settings.ControllerFamily, tag.GetSize());
            if (DeviceScalarCodec.StorageType(point) == "String" && tag.GetStringCapacity(0) != 82)
                throw new ArgumentException("The PCCC STRING response does not use its standard 82-character layout.");
            return;
        }
        // The SDK's default 88-byte buffer and 82-character capacity describe
        // its codec, not the controller's structure schema. A same-size UDT
        // cannot be treated as STRING without qualifying its member layout.
        if (DeviceScalarCodec.StorageType(point) == "String")
            throw new ArgumentException("Logix String storage requires a qualified controller structure schema.");
        var type = ReadNativeType(tag);
        if (type.Length < 2) throw new ArgumentException("The PLC did not supply scalar type metadata.");
        if (TypeName(type[0]) != DeviceScalarCodec.StorageType(point) || tag.GetSize() != DeviceScalarCodec.Width(DeviceScalarCodec.StorageType(point)))
            throw new ArgumentException("The Logix symbol type or scalar width differs from the saved point map.");
    }

    private static byte[] ReadNativeType(Tag tag)
    {
        // libplctag.NET 1.5.2 treats the native byte count as a status code in
        // GetByteArrayAttribute. Keep this pinned-SDK bridge limited to metadata;
        // Tag still owns all I/O and the native handle's lifetime.
        const System.Reflection.BindingFlags fields = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
        var wrapperField = typeof(Tag).GetField("_tag", fields);
        var wrapper = wrapperField?.GetValue(tag);
        var handleField = wrapperField?.FieldType.GetField("nativeTagHandle", fields);
        if (typeof(Tag).Assembly.GetName().Version != new Version(1, 5, 2, 0) || !tag.IsInitialized || wrapper is null ||
            wrapperField?.FieldType.FullName != "libplctag.NativeTagWrapper" || handleField?.FieldType != typeof(int) ||
            handleField.GetValue(wrapper) is not int handle || handle <= 0)
            throw new InvalidOperationException("The pinned EtherNet/IP SDK metadata bridge is unavailable.");
        const string attribute = "raw_tag_type_bytes";
        var length = libplctag.NativeImport.plctag.plc_tag_get_int_attribute(handle, attribute + ".length", -1);
        if (length is < 2 or > 64) throw new ArgumentException("The PLC did not supply supported scalar type metadata.");
        var data = new byte[length];
        var copied = libplctag.NativeImport.plctag.plc_tag_get_byte_array_attribute(handle, attribute, data, length);
        if (copied != length) throw new InvalidOperationException("The PLC scalar type metadata could not be read.");
        return data;
    }

    public async Task<IReadOnlyList<ConnectorValue>> ReadAsync(IReadOnlyList<DevicePoint> points, CancellationToken cancellation)
    {
        var result = new List<ConnectorValue>();
        using var deadline = DeviceScalarCodec.Deadline(settings.TimeoutMs, cancellation);
        foreach (var point in points)
        {
            deadline.Token.ThrowIfCancellationRequested();
            try
            {
                EmbeddedPlcRuntime.EnsureAvailable(dataDirectory);
                using var tag = CreateTag(point);
                await tag.ReadAsync(deadline.Token);
                ValidateNativeType(tag, point);
                var raw = ReadNativeValue(tag, point);
                if (raw is string text && text.Length > point.StringLength) throw new ArgumentException("The controller string exceeds the configured point capacity.");
                result.Add(new(point.Id, DeviceScalarCodec.Decode(point, raw), point.DataType, "Good", DateTimeOffset.UtcNow));
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !deadline.IsCancellationRequested)
            { result.Add(DeviceScalarCodec.Bad(point, ex)); }
        }
        return result;
    }

    private static object ReadNativeValue(Tag tag, DevicePoint point) => DeviceScalarCodec.StorageType(point) switch
    {
        "Boolean" => tag.GetBit(0), "Int16" => tag.GetInt16(0), "UInt16" => tag.GetUInt16(0),
        "Int32" => tag.GetInt32(0), "UInt32" => tag.GetUInt32(0), "Int64" => tag.GetInt64(0),
        "Float" => tag.GetFloat32(0), "Double" => tag.GetFloat64(0), "String" => tag.GetString(0),
        _ => throw new ArgumentException("Unsupported Allen Bradley scalar type.")
    };

    public Task<string> WriteAsync(DevicePoint point, JsonElement value, Action? beforeDispatch, CancellationToken cancellation) =>
        DeviceScalarCodec.SdkAsync(() => WriteCoreAsync(point, value, beforeDispatch, cancellation), "EtherNet/IP");
    private async Task<string> WriteCoreAsync(DevicePoint point, JsonElement value, Action? beforeDispatch, CancellationToken cancellation)
    {
        if (!point.Writable) throw new ArgumentException("This point does not permit writes.");
        var raw = DeviceScalarCodec.Encode(point, value);
        using var deadline = DeviceScalarCodec.Deadline(settings.TimeoutMs, cancellation);
        deadline.Token.ThrowIfCancellationRequested(); EmbeddedPlcRuntime.EnsureAvailable(dataDirectory);
        using var tag = CreateTag(point);
        await tag.ReadAsync(deadline.Token);
        ValidateNativeType(tag, point);
        switch (DeviceScalarCodec.StorageType(point))
        {
            case "Boolean": tag.SetBit(0, (bool)raw); break;
            case "Int16": tag.SetInt16(0, (short)raw); break;
            case "UInt16": tag.SetUInt16(0, (ushort)raw); break;
            case "Int32": tag.SetInt32(0, (int)raw); break;
            case "UInt32": tag.SetUInt32(0, (uint)raw); break;
            case "Int64": tag.SetInt64(0, (long)raw); break;
            case "Float": tag.SetFloat32(0, (float)raw); break;
            case "Double": tag.SetFloat64(0, (double)raw); break;
            case "String": tag.SetString(0, (string)raw); break;
        }
        // Auto-sync is disabled: setters modify only the local buffer. There is one explicit write call.
        deadline.Token.ThrowIfCancellationRequested(); beforeDispatch?.Invoke();
        await tag.WriteAsync(deadline.Token);
        return "Good";
    }

    public void Dispose() => disposed = true;
}
