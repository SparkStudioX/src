using System.Text;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Bounded per-project history, replaced atomically; no invocation inputs are stored.</summary>
public sealed class ScriptRunJournal(string directory)
{
    private readonly string path = Path.Combine(directory, "script-event-runs.json");
    private readonly string appendPath = Path.Combine(directory, "script-event-runs.jsonl");
    private readonly object gate = new();
    public long AppendFlushCount { get; private set; }
    public JsonObject[] Load()
    {
        lock (gate) return LoadCore(recover: true);
    }
    private JsonObject[] LoadCore(bool recover)
    {
        RecoveryFileSystem.RejectLinks(path);
        if (File.Exists(path) && new FileInfo(path).Length > 8 * 1024 * 1024) throw new InvalidOperationException("The script execution journal exceeds its bounded file limit.");
        var document = File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path))?.AsObject() ?? throw new InvalidOperationException("The script execution journal is invalid.")
            : new JsonObject { ["version"] = 1, ["runs"] = new JsonArray() };
        if (document["version"]?.GetValue<int>() != 1 || document["runs"] is not JsonArray runs || runs.Count > 100 || runs.Any(item => item is not JsonObject))
            throw new InvalidOperationException("The script execution journal has an unsupported format.");
        var merged = runs.OfType<JsonObject>().Select(item => item.DeepClone().AsObject()).ToList();
        if (File.Exists(appendPath))
        {
            RecoveryFileSystem.RejectLinks(appendPath);
            if (new FileInfo(appendPath).Length > 16 * 1024 * 1024) throw new InvalidOperationException("The script append journal exceeds its bounded file limit.");
            var text = File.ReadAllText(appendPath); var lines = text.Split('\n');
            for (var index = 0; index < lines.Length - 1; index++)
            {
                if (string.IsNullOrWhiteSpace(lines[index])) continue;
                var entry = JsonNode.Parse(lines[index]) as JsonObject ?? throw new InvalidOperationException("Invalid script append journal entry.");
                var id = entry["runId"]?.GetValue<string>() ?? throw new InvalidOperationException("Script append journal entry has no identity.");
                var prior = merged.FindIndex(item => item["runId"]?.GetValue<string>() == id);
                if (prior >= 0) merged[prior] = entry; else merged.Add(entry);
                while (merged.Count > 100) merged.RemoveAt(0);
            }
            // A final unterminated line is an interrupted append and is discarded.
        }
        var result = merged.ToArray();
        var changed = false;
        foreach (var entry in result.Where(item => recover && item["status"]?.GetValue<string>() == "running"))
        {
            changed = true; entry["status"] = "interrupted"; entry["success"] = false;
            entry["finishedAt"] = DateTimeOffset.UtcNow.ToString("O");
            entry["stderr"] = "The gateway stopped before this execution recorded a completion. Its side effects may already have occurred.";
        }
        if (changed || recover && File.Exists(appendPath)) Save(result);
        return result;
    }
    public void Append(IEnumerable<JsonObject> entries)
    {
        lock (gate)
        {
            var batch = entries.Select(entry => entry.ToJsonString()).ToArray();
            if (batch.Length == 0) return;
            var bytes = Encoding.UTF8.GetBytes(string.Join('\n', batch) + "\n");
            if (bytes.Length > 8 * 1024 * 1024) throw new IOException("The script journal batch is too large.");
            Directory.CreateDirectory(directory); RecoveryFileSystem.RejectLinks(directory); RecoveryFileSystem.RejectLinks(appendPath);
            using (var stream = new FileStream(appendPath, FileMode.Append, FileAccess.Write, FileShare.Read))
            { stream.Write(bytes); stream.Flush(flushToDisk: true); }
            AppendFlushCount++;
            if (new FileInfo(appendPath).Length >= 2 * 1024 * 1024) Save(LoadCore(recover: false));
        }
    }
    public void Save(IEnumerable<JsonObject> entries)
    {
        lock (gate)
        {
        Directory.CreateDirectory(directory);
        RecoveryFileSystem.RejectLinks(directory); RecoveryFileSystem.RejectLinks(path);
        var temporary = path + ".tmp";
        RecoveryFileSystem.RejectLinks(temporary);
        var document = new JsonObject { ["version"] = 1, ["runs"] = new JsonArray(entries.TakeLast(100).Select(item => item.DeepClone()).ToArray()) };
        var bytes = Encoding.UTF8.GetBytes(document.ToJsonString());
        while (bytes.Length > 8 * 1024 * 1024 && document["runs"]!.AsArray().Count > 1)
        {
            document["runs"]!.AsArray().RemoveAt(0);
            bytes = Encoding.UTF8.GetBytes(document.ToJsonString());
        }
        if (bytes.Length > 8 * 1024 * 1024) throw new IOException("The bounded script journal is too large.");
        using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        { stream.Write(bytes); stream.Flush(flushToDisk: true); }
        File.Move(temporary, path, true);
        if (File.Exists(appendPath)) File.Delete(appendPath);
        }
    }
}
