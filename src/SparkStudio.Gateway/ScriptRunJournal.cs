using System.Text;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Bounded per-project history, replaced atomically; no invocation inputs are stored.</summary>
public sealed class ScriptRunJournal(string directory)
{
    private readonly string path = Path.Combine(directory, "script-event-runs.json");
    public JsonObject[] Load()
    {
        if (!File.Exists(path)) return [];
        RecoveryFileSystem.RejectLinks(path);
        if (new FileInfo(path).Length > 8 * 1024 * 1024) throw new InvalidOperationException("The script execution journal exceeds its bounded file limit.");
        var document = JsonNode.Parse(File.ReadAllText(path))?.AsObject() ?? throw new InvalidOperationException("The script execution journal is invalid.");
        if (document["version"]?.GetValue<int>() != 1 || document["runs"] is not JsonArray runs || runs.Count > 100 || runs.Any(item => item is not JsonObject))
            throw new InvalidOperationException("The script execution journal has an unsupported format.");
        var result = runs.OfType<JsonObject>().Select(item => item.DeepClone().AsObject()).ToArray();
        var changed = false;
        foreach (var entry in result.Where(item => item["status"]?.GetValue<string>() == "running"))
        {
            changed = true; entry["status"] = "interrupted"; entry["success"] = false;
            entry["finishedAt"] = DateTimeOffset.UtcNow.ToString("O");
            entry["stderr"] = "The gateway stopped before this execution recorded a completion. Its side effects may already have occurred.";
        }
        if (changed) Save(result);
        return result;
    }
    public void Save(IEnumerable<JsonObject> entries)
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
    }
}
