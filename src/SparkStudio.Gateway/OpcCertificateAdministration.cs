using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace SparkStudio.Gateway;

public sealed record OpcCertificateTrustRequest(string Certificate, string ConfirmedSha256);
public sealed record OpcCertificateRemovalRequest(string ConfirmedSha256);
public sealed record OpcCertificateSummary(string Store, string Sha256, string Subject, string Issuer, DateTimeOffset NotBefore, DateTimeOffset NotAfter);

/// <summary>Only public OPC certificates cross this API. Trust-store edits take effect after gateway restart.</summary>
public sealed class OpcCertificateAdministration(string dataDirectory)
{
    private readonly object gate = new();
    private readonly string root = Path.Combine(dataDirectory, "pki");
    private static readonly string[] Stores = ["own", "trusted", "issuers", "rejected"];

    public object List()
    {
        lock (gate)
        {
            var certificates = new List<OpcCertificateSummary>(); var invalidFiles = 0;
            foreach (var store in Stores)
                foreach (var path in Files(store))
                {
                    using var certificate = Read(path);
                    if (certificate is null) invalidFiles++; else certificates.Add(Summary(store, certificate));
                }
            return new { certificates, invalidFiles, note = "Verify certificate fingerprints independently. Trust-store changes require a gateway restart, including revocation of existing sessions. Connection-specific pins must also be removed to revoke a pinned server. Private keys are never returned." };
        }
    }

    public byte[] Download(string store, string sha256)
    {
        ValidateFingerprint(sha256);
        lock (gate)
        {
            foreach (var path in Files(store))
            {
                using var certificate = Read(path);
                if (certificate is not null && Fingerprint(certificate).Equals(sha256, StringComparison.OrdinalIgnoreCase)) return certificate.Export(X509ContentType.Cert);
            }
            throw new KeyNotFoundException("Public OPC certificate not found.");
        }
    }

    public object Trust(OpcCertificateTrustRequest request)
    {
        ValidateFingerprint(request.ConfirmedSha256);
        byte[] bytes;
        try { bytes = Convert.FromBase64String(request.Certificate); } catch (FormatException) { throw new ArgumentException("Choose a DER public certificate."); }
        if (bytes.Length is < 32 or > 65536) throw new ArgumentException("Public OPC certificates must be at most 64 KiB.");
        using var certificate = X509CertificateLoader.LoadCertificate(bytes);
        if (certificate.HasPrivateKey || !Fingerprint(certificate).Equals(request.ConfirmedSha256, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("The independently confirmed SHA-256 fingerprint does not match the certificate.");
        var now = DateTimeOffset.UtcNow;
        if (certificate.NotBefore.ToUniversalTime() > now || certificate.NotAfter.ToUniversalTime() <= now) throw new ArgumentException("The certificate is not currently valid.");
        using var rsa = certificate.GetRSAPublicKey(); using var ec = certificate.GetECDsaPublicKey();
        // Accept modern digest algorithms positively. RSA-PSS needs parameter validation,
        // so it remains unsupported rather than accepting an unchecked inner digest.
        if (certificate.SignatureAlgorithm.Value is not ("1.2.840.113549.1.1.11" or "1.2.840.113549.1.1.12" or "1.2.840.113549.1.1.13"
            or "1.2.840.10045.4.3.2" or "1.2.840.10045.4.3.3" or "1.2.840.10045.4.3.4")
            || rsa is not null && rsa.KeySize < 2048 || rsa is null && (ec is null || ec.KeySize < 256))
            throw new ArgumentException("Use an RSA PKCS#1 or ECDSA certificate signed with SHA-256, SHA-384 or SHA-512, with at least a 2048-bit RSA or 256-bit EC key. RSA-PSS and other signature algorithms are not supported by this trust workflow.");
        lock (gate)
        {
            var folder = Path.Combine(root, "trusted", "certs"); RecoveryFileSystem.RejectLinks(folder); Directory.CreateDirectory(folder);
            var path = Path.Combine(folder, Fingerprint(certificate) + ".der"); RecoveryFileSystem.RejectLinks(path);
            var publicBytes = certificate.Export(X509ContentType.Cert);
            // Re-importing repairs an interrupted/corrupt file at this exact public identity.
            if (!File.Exists(path) || new FileInfo(path).Length > 65536 || !File.ReadAllBytes(path).SequenceEqual(publicBytes))
            {
                var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try
                {
                    using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(publicBytes); stream.Flush(true); }
                    File.Move(temporary, path, overwrite: true);
                }
                finally { if (File.Exists(temporary)) File.Delete(temporary); }
            }
            return new { certificate = Summary("trusted", certificate), restartRequired = true };
        }
    }

    public object Remove(string sha256, OpcCertificateRemovalRequest request)
    {
        ValidateFingerprint(sha256);
        if (!sha256.Equals(request.ConfirmedSha256, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Confirm the exact certificate fingerprint before removing trust.");
        lock (gate)
        {
            var removed = 0;
            foreach (var path in Files("trusted"))
            {
                using var certificate = Read(path);
                if (certificate is null || !Fingerprint(certificate).Equals(sha256, StringComparison.OrdinalIgnoreCase)) continue;
                File.Delete(path); removed++;
            }
            if (removed == 0) throw new KeyNotFoundException("Trusted certificate not found.");
            return new { removed, restartRequired = true };
        }
    }

    private string[] Files(string store)
    {
        if (!Stores.Contains(store, StringComparer.Ordinal)) throw new ArgumentException("Choose a public OPC certificate store.");
        var folder = Path.Combine(root, store, "certs"); RecoveryFileSystem.RejectLinks(folder);
        if (!Directory.Exists(folder)) return [];
        var paths = Directory.EnumerateFiles(folder, "*.der", SearchOption.TopDirectoryOnly).Take(1001).ToArray();
        if (paths.Length > 1000) throw new InvalidOperationException("A certificate store exceeds 1,000 entries. Manage it locally before continuing.");
        return paths;
    }
    private static X509Certificate2? Read(string path)
    {
        // Reparse points remain a hard failure. A malformed ordinary public file must
        // not prevent lookup or revocation of an unrelated valid certificate.
        RecoveryFileSystem.RejectLinks(path);
        try
        {
            if (new FileInfo(path).Length > 65536) return null;
            return X509CertificateLoader.LoadCertificate(File.ReadAllBytes(path));
        }
        catch (Exception error) when (error is CryptographicException or IOException or ArgumentException) { return null; }
    }
    private static string Fingerprint(X509Certificate2 certificate) => certificate.GetCertHashString(HashAlgorithmName.SHA256);
    private static void ValidateFingerprint(string value) { if (value is null || value.Length != 64 || value.Any(character => !char.IsAsciiHexDigit(character))) throw new ArgumentException("A SHA-256 fingerprint needs exactly 64 hexadecimal characters."); }
    private static OpcCertificateSummary Summary(string store, X509Certificate2 certificate) => new(store, Fingerprint(certificate), certificate.Subject, certificate.Issuer, certificate.NotBefore.ToUniversalTime(), certificate.NotAfter.ToUniversalTime());

    public static void MapEndpoints(WebApplication app)
    {
        app.MapGet("/api/gateway/opcua/certificates", (OpcCertificateAdministration certificates) => certificates.List()).Access("configuration");
        app.MapGet("/api/gateway/opcua/certificates/{store}/{sha256}", (string store, string sha256, OpcCertificateAdministration certificates) => Results.File(certificates.Download(store, sha256), "application/pkix-cert", "sparkstudio-opc-" + sha256 + ".der")).Access("configuration", audit: true);
        app.MapPost("/api/gateway/opcua/certificates/trust", (OpcCertificateTrustRequest request, OpcCertificateAdministration certificates) => certificates.Trust(request)).Access("configuration", audit: true);
        app.MapPost("/api/gateway/opcua/certificates/trusted/{sha256}/remove", (string sha256, OpcCertificateRemovalRequest request, OpcCertificateAdministration certificates) => certificates.Remove(sha256, request)).Access("configuration", audit: true);
    }
}
