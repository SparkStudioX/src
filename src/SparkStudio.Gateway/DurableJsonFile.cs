using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Write a complete durable sibling before replacing the last committed document.</summary>
internal static class DurableJsonFile
{
    public static void Write(string path, JsonNode document, JsonSerializerOptions? options = null, object? commitGate = null)
        => WriteDocument(path, writer => document.WriteTo(writer, options), options, commitGate);

    // Serialize an immutable candidate view without cloning or reparenting its
    // unchanged nodes. The caller commits its in-memory array only after this
    // complete sibling has been flushed and atomically replaced.
    public static void WriteArray(string path, IReadOnlyList<JsonNode?> items, JsonSerializerOptions? options = null)
        => WriteDocument(path, writer => {
            writer.WriteStartArray();
            foreach (var item in items) {
                if (item is null) writer.WriteNullValue();
                else item.WriteTo(writer, options);
            }
            writer.WriteEndArray();
        }, options, null);

    private static void WriteDocument(string path, Action<Utf8JsonWriter> write, JsonSerializerOptions? options, object? commitGate)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        RecoveryFileSystem.RejectLinks(path);
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = options?.WriteIndented ?? false }))
                    write(writer);
                stream.Flush(flushToDisk: true);
            }
            if (commitGate is null) File.Move(temporary, path, overwrite: true);
            else lock (commitGate) File.Move(temporary, path, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}
