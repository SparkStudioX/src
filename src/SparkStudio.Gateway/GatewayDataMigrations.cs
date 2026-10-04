using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Validates the current gateway format while the data lease is held; unsupported tag formats are never rewritten.</summary>
public static class GatewayDataMigrations
{
    public const int CurrentVersion = TagModel.FormatVersion;
    public static void Prepare(string directory)
    {
        var manifestPath = Path.Combine(directory, "gateway-format.json");
        RecoveryFileSystem.RejectLinks(manifestPath);
        var manifest = File.Exists(manifestPath) ? Read(manifestPath) as JsonObject ?? throw new InvalidDataException("Gateway format manifest must be an object.") : null;
        if (manifest is not null && (manifest["version"] is not JsonValue version || !version.TryGetValue<int>(out var number) || number != CurrentVersion))
            throw new InvalidDataException("This gateway data format is unsupported. Use a current-format data directory; automatic tag migration is not available.");

        var tagsPath = Path.Combine(directory, "tags.json");
        RecoveryFileSystem.RejectLinks(tagsPath);
        if (File.Exists(tagsPath)) TagModel.RequireCurrentFormat(Read(tagsPath));
        if (manifest is null)
            DurableJsonFile.Write(manifestPath, new JsonObject { ["version"] = CurrentVersion, ["updatedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["minimumFormatReader"] = CurrentVersion });
    }

    private static JsonNode Read(string path)
    {
        if (new FileInfo(path).Length > 32 * 1024 * 1024) throw new InvalidDataException("Gateway format document exceeds 32 MiB.");
        return JsonNode.Parse(File.ReadAllText(path)) ?? throw new InvalidDataException("Gateway format document is empty.");
    }
}
