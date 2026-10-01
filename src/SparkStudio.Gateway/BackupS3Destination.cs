using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Amazon;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;

namespace SparkStudio.Gateway;

public static partial class BackupDestinations
{
    private static BackupDestination ValidateS3(BackupDestination destination)
    {
        if (destination.TimeoutSeconds is < 30 or > 3600) throw new ArgumentException("Backup destination timeout must be 30–3600 seconds.");
        if (!string.IsNullOrEmpty(destination.Address) || !string.IsNullOrEmpty(destination.Username) || !string.IsNullOrEmpty(destination.Password)
            || !string.IsNullOrEmpty(destination.Domain) || destination.AllowInsecureFtp)
            throw new ArgumentException("S3 uses bucket, region, prefix and AWS credentials; SMB and FTP properties must be empty.");
        var bucket = destination.Bucket ?? "";
        if (!Regex.IsMatch(bucket, @"\A[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\z", RegexOptions.CultureInvariant)
            || bucket.Contains("..") || bucket.Contains(".-") || bucket.Contains("-.") || IPAddress.TryParse(bucket, out _)
            || bucket.StartsWith("xn--", StringComparison.Ordinal) || bucket.StartsWith("sthree-", StringComparison.Ordinal)
            || bucket.StartsWith("amzn-s3-demo-", StringComparison.Ordinal)
            || new[] { "-s3alias", "--ol-s3", ".mrap", "--x-s3", "--table-s3" }.Any(bucket.EndsWith))
            throw new ArgumentException("S3 needs an ordinary general purpose bucket name of 3–63 lowercase letters, digits, periods or hyphens.");
        if (destination.Region is null || !Regex.IsMatch(destination.Region, @"\A[a-z0-9][a-z0-9-]{0,62}\z", RegexOptions.CultureInvariant))
            throw new ArgumentException("S3 needs a bounded region name, such as us-east-1.");
        if (destination.AccessKeyId is null || !Regex.IsMatch(destination.AccessKeyId, @"\A[A-Za-z0-9_-]{1,256}\z", RegexOptions.CultureInvariant))
            throw new ArgumentException("S3 needs an explicit access key ID.");
        foreach (var secret in new[] { destination.SecretAccessKey, destination.SessionToken })
            if (secret is { Length: > 4096 } || secret?.Any(char.IsControl) == true || secret is { Length: 0 })
                throw new ArgumentException("S3 secrets must be nonempty bounded values without control characters.");
        var prefix = destination.Prefix ?? "";
        if (prefix.Length > 700 || prefix.StartsWith('/') || prefix.Contains('\\')
            || prefix.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '/' or '.' or '_' or '-'))
            || prefix.TrimEnd('/').Split('/').Any(part => part is "." or "..") || prefix.Contains("//"))
            throw new ArgumentException("S3 prefix must be bounded ordinary key segments using letters, digits, periods, underscores, hyphens and slashes.");
        if (prefix.Length > 0) prefix = prefix.TrimEnd('/') + "/";
        if (prefix.Length > 700) throw new ArgumentException("S3 prefix including its trailing slash must be at most 700 characters.");
        string? endpoint = null;
        if (!string.IsNullOrEmpty(destination.Endpoint))
        {
            if (destination.Endpoint.Length > 1000 || destination.Endpoint.Any(char.IsControl) || destination.Endpoint.Contains('\\')
                || !Uri.TryCreate(destination.Endpoint, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.Host.Length == 0
                || uri.Port is < 1 or > 65535 || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0 || uri.AbsolutePath != "/")
                throw new ArgumentException("An S3-compatible endpoint must be an HTTPS origin without a path, embedded credentials, query or fragment.");
            endpoint = uri.GetLeftPart(UriPartial.Authority);
        }
        return destination with { Prefix = prefix, Endpoint = endpoint };
    }

    // This seam is only for an owned loopback fixture. Production always uses strict TLS.
    internal static Task<BackupDeliveryResult> DeliverS3FixtureAsync(BackupDestination destination, string archive,
        string name, Guid owner, int days, CancellationToken token, HttpMessageHandler handler, bool multipart = false)
    {
        if (destination.Kind != "s3" || !Uri.TryCreate(destination.Endpoint, UriKind.Absolute, out var endpoint)
            || !endpoint.IsLoopback || !destination.ForcePathStyle) throw new ArgumentException("S3 fixtures require an owned loopback path-style endpoint.");
        return DeliverWithS3HandlerAsync(destination, archive, name, owner, days, token, handler, multipart);
    }

    private static async Task<BackupDeliveryResult> DeliverS3Async(BackupDestination destination, string archive,
        string name, Guid owner, int days, DeliveryProgress progress, CancellationToken token, HttpMessageHandler? fixtureHandler, bool fixtureMultipart)
    {
        if (string.IsNullOrEmpty(destination.SecretAccessKey)) throw new ArgumentException("S3 delivery requires a saved secret access key.");
        using var httpFactory = new BoundedS3ClientFactory(destination.Endpoint, destination.Bucket!, fixtureHandler);
        var config = new AmazonS3Config
        {
            AuthenticationRegion = destination.Region, ForcePathStyle = destination.ForcePathStyle, MaxErrorRetry = 0,
            AllowAutoRedirect = false, IgnoreConfiguredEndpointUrls = true, UseHttp = false, DisableLogging = true, LogMetrics = false, LogResponse = false,
            Timeout = TimeSpan.FromSeconds(destination.TimeoutSeconds),
            RequestChecksumCalculation = RequestChecksumCalculation.WHEN_REQUIRED,
            ResponseChecksumValidation = ResponseChecksumValidation.WHEN_REQUIRED,
            HttpClientFactory = httpFactory
        };
        if (destination.Endpoint is null) config.RegionEndpoint = RegionEndpoint.GetBySystemName(destination.Region!);
        else config.ServiceURL = destination.Endpoint;
        AWSCredentials credentials = destination.SessionToken is null
            ? new BasicAWSCredentials(destination.AccessKeyId, destination.SecretAccessKey)
            : new SessionAWSCredentials(destination.AccessKeyId, destination.SecretAccessKey, destination.SessionToken);
        using var client = new AmazonS3Client(credentials, config);
        using var local = RecoveryFileSystem.OpenSource(Path.GetFullPath(archive));
        var length = local.Length;
        if (length is < 80 or > MaximumArchiveBytes) throw new InvalidDataException("Only bounded encrypted gateway archives can be delivered.");
        var magic = new byte[8]; await local.ReadExactlyAsync(magic, token);
        if (!magic.AsSpan().SequenceEqual("SPARKBAK"u8)) throw new InvalidDataException("Only encrypted .sparkbak archives can be delivered.");
        local.Position = 0; var digest = await SHA256.HashDataAsync(local, token); local.Position = 0;
        var prefix = destination.Prefix!; var finalKey = prefix + name;
        var names = await ListS3OwnedAsync(client, destination.Bucket!, prefix, owner, token);
        if (names.Any(item => item.Key == finalKey)) throw new IOException("The archive already exists at the destination.");
        var temporaryKey = prefix + "." + name + "." + Guid.NewGuid().ToString("N") + ".partial";
        S3WrittenObject? temporary = null, final = null;
        try
        {
            temporary = await PutS3Async(client, destination.Bucket!, temporaryKey, local, length, digest, token, fixtureMultipart);
            await VerifyS3Async(client, destination.Bucket!, temporaryKey, temporary, length, digest, token);
            token.ThrowIfCancellationRequested(); local.Position = 0;
            // General purpose S3 has no rename. A conditional upload publishes the final key only after the
            // staging readback passed; a second readback also verifies the published generation.
            final = await PutS3Async(client, destination.Bucket!, finalKey, local, length, digest, token, fixtureMultipart);
            await VerifyS3Async(client, destination.Bucket!, finalKey, final, length, digest, token);
            progress.Committed = new(name, length, Convert.ToHexString(digest).ToLowerInvariant(), 0, null);
        }
        finally
        {
            // Only exact keys successfully created by this run may be cleaned up. An unknown
            // timed-out PUT can leave an orphan; it must never lead to deleting an existing key.
            if (!token.IsCancellationRequested)
            {
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                if (temporary is not null) try { await DeleteS3WrittenAsync(client, destination.Bucket!, temporaryKey, temporary, cleanup.Token); } catch { }
                if (final is not null && progress.Committed is null) try { await DeleteS3WrittenAsync(client, destination.Bucket!, finalKey, final, cleanup.Token); } catch { }
            }
        }
        try
        {
            names = await ListS3OwnedAsync(client, destination.Bucket!, prefix, owner, token);
            var cutoff = DateTimeOffset.UtcNow.AddDays(-days);
            foreach (var item in names)
            {
                token.ThrowIfCancellationRequested();
                if (item.Key == finalKey || !TryOwnedArchive(item.Key[prefix.Length..], owner, out var created) || created >= cutoff) continue;
                // The listed ETag guards against deleting a key replaced since the listing.
                await client.DeleteObjectAsync(new DeleteObjectRequest { BucketName = destination.Bucket, Key = item.Key, IfMatch = item.ETag }, token);
                progress.Removed++;
            }
            return progress.Committed! with { RemovedCount = progress.Removed };
        }
        catch (Exception error) when (error is IOException or AmazonClientException or AmazonServiceException or HttpRequestException or OperationCanceledException or InvalidOperationException or System.Xml.XmlException)
        { return progress.Committed! with { RemovedCount = progress.Removed, RetentionWarning = RetentionIncomplete }; }
    }

    private sealed record S3WrittenObject(string ETag, string? VersionId);
    private static async Task<S3WrittenObject> PutS3Async(AmazonS3Client client, string bucket, string key,
        Stream local, long length, byte[] digest, CancellationToken token, bool fixtureMultipart)
    {
        token.ThrowIfCancellationRequested();
        // Multipart avoids S3's single-PUT size limit and keeps larger archive uploads bounded.
        if (fixtureMultipart || length > 128L * 1024 * 1024)
            return await PutS3MultipartAsync(client, bucket, key, local, length, token, fixtureMultipart ? 128 : 64 * 1024 * 1024);
        var request = new PutObjectRequest
        {
            BucketName = bucket, Key = key, InputStream = local, AutoCloseStream = false, AutoResetStreamPosition = false,
            IfNoneMatch = "*", UseChunkEncoding = false, DisablePayloadSigning = false, ContentType = "application/octet-stream",
            ChecksumSHA256 = Convert.ToBase64String(digest)
        };
        request.Headers.ContentLength = length;
        var result = await client.PutObjectAsync(request, token);
        if (!SafeS3EntityTag(result.ETag) || result.VersionId is { Length: > 1024 } || result.VersionId?.Any(char.IsControl) == true)
            throw new IOException("S3 upload did not return a bounded object identity.");
        return new(result.ETag, result.VersionId);
    }

    private static async Task<S3WrittenObject> PutS3MultipartAsync(AmazonS3Client client, string bucket, string key,
        Stream local, long length, CancellationToken token, int partBytes)
    {
        var initiated = await client.InitiateMultipartUploadAsync(new InitiateMultipartUploadRequest
        { BucketName = bucket, Key = key, ContentType = "application/octet-stream" }, token);
        var id = initiated.UploadId;
        if (string.IsNullOrEmpty(id) || id.Length > 4096 || id.Any(char.IsControl)) throw new IOException("S3 multipart upload omitted a bounded upload identity.");
        var completed = false;
        try
        {
            var parts = new List<PartETag>();
            for (long offset = 0; offset < length; offset += partBytes)
            {
                token.ThrowIfCancellationRequested(); var size = Math.Min(partBytes, length - offset);
                using var slice = new S3PartStream(local, offset, size);
                var part = await client.UploadPartAsync(new UploadPartRequest
                {
                    BucketName = bucket, Key = key, UploadId = id, PartNumber = parts.Count + 1,
                    InputStream = slice, PartSize = size, IsLastPart = offset + size == length,
                    UseChunkEncoding = false, DisablePayloadSigning = false
                }, token);
                if (!SafeS3EntityTag(part.ETag)) throw new IOException("S3 multipart upload omitted a bounded part identity.");
                parts.Add(new PartETag(parts.Count + 1, part.ETag));
            }
            token.ThrowIfCancellationRequested();
            var result = await client.CompleteMultipartUploadAsync(new CompleteMultipartUploadRequest
            { BucketName = bucket, Key = key, UploadId = id, PartETags = parts, IfNoneMatch = "*" }, token);
            if (!SafeS3EntityTag(result.ETag) || result.VersionId is { Length: > 1024 } || result.VersionId?.Any(char.IsControl) == true)
                throw new IOException("S3 multipart upload omitted a bounded object identity.");
            completed = true; return new(result.ETag, result.VersionId);
        }
        finally
        {
            if (!completed)
            {
                using var abort = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                try { await client.AbortMultipartUploadAsync(new AbortMultipartUploadRequest { BucketName = bucket, Key = key, UploadId = id }, abort.Token); }
                catch { /* Only this run's exact upload ID is eligible for best-effort abort. */ }
            }
        }
    }

    private sealed class S3PartStream(Stream inner, long offset, long size) : Stream
    {
        private long position;
        private int ReadCount(int count) => (int)Math.Min(count, size - position);
        private int Count(int count) { position += count; return count; }
        public override int Read(byte[] buffer, int start, int count) { inner.Position = offset + position; return Count(inner.Read(buffer, start, ReadCount(count))); }
        public override int Read(Span<byte> buffer) { inner.Position = offset + position; return Count(inner.Read(buffer[..ReadCount(buffer.Length)])); }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        { inner.Position = offset + position; return Count(await inner.ReadAsync(buffer[..ReadCount(buffer.Length)], cancellationToken)); }
        public override async Task<int> ReadAsync(byte[] buffer, int start, int count, CancellationToken cancellationToken)
        { inner.Position = offset + position; return Count(await inner.ReadAsync(buffer, start, ReadCount(count), cancellationToken)); }
        public override long Seek(long value, SeekOrigin origin) { Position = origin switch { SeekOrigin.Begin => value, SeekOrigin.Current => position + value, SeekOrigin.End => size + value, _ => throw new ArgumentException("Invalid stream origin.") }; return position; }
        public override long Position { get => position; set { if (value < 0 || value > size) throw new IOException("S3 part stream seek exceeds its bounds."); position = value; } }
        public override long Length => size; public override bool CanSeek => true; public override bool CanRead => true; public override bool CanWrite => false;
        public override void Flush() { } public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int start, int count) => throw new NotSupportedException();
        // The already validated archive handle remains open across every part and both uploads.
    }

    private static async Task VerifyS3Async(AmazonS3Client client, string bucket, string key, S3WrittenObject written,
        long length, byte[] digest, CancellationToken token)
    {
        using var result = await client.GetObjectAsync(new GetObjectRequest
        { BucketName = bucket, Key = key, EtagToMatch = written.ETag, VersionId = written.VersionId }, token);
        if (result.ContentLength != length || result.ETag != written.ETag) throw new IOException("S3 verification object identity or length changed.");
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[1024 * 1024]; long total = 0; int count;
        while ((count = await result.ResponseStream.ReadAsync(buffer, token)) != 0)
        {
            total += count; if (total > length) throw new IOException("S3 verification length changed.");
            hash.AppendData(buffer, 0, count);
        }
        if (total != length || !CryptographicOperations.FixedTimeEquals(hash.GetHashAndReset(), digest)) throw new IOException("S3 readback verification failed.");
    }

    private static Task DeleteS3WrittenAsync(AmazonS3Client client, string bucket, string key, S3WrittenObject written, CancellationToken token)
        => client.DeleteObjectAsync(new DeleteObjectRequest { BucketName = bucket, Key = key, IfMatch = written.ETag, VersionId = written.VersionId }, token);

    private static bool SafeS3EntityTag(string? value) => value is { Length: > 0 and <= 1024 } && !value.Any(char.IsControl);
    private static async Task<List<S3Object>> ListS3OwnedAsync(AmazonS3Client client, string bucket, string prefix, Guid owner, CancellationToken token)
    {
        var ownedPrefix = prefix + "sparkstudio-" + owner.ToString("N") + "-";
        var result = new List<S3Object>(); var keys = new HashSet<string>(StringComparer.Ordinal); var cursors = new HashSet<string>(StringComparer.Ordinal);
        string? cursor = null; var entries = 0; var bytes = 0;
        for (var page = 0; page < 100; page++)
        {
            token.ThrowIfCancellationRequested();
            var listing = await client.ListObjectsV2Async(new ListObjectsV2Request
            { BucketName = bucket, Prefix = ownedPrefix, MaxKeys = 1000, ContinuationToken = cursor }, token);
            foreach (var item in listing.S3Objects ?? [])
            {
                if (++entries > MaximumEntries || item.Key is null || item.Key.Length > 1024 || (bytes += Encoding.UTF8.GetByteCount(item.Key)) > MaximumListingBytes)
                    throw new IOException("S3 listing exceeds its bounded entry or byte limit.");
                // A compatible endpoint must never be trusted to respect the requested prefix.
                if (!item.Key.StartsWith(ownedPrefix, StringComparison.Ordinal) || !TryOwnedArchive(item.Key[prefix.Length..], owner, out _)) continue;
                if (!SafeS3EntityTag(item.ETag)) throw new IOException("S3 listing omitted a bounded object identity.");
                if (keys.Add(item.Key)) result.Add(item);
            }
            if (listing.IsTruncated != true) return result;
            cursor = listing.NextContinuationToken;
            if (string.IsNullOrEmpty(cursor) || cursor.Length > 4096 || cursor.Any(char.IsControl) || !cursors.Add(cursor))
                throw new IOException("S3 listing has invalid or repeated pagination.");
        }
        throw new IOException("S3 listing exceeds its page limit.");
    }

    private sealed class BoundedS3ClientFactory(string? endpoint, string bucket, HttpMessageHandler? fixtureHandler) : Amazon.Runtime.HttpClientFactory, IDisposable
    {
        private HttpClient? client;
        public override HttpClient CreateHttpClient(IClientConfig config)
            => client ??= new(new BoundedS3ResponseHandler(endpoint, bucket) { InnerHandler = fixtureHandler ?? new HttpClientHandler { AllowAutoRedirect = false } })
            { Timeout = TimeSpan.FromSeconds(3600) };
        public override bool UseSDKHttpClientCaching(IClientConfig config) => false;
        public override bool DisposeHttpClientsAfterUse(IClientConfig config) => false;
        public void Dispose() => client?.Dispose();
    }

    private sealed class BoundedS3ResponseHandler(string? endpoint, string bucket) : DelegatingHandler
    {
        // Covers both initial and retention listings, including XML overhead and ignored keys.
        private long listingBytes;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var uri = request.RequestUri;
            if (uri is null || uri.Scheme != "https" || uri.UserInfo.Length != 0) throw new IOException("S3 requires HTTPS for every request.");
            if (endpoint is not null)
            {
                var configured = new Uri(endpoint);
                if (uri.Port != configured.Port || !(uri.Host.Equals(configured.Host, StringComparison.OrdinalIgnoreCase)
                    || uri.Host.Equals(bucket + "." + configured.Host, StringComparison.OrdinalIgnoreCase)))
                    throw new IOException("S3-compatible endpoint redirect is outside its configured host.");
            }
            var response = await base.SendAsync(request, cancellationToken);
            var listing = request.Method == HttpMethod.Get && request.RequestUri!.Query.Contains("list-type=2", StringComparison.Ordinal);
            if (listing || request.Method != HttpMethod.Get || !response.IsSuccessStatusCode)
            {
                var limit = response.IsSuccessStatusCode ? MaximumListingBytes : 64 * 1024;
                if (response.Content.Headers.ContentLength > limit) { response.Dispose(); throw new IOException("S3 response exceeds its byte limit."); }
                response.Content = new BoundedS3Content(response.Content, limit, listing ? count =>
                { if (Interlocked.Add(ref listingBytes, count) > MaximumListingBytes * 2L) throw new IOException("S3 listings exceed their byte limit."); } : null);
            }
            return response;
        }
    }

    private sealed class BoundedS3Content : HttpContent
    {
        private readonly HttpContent inner; private readonly long limit; private readonly Action<int>? count;
        public BoundedS3Content(HttpContent inner, long limit, Action<int>? count)
        { this.inner = inner; this.limit = limit; this.count = count; foreach (var header in inner.Headers) Headers.TryAddWithoutValidation(header.Key, header.Value); }
        protected override bool TryComputeLength(out long length) { length = inner.Headers.ContentLength ?? -1; return length >= 0; }
        protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context)
        { await using var source = await CreateContentReadStreamAsync(); await source.CopyToAsync(stream); }
        protected override async Task<Stream> CreateContentReadStreamAsync() => new BoundedS3Stream(await inner.ReadAsStreamAsync(), limit, count);
        protected override async Task<Stream> CreateContentReadStreamAsync(CancellationToken cancellationToken) => new BoundedS3Stream(await inner.ReadAsStreamAsync(cancellationToken), limit, count);
        protected override void Dispose(bool disposing) { if (disposing) inner.Dispose(); base.Dispose(disposing); }
    }

    private sealed class BoundedS3Stream(Stream inner, long limit, Action<int>? count) : Stream
    {
        private long total;
        private int Count(int read) { if ((total += read) > limit) throw new IOException("S3 response exceeds its byte limit."); count?.Invoke(read); return read; }
        public override int Read(byte[] buffer, int offset, int length) => Count(inner.Read(buffer, offset, length));
        public override int Read(Span<byte> buffer) => Count(inner.Read(buffer));
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => Count(await inner.ReadAsync(buffer, cancellationToken));
        public override async Task<int> ReadAsync(byte[] buffer, int offset, int length, CancellationToken cancellationToken) => Count(await inner.ReadAsync(buffer, offset, length, cancellationToken));
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException(); public override long Position { get => total; set => throw new NotSupportedException(); }
        public override void Flush() { } public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int length) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (disposing) inner.Dispose(); base.Dispose(disposing); }
        public override async ValueTask DisposeAsync() { await inner.DisposeAsync(); GC.SuppressFinalize(this); }
    }
}
