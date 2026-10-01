using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using SparkStudio.Connectors;

internal static class DeviceConnectorChecks
{
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool value, string message) { if (!value) throw new InvalidOperationException(message); passed++; }
        void Reject(Action action, string message) { try { action(); } catch (ArgumentException) { passed++; return; } throw new InvalidOperationException(message); }
        async Task RejectAsync(Func<Task> action, string message) { try { await action(); } catch (Exception error) when (error is IOException or InvalidOperationException or TimeoutException or ArgumentException) { passed++; return; } throw new InvalidOperationException(message); }
        DevicePoint Point(string id, string type, int offset, bool writable = true) => new() { Id = id, Name = id, Address = "holdingRegister:" + offset, DataType = type, Writable = writable };
        foreach (var type in new[] { "Int16", "UInt16", "Int32", "UInt32", "Int64", "Float", "Double", "String" })
        {
            var sample = type switch { "Int16" => (object)(short)-1234, "UInt16" => (ushort)50000, "Int32" => -123456789, "UInt32" => 4_000_000_000U,
                "Int64" => -9_007_199_254_740_993L, "Float" => 123.25f, "Double" => -1.234567890123, _ => "test" };
            foreach (var byteSwap in new[] { false, true }) foreach (var wordSwap in new[] { false, true })
            {
                var point = Point("scalar", type, 0) with { ByteSwap = byteSwap, WordSwap = wordSwap, StringLength = 7 };
                var encoded = ModbusDeviceSession.Encode(point, sample);
                Check(Equals(ModbusDeviceSession.Decode(point, encoded), sample), $"Exact Modbus {type} roundtrip, byte={byteSwap}, word={wordSwap}");
            }
        }
        Reject(() => ModbusDeviceSession.ValidatePoint(Point("p", "Double", 65533)), "Overflowing address span accepted");
        Reject(() => ModbusDeviceSession.ValidatePoint(Point("p", "UInt16", 0) with { Address = "inputRegister:0" }), "Writable input accepted");
        Reject(() => ModbusDeviceSession.ValidatePoint(Point("p", "String", 0) with { StringLength = 247 }), "Oversized write span accepted");
        Reject(() => ModbusDeviceSession.ValidatePoint(Point("p", "UInt16", 0) with { Address = "40001" }), "Ambiguous traditional register accepted");
        using var fractional = JsonDocument.Parse("1.5");
        Reject(() => DeviceScalarCodec.Encode(Point("p", "Int16", 0), fractional.RootElement), "Integer truncation accepted");
        using var overflow = JsonDocument.Parse("65536");
        Reject(() => DeviceScalarCodec.Encode(Point("p", "UInt16", 0), overflow.RootElement), "Integer overflow accepted");
        using var highInteger = JsonDocument.Parse("9007199254740993");
        Check((long)DeviceScalarCodec.Encode(Point("p", "Int64", 0), highInteger.RootElement) == 9007199254740993L, "Int64 write lost precision through double");
        using var scaledInput = JsonDocument.Parse("42");
        var scaled = Point("scaled", "Double", 12) with { Scale = .5, Offset = 2 };
        Check((double)DeviceScalarCodec.Encode(scaled, scaledInput.RootElement) == 80, "Inverse scaling wrong");
        Check((double)DeviceScalarCodec.Decode(scaled, 80d) == 42, "Read scaling wrong");
        await using var server = new ModbusFixture();
        var points = new DevicePoint[] { Point("a", "UInt16", 0), Point("b", "Int16", 1), Point("wide", "Int32", 2),
            Point("scaled", "Double", 4) with { Scale = .5, Offset = 2 },
            new() { Id = "bit", Name = "Bit", Address = "coil:0", DataType = "Boolean", Writable = true },
            Point("text", "String", 8) with { StringLength = 7 },
            Point("fractional", "Double", 12) with { RawDataType = "UInt16", Scale = .1 }, Point("readonly", "UInt16", 15, false) };
        var settings = new DeviceSettings { Host = "127.0.0.1", Port = server.Port, TimeoutMs = 500, Points = points };
        var connection = new ConnectionDefinition("device", "Test", "modbus-tcp", Device: settings);
        Reject(() => DeviceConfiguration.Validate(settings with { Points = [points[0], points[0]] }, "modbus-tcp"), "Duplicate map ID accepted");
        Reject(() => DeviceConfiguration.Validate(settings with { Host = "127.0.0.1&gateway=evil" }, "modbus-tcp"), "Host injection accepted");
        Reject(() => DeviceConfiguration.Validate(settings with { Points = [points[0] with { Scale = 0 }] }, "modbus-tcp"), "Noninvertible scaling accepted");
        Reject(() => DeviceConfiguration.Validate(settings with { Route = null! }, "modbus-tcp"), "JSON null route accepted");
        Reject(() => DeviceConfiguration.Validate(settings with { Points = [points[0] with { Scale = 1e-300 }] }, "modbus-tcp"), "Decimal scale underflow accepted");
        Reject(() => DeviceConfiguration.Validate(settings with { Points = [points[0] with { Offset = 1e-300 }] }, "modbus-tcp"), "Decimal offset underflow accepted");
        Reject(() => DeviceConfiguration.Validate(settings with { Points = [points[0] with { Scale = 1e300 }] }, "modbus-tcp"), "Decimal scale overflow accepted");
        Reject(() => DeviceConfiguration.Validate(settings with { Points = [points[0] with { RawDataType = "Boolean" }] }, "modbus-tcp"), "Numeric engineering type on Boolean storage accepted");
        Reject(() => DeviceConfiguration.Validate(settings with { Points = Enumerable.Range(0, 3000).Select(index => points[0] with { Id = "p" + index, Name = new string('a', 220) }).ToArray() }, "modbus-tcp"), "Map payload budget ignored");
        Check(DeviceConfiguration.ContentionKey(connection) == DeviceConfiguration.ContentionKey(connection with { Id = "alias", Type = "siemens-s7", Device = settings with { Port = 102 } }), "Protocols on one physical host did not share command domain");
        Check(DeviceConfiguration.ContentionKey(connection with { Device = settings with { ContentionDomain = "cell-1" } }) ==
            DeviceConfiguration.ContentionKey(connection with { Device = settings with { Host = "controller.example", ContentionDomain = "CELL-1" } }), "Explicit alias domain differs");
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.device-tests." + Guid.NewGuid().ToString("N"));
        using var service = new ConnectorService(directory);
        var browse = await service.BrowseAsync(connection, null, default);
        Check(browse.Count == points.Length && browse.All(node => node.BrowseMode == "configured") && browse.Single(node => node.NodeId == "readonly").Writable == false, "Configured browse metadata wrong");
        Check((await service.TestAsync(connection, default)).Success, "Read-only connection probe failed");
        var clientCount = server.Clients;
        var cloned = connection with { Device = JsonSerializer.Deserialize<DeviceSettings>(JsonSerializer.Serialize(settings)) };
        await service.ReadAsync(cloned, ["a"], default);
        Check(server.Clients == clientCount, "Value-identical deserialized map recreated session");
        var requests = server.Reads;
        var initial = await service.ReadAsync(connection, ["a", "b", "wide"], default);
        Check(initial.Count == 3 && initial.All(value => value.Quality == "Good") && server.Reads == requests + 1, "Adjacent registers did not coalesce into one bounded read");
        foreach (var (id, json) in new[] { ("a", "50000"), ("b", "-123"), ("wide", "-1234567"), ("scaled", "42"), ("bit", "true"), ("text", "\"ASCII\""), ("fractional", "12.3") })
        {
            using var value = JsonDocument.Parse(json);
            var dispatched = 0;
            var point = points.Single(p => p.Id == id);
            var status = await service.WriteValueAsync(connection, id, point.DataType, value.RootElement, default, () => dispatched++);
            var read = (await service.ReadAsync(connection, [id], default))[0];
            Check(status == "Good" && dispatched == 1 && read.Quality == "Good" && JsonSerializer.Serialize(read.Value) == json, "Native read/write mismatch for " + id);
        }
        Check(server.Registers[12] == 123 && ModbusDeviceSession.Parse(points.Single(point => point.Id == "fractional")).Count == 1,
            "Scaled Double engineering value did not retain UInt16 one-register storage");
        using var one = JsonDocument.Parse("1");
        var writesBefore = server.Writes;
        await RejectAsync(() => service.WriteValueAsync(connection, "readonly", "UInt16", one.RootElement, default), "Read-only map allowed a write");
        await RejectAsync(() => service.WriteValueAsync(connection, "a", "Int16", one.RootElement, default), "Type mismatch allowed a write");
        await RejectAsync(() => service.ReadAsync(connection, ["not-in-map"], default), "Unmapped read accepted");
        Check(server.Writes == writesBefore, "Validation rejection reached transport");
        server.RejectNext = true;
        var rejected = await service.ReadAsync(connection, ["a"], default);
        Check(rejected[0].Quality == "Bad_AddressUnknown" && rejected[0].Value is null, "Protocol rejection did not preserve bad quality");
        server.WrongTransaction = true;
        await RejectAsync(() => service.ReadAsync(connection, ["a"], default), "Wrong transaction was accepted");
        var oldClients = server.Clients;
        Check((await service.ReadAsync(connection, ["a"], default))[0].Quality == "Good" && server.Clients > oldClients, "Invalid transport was reused");
        server.DropWriteAcknowledgement = true;
        var dispatchedOnce = 0; writesBefore = server.Writes;
        await RejectAsync(() => service.WriteValueAsync(connection, "a", "UInt16", one.RootElement, default, () => dispatchedOnce++), "Lost acknowledgement should be uncertain");
        Check(dispatchedOnce == 1 && server.Writes == writesBefore + 1 && server.Registers[0] == 1, "Lost write response was replayed or not applied");
        using var watching = new CancellationTokenSource(TimeSpan.FromSeconds(4));
        var observed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var watch = service.WatchAsync(connection, ["a"], 100, values => { if (values[0].Quality == "Good") observed.TrySetResult(); }, _ => { }, watching.Token);
        await observed.Task.WaitAsync(TimeSpan.FromSeconds(2)); watching.Cancel(); await watch.WaitAsync(TimeSpan.FromSeconds(2)); passed++;
        var callback = service.WatchAsync(connection, ["a"], 100, _ => throw new Exception("synthetic callback"), _ => { }, default);
        await RejectAsync(() => callback.WaitAsync(TimeSpan.FromSeconds(2)), "Callback failure did not terminate watch");
        var committed = false;
        await service.PrepareConnectionRemoval(connection.Id, () => committed = true)();
        Check(committed, "Idle device removal did not commit");
        await RejectAsync(() => service.ReadAsync(connection, ["a"], default), "Removed connection accepted a lease");
        return passed;
    }

    private sealed class ModbusFixture : IAsyncDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _accept;
        private readonly List<Task> _clients = [];
        public ushort[] Registers { get; } = new ushort[65536];
        private readonly bool[] _coils = new bool[65536];
        public int Port { get; }
        public int Clients;
        public int Reads;
        public int Writes;
        public volatile bool WrongTransaction;
        public volatile bool RejectNext;
        public volatile bool DropWriteAcknowledgement;
        public ModbusFixture() { _listener.Start(); Port = ((IPEndPoint)_listener.LocalEndpoint).Port; _accept = AcceptAsync(); }
        private async Task AcceptAsync()
        {
            try { while (!_stop.IsCancellationRequested) { var client = await _listener.AcceptTcpClientAsync(_stop.Token); Interlocked.Increment(ref Clients); lock (_clients) _clients.Add(ServeAsync(client)); } }
            catch (OperationCanceledException) { }
        }
        private async Task ServeAsync(TcpClient client)
        {
            using (client)
            {
                try
                {
                    var stream = client.GetStream();
                    while (!_stop.IsCancellationRequested)
                    {
                        var header = new byte[7]; await stream.ReadExactlyAsync(header, _stop.Token);
                        var request = new byte[BinaryPrimitives.ReadUInt16BigEndian(header.AsSpan(4)) - 1];
                        await stream.ReadExactlyAsync(request, _stop.Token);
                        var address = request.Length >= 5 ? BinaryPrimitives.ReadUInt16BigEndian(request.AsSpan(1)) : 0;
                        var count = request.Length >= 5 ? BinaryPrimitives.ReadUInt16BigEndian(request.AsSpan(3)) : 0;
                        byte[] response;
                        if (RejectNext) { RejectNext = false; response = [(byte)(request[0] | 128), 2]; }
                        else if (request[0] is 1 or 2)
                        {
                            Interlocked.Increment(ref Reads); response = new byte[2 + (count + 7) / 8]; response[0] = request[0]; response[1] = (byte)(response.Length - 2);
                            for (var i = 0; i < count; i++) if (_coils[address + i]) response[2 + i / 8] |= (byte)(1 << (i % 8));
                        }
                        else if (request[0] is 3 or 4)
                        {
                            Interlocked.Increment(ref Reads); response = new byte[2 + count * 2]; response[0] = request[0]; response[1] = (byte)(count * 2);
                            for (var i = 0; i < count; i++) BinaryPrimitives.WriteUInt16BigEndian(response.AsSpan(2 + i * 2), Registers[address + i]);
                        }
                        else if (request[0] is 5 or 6 or 16)
                        {
                            Interlocked.Increment(ref Writes);
                            if (request[0] == 5) _coils[address] = count == 0xff00;
                            else if (request[0] == 6) Registers[address] = (ushort)count;
                            else for (var i = 0; i < count; i++) Registers[address + i] = BinaryPrimitives.ReadUInt16BigEndian(request.AsSpan(6 + i * 2));
                            if (DropWriteAcknowledgement) { DropWriteAcknowledgement = false; return; }
                            response = request[..5];
                        }
                        else response = [(byte)(request[0] | 128), 1];
                        if (WrongTransaction) { WrongTransaction = false; header[1]++; }
                        BinaryPrimitives.WriteUInt16BigEndian(header.AsSpan(4), (ushort)(response.Length + 1));
                        await stream.WriteAsync(header, _stop.Token); await stream.WriteAsync(response, _stop.Token);
                    }
                }
                catch (Exception error) when (error is IOException or SocketException or OperationCanceledException) { }
            }
        }
        public async ValueTask DisposeAsync()
        {
            _stop.Cancel(); _listener.Stop(); await _accept;
            Task[] clients; lock (_clients) clients = _clients.ToArray(); await Task.WhenAll(clients); _stop.Dispose();
        }
    }
}
