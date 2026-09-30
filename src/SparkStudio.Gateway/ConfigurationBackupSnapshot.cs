using System.Diagnostics;
using System.Security.Cryptography;

namespace SparkStudio.Gateway;

/// <summary>A running host captures saved configuration, never live database or audit files.</summary>
public static class ConfigurationBackupSnapshot
{
    public const long MaximumBytes = 256L * 1024 * 1024;
    public const long MaximumFileBytes = 64L * 1024 * 1024;
    public static readonly TimeSpan CaptureTimeout = TimeSpan.FromSeconds(30);
    private static readonly HashSet<string> RootFiles = new(StringComparer.OrdinalIgnoreCase)
    {
        "projects.json", "connections.json", "tags.json", "deployment.json", "deployment.json.previous", "backup-settings.json",
        "project.json", "queries.json", "published.json", "scripts-draft.json", "scripts-published.json"
    };
    private static readonly HashSet<string> ProjectFiles = new(StringComparer.OrdinalIgnoreCase)
    { "project.json", "queries.json", "published.json", "scripts-draft.json", "scripts-published.json" };

    public static async Task<RecoveryReport> CreateAsync(string dataDirectory, string archivePath, string passphrase, CancellationToken cancellation = default)
    {
        var root = RecoveryFileSystem.LocalPath(dataDirectory);
        var archive = RecoveryFileSystem.LocalPath(archivePath);
        if (!Directory.Exists(root)) throw new DirectoryNotFoundException("The gateway data directory does not exist.");
        var work = Path.Combine(root, "backup-work");
        if (IsWithin(archive, root) && !IsWithin(archive, work))
            throw new ArgumentException("Place online archives outside gateway data or in its reserved backup-work directory.");
        if (File.Exists(archive) || Directory.Exists(archive)) throw new IOException("Choose a new archive filename.");
        RecoveryFileSystem.RejectLinks(work); Directory.CreateDirectory(work); RecoveryFileSystem.RejectLinks(work);
        var stage = Path.Combine(work, ".sparkstudio-config-" + Guid.NewGuid().ToString("N"));
        try
        {
            RecoveryFileSystem.CreatePrivateDirectory(stage);
            // An interrupted private staging directory must never start as an active gateway.
            using (var marker = new FileStream(Path.Combine(stage, GatewayRecovery.QuarantineFileName), FileMode.CreateNew, FileAccess.Write, FileShare.None))
            { marker.Write("{\"schemaVersion\":1,\"state\":\"configuration-staging\"}"u8); marker.Flush(flushToDisk: true); }
            var captured = await Task.Run(() => Capture(root, stage, cancellation), cancellation);
            // Configuration locks are released before password derivation, encryption and upload.
            return await GatewayRecovery.BackupConfigurationAsync(stage, archive, passphrase, captured.Excluded,
                captured.WasQuarantined, cancellation);
        }
        finally
        {
            if (Directory.Exists(stage))
            {
                if (Path.GetDirectoryName(stage) != work || !Path.GetFileName(stage).StartsWith(".sparkstudio-config-", StringComparison.Ordinal))
                    throw new InvalidOperationException("Unrecognized configuration staging path.");
                RecoveryFileSystem.RejectLinks(stage); Directory.Delete(stage, recursive: true);
            }
        }
    }

    private static (List<string> Excluded, bool WasQuarantined) Capture(string root, string stage, CancellationToken cancellation)
    {
        var clock = Stopwatch.StartNew();
        void CheckDeadline()
        {
            cancellation.ThrowIfCancellationRequested();
            if (clock.Elapsed > CaptureTimeout) throw new TimeoutException("Configuration capture exceeded 30 seconds; no backup was committed. Retry during a quieter period.");
        }
        var entered = false;
        var inputs = new List<(string Path, FileStream Stream)>();
        var buffer = new byte[GatewayRecovery.ChunkBytes];
        try
        {
            while (!(entered = Monitor.TryEnter(GatewayConfigurationLock.SyncRoot, 100))) CheckDeadline();
            CheckDeadline();
            var before = Inventory(root, CheckDeadline);
            long total = 0;
            foreach (var path in before.Included)
            {
                CheckDeadline();
                var input = RecoveryFileSystem.OpenSource(Path.Combine(root, path));
                inputs.Add((path, input));
                if (input.Length > MaximumFileBytes || (total += input.Length) > MaximumBytes)
                    throw new InvalidDataException("Online configuration backups support 64 MiB per file and 256 MiB total. Use the offline full backup for larger gateways.");
            }
            // Windows pinned read handles prevent replacement of keys/certificates written
            // by framework libraries outside the store gate. Opening an active writer fails
            // this attempt; a newly added file changes the final inventory and also fails it.
            foreach (var (path, input) in inputs)
            {
                var outputPath = Path.Combine(stage, path);
                Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
                using var output = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                var remaining = input.Length;
                while (remaining > 0)
                {
                    CheckDeadline();
                    var count = (int)Math.Min(buffer.Length, remaining);
                    input.ReadExactly(buffer.AsSpan(0, count)); output.Write(buffer, 0, count); remaining -= count;
                }
                if (input.ReadByte() != -1) throw new IOException("Configuration changed during capture; no backup was committed.");
            }
            var after = Inventory(root, CheckDeadline);
            if (!before.Included.SequenceEqual(after.Included, StringComparer.Ordinal))
                throw new IOException("Configuration files changed during capture; no backup was committed. Retry after the writer finishes.");
            CheckDeadline();
            return (before.Excluded, File.Exists(Path.Combine(root, GatewayRecovery.QuarantineFileName)) || Directory.Exists(Path.Combine(root, GatewayRecovery.QuarantineFileName)));
        }
        finally
        {
            foreach (var input in inputs) input.Stream.Dispose();
            CryptographicOperations.ZeroMemory(buffer);
            if (entered) Monitor.Exit(GatewayConfigurationLock.SyncRoot);
        }
    }

    private sealed record FileInventory(string[] Included, List<string> Excluded);
    private static FileInventory Inventory(string root, Action check)
    {
        var included = new List<string>(); var excluded = new List<string>();
        var directories = new Stack<string>(); directories.Push(root); var count = 0;
        while (directories.TryPop(out var directory))
        foreach (var path in Directory.EnumerateFileSystemEntries(directory))
        {
            check();
            if (++count > GatewayRecovery.MaxDirectoryEntries) throw new InvalidDataException("Configuration directory entry limit exceeded.");
            var relative = Path.GetRelativePath(root, path).Replace('\\', '/');
            var isDirectory = Directory.Exists(path);
            if (!Selected(relative, isDirectory))
            { excluded.Add(relative + (isDirectory ? "/" : "")); continue; }
            RecoveryFileSystem.RejectLinks(path);
            GatewayRecovery.ValidateRelativePath(relative);
            if (isDirectory) { directories.Push(path); continue; }
            if (included.Count >= GatewayRecovery.MaxFiles) throw new InvalidDataException("Configuration file count limit exceeded.");
            included.Add(relative);
        }
        return new(included.Order(StringComparer.Ordinal).ToArray(), excluded.Order(StringComparer.Ordinal).ToList());
    }

    private static bool Selected(string path, bool directory)
    {
        var parts = path.Split('/');
        var first = parts[0];
        if (parts.Length == 1)
            return directory ? first is "projects" or "assets" or "security" or "keys" or "pki" or "certificates" : RootFiles.Contains(first);
        if (first is "pki" or "certificates") return true;
        if (first == "keys") return directory || path.EndsWith(".xml", StringComparison.OrdinalIgnoreCase);
        if (first == "security") return parts.Length == 2 && !directory && parts[1] == "identities.json";
        if (first == "assets") return parts.Length == 2 && !directory && AssetExtension(parts[1]);
        if (first != "projects" || parts[1].StartsWith('.')) return false;
        if (parts.Length == 2) return directory;
        if (parts.Length == 3) return directory ? parts[2] == "assets" : ProjectFiles.Contains(parts[2]);
        return parts.Length == 4 && parts[2] == "assets" && !directory && AssetExtension(parts[3]);
    }
    private static bool AssetExtension(string path) => path.EndsWith(".json", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".bin", StringComparison.OrdinalIgnoreCase);
    private static bool IsWithin(string path, string directory) => path.Equals(directory, StringComparison.OrdinalIgnoreCase)
        || path.StartsWith(Path.TrimEndingDirectorySeparator(directory) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
}
