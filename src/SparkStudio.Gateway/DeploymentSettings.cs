using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Server.Kestrel.Https;

namespace SparkStudio.Gateway;

/// <summary>Explicit, restart-only listener intent. Secrets remain in offline files.</summary>
public sealed class DeploymentSettings : IDisposable
{
    private const int MaximumFileBytes = 65_536;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    { WriteIndented = true, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
    private static readonly Regex FileName = new(@"\A[A-Za-z0-9][A-Za-z0-9._-]{0,119}\z", RegexOptions.CultureInvariant);
    private readonly object sync = GatewayConfigurationLock.SyncRoot;
    private readonly string filename;
    private readonly string certificateDirectory;
    private readonly string? overrideReason;
    private readonly int? installerManagementPort;
    private string fingerprint;
    private DeploymentDocument document;
    private readonly DeploymentIntent? startupIntent;
    private string? recovery;
    private string startupState = "unmanaged";
    private X509Certificate2? startupCertificate;
    private readonly X509Certificate2Collection startupCertificateChain = new();

    public DeploymentSettings(string dataDirectory, string? externalOverride = null, int? installerManagementPort = null)
    {
        filename = Path.Combine(dataDirectory, "deployment.json");
        certificateDirectory = Path.Combine(dataDirectory, "certificates", "deployment");
        overrideReason = externalOverride;
        if (installerManagementPort is < 1024 or > 65535) throw new ArgumentException("Installer management port must be between 1024 and 65535.");
        this.installerManagementPort = installerManagementPort;
        fingerprint = Fingerprint(filename);
        try { document = Read(filename) ?? new(1, "0", Default); startupIntent = document.Settings; }
        catch (Exception error) when (IsFileFailure(error))
        { document = new(1, fingerprint, Default); recovery = "The saved deployment file is invalid or unreadable. Existing host configuration was retained. Restore the previous settings or save a replacement."; }
    }

    public static DeploymentIntent Default => new(false, "http://127.0.0.1:5090", null, null);

    /// <summary>Call after resolving the data directory, before registering startup observations or building the host.</summary>
    public static DeploymentSettings Configure(WebApplicationBuilder builder, string dataDirectory, string? recoveryReason = null)
    {
        int? managementPort = null;
        if (builder.Configuration["InstallerManagementPort"] is { } configured)
        {
            if (!int.TryParse(configured, out var parsed) || parsed is < 1024 or > 65535) throw new ArgumentException("Invalid installer management port.");
            managementPort = parsed;
        }
        var externalOverride = ExternalOverride(builder.Configuration);
        if (recoveryReason is null && managementPort is not null && externalOverride is not null)
            throw new InvalidOperationException("Installer-managed listeners have a conflicting external override. Remove URL/Kestrel/environment overrides before starting the service. For manual recovery, omit InstallerManagementPort and supply an explicit loopback --urls value.");
        var store = new DeploymentSettings(dataDirectory, recoveryReason ?? externalOverride, managementPort);
        if (recoveryReason is null) store.ApplyStartup(builder);
        else { store.startupState = "overridden"; store.recovery = recoveryReason; }
        builder.Services.AddSingleton<DeploymentSettings>(_ => store);
        return store;
    }

    public void ApplyStartup(WebApplicationBuilder builder)
    {
        if (overrideReason is not null) { startupState = "overridden"; return; }
        // Retain local bootstrap/recovery access independently of the optional LAN listener.
        if (installerManagementPort is { } managementPort)
            builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, managementPort));
        if (recovery is not null) { startupState = "recovery"; return; }
        if (startupIntent?.Enabled != true) return;
        try
        {
            var validated = Validate(startupIntent);
            var uri = new Uri(validated.Settings.Url);
            if (validated.Settings.PublicHostname is { } publicHostname) AllowPublicHostname(builder.Configuration, publicHostname);
            var address = IPAddress.Parse(uri.Host.Trim('[', ']'));
            if (uri.Scheme == "https")
            {
                startupCertificate = LoadCertificate(validated.Settings, uri, forTls: true);
                startupCertificateChain.ImportFromPemFile(Path.Combine(certificateDirectory, validated.Settings.CertificateFile!));
            }
            if (!(installerManagementPort == uri.Port && address.Equals(IPAddress.Loopback) && uri.Scheme == "http"))
            builder.WebHost.ConfigureKestrel(options => options.Listen(address, uri.Port, listener =>
            {
                if (startupCertificate is not null) listener.UseHttps(new HttpsConnectionAdapterOptions { ServerCertificate = startupCertificate, ServerCertificateChain = startupCertificateChain });
            }));
            startupState = "managed";
        }
        catch (Exception error) when (error is ArgumentException || IsFileFailure(error))
        {
            startupCertificate?.Dispose(); startupCertificate = null;
            foreach (var certificate in startupCertificateChain) certificate.Dispose(); startupCertificateChain.Clear();
            startupState = "recovery";
            recovery = "Saved listener or certificate validation failed at startup. Existing host configuration was retained. Review the offline certificate files, restore previous settings, or save a replacement.";
        }
    }

    public DeploymentSettingsSnapshot Snapshot()
    {
        lock (sync)
        {
            var same = startupIntent == document.Settings;
            return new(document.Revision, document.Settings, startupIntent, startupState,
                document.Settings.Enabled && overrideReason is not null ? "overridden"
                    : !same ? "restart-required" : startupState == "managed" ? "applied-at-startup" : startupState,
                !same, overrideReason, recovery, PreviousAvailable(), certificateDirectory, installerManagementPort,
                "Saving never restarts the gateway. Stop and start it deliberately, then verify the actual listeners. If the address is unavailable, stop the service and launch manually without --InstallerManagementPort, using --urls http://127.0.0.1:5090 (or an unused local port). This bypasses saved settings without changing gateway data.");
        }
    }

    public DeploymentValidation Validate(DeploymentIntent? input)
    {
        if (input is null) throw new ArgumentException("Listener settings are required.");
        if (input.Url is null || input.Url.Length > 128 || input.Url.Any(char.IsWhiteSpace)
            || !Uri.TryCreate(input.Url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")
            || uri.Port is < 1024 or > 65535 || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0
            || uri.AbsolutePath != "/" || !IPAddress.TryParse(uri.Host.Trim('[', ']'), out var address)
            || !(address.Equals(IPAddress.Loopback) || address.Equals(IPAddress.IPv6Loopback) || address.Equals(IPAddress.Any)))
            throw new ArgumentException("Use 127.0.0.1, [::1], or 0.0.0.0 with a port from 1024 to 65535. Network listeners require HTTPS and a DNS hostname or specific IPv4 address.");
        var network = address.Equals(IPAddress.Any);
        if (network && uri.Scheme != "https") throw new ArgumentException("Network access requires HTTPS. HTTP is supported only on loopback.");
        var hostname = string.IsNullOrWhiteSpace(input.PublicHostname) ? null : input.PublicHostname.Trim().ToLowerInvariant();
        if (hostname is not null) ValidatePublicAddress(hostname);
        if (network && hostname is null) throw new ArgumentException("A DNS hostname or specific IPv4 address matching the certificate is required for network access.");
        if (!network && hostname is not null) throw new ArgumentException("A public hostname is used only for the 0.0.0.0 network listener.");
        if (installerManagementPort == uri.Port && (network || uri.Scheme == "https" || !address.Equals(IPAddress.Loopback)))
            throw new ArgumentException("The HTTPS port must differ from the installer's local management port.");
        var normalized = new DeploymentIntent(input.Enabled, uri.GetLeftPart(UriPartial.Authority), input.CertificateFile, input.PrivateKeyFile, hostname);
        DateTimeOffset? expires = null;
        if (uri.Scheme == "https")
        {
            ValidateFilename(input.CertificateFile); ValidateFilename(input.PrivateKeyFile);
            if (input.Enabled)
            {
                using var certificate = LoadCertificate(normalized, uri);
                expires = certificate.NotAfter.ToUniversalTime();
            }
        }
        else if (input.CertificateFile is not null || input.PrivateKeyFile is not null)
            throw new ArgumentException("HTTP settings cannot include certificate or private key references.");
        return new(normalized, expires, overrideReason,
            input.Enabled ? "Listener settings are valid. This does not test whether the port is free, establish browser certificate trust, open the firewall, or restart the gateway."
                : "Managed listener disabled. After restart, the gateway uses its normal host configuration.");
    }

    public DeploymentSettingsSnapshot Save(DeploymentSaveRequest request)
    {
        lock (sync)
        {
            CheckRevision(request.Revision);
            var next = Validate(request.Settings).Settings;
            Persist(next);
            return Snapshot();
        }
    }

    public DeploymentSettingsSnapshot Restore(DeploymentRevisionRequest request)
    {
        lock (sync)
        {
            CheckRevision(request.Revision);
            DeploymentDocument? previous;
            try { previous = Read(filename + ".previous"); }
            catch (Exception error) when (IsFileFailure(error)) { throw new ArgumentException("The previous deployment file is invalid or unreadable."); }
            if (previous is null) throw new ArgumentException("No previous deployment settings are available.");
            var next = Validate(previous.Settings).Settings;
            Persist(next);
            return Snapshot();
        }
    }

    private void Persist(DeploymentIntent settings)
    {
        var next = new DeploymentDocument(1, Guid.NewGuid().ToString("N"), settings);
        // Commit the old bytes before replacing the only active file. No certificate/key bytes enter either file.
        byte[]? previousBytes = null;
        try
        {
            var previous = Read(filename);
            if (previous is not null) { Validate(previous.Settings); previousBytes = ReadBytes(filename); }
            else previousBytes = JsonSerializer.SerializeToUtf8Bytes(document, Json);
        }
        catch (Exception error) when (error is ArgumentException || IsFileFailure(error)) { }
        // A damaged current file must never replace the last usable recovery file.
        if (previousBytes is not null) WriteAtomic(filename + ".previous", previousBytes);
        WriteAtomic(filename, JsonSerializer.SerializeToUtf8Bytes(next, Json));
        document = next; fingerprint = Fingerprint(filename); recovery = null;
    }

    private void CheckRevision(string revision)
    {
        if (revision != document.Revision) throw new InvalidOperationException("Deployment settings changed. Reload the saved settings before trying again.");
        if (Fingerprint(filename) != fingerprint) throw new InvalidOperationException("Deployment settings were changed outside this process. Restart the gateway to load that file before editing it here.");
    }

    private bool PreviousAvailable()
    {
        try { var previous = Read(filename + ".previous"); if (previous is null) return false; Validate(previous.Settings); return true; }
        catch (Exception error) when (error is ArgumentException || IsFileFailure(error)) { return false; }
    }

    private static DeploymentDocument? Read(string path)
    {
        if (!File.Exists(path)) return null;
        var result = JsonSerializer.Deserialize<DeploymentDocument>(ReadBytes(path), Json);
        if (result is null || result.Version != 1 || string.IsNullOrWhiteSpace(result.Revision) || result.Revision.Length > 128 || result.Settings is null)
            throw new JsonException("Unsupported deployment document.");
        return result;
    }

    private X509Certificate2 LoadCertificate(DeploymentIntent intent, Uri uri, bool forTls = false)
    {
        ValidateFilename(intent.CertificateFile); ValidateFilename(intent.PrivateKeyFile);
        try
        {
            foreach (var directory in new[] { Directory.GetParent(certificateDirectory)!.FullName, certificateDirectory })
                if (Directory.Exists(directory) && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("Certificate folders must be ordinary local directories.");
            var certPath = Path.Combine(certificateDirectory, intent.CertificateFile!);
            var keyPath = Path.Combine(certificateDirectory, intent.PrivateKeyFile!);
            foreach (var path in new[] { certPath, keyPath })
                if (!File.Exists(path) || new FileInfo(path).Length > MaximumFileBytes || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                    throw new ArgumentException("Certificate and key files must exist as ordinary files, each no larger than 64 KiB, in the deployment certificate directory.");
            var cert = X509Certificate2.CreateFromPemFile(certPath, keyPath);
            try
            {
                if (!cert.HasPrivateKey || cert.NotBefore.ToUniversalTime() > DateTime.UtcNow || cert.NotAfter.ToUniversalTime() <= DateTime.UtcNow
                    || !cert.MatchesHostname(intent.PublicHostname ?? uri.Host.Trim('[', ']'), allowWildcards: false, allowCommonName: false))
                    throw new ArgumentException("The certificate must have its matching private key, be currently valid, and contain the public DNS hostname or exact IP address in its subject alternative names. IP addresses require an IP SAN; a DNS SAN containing digits or a Common Name is insufficient.");
                foreach (var usage in cert.Extensions.OfType<X509EnhancedKeyUsageExtension>())
                    if (!usage.EnhancedKeyUsages.Cast<Oid>().Any(oid => oid.Value == "1.3.6.1.5.5.7.3.1"))
                        throw new ArgumentException("The certificate's extended key usage must allow TLS server authentication.");
                if (forTls && OperatingSystem.IsWindows())
                {
                    // SChannel needs a non-ephemeral key handle. The loader removes its temporary
                    // key container on Dispose; neither PersistKeySet nor a certificate-store import is used.
                    var pfx = cert.Export(X509ContentType.Pkcs12);
                    try { var windows = X509CertificateLoader.LoadPkcs12(pfx, null, X509KeyStorageFlags.DefaultKeySet); cert.Dispose(); return windows; }
                    finally { CryptographicOperations.ZeroMemory(pfx); }
                }
                return cert;
            }
            catch { cert.Dispose(); throw; }
        }
        catch (Exception error) when (IsFileFailure(error))
        { throw new ArgumentException("Unable to load the certificate/key pair. Use a PEM certificate and its matching unencrypted PEM private key in the deployment certificate directory; passwords and key uploads are not supported."); }
    }

    private static void ValidatePublicAddress(string value)
    {
        if (IPAddress.TryParse(value, out var ip))
        {
            if (ip.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork)
                throw new ArgumentException("Network access currently uses IPv4. Enter a DNS hostname or specific IPv4 address, without brackets or a port.");
            var first = ip.GetAddressBytes()[0];
            if (value != ip.ToString() || first == 0 || first >= 224)
                throw new ArgumentException("Use a specific canonical IPv4 address such as 192.168.1.20, not an abbreviated, wildcard, multicast or reserved address.");
            return;
        }
        if (value.Length > 253 || value.All(c => char.IsAsciiDigit(c) || c == '.') || Uri.CheckHostName(value) != UriHostNameType.Dns
            || value.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '.' or '-')) || value.StartsWith('.') || value.EndsWith('.')
            || value.Split('.').Any(label => label.Length is < 1 or > 63 || label.StartsWith('-') || label.EndsWith('-')))
            throw new ArgumentException("Use a DNS hostname or specific IPv4 address without a scheme, port, path or wildcard.");
    }

    private static void ValidateFilename(string? value)
    {
        if (value is null || !FileName.IsMatch(value) || value is "." or "..")
            throw new ArgumentException("Certificate references must be plain filenames in the deployment certificate directory.");
    }

    private static bool IsFileFailure(Exception error) => error is IOException or UnauthorizedAccessException or JsonException or CryptographicException or NotSupportedException;
    private static byte[] ReadBytes(string path)
    {
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var output = new MemoryStream();
        var buffer = new byte[4096]; int count;
        while ((count = input.Read(buffer)) > 0)
        { if (output.Length + count > MaximumFileBytes) throw new JsonException("Deployment file is too large."); output.Write(buffer, 0, count); }
        return output.ToArray();
    }
    private static string Fingerprint(string path)
    {
        try
        {
            if (!File.Exists(path)) return "missing";
            var info = new FileInfo(path);
            return info.Length > MaximumFileBytes ? $"oversized-{info.Length}-{info.LastWriteTimeUtc.Ticks}" : Convert.ToHexString(SHA256.HashData(ReadBytes(path)));
        }
        catch (Exception error) when (IsFileFailure(error)) { return "unreadable"; }
    }
    private static void WriteAtomic(string path, byte[] bytes)
    {
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            { stream.Write(bytes); stream.Flush(flushToDisk: true); }
            File.Move(temp, path, overwrite: true);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }

    private static void AllowPublicHostname(ConfigurationManager configuration, string hostname)
    {
        var allowed = configuration["AllowedHosts"];
        var values = (allowed ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (values.Any(value => value == "*" || value.Equals(hostname, StringComparison.OrdinalIgnoreCase))) return;
        var defaultHosts = "localhost;127.0.0.1;[::1]";
        var source = ((IConfigurationRoot)configuration).Providers.Reverse().FirstOrDefault(provider => provider.TryGet("AllowedHosts", out var value) && !string.IsNullOrWhiteSpace(value));
        if (source is not null && !(source is Microsoft.Extensions.Configuration.Json.JsonConfigurationProvider json && json.Source.Path == "appsettings.json" && allowed == defaultHosts))
            throw new ArgumentException("The explicit AllowedHosts configuration must include the public hostname before network HTTPS can start.");
        // Expand only the bundled default. An explicit operator policy remains authoritative.
        configuration["AllowedHosts"] = defaultHosts + ";" + hostname;
    }

    public static string? ExternalOverride(IConfiguration config)
    {
        if (Environment.GetEnvironmentVariable("SPARKSTUDIO_DEPLOYMENT_DISABLE") is "1" or "true") return "SPARKSTUDIO_DEPLOYMENT_DISABLE bypasses saved listener settings.";
        if (config.GetSection("Kestrel:Endpoints").GetChildren().Any()) return "Explicit Kestrel endpoints take precedence over saved listener settings.";
        if (config is IConfigurationRoot root)
            foreach (var provider in root.Providers.Reverse())
            {
                if (!provider.TryGet("Urls", out var value) || string.IsNullOrWhiteSpace(value)) continue;
                if (provider is Microsoft.Extensions.Configuration.Json.JsonConfigurationProvider json && json.Source.Path == "appsettings.json") continue;
                return "An external URL binding takes precedence over saved listener settings (command line, environment or host configuration).";
            }
        return null;
    }

    public void Dispose() { startupCertificate?.Dispose(); startupCertificate = null; foreach (var certificate in startupCertificateChain) certificate.Dispose(); startupCertificateChain.Clear(); }
}

public sealed record DeploymentIntent(bool Enabled, string Url, string? CertificateFile, string? PrivateKeyFile,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? PublicHostname = null);
public sealed record DeploymentDocument(int Version, string Revision, DeploymentIntent Settings);
public sealed record DeploymentSaveRequest(string Revision, DeploymentIntent Settings);
public sealed record DeploymentRevisionRequest(string Revision);
public sealed record DeploymentValidation(DeploymentIntent Settings, DateTimeOffset? CertificateExpiresAt, string? OverrideReason, string Message);
public sealed record DeploymentSettingsSnapshot(string Revision, DeploymentIntent Saved, DeploymentIntent? StartupIntent, string StartupState,
    string State, bool RestartRequired, string? OverrideReason, string? Recovery, bool PreviousAvailable, string CertificateDirectory, int? InstallerManagementPort, string RestartNote);

public static class DeploymentSettingsEndpoints
{
    public static void MapDeploymentSettingsEndpoints(this WebApplication app)
    {
        app.MapGet("/api/gateway/deployment/settings", (HttpContext context, DeploymentSettings settings) =>
        { context.Response.Headers.CacheControl = "no-store"; return settings.Snapshot(); }).Access("configuration");
        app.MapPost("/api/gateway/deployment/settings/validate", (DeploymentIntent request, DeploymentSettings settings) => settings.Validate(request)).Access("configuration");
        app.MapPut("/api/gateway/deployment/settings", (DeploymentSaveRequest request, DeploymentSettings settings) => settings.Save(request)).Access("configuration", audit: true);
        app.MapPost("/api/gateway/deployment/settings/restore", (DeploymentRevisionRequest request, DeploymentSettings settings) => settings.Restore(request)).Access("configuration", audit: true);
    }
}
