using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;

// Independently authored isolated MQTT 3.1.1 broker fixture; never contacts an installed broker.
internal sealed class ModelPublishingBroker : IAsyncDisposable
{
    private readonly TcpListener listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource stop = new();
    private readonly Task run;
    internal readonly ConcurrentQueue<(string Topic, string Payload, int Qos, bool Retain)> Messages = new();
    internal readonly ConcurrentQueue<string> ClientIds = new();
    internal bool Acknowledge = true;
    internal int Connections;
    internal string? Username, Password;
    internal string Endpoint => "mqtt://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port;
    internal ModelPublishingBroker() { listener.Start(); run = RunAsync(); }
    private async Task RunAsync()
    {
        var clients = new List<Task>();
        try
        {
            while (!stop.IsCancellationRequested) clients.Add(ClientAsync(await listener.AcceptTcpClientAsync(stop.Token)));
        }
        catch (Exception error) when (error is OperationCanceledException or SocketException or ObjectDisposedException) { }
        finally { await Task.WhenAll(clients); }
    }
    private async Task ClientAsync(TcpClient socket)
    {
        using (socket)
        try
        {
            Interlocked.Increment(ref Connections);
            var stream = socket.GetStream();
            var connect = await ReadAsync(stream);
            if (connect.Header != 0x10 || connect.Body[6] != 4) throw new IOException("Expected MQTT 3.1.1 CONNECT.");
            var offset = 10; ClientIds.Enqueue(ReadString(connect.Body, ref offset));
            if ((connect.Body[7] & 0x80) != 0) Username = ReadString(connect.Body, ref offset);
            if ((connect.Body[7] & 0x40) != 0) Password = ReadString(connect.Body, ref offset);
            await stream.WriteAsync(new byte[] { 0x20, 2, 0, 0 }, stop.Token);
            while (!stop.IsCancellationRequested)
            {
                var packet = await ReadAsync(stream);
                if (packet.Header == 0xC0) { await stream.WriteAsync(new byte[] { 0xD0, 0 }, stop.Token); continue; }
                if (packet.Header >> 4 != 3) throw new IOException("Expected PUBLISH.");
                offset = 0; var topic = ReadString(packet.Body, ref offset); var qos = (packet.Header >> 1) & 3;
                var id = qos == 1 ? BinaryPrimitives.ReadUInt16BigEndian(packet.Body.AsSpan(offset)) : (ushort)0;
                if (qos == 1) offset += 2;
                Messages.Enqueue((topic, Encoding.UTF8.GetString(packet.Body.AsSpan(offset)), qos, (packet.Header & 1) != 0));
                if (qos == 1 && Acknowledge) await stream.WriteAsync(new byte[] { 0x40, 2, (byte)(id >> 8), (byte)id }, stop.Token);
            }
        }
        catch (Exception error) when (error is IOException or OperationCanceledException or SocketException or ObjectDisposedException) { }
    }
    private async Task<(byte Header, byte[] Body)> ReadAsync(Stream stream)
    {
        var one = new byte[1]; await stream.ReadExactlyAsync(one, stop.Token); var header = one[0]; var length = 0; var shift = 0;
        do { await stream.ReadExactlyAsync(one, stop.Token); length |= (one[0] & 127) << shift; shift += 7; if (shift > 28) throw new IOException("Invalid length."); } while ((one[0] & 128) != 0);
        if (length > 300 * 1024) throw new IOException("Fixture packet too large.");
        var body = new byte[length]; await stream.ReadExactlyAsync(body, stop.Token); return (header, body);
    }
    private static string ReadString(byte[] body, ref int offset)
    {
        var length = BinaryPrimitives.ReadUInt16BigEndian(body.AsSpan(offset)); offset += 2;
        var result = Encoding.UTF8.GetString(body, offset, length); offset += length; return result;
    }
    public async ValueTask DisposeAsync()
    {
        stop.Cancel(); listener.Stop(); await run.WaitAsync(TimeSpan.FromSeconds(5)); stop.Dispose();
    }
}
