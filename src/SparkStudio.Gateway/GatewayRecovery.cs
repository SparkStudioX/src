using System.Buffers.Binary;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace SparkStudio.Gateway;

public sealed record RecoveryFile(string Path, long Length, string Sha256, string Category);
public sealed record RecoveryManifest(int SchemaVersion, string ArchiveId, string CreatedAtUtc, string SourceVersion,
    string SourcePlatform, bool SourceWasQuarantined, string SecretPortability, long TotalBytes, List<RecoveryFile> Files,
    string Scope = "full", List<string>? ExcludedPaths = null);
public sealed record RecoveryReport(string ArchiveId, string CreatedAtUtc, string SourceVersion, string SourcePlatform,
    int FileCount, long TotalBytes, string SecretPortability, bool SourceWasQuarantined, IReadOnlyDictionary<string, int> Categories,
    string Scope = "full", IReadOnlyList<string>? ExcludedPaths = null);

/// <summary>Offline authenticated snapshots; this never loads gateway stores or executes project code.</summary>
public static class GatewayRecovery
{
    public const int FormatVersion = 1, MaxFiles = 10000, MaxManifestBytes = 8 * 1024 * 1024, ChunkBytes = 1024 * 1024;
    internal const int MaxDirectoryEntries = MaxFiles * 2 + 2;
    public const long MaxFileBytes = 2L * 1024 * 1024 * 1024, MaxTotalBytes = 8L * 1024 * 1024 * 1024;
    public const string QuarantineFileName = "recovery-quarantine.json";
    public const string PortabilityPolicy = "Opaque source keyring and protected secrets are preserved. Windows DPAPI requires the original machine and Windows account; archive encryption does not rewrap those keys. Sessions, external databases, installed binaries, environment and service registration are not included.";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow, RespectRequiredConstructorParameters = true, MaxDepth = 16 };

    public static Task<RecoveryReport> BackupAsync(string dataDirectory, string archivePath, string passphrase, CancellationToken cancellation = default)
        => BackupCoreAsync(dataDirectory, archivePath, passphrase, "full", ["backup-work/"], null, cancellation);

    internal static Task<RecoveryReport> BackupConfigurationAsync(string stagedDirectory, string archivePath, string passphrase,
        List<string> excludedPaths, bool sourceWasQuarantined, CancellationToken cancellation)
        => BackupCoreAsync(stagedDirectory, archivePath, passphrase, "configuration", excludedPaths, sourceWasQuarantined, cancellation);

    private static async Task<RecoveryReport> BackupCoreAsync(string dataDirectory, string archivePath, string passphrase,
        string scope, List<string> excludedPaths, bool? sourceWasQuarantined, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        var root = RecoveryFileSystem.LocalPath(dataDirectory);
        var archive = RecoveryFileSystem.LocalPath(archivePath);
        RequireArchiveOutsideData(root, archive);
        if (File.Exists(archive) || Directory.Exists(archive)) throw new IOException("The backup archive already exists; choose a new filename.");
        var parent = Path.GetDirectoryName(archive)!;
        if (!Directory.Exists(parent)) throw new DirectoryNotFoundException("Create the archive destination directory first.");
        using var lease = DataDirectoryLease.Acquire(root, createDirectory: false);
        var inventory = Inventory(root, cancellation);
        var entries = new List<RecoveryFile>();
        long total = 0;
        foreach (var file in inventory)
        {
            cancellation.ThrowIfCancellationRequested();
            using var input = RecoveryFileSystem.OpenSource(Path.Combine(root, file));
            var length = input.Length;
            if (length > MaxFileBytes || (total += length) > MaxTotalBytes) throw new InvalidDataException("The data directory exceeds backup size limits.");
            var digest = await SHA256.HashDataAsync(input, cancellation);
            entries.Add(new RecoveryFile(file, length, Convert.ToHexString(digest).ToLowerInvariant(), Category(file)));
        }
        var manifest = new RecoveryManifest(FormatVersion, Guid.NewGuid().ToString("N"), DateTimeOffset.UtcNow.ToString("O"),
            typeof(GatewayRecovery).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown",
            OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "macos" : "linux",
            sourceWasQuarantined ?? (File.Exists(Path.Combine(root, QuarantineFileName)) || Directory.Exists(Path.Combine(root, QuarantineFileName))), PortabilityPolicy, total, entries,
            scope, excludedPaths);
        ValidateManifest(manifest);
        var manifestBytes = JsonSerializer.SerializeToUtf8Bytes(manifest, Json);
        if (manifestBytes.Length > MaxManifestBytes) throw new InvalidDataException("The backup manifest exceeds its size limit.");
        var temporary = Path.Combine(parent, ".sparkbak-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, ChunkBytes, FileOptions.Asynchronous))
            using (var records = RecoveryRecords.Create(output, passphrase))
            {
                records.Write(1, manifestBytes);
                var buffer = new byte[ChunkBytes];
                try
                {
                    foreach (var file in entries)
                    {
                        using var input = RecoveryFileSystem.OpenSource(Path.Combine(root, file.Path));
                        if (input.Length != file.Length) throw new IOException("Gateway data changed during backup; no archive was committed.");
                        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                        var remaining = file.Length;
                        while (remaining > 0)
                        {
                            cancellation.ThrowIfCancellationRequested();
                            var length = (int)Math.Min(buffer.Length, remaining);
                            await input.ReadExactlyAsync(buffer.AsMemory(0, length), cancellation);
                            hash.AppendData(buffer, 0, length);
                            records.Write(2, buffer.AsSpan(0, length));
                            remaining -= length;
                        }
                        if (input.ReadByte() != -1 || !DigestMatches(hash.GetHashAndReset(), file.Sha256))
                            throw new IOException("Gateway data changed during backup; no archive was committed.");
                    }
                    if (!inventory.SequenceEqual(Inventory(root, cancellation), StringComparer.Ordinal))
                        throw new IOException("Gateway data paths changed during backup; no archive was committed.");
                    cancellation.ThrowIfCancellationRequested();
                    records.Write(3, ReadOnlySpan<byte>.Empty);
                    await output.FlushAsync(cancellation);
                    output.Flush(flushToDisk: true);
                }
                finally { CryptographicOperations.ZeroMemory(buffer); }
            }
            RecoveryFileSystem.RejectLinks(archive);
            cancellation.ThrowIfCancellationRequested();
            File.Move(temporary, archive, overwrite: false);
            return Report(manifest);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(manifestBytes);
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    public static Task<RecoveryReport> InspectAsync(string archivePath, string passphrase, CancellationToken cancellation = default)
        => ReadArchiveAsync(archivePath, passphrase, null, cancellation);

    public static async Task<RecoveryReport> RestoreAsync(string archivePath, string newDataDirectory, string passphrase, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        var destination = RecoveryFileSystem.LocalPath(newDataDirectory);
        var archive = RecoveryFileSystem.LocalPath(archivePath);
        RequireArchiveOutsideData(destination, archive);
        if (Directory.Exists(destination) || File.Exists(destination)) throw new IOException("Restore requires a new, nonexistent data directory; existing data is never replaced or merged.");
        var parent = Path.GetDirectoryName(destination)!;
        if (!Directory.Exists(parent)) throw new DirectoryNotFoundException("Create the restore parent directory first.");
        var stage = Path.Combine(parent, ".sparkstudio-restore-" + Guid.NewGuid().ToString("N"));
        var committed = false;
        try
        {
            RecoveryFileSystem.CreatePrivateDirectory(stage);
            WriteDurableMarker(stage, "{\"schemaVersion\":1,\"state\":\"restoring\"}"u8.ToArray());
            // A staging tree is not a runnable data directory. Keep its lease
            // while decrypting; the final destination does not exist until commit.
            RecoveryReport report;
            using (DataDirectoryLease.Acquire(stage))
            {
                report = await ReadArchiveAsync(archive, passphrase, stage, cancellation);
                var marker = JsonSerializer.SerializeToUtf8Bytes(new
                {
                    schemaVersion = 1, archiveId = report.ArchiveId, restoredAtUtc = DateTimeOffset.UtcNow.ToString("O"),
                    sourceVersion = report.SourceVersion, sourcePlatform = report.SourcePlatform,
                    fileCount = report.FileCount, totalBytes = report.TotalBytes, state = "quarantined",
                    scope = report.Scope, excludedPaths = ReceiptExclusions(report.ExcludedPaths),
                    excludedPathCount = report.ExcludedPaths?.Count ?? 0
                }, Json);
                cancellation.ThrowIfCancellationRequested();
                WriteDurableMarker(stage, marker);
            }
            cancellation.ThrowIfCancellationRequested();
            RecoveryFileSystem.RejectLinks(destination);
            Directory.Move(stage, destination); // Same-parent rename; never overwrite an existing destination.
            committed = true;
            return report;
        }
        finally
        {
            if (!committed && Directory.Exists(stage)) RecoveryFileSystem.RemoveOwnedStage(stage, parent);
        }
    }

    private static async Task<RecoveryReport> ReadArchiveAsync(string archivePath, string passphrase, string? stage, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        using var input = RecoveryFileSystem.OpenSource(RecoveryFileSystem.LocalPath(archivePath));
        if (input.Length > MaxTotalBytes + 32L * 1024 * 1024) throw new InvalidDataException("The archive exceeds the recovery size limit.");
        using var records = RecoveryRecords.Open(input, passphrase);
        var bytes = records.Read(1, MaxManifestBytes);
        RecoveryManifest manifest;
        try
        {
            RejectDuplicateJsonProperties(bytes);
            manifest = JsonSerializer.Deserialize<RecoveryManifest>(bytes, Json) ?? throw new InvalidDataException("The archive manifest is missing.");
            ValidateManifest(manifest);
        }
        catch (JsonException error) { throw new InvalidDataException("The archive manifest is invalid or has unsupported fields.", error); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
        foreach (var file in manifest.Files)
        {
            cancellation.ThrowIfCancellationRequested();
            FileStream? output = null;
            try
            {
                if (stage is not null)
                {
                    var path = Path.Combine(stage, file.Path);
                    RecoveryFileSystem.RejectLinks(path);
                    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                    output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, ChunkBytes, FileOptions.Asynchronous);
                }
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                var remaining = file.Length;
                while (remaining > 0)
                {
                    cancellation.ThrowIfCancellationRequested();
                    var expected = (int)Math.Min(ChunkBytes, remaining);
                    var content = records.Read(2, expected);
                    try
                    {
                        if (content.Length != expected) throw new InvalidDataException("An archive file record has an unexpected length.");
                        hash.AppendData(content);
                        if (output is not null) await output.WriteAsync(content, cancellation);
                        remaining -= content.Length;
                    }
                    finally { CryptographicOperations.ZeroMemory(content); }
                }
                if (!DigestMatches(hash.GetHashAndReset(), file.Sha256)) throw new InvalidDataException("An archive file failed its content digest check.");
                if (output is not null) { await output.FlushAsync(cancellation); output.Flush(flushToDisk: true); }
            }
            finally { if (output is not null) await output.DisposeAsync(); }
        }
        var final = records.Read(3, 0);
        if (final.Length != 0 || input.ReadByte() != -1) throw new InvalidDataException("The archive has unexpected trailing content.");
        cancellation.ThrowIfCancellationRequested();
        return Report(manifest);
    }

    internal static string[] Inventory(string root, CancellationToken cancellation, int entryLimit = MaxDirectoryEntries)
    {
        if (entryLimit is < 1 or > MaxDirectoryEntries) throw new ArgumentOutOfRangeException(nameof(entryLimit));
        var result = new List<string>();
        var directories = new Stack<string>(); directories.Push(root);
        var visited = 0;
        while (directories.TryPop(out var directory))
        {
            foreach (var path in Directory.EnumerateFileSystemEntries(directory))
            {
                cancellation.ThrowIfCancellationRequested();
                if (++visited > entryLimit) throw new InvalidDataException("The data directory exceeds the recovery directory-entry limit.");
                RecoveryFileSystem.RejectLinks(path);
                var relative = Path.GetRelativePath(root, path).Replace('\\', '/');
                if (relative is DataDirectoryLease.FileName or QuarantineFileName or "backup-work") continue;
                ValidateRelativePath(relative);
                if (Directory.Exists(path)) { directories.Push(path); continue; }
                if (result.Count >= MaxFiles) throw new InvalidDataException("The data directory exceeds the backup file-count limit.");
                result.Add(relative);
            }
        }
        var ordered = result.Order(StringComparer.Ordinal).ToArray();
        if (ordered.Distinct(StringComparer.OrdinalIgnoreCase).Count() != ordered.Length)
            throw new InvalidDataException("Data paths collide when compared without case; this backup would not be portable.");
        return ordered;
    }

    internal static void ValidateManifest(RecoveryManifest manifest)
    {
        if (manifest.SchemaVersion != FormatVersion || !Guid.TryParseExact(manifest.ArchiveId, "N", out _) ||
            !DateTimeOffset.TryParse(manifest.CreatedAtUtc, out _) || string.IsNullOrWhiteSpace(manifest.SourceVersion) || manifest.SourceVersion.Length > 200 ||
            manifest.SourcePlatform is not ("windows" or "linux" or "macos") || manifest.SecretPortability != PortabilityPolicy ||
            manifest.Files is null || manifest.Files.Count > MaxFiles || manifest.TotalBytes is < 0 or > MaxTotalBytes ||
            manifest.Scope is not ("full" or "configuration") || (manifest.ExcludedPaths?.Count ?? 0) > MaxDirectoryEntries ||
            manifest.ExcludedPaths?.Any(path => string.IsNullOrEmpty(path) || path.Length > 1001 || path.Any(char.IsControl)) == true)
            throw new InvalidDataException("The archive manifest uses invalid or unsupported metadata.");
        var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        foreach (var file in manifest.Files)
        {
            if (file is null) throw new InvalidDataException("The manifest contains a missing file entry.");
            ValidateRelativePath(file.Path);
            if (!files.Add(file.Path) || directories.Contains(file.Path) || file.Length is < 0 or > MaxFileBytes ||
                file.Sha256 is null || !Regex.IsMatch(file.Sha256, "\\A[0-9a-f]{64}\\z", RegexOptions.CultureInvariant) || file.Category != Category(file.Path))
                throw new InvalidDataException("The manifest contains an invalid or duplicate file entry.");
            for (var slash = file.Path.IndexOf('/'); slash >= 0; slash = file.Path.IndexOf('/', slash + 1))
            {
                var parent = file.Path[..slash];
                if (files.Contains(parent)) throw new InvalidDataException("Archive file and directory paths collide.");
                if (directories.TryGetValue(parent, out var existing) && !existing.Equals(parent, StringComparison.Ordinal))
                    throw new InvalidDataException("Archive directory names collide when compared without case.");
                directories.Add(parent);
            }
            total += file.Length;
            if (total > MaxTotalBytes) throw new InvalidDataException("The archive data exceeds its size limit.");
        }
        if (total != manifest.TotalBytes) throw new InvalidDataException("The archive total does not match its file entries.");
    }

    internal static void ValidateRelativePath(string path)
    {
        if (string.IsNullOrEmpty(path) || path.Length > 1000 || path != path.Normalize(NormalizationForm.FormC) || path.Contains('\\') || path.Contains(':') || path.StartsWith('/') ||
            path.Equals(DataDirectoryLease.FileName, StringComparison.OrdinalIgnoreCase) || path.Equals(QuarantineFileName, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("A recovery path is invalid or reserved.");
        var parts = path.Split('/');
        if (parts[0].Equals(DataDirectoryLease.FileName, StringComparison.OrdinalIgnoreCase) || parts[0].Equals(QuarantineFileName, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Recovery control paths are reserved.");
        if (parts.Length > 16 || parts.Any(part => part.Length is 0 or > 150 || part is "." or ".." || part.EndsWith('.') || part.EndsWith(' ') ||
            part.Any(character => character < ' ' || character is '<' or '>' or '"' or '|' or '?' or '*') ||
            Regex.IsMatch(part.Split('.')[0], "\\A(CON|PRN|AUX|NUL|CLOCK\\$|CONIN\\$|CONOUT\\$|COM[0-9¹²³]|LPT[0-9¹²³])\\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)))
            throw new InvalidDataException("A recovery path cannot be represented safely on supported filesystems.");
    }

    private static void RejectDuplicateJsonProperties(byte[] bytes)
    {
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 16 });
        Visit(document.RootElement);
        static void Visit(JsonElement element)
        {
            if (element.ValueKind == JsonValueKind.Object)
            {
                var names = new HashSet<string>(StringComparer.Ordinal);
                foreach (var property in element.EnumerateObject())
                { if (!names.Add(property.Name)) throw new InvalidDataException("The archive manifest contains duplicate JSON fields."); Visit(property.Value); }
            }
            else if (element.ValueKind == JsonValueKind.Array) foreach (var item in element.EnumerateArray()) Visit(item);
        }
    }

    private static void RequireArchiveOutsideData(string root, string archive)
    {
        if (archive.Equals(root, StringComparison.OrdinalIgnoreCase) || archive.StartsWith(Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Keep the archive outside the gateway data directory.");
    }
    private static bool DigestMatches(byte[] bytes, string expected) => CryptographicOperations.FixedTimeEquals(bytes, Convert.FromHexString(expected));
    private static string[] ReceiptExclusions(IReadOnlyList<string>? paths)
    {
        var result = new List<string>(); var bytes = 2;
        foreach (var path in paths ?? [])
        {
            // The manifest keeps every exclusion; a small receipt preview must fit
            // even when JSON escaping makes Unicode names larger than their length.
            var size = JsonSerializer.SerializeToUtf8Bytes(path, Json).Length + 1;
            if (result.Count >= 32 || bytes + size > 4096) break;
            result.Add(path); bytes += size;
        }
        return result.ToArray();
    }
    private static void WriteDurableMarker(string directory, byte[] bytes)
    {
        using var file = new FileStream(Path.Combine(directory, QuarantineFileName), FileMode.Create, FileAccess.Write, FileShare.None);
        file.Write(bytes); file.Flush(flushToDisk: true);
    }
    private static string Category(string path) => path.Split('/')[0] switch
    {
        "security" => "accounts-and-audit", "keys" => "keyring", "projects" or "projects.json" => "projects",
        "databases" => "managed-databases", "pki" or "certificates" => "certificates", "connections.json" => "connections",
        "tags.json" => "tags", "deployment.json" or "deployment.json.previous" => "deployment",
        "model-publishing.json" => "model-publishing", "model-publishing-queue" => "outgoing-model-messages",
        "project.json" or "queries.json" or "published.json" or "scripts-draft.json" or "scripts-published.json" or "assets" => "legacy-project-data",
        _ => "additional-local-data"
    };
    private static RecoveryReport Report(RecoveryManifest value) => new(value.ArchiveId, value.CreatedAtUtc, value.SourceVersion,
        value.SourcePlatform, value.Files.Count, value.TotalBytes, value.SecretPortability, value.SourceWasQuarantined,
        value.Files.GroupBy(file => file.Category).ToDictionary(group => group.Key, group => group.Count(), StringComparer.Ordinal),
        value.Scope, value.ExcludedPaths ?? []);
}

/// <summary>Sequence-bound AES-GCM records; no compression or plaintext temporary archive.</summary>
internal sealed class RecoveryRecords : IDisposable
{
    private const int HeaderBytes = 56, Iterations = 600000;
    private readonly Stream stream;
    private readonly byte[] header, key;
    private readonly AesGcm cipher;
    private uint sequence;
    private RecoveryRecords(Stream stream, byte[] header, string passphrase)
    {
        if (passphrase.Length is < 12 or > 1024) throw new ArgumentException("Use a recovery passphrase of 12–1024 characters.");
        this.stream = stream; this.header = header;
        var password = Encoding.UTF8.GetBytes(passphrase);
        try { key = Rfc2898DeriveBytes.Pbkdf2(password, header.AsSpan(16, 32), Iterations, HashAlgorithmName.SHA256, 32); }
        finally { CryptographicOperations.ZeroMemory(password); }
        cipher = new AesGcm(key, 16);
    }
    internal static RecoveryRecords Create(Stream output, string passphrase)
    {
        var header = new byte[HeaderBytes]; "SPARKBAK"u8.CopyTo(header);
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(8), 1);
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(12), Iterations);
        RandomNumberGenerator.Fill(header.AsSpan(16));
        var result = new RecoveryRecords(output, header, passphrase);
        try { output.Write(header); return result; } catch { result.Dispose(); throw; }
    }
    internal static RecoveryRecords Open(Stream input, string passphrase)
    {
        var header = new byte[HeaderBytes]; input.ReadExactly(header);
        if (!header.AsSpan(0, 8).SequenceEqual("SPARKBAK"u8) || BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(8)) != 1 ||
            BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(12)) != Iterations)
            throw new InvalidDataException("The archive header, format version or key-derivation policy is unsupported.");
        return new RecoveryRecords(input, header, passphrase);
    }
    internal void Write(byte kind, ReadOnlySpan<byte> content)
    {
        var nonce = Nonce(); var aad = AssociatedData(kind, content.Length);
        var encrypted = new byte[content.Length]; Span<byte> tag = stackalloc byte[16];
        cipher.Encrypt(nonce, content, encrypted, tag, aad);
        stream.Write(aad.AsSpan(HeaderBytes + 4, 5)); stream.Write(encrypted); stream.Write(tag);
        sequence = checked(sequence + 1);
    }
    internal byte[] Read(byte expectedKind, int maximum)
    {
        Span<byte> prefix = stackalloc byte[5]; stream.ReadExactly(prefix);
        var length = BinaryPrimitives.ReadInt32LittleEndian(prefix[1..]);
        if (prefix[0] != expectedKind || length < 0 || length > maximum) throw new InvalidDataException("The archive contains an unsupported or oversized record.");
        var content = new byte[length]; var encrypted = new byte[length]; Span<byte> tag = stackalloc byte[16];
        stream.ReadExactly(encrypted); stream.ReadExactly(tag);
        try
        {
            cipher.Decrypt(Nonce(), encrypted, tag, content, AssociatedData(prefix[0], length));
            sequence = checked(sequence + 1);
            return content;
        }
        catch (CryptographicException error)
        { CryptographicOperations.ZeroMemory(content); throw new InvalidDataException("The archive cannot be authenticated. The passphrase is incorrect or the archive is damaged.", error); }
    }
    private byte[] Nonce()
    { var nonce = new byte[12]; header.AsSpan(48, 8).CopyTo(nonce); BinaryPrimitives.WriteUInt32LittleEndian(nonce.AsSpan(8), sequence); return nonce; }
    private byte[] AssociatedData(byte kind, int length)
    {
        var aad = new byte[HeaderBytes + 9]; header.CopyTo(aad, 0);
        BinaryPrimitives.WriteUInt32LittleEndian(aad.AsSpan(HeaderBytes), sequence); aad[HeaderBytes + 4] = kind;
        BinaryPrimitives.WriteInt32LittleEndian(aad.AsSpan(HeaderBytes + 5), length); return aad;
    }
    public void Dispose() { cipher.Dispose(); CryptographicOperations.ZeroMemory(key); }
}

internal static class RecoveryFileSystem
{
    internal static string LocalPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Any(character => character < ' ') || path.StartsWith(@"\\", StringComparison.Ordinal))
            throw new ArgumentException("Use an ordinary local filesystem path for recovery.");
        var result = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        if (result == Path.GetPathRoot(result)) throw new ArgumentException("A filesystem root cannot be a recovery target.");
        RejectLinks(result); return result;
    }
    internal static void RejectLinks(string path)
    {
        for (string? current = Path.GetFullPath(path); current is not null; current = Path.GetDirectoryName(current))
        {
            try { if ((File.GetAttributes(current) & (FileAttributes.ReparsePoint | FileAttributes.Device)) != 0) throw new InvalidDataException("Recovery paths cannot contain symbolic links, junctions, devices or reparse points."); }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
        }
    }
    internal static FileStream OpenSource(string path)
    {
        RejectLinks(path);
        var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, GatewayRecovery.ChunkBytes, FileOptions.Asynchronous);
        try { CheckOrdinaryFile(stream); return stream; } catch { stream.Dispose(); throw; }
    }
    internal static void CheckOrdinaryFile(FileStream stream)
    {
        if (!stream.CanSeek) throw new InvalidDataException("Recovery accepts only ordinary seekable files.");
        if (OperatingSystem.IsWindows())
        {
            if (!GetFileInformationByHandle(stream.SafeFileHandle, out var value)) throw new System.ComponentModel.Win32Exception();
            if (value.Links != 1 || (value.Attributes & (uint)(FileAttributes.ReparsePoint | FileAttributes.Directory | FileAttributes.Device)) != 0)
                throw new InvalidDataException("Recovery files cannot be hard links, directories or special files.");
        }
    }
    internal static void CreatePrivateDirectory(string path)
    {
        RejectLinks(path);
        if (Directory.Exists(path) || File.Exists(path)) throw new IOException("Recovery staging already exists.");
        if (OperatingSystem.IsWindows())
        {
            var identity = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("The recovery identity is unavailable.");
            var acl = new DirectorySecurity(); acl.SetAccessRuleProtection(true, false);
            foreach (var sid in new[] { identity, new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
                acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(path).Create(acl);
        }
        else Directory.CreateDirectory(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }
    internal static void RemoveOwnedStage(string stage, string parent)
    {
        if (!Path.GetDirectoryName(stage)!.Equals(parent, StringComparison.Ordinal) || !Path.GetFileName(stage).StartsWith(".sparkstudio-restore-", StringComparison.Ordinal))
            throw new InvalidOperationException("Refusing to remove an unrecognized recovery staging path.");
        RejectLinks(stage);
        Directory.Delete(stage, recursive: true);
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation
    {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation value);
}
