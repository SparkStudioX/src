using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public sealed partial class PublicationStore
{
    private const int MaximumRecordBytes = 16 * 1024 * 1024;
    private const int MaximumPublicationBytes = 32 * 1024 * 1024;
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
        if (publication?["history"] is null) return [];
        if (publication["history"] is not JsonArray records || records.Count > 20) throw new InvalidOperationException("Invalid publication history.");
        var result = records.Select(item => item as JsonObject ?? throw new InvalidOperationException("Invalid publication history entry.")).ToArray();
        foreach (var record in result) ValidateRecord(record);
        return result;
    }
    public JsonObject History()
    {
        lock (gate)
        {
            var records = HistoryRecords();
            var warnings = HistoryWarnings();
            if (publication is not null && !publication.ContainsKey("history"))
            {
                try { MakeRecord(publication); }
                catch (OversizedPublicationRecordException)
                {
                    warnings.Add("The current legacy publication exceeds the 16 MiB history limit. Publishing a smaller valid version can replace it, but this legacy version cannot be retained for rollback. The current application remains active until publication succeeds.");
                }
            }
            return new JsonObject { ["current"] = Metadata(), ["retention"] = 20,
                ["warnings"] = warnings,
                ["scope"] = "Screen, template, style, project settings, button code and named-query snapshots. Script-library publications and gateway jobs are separate and are not rolled back.",
                ["entries"] = new JsonArray(records.Select(record => (JsonNode)new JsonObject {
                    ["id"] = record["id"]!.DeepClone(), ["recordedAt"] = record["recordedAt"]!.DeepClone(),
                    ["publishedAt"] = record["snapshot"]!["publishedAt"]!.DeepClone(),
                    ["revision"] = record["snapshot"]!["project"]!["revision"]!.DeepClone(),
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
            catch (OversizedPublicationRecordException) when (!publication.ContainsKey("history"))
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
        File.WriteAllBytes(path + ".tmp", bytes);
        File.Move(path + ".tmp", path, true);
        publication = next;
    }
    public JsonObject Rollback(string id, string expectedPublishedAt)
    {
        lock (gate)
        {
            if (!Guid.TryParseExact(id, "N", out _)) throw new ArgumentException("Invalid publication history ID.");
            if (RequirePublication()["publishedAt"]!.GetValue<string>() != expectedPublishedAt)
                throw new InvalidOperationException("The operator publication changed. Refresh history before restoring a version.");
            var saved = HistoryRecords().FirstOrDefault(item => item["id"]?.GetValue<string>() == id)
                ?? throw new KeyNotFoundException("Publication history entry not found.");
            var snapshot = (JsonObject)saved["snapshot"]!.DeepClone();
            ValidateScreens(snapshot["project"]!.AsObject());
            ComponentQueryBindingValidator.ValidateQueries(snapshot["project"]!.AsObject(), snapshot["queries"]!.AsArray());
            snapshot["publishedAt"] = DateTimeOffset.UtcNow.ToString("O");
            CommitWithHistory(snapshot);
            return Metadata();
        }
    }
}

public sealed record PublicationRollbackRequest(string ExpectedPublishedAt);
