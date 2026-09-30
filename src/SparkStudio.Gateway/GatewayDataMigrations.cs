using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Forward-only, restartable local format upgrades run while the gateway data lease is held.</summary>
public static class GatewayDataMigrations
{
    public const int CurrentVersion = 2;
    public static void Prepare(string directory)
    {
        var manifestPath = Path.Combine(directory, "gateway-format.json");
        RecoveryFileSystem.RejectLinks(manifestPath);
        var manifest = File.Exists(manifestPath) ? Read(manifestPath) as JsonObject ?? throw new InvalidDataException("Gateway format manifest must be an object.") : null;
        var version = manifest?["version"]?.GetValue<int>() ?? 1;
        if (version is < 1 or > CurrentVersion) throw new InvalidDataException("This gateway data format requires another SparkStudio version. Restore a compatible backup; do not downgrade live data.");
        if (version == CurrentVersion) return;

        // Version 1 accepted legacy flat tag arrays; version 2 writes an explicit tag model.
        // Do not touch project publications or activate scripts during a data upgrade.
        var tagsPath = Path.Combine(directory, "tags.json");
        RecoveryFileSystem.RejectLinks(tagsPath);
        var tags = File.Exists(tagsPath) ? Read(tagsPath) : null;
        if (tags is not null && tags is not JsonArray && (tags is not JsonObject model || model["version"]?.GetValue<int>() != 2))
            throw new InvalidDataException("Tag configuration is not a supported migration source. Restore its backup before retrying.");
        var backupDirectory = Path.Combine(directory, "migration-backups", "format-2");
        if (tags is JsonArray legacy)
        {
            RecoveryFileSystem.RejectLinks(backupDirectory); Directory.CreateDirectory(backupDirectory);
            var backup = Path.Combine(backupDirectory, "tags.json"); RecoveryFileSystem.RejectLinks(backup);
            if (!File.Exists(backup))
            {
                var bytes = File.ReadAllBytes(tagsPath);
                using (var stream = new FileStream(backup, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(bytes); stream.Flush(true); }
                DurableJsonFile.Write(Path.Combine(backupDirectory, "receipt.json"), new JsonObject { ["from"] = 1, ["to"] = 2, ["file"] = "tags.json", ["sha256"] = Convert.ToHexString(SHA256.HashData(bytes)), ["createdAt"] = DateTimeOffset.UtcNow.ToString("O") });
            }
            else if (Read(backup) is not JsonArray) throw new InvalidDataException("The preserved tag migration backup is invalid.");
            var upgraded = TagModel.Empty(); upgraded["tags"] = legacy.DeepClone();
            // Atomic replacement is restartable. If the process stops before the marker,
            // the next startup accepts the already upgraded document and finishes it.
            DurableJsonFile.Write(tagsPath, upgraded);
        }
        DurableJsonFile.Write(manifestPath, new JsonObject { ["version"] = CurrentVersion, ["updatedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["minimumFormatReader"] = CurrentVersion });
    }

    private static JsonNode Read(string path)
    {
        if (new FileInfo(path).Length > 32 * 1024 * 1024) throw new InvalidDataException("Gateway migration source exceeds 32 MiB.");
        return JsonNode.Parse(File.ReadAllText(path)) ?? throw new InvalidDataException("Gateway migration source is empty.");
    }
}
