using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Write a complete durable sibling before replacing the last committed document.</summary>
internal static class DurableJsonFile
{
    public static void Write(string path, JsonNode document, JsonSerializerOptions? options = null, object? commitGate = null)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        RecoveryFileSystem.RejectLinks(path);
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = options?.WriteIndented ?? false }))
                    document.WriteTo(writer, options);
                stream.Flush(flushToDisk: true);
            }
            if (commitGate is null) File.Move(temporary, path, overwrite: true);
            else lock (commitGate) File.Move(temporary, path, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}
