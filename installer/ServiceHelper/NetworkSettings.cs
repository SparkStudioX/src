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
    internal sealed record NetworkOptions(string Access, int ManagementPort, int HttpsPort, string? Hostname, string? Certificate, string? PrivateKey, string CertificateMode = "provided");

    internal static NetworkOptions ParseNetwork(Dictionary<string, string> options, int port)
    {
        var access = options.GetValueOrDefault("access", "local");
        if (access is not ("local" or "network" or "keep")) throw new ArgumentException("Access must be local, network or keep.");
        if (!int.TryParse(options.GetValueOrDefault("https-port", "5443"), out var tlsPort) || tlsPort is < 1024 or > 65535)
            throw new ArgumentException("HTTPS port must be between 1024 and 65535.");
        if (access == "network" && (port is < 1024 or > 65535 || tlsPort == port))
            throw new ArgumentException("Local and network HTTPS ports must differ and be between 1024 and 65535.");
        var hostname = options.GetValueOrDefault("hostname")?.Trim().ToLowerInvariant();
        if (access == "network" && !ValidHostname(hostname)) throw new ArgumentException("Network access needs a DNS name or a specific IPv4 address, without scheme, port, path or wildcard. IPv6 and unspecified, multicast or reserved IPv4 addresses are not supported.");
        var certificateMode = options.GetValueOrDefault("certificate-mode", "provided");
        if (certificateMode is not ("provided" or "self-signed")) throw new ArgumentException("Certificate mode must be provided or self-signed.");
        if (access == "network" && certificateMode == "self-signed" && (options.ContainsKey("certificate") || options.ContainsKey("private-key")))
            throw new ArgumentException("Self-signed mode generates its own certificate and key; do not supply certificate or private-key paths.");
        return new(access, port, tlsPort, hostname, options.GetValueOrDefault("certificate"), options.GetValueOrDefault("private-key"), certificateMode);
    }

    private static bool ValidHostname(string? hostname)
    {
        if (hostname is not { Length: > 0 and <= 253 }) return false;
        if (IPAddress.TryParse(hostname, out var address))
        {
            // The installed network listener is IPv4. Reject alternate numeric spellings
            // and non-unicast targets; a selected IP is a certificate identity, never a bind wildcard.
            return address.AddressFamily == AddressFamily.InterNetwork && address.ToString() == hostname
                && address.GetAddressBytes()[0] is > 0 and < 224;
        }
        return !hostname.All(c => char.IsAsciiDigit(c) || c == '.')
            && Uri.CheckHostName(hostname) == UriHostNameType.Dns
            && hostname.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-')
            && hostname.Split('.').All(label => label.Length is > 0 and <= 63 && !label.StartsWith('-') && !label.EndsWith('-'));
    }

    private static byte[] CertificateBytes(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal) || path.Any(c => c < ' ' || c == '"'))
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
                    throw new ArgumentException("The certificate must be currently valid, have a matching key, and include the selected DNS name as a DNS subject alternative name or the selected IPv4 address as an IP Address subject alternative name. A common name or DNS entry containing an IP is insufficient.");
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
        if (!ValidHostname(hostname)) throw new ArgumentException("The saved network listener has an invalid DNS name or IPv4 address.");
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
        // Preflight and prepare never generate keys, certificates or trust-store entries.
        if (options.Access == "network" && options.CertificateMode == "provided") { using var certificate = ValidateCertificate(options); }
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

    private static X509Certificate2 CreateSelfSignedCertificate(string hostname)
    {
        if (!ValidHostname(hostname)) throw new ArgumentException("A self-signed certificate needs a valid DNS name or specific IPv4 address.");
        using var rsa = RSA.Create(3072);
        var request = new CertificateRequest("CN=SparkStudio gateway", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var san = new SubjectAlternativeNameBuilder();
        if (IPAddress.TryParse(hostname, out var address)) san.AddIpAddress(address); else san.AddDnsName(hostname);
        request.CertificateExtensions.Add(san.Build());
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.1") }, false));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        var now = DateTimeOffset.UtcNow;
        return request.CreateSelfSigned(now.AddMinutes(-5), now.AddDays(365));
    }

    private static byte[] ExportPrivateKeyPem(X509Certificate2 certificate)
    {
        using var rsa = certificate.GetRSAPrivateKey() ?? throw new InvalidOperationException("The generated certificate has no RSA private key.");
        var der = rsa.ExportPkcs8PrivateKey();
        char[]? pem = null;
        try { pem = PemEncoding.Write("PRIVATE KEY", der); return System.Text.Encoding.UTF8.GetBytes(pem); }
        finally { CryptographicOperations.ZeroMemory(der); pem?.AsSpan().Clear(); }
    }

    private static FileSecurity CertificateFileSecurity(SecurityIdentifier serviceIdentity)
    {
        var acl = new FileSecurity(); acl.SetAccessRuleProtection(true, false);
        foreach (var sid in new[] { new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), serviceIdentity })
            acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
        return acl;
    }

    private static void WriteCertificateArtifact(string path, byte[] bytes, DeploymentChange change, SecurityIdentifier serviceIdentity, bool replace = false)
    {
        RejectReparsePoints(path);
        var existed = File.Exists(path);
        if (existed && !replace) throw new IOException("The certificate destination already exists.");
        if (existed) change.ReplacedFiles.Add(path, new(CertificateBytes(path), new FileInfo(path).GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Access))); else change.CreatedFiles.Add(path);
        // The temporary file receives the private ACL before any bytes are written.
        // Public exports deliberately stay in the protected gateway directory; an
        // administrator copies only the .cer file to the operator computers.
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var output = new FileInfo(temporary).Create(FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.WriteThrough, CertificateFileSecurity(serviceIdentity)))
            { output.Write(bytes); output.Flush(true); }
            File.Move(temporary, path, replace);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static string TrustInstructions(NetworkOptions options, X509Certificate2 certificate)
    {
        var fingerprint = Convert.ToHexString(certificate.GetCertHash(HashAlgorithmName.SHA256));
        var formattedFingerprint = string.Join(":", Enumerable.Range(0, fingerprint.Length / 2).Select(index => fingerprint.Substring(index * 2, 2)));
        var selfSigned = options.CertificateMode == "self-signed";
        return $"""
            SparkStudio HTTPS certificate

            Operator address: https://{options.Hostname}:{options.HttpsPort}
            Certificate mode: {(selfSigned ? "Generated self-signed server certificate" : "Provided server certificate")}
            Valid from (UTC): {certificate.NotBefore.ToUniversalTime():O}
            Valid until (UTC): {certificate.NotAfter.ToUniversalTime():O}
            SHA-256 fingerprint: {formattedFingerprint}

            gateway-public.cer contains ONLY the public server certificate, never its private key.
            Keep every -key.pem file on the gateway. Do not send it to operator computers.
            {(selfSigned ? "Browsers will show an untrusted-certificate warning until this certificate is explicitly trusted on each operator computer." : "Operator computers must trust the issuing CA. Obtain the CA certificates through your administrator's approved channel; this export is the server certificate only.")}

            {(selfSigned ? "For Windows operator computers: an administrator should transfer gateway-public.cer through a trusted channel. Compare its SHA-256 fingerprint with the value above using certutil -hashfile gateway-public.cer SHA256. Double-click the .cer file, select Install Certificate, choose Current User, then Place all certificates in the following store, and select Trusted Root Certification Authorities. Verify the certificate before approving Windows' trust prompt. Restart the browser and open exactly the operator address above. Other browser or device certificate stores may require their own import. Do not bypass certificate warnings." : "For a CA-issued certificate, install the approved root/intermediate CA certificates if needed; do not add this server certificate to a trusted-root store just to suppress warnings.")}

            Trust is not installed automatically. Firewall rules are not changed.
            Use a fixed IP or DHCP reservation for IP-based HTTPS.
            {(selfSigned ? "The generated certificate expires after one year. Before it expires, run setup again with Network HTTPS and Generate a self-signed certificate (or provide a CA-issued replacement), then distribute and trust the replacement. Keep existing settings preserves this certificate and its expiration; it does not renew it. After replacement, remove the old SparkStudio certificate from operator trust stores when no longer needed." : "Renew and deploy a replacement certificate before expiration using Network HTTPS setup or the gateway deployment settings.")}
            """;
    }

    private static DeploymentChange InstallDeployment(string directory, int managementPort, NetworkOptions options, SecurityIdentifier? certificateServiceIdentity = null)
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
                using var certificate = options.CertificateMode == "self-signed" ? CreateSelfSignedCertificate(options.Hostname!) : ValidateCertificate(options);
                var certificateDirectory = Path.Combine(directory, "certificates", "deployment");
                RejectReparsePoints(certificateDirectory);
                foreach (var folder in new[] { Path.Combine(directory, "certificates"), certificateDirectory })
                    if (!Directory.Exists(folder)) { Directory.CreateDirectory(folder); change.CreatedDirectories.Add(folder); }
                var serviceIdentity = certificateServiceIdentity ?? (SecurityIdentifier)new NTAccount(@"NT SERVICE\SparkStudio").Translate(typeof(SecurityIdentifier));
                var suffix = Guid.NewGuid().ToString("N"); certificateName = $"gateway-{suffix}.pem"; keyName = $"gateway-{suffix}-key.pem";
                foreach (var isKey in new[] { false, true })
                {
                    var destination = Path.Combine(certificateDirectory, isKey ? keyName : certificateName);
                    var bytes = options.CertificateMode == "self-signed"
                        ? isKey ? ExportPrivateKeyPem(certificate) : System.Text.Encoding.UTF8.GetBytes(certificate.ExportCertificatePem())
                        : CertificateBytes(isKey ? options.PrivateKey : options.Certificate);
                    try
                    {
                        WriteCertificateArtifact(destination, bytes, change, serviceIdentity);
                    }
                    finally { CryptographicOperations.ZeroMemory(bytes); }
                }
                // Read back the installed pair before saving its listener intent.
                using var installedCertificate = ValidateCertificate(options with { Certificate = Path.Combine(certificateDirectory, certificateName), PrivateKey = Path.Combine(certificateDirectory, keyName), CertificateMode = "provided" });
                WriteCertificateArtifact(Path.Combine(certificateDirectory, "gateway-public.cer"), installedCertificate.Export(X509ContentType.Cert), change, serviceIdentity, replace: true);
                WriteCertificateArtifact(Path.Combine(certificateDirectory, "gateway-trust.txt"), System.Text.Encoding.UTF8.GetBytes(TrustInstructions(options, installedCertificate)), change, serviceIdentity, replace: true);
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
        public sealed record ReplacedArtifact(byte[] Bytes, string AccessSddl);
        public List<string> CreatedFiles { get; } = [];
        public Dictionary<string, ReplacedArtifact> ReplacedFiles { get; } = new(StringComparer.OrdinalIgnoreCase);
        public List<string> CreatedDirectories { get; } = [];
        public void Rollback()
        {
            if (Previous is null) { if (File.Exists(Filename)) File.Delete(Filename); }
            else AtomicDeploymentWrite(Filename, Previous);
            foreach (var file in CreatedFiles) if (File.Exists(file)) File.Delete(file);
            foreach (var pair in ReplacedFiles)
            {
                File.WriteAllBytes(pair.Key, pair.Value.Bytes);
                var acl = new FileSecurity(); acl.SetSecurityDescriptorSddlForm(pair.Value.AccessSddl, AccessControlSections.Access);
                new FileInfo(pair.Key).SetAccessControl(acl);
            }
            foreach (var folder in CreatedDirectories.AsEnumerable().Reverse()) if (Directory.Exists(folder) && !Directory.EnumerateFileSystemEntries(folder).Any()) Directory.Delete(folder);
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
            void Assert(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); checks++; }
            void Reject(Action action) { try { action(); } catch (Exception error) when (error is ArgumentException or InvalidOperationException) { checks++; return; } throw new InvalidOperationException("Expected network setting rejection."); }
            async Task VerifyFixtureTlsAsync(NetworkOptions fixtureOptions, X509Certificate2 fixtureCertificate)
            {
                var pfx = fixtureCertificate.Export(X509ContentType.Pkcs12);
                using var serverCertificate = X509CertificateLoader.LoadPkcs12(pfx, null, X509KeyStorageFlags.DefaultKeySet); CryptographicOperations.ZeroMemory(pfx);
                var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
                var tlsPort = ((IPEndPoint)listener.LocalEndpoint).Port;
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                var server = Task.Run(async () =>
                {
                    using var connection = await listener.AcceptTcpClientAsync(deadline.Token);
                    await using var stream = new SslStream(connection.GetStream());
                    await stream.AuthenticateAsServerAsync(new SslServerAuthenticationOptions { ServerCertificate = serverCertificate }, deadline.Token);
                    using var reader = new StreamReader(stream, leaveOpen: true);
                    var hostSeen = false;
                    while (await reader.ReadLineAsync(deadline.Token) is { Length: > 0 } headerLine)
                        if (headerLine.Equals($"Host: {fixtureOptions.Hostname}:{tlsPort}", StringComparison.OrdinalIgnoreCase)) hostSeen = true;
                    if (!hostSeen) throw new InvalidOperationException("The readiness Host header did not preserve the selected DNS/IP identity.");
                    var body = System.Text.Encoding.UTF8.GetBytes("{\"product\":\"SparkStudio\",\"status\":\"ready\",\"pythonAvailable\":true,\"processId\":1234}");
                    var header = System.Text.Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
                    await stream.WriteAsync(header, deadline.Token); await stream.WriteAsync(body, deadline.Token); await stream.FlushAsync(deadline.Token);
                }, deadline.Token);
                try { await VerifyNetworkReadinessAsync(fixtureOptions with { HttpsPort = tlsPort }, () => 1234); await server; checks++; }
                finally { listener.Stop(); }
            }
            var fields = new Dictionary<string, string> { ["access"] = "network", ["hostname"] = "gateway.fixture.test", ["https-port"] = "5443" };
            var options = ParseNetwork(fields, 5090);
            Assert(options.CertificateMode == "provided", "The helper's existing provided-certificate default changed.");
            Reject(() => ParseNetwork(new(fields) { ["certificate-mode"] = "unknown" }, 5090));
            Reject(() => ParseNetwork(new(fields) { ["certificate-mode"] = "self-signed", ["certificate"] = "ignored.pem" }, 5090));
            Reject(() => ParseNetwork(new(fields) { ["certificate-mode"] = "self-signed", ["private-key"] = "ignored-key.pem" }, 5090));
            Reject(() => ParseOptions(["--action", "preflight", "--certificate-mode", "self-signed", "--certificate-mode", "provided"]));
            Assert(ParseOptions(["--action", "preflight", "--certificate-mode", "self-signed"])["certificate-mode"] == "self-signed", "The public CLI rejected the generation option.");
            var generatedOptions = ParseNetwork(new(fields) { ["certificate-mode"] = "self-signed" }, 5090);
            ValidateNetwork(generatedOptions, null);
            Assert(!Directory.EnumerateFileSystemEntries(directory).Any(), "Generated-certificate preflight wrote a file.");
            Reject(() => ValidateNetwork(options, null));
            Reject(() => ParseNetwork(fields, 5443));
            foreach (var hostname in new[] { "https://gateway.fixture.test", "0.0.0.0", "*.fixture.test", "gateway.fixture.test/path", "gateway..test", "-gateway.test",
                "0.1.2.3", "255.255.255.255", "224.0.0.1", "239.1.2.3", "240.0.0.1", "256.1.2.3", "192.168.1.999", "127.1", "2130706433", "0x7f000001",
                "192.168.001.1", "192.168.1.1:5443", "[::1]", "::1", "2001:db8::1", "::ffff:192.168.1.50" })
                Reject(() => ParseNetwork(new(fields) { ["hostname"] = hostname }, 5090));
            foreach (var hostname in new[] { "192.168.1.50", "10.20.30.40", "172.16.10.2", "169.254.10.2", "127.0.0.1", "192.0.2.10" })
                Assert(ParseNetwork(new(fields) { ["hostname"] = hostname }, 5090).Hostname == hostname, "A specific IPv4 identity was rejected or changed.");
            using var rsa = RSA.Create(2048);
            var request = new CertificateRequest("CN=SparkStudio synthetic network fixture", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            var san = new SubjectAlternativeNameBuilder(); san.AddDnsName("gateway.fixture.test"); san.AddIpAddress(IPAddress.Parse("192.0.2.10")); request.CertificateExtensions.Add(san.Build());
            request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.1") }, false));
            using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddDays(1));
            var certFile = Path.Combine(directory, "certificate.pem"); var keyFile = Path.Combine(directory, "key.pem");
            File.WriteAllText(certFile, certificate.ExportCertificatePem()); File.WriteAllText(keyFile, rsa.ExportPkcs8PrivateKeyPem());
            options = options with { Certificate = certFile, PrivateKey = keyFile };
            using (var validated = ValidateCertificate(options)) Assert(validated.Thumbprint == certificate.Thumbprint, "Selected certificate validation failed.");
            Reject(() => ValidateCertificate(options with { Hostname = "different.fixture.test" }));
            using (var validated = ValidateCertificate(options with { Hostname = "192.0.2.10" })) Assert(validated.Thumbprint == certificate.Thumbprint, "Exact IP SAN validation failed.");
            Reject(() => ValidateCertificate(options with { Hostname = "192.0.2.11" }));
            var dnsIpRequest = new CertificateRequest("CN=192.0.2.10", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            var dnsIpSan = new SubjectAlternativeNameBuilder(); dnsIpSan.AddDnsName("192.0.2.10"); dnsIpRequest.CertificateExtensions.Add(dnsIpSan.Build());
            using var dnsIpCertificate = dnsIpRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddDays(1));
            var dnsIpFile = Path.Combine(directory, "dns-ip.pem"); File.WriteAllText(dnsIpFile, dnsIpCertificate.ExportCertificatePem());
            Reject(() => ValidateCertificate(options with { Hostname = "192.0.2.10", Certificate = dnsIpFile }));
            var cnIpRequest = new CertificateRequest("CN=192.0.2.10", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            using var cnIpCertificate = cnIpRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddDays(1));
            var cnIpFile = Path.Combine(directory, "cn-ip.pem"); File.WriteAllText(cnIpFile, cnIpCertificate.ExportCertificatePem());
            Reject(() => ValidateCertificate(options with { Hostname = "192.0.2.10", Certificate = cnIpFile }));
            using var otherKey = RSA.Create(2048); var wrongKey = Path.Combine(directory, "wrong-key.pem"); File.WriteAllText(wrongKey, otherKey.ExportPkcs8PrivateKeyPem());
            Reject(() => ValidateCertificate(options with { PrivateKey = wrongKey }));
            var settingsFile = Path.Combine(directory, "deployment.json");

            // Exercise the same installation path with a disposable fixture SID in place
            // of the real service identity. No service, machine data or trust store is touched.
            var fixtureIdentity = WindowsIdentity.GetCurrent().User!;
            foreach (var identity in new[] { "gateway.fixture.test", "192.0.2.10" })
            {
                var generatedChange = InstallDeployment(directory, 5090, generatedOptions with { Hostname = identity }, fixtureIdentity);
                var installed = ReadNetworkIntent(directory) ?? throw new InvalidOperationException("Generated network settings were not saved.");
                using var generated = ValidateCertificate(installed);
                Assert(generated.HasPrivateKey && generated.MatchesHostname(identity, allowWildcards: false, allowCommonName: false), "Generated certificate identity/key did not persist.");
                Reject(() => ValidateCertificate(installed with { Hostname = identity == "192.0.2.10" ? "192.0.2.11" : "other.fixture.test" }));
                Assert(generated.NotBefore.ToUniversalTime() < DateTime.UtcNow && generated.NotAfter.ToUniversalTime() > DateTime.UtcNow.AddDays(364)
                    && generated.NotAfter.ToUniversalTime() <= DateTime.UtcNow.AddDays(365), "Generated validity or clock-skew allowance is incorrect.");
                using (var key = generated.GetRSAPublicKey()) Assert(key?.KeySize == 3072 && generated.SignatureAlgorithm.Value == "1.2.840.113549.1.1.11", "Generated key or signature strength is incorrect.");
                Assert(generated.Extensions.OfType<X509BasicConstraintsExtension>().Single().CertificateAuthority == false
                    && generated.Extensions.OfType<X509EnhancedKeyUsageExtension>().Single().EnhancedKeyUsages.Cast<Oid>().Single().Value == "1.3.6.1.5.5.7.3.1", "Generated certificate is not a non-CA server certificate.");
                var certificateDirectory = Path.Combine(directory, "certificates", "deployment");
                var publicFile = Path.Combine(certificateDirectory, "gateway-public.cer");
                var guideFile = Path.Combine(certificateDirectory, "gateway-trust.txt");
                var publicBytes = File.ReadAllBytes(publicFile);
                using var publicCertificate = X509CertificateLoader.LoadCertificate(publicBytes);
                Assert(!publicCertificate.HasPrivateKey && publicCertificate.RawData.AsSpan().SequenceEqual(generated.RawData), "The public export leaked a private key or exported a different certificate.");
                var keyAcl = new FileInfo(installed.PrivateKey!).GetAccessControl();
                var keyRules = keyAcl.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToArray();
                var allowedSids = new[] { fixtureIdentity.Value, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null).Value, new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null).Value };
                Assert(keyAcl.AreAccessRulesProtected && keyRules.Length == allowedSids.Distinct().Count()
                    && keyRules.All(rule => !rule.IsInherited && rule.AccessControlType == AccessControlType.Allow && allowedSids.Contains(rule.IdentityReference.Value)), "The private key inherited or granted broad access.");
                using (var untrusted = new X509Chain())
                {
                    untrusted.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck; untrusted.ChainPolicy.DisableCertificateDownloads = true;
                    Assert(!untrusted.Build(publicCertificate) && untrusted.ChainStatus.Any(status => status.Status.HasFlag(X509ChainStatusFlags.UntrustedRoot)), "The generated certificate unexpectedly became OS-trusted.");
                }
                using (var trusted = new X509Chain())
                {
                    trusted.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck; trusted.ChainPolicy.DisableCertificateDownloads = true;
                    trusted.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust; trusted.ChainPolicy.CustomTrustStore.Add(publicCertificate);
                    trusted.ChainPolicy.ApplicationPolicy.Add(new Oid("1.3.6.1.5.5.7.3.1"));
                    Assert(trusted.Build(publicCertificate), "Trusting only the exported self-signed public certificate did not validate server authentication.");
                }
                var guide = File.ReadAllText(guideFile);
                var fingerprint = string.Join(":", generated.GetCertHash(HashAlgorithmName.SHA256).Select(value => value.ToString("X2", System.Globalization.CultureInfo.InvariantCulture)));
                Assert(guide.Contains(fingerprint) && guide.Contains($"https://{identity}:5443")
                    && guide.Contains("one year") && !guide.Contains("PRIVATE KEY"), "The trust guide lost the exact fingerprint, address or renewal instructions.");
                await VerifyFixtureTlsAsync(installed, generated);
                var beforeKeep = Directory.GetFiles(certificateDirectory).ToDictionary(path => path, File.ReadAllBytes);
                var kept = InstallDeployment(directory, 5090, generatedOptions with { Access = "keep" }, fixtureIdentity);
                Assert(kept.CreatedFiles.Count == 0 && Directory.GetFiles(certificateDirectory).Length == beforeKeep.Count
                    && beforeKeep.All(pair => File.ReadAllBytes(pair.Key).AsSpan().SequenceEqual(pair.Value)), "Keep settings regenerated or changed the certificate.");
                // Replacement must update the public export, and rollback must restore its
                // exact old content and ACL as well as the listener and unique PEM files.
                var previousSettings = File.ReadAllBytes(settingsFile);
                var previousGuide = File.ReadAllBytes(guideFile);
                // A distinct pre-existing public-export ACL verifies exact ACL rollback.
                var distinctiveAcl = new FileInfo(publicFile).GetAccessControl();
                distinctiveAcl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.Read, AccessControlType.Allow));
                new FileInfo(publicFile).SetAccessControl(distinctiveAcl);
                var previousPublicAcl = new FileInfo(publicFile).GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Access);
                var replacement = InstallDeployment(directory, 5090, options with { Hostname = identity }, fixtureIdentity);
                using (var suppliedExport = X509CertificateLoader.LoadCertificateFromFile(publicFile)) Assert(suppliedExport.RawData.AsSpan().SequenceEqual(certificate.RawData), "Provided mode left a stale generated public certificate.");
                replacement.Rollback();
                Assert(File.ReadAllBytes(settingsFile).AsSpan().SequenceEqual(previousSettings) && File.ReadAllBytes(publicFile).AsSpan().SequenceEqual(publicBytes)
                    && File.ReadAllBytes(guideFile).AsSpan().SequenceEqual(previousGuide) && Directory.GetFiles(certificateDirectory).Length == beforeKeep.Count
                    && new FileInfo(publicFile).GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Access) == previousPublicAcl, "Replacement rollback did not restore exact deployment/export bytes and ACL.");
                File.WriteAllBytes(guideFile, new byte[65_537]);
                Reject(() => InstallDeployment(directory, 5090, generatedOptions with { Hostname = identity }, fixtureIdentity));
                Assert(File.ReadAllBytes(settingsFile).AsSpan().SequenceEqual(previousSettings) && File.ReadAllBytes(publicFile).AsSpan().SequenceEqual(publicBytes)
                    && Directory.GetFiles(certificateDirectory).Length == beforeKeep.Count && new FileInfo(guideFile).Length == 65_537
                    && new FileInfo(publicFile).GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Access) == previousPublicAcl, "A failed certificate replacement left generated artifacts or changed previous exports.");
                File.WriteAllBytes(guideFile, previousGuide);
                generatedChange.Rollback();
                Assert(!File.Exists(settingsFile) && !Directory.Exists(Path.Combine(directory, "certificates")), "Generated certificate rollback left artifacts or directories.");
            }

            File.WriteAllText(settingsFile, JsonSerializer.Serialize(new { version = 1, settings = new { enabled = true, url = "https://0.0.0.0:5443", publicHostname = "192.0.2.10", certificateFile = "ip.pem", privateKeyFile = "ip-key.pem" } }));
            Assert(ReadNetworkIntent(directory)?.Hostname == "192.0.2.10", "Keeping a saved IP network identity failed.");
            File.Delete(settingsFile);
            var local = options with { Access = "local" };
            var change = InstallDeployment(directory, 15090, local);
            Assert(JsonNode.Parse(File.ReadAllText(settingsFile))?["settings"]?["url"]?.GetValue<string>() == "http://127.0.0.1:15090", "Local intent was not installed.");
            change.Rollback(); Assert(!File.Exists(settingsFile), "New deployment rollback left a file.");
            File.WriteAllText(settingsFile, "retained configuration");
            var update = InstallDeployment(directory, 15091, local); update.Rollback();
            Assert(File.ReadAllText(settingsFile) == "retained configuration", "Rollback did not restore exact previous bytes.");
            foreach (var identity in new[] { "gateway.fixture.test", "192.0.2.10" })
                await VerifyFixtureTlsAsync(options with { Hostname = identity }, certificate);
            var pfx = certificate.Export(X509ContentType.Pkcs12);
            using var serverCertificate = X509CertificateLoader.LoadPkcs12(pfx, null, X509KeyStorageFlags.DefaultKeySet); CryptographicOperations.ZeroMemory(pfx);
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
                try { await VerifyNetworkReadinessAsync(options with { HttpsPort = stalledPort }, () => 1234); throw new InvalidOperationException("Stalled TLS response body was accepted."); }
                catch (InvalidOperationException error) when (error.Message.Contains("within 5 seconds")) { Assert(watch.Elapsed < TimeSpan.FromSeconds(8), "TLS readiness body deadline was not bounded."); }
            }
            finally { stalledDeadline.Cancel(); stalledListener.Stop(); try { await stalledServer; } catch (OperationCanceledException) { } }
            Console.WriteLine($"PASS {checks} network DNS/IPv4 identity/certificate/port, self-signed generation/public trust/private ACL, exact deployment rollback and pinned TLS readiness checks; no service, registration or trust store was changed.");
        }
        catch (Exception error) { Console.Error.WriteLine($"Network fixture failed: {error}"); throw; }
        finally
        {
            // This unique fixture root and every child were created by this test; no
            // external path input or reparse point is followed during cleanup.
            RejectReparsePoints(directory);
            foreach (var entry in Directory.GetFileSystemEntries(directory, "*", SearchOption.AllDirectories)) RejectReparsePoints(entry);
            foreach (var file in Directory.GetFiles(directory, "*", SearchOption.AllDirectories)) File.Delete(file);
            foreach (var folder in Directory.GetDirectories(directory, "*", SearchOption.AllDirectories).OrderByDescending(path => path.Length)) Directory.Delete(folder);
            Directory.Delete(directory);
        }
    }

}
