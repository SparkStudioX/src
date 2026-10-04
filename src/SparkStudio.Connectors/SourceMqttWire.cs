using System.Buffers.Binary;
using System.Net.Security;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace SparkStudio.Connectors;

// Independently authored bounded MQTT client. The receive allocation gate belongs here,
// before reading any body, rather than behind a library's already allocated publish queue.
internal sealed class SourceMqttWire : IAsyncDisposable
{
    internal sealed record Publish(string Topic, ReadOnlyMemory<byte> Payload, bool Retained, bool Duplicate, long Ordinal);
    internal sealed class ProtocolException(string message) : IOException(message);
    internal sealed class RejectedException(string message) : IOException(message);
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private readonly Stream stream;
    private readonly bool v5;
    private readonly SourceLimits limits;
    private readonly int keepAlive;
    private readonly SourceTransportTelemetry telemetry;
    private readonly SemaphoreSlim writes = new(1, 1);
    private readonly SourceMemoryBudget memory = new();
    private readonly Dictionary<ushort, (int PacketType, TaskCompletionSource<byte[]> Completion)> acknowledgments = [];
    private readonly CancellationTokenSource stop = new();
    private Task? receiver;
    private Task? heartbeat;
    private ushort nextId;
    private long ordinal;
    private long currentBody, peakBody, currentPacket, peakPacket, headerRejected, payloadRejected, queueRejected, received, admitted;
    private long lastReceived = Environment.TickCount64;
    private bool disposed;

    private SourceMqttWire(Stream stream, bool v5, SourceLimits limits, int keepAlive, SourceTransportTelemetry? telemetry = null)
    {
        this.stream = stream; this.v5 = v5; this.limits = limits; this.keepAlive = keepAlive;
        this.telemetry = telemetry ?? new();
        try { memory.SetBytes("decode", 4L * Math.Min(limits.PacketBytes, 272 * 1024)); }
        catch { stream.Dispose(); memory.Dispose(); throw; }
    }
    internal Task Completion => receiver ?? Task.CompletedTask;
    internal IReadOnlyDictionary<string, object?> Metrics() => new Dictionary<string, object?>(telemetry.Snapshot()) {
        ["inputByteBasis"] = "received MQTT protocol bytes, including headers and control packets",
        ["bodyBytes"] = Interlocked.Read(ref currentBody), ["peakBodyBytes"] = Interlocked.Read(ref peakBody),
        ["packetBytes"] = Interlocked.Read(ref currentPacket), ["peakPacketBytes"] = Interlocked.Read(ref peakPacket),
        ["headerRejections"] = Interlocked.Read(ref headerRejected), ["payloadRejections"] = Interlocked.Read(ref payloadRejected),
        ["queueRejections"] = Interlocked.Read(ref queueRejected), ["publishReceived"] = Interlocked.Read(ref received), ["publishAdmitted"] = Interlocked.Read(ref admitted)
    };

    internal static async Task<SourceMqttWire> ConnectAsync(ConnectionDefinition connection, string dataDirectory, CancellationToken ct, SourceTransportTelemetry? telemetry = null)
    {
        var source = connection.Source ?? throw new ArgumentException("Missing Source settings.");
        var settings = source.Mqtt ?? new();
        if (!Uri.TryCreate(source.Endpoint, UriKind.Absolute, out var uri) || string.IsNullOrWhiteSpace(uri.Host) ||
            !string.IsNullOrEmpty(uri.UserInfo) || !new[] { "mqtt", "mqtts", "ws", "wss" }.Contains(uri.Scheme))
            throw new ArgumentException("MQTT endpoint must be mqtt://, mqtts://, ws:// or wss:// without embedded credentials.");
        var websocket = uri.Scheme is "ws" or "wss";
        var tls = uri.Scheme is "mqtts" or "wss";
        if (settings.Transport is not ("tcp" or "tls" or "websocket") ||
            (settings.Transport == "websocket") != websocket || (settings.Transport == "tls" && !tls))
            throw new ArgumentException("MQTT transport does not match its endpoint scheme.");
        if (settings.ProtocolVersion is not ("5" or "3.1.1") || settings.KeepAliveSeconds is < 1 or > 65535 ||
            settings.SessionExpirySeconds is < 0 or > 86400 || (!settings.CleanStart && string.IsNullOrEmpty(settings.ClientId)))
            throw new ArgumentException("Invalid MQTT protocol, keepalive, or persistent-session settings.");
        if (settings.ProtocolVersion == "3.1.1" && settings.SessionExpirySeconds != 0)
            throw new ArgumentException("Session expiry requires MQTT 5.");
        var auth = source.Authentication ?? new();
        if (auth.Mode is not ("none" or "basic" or "username")) throw new ArgumentException("MQTT supports protected username/password authentication.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(Math.Clamp(source.EffectiveLimits.ConnectTimeoutMs, 1, 5000));
        Stream transport;
        if (websocket)
        {
            var socket = new ClientWebSocket();
            socket.Options.AddSubProtocol("mqtt");
            socket.Options.KeepAliveInterval = Timeout.InfiniteTimeSpan;
            if (tls) ConfigureWebSocketTls(socket, source.Tls, dataDirectory);
            try { await socket.ConnectAsync(uri, deadline.Token); transport = new WebSocketStream(socket); }
            catch { socket.Dispose(); throw; }
        }
        else
        {
            var socket = new TcpClient();
            try
            {
                await socket.ConnectAsync(uri.Host, uri.IsDefaultPort || uri.Port == -1 ? tls ? 8883 : 1883 : uri.Port, deadline.Token);
                transport = socket.GetStream();
                if (tls)
                {
                    var secure = new SslStream(transport, false, CertificateValidator(source.Tls, dataDirectory));
                    var options = new SslClientAuthenticationOptions { TargetHost = uri.Host, EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13 };
                    if (LoadClientCertificate(source.Tls, dataDirectory) is { } client) options.ClientCertificates = [client];
                    await secure.AuthenticateAsClientAsync(options, deadline.Token);
                    transport = secure;
                }
            }
            catch { socket.Dispose(); throw; }
        }
        var wire = new SourceMqttWire(transport, settings.ProtocolVersion == "5", source.EffectiveLimits, settings.KeepAliveSeconds, telemetry);
        try
        {
            var body = new MemoryStream();
            WriteString(body, "MQTT"); body.WriteByte(wire.v5 ? (byte)5 : (byte)4);
            var flags = settings.CleanStart ? 2 : 0;
            if (auth.Mode != "none") flags |= 0xC0;
            body.WriteByte((byte)flags); WriteU16(body, (ushort)settings.KeepAliveSeconds);
            if (wire.v5)
            {
                var props = new MemoryStream();
                props.WriteByte(0x27); WriteU32(props, (uint)Math.Min(source.EffectiveLimits.PacketBytes, 272 * 1024));
                props.WriteByte(0x21); WriteU16(props, 64);
                if (settings.SessionExpirySeconds != 0) { props.WriteByte(0x11); WriteU32(props, (uint)settings.SessionExpirySeconds); }
                WriteVariable(body, checked((int)props.Length)); props.Position = 0; props.CopyTo(body);
            }
            WriteString(body, settings.ClientId ?? "spark-" + Guid.NewGuid().ToString("N"));
            if (auth.Mode != "none") { WriteString(body, auth.Username ?? ""); WriteString(body, auth.Password ?? ""); }
            await wire.SendAsync(0x10, body.ToArray(), deadline.Token);
            var response = await wire.ReadPacketAsync(deadline.Token);
            if (response.Header != 0x20 || response.Body.Length < 2 || (response.Body[0] & 0xFE) != 0 || settings.CleanStart && response.Body[0] != 0)
                throw new ProtocolException("Invalid MQTT CONNACK.");
            if (response.Body[1] != 0) throw new RejectedException("MQTT broker rejected CONNECT (reason " + response.Body[1] + ").");
            if (!wire.v5 && response.Body.Length != 2) throw new ProtocolException("Invalid MQTT 3.1.1 CONNACK length.");
            if (wire.v5)
            {
                var offset = 2; SkipProperties(response.Body, ref offset);
                if (offset != response.Body.Length) throw new ProtocolException("Invalid MQTT 5 CONNACK properties.");
            }
            Interlocked.Exchange(ref wire.currentBody, 0); Interlocked.Exchange(ref wire.currentPacket, 0); return wire;
        }
        catch { await wire.DisposeAsync(); throw; }
    }

    internal void Start(Func<Publish, bool> admit, Action<Publish, string> rejected)
    {
        receiver = ReceiveAsync(admit, rejected, stop.Token);
        heartbeat = HeartbeatAsync(stop.Token);
    }

    internal async Task SubscribeAsync(IReadOnlyList<(string Filter, int Qos)> filters, CancellationToken ct)
    {
        // Small batches also bound acknowledgment state and broker-controlled SUBACK allocations.
        foreach (var batch in SubscriptionBatches(filters))
        {
            var id = AllocateId(); var body = new MemoryStream(); WriteU16(body, id); if (v5) body.WriteByte(0);
            foreach (var filter in batch) { WriteString(body, filter.Filter); body.WriteByte((byte)filter.Qos); }
            var ack = await SendAcknowledgedAsync(id, 0x82, body.ToArray(), ct);
            var offset = 2; if (v5) SkipProperties(ack, ref offset);
            if (ack.Length - offset != batch.Length || ack.AsSpan(offset).ContainsAnyExcept((byte)0, (byte)1))
                throw new RejectedException("MQTT broker rejected a subscription.");
            for (var index = 0; index < batch.Length; index++) if (ack[offset + index] > batch[index].Qos) throw new ProtocolException("MQTT broker granted QoS above the subscription request.");
        }
    }
    internal async Task UnsubscribeAsync(IReadOnlyList<string> filters, CancellationToken ct)
    {
        foreach (var batch in SubscriptionBatches(filters.Select(filter => (Filter: filter, Qos: 0)).ToArray()))
        {
            var id = AllocateId(); var body = new MemoryStream(); WriteU16(body, id); if (v5) body.WriteByte(0);
            foreach (var filter in batch) WriteString(body, filter.Filter);
            var ack = await SendAcknowledgedAsync(id, 0xA2, body.ToArray(), ct);
            if (v5) { var offset = 2; SkipProperties(ack, ref offset); if (ack.Length - offset != batch.Length || ack.AsSpan(offset).ContainsAnyExcept((byte)0, (byte)0x11)) throw new RejectedException("MQTT broker rejected unsubscribe."); }
            else if (ack.Length != 2) throw new ProtocolException("Invalid UNSUBACK.");
        }
    }
    internal async Task PublishAsync(string topic, ReadOnlyMemory<byte> payload, int qos, bool retain, CancellationToken ct)
    {
        if (qos is not (0 or 1) || string.IsNullOrEmpty(topic) || topic.Contains('+') || topic.Contains('#') || topic.Any(char.IsControl))
            throw new ArgumentException("Publishing requires a concrete topic and QoS 0 or 1.");
        if (payload.Length > Math.Min(limits.PayloadBytes, 256 * 1024) || Utf8.GetByteCount(topic) > 4096)
            throw new ArgumentException("MQTT publication exceeds its local byte limit.");
        var id = qos == 1 ? AllocateId() : (ushort)0;
        using var body = new MemoryStream(); WriteString(body, topic);
        if (qos == 1) WriteU16(body, id);
        if (v5) body.WriteByte(0);
        body.Write(payload.Span);
        var header = (byte)(0x30 | (qos << 1) | (retain ? 1 : 0));
        if (qos == 0) { await SendAsync(header, body.ToArray(), ct); return; }
        var ack = await SendAcknowledgedAsync(id, header, body.ToArray(), ct);
        ValidatePublishAcknowledgment(ack);
    }
    private void ValidatePublishAcknowledgment(byte[] ack)
    {
        if (!v5 && ack.Length != 2) throw new ProtocolException("Invalid PUBACK.");
        if (v5 && ack.Length > 2 && ack[2] >= 0x80) throw new RejectedException("MQTT broker rejected the publication (reason " + ack[2] + ").");
        if (v5 && ack.Length > 3) { var offset = 3; SkipProperties(ack, ref offset); if (offset != ack.Length) throw new ProtocolException("Invalid PUBACK properties."); }
    }
    private IEnumerable<(string Filter, int Qos)[]> SubscriptionBatches(IReadOnlyList<(string Filter, int Qos)> filters)
    {
        var batch = new List<(string Filter, int Qos)>(); var bytes = 8; var cap = Math.Min(limits.PacketBytes, 272 * 1024);
        foreach (var filter in filters)
        {
            var cost = Utf8.GetByteCount(filter.Filter) + 3;
            if (cost > cap - 8) throw new ArgumentException("MQTT filter exceeds the local packet byte cap.");
            if (batch.Count == 64 || bytes + cost > cap) { yield return batch.ToArray(); batch.Clear(); bytes = 8; }
            batch.Add(filter); bytes += cost;
        }
        if (batch.Count > 0) yield return batch.ToArray();
    }
    private ushort AllocateId() { if (++nextId == 0) nextId = 1; return nextId; }
    private async Task<byte[]> SendAcknowledgedAsync(ushort id, byte header, byte[] body, CancellationToken ct)
    {
        var completion = new TaskCompletionSource<byte[]>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (acknowledgments) acknowledgments.Add(id, (header >> 4 == 3 ? 4 : header == 0x82 ? 9 : 11, completion));
        try { await SendAsync(header, body, ct); return await completion.Task.WaitAsync(ct); }
        finally { lock (acknowledgments) acknowledgments.Remove(id); }
    }
    private async Task ReceiveAsync(Func<Publish, bool> admit, Action<Publish, string> rejected, CancellationToken ct)
    {
        var sizeViolations = 0;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var packet = await ReadPacketAsync(ct); lastReceived = Environment.TickCount64;
                var type = packet.Header >> 4;
                if (type == 3)
                {
                    var qos = (packet.Header >> 1) & 3;
                    if (qos > 1 || (qos == 0 && (packet.Header & 8) != 0)) throw new ProtocolException("Only MQTT QoS 0 and 1 are supported.");
                    var offset = 0; var topic = ReadString(packet.Body, ref offset);
                    if (topic.Length == 0 || topic.Contains('+') || topic.Contains('#')) throw new ProtocolException("Invalid MQTT topic or unsupported topic alias.");
                    var id = qos == 1 ? ReadU16(packet.Body, ref offset) : (ushort)0;
                    if (qos == 1 && id == 0) throw new ProtocolException("MQTT packet identifier must be nonzero.");
                    if (v5) SkipProperties(packet.Body, ref offset);
                    var message = new Publish(topic, packet.Body.AsMemory(offset), (packet.Header & 1) != 0, (packet.Header & 8) != 0, Interlocked.Increment(ref ordinal));
                    Interlocked.Increment(ref received);
                    var oversized = message.Payload.Length > Math.Min(limits.PayloadBytes, 256 * 1024);
                    if (oversized) { sizeViolations++; Interlocked.Increment(ref payloadRejected); rejected(message, "MQTT payload exceeds its local byte limit."); }
                    else if (!admit(message)) { Interlocked.Increment(ref queueRejected); rejected(message, "MQTT input queue is full; newest message dropped."); }
                    else Interlocked.Increment(ref admitted);
                    // Receipt/admission ACK is independent of decoding/application commit. Rejected poison
                    // messages within the packet cap are acknowledged to avoid an endless redelivery loop.
                    if (qos == 1) await SendAsync(0x40, [(byte)(id >> 8), (byte)id], ct);
                    if (sizeViolations >= 3) throw new ProtocolException("Repeated MQTT payload size violations; correct the publisher or local profile.");
                }
                else if (IsAcknowledgment(type))
                {
                    if ((packet.Header & 15) != 0 || packet.Body.Length < 2) throw new ProtocolException("Invalid MQTT acknowledgment.");
                    var offset = 0; var id = ReadU16(packet.Body, ref offset);
                    lock (acknowledgments) if (acknowledgments.TryGetValue(id, out var pending))
                    { if (pending.PacketType != type) throw new ProtocolException("MQTT acknowledgment has the wrong packet type."); pending.Completion.TrySetResult(packet.Body); }
                }
                else if (type == 13 && packet.Header == 0xD0 && packet.Body.Length == 0) { }
                else if (type == 14) throw new IOException("MQTT broker disconnected the subscriber.");
                else throw new ProtocolException("Unexpected MQTT server packet type " + type + ".");
                Interlocked.Exchange(ref currentBody, 0); Interlocked.Exchange(ref currentPacket, 0);
            }
        }
        catch (Exception error)
        {
            lock (acknowledgments) foreach (var pending in acknowledgments.Values) pending.Completion.TrySetException(error);
            Interlocked.Exchange(ref currentBody, 0); Interlocked.Exchange(ref currentPacket, 0); stop.Cancel(); throw;
        }
    }
    private static bool IsAcknowledgment(int type) => type is 4 or 9 or 11;
    private async Task HeartbeatAsync(CancellationToken ct)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Max(1, keepAlive / 2d)));
            while (await timer.WaitForNextTickAsync(ct))
            {
                if (Environment.TickCount64 - lastReceived > keepAlive * 1500L) { stream.Dispose(); throw new IOException("MQTT keepalive response timed out."); }
                await SendAsync(0xC0, [], ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch { stream.Dispose(); throw; }
    }
    internal async Task<(byte Header, byte[] Body)> ReadPacketAsync(CancellationToken ct)
    {
        var one = new byte[1]; await ReadInputExactlyAsync(one, ct); var header = one[0];
        var length = 0; var multiplier = 1; var bytes = 1;
        for (var index = 0; ; index++)
        {
            if (index == 4) throw new ProtocolException("Malformed MQTT Remaining Length.");
            await ReadInputExactlyAsync(one, ct); bytes++; var digit = one[0];
            length += (digit & 127) * multiplier;
            if ((digit & 128) == 0) { if (index > 0 && digit == 0) throw new ProtocolException("Noncanonical MQTT Remaining Length."); break; }
            multiplier *= 128;
        }
        // This check precedes allocation and body reads, for both protocol versions and all transports.
        if (length > Math.Min(limits.PacketBytes, 272 * 1024) - bytes) { Interlocked.Increment(ref headerRejected); throw new ProtocolException("MQTT packet exceeds its local byte limit."); }
        Interlocked.Exchange(ref currentBody, length); Interlocked.Exchange(ref currentPacket, length + bytes);
        Interlocked.Exchange(ref peakBody, Math.Max(Interlocked.Read(ref peakBody), length));
        Interlocked.Exchange(ref peakPacket, Math.Max(Interlocked.Read(ref peakPacket), length + bytes));
        var body = new byte[length]; await ReadInputExactlyAsync(body, ct); return (header, body);
    }
    private async ValueTask ReadInputExactlyAsync(Memory<byte> target, CancellationToken ct)
    {
        while (!target.IsEmpty) {
            var read = await stream.ReadAsync(target, ct);
            if (read == 0) throw new EndOfStreamException("MQTT transport ended inside a packet.");
            telemetry.RecordInput(read); target = target[read..];
        }
    }
    internal static SourceMqttWire ForFixture(Stream stream, bool v5, SourceLimits? limits = null) => new(stream, v5, limits ?? new(), 30);
    private async Task SendAsync(byte header, byte[] body, CancellationToken ct)
    {
        var packet = new MemoryStream(); packet.WriteByte(header); WriteVariable(packet, body.Length); packet.Write(body);
        if (packet.Length > Math.Min(limits.PacketBytes, 272 * 1024)) throw new ArgumentException("MQTT outbound packet exceeds its local byte limit.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(Math.Clamp(limits.RequestTimeoutMs, 1, 2000));
        var entered = false;
        try
        {
            await writes.WaitAsync(deadline.Token); entered = true;
            await stream.WriteAsync(packet.GetBuffer().AsMemory(0, (int)packet.Length), deadline.Token).AsTask().WaitAsync(deadline.Token);
            await stream.FlushAsync(deadline.Token).WaitAsync(deadline.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        { stream.Dispose(); throw new IOException("MQTT outbound acknowledgment/control write timed out."); }
        finally { if (entered) writes.Release(); }
    }
    internal static void WriteVariable(Stream stream, int value)
    { do { var digit = value % 128; value /= 128; if (value != 0) digit |= 128; stream.WriteByte((byte)digit); } while (value != 0); }
    private static int ReadVariable(byte[] data, ref int offset)
    {
        var result = 0; var multiplier = 1;
        for (var index = 0; index < 4; index++) { if (offset >= data.Length) throw new ProtocolException("Truncated MQTT property length."); var digit = data[offset++]; result += (digit & 127) * multiplier; if ((digit & 128) == 0) return result; multiplier *= 128; }
        throw new ProtocolException("Malformed MQTT property length.");
    }
    private static void SkipProperties(byte[] body, ref int offset)
    {
        var size = ReadVariable(body, ref offset); if (size > body.Length - offset) throw new ProtocolException("Truncated MQTT properties.");
        // MQTT 5 property length is structurally bounded. Aliases are not advertised or accepted.
        var end = offset + size;
        while (offset < end)
        {
            var id = ReadVariable(body, ref offset);
            switch (id)
            {
                case 1: case 0x17: case 0x19: case 0x24: case 0x25: case 0x28: case 0x29: case 0x2A: offset++; break;
                case 2: case 0x11: case 0x18: case 0x27: offset += 4; break;
                case 0x13: case 0x21: case 0x22: offset += 2; break;
                case 0x23: throw new ProtocolException("MQTT topic aliases were not negotiated.");
                case 0x0B: _ = ReadVariable(body, ref offset); break;
                case 3: case 8: case 0x12: case 0x15: case 0x1A: case 0x1C: case 0x1F: _ = ReadString(body, ref offset); break;
                case 9: case 0x16: var bytes = ReadU16(body, ref offset); offset += bytes; break;
                case 0x26: _ = ReadString(body, ref offset); _ = ReadString(body, ref offset); break;
                default: throw new ProtocolException("Unknown MQTT property.");
            }
            if (offset > end) throw new ProtocolException("MQTT property crosses its declared boundary.");
        }
    }
    private static ushort ReadU16(byte[] data, ref int offset)
    { if (data.Length - offset < 2) throw new ProtocolException("Truncated MQTT integer."); var value = BinaryPrimitives.ReadUInt16BigEndian(data.AsSpan(offset)); offset += 2; return value; }
    private static string ReadString(byte[] data, ref int offset)
    {
        var length = ReadU16(data, ref offset); if (data.Length - offset < length) throw new ProtocolException("Truncated MQTT string.");
        string value; try { value = Utf8.GetString(data, offset, length); } catch (DecoderFallbackException) { throw new ProtocolException("Invalid MQTT UTF-8."); }
        offset += length; if (value.Contains('\0')) throw new ProtocolException("NUL is not permitted in MQTT strings."); return value;
    }
    private static void WriteString(Stream stream, string value)
    { var bytes = Utf8.GetBytes(value); if (bytes.Length > ushort.MaxValue || value.Contains('\0')) throw new ArgumentException("MQTT string exceeds its limit or contains NUL."); WriteU16(stream, (ushort)bytes.Length); stream.Write(bytes); }
    private static void WriteU16(Stream stream, ushort value) { Span<byte> bytes = stackalloc byte[2]; BinaryPrimitives.WriteUInt16BigEndian(bytes, value); stream.Write(bytes); }
    private static void WriteU32(Stream stream, uint value) { Span<byte> bytes = stackalloc byte[4]; BinaryPrimitives.WriteUInt32BigEndian(bytes, value); stream.Write(bytes); }
    private static string ReferencePath(string dataDirectory, string reference)
    {
        return SourceHttp.CertificatePath(reference, dataDirectory);
    }
    private static X509Certificate2? LoadClientCertificate(SourceTlsSettings? settings, string dataDirectory)
    {
        if (settings?.ClientCertificateReference is not { } reference) return null;
        var cert = ReferencePath(dataDirectory, reference);
        var certificate = settings.ClientKeyReference is { } key ? X509Certificate2.CreateFromPemFile(cert, ReferencePath(dataDirectory, key)) : X509CertificateLoader.LoadPkcs12FromFile(cert, null, X509KeyStorageFlags.EphemeralKeySet);
        if (!certificate.HasPrivateKey) { certificate.Dispose(); throw new ArgumentException("MQTT client certificate requires its private key."); }
        return certificate;
    }
    private static RemoteCertificateValidationCallback CertificateValidator(SourceTlsSettings? settings, string dataDirectory) => (_, certificate, _, errors) =>
    {
        if (certificate is null || (errors & (SslPolicyErrors.RemoteCertificateNotAvailable | SslPolicyErrors.RemoteCertificateNameMismatch)) != 0) return false;
        using var peer = new X509Certificate2(certificate);
        if (settings?.ServerCertificateSha256 is { } pin && !string.Equals(Convert.ToHexString(SHA256.HashData(peer.RawData)), pin.Replace(":", "").Replace(" ", ""), StringComparison.OrdinalIgnoreCase)) return false;
        if (settings?.CaCertificateReference is { } ca)
        {
            using var chain = new X509Chain(); using var root = X509CertificateLoader.LoadCertificateFromFile(ReferencePath(dataDirectory, ca));
            chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust; chain.ChainPolicy.CustomTrustStore.Add(root);
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            return chain.Build(peer);
        }
        return errors == SslPolicyErrors.None;
    };
    private static void ConfigureWebSocketTls(ClientWebSocket socket, SourceTlsSettings? settings, string dataDirectory)
    { socket.Options.RemoteCertificateValidationCallback = CertificateValidator(settings, dataDirectory); if (LoadClientCertificate(settings, dataDirectory) is { } client) socket.Options.ClientCertificates.Add(client); }
    public async ValueTask DisposeAsync()
    {
        if (disposed) return; disposed = true; stop.Cancel(); stream.Dispose();
        foreach (var task in new[] { receiver, heartbeat }) if (task is not null) try { await task.WaitAsync(TimeSpan.FromSeconds(2)); } catch { }
        stop.Dispose(); writes.Dispose(); memory.Dispose();
    }
    private sealed class WebSocketStream(ClientWebSocket socket) : Stream
    {
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { } public override Task FlushAsync(CancellationToken ct) => Task.CompletedTask;
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
        {
            while (true) { var result = await socket.ReceiveAsync(buffer, ct); if (result.MessageType != WebSocketMessageType.Binary) throw new ProtocolException("MQTT WebSocket requires binary frames."); if (result.Count != 0) return result.Count; }
        }
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default) => socket.SendAsync(buffer, WebSocketMessageType.Binary, true, ct);
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (disposing) socket.Dispose(); base.Dispose(disposing); }
    }
}
