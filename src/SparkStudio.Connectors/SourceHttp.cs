using System.Net;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

namespace SparkStudio.Connectors;

public static class SourceHttp
{
    public static HttpClient CreateClient(ConnectionDefinition connection, string? dataDirectory = null)
    {
        var settings = connection.Source ?? throw new ArgumentException("Source settings are required.");
        var handler = new SocketsHttpHandler {
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate | DecompressionMethods.Brotli,
            ConnectTimeout = TimeSpan.FromMilliseconds(settings.EffectiveLimits.ConnectTimeoutMs),
            MaxConnectionsPerServer = 4, PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            AllowAutoRedirect = false
        };
        ConfigureTls(handler.SslOptions, settings.Tls, dataDirectory);
        return new(handler) { Timeout = Timeout.InfiniteTimeSpan };
    }

    public static void ApplyAuthentication(HttpRequestMessage request, ConnectionDefinition connection)
    {
        var auth = connection.Source?.Authentication;
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (auth is null || auth.Mode == "none") return;
        switch (auth.Mode)
        {
            case "basic": request.Headers.Authorization = new("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{auth.Username}:{auth.Password}"))); break;
            case "bearer": request.Headers.Authorization = new("Bearer", auth.Token); break;
            case "api-key": request.Headers.Add(auth.Header, auth.Token); break;
            default: throw new ArgumentException("Unsupported source authentication mode.");
        }
    }

    public static async Task<byte[]> ReadBoundedAsync(HttpResponseMessage response, int maximumBytes, CancellationToken cancellation)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(maximumBytes, 1);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellation);
        using var output = new MemoryStream(Math.Min(maximumBytes, 65536));
        var buffer = new byte[Math.Min(maximumBytes + 1, 16384)];
        while (true)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, maximumBytes - checked((int)output.Length) + 1)), cancellation);
            if (read == 0) break;
            if (output.Length + read > maximumBytes) throw new SourceLimitException("Decoded source document exceeds its byte limit.");
            await output.WriteAsync(buffer.AsMemory(0, read), cancellation);
        }
        return output.ToArray();
    }

    // Observe the decoded response stream rather than Content-Length or a second
    // body read. This also covers injected clients, partial documents and SSE.
    public static void ObserveResponse(HttpResponseMessage response, SourceTransportTelemetry telemetry)
    {
        telemetry.RecordActivity();
        if (response.Content is ObservedContent observed && ReferenceEquals(observed.Telemetry, telemetry)) return;
        response.Content = new ObservedContent(response.Content, telemetry);
    }

    private sealed class ObservedContent : HttpContent
    {
        private readonly HttpContent content;
        public SourceTransportTelemetry Telemetry { get; }
        public ObservedContent(HttpContent content, SourceTransportTelemetry telemetry)
        {
            this.content = content; Telemetry = telemetry;
            foreach (var header in content.Headers) Headers.TryAddWithoutValidation(header.Key, header.Value);
        }
        protected override bool TryComputeLength(out long length)
        {
            length = content.Headers.ContentLength ?? -1;
            return length >= 0;
        }
        protected override async Task<Stream> CreateContentReadStreamAsync() =>
            new ObservedStream(await content.ReadAsStreamAsync(), Telemetry);
        protected override async Task<Stream> CreateContentReadStreamAsync(CancellationToken cancellation) =>
            new ObservedStream(await content.ReadAsStreamAsync(cancellation), Telemetry);
        protected override async Task SerializeToStreamAsync(Stream output, TransportContext? context)
        {
            await using var input = await CreateContentReadStreamAsync();
            await input.CopyToAsync(output);
        }
        protected override void Dispose(bool disposing)
        {
            try { base.Dispose(disposing); }
            finally { if (disposing) content.Dispose(); }
        }
    }
    private sealed class ObservedStream(Stream input, SourceTransportTelemetry telemetry) : Stream
    {
        private int disposed;
        public override bool CanRead => input.CanRead;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count)
        { var read = input.Read(buffer, offset, count); telemetry.RecordInput(read); return read; }
        public override int Read(Span<byte> buffer)
        { var read = input.Read(buffer); telemetry.RecordInput(read); return read; }
        public override int ReadByte()
        { var value = input.ReadByte(); if (value >= 0) telemetry.RecordInput(1); return value; }
        public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellation)
        { var read = await input.ReadAsync(buffer.AsMemory(offset, count), cancellation); telemetry.RecordInput(read); return read; }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellation = default)
        { var read = await input.ReadAsync(buffer, cancellation); telemetry.RecordInput(read); return read; }
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing)
        {
            try { if (disposing && Interlocked.Exchange(ref disposed, 1) == 0) input.Dispose(); }
            finally { base.Dispose(disposing); }
        }
        public override async ValueTask DisposeAsync()
        {
            try { if (Interlocked.Exchange(ref disposed, 1) == 0) await input.DisposeAsync(); }
            finally { await base.DisposeAsync(); }
            GC.SuppressFinalize(this);
        }
    }

    public static void ConfigureTls(SslClientAuthenticationOptions ssl, SourceTlsSettings? tls, string? dataDirectory)
    {
        if (tls is null) return;
        if (tls.ClientCertificateReference is { Length: > 0 } client)
        {
            var path = CertificatePath(client, dataDirectory);
            var certificate = tls.ClientKeyReference is { Length: > 0 } key
                ? X509Certificate2.CreateFromPemFile(path, CertificatePath(key, dataDirectory))
                : X509CertificateLoader.LoadPkcs12FromFile(path, null, X509KeyStorageFlags.EphemeralKeySet);
            if (!certificate.HasPrivateKey) throw new ArgumentException("The source client certificate requires a private key.");
            ssl.ClientCertificates = new X509CertificateCollection { certificate };
        }
        if (tls.CaCertificateReference is { Length: > 0 } caReference)
        {
            var ca = X509Certificate2.CreateFromPemFile(CertificatePath(caReference, dataDirectory));
            ssl.CertificateChainPolicy = new X509ChainPolicy {
                TrustMode = X509ChainTrustMode.CustomRootTrust,
                RevocationMode = X509RevocationMode.Online
            };
            ssl.CertificateChainPolicy.CustomTrustStore.Add(ca);
        }
        if (tls.ServerCertificateSha256 is { Length: > 0 } pin)
            ssl.RemoteCertificateValidationCallback = (_, certificate, _, errors) => {
                if (certificate is null || (errors & SslPolicyErrors.RemoteCertificateNameMismatch) != 0) return false;
                using var peer = new X509Certificate2(certificate);
                return DateTime.UtcNow >= peer.NotBefore.ToUniversalTime() && DateTime.UtcNow <= peer.NotAfter.ToUniversalTime()
                    && CryptographicOperations.FixedTimeEquals(Convert.FromHexString(pin), peer.GetCertHash(HashAlgorithmName.SHA256));
            };
    }

    public static string CertificatePath(string reference, string? dataDirectory)
    {
        if (dataDirectory is null || !SourceConfiguration.CertificateReferenceValid(reference))
            throw new ArgumentException("Choose a gateway certificate reference.");
        var directory = Path.GetFullPath(Path.Combine(dataDirectory, "certificates"));
        var path = Path.GetFullPath(Path.Combine(directory, reference));
        if (!path.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Invalid certificate reference.");
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0 || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
            throw new ArgumentException("Certificate references cannot use filesystem links.");
        return path;
    }
}

/// <summary>Bounded connection counters. Rates use monotonic elapsed time; wall time is receipt provenance.</summary>
public sealed class SourceTransportTelemetry
{
    private readonly long started = Stopwatch.GetTimestamp();
    private long bytes, lastActivityUtcTicks;
    public void RecordActivity() => Interlocked.Exchange(ref lastActivityUtcTicks, DateTimeOffset.UtcNow.UtcTicks);
    public void RecordInput(int count)
    {
        if (count <= 0) return;
        Interlocked.Add(ref bytes, count); RecordActivity();
    }
    public IReadOnlyDictionary<string, object?> Snapshot()
    {
        var total = Interlocked.Read(ref bytes); var activity = Interlocked.Read(ref lastActivityUtcTicks);
        return new Dictionary<string, object?> {
            ["inputBytes"] = total,
            ["inputBytesPerSecond"] = total / Math.Max(.001, Stopwatch.GetElapsedTime(started).TotalSeconds),
            ["inputRateBasis"] = "mean since connection owner creation",
            ["lastTransportActivityAt"] = activity == 0 ? null : new DateTimeOffset(activity, TimeSpan.Zero)
        };
    }
}

public sealed class SourceLimitException(string message) : IOException(message);

public static class SourceBrowse
{
    private static readonly byte[] Key = RandomNumberGenerator.GetBytes(32);
    private sealed record Cursor(int Offset, int PageSize, string? Parent, long Generation, long Revision, long Expires, string Digest);
    public static SourceBrowsePage Page(IReadOnlyList<SourceBrowseEntry> entries, SourceBrowseRequest request, bool truncated = false)
    {
        if (request.PageSize is < 1 or > 500) throw new ArgumentException("Browse page size must be 1–500.");
        var digest = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(entries.Select(entry =>
            new { entry.Address, entry.Name, entry.IsVariable, entry.DataType, entry.Selector, entry.Parent, entry.MappingId, entry.SuggestedPath }))));
        var offset = 0;
        if (request.ContinuationToken is { Length: > 0 } token)
        {
            if (token.Length > 4096) throw new ArgumentException("Invalid browse continuation token.");
            try {
                var pieces = token.Split('.');
                if (pieces.Length != 2) throw new FormatException();
                var payload = Convert.FromBase64String(pieces[0]);
                if (!CryptographicOperations.FixedTimeEquals(HMACSHA256.HashData(Key, payload), Convert.FromBase64String(pieces[1]))) throw new FormatException();
                var cursor = JsonSerializer.Deserialize<Cursor>(payload) ?? throw new FormatException();
                if (cursor.PageSize != request.PageSize || cursor.Parent != request.Parent || cursor.Generation != request.Generation
                    || cursor.Revision != request.BindingRevision || cursor.Expires < DateTimeOffset.UtcNow.ToUnixTimeSeconds() || cursor.Digest != digest) throw new FormatException();
                offset = cursor.Offset;
            } catch (Exception error) when (error is FormatException or JsonException) { throw new ArgumentException("Browse catalog changed or token expired. Restart browsing."); }
        }
        if (offset < 0 || offset > entries.Count) throw new ArgumentException("Invalid browse continuation offset.");
        var page = entries.Skip(offset).Take(request.PageSize).ToArray();
        string? next = null;
        if (offset + page.Length < entries.Count)
        {
            var payload = JsonSerializer.SerializeToUtf8Bytes(new Cursor(offset + page.Length, request.PageSize, request.Parent,
                request.Generation, request.BindingRevision, DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeSeconds(), digest));
            next = Convert.ToBase64String(payload) + "." + Convert.ToBase64String(HMACSHA256.HashData(Key, payload));
        }
        return new(page, next, truncated, request.Generation, request.BindingRevision);
    }
}
