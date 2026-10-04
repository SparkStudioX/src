using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using System.Text.Json.Nodes;
using SparkStudio.Gateway;

internal static class DataMigrationChecks
{
    public static int Run()
    {
        var passed = 0;
        void Check(bool condition, string description) { if (!condition) throw new Exception("FAILED: " + description); passed++; }
        void Reject(Action action, string description)
        {
            try { action(); } catch (Exception error) when (error is ArgumentException or InvalidDataException or KeyNotFoundException or CryptographicException) { passed++; return; }
            throw new Exception("FAILED to reject: " + description);
        }
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.Migrations." + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
        try
        {
            const string legacy = """[{"path":"[default]Fixture/Count","kind":"memory","dataType":"Int32","value":17,"enabled":true}]""";
            File.WriteAllText(Path.Combine(directory, "tags.json"), legacy);
            Reject(() => GatewayDataMigrations.Prepare(directory), "flat tag arrays are unsupported");
            Check(File.ReadAllText(Path.Combine(directory, "tags.json")) == legacy && !Directory.Exists(Path.Combine(directory, "migration-backups")), "unsupported tags are not migrated or rewritten");
            var current = TagModel.Empty(); current["tags"] = JsonNode.Parse(legacy);
            File.WriteAllText(Path.Combine(directory, "tags.json"), current.ToJsonString());
            GatewayDataMigrations.Prepare(directory);
            Check(JsonNode.Parse(File.ReadAllText(Path.Combine(directory, "gateway-format.json")))!["version"]!.GetValue<int>() == TagModel.FormatVersion, "current tag model initializes the current gateway format marker");
            var before = File.ReadAllText(Path.Combine(directory, "gateway-format.json")); GatewayDataMigrations.Prepare(directory);
            Check(before == File.ReadAllText(Path.Combine(directory, "gateway-format.json")), "current format validation is idempotent");
            foreach (var version in new[] { 1, 2, 999 })
            {
                File.WriteAllText(Path.Combine(directory, "gateway-format.json"), new JsonObject { ["version"] = version }.ToJsonString());
                Reject(() => GatewayDataMigrations.Prepare(directory), "unsupported gateway format rejected before mutation");
            }
            Check(JsonNode.Parse(File.ReadAllText(Path.Combine(directory, "tags.json")))!["tags"]![0]!["value"]!.GetValue<int>() == 17, "unsupported format does not rewrite data");

            var certificates = new OpcCertificateAdministration(directory);
            using var key = RSA.Create(2048);
            var request = new CertificateRequest("CN=Authored OPC Fixture", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(30));
            var bytes = certificate.Export(X509ContentType.Cert); var hash = certificate.GetCertHashString(HashAlgorithmName.SHA256);
            Reject(() => certificates.Trust(new(Convert.ToBase64String(bytes), new string('0', 64))), "unconfirmed certificate fingerprint");
            certificates.Trust(new(Convert.ToBase64String(bytes), hash));
            Check(certificates.Download("trusted", hash).SequenceEqual(bytes), "public certificate trust/download round trip");
            var listing = JsonSerializer.SerializeToNode(certificates.List(), ProjectStore.Json)!;
            Check(listing["certificates"]!.AsArray().Count == 1, "certificate listed with public identity");
            var trustedFolder = Path.Combine(directory, "pki", "trusted", "certs");
            File.WriteAllBytes(Path.Combine(trustedFolder, "corrupt.der"), [0x30, 0x03, 0x01]);
            listing = JsonSerializer.SerializeToNode(certificates.List(), ProjectStore.Json)!;
            Check(listing["certificates"]!.AsArray().Count == 1 && listing["invalidFiles"]!.GetValue<int>() == 1, "malformed ordinary certificate is reported without hiding valid certificates");
            Check(certificates.Download("trusted", hash).SequenceEqual(bytes), "unrelated malformed certificate does not block valid download");
            File.WriteAllBytes(Path.Combine(trustedFolder, hash + ".der"), [0x30, 0x03, 0x01]);
            certificates.Trust(new(Convert.ToBase64String(bytes), hash));
            Check(certificates.Download("trusted", hash).SequenceEqual(bytes), "confirmed trust re-import repairs corrupt exact-identity file");
            // Change only the encoded algorithm OID in this generated public fixture.
            // It is intentionally not a valid signature; the trust policy must reject its weak algorithm first.
            var md5 = bytes.ToArray();
            byte[] sha256RsaOid = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b];
            for (var index = 0; index <= md5.Length - sha256RsaOid.Length; index++)
                if (md5.AsSpan(index, sha256RsaOid.Length).SequenceEqual(sha256RsaOid)) md5[index + sha256RsaOid.Length - 1] = 0x04;
            using var weakSignature = X509CertificateLoader.LoadCertificate(md5);
            Reject(() => certificates.Trust(new(Convert.ToBase64String(md5), weakSignature.GetCertHashString(HashAlgorithmName.SHA256))), "MD5 RSA signature rejected despite a 2048-bit key");
            var pssRequest = new CertificateRequest("CN=Unsupported PSS Fixture", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
            using var pss = pssRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
            Reject(() => certificates.Trust(new(Convert.ToBase64String(pss.Export(X509ContentType.Cert)), pss.GetCertHashString(HashAlgorithmName.SHA256))), "PSS rejected until digest parameters have a supported validator");
            using var ecKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            foreach (var algorithm in new[] { HashAlgorithmName.SHA256, HashAlgorithmName.SHA384, HashAlgorithmName.SHA512 })
            {
                var modern = new CertificateRequest("CN=Modern EC Fixture", ecKey, algorithm);
                using var ec = modern.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
                var ecBytes = ec.Export(X509ContentType.Cert); var ecHash = ec.GetCertHashString(HashAlgorithmName.SHA256);
                certificates.Trust(new(Convert.ToBase64String(ecBytes), ecHash));
                Check(certificates.Download("trusted", ecHash).SequenceEqual(ecBytes), "modern ECDSA " + algorithm.Name + " accepted");
                certificates.Remove(ecHash, new(ecHash));
            }
            Reject(() => certificates.Download("../own/private", hash), "private/traversal stores unavailable");
            Reject(() => certificates.Trust(new(Convert.ToBase64String(certificate.Export(X509ContentType.Pkcs12)), hash)), "PKCS12/private keys are never imported");
            Reject(() => certificates.Remove(hash, new(new string('0', 64))), "remove requires matching confirmation");
            certificates.Remove(hash, new(hash)); Reject(() => certificates.Download("trusted", hash), "unrelated malformed certificate does not block trust removal");
            using var expired = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-5), DateTimeOffset.UtcNow.AddDays(-1));
            Reject(() => certificates.Trust(new(Convert.ToBase64String(expired.Export(X509ContentType.Cert)), expired.GetCertHashString(HashAlgorithmName.SHA256))), "expired certificate rejected");
        }
        finally { Directory.Delete(directory, true); }
        return passed;
    }
}
