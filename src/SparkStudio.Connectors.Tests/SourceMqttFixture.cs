using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Net.Security;
using System.Net.WebSockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using SparkStudio.Connectors;

// A deliberately small independently authored broker fixture: it only implements the
// wire cases exercised here, and never contacts an installed service or external broker.
internal sealed class SourceMqttFixture : IAsyncDisposable
{
    private readonly TcpListener listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource stop = new();
    private readonly SemaphoreSlim writes = new(1, 1);
    private readonly Task run;
    private Stream? stream;
    private readonly bool tls, websocket;
    private readonly X509Certificate2? certificate;
    internal string DataDirectory { get; }
    private bool v5;
    internal readonly TaskCompletionSource<bool> Subscribed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    internal readonly TaskCompletionSource<ushort> PublishAcknowledged = new(TaskCreationOptions.RunContinuationsAsynchronously);
    internal int Connections;
    internal Exception? Failure;
    internal readonly Dictionary<string, string> RetainedBeforeSubAck = new(StringComparer.Ordinal);
    internal SourceMqttFixture(bool tls = false, bool websocket = false)
    {
        this.tls = tls; this.websocket = websocket;
        DataDirectory = Path.Combine(Path.GetTempPath(), "spark-mqtt-fixture-" + Guid.NewGuid().ToString("N"));
        if (tls)
        {
            Directory.CreateDirectory(Path.Combine(DataDirectory, "certificates"));
            using var rootKey = RSA.Create(2048); var rootRequest = new CertificateRequest("CN=Spark MQTT fixture root", rootKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            rootRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
            rootRequest.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
            using var root = rootRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-2), DateTimeOffset.UtcNow.AddHours(2));
            using var key = RSA.Create(2048); var request = new CertificateRequest("CN=localhost", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
            request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
            request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.1") }, false));
            var names = new SubjectAlternativeNameBuilder(); names.AddDnsName("localhost"); names.AddIpAddress(IPAddress.Loopback); request.CertificateExtensions.Add(names.Build());
            using var signed = request.Create(root, DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddHours(1), Guid.NewGuid().ToByteArray());
            using var withKey = signed.CopyWithPrivateKey(key);
            certificate = X509CertificateLoader.LoadPkcs12(withKey.Export(X509ContentType.Pkcs12), null, X509KeyStorageFlags.Exportable
                | (OperatingSystem.IsWindows() ? X509KeyStorageFlags.DefaultKeySet : X509KeyStorageFlags.EphemeralKeySet));
            File.WriteAllText(Path.Combine(DataDirectory, "certificates", "fixture-ca.pem"), root.ExportCertificatePem());
        }
        listener.Start(); run = RunAsync();
    }
    internal SourceTlsSettings? TlsSettings => tls ? new(CaCertificateReference: "fixture-ca.pem") : null;
    internal string Endpoint => (websocket ? tls ? "wss" : "ws" : tls ? "mqtts" : "mqtt") + "://127.0.0.1:" + Port + (websocket ? "/mqtt" : "");
    internal int Port => ((IPEndPoint)listener.LocalEndpoint).Port;
    private async Task RunAsync()
    {
        try
        {
            using var client = await listener.AcceptTcpClientAsync(stop.Token); Connections++; stream = client.GetStream();
            if (tls)
            {
                var secure = new SslStream(stream); await secure.AuthenticateAsServerAsync(new SslServerAuthenticationOptions { ServerCertificate = certificate, EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13 }, stop.Token); stream = secure;
            }
            if (websocket) stream = await UpgradeAsync(stream, stop.Token);
            var connect = await ReadPacketAsync(stream, stop.Token);
            if (connect.Header != 0x10 || connect.Body.Length < 10) throw new IOException("Fixture expected CONNECT.");
            v5 = connect.Body[6] == 5;
            await SendAsync(0x20, v5 ? [0, 0, 0] : [0, 0]);
            while (!stop.IsCancellationRequested)
            {
                var packet = await ReadPacketAsync(stream, stop.Token);
                if (packet.Header == 0x82)
                {
                    var offset = v5 ? 3 : 2; var codes = new List<byte>(); var filters = new List<string>();
                    while (offset < packet.Body.Length) { var length = BinaryPrimitives.ReadUInt16BigEndian(packet.Body.AsSpan(offset)); offset += 2; filters.Add(Encoding.UTF8.GetString(packet.Body, offset, length)); offset += length; codes.Add(packet.Body[offset++]); }
                    foreach (var retained in RetainedBeforeSubAck.Where(pair => filters.Contains(pair.Key))) await PublishAsync(retained.Key, retained.Value, retained: true, qos: 1);
                    var body = new List<byte> { packet.Body[0], packet.Body[1] }; if (v5) body.Add(0); body.AddRange(codes);
                    await SendAsync(0x90, body.ToArray()); Subscribed.TrySetResult(true);
                }
                else if (packet.Header == 0xA2)
                {
                    var offset = v5 ? 3 : 2; var codes = new List<byte>();
                    while (offset < packet.Body.Length) { var length = BinaryPrimitives.ReadUInt16BigEndian(packet.Body.AsSpan(offset)); offset += 2 + length; codes.Add(0); }
                    var body = new List<byte> { packet.Body[0], packet.Body[1] }; if (v5) { body.Add(0); body.AddRange(codes); } await SendAsync(0xB0, body.ToArray());
                }
                else if (packet.Header == 0x40) PublishAcknowledged.TrySetResult(BinaryPrimitives.ReadUInt16BigEndian(packet.Body));
                else if (packet.Header == 0xC0) await SendAsync(0xD0, []);
                else throw new IOException("Unexpected fixture client packet.");
            }
        }
        catch (Exception error) when (error is OperationCanceledException or IOException or ObjectDisposedException or SocketException or WebSocketException or AuthenticationException) { Failure = error; }
    }
    internal async Task PublishAsync(string topic, string payload, bool retained = false, int qos = 0, ushort id = 7)
    {
        var data = Encoding.UTF8.GetBytes(topic); var body = new MemoryStream(); body.WriteByte((byte)(data.Length >> 8)); body.WriteByte((byte)data.Length); body.Write(data);
        if (qos == 1) { body.WriteByte((byte)(id >> 8)); body.WriteByte((byte)id); }
        if (v5) body.WriteByte(0); body.Write(Encoding.UTF8.GetBytes(payload));
        await SendAsync((byte)(0x30 | (qos << 1) | (retained ? 1 : 0)), body.ToArray());
    }
    internal async Task SendRawAsync(byte[] bytes)
    { await writes.WaitAsync(stop.Token); try { await stream!.WriteAsync(bytes, stop.Token); await stream.FlushAsync(stop.Token); } finally { writes.Release(); } }
    private Task SendAsync(byte header, byte[] body)
    { var packet = new MemoryStream(); packet.WriteByte(header); var length = body.Length; do { var digit = length % 128; length /= 128; packet.WriteByte((byte)(digit | (length > 0 ? 128 : 0))); } while (length > 0); packet.Write(body); return SendRawAsync(packet.ToArray()); }
    private static async Task<(byte Header, byte[] Body)> ReadPacketAsync(Stream stream, CancellationToken ct)
    {
        var one = new byte[1]; await stream.ReadExactlyAsync(one, ct); var header = one[0]; var length = 0; var scale = 1;
        do { await stream.ReadExactlyAsync(one, ct); length += (one[0] & 127) * scale; scale *= 128; } while ((one[0] & 128) != 0);
        if (length > 1024 * 1024) throw new IOException("Fixture client packet is unexpectedly large.");
        var body = new byte[length]; await stream.ReadExactlyAsync(body, ct); return (header, body);
    }
    private static async Task<Stream> UpgradeAsync(Stream stream, CancellationToken ct)
    {
        var bytes = new List<byte>(); var one = new byte[1];
        while (true) { await stream.ReadExactlyAsync(one, ct); bytes.Add(one[0]); if (bytes.Count > 8192) throw new IOException("Fixture WebSocket headers exceeded their limit."); if (bytes.Count >= 4 && bytes.TakeLast(4).SequenceEqual(new byte[] { 13, 10, 13, 10 })) break; }
        var headers = Encoding.ASCII.GetString(bytes.ToArray()).Split("\r\n"); var key = headers.Single(line => line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase)).Split(':', 2)[1].Trim();
        var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
        await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: mqtt\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n"), ct);
        await stream.FlushAsync(ct);
        return new FixtureWebSocketStream(WebSocket.CreateFromStream(stream, true, "mqtt", Timeout.InfiniteTimeSpan));
    }
    public async ValueTask DisposeAsync()
    {
        stop.Cancel(); listener.Stop(); stream?.Dispose(); try { await run.WaitAsync(TimeSpan.FromSeconds(2)); } catch { }
        stop.Dispose(); writes.Dispose(); certificate?.Dispose();
        if (Directory.Exists(DataDirectory)) Directory.Delete(DataDirectory, true);
    }
    private sealed class FixtureWebSocketStream(WebSocket socket) : Stream
    {
        public override bool CanRead => true; public override bool CanWrite => true; public override bool CanSeek => false;
        public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] bytes, int offset, int count) => throw new NotSupportedException();
        public override async ValueTask<int> ReadAsync(Memory<byte> bytes, CancellationToken ct = default)
        { while (true) { var frame = await socket.ReceiveAsync(bytes, ct); if (frame.MessageType != WebSocketMessageType.Binary) throw new IOException("Fixture closed WebSocket."); if (frame.Count > 0) return frame.Count; } }
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> bytes, CancellationToken ct = default) => socket.SendAsync(bytes, WebSocketMessageType.Binary, true, ct);
        public override void Write(byte[] bytes, int offset, int count) => throw new NotSupportedException(); public override void Flush() { } public override Task FlushAsync(CancellationToken ct) => Task.CompletedTask;
        public override long Seek(long value, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (disposing) socket.Dispose(); base.Dispose(disposing); }
    }
}
