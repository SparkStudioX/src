using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Collections.Concurrent;
using System.Diagnostics;

// A loopback-only synthetic agent. No live/vendored response documents are used.
internal sealed class MtConnectSimulatorFixture : IAsyncDisposable
{
    private readonly TcpListener listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource stopping = new();
    private readonly List<Task> clients = [];
    private readonly Task accepting;
    private int currentReads;
    private int samples;
    public Uri Endpoint { get; }
    public int CurrentReads => Volatile.Read(ref currentReads);
    public int SampleRequests => Volatile.Read(ref samples);
    public bool StallAfterSeed { get; init; }
    public bool ExpireFirstCursor { get; init; }
    public bool DropAfterValidPart { get; init; }
    public bool MalformedSamples { get; init; }
    public ConcurrentQueue<(long Started, ulong Cursor)> SampleStarts { get; } = new();
    public MtConnectSimulatorFixture()
    {
        listener.Start();
        Endpoint = new Uri("http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port);
        accepting = AcceptAsync();
    }
    private async Task AcceptAsync()
    {
        try {
            while (!stopping.IsCancellationRequested) {
                var client = await listener.AcceptTcpClientAsync(stopping.Token);
                var task = ServeAsync(client);
                lock (clients) { clients.RemoveAll(t => t.IsCompleted); clients.Add(task); }
            }
        } catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (SocketException) when (stopping.IsCancellationRequested) { }
    }
    private async Task ServeAsync(TcpClient client)
    {
        using (client) {
            var ct = stopping.Token;
            try {
                await using var stream = client.GetStream();
                using var headersDeadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                headersDeadline.CancelAfter(TimeSpan.FromSeconds(2));
                var header = new List<byte>(); var one = new byte[1];
                while (header.Count < 16384) {
                    if (await stream.ReadAsync(one, headersDeadline.Token) == 0) return;
                    header.Add(one[0]);
                    if (header.Count >= 4 && header[^4] == 13 && header[^3] == 10 && header[^2] == 13 && header[^1] == 10) break;
                }
                var first = Encoding.ASCII.GetString(header.ToArray()).Split("\r\n", StringSplitOptions.None)[0].Split(' ');
                if (first.Length != 3 || first[0] != "GET") { await SendAsync(stream, "400 Bad Request", "", ct); return; }
                var uri = new Uri(Endpoint, first[1]);
                if (uri.AbsolutePath == "/probe") {
                    await SendAsync(stream, "200 OK", Probe, ct); return;
                }
                if (uri.AbsolutePath == "/current") {
                    var count = Interlocked.Increment(ref currentReads);
                    await SendAsync(stream, "200 OK", Current((ulong)(count * 10), count), ct); return;
                }
                if (uri.AbsolutePath == "/sample") {
                    var request = Interlocked.Increment(ref samples);
                    if (ExpireFirstCursor && request == 1) {
                        await SendAsync(stream, "404 Not Found", "<MTConnectError xmlns=\"urn:mtconnect.org:MTConnectError:2.8\"><Errors><OutOfRange><Message>Synthetic expired cursor</Message></OutOfRange></Errors></MTConnectError>", ct); return;
                    }
                    await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: multipart/mixed; boundary=loopback-agent\r\nConnection: close\r\n\r\n"), ct);
                    if (StallAfterSeed) { await Task.Delay(Timeout.Infinite, ct); return; }
                    var rawFrom = uri.Query.TrimStart('?').Split('&').FirstOrDefault(q => q.StartsWith("from=", StringComparison.Ordinal))?[5..];
                    if (!ulong.TryParse(rawFrom, out var cursor)) { await SendAsync(stream, "400 Bad Request", "", ct); return; }
                    SampleStarts.Enqueue((Stopwatch.GetTimestamp(), cursor));
                    if (MalformedSamples) {
                        await stream.WriteAsync(Encoding.UTF8.GetBytes("--loopback-agent\r\nContent-Type: application/xml\r\n\r\n<MTConnectStreams"), ct);
                        return;
                    }
                    while (!ct.IsCancellationRequested) {
                        var content = "--loopback-agent\r\nContent-Type: application/xml\r\n\r\n" + Current(cursor + 1, 100 + request) + "\r\n";
                        // Deliberately fragment HTTP transport writes inside XML attributes.
                        var payload = Encoding.UTF8.GetBytes(content);
                        for (var i = 0; i < payload.Length; i += 17) await stream.WriteAsync(payload.AsMemory(i, Math.Min(17, payload.Length - i)), ct);
                        cursor++;
                        if (DropAfterValidPart) {
                            // Delimit one complete document, then disconnect inside
                            // the following XML part. The prior part must commit.
                            await stream.WriteAsync(Encoding.UTF8.GetBytes("--loopback-agent\r\nContent-Type: application/xml\r\n\r\n<MTConnectStreams"), ct);
                            return;
                        }
                        await Task.Delay(1000, ct);
                    }
                    return;
                }
                await SendAsync(stream, "404 Not Found", "", ct);
            } catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
            catch (IOException) { }
            catch (SocketException) { }
        }
    }
    private static async Task SendAsync(Stream stream, string status, string body, CancellationToken ct)
    {
        var payload = Encoding.UTF8.GetBytes(body);
        await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 {status}\r\nContent-Type: application/xml\r\nContent-Length: {payload.Length}\r\nConnection: close\r\n\r\n"), ct);
        await stream.WriteAsync(payload, ct);
    }
    private const string Probe = "<MTConnectDevices xmlns=\"urn:mtconnect.org:MTConnectDevices:2.8\"><Header instanceId=\"123\" version=\"SparkStudio synthetic agent\"/><Devices><Device id=\"d\" uuid=\"machine\" name=\"Synthetic CNC\"><DataItems><DataItem id=\"speed\" category=\"SAMPLE\" type=\"SPINDLE_SPEED\" units=\"REVOLUTION/MINUTE\"/></DataItems></Device></Devices></MTConnectDevices>";
    private static string Current(ulong next, int value) => $"<MTConnectStreams xmlns=\"urn:mtconnect.org:MTConnectStreams:2.8\"><Header instanceId=\"123\" firstSequence=\"1\" lastSequence=\"{next - 1}\" nextSequence=\"{next}\"/><Streams><DeviceStream uuid=\"machine\"><ComponentStream><Samples><SpindleSpeed dataItemId=\"speed\" timestamp=\"2026-10-01T00:00:00Z\" sequence=\"{next - 1}\">{value}</SpindleSpeed></Samples></ComponentStream></DeviceStream></Streams></MTConnectStreams>";
    public async ValueTask DisposeAsync()
    {
        stopping.Cancel(); listener.Stop();
        await accepting;
        Task[] pending; lock (clients) pending = clients.ToArray();
        await Task.WhenAll(pending).WaitAsync(TimeSpan.FromSeconds(2));
        stopping.Dispose();
    }
}
