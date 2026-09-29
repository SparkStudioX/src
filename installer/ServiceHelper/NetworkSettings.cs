using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparkStudio.Installer;

internal static partial class Program
{
    internal sealed record NetworkOptions(string Access, int ManagementPort, int HttpsPort, string? Hostname, string? Certificate, string? PrivateKey);

    internal static NetworkOptions ParseNetwork(Dictionary<string, string> options, int port)
    {
        var access = options.GetValueOrDefault("access", "local");
        if (access is not ("local" or "network" or "keep")) throw new ArgumentException("Access must be local, network or keep.");
        if (!int.TryParse(options.GetValueOrDefault("https-port", "5443"), out var tlsPort) || tlsPort is < 1024 or > 65535)
            throw new ArgumentException("HTTPS port must be between 1024 and 65535.");
        if (access == "network" && (port is < 1024 or > 65535 || tlsPort == port))
            throw new ArgumentException("Local and network HTTPS ports must differ and be between 1024 and 65535.");
        var hostname = options.GetValueOrDefault("hostname")?.Trim().ToLowerInvariant();
        if (access == "network" && !ValidHostname(hostname)) throw new ArgumentException("Network access needs a DNS hostname without scheme, port, path or wildcard.");
        return new(access, port, tlsPort, hostname, options.GetValueOrDefault("certificate"), options.GetValueOrDefault("private-key"));
    }

    private static bool ValidHostname(string? hostname) => hostname is { Length: > 0 and <= 253 }
        && Uri.CheckHostName(hostname) == UriHostNameType.Dns
        && hostname.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-')
        && hostname.Split('.').All(label => label.Length is > 0 and <= 63 && !label.StartsWith('-') && !label.EndsWith('-'));

    private static byte[] CertificateBytes(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) || path.StartsWith(@"\\") || path.Any(c => c < ' ' || c == '"'))
            throw new ArgumentException("Choose local absolute paths for the PEM certificate and private key.");
        RejectReparsePoints(Path.GetFullPath(path));
        if (!File.Exists(path) || new FileInfo(path).Length is <= 0 or > 65_536 || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new ArgumentException("Certificate and key must be ordinary local files, each at most 64 KiB.");
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var length = file.Length;
        if (length is <= 0 or > 65_536) throw new ArgumentException("Certificate and key files must each be at most 64 KiB.");
        var bytes = new byte[checked((int)length)]; file.ReadExactly(bytes); return bytes;
    }

    private static X509Certificate2 ValidateCertificate(NetworkOptions options)
    {
        var certBytes = CertificateBytes(options.Certificate); var keyBytes = CertificateBytes(options.PrivateKey);
        try
        {
            var certificate = X509Certificate2.CreateFromPem(System.Text.Encoding.UTF8.GetString(certBytes), System.Text.Encoding.UTF8.GetString(keyBytes));
            try
            {
                if (!certificate.HasPrivateKey || certificate.NotBefore.ToUniversalTime() > DateTime.UtcNow || certificate.NotAfter.ToUniversalTime() <= DateTime.UtcNow
                    || !certificate.MatchesHostname(options.Hostname!, allowWildcards: false, allowCommonName: false))
                    throw new ArgumentException("The certificate must be currently valid and have a matching key and an exact DNS subject alternative name for the public hostname.");
                if (certificate.Extensions.OfType<X509EnhancedKeyUsageExtension>().Any(usage => !usage.EnhancedKeyUsages.Cast<Oid>().Any(oid => oid.Value == "1.3.6.1.5.5.7.3.1")))
                    throw new ArgumentException("The certificate must allow TLS server authentication.");
                return certificate;
            }
            catch { certificate.Dispose(); throw; }
        }
        catch (CryptographicException) { throw new ArgumentException("The certificate and matching unencrypted private key must both use PEM format."); }
        finally { CryptographicOperations.ZeroMemory(keyBytes); }
    }

    private static NetworkOptions? ReadNetworkIntent(string directory)
    {
        var filename = Path.Combine(directory, "deployment.json");
        if (!File.Exists(filename)) return null;
        RejectReparsePoints(filename);
        if (new FileInfo(filename).Length > 65_536) throw new ArgumentException("The saved deployment file is too large.");
        var document = JsonNode.Parse(File.ReadAllText(filename))?.AsObject() ?? throw new ArgumentException("Invalid saved deployment settings.");
        if (document["version"]?.GetValue<int>() != 1) throw new ArgumentException("Unsupported saved deployment settings.");
        var settings = document["settings"]?.AsObject() ?? throw new ArgumentException("Invalid saved deployment settings.");
        if (settings["enabled"]?.GetValue<bool>() != true) return null;
        if (!Uri.TryCreate(settings["url"]?.GetValue<string>(), UriKind.Absolute, out var uri)) throw new ArgumentException("Invalid saved listener URL.");
        if (uri.Host != "0.0.0.0") return null;
        if (uri.Scheme != "https" || uri.Port is < 1024 or > 65535 || uri.UserInfo.Length != 0 || uri.AbsolutePath != "/" || uri.Query.Length != 0 || uri.Fragment.Length != 0)
            throw new ArgumentException("The saved network listener must use HTTPS.");
        var hostname = settings["publicHostname"]?.GetValue<string>();
        if (!ValidHostname(hostname)) throw new ArgumentException("The saved network listener has an invalid public hostname.");
        string CertificatePath(string name)
        {
            var value = settings[name]?.GetValue<string>();
            if (value is null || value.Length is < 1 or > 120 || !char.IsAsciiLetterOrDigit(value[0]) || !value.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-'))
                throw new ArgumentException("The saved certificate reference must be a plain filename.");
            return Path.Combine(directory, "certificates", "deployment", value);
        }
        return new("network", 0, uri.Port, hostname, CertificatePath("certificateFile"), CertificatePath("privateKeyFile"));
    }

    private static void ValidateNetwork(NetworkOptions options, Registration? registration)
    {
        if (options.ManagementPort is < 1024 or > 65535) throw new ArgumentException("Local management port must be between 1024 and 65535.");
        if (options.Access == "network") { using var certificate = ValidateCertificate(options); }
        if (options.Access == "keep")
        {
            if (registration?.CommandVersion != 2) throw new ArgumentException("Keep existing settings requires a managed-listener installation. Choose Local only or Network HTTPS for this upgrade.");
            if (ReadNetworkIntent(DataDirectory) is { } saved)
            {
                if (saved.HttpsPort == options.ManagementPort) throw new ArgumentException("Local management and saved HTTPS ports must differ.");
                using var certificate = ValidateCertificate(saved);
            }
        }
    }

    private static void ProbeNetworkPort(NetworkOptions options, ServiceInfo? service, Registration? registration)
    {
        var selected = options.Access == "network" ? options : options.Access == "keep" ? ReadNetworkIntent(DataDirectory) : null;
        if (selected is null) return;
        var previousPort = registration?.CommandVersion == 2 ? ReadNetworkIntent(DataDirectory)?.HttpsPort : null;
        if (service is not null && service.State != Native.Stopped && (registration?.Port == selected.HttpsPort || previousPort == selected.HttpsPort)) return;
        var listener = new TcpListener(IPAddress.Any, selected.HttpsPort); listener.Server.ExclusiveAddressUse = true;
        try { listener.Start(); }
        catch (SocketException) { throw new InvalidOperationException($"HTTPS port {selected.HttpsPort} is already in use. Choose another network port. No application was stopped."); }
        finally { listener.Stop(); }
    }

    private static DeploymentChange InstallDeployment(string directory, int managementPort, NetworkOptions options)
    {
        var filename = Path.Combine(directory, "deployment.json");
        RejectReparsePoints(filename);
        if (File.Exists(filename) && new FileInfo(filename).Length > 65_536) throw new ArgumentException("The saved deployment file is too large.");
        var previous = File.Exists(filename) ? File.ReadAllBytes(filename) : null;
        if (previous?.Length > 65_536) throw new ArgumentException("The saved deployment file is too large.");
        var change = new DeploymentChange(filename, previous);
        if (options.Access == "keep") return change;
        try
        {
            string? certificateName = null, keyName = null;
            if (options.Access == "network")
            {
                using var certificate = ValidateCertificate(options);
                var certificateDirectory = Path.Combine(directory, "certificates", "deployment");
                RejectReparsePoints(certificateDirectory); Directory.CreateDirectory(certificateDirectory);
                var suffix = Guid.NewGuid().ToString("N"); certificateName = $"gateway-{suffix}.pem"; keyName = $"gateway-{suffix}-key.pem";
                foreach (var pair in new[] { (options.Certificate, certificateName), (options.PrivateKey, keyName) })
                {
                    var destination = Path.Combine(certificateDirectory, pair.Item2); var bytes = CertificateBytes(pair.Item1);
                    try
                    {
                        // Create with an explicit private ACL before writing any key bytes.
                        var acl = new FileSecurity(); acl.SetAccessRuleProtection(true, false);
                        foreach (var sid in new[] { new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                            (SecurityIdentifier)new NTAccount(@"NT SERVICE\SparkStudio").Translate(typeof(SecurityIdentifier)) })
                            acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
                        using var output = new FileInfo(destination).Create(FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.WriteThrough, acl);
                        change.CreatedFiles.Add(destination); output.Write(bytes); output.Flush(true);
                    }
                    finally { CryptographicOperations.ZeroMemory(bytes); }
                }
            }
            var settings = new { enabled = true, url = options.Access == "network" ? $"https://0.0.0.0:{options.HttpsPort}" : $"http://127.0.0.1:{managementPort}",
                certificateFile = certificateName, privateKeyFile = keyName, publicHostname = options.Access == "network" ? options.Hostname : null };
            AtomicDeploymentWrite(filename, JsonSerializer.SerializeToUtf8Bytes(new { version = 1, revision = Guid.NewGuid().ToString("N"), settings }));
            return change;
        }
        catch { change.Rollback(); throw; }
    }

    private static void AtomicDeploymentWrite(string filename, byte[] bytes)
    {
        RejectReparsePoints(filename);
        var temporary = filename + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { output.Write(bytes); output.Flush(true); }
            File.Move(temporary, filename, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private sealed record DeploymentChange(string Filename, byte[]? Previous)
    {
        public List<string> CreatedFiles { get; } = [];
        public void Rollback()
        {
            if (Previous is null) { if (File.Exists(Filename)) File.Delete(Filename); }
            else AtomicDeploymentWrite(Filename, Previous);
            foreach (var file in CreatedFiles) if (File.Exists(file)) File.Delete(file);
        }
    }

    private static async Task VerifyNetworkReadinessAsync(NetworkOptions options, Func<uint> runningProcessId)
    {
        using var expected = ValidateCertificate(options);
        using var handler = new SocketsHttpHandler { AllowAutoRedirect = false, UseProxy = false, UseCookies = false };
        handler.ConnectCallback = async (_, cancellation) =>
        {
            var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            try { await socket.ConnectAsync(IPAddress.Loopback, options.HttpsPort, cancellation); return new NetworkStream(socket, ownsSocket: true); }
            catch { socket.Dispose(); throw; }
        };
        // Pin only this locally installed certificate. Name/date/key validation was already performed;
        // this local readiness check neither installs CA trust nor bypasses operator-browser validation.
        handler.SslOptions.RemoteCertificateValidationCallback = (_, certificate, _, errors) => certificate is not null
            && (errors & (SslPolicyErrors.RemoteCertificateNameMismatch | SslPolicyErrors.RemoteCertificateNotAvailable)) == 0
            && CryptographicOperations.FixedTimeEquals(certificate.GetCertHash(HashAlgorithmName.SHA256), expected.GetCertHash(HashAlgorithmName.SHA256));
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(5) };
        var pid = runningProcessId();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        ReadinessProbe result;
        try { result = await ProbeReadinessAsync(client, options.HttpsPort, pid, deadline.Token, new Uri($"https://{options.Hostname}:{options.HttpsPort}")); }
        catch (OperationCanceledException) when (deadline.IsCancellationRequested) { throw new InvalidOperationException("Network HTTPS readiness did not complete within 5 seconds."); }
        if (!result.Ready || runningProcessId() != pid) throw new InvalidOperationException("The configured network HTTPS listener did not pass certificate-pinned local readiness. Review the deployment settings and certificate. " + result.Message);
    }
    private static async Task NetworkSelfTestAsync()
    {
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio-network-check-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
        try
        {
            var checks = 0;
            void Assert(bool condition, string message) { if (!condition) throw new Exception(message); checks++; }
            void Reject(Action action) { try { action(); } catch (Exception error) when (error is ArgumentException or InvalidOperationException) { checks++; return; } throw new Exception("Expected network setting rejection."); }
            var fields = new Dictionary<string, string> { ["access"] = "network", ["hostname"] = "gateway.fixture.test", ["https-port"] = "5443" };
            var options = ParseNetwork(fields, 5090);
            Reject(() => ParseNetwork(fields, 5443));
            foreach (var hostname in new[] { "https://gateway.fixture.test", "0.0.0.0", "*.fixture.test", "gateway.fixture.test/path", "gateway..test", "-gateway.test" })
                Reject(() => ParseNetwork(new(fields) { ["hostname"] = hostname }, 5090));
            using var rsa = RSA.Create(2048);
            var request = new CertificateRequest("CN=SparkStudio synthetic network fixture", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            var san = new SubjectAlternativeNameBuilder(); san.AddDnsName("gateway.fixture.test"); request.CertificateExtensions.Add(san.Build());
            request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.1") }, false));
            using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddDays(1));
            var certFile = Path.Combine(directory, "certificate.pem"); var keyFile = Path.Combine(directory, "key.pem");
            File.WriteAllText(certFile, certificate.ExportCertificatePem()); File.WriteAllText(keyFile, rsa.ExportPkcs8PrivateKeyPem());
            options = options with { Certificate = certFile, PrivateKey = keyFile };
            using (var validated = ValidateCertificate(options)) Assert(validated.Thumbprint == certificate.Thumbprint, "Selected certificate validation failed.");
            Reject(() => ValidateCertificate(options with { Hostname = "different.fixture.test" }));
            using var otherKey = RSA.Create(2048); var wrongKey = Path.Combine(directory, "wrong-key.pem"); File.WriteAllText(wrongKey, otherKey.ExportPkcs8PrivateKeyPem());
            Reject(() => ValidateCertificate(options with { PrivateKey = wrongKey }));
            var settingsFile = Path.Combine(directory, "deployment.json");
            var local = options with { Access = "local" };
            var change = InstallDeployment(directory, 15090, local);
            Assert(JsonNode.Parse(File.ReadAllText(settingsFile))?["settings"]?["url"]?.GetValue<string>() == "http://127.0.0.1:15090", "Local intent was not installed.");
            change.Rollback(); Assert(!File.Exists(settingsFile), "New deployment rollback left a file.");
            File.WriteAllText(settingsFile, "retained configuration");
            var update = InstallDeployment(directory, 15091, local); update.Rollback();
            Assert(File.ReadAllText(settingsFile) == "retained configuration", "Rollback did not restore exact previous bytes.");
            var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
            var tlsPort = ((IPEndPoint)listener.LocalEndpoint).Port;
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var pfx = certificate.Export(X509ContentType.Pkcs12);
            using var serverCertificate = X509CertificateLoader.LoadPkcs12(pfx, null, X509KeyStorageFlags.DefaultKeySet); CryptographicOperations.ZeroMemory(pfx);
            var server = Task.Run(async () =>
            {
                using var connection = await listener.AcceptTcpClientAsync(deadline.Token);
                await using var stream = new SslStream(connection.GetStream());
                await stream.AuthenticateAsServerAsync(new SslServerAuthenticationOptions { ServerCertificate = serverCertificate }, deadline.Token);
                using var reader = new StreamReader(stream, leaveOpen: true);
                while (await reader.ReadLineAsync(deadline.Token) is { Length: > 0 }) { }
                var body = System.Text.Encoding.UTF8.GetBytes("{\"product\":\"SparkStudio\",\"status\":\"ready\",\"pythonAvailable\":true,\"processId\":1234}");
                var header = System.Text.Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(header, deadline.Token); await stream.WriteAsync(body, deadline.Token); await stream.FlushAsync(deadline.Token);
            }, deadline.Token);
            try { await VerifyNetworkReadinessAsync(options with { HttpsPort = tlsPort }, () => 1234); await server; checks++; }
            finally { listener.Stop(); }
            var stalledListener = new TcpListener(IPAddress.Loopback, 0); stalledListener.Start();
            var stalledPort = ((IPEndPoint)stalledListener.LocalEndpoint).Port;
            using var stalledDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var stalledServer = Task.Run(async () =>
            {
                using var connection = await stalledListener.AcceptTcpClientAsync(stalledDeadline.Token);
                await using var stream = new SslStream(connection.GetStream());
                await stream.AuthenticateAsServerAsync(new SslServerAuthenticationOptions { ServerCertificate = serverCertificate }, stalledDeadline.Token);
                using var reader = new StreamReader(stream, leaveOpen: true);
                while (await reader.ReadLineAsync(stalledDeadline.Token) is { Length: > 0 }) { }
                await stream.WriteAsync(System.Text.Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n"), stalledDeadline.Token);
                await stream.FlushAsync(stalledDeadline.Token); await Task.Delay(Timeout.Infinite, stalledDeadline.Token);
            }, stalledDeadline.Token);
            var watch = System.Diagnostics.Stopwatch.StartNew();
            try
            {
                try { await VerifyNetworkReadinessAsync(options with { HttpsPort = stalledPort }, () => 1234); throw new Exception("Stalled TLS response body was accepted."); }
                catch (InvalidOperationException error) when (error.Message.Contains("within 5 seconds")) { Assert(watch.Elapsed < TimeSpan.FromSeconds(8), "TLS readiness body deadline was not bounded."); }
            }
            finally { stalledDeadline.Cancel(); stalledListener.Stop(); try { await stalledServer; } catch (OperationCanceledException) { } }
            Console.WriteLine($"PASS {checks} network hostname/certificate/port, exact deployment rollback and pinned TLS readiness checks; no service, registration or trust store was changed.");
        }
        finally
        {
            // Every entry is generated directly by this fixture; there is no recursive deletion or external path input.
            foreach (var file in Directory.GetFiles(directory)) File.Delete(file);
            Directory.Delete(directory);
        }
    }

}
