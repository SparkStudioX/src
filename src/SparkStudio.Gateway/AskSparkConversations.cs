using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;

namespace SparkStudio.Gateway;

public sealed record AskSparkPending(AskSparkToolCall Call, string? Token, DateTimeOffset ExpiresAt, bool Decided = false, bool Declined = false, string? NativeId = null,
    bool ServerHandled = false, JsonNode? ServerResult = null);
public sealed class AskSparkConversation
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Title { get; set; } = "New conversation";
    public string? ProjectId { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public List<AskSparkMessage> Messages { get; set; } = [];
    public List<AskSparkAction> Actions { get; set; } = [];
    public JsonArray Contents { get; set; } = [];
    public AskSparkPending[] Pending { get; set; } = [];
    public string? ContinuationToken { get; set; }
    public int Rounds { get; set; }
    public int Calls { get; set; }
    public int Tokens { get; set; }
    public int StepLimit { get; set; } = 100;
    public string[] LoadedTools { get; set; } = [];
    public JsonObject ToolContext { get; set; } = new();
}

/// <summary>Private bounded conversation files; signatures and attachments never leave through history endpoints.</summary>
public sealed class AskSparkConversations
{
    private const int MaximumFileBytes = 32 * 1024 * 1024;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly string directory;
    private readonly IDataProtector protector;
    private readonly object gate = new();
    private readonly ConcurrentDictionary<string, byte> busy = new(StringComparer.Ordinal);

    public AskSparkConversations(string dataDirectory, IDataProtectionProvider protection)
    {
        directory = Path.Combine(dataDirectory, "ask-spark-conversations");
        protector = protection.CreateProtector("SparkStudio.AskSpark.Conversations.v1");
    }

    public object[] List(string userId)
    {
        lock (gate)
        {
            var folder = UserDirectory(userId);
            if (!Directory.Exists(folder)) return [];
            return new DirectoryInfo(folder).EnumerateFiles("*.json")
                .Where(file => IsValidId(Path.GetFileNameWithoutExtension(file.Name)))
                .OrderByDescending(file => file.LastWriteTimeUtc).Take(20).Select(file => (object)Summary(file)).ToArray();
        }
    }

    private AskSparkConversationSummary Summary(FileInfo file)
    {
        var id = Path.GetFileNameWithoutExtension(file.Name);
        try
        {
            var item = ReadFile(file.FullName);
            return new(id, item.Title, item.UpdatedAt, item.ProjectId);
        }
        catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException or InvalidOperationException)
        {
            // Preserve a deletable identity without exposing encrypted content or blocking other conversations.
            return new(id, "Unreadable conversation", new DateTimeOffset(file.LastWriteTimeUtc, TimeSpan.Zero), null, true);
        }
    }

    public AskSparkConversation Read(string userId, string id)
    {
        lock (gate)
        {
            var path = FilePath(userId, id);
            if (!File.Exists(path)) throw new KeyNotFoundException("Conversation not found.");
            return ReadFile(path);
        }
    }

    public void Save(string userId, AskSparkConversation conversation)
    {
        var text = JsonSerializer.Serialize(conversation, Json);
        if (Encoding.UTF8.GetByteCount(text) > 22 * 1024 * 1024) throw new BadHttpRequestException("This conversation reached its size limit. Start a new conversation.", 413);
        lock (gate)
        {
            var folder = UserDirectory(userId);
            if (!Directory.Exists(directory)) RecoveryFileSystem.CreatePrivateDirectory(directory);
            if (!Directory.Exists(folder)) RecoveryFileSystem.CreatePrivateDirectory(folder);
            DurableJsonFile.Write(FilePath(userId, conversation.Id), new JsonObject { ["protectedConversation"] = protector.Protect(text) });
            Prune(folder, conversation.Id);
        }
    }

    public void Delete(string userId, string id)
    {
        lock (gate)
        {
            var path = FilePath(userId, id);
            if (busy.ContainsKey(Key(userId, id))) throw new BadHttpRequestException("Wait for this conversation's active request to finish.", 409);
            RecoveryFileSystem.RejectLinks(path);
            File.Delete(path);
        }
    }

    public IDisposable Enter(string userId, string id)
    {
        ValidateId(id);
        var key = Key(userId, id);
        if (!busy.TryAdd(key, 0)) throw new BadHttpRequestException("Another request is already running in this conversation.", 409);
        return new Lease(() => busy.TryRemove(key, out _));
    }

    private AskSparkConversation ReadFile(string path)
    {
        RecoveryFileSystem.RejectLinks(path);
        if (new FileInfo(path).Length > MaximumFileBytes) throw new InvalidDataException("The saved conversation exceeds its size limit.");
        try
        {
            var secret = JsonNode.Parse(File.ReadAllText(path))?["protectedConversation"]?.GetValue<string>() ?? throw new InvalidDataException();
            return JsonSerializer.Deserialize<AskSparkConversation>(protector.Unprotect(secret), Json) ?? throw new InvalidDataException();
        }
        catch (Exception error) when (error is CryptographicException or JsonException or InvalidDataException)
        { throw new InvalidDataException("A saved Ask Spark conversation cannot be read. Delete it or restore its protection keys."); }
    }

    private string UserDirectory(string userId)
    {
        var folder = Path.Combine(directory, Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(userId))));
        RecoveryFileSystem.RejectLinks(folder);
        return folder;
    }

    private string FilePath(string userId, string id) { ValidateId(id); return Path.Combine(UserDirectory(userId), id + ".json"); }
    private static string Key(string userId, string id) => userId + ":" + id;
    private static void ValidateId(string id)
    {
        if (!IsValidId(id)) throw new ArgumentException("Invalid conversation identifier.");
    }
    private static bool IsValidId(string? id) => id is { Length: 32 } && id.All(char.IsAsciiHexDigit);

    private static void Prune(string folder, string currentId)
    {
        var files = new DirectoryInfo(folder).GetFiles("*.json").OrderBy(file => file.LastWriteTimeUtc).ToList();
        var bytes = files.Sum(file => file.Length);
        foreach (var file in files)
        {
            if (files.Count <= 20 && bytes <= 64 * 1024 * 1024) break;
            if (file.Name == currentId + ".json") continue;
            RecoveryFileSystem.RejectLinks(file.FullName);
            bytes -= file.Length;
            file.Delete();
            // Counting remaining paths avoids mutating the enumerated collection.
            if (Directory.EnumerateFiles(folder, "*.json").Count() <= 20 && bytes <= 64 * 1024 * 1024) break;
        }
    }

    private sealed class Lease(Action release) : IDisposable
    {
        private Action? callback = release;
        public void Dispose() => Interlocked.Exchange(ref callback, null)?.Invoke();
    }
}
