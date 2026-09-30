using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public sealed partial class PublicationStore
{
    private const int MaximumRecordBytes = 16 * 1024 * 1024;
    private const int MaximumPublicationBytes = 32 * 1024 * 1024;
    private JsonObject? validatedHistoryPublication;
    private WeakReference<JsonObject[]>? validatedHistoryRecords;
    public long HistoryValidationCount { get; private set; }
    private const string LegacyMigrationWarning = "A legacy publication exceeded the 16 MiB history limit and could not be retained when it was replaced. That legacy version is not available for rollback from this history.";
    private sealed class OversizedPublicationRecordException() : ArgumentException("A publication history snapshot exceeds the 16 MiB limit. Reduce project or query resources before publishing.");
    private static JsonObject BareSnapshot(JsonObject snapshot)
    {
        var copy = (JsonObject)snapshot.DeepClone(); copy.Remove("history"); copy.Remove("historyWarnings"); return copy;
    }
    private static string SnapshotHash(JsonObject snapshot) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(snapshot.ToJsonString(ProjectStore.Json))));
    private static void ValidateRecord(JsonObject record)
    {
        if (record["formatVersion"]?.GetValue<int>() != 1 || !Guid.TryParseExact(record["id"]?.GetValue<string>(), "N", out _) ||
            !DateTimeOffset.TryParse(record["recordedAt"]?.GetValue<string>(), out _) || record["snapshot"] is not JsonObject snapshot ||
            snapshot.ContainsKey("history") || snapshot.ContainsKey("historyWarnings") || record["sha256"]?.GetValue<string>() != SnapshotHash(snapshot))
            throw new InvalidOperationException("Publication history checksum or identity is invalid.");
        if (Encoding.UTF8.GetByteCount(record.ToJsonString(ProjectStore.Json)) > MaximumRecordBytes)
            throw new OversizedPublicationRecordException();
    }
    private JsonArray HistoryWarnings()
    {
        if (publication?["historyWarnings"] is null) return new JsonArray();
        if (publication["historyWarnings"] is not JsonArray warnings || warnings.Count > 20 || warnings.Any(item => item is not JsonValue value || !value.TryGetValue<string>(out var text) || string.IsNullOrWhiteSpace(text) || text.Length > 1024))
            throw new InvalidOperationException("Invalid publication history warnings.");
        return (JsonArray)warnings.DeepClone();
    }
    private JsonObject[] HistoryRecords()
    {
        if (publication is not null && ReferenceEquals(validatedHistoryPublication, publication) && validatedHistoryRecords?.TryGetTarget(out var cached) == true) return cached;
        if (!hasPersistedHistory) return [];
        if (new FileInfo(path).Length > MaximumPublicationBytes) throw new InvalidOperationException("The publication history exceeds its file-size limit.");
        var stored = JsonNode.Parse(File.ReadAllText(path))?.AsObject();
        if (stored?["history"] is not JsonArray records || records.Count > 20) throw new InvalidOperationException("Invalid publication history.");
        var result = records.Select(item => item as JsonObject ?? throw new InvalidOperationException("Invalid publication history entry.")).ToArray();
        foreach (var record in result) ValidateRecord(record);
        validatedHistoryPublication = publication;
        validatedHistoryRecords = new(result);
        HistoryValidationCount++;
        return result;
    }
    public JsonObject History()
    {
        lock (gate)
        {
            var records = HistoryRecords();
            var warnings = HistoryWarnings();
            if (publication is not null && !hasPersistedHistory)
            {
                try { MakeRecord(publication); }
                catch (OversizedPublicationRecordException)
                {
                    warnings.Add("The current legacy publication exceeds the 16 MiB history limit. Publishing a smaller valid version can replace it, but this legacy version cannot be retained for rollback. The current application remains active until publication succeeds.");
                }
            }
            return new JsonObject { ["current"] = Metadata(), ["retention"] = 20,
                ["warnings"] = warnings,
                ["scope"] = "Complete application snapshots include screens, templates, styles, project settings, button code, all named queries, Python libraries and gateway/browser script resources. Tags, connections, credentials and database data are external and are not restored.",
                ["entries"] = new JsonArray(records.Select(record => (JsonNode)new JsonObject {
                    ["id"] = record["id"]!.DeepClone(), ["recordedAt"] = record["recordedAt"]!.DeepClone(),
                    ["publishedAt"] = record["snapshot"]!["publishedAt"]!.DeepClone(),
                    ["revision"] = record["snapshot"]!["project"]!["revision"]!.DeepClone(),
                    ["scriptsRevision"] = record["snapshot"]!["scripts"]?["revision"]?.DeepClone(),
                    ["complete"] = record["snapshot"]!["scripts"] is JsonObject && record["snapshot"]!["legacyScriptCompatibility"]?.GetValue<bool>() != true,
                    ["name"] = record["snapshot"]!["project"]!["name"]!.DeepClone(),
                    ["current"] = publication?["publishedAt"]?.GetValue<string>() == record["snapshot"]!["publishedAt"]!.GetValue<string>()
                }).ToArray()) };
        }
    }
    private static JsonObject MakeRecord(JsonObject snapshot)
    {
        var bare = BareSnapshot(snapshot);
        var record = new JsonObject { ["formatVersion"] = 1, ["id"] = Guid.NewGuid().ToString("N"), ["recordedAt"] = DateTimeOffset.UtcNow.ToString("O"),
            ["sha256"] = SnapshotHash(bare), ["snapshot"] = bare };
        ValidateRecord(record); return record;
    }
    private void CommitWithHistory(JsonObject snapshot)
    {
        // Current publication and its history share one atomic file replacement.
        // Preflight every new record and the total byte budget before touching disk.
        var records = HistoryRecords().Select(item => (JsonObject)item.DeepClone()).ToList();
        var warnings = HistoryWarnings();
        if (publication is not null && !records.Any(item => item["snapshot"]?["publishedAt"]?.GetValue<string>() == publication["publishedAt"]?.GetValue<string>()))
        {
            try { records.Insert(0, MakeRecord(publication)); }
            catch (OversizedPublicationRecordException) when (!hasPersistedHistory)
            {
                // Pre-feature applications had no history-size admission limit.
                // Do not make an oversized old version impossible to replace.
                // The omission notice commits with the new application, never before it.
                if (!warnings.Any(item => item?.GetValue<string>() == LegacyMigrationWarning)) warnings.Add(LegacyMigrationWarning);
                while (warnings.Count > 20) warnings.RemoveAt(0);
            }
        }
        records.Insert(0, MakeRecord(snapshot));
        if (records.Count > 20) records.RemoveRange(20, records.Count - 20);
        var next = BareSnapshot(snapshot);
        if (warnings.Count > 0) next["historyWarnings"] = warnings;
        byte[] bytes;
        while (true)
        {
            next["history"] = new JsonArray(records.Select(item => item.DeepClone()).ToArray());
            bytes = Encoding.UTF8.GetBytes(next.ToJsonString(ProjectStore.Json));
            if (bytes.Length <= MaximumPublicationBytes) break;
            if (records.Count <= 1) throw new ArgumentException("The publication with its current history snapshot exceeds 32 MiB. Reduce project or query resources before publishing.");
            records.RemoveAt(records.Count - 1);
        }
        using (var staged = new FileStream(path + ".tmp", FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            staged.Write(bytes);
            staged.Flush(flushToDisk: true);
        }
        File.Move(path + ".tmp", path, true);
        hasPersistedHistory = next.Remove("history");
        publication = next;
        validatedHistoryPublication = null; validatedHistoryRecords = null;
    }
    public JsonObject Rollback(string id, string expectedPublishedAt, bool acknowledgeLegacy = false, bool allowExecutableChanges = true)
    {
        JsonObject result;
        lock (gate)
        {
            if (!Guid.TryParseExact(id, "N", out _)) throw new ArgumentException("Invalid publication history ID.");
            if (RequirePublication()["publishedAt"]!.GetValue<string>() != expectedPublishedAt)
                throw new InvalidOperationException("The operator publication changed. Refresh history before restoring a version.");
            var saved = HistoryRecords().FirstOrDefault(item => item["id"]?.GetValue<string>() == id)
                ?? throw new KeyNotFoundException("Publication history entry not found.");
            var snapshot = (JsonObject)saved["snapshot"]!.DeepClone();
            if (snapshot["scripts"] is not JsonObject || snapshot["legacyScriptCompatibility"]?.GetValue<bool>() == true)
            {
                if (!acknowledgeLegacy) throw new ArgumentException("This legacy snapshot excludes script resources. Review the compatibility warning and explicitly acknowledge the legacy restore.");
                // Preserve the active resources in the same durable replacement; never
                // silently switch back to an obsolete scripts-published.json file.
                snapshot["scripts"] = scripts?.CapturePublished() ?? new JsonObject { ["revision"] = 0, ["resources"] = new JsonArray() };
                snapshot["legacyScriptCompatibility"] = true;
            }
            snapshot["scripts"] = ScriptResourceStore.ValidatePublication(snapshot["scripts"]!.AsObject());
            ValidateScreens(snapshot["project"]!.AsObject());
            ComponentQueryBindingValidator.ValidateQueries(snapshot["project"]!.AsObject(), snapshot["queries"]!.AsArray());
            snapshot["publishedAt"] = DateTimeOffset.UtcNow.ToString("O");
            ExecutablePublication.RequireAllowed(publication, snapshot, allowExecutableChanges);
            CommitWithHistory(snapshot);
            result = Metadata();
        }
        scripts?.NotifyPublished();
        return result;
    }
}

public sealed record PublicationRollbackRequest(string ExpectedPublishedAt, bool AcknowledgeLegacy = false);
