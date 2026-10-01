using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using SparkStudio.Connectors;

public static class NativeDeviceChecks
{
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool value, string message) { if (!value) throw new Exception(message); passed++; }
        void Reject(Action action, string message)
        {
            try { action(); } catch (Exception error) when (error is ArgumentException or OverflowException) { passed++; return; }
            throw new Exception("Expected rejection: " + message);
        }
        var scalar = new DevicePoint { Id = "temperature", Name = "Temperature", Address = "DB10.DBD20", DataType = "Float", Writable = true };
        Check((float)SiemensS7DeviceSession.Decode(scalar, null, [0x41, 0x48, 0, 0]) == 12.5f, "S7 REAL decodes network byte order");
        Check(SiemensS7DeviceSession.Encode(scalar, -1.5f).SequenceEqual(new byte[] { 0xBF, 0xC0, 0, 0 }), "S7 REAL encodes network byte order");
        Check((long)SiemensS7DeviceSession.Decode(scalar with { Address = "DB10.DBB20", DataType = "Int64" }, null, [0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]) == long.MaxValue, "S7 Int64 retains exact precision");
        var text = scalar with { Address = "DB10.DBB20", DataType = "String", StringLength = 4 };
        Check((string)SiemensS7DeviceSession.Decode(text, null, [4, 2, 65, 66, 0, 0]) == "AB", "S7 STRING validates and decodes its declared capacity");
        Reject(() => SiemensS7DeviceSession.Decode(text, null, [8, 2, 65, 66, 0, 0]), "S7 STRING capacity drift");
        Reject(() => SiemensS7DeviceSession.Decode(text, null, [4, 5, 65, 66, 0, 0]), "S7 STRING invalid current length");
        Reject(() => SiemensS7DeviceSession.ValidatePoint(scalar with { Address = "QW0", DataType = "UInt16" }), "S7 writable output not qualified");
        Reject(() => SiemensS7DeviceSession.ValidatePoint(scalar with { Address = "DB10.DBX0.8", DataType = "Boolean" }), "S7 invalid bit");
        Reject(() => SiemensS7DeviceSession.ValidatePoint(scalar with { Address = "DB10.DBW20" }), "S7 byte width mismatch");
        Reject(() => SiemensS7DeviceSession.ValidatePoint(scalar with { Address = "DB10.DBB2097150", DataType = "Int64" }), "S7 native range overflow");
        Reject(() => EthernetIpDeviceSession.ValidatePoint(scalar with { Address = "@raw" }), "EtherNet/IP magic raw packet tags prohibited");
        Reject(() => EthernetIpDeviceSession.ValidatePoint(scalar with { Address = "Speed.3" }), "EtherNet/IP bit-selector requires separate profile");
        EthernetIpDeviceSession.ValidatePoint(scalar with { Address = "Program:Main.Speeds[2]" }); passed++;
        Reject(() => EthernetIpDeviceSession.ValidatePoint(scalar with { Address = "Speed", ByteSwap = true }), "EtherNet/IP native byte order cannot be overridden");
        Reject(() => BeckhoffAdsDeviceSession.ValidatePoint(scalar with { Address = "MAIN.Speed;other" }), "ADS symbol grammar");
        BeckhoffAdsDeviceSession.ValidatePoint(scalar with { Address = "MAIN.Values[2].Speed" }); passed++;
        var scaled = scalar with { DataType = "Int16", Scale = 0.1, Offset = 2 };
        Check((short)DeviceScalarCodec.Encode(scaled, JsonSerializer.SerializeToElement(12m)) == 100, "Inverse scaling is exact before dispatch");
        Reject(() => DeviceScalarCodec.Encode(scaled, JsonSerializer.SerializeToElement(12.05m)), "Integer inverse scaling rejects fractional raw values");
        Reject(() => DeviceScalarCodec.Encode(scaled, JsonSerializer.SerializeToElement(100000m)), "Inverse scaling rejects raw overflow");
        Check((long)DeviceScalarCodec.Encode(scalar with { DataType = "Int64" }, JsonSerializer.SerializeToElement(long.MaxValue)) == long.MaxValue, "Native integer encoding retains exact Int64 maximum");
        Reject(() => DeviceScalarCodec.Encode(text, JsonSerializer.SerializeToElement("ABCDE")), "String capacity checked before writes");
        Reject(() => DeviceScalarCodec.Encode(text, JsonSerializer.SerializeToElement("é")), "ASCII profile rejects unsupported encoding");
        Reject(() => DeviceScalarCodec.Decode(text, "é"), "ASCII profile rejects unsupported native string read encoding");
        var engineering = scalar with { DataType = "Double", RawDataType = "UInt16", Scale = 0.1, Offset = 2 };
        Check((double)DeviceScalarCodec.Decode(engineering, (ushort)105) == 12.5, "Raw UInt16 scales into engineering Double without integer truncation");
        Check((ushort)DeviceScalarCodec.Encode(engineering, JsonSerializer.SerializeToElement(12.5)) == 105, "Engineering Double inverse-scales into exact raw UInt16");
        Reject(() => DeviceScalarCodec.Encode(engineering, JsonSerializer.SerializeToElement(12.55)), "Raw integer inverse scaling rejects fractional device values");
        Reject(() => DeviceScalarCodec.Encode(engineering with { Scale = 1e-100 }, JsonSerializer.SerializeToElement(2)), "Integer raw scaling rejects decimal underflow");
        var rawWord = engineering with { Address = "DB10.DBW20" };
        SiemensS7DeviceSession.ValidatePoint(rawWord);
        Check((ushort)SiemensS7DeviceSession.Decode(rawWord, null, [0, 105]) == 105, "S7 layout validation and decoding use raw width");
        Check(SiemensS7DeviceSession.Encode(rawWord, (ushort)105).SequenceEqual(new byte[] { 0, 105 }), "S7 encoding uses raw UInt16 width for engineering Double");

        var runtimeCache = Path.GetFullPath(Path.Combine(".data", "native-sdk-checks", Guid.NewGuid().ToString("N")));
        var payload = new byte[] { 10, 20, 30, 40 };
        var cached = EmbeddedPlcRuntime.RetainVerified(payload, Path.Combine(runtimeCache, "integrity"), "fixture.bin");
        Check(File.ReadAllBytes(cached).SequenceEqual(payload), "Native cache retains the exact embedded bytes");
        var copies = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() => EmbeddedPlcRuntime.RetainVerified(payload, Path.Combine(runtimeCache, "concurrent"), "fixture.bin"))));
        Check(copies.Distinct().Count() == 1, "Concurrent native cache creation converges on one verified file");
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(cached, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        File.WriteAllBytes(cached, [99]);
        try { EmbeddedPlcRuntime.RetainVerified(payload, Path.Combine(runtimeCache, "integrity"), "fixture.bin"); throw new Exception("Unverified native payload accepted"); }
        catch (InvalidOperationException) { passed++; }
        var bundle = EmbeddedPlcRuntime.RetainVerifiedBundle(new Dictionary<string, byte[]> { ["first.bin"] = payload, ["dependency.bin"] = [1, 2] }, Path.Combine(runtimeCache, "bundle"));
        Check(Path.GetDirectoryName(bundle["first.bin"]) == Path.GetDirectoryName(bundle["dependency.bin"]), "Native dependencies are retained alongside their library");
        var upgradedBundle = EmbeddedPlcRuntime.RetainVerifiedBundle(new Dictionary<string, byte[]> { ["first.bin"] = payload, ["dependency.bin"] = [1, 3] }, Path.Combine(runtimeCache, "bundle"));
        Check(bundle["first.bin"] != upgradedBundle["first.bin"], "A dependency update gets a fresh content-addressed bundle directory");
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(bundle["dependency.bin"], UnixFileMode.UserRead | UnixFileMode.UserWrite);
        File.WriteAllBytes(bundle["dependency.bin"], [99]);
        try { EmbeddedPlcRuntime.RetainVerifiedBundle(new Dictionary<string, byte[]> { ["first.bin"] = payload, ["dependency.bin"] = [1, 2] }, Path.Combine(runtimeCache, "bundle")); throw new Exception("Unverified dependency accepted"); }
        catch (InvalidOperationException) { passed++; }
        var previousData = Environment.GetEnvironmentVariable("SPARKSTUDIO_DATA_DIR");
        var packagedNative = Path.Combine(AppContext.BaseDirectory, OperatingSystem.IsWindows() ? "plctag.dll" : "libplctag.so");
        Check(File.Exists(packagedNative), "Build packages the platform native binary before application startup");
        var attributes = File.GetAttributes(packagedNative);
        try
        {
            Environment.SetEnvironmentVariable("SPARKSTUDIO_DATA_DIR", runtimeCache);
            File.SetAttributes(packagedNative, attributes | FileAttributes.ReadOnly);
            EmbeddedPlcRuntime.EnsureAvailable();
            Check(libplctag.NativeImport.plctag.plc_tag_check_lib_version(2, 0, 0) == 0, "Actual libplctag native API loads with its packaged binary read-only");
            if (OperatingSystem.IsWindows())
            {
                Check(EmbeddedPlcRuntime.WindowsRuntimeLoaded, "Windows explicitly loads the bundled VC runtime dependency");
                var native = System.Diagnostics.Process.GetCurrentProcess().Modules.Cast<System.Diagnostics.ProcessModule>()
                    .Where(module => module.ModuleName.Equals("vcruntime140.dll", StringComparison.OrdinalIgnoreCase) || module.ModuleName.Equals("plctag.dll", StringComparison.OrdinalIgnoreCase)).ToArray();
                Check(native.Length == 2 && native.All(module => module.FileName.StartsWith(runtimeCache + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)),
                    "Native SDK and VC runtime actually load from the verified cache without a host-installed VC runtime");
                var dependency = native.Single(module => module.ModuleName.Equals("vcruntime140.dll", StringComparison.OrdinalIgnoreCase));
                Check(Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(dependency.FileName))) == EmbeddedPlcRuntime.WindowsRuntimeSha256,
                    "Loaded VC runtime matches the exact pinned CPython redistribution bytes");
            }
            using var silentEndpoint = new TcpListener(IPAddress.Loopback, 0); silentEndpoint.Start();
            using var eip = new EthernetIpDeviceSession(new ConnectionDefinition("eip-test", "Native fixture", "ab-eip", Device: new DeviceSettings
            { Host = "127.0.0.1", Port = ((IPEndPoint)silentEndpoint.LocalEndpoint).Port, TimeoutMs = 250 }));
            var elapsed = System.Diagnostics.Stopwatch.StartNew();
            try { await eip.TestAsync(default); throw new Exception("Expected native protocol timeout"); }
            catch (Exception error) when (error is OperationCanceledException or InvalidOperationException) { passed++; }
            Check(elapsed.Elapsed < TimeSpan.FromSeconds(3), "Actual EIP native browse probe terminates within its deadline");
        }
        finally { Environment.SetEnvironmentVariable("SPARKSTUDIO_DATA_DIR", previousData); File.SetAttributes(packagedNative, attributes); }

        passed += await CheckAllenBradleyFamiliesAsync();

        await using var fixture = new S7Fixture();
        var settings = new DeviceSettings { Host = "127.0.0.1", Port = fixture.Port, ControllerFamily = "S71200", TimeoutMs = 1500, Points = [scalar] };
        using var session = new SiemensS7DeviceSession(new ConnectionDefinition("s7-test", "S7 fixture", "siemens-s7", Device: settings));
        var map = await session.BrowseAsync(null, default);
        Check(map.Single().BrowseMode == "configured" && map.Single().NodeId == scalar.Id, "S7 map browse labels its provenance and saved identity");
        var read = await session.ReadAsync([scalar], default);
        Check(read.Single().Quality == "Good" && (float)read.Single().Value! == 12.5f, "Actual S7 SDK handshake and read consume loopback protocol response");
        Check(fixture.Writes == 0, "S7 browse and read issue no write request");
        var dispatches = 0;
        Check(await session.WriteAsync(scalar, JsonSerializer.SerializeToElement(25.5), () => dispatches++, default) == "Good", "Actual S7 SDK scalar write receives positive acknowledgement");
        Check(fixture.Writes == 1 && dispatches == 1 && fixture.LastValue.SequenceEqual(new byte[] { 0x41, 0xCC, 0, 0 }), "Single S7 write has exact encoded payload and one dispatch callback");
        var bit = scalar with { Id = "bit", Address = "DB10.DBX0.3", DataType = "Boolean" };
        await session.WriteAsync(bit, JsonSerializer.SerializeToElement(true), () => dispatches++, default);
        Check(fixture.Writes == 2 && fixture.LastTransport == 1 && fixture.LastBitAddress == 3, "S7 Boolean writes use native bit addressing, not byte read-modify-write");
        fixture.DropWriteResponse = true;
        try { await session.WriteAsync(scalar, JsonSerializer.SerializeToElement(18), () => dispatches++, default); throw new Exception("Expected lost acknowledgement failure"); }
        catch (Exception error) when (error.Message != "Expected lost acknowledgement failure") { passed++; }
        await Task.Delay(100);
        Check(fixture.Writes == 3 && dispatches == 3, "Lost S7 acknowledgement propagates after dispatch without automatic retry");
        using var canceled = new CancellationTokenSource(); canceled.Cancel();
        try { await session.WriteAsync(scalar, JsonSerializer.SerializeToElement(20), () => dispatches++, canceled.Token); }
        catch (OperationCanceledException) { passed++; }
        Check(fixture.Writes == 3 && dispatches == 3, "Pre-dispatch cancellation sends no write");
        return passed;
    }

    private static async Task<int> CheckAllenBradleyFamiliesAsync()
    {
        var passed = 0;
        void Check(bool value, string message) { if (!value) throw new Exception(message); passed++; }
        void Reject(Action action, string message)
        {
            try { action(); } catch (ArgumentException) { passed++; return; }
            throw new Exception("Expected rejection: " + message);
        }
        var symbolic = new DevicePoint { Id = "speed", Name = "Speed", Address = "Speed", DataType = "UInt16", Writable = true };
        var integer = symbolic with { Address = "n7:0", DataType = "Int16" };
        foreach (var family in new[] { "ControlLogix", "CompactLogix", "Micro800", "MicroLogix", "Slc500", "Plc5" })
        {
            var logix = EthernetIpDeviceSession.HasNativeBrowse(family);
            var pccc = family is "MicroLogix" or "Slc500" or "Plc5";
            var point = pccc ? integer : symbolic;
            var settings = new DeviceSettings { Host = "127.0.0.1", Port = 44818, ControllerFamily = family, Route = logix ? "1,0" : "", Points = [point] };
            DeviceConfiguration.Validate(settings, "ab-eip"); passed++;
            using var session = new EthernetIpDeviceSession(new ConnectionDefinition(family, family, "ab-eip", Device: settings));
            using var tag = session.CreateTag(point);
            Check(tag.PlcType == (logix ? libplctag.PlcType.ControlLogix : Enum.Parse<libplctag.PlcType>(family)), family + " selects the pinned SDK PLC type");
            Check(tag.Path == (logix ? "1,0" : null), family + " emits the correct required/omitted route attribute");
            Check(tag.UseConnectedMessaging == !pccc && tag.AllowPacking == false, family + " selects required connected messaging without packing");
            Check(tag.AutoSyncReadInterval == TimeSpan.Zero && tag.AutoSyncWriteInterval == TimeSpan.Zero && tag.ReadCacheMillisecondDuration == 0, family + " disables automatic writes and stale reads");
            if (pccc) Check(tag.Name == "N7:0" && tag.ElementSize == 2, family + " canonicalizes the file prefix with its native word width");
            if (!logix)
            {
                var map = await session.BrowseAsync(null, default);
                Check(map.Count == 1 && map[0].PointId == point.Id && map[0].BrowseMode == "configured", family + " browse is an offline saved map");
                Reject(() => DeviceConfiguration.Validate(settings with { Route = "1,0" }, "ab-eip"), family + " rejects ignored/unsupported routes");
                using var empty = new EthernetIpDeviceSession(new ConnectionDefinition(family, family, "ab-eip", Device: settings with { Points = [] }));
                try { await empty.TestAsync(default); throw new Exception("Empty family test accepted"); }
                catch (ArgumentException) { passed++; }
            }
        }
        Reject(() => EthernetIpDeviceSession.ValidateSettings(new DeviceSettings { ControllerFamily = "ControlLogix", Route = "1,0,1" }), "Logix routing requires complete port/link pairs");
        Reject(() => EthernetIpDeviceSession.ValidateSettings(new DeviceSettings { ControllerFamily = "ControlLogix", Route = "1,256" }), "Logix route bytes are bounded");
        Reject(() => EthernetIpDeviceSession.ValidateSettings(new DeviceSettings { ControllerFamily = "unknown", Route = "" }), "Unknown family is not silently treated as Logix");
        Reject(() => EthernetIpDeviceSession.ValidatePoint(symbolic with { Address = "Program:Main.Speed" }, "Micro800"), "Micro800 does not claim Logix program scope");
        Reject(() => EthernetIpDeviceSession.ValidatePoint(symbolic with { DataType = "String" }, "Micro800"), "Micro800 STRING cannot use Logix defaults");
        foreach (var family in new[] { "ControlLogix", "CompactLogix" })
        {
            var unsupportedString = symbolic with { DataType = "String", StringLength = 82 };
            var unsupportedSettings = new DeviceSettings { Host = "127.0.0.1", ControllerFamily = family, Route = "1,0", Points = [unsupportedString] };
            Reject(() => EthernetIpDeviceSession.ValidatePoint(unsupportedString, family), family + " requires qualified structure schema before accepting String");
            Reject(() => DeviceConfiguration.Validate(unsupportedSettings, "ab-eip"), family + " rejects unsupported String during map save validation");
            Reject(() => { using var invalid = new EthernetIpDeviceSession(new ConnectionDefinition("unsupported-string", family, "ab-eip", Device: unsupportedSettings)); },
                family + " cannot load a usable session with an unsupported String map");
        }
        Check(EthernetIpDeviceSession.TypeName(0xD2) == "UInt16" && EthernetIpDeviceSession.TypeName(0xD3) == "UInt32", "Micro800 WORD/DWORD use exact unsigned native widths");
        foreach (var family in new[] { "MicroLogix", "Slc500", "Plc5" })
        {
            foreach (var point in new[] { integer, integer with { Address = "B3:0", DataType = "UInt16" }, integer with { Address = "N7:0/15", DataType = "Boolean" },
                integer with { Address = "F8:0", DataType = "Float" }, integer with { Address = "ST9:0", DataType = "String", StringLength = 82 },
                integer with { Address = "N255:65535", DataType = "Double", RawDataType = "Int16", Scale = 0.1 } })
            { EthernetIpDeviceSession.ValidatePoint(point, family); passed++; }
            Reject(() => EthernetIpDeviceSession.ValidatePoint(integer with { Address = "N256:0" }, family), "PCCC file bound");
            Reject(() => EthernetIpDeviceSession.ValidatePoint(integer with { Address = "N7:65536" }, family), "PCCC element bound");
            Reject(() => EthernetIpDeviceSession.ValidatePoint(integer with { Address = "B3:0/16", DataType = "Boolean" }, family), "PCCC word bit bound");
            Reject(() => EthernetIpDeviceSession.ValidatePoint(integer with { Address = "B3:0", DataType = "Boolean" }, family), "PCCC Boolean requires native bit address");
            Reject(() => EthernetIpDeviceSession.ValidatePoint(integer with { Address = "N7:0/2" }, family), "PCCC bit address requires Boolean raw type");
            Reject(() => EthernetIpDeviceSession.ValidatePoint(integer with { Address = "F8:0", DataType = "Int32" }, family), "PCCC float files cannot be reinterpreted as Int32");
            Reject(() => EthernetIpDeviceSession.ValidatePoint(integer with { Address = "ST9:0", DataType = "String", StringLength = 83 }, family), "PCCC strings are at most 82 characters");
            Reject(() => EthernetIpDeviceSession.ValidatePoint(integer with { Address = "T4:0.ACC" }, family), "Unsupported PCCC subfields are rejected");
            EthernetIpDeviceSession.ValidatePcccSize(integer with { Address = "B3:0/15", DataType = "Boolean" }, family, 2); passed++;
            Reject(() => EthernetIpDeviceSession.ValidatePcccSize(integer with { Address = "B3:0/15", DataType = "Boolean" }, family, 1), "PCCC Boolean retains a native two-byte word buffer");
            EthernetIpDeviceSession.ValidatePcccSize(integer with { Address = "ST9:0", DataType = "String" }, family, 84); passed++;
            Reject(() => EthernetIpDeviceSession.ValidatePcccSize(integer with { Address = "ST9:0", DataType = "String" }, family, 88), "PCCC String must not use the Logix88-byte buffer");
        }
        EthernetIpDeviceSession.ValidatePoint(integer with { Address = "L19:0", DataType = "Int32" }, "MicroLogix"); passed++;
        foreach (var family in new[] { "Slc500", "Plc5" })
            Reject(() => EthernetIpDeviceSession.ValidatePoint(integer with { Address = "L19:0", DataType = "Int32" }, family), "Long files are a MicroLogix profile feature");
        Reject(() => EthernetIpDeviceSession.ValidatePoint(integer with { Address = "L19:0/28", DataType = "Boolean" }, "MicroLogix"), "Pinned PCCC supports only word bit masks");
        foreach (var family in new[] { "MicroLogix", "Slc500", "Plc5" })
        {
            await using var wire = new PcccFixture(family == "Plc5");
            using var session = new EthernetIpDeviceSession(new ConnectionDefinition("pccc-wire", "PCCC fixture", "ab-eip", Device: new DeviceSettings
            { Host = "127.0.0.1", Port = wire.Port, ControllerFamily = family, Route = "", TimeoutMs = 1500, Points = [integer] }));
            var read = await session.ReadAsync([integer], default);
            Check(read.Single().Quality == "Good" && (short)read.Single().Value! == 1234, family + " actual SDK reads PCCC data after EIP registration");
            Check(wire.Writes == 0, family + " read sends no write");
            var dispatched = 0;
            await session.WriteAsync(integer, JsonSerializer.SerializeToElement(200), () => dispatched++, default);
            Check(dispatched == 1 && wire.Writes == 1 && wire.LastFunction == (family == "Plc5" ? 0x00 : 0xAA) && wire.LastData.TakeLast(2).SequenceEqual(new byte[] { 200, 0 }), family + " actual native word write has one dispatch and correct little-endian bytes");
            var bitPoint = integer with { Address = "B3:0/15", DataType = "Boolean" };
            wire.Data = [0, 0x80];
            var bitRead = await session.ReadAsync([bitPoint], default);
            Check(bitRead.Single().Quality == "Good" && (bool)bitRead.Single().Value! == true, family + " reads configured bit15 when bit0 is false");
            wire.Data = [1, 0];
            bitRead = await session.ReadAsync([bitPoint], default);
            Check(bitRead.Single().Quality == "Good" && (bool)bitRead.Single().Value! == false, family + " reads configured bit15 when bit0 is true");
            await session.WriteAsync(bitPoint, JsonSerializer.SerializeToElement(true), () => dispatched++, default);
            Check(dispatched == 2 && wire.Writes == 2 && wire.LastFunction == (family == "Plc5" ? 0x26 : 0xAB), family + " Boolean uses a native masked-bit command");
            var masks = wire.LastData.TakeLast(4).ToArray();
            Check(BinaryPrimitives.ReadUInt16LittleEndian(masks) == (family == "Plc5" ? 0xFFFF : 0x8000) &&
                BinaryPrimitives.ReadUInt16LittleEndian(masks.AsSpan(2)) == (family == "Plc5" ? 0x8000 : 0x8001),
                family + " native bit15 masks preserve all neighboring bits: " + Convert.ToHexString(masks));
            await session.WriteAsync(bitPoint, JsonSerializer.SerializeToElement(false), () => dispatched++, default);
            masks = wire.LastData.TakeLast(4).ToArray();
            Check(BinaryPrimitives.ReadUInt16LittleEndian(masks) == (family == "Plc5" ? 0x7FFF : 0x8000) && BinaryPrimitives.ReadUInt16LittleEndian(masks.AsSpan(2)) == (family == "Plc5" ? 0 : 1),
                family + " native bit15 clear masks preserve all neighboring bits: " + Convert.ToHexString(masks));
            wire.Data = new byte[84]; wire.Data[0] = 2; wire.Data[2] = 66; wire.Data[3] = 65;
            var stringPoint = integer with { Address = "ST9:0", DataType = "String", StringLength = 82 };
            var stringRead = await session.ReadAsync([stringPoint], default);
            Check(stringRead.Single().Quality == "Good" && (string)stringRead.Single().Value! == "AB", family + " native codec reads the byte-swapped 84-byte STRING layout");
            await session.WriteAsync(stringPoint, JsonSerializer.SerializeToElement("CD"), () => dispatched++, default);
            Check(wire.Writes == 4 && wire.LastData.TakeLast(84).Take(4).SequenceEqual(new byte[] { 2, 0, 68, 67 }), family + " STRING write uses the native two-byte count and swapped characters");
            var floatPoint = integer with { Address = "F8:0", DataType = "Float" };
            wire.Data = family == "Plc5" ? [0x48, 0x41, 0, 0] : [0, 0, 0x48, 0x41];
            var floatRead = await session.ReadAsync([floatPoint], default);
            Check(floatRead.Single().Quality == "Good" && (float)floatRead.Single().Value! == 12.5f, family + " native Float codec uses its family byte order");
            await session.WriteAsync(floatPoint, JsonSerializer.SerializeToElement(-25.5f), () => dispatched++, default);
            Check(wire.LastData.TakeLast(4).SequenceEqual(family == "Plc5" ? new byte[] { 0xCC, 0xC1, 0, 0 } : new byte[] { 0, 0, 0xCC, 0xC1 }), family + " native Float write uses its family byte order");
            if (family == "MicroLogix")
            {
                var longPoint = integer with { Address = "L19:0", DataType = "UInt32" };
                wire.Data = [255, 255, 255, 255];
                var longRead = await session.ReadAsync([longPoint], default);
                Check(longRead.Single().Quality == "Good" && (uint)longRead.Single().Value! == uint.MaxValue, "MicroLogix native long file reads UInt32 maximum");
                await session.WriteAsync(longPoint, JsonSerializer.SerializeToElement(uint.MaxValue), () => dispatched++, default);
                Check(wire.LastData.TakeLast(4).SequenceEqual(new byte[] { 255, 255, 255, 255 }), "MicroLogix native long file writes UInt32 maximum");
                longPoint = longPoint with { DataType = "Int32" }; wire.Data = [0, 0, 0, 128];
                longRead = await session.ReadAsync([longPoint], default);
                Check(longRead.Single().Quality == "Good" && (int)longRead.Single().Value! == int.MinValue, "MicroLogix native long file reads Int32 minimum");
                await session.WriteAsync(longPoint, JsonSerializer.SerializeToElement(int.MinValue), () => dispatched++, default);
                Check(wire.LastData.TakeLast(4).SequenceEqual(new byte[] { 0, 0, 0, 128 }), "MicroLogix native long file writes Int32 minimum");
            }
            var expectedWrites = family == "MicroLogix" ? 8 : 6;
            wire.Data = [0xD2, 0x04]; wire.DropWriteResponse = true;
            try { await session.WriteAsync(integer, JsonSerializer.SerializeToElement(300), () => dispatched++, default); throw new Exception("Lost PCCC acknowledgement accepted"); }
            catch (Exception error) when (error is OperationCanceledException or InvalidOperationException) { passed++; }
            await Task.Delay(100);
            Check(wire.Writes == expectedWrites && dispatched == expectedWrites, family + " lost acknowledgement is not automatically resent");
            using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
            try { await session.WriteAsync(integer, JsonSerializer.SerializeToElement(400), () => dispatched++, cancellation.Token); throw new Exception("Canceled PCCC write returned successfully"); }
            catch (OperationCanceledException) { passed++; }
            Check(wire.Writes == expectedWrites && dispatched == expectedWrites, family + " canceled write never crosses dispatch boundary");
        }
        await using (var wire = new CipSymbolFixture())
        {
            using var session = new EthernetIpDeviceSession(new ConnectionDefinition("micro-wire", "Micro800 fixture", "ab-eip", Device: new DeviceSettings
            { Host = "127.0.0.1", Port = wire.Port, ControllerFamily = "Micro800", Route = "", TimeoutMs = 1500, Points = [symbolic] }));
            var read = await session.ReadAsync([symbolic], default);
            Check(read.Single().Quality == "Good" && (ushort)read.Single().Value! == 1234 && wire.ForwardOpens > 0,
                "Actual Micro800 SDK establishes a CIP connection and reads WORD native metadata: " + JsonSerializer.Serialize(read) + " opens=" + wire.ForwardOpens);
            Check(wire.Writes == 0, "Micro800 Test/read path performs no write");
            var dispatched = 0;
            await session.WriteAsync(symbolic, JsonSerializer.SerializeToElement(50000), () => dispatched++, default);
            Check(wire.Writes == 1 && dispatched == 1 && wire.LastType == 0xD2 && wire.LastData.SequenceEqual(new byte[] { 0x50, 0xC3 }),
                "Micro800 actual WORD write retains native type and exact unsigned bytes");
            wire.NativeType = 0xD3; wire.Data = [0xFF, 0xFF, 0xFF, 0xFF];
            var dword = symbolic with { DataType = "UInt32" };
            read = await session.ReadAsync([dword], default);
            Check(read.Single().Quality == "Good" && (uint)read.Single().Value! == uint.MaxValue, "Micro800 DWORD maps to unsigned 32-bit engineering value");
            await session.WriteAsync(dword, JsonSerializer.SerializeToElement(uint.MaxValue), () => dispatched++, default);
            Check(wire.Writes == 2 && wire.LastType == 0xD3 && wire.LastData.SequenceEqual(new byte[] { 255, 255, 255, 255 }), "Micro800 DWORD write retains all unsigned bits");
            wire.NativeType = 0xCA; wire.Data = [0, 0, 0x48, 0x41];
            read = await session.ReadAsync([symbolic], default);
            Check(read.Single().Quality == "Bad_DecodingError", "Micro800 actual incompatible CIP metadata gives bad quality");
            try { await session.WriteAsync(symbolic, JsonSerializer.SerializeToElement(100), () => dispatched++, default); throw new Exception("Native mismatch accepted"); }
            catch (ArgumentException) { passed++; }
            Check(wire.Writes == 2 && dispatched == 2, "Micro800 native type mismatch rejects before write dispatch");
            wire.NativeType = 0xD2; wire.Data = [0xD2, 0x04]; wire.DropWriteResponse = true;
            try { await session.WriteAsync(symbolic, JsonSerializer.SerializeToElement(100), () => dispatched++, default); throw new Exception("Lost Micro800 acknowledgement accepted"); }
            catch (Exception error) when (error is OperationCanceledException or InvalidOperationException) { passed++; }
            await Task.Delay(100);
            Check(wire.Writes == 3 && dispatched == 3, "Micro800 lost acknowledgement does not trigger write replay");
        }
        foreach (var family in new[] { "ControlLogix", "CompactLogix" })
        {
            await using var wire = new CipSymbolFixture { NativeType = 0xC7 };
            using var session = new EthernetIpDeviceSession(new ConnectionDefinition("logix-wire", "Logix fixture", "ab-eip", Device: new DeviceSettings
            { Host = "127.0.0.1", Port = wire.Port, ControllerFamily = family, Route = "1,0", TimeoutMs = 1500, Points = [symbolic] }));
            var read = await session.ReadAsync([symbolic], default);
            Check(read.Single().Quality == "Good" && (ushort)read.Single().Value! == 1234 && wire.ForwardOpens > 0,
                family + " connected scalar read validates metadata through the pinned SDK bridge");
            var dispatched = 0;
            await session.WriteAsync(symbolic, JsonSerializer.SerializeToElement(50000), () => dispatched++, default);
            Check(dispatched == 1 && wire.Writes == 1 && wire.LastType == 0xC7 && wire.LastData.SequenceEqual(new byte[] { 0x50, 0xC3 }), family + " connected scalar write retains native type and value");
            // A synthetic standard-string layout previously exercised codec bytes,
            // but neither that fixture nor default SDK capacity qualifies the PLC
            // schema. Both it and a same-size incompatible UDT fail before tag I/O.
            foreach (var typeHandle in new ushort[] { 0x0FCE, 0x1234 })
            {
                wire.NativeType = 0x02A0; wire.TypeTail = [(byte)typeHandle, (byte)(typeHandle >> 8)];
                wire.Data = new byte[88]; wire.Data[0] = 2; wire.Data[4] = 65; wire.Data[5] = 66;
                var textPoint = symbolic with { DataType = "String", StringLength = 82 };
                var readsBefore = wire.Reads; var opensBefore = wire.ForwardOpens;
                Reject(() => { using var unsupported = session.CreateTag(textPoint); }, family + " does not create a native String tag or setter buffer");
                read = await session.ReadAsync([textPoint], default);
                Check(read.Single().Quality == "Bad_DecodingError" && read.Single().Value is null,
                    family + " does not decode unqualified 88-byte structure handle " + typeHandle.ToString("X4") + " as String");
                try { await session.WriteAsync(textPoint, JsonSerializer.SerializeToElement("CD"), () => dispatched++, default); throw new Exception("Unqualified Logix String write accepted"); }
                catch (ArgumentException) { passed++; }
                Check(wire.Reads == readsBefore && wire.ForwardOpens == opensBefore && dispatched == 1 && wire.Writes == 1,
                    family + " unqualified structure rejects before any native read, setter, dispatch or write");
            }
        }
        return passed;
    }

    // Independent connected-CIP scalar responder with synthetic data. Physical
    // controller behavior, program configuration and routing still need acceptance.
    private sealed class CipSymbolFixture : IAsyncDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource stop = new();
        private readonly Task accepting;
        private readonly List<Task> clients = [];
        public ushort NativeType = 0xD2;
        public byte[] TypeTail = [];
        public byte[] Data = [0xD2, 0x04];
        public ushort LastType;
        public byte[] LastData = [];
        public bool DropWriteResponse;
        public int ForwardOpens, Reads, Writes;
        public int Port { get; }
        public CipSymbolFixture() { listener.Start(); Port = ((IPEndPoint)listener.LocalEndpoint).Port; accepting = AcceptAsync(); }
        private async Task AcceptAsync()
        {
            try { while (!stop.IsCancellationRequested) clients.Add(ServeAsync(await listener.AcceptTcpClientAsync(stop.Token))); }
            catch (OperationCanceledException) { }
        }
        private async Task ServeAsync(TcpClient client)
        {
            using (client)
            {
                var stream = client.GetStream(); uint originConnection = 0;
                try
                {
                    while (!stop.IsCancellationRequested)
                    {
                        var header = new byte[24]; await stream.ReadExactlyAsync(header, stop.Token);
                        var body = new byte[BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(2))]; await stream.ReadExactlyAsync(body, stop.Token);
                        var command = BinaryPrimitives.ReadUInt16LittleEndian(header);
                        byte[] response;
                        if (command == 0x65) { BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(4), 0x12345678); response = [1, 0, 0, 0]; }
                        else if (command == 0x6F && body[16] is 0x54 or 0x5B)
                        {
                            Interlocked.Increment(ref ForwardOpens);
                            originConnection = BinaryPrimitives.ReadUInt32LittleEndian(body.AsSpan(28));
                            response = new byte[46]; response[6] = 2; response[12] = 0xB2; response[14] = 30;
                            response[16] = (byte)(body[16] | 0x80);
                            BinaryPrimitives.WriteUInt32LittleEndian(response.AsSpan(20), 0x11223344);
                            BinaryPrimitives.WriteUInt32LittleEndian(response.AsSpan(24), originConnection);
                            body.AsSpan(32, 8).CopyTo(response.AsSpan(28));
                            BinaryPrimitives.WriteUInt32LittleEndian(response.AsSpan(36), 1_000_000);
                            BinaryPrimitives.WriteUInt32LittleEndian(response.AsSpan(40), 1_000_000);
                        }
                        else if (command == 0x70)
                        {
                            var service = body[22];
                            var reading = service is 0x4C or 0x52;
                            if (!reading && service is not (0x4D or 0x53)) throw new InvalidOperationException("Unexpected connected CIP service.");
                            if (reading) Interlocked.Increment(ref Reads);
                            if (!reading)
                            {
                                var offset = 24 + body[23] * 2;
                                LastType = BinaryPrimitives.ReadUInt16LittleEndian(body.AsSpan(offset));
                                LastData = body[(offset + TypeTail.Length + (service == 0x53 ? 8 : 4))..]; Interlocked.Increment(ref Writes);
                                if (DropWriteResponse) continue;
                            }
                            response = new byte[26 + (reading ? 2 + TypeTail.Length + Data.Length : 0)];
                            response[6] = 2; response[8] = 0xA1; response[10] = 4;
                            BinaryPrimitives.WriteUInt32LittleEndian(response.AsSpan(12), originConnection);
                            response[16] = 0xB1; BinaryPrimitives.WriteUInt16LittleEndian(response.AsSpan(18), (ushort)(response.Length - 20));
                            body.AsSpan(20, 2).CopyTo(response.AsSpan(20)); response[22] = (byte)(service | 0x80);
                            if (reading) { BinaryPrimitives.WriteUInt16LittleEndian(response.AsSpan(26), NativeType); TypeTail.CopyTo(response, 28); Data.CopyTo(response, 28 + TypeTail.Length); }
                        }
                        else if (command == 0x6F && body[16] == 0x4E)
                        {
                            response = new byte[30]; response[6] = 2; response[12] = 0xB2; response[14] = 14; response[16] = 0xCE;
                            body.AsSpan(24, 8).CopyTo(response.AsSpan(20));
                        }
                        else if (command == 0x66) return;
                        else throw new InvalidOperationException("Unexpected CIP fixture command: " + Convert.ToHexString(body));
                        BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(2), (ushort)response.Length);
                        await stream.WriteAsync(header, stop.Token); await stream.WriteAsync(response, stop.Token);
                    }
                }
                catch (Exception error) when (error is IOException or OperationCanceledException) { }
            }
        }
        public async ValueTask DisposeAsync()
        { stop.Cancel(); listener.Stop(); await accepting; await Task.WhenAll(clients); stop.Dispose(); }
    }

    // Independent minimal Ethernet/IP registration + execute-PCCC responder. The
    // controller data is synthetic; these tests never contact a physical device.
    private sealed class PcccFixture : IAsyncDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource stop = new();
        private readonly Task accepting;
        private readonly List<Task> clients = [];
        private readonly bool plc5;
        public byte[] Data = [0xD2, 0x04];
        public byte[] LastData = [];
        public byte LastFunction;
        public int Writes;
        public bool DropWriteResponse;
        public int Port { get; }
        public PcccFixture(bool plc5)
        { this.plc5 = plc5; listener.Start(); Port = ((IPEndPoint)listener.LocalEndpoint).Port; accepting = AcceptAsync(); }
        private async Task AcceptAsync()
        {
            try { while (!stop.IsCancellationRequested) clients.Add(ServeAsync(await listener.AcceptTcpClientAsync(stop.Token))); }
            catch (OperationCanceledException) { }
        }
        private async Task ServeAsync(TcpClient client)
        {
            using (client)
            {
                var stream = client.GetStream();
                try
                {
                    while (!stop.IsCancellationRequested)
                    {
                        var header = new byte[24]; await stream.ReadExactlyAsync(header, stop.Token);
                        var body = new byte[BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(2))]; await stream.ReadExactlyAsync(body, stop.Token);
                        var command = BinaryPrimitives.ReadUInt16LittleEndian(header);
                        byte[] response;
                        if (command == 0x65)
                        {
                            BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(4), 0x12345678); response = [1, 0, 0, 0];
                        }
                        else if (command == 0x6F)
                        {
                            if (body.Length < 34 || body[16] != 0x4B) throw new InvalidOperationException("Unexpected synthetic PCCC request: " + Convert.ToHexString(body));
                            var function = body[33];
                            var reading = function == (plc5 ? 0x01 : 0xA2);
                            if (!reading)
                            {
                                LastFunction = function; LastData = body[34..]; Interlocked.Increment(ref Writes);
                                if (DropWriteResponse) continue;
                            }
                            var data = reading ? Data : [];
                            response = new byte[31 + data.Length];
                            // Null address item, then one unconnected CIP data item.
                            response[6] = 2; response[12] = 0xB2;
                            BinaryPrimitives.WriteUInt16LittleEndian(response.AsSpan(14), (ushort)(15 + data.Length));
                            response[16] = 0xCB;
                            body.AsSpan(22, 7).CopyTo(response.AsSpan(20));
                            response[27] = 0x4F; body.AsSpan(31, 2).CopyTo(response.AsSpan(29));
                            data.CopyTo(response, 31);
                        }
                        else if (command == 0x66) return;
                        else throw new InvalidOperationException("Unexpected EIP command in fixture.");
                        BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(2), (ushort)response.Length);
                        await stream.WriteAsync(header, stop.Token); await stream.WriteAsync(response, stop.Token);
                    }
                }
                catch (Exception error) when (error is IOException or OperationCanceledException) { }
            }
        }
        public async ValueTask DisposeAsync()
        { stop.Cancel(); listener.Stop(); await accepting; await Task.WhenAll(clients); stop.Dispose(); }
    }

    // A minimal independently authored ISO-on-TCP/S7 responder. It only accepts our synthetic
    // scalar requests and never contacts a controller. Port allocation is OS-selected loopback.
    private sealed class S7Fixture : IAsyncDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource stop = new();
        private readonly Task accepting;
        private readonly List<Task> clients = [];
        public int Port { get; }
        public int Writes;
        public byte[] LastValue = [];
        public byte LastTransport;
        public int LastBitAddress;
        public bool DropWriteResponse;
        public S7Fixture() { listener.Start(); Port = ((IPEndPoint)listener.LocalEndpoint).Port; accepting = AcceptAsync(); }

        private async Task AcceptAsync()
        {
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    var client = await listener.AcceptTcpClientAsync(stop.Token);
                    clients.Add(ServeAsync(client));
                }
            }
            catch (OperationCanceledException) { }
        }

        private async Task ServeAsync(TcpClient client)
        {
            using (client)
            {
                var stream = client.GetStream();
                try
                {
                    while (!stop.IsCancellationRequested)
                    {
                        var header = new byte[4]; await stream.ReadExactlyAsync(header, stop.Token);
                        var packet = new byte[BinaryPrimitives.ReadUInt16BigEndian(header.AsSpan(2))];
                        header.CopyTo(packet, 0); await stream.ReadExactlyAsync(packet.AsMemory(4), stop.Token);
                        if (packet[5] == 0xE0)
                        {
                            byte[] confirm = [3, 0, 0, 22, 17, 0xD0, 0, 1, 0, 1, 0, 0xC0, 1, 10, 0xC1, 2, 1, 0, 0xC2, 2, 1, 0];
                            await stream.WriteAsync(confirm, stop.Token); continue;
                        }
                        byte[] parameter;
                        byte[] data;
                        if (packet[17] == 0xF0) { parameter = [0xF0, 0, 0, 1, 0, 1, 0, 240]; data = []; }
                        else if (packet[17] == 4)
                        {
                            var count = BinaryPrimitives.ReadUInt16BigEndian(packet.AsSpan(23));
                            var bytes = new byte[count];
                            if (count == 4) new byte[] { 0x41, 0x48, 0, 0 }.CopyTo(bytes, 0);
                            parameter = [4, 1]; data = new byte[4 + bytes.Length]; data[0] = 0xFF; data[1] = 4;
                            BinaryPrimitives.WriteUInt16BigEndian(data.AsSpan(2), checked((ushort)(count * 8))); bytes.CopyTo(data, 4);
                        }
                        else if (packet[17] == 5)
                        {
                            LastTransport = packet[22]; LastBitAddress = (packet[28] << 16) | (packet[29] << 8) | packet[30];
                            LastValue = packet[35..]; Interlocked.Increment(ref Writes);
                            if (DropWriteResponse) return;
                            parameter = [5, 1]; data = [0xFF];
                        }
                        else throw new InvalidOperationException("Unexpected S7 fixture function.");
                        var response = new byte[19 + parameter.Length + data.Length];
                        response[0] = 3; BinaryPrimitives.WriteUInt16BigEndian(response.AsSpan(2), (ushort)response.Length);
                        response[4] = 2; response[5] = 0xF0; response[6] = 0x80; response[7] = 0x32; response[8] = 3;
                        response[11] = packet[11]; response[12] = packet[12];
                        BinaryPrimitives.WriteUInt16BigEndian(response.AsSpan(13), (ushort)parameter.Length);
                        BinaryPrimitives.WriteUInt16BigEndian(response.AsSpan(15), (ushort)data.Length);
                        parameter.CopyTo(response, 19); data.CopyTo(response, 19 + parameter.Length);
                        await stream.WriteAsync(response, stop.Token);
                    }
                }
                catch (Exception ex) when (ex is IOException or OperationCanceledException) { }
            }
        }

        public async ValueTask DisposeAsync()
        {
            stop.Cancel(); listener.Stop(); await accepting; await Task.WhenAll(clients); stop.Dispose();
        }
    }
}
