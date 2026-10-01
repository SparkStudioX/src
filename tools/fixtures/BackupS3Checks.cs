using System.Collections.Concurrent;
using System.Net;
using System.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Xml.Linq;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using SparkStudio.Gateway;

internal static class BackupS3Checks
{
    internal const string AccessKey = "SYNTHETICACCESSKEY", Secret = "fixture-secret-access-key", Session = "fixture-session-token";
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static async Task Reject(Func<Task> action, string message)
    {
        try { await action(); }
        catch (Exception error) when (error is ArgumentException or IOException or InvalidOperationException or OperationCanceledException or TimeoutException)
        { Check(!error.ToString().Contains(Secret) && !error.ToString().Contains(Session) && !error.ToString().Contains(AccessKey), "S3 exception exposed credentials or raw response."); return; }
        throw new Exception("Expected rejection: " + message);
    }

    public static async Task RunAsync(string archive, byte[] payload, Guid owner, string old, string fresh, string foreign, string badDate)
    {
        await using var service = await FakeS3Service.StartAsync(owner);
        BackupDestination Target() => new("s3", "", TimeoutSeconds: 30, Bucket: "fixture-bucket", Region: "us-east-1",
            Prefix: "backups/gateway", AccessKeyId: AccessKey, SecretAccessKey: Secret, SessionToken: Session,
            Endpoint: service.HttpsOrigin, ForcePathStyle: true);
        const string prefix = "backups/gateway/";
        string Name() => BackupDestinations.CreateArchiveName(owner, DateTimeOffset.UtcNow, Guid.NewGuid());
        Task<BackupDeliveryResult> Deliver(string name, CancellationToken token = default, bool multipart = false)
            => BackupDestinations.DeliverS3FixtureAsync(Target(), archive, name, owner, 7, token, new LoopbackRewrite(service.Port), multipart);
        void Seed()
        {
            service.Reset();
            foreach (var name in new[] { old, fresh, foreign, badDate }) service.Files[prefix + name] = [1, 2, 3];
            foreach (var name in new[] { "nested/" + old, "../" + old, old + ".partial", "operator-notes.txt" }) service.Files[prefix + name] = [1, 2, 3];
            service.Files["other/" + old] = [1, 2, 3];
        }
        var normal = BackupDestinations.Validate(Target());
        Check(normal.Prefix == prefix && normal.Endpoint == service.HttpsOrigin, "S3 canonical prefix/endpoint differ.");
        BackupDestinations.Validate(Target() with { SecretAccessKey = null, SessionToken = null });
        Check(!Target().ToString().Contains(Secret) && !Target().ToString().Contains(Session) && !Target().ToString().Contains(AccessKey), "S3 DTO exposes credentials.");
        foreach (var invalid in new[] {
            Target() with { Bucket = "../bucket" }, Target() with { Bucket = "127.0.0.1" }, Target() with { Bucket = "UPPER" },
            Target() with { Bucket = "directory--x-s3" }, Target() with { Region = "us-east-1/other" }, Target() with { Region = "" },
            Target() with { Prefix = "../backups" }, Target() with { Prefix = "/backups" }, Target() with { Prefix = "backups//other" },
            Target() with { Prefix = new string('a', 700) }, Target() with { Prefix = new string('a', 701) + "/" },
            Target() with { AccessKeyId = "" }, Target() with { AccessKeyId = "bad\rkey" }, Target() with { SecretAccessKey = "bad\rsecret" },
            Target() with { SessionToken = new string('x', 4097) }, Target() with { Endpoint = "http://127.0.0.1" },
            Target() with { Endpoint = "https://user:password@localhost" }, Target() with { Endpoint = "https://localhost/path" },
            Target() with { Endpoint = "https://localhost?secret=x" }, Target() with { Endpoint = "https://localhost/#fragment" },
            Target() with { Address = "ftp://localhost/" }, Target() with { Username = "ignored" }, Target() with { Password = "ignored" },
            Target() with { TimeoutSeconds = 29 }, Target() with { TimeoutSeconds = 3601 } })
            await Reject(() => Task.Run(() => BackupDestinations.Validate(invalid)), "S3 properties");
        await Reject(() => BackupDestinations.DeliverAsync(Target() with { SecretAccessKey = null }, archive, Name(), owner), "missing saved secret");
        Check(service.Calls.IsEmpty, "Missing S3 secret sent network request.");
        Console.WriteLine("PASS S3 type-specific properties, HTTPS endpoint validation and redacted credential DTO");

        Seed(); var delivered = Name(); var result = await Deliver(delivered);
        Check(result.RemovedCount == 1 && result.RetentionWarning is null && service.Files[prefix + delivered].SequenceEqual(payload)
            && result.Sha256 == Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant(), "S3 delivered bytes or digest differ.");
        Check(!service.Files.ContainsKey(prefix + old) && service.Files.ContainsKey(prefix + fresh) && service.Files.ContainsKey(prefix + foreign)
            && service.Files.ContainsKey(prefix + badDate) && service.Files.ContainsKey(prefix + "nested/" + old)
            && service.Files.ContainsKey(prefix + "../" + old) && service.Files.ContainsKey("other/" + old), "S3 removed an unowned key.");
        Check(!service.Files.Keys.Any(key => key.StartsWith(prefix + ".sparkstudio-", StringComparison.Ordinal)), "S3 staging key remained after success.");
        var calls = service.Calls.ToArray(); var stagingGet = Array.FindIndex(calls, call => call.StartsWith("GET " + prefix + ".", StringComparison.Ordinal));
        var finalPut = Array.FindIndex(calls, call => call == "PUT " + prefix + delivered); var finalGet = Array.FindIndex(calls, call => call == "GET " + prefix + delivered);
        var oldDelete = Array.FindIndex(calls, call => call == "DELETE " + prefix + old);
        Check(stagingGet > 0 && stagingGet < finalPut && finalPut < finalGet && finalGet < oldDelete, "S3 staging/final verification/retention ordering differs.");
        Check(service.SignaturesValidated > 0 && service.PayloadsValidated == 2 && service.ListPages > 2 && service.Prefixes.All(p => p == prefix + "sparkstudio-" + owner.ToString("N") + "-"), "S3 signed payload or owned pagination differs.");
        await Reject(() => Deliver(delivered), "existing final key");
        Check(service.Files[prefix + delivered].SequenceEqual(payload), "Collision overwrote S3 final object.");
        Console.WriteLine("PASS actual SDK SigV4/session signing, payload checksums, paginated listing and staging/final streamed readback");

        Seed(); service.CorruptStaging = true; delivered = Name(); await Reject(() => Deliver(delivered), "corrupt staging readback");
        Check(service.Files.ContainsKey(prefix + old) && !service.Files.ContainsKey(prefix + delivered) && !service.Calls.Contains("DELETE " + prefix + old), "Corrupt S3 staging pruned an old object or published final key.");
        Seed(); service.CorruptFinal = true; delivered = Name(); await Reject(() => Deliver(delivered), "corrupt final readback");
        Check(service.Files.ContainsKey(prefix + old) && !service.Files.ContainsKey(prefix + delivered), "Corrupt final S3 readback pruned old archive or retained failed key.");
        Seed(); service.RejectUpload = true; await Reject(() => Deliver(Name()), "S3 denied upload");
        Check(service.Files.ContainsKey(prefix + old) && !service.Calls.Any(call => call.StartsWith("DELETE ")), "S3 denied upload removed any key.");
        Seed(); service.ConflictFinal = true; delivered = Name(); await Reject(() => Deliver(delivered), "conditional final conflict");
        Check(service.Files[prefix + delivered].SequenceEqual(new byte[] { 9, 9, 9 }) && service.Files.ContainsKey(prefix + old), "S3 conditional failure removed or overwrote the conflicting object.");
        Console.WriteLine("PASS S3 corrupt readbacks, denied PUT and conditional conflicts preserve previous and foreign objects");

        Seed(); service.OversizedListing = true; await Reject(() => Deliver(Name()), "oversized S3 XML");
        Check(!service.Calls.Any(call => call.StartsWith("PUT ") || call.StartsWith("DELETE ")), "Oversized S3 listing started mutation.");
        Seed(); service.RepeatedCursor = true; await Reject(() => Deliver(Name()), "repeated cursor");
        Check(!service.Calls.Any(call => call.StartsWith("PUT ") || call.StartsWith("DELETE ")), "Repeated S3 cursor started mutation.");
        Seed(); service.StallReadback = true;
        using (var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(500)))
        {
            var watch = System.Diagnostics.Stopwatch.StartNew(); await Reject(() => Deliver(Name(), cancel.Token), "stalled S3 stream");
            Check(watch.Elapsed < TimeSpan.FromSeconds(5) && service.Files.ContainsKey(prefix + old), "S3 cancellation failed to interrupt readback or removed previous backup.");
        }
        Console.WriteLine("PASS bounded streamed S3 listing, repeated pagination rejection and cancellation during readback");

        Seed(); service.StallRetention = true; delivered = Name();
        using (var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(500)))
        {
            result = await Deliver(delivered, cancel.Token);
            Check(result.RetentionWarning is not null && service.Files[prefix + delivered].SequenceEqual(payload) && service.Files.ContainsKey(prefix + old), "S3 retention cancellation lost committed delivery.");
        }
        Seed(); service.ChangeBeforeDelete = true; delivered = Name(); result = await Deliver(delivered);
        Check(result.RetentionWarning is not null && result.RemovedCount == 0 && service.Files.ContainsKey(prefix + old)
            && service.Files.ContainsKey(prefix + delivered), "S3 conditional retention deleted an object replaced after listing.");
        Console.WriteLine("PASS S3 cancelled retention and changed-object preconditions preserve delivered outcome with warning");

        Seed(); delivered = Name(); result = await Deliver(delivered, multipart: true);
        Check(result.RemovedCount == 1 && result.RetentionWarning is null && service.Files[prefix + delivered].SequenceEqual(payload)
            && service.Uploads.IsEmpty && service.CompletedMultiparts == 2 && service.UploadedParts > 2,
            "S3 bounded multipart staging/final delivery differs.");
        Check(service.Calls.ToArray().Count(call => call.StartsWith("MULTIPART_COMPLETE ", StringComparison.Ordinal)) == 2,
            "S3 multipart publication missed conditional completion.");
        Seed(); service.RejectPart = true; await Reject(() => Deliver(Name(), multipart: true), "denied S3 multipart part");
        Check(service.Uploads.IsEmpty && service.AbortedMultiparts == 1 && service.Files.ContainsKey(prefix + old)
            && !service.Calls.Contains("DELETE " + prefix + old), "Failed S3 multipart part was not aborted or removed old backup.");
        Seed(); service.ConflictFinal = true; delivered = Name(); await Reject(() => Deliver(delivered, multipart: true), "multipart final conflict");
        Check(service.Uploads.IsEmpty && service.AbortedMultiparts == 1 && service.Files[prefix + delivered].SequenceEqual(new byte[] { 9, 9, 9 })
            && service.Files.ContainsKey(prefix + old), "Conflicting S3 multipart completion overwrote/deleted foreign final key.");
        Seed(); service.EmbeddedCompleteError = true; await Reject(() => Deliver(Name(), multipart: true), "multipart HTTP200 embedded error");
        Check(service.Uploads.IsEmpty && service.AbortedMultiparts == 1 && service.Files.ContainsKey(prefix + old), "S3 HTTP200 multipart error was committed or not aborted.");
        Seed(); service.StallPart = true;
        using (var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(500)))
        {
            await Reject(() => Deliver(Name(), cancel.Token, true), "stalled multipart part");
            var deadline = DateTimeOffset.UtcNow.AddSeconds(5);
            while (!service.Uploads.IsEmpty && DateTimeOffset.UtcNow < deadline) await Task.Delay(20);
            Check(service.Uploads.IsEmpty && service.AbortedMultiparts == 1 && service.Files.ContainsKey(prefix + old), "Cancelled multipart part was not aborted or removed old backup.");
        }
        Console.WriteLine("PASS bounded multipart streams, conditional completion, embedded errors and owned-upload abort on failure/cancellation");

        await using var tls = await FakeS3Service.StartAsync(owner, true);
        await Reject(() => BackupDestinations.DeliverAsync(Target() with { Endpoint = tls.HttpsOrigin }, archive, Name(), owner), "untrusted S3 TLS");
        Check(tls.Calls.IsEmpty && tls.SignaturesValidated == 0, "S3 sent credentials to an untrusted TLS service.");
        Console.WriteLine("PASS S3 strict TLS rejects untrusted loopback certificate before HTTP credentials");
    }

    private sealed class LoopbackRewrite(int port) : DelegatingHandler(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false })
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri is null || request.RequestUri.Scheme != "https" || request.RequestUri.Host != "127.0.0.1" || request.RequestUri.Port != port)
                throw new IOException("Fixture attempted a non-owned network request.");
            request.RequestUri = new UriBuilder(request.RequestUri) { Scheme = "http", Port = port }.Uri;
            return base.SendAsync(request, cancellationToken);
        }
    }

    private sealed class FakeS3Service(WebApplication app, X509Certificate2? certificate) : IAsyncDisposable
    {
        public ConcurrentDictionary<string, byte[]> Files { get; } = new(StringComparer.Ordinal);
        public ConcurrentDictionary<string, MultipartUpload> Uploads { get; } = new(StringComparer.Ordinal);
        private ConcurrentDictionary<string, string> ObjectETags { get; } = new(StringComparer.Ordinal);
        public ConcurrentQueue<string> Calls { get; } = new();
        public ConcurrentQueue<string> Prefixes { get; } = new();
        public bool CorruptStaging, CorruptFinal, RejectUpload, ConflictFinal, OversizedListing, RepeatedCursor, StallReadback, StallRetention, ChangeBeforeDelete, RejectPart, EmbeddedCompleteError, StallPart;
        public int SignaturesValidated, PayloadsValidated, ListPages, FinalReadbacks, UploadedParts, CompletedMultiparts, AbortedMultiparts;
        public sealed record MultipartUpload(string Key, SortedDictionary<int, byte[]> Parts);
        public int Port => new Uri(app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single()).Port;
        public string HttpsOrigin => "https://127.0.0.1:" + Port;
        public static async Task<FakeS3Service> StartAsync(Guid owner, bool tls = false)
        {
            X509Certificate2? certificate = null;
            if (tls)
            {
                using var rsa = RSA.Create(2048); var request = new CertificateRequest("CN=untrusted-s3-fixture", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
                using var issued = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
                certificate = X509CertificateLoader.LoadPkcs12(issued.Export(X509ContentType.Pfx), null, X509KeyStorageFlags.EphemeralKeySet);
            }
            var builder = WebApplication.CreateSlimBuilder(); builder.Logging.ClearProviders();
            builder.WebHost.UseKestrel(options => options.Listen(IPAddress.Loopback, 0, listen => { if (tls) listen.UseHttps(certificate!); }));
            var app = builder.Build(); var fixture = new FakeS3Service(app, certificate);
            app.Run(fixture.Handle); await app.StartAsync(); return fixture;
        }
        public void Reset()
        {
            Files.Clear(); Calls.Clear(); Prefixes.Clear(); Uploads.Clear(); ObjectETags.Clear();
            CorruptStaging = CorruptFinal = RejectUpload = ConflictFinal = OversizedListing = RepeatedCursor = StallReadback = StallRetention = ChangeBeforeDelete = RejectPart = EmbeddedCompleteError = StallPart = false;
            SignaturesValidated = PayloadsValidated = ListPages = FinalReadbacks = UploadedParts = CompletedMultiparts = AbortedMultiparts = 0;
        }
        private static string ETag(byte[] bytes) => "\"" + Convert.ToHexString(MD5.HashData(bytes)).ToLowerInvariant() + "\"";
        private string ETagFor(string key, byte[] bytes) => ObjectETags.TryGetValue(key, out var tag) ? tag : ETag(bytes);
        private async Task Handle(HttpContext context)
        {
            byte[] body; using (var bytes = new MemoryStream()) { await context.Request.Body.CopyToAsync(bytes, context.RequestAborted); body = bytes.ToArray(); }
            CheckSignature(context, body);
            Interlocked.Increment(ref SignaturesValidated);
            if (context.Request.Query["list-type"] == "2")
            {
                Calls.Enqueue("LIST"); Interlocked.Increment(ref ListPages); var prefix = context.Request.Query["prefix"].ToString(); Prefixes.Enqueue(prefix);
                if (StallRetention && Volatile.Read(ref FinalReadbacks) > 0) { await Task.Delay(Timeout.Infinite, context.RequestAborted); return; }
                if (OversizedListing) { await Xml(context, "<ListBucketResult>" + new string('x', 1024 * 1024 + 1) + "</ListBucketResult>"); return; }
                // Return unrelated keys deliberately: the client must check every result itself.
                var all = Files.OrderBy(item => item.Key, StringComparer.Ordinal).ToArray();
                var start = int.TryParse(context.Request.Query["continuation-token"], out var cursor) ? cursor : 0;
                var page = all.Skip(start).Take(2).ToArray(); var more = start + page.Length < all.Length;
                var content = string.Join("", page.Select(item => $"<Contents><Key>{SecurityElement.Escape(item.Key)}</Key><ETag>{SecurityElement.Escape(ETagFor(item.Key, item.Value))}</ETag><Size>{item.Value.Length}</Size></Contents>"));
                var next = RepeatedCursor ? "1" : (start + page.Length).ToString(System.Globalization.CultureInfo.InvariantCulture);
                await Xml(context, $"<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>fixture-bucket</Name><Prefix>{SecurityElement.Escape(prefix)}</Prefix><KeyCount>{page.Length}</KeyCount><MaxKeys>2</MaxKeys><IsTruncated>{(more || RepeatedCursor ? "true" : "false")}</IsTruncated>{(more || RepeatedCursor ? "<NextContinuationToken>" + next + "</NextContinuationToken>" : "")}{content}</ListBucketResult>"); return;
            }
            var path = context.Request.Path.Value!; Check(path.StartsWith("/fixture-bucket/", StringComparison.Ordinal), "SDK fixture bucket path differs.");
            var key = path["/fixture-bucket/".Length..];
            var staging = key.Split('/').Last().StartsWith('.');
            if (context.Request.Method == "POST" && context.Request.Query.ContainsKey("uploads"))
            {
                Calls.Enqueue("MULTIPART_START " + key); var id = Guid.NewGuid().ToString("N"); Uploads[id] = new(key, []);
                await Xml(context, $"<InitiateMultipartUploadResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Bucket>fixture-bucket</Bucket><Key>{key}</Key><UploadId>{id}</UploadId></InitiateMultipartUploadResult>"); return;
            }
            var uploadId = context.Request.Query["uploadId"].ToString();
            if (uploadId.Length > 0)
            {
                Check(Uploads.TryGetValue(uploadId, out var upload) && upload.Key == key, "Fixture multipart operation has invalid owned upload ID/key.");
                if (context.Request.Method == "PUT")
                {
                    Calls.Enqueue("PART " + key);
                    if (StallPart) { await Task.Delay(Timeout.Infinite, context.RequestAborted); return; }
                    if (RejectPart) { context.Response.StatusCode = 403; await Error(context, "AccessDenied"); return; }
                    Check(int.TryParse(context.Request.Query["partNumber"], out var part) && part is >= 1 and <= 10000, "Fixture multipart part number invalid.");
                    upload!.Parts[part] = body; Interlocked.Increment(ref UploadedParts); context.Response.Headers.ETag = ETag(body); return;
                }
                if (context.Request.Method == "DELETE")
                { Calls.Enqueue("MULTIPART_ABORT " + key); Uploads.TryRemove(uploadId, out _); Interlocked.Increment(ref AbortedMultiparts); context.Response.StatusCode = 204; return; }
                Check(context.Request.Method == "POST" && context.Request.Headers.IfNoneMatch == "*", "SDK multipart completion lacks nonoverwrite condition.");
                Calls.Enqueue("MULTIPART_COMPLETE " + key);
                if (EmbeddedCompleteError) { await Error(context, "InternalError"); return; }
                var manifest = XDocument.Parse(Encoding.UTF8.GetString(body));
                var parts = manifest.Root!.Elements().Select(part => (Number: int.Parse(part.Elements().Single(item => item.Name.LocalName == "PartNumber").Value),
                    Tag: part.Elements().Single(item => item.Name.LocalName == "ETag").Value)).ToArray();
                Check(parts.Length == upload!.Parts.Count && parts.All(part => part.Tag == ETag(upload.Parts[part.Number])), "SDK multipart part manifest differs.");
                using var combined = new MemoryStream(); foreach (var part in parts) combined.Write(upload.Parts[part.Number]);
                var content = combined.ToArray();
                if (!staging && ConflictFinal) Files.TryAdd(key, [9, 9, 9]);
                if (!Files.TryAdd(key, content)) { context.Response.StatusCode = 412; await Error(context, "PreconditionFailed"); return; }
                var tag = "\"" + Convert.ToHexString(MD5.HashData(parts.SelectMany(part => MD5.HashData(upload.Parts[part.Number])).ToArray())).ToLowerInvariant() + "-" + parts.Length + "\"";
                ObjectETags[key] = tag; Uploads.TryRemove(uploadId, out _); Interlocked.Increment(ref CompletedMultiparts);
                await Xml(context, $"<CompleteMultipartUploadResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Location>{HttpsOrigin}/fixture-bucket/{key}</Location><Bucket>fixture-bucket</Bucket><Key>{key}</Key><ETag>{SecurityElement.Escape(tag)}</ETag></CompleteMultipartUploadResult>"); return;
            }
            Calls.Enqueue(context.Request.Method + " " + key);
            switch (context.Request.Method)
            {
                case "PUT":
                    Check(context.Request.Headers.IfNoneMatch == "*", "SDK PUT lacks conditional nonoverwrite header.");
                    Check(context.Request.Headers["x-amz-checksum-sha256"] == Convert.ToBase64String(SHA256.HashData(body)), "S3 payload checksum differs.");
                    Interlocked.Increment(ref PayloadsValidated);
                    if (RejectUpload) { context.Response.StatusCode = 403; await Error(context, "AccessDenied"); return; }
                    if (!staging && ConflictFinal) Files.TryAdd(key, [9, 9, 9]);
                    if (!Files.TryAdd(key, body)) { context.Response.StatusCode = 412; await Error(context, "PreconditionFailed"); return; }
                    context.Response.Headers.ETag = ETag(body); context.Response.StatusCode = 200; return;
                case "GET":
                    if (!Files.TryGetValue(key, out var file)) { context.Response.StatusCode = 404; await Error(context, "NoSuchKey"); return; }
                    Check(context.Request.Headers.IfMatch == ETagFor(key, file), "SDK GET lacks uploaded generation guard.");
                    var content = file.ToArray(); if (staging ? CorruptStaging : CorruptFinal) content[^1] ^= 0xff;
                    context.Response.Headers.ETag = ETagFor(key, file); context.Response.ContentLength = content.Length;
                    context.Response.ContentType = "application/octet-stream";
                    if (StallReadback) { await context.Response.StartAsync(context.RequestAborted); await context.Response.Body.FlushAsync(context.RequestAborted); await Task.Delay(Timeout.Infinite, context.RequestAborted); return; }
                    await context.Response.Body.WriteAsync(content, context.RequestAborted);
                    if (!staging) Interlocked.Increment(ref FinalReadbacks); return;
                case "DELETE":
                    Check(context.Request.Headers.IfMatch.Count == 1 && context.Request.Headers.IfMatch.ToString().Length > 0, "SDK DELETE lacks listed/written generation guard.");
                    if (!staging && ChangeBeforeDelete) Files[key] = [8, 8, 8];
                    if (Files.TryGetValue(key, out var existing) && context.Request.Headers.IfMatch != ETagFor(key, existing))
                    { context.Response.StatusCode = 412; await Error(context, "PreconditionFailed"); return; }
                    Files.TryRemove(key, out _); ObjectETags.TryRemove(key, out _); context.Response.StatusCode = 204; return;
                default: throw new Exception("Unexpected S3 method.");
            }
        }
        private static async Task Error(HttpContext context, string code)
            => await Xml(context, $"<Error><Code>{code}</Code><Message>{Secret} {Session} {AccessKey}</Message></Error>");
        private static async Task Xml(HttpContext context, string value)
        { var bytes = Encoding.UTF8.GetBytes(value); context.Response.ContentType = "application/xml"; context.Response.ContentLength = bytes.Length; await context.Response.Body.WriteAsync(bytes, context.RequestAborted); }
        private static void CheckSignature(HttpContext context, byte[] body)
        {
            var authorization = context.Request.Headers.Authorization.ToString();
            Check(authorization.StartsWith("AWS4-HMAC-SHA256 ", StringComparison.Ordinal), "SDK did not use SigV4.");
            var parts = authorization["AWS4-HMAC-SHA256 ".Length..].Split(',').Select(part => part.Trim().Split('=', 2)).ToDictionary(part => part[0], part => part[1]);
            var scope = parts["Credential"].Split('/');
            Check(scope.Length == 5 && scope[0] == AccessKey && scope[2] == "us-east-1" && scope[3] == "s3" && scope[4] == "aws4_request", "SDK signing credential scope differs.");
            Check(context.Request.Headers["x-amz-security-token"] == Session, "SDK session token absent.");
            var signed = parts["SignedHeaders"].Split(';');
            var headers = string.Join("", signed.Select(name => name + ":" + (name == "host" ? context.Request.Host.Value ?? "" : string.Join(',', context.Request.Headers[name].ToArray())).Trim() + "\n"));
            var query = string.Join('&', context.Request.Query.SelectMany(pair => pair.Value.Select(value => (Key: Uri.EscapeDataString(pair.Key), Value: Uri.EscapeDataString(value ?? ""))))
                .OrderBy(pair => pair.Key, StringComparer.Ordinal).ThenBy(pair => pair.Value, StringComparer.Ordinal).Select(pair => pair.Key + "=" + pair.Value));
            var payloadHash = context.Request.Headers["x-amz-content-sha256"].ToString();
            Check(payloadHash == Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant(), "SDK unsigned or mismatched payload hash.");
            var canonical = context.Request.Method + "\n" + context.Request.Path.Value + "\n" + query + "\n" + headers + "\n" + parts["SignedHeaders"] + "\n" + payloadHash;
            var signing = "AWS4-HMAC-SHA256\n" + context.Request.Headers["x-amz-date"] + "\n" + string.Join('/', scope.Skip(1)) + "\n" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
            static byte[] Hmac(byte[] key, string text) => HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(text));
            var signingKey = Hmac(Hmac(Hmac(Hmac(Encoding.UTF8.GetBytes("AWS4" + Secret), scope[1]), scope[2]), "s3"), "aws4_request");
            Check(parts["Signature"] == Convert.ToHexString(Hmac(signingKey, signing)).ToLowerInvariant(), "SDK SigV4 signature differs from independent fixture verification.");
        }
        public async ValueTask DisposeAsync() { await app.StopAsync(); await app.DisposeAsync(); certificate?.Dispose(); }
    }
}
