using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

public sealed record ScriptRunRequest(int Revision, string? Source, Dictionary<string, JsonElement>? Parameters);
public sealed record ScriptRunSnapshot(JsonObject Resource, int Revision, string Source, IReadOnlyDictionary<string, string> Libraries, JsonArray? Queries = null, string? PublishedAt = null);
public sealed record ScriptUpdateNotice(string Actor, JsonObject Resources, string Reason);

/// <summary>Independent script drafts read active resources from the complete application publication, with legacy fallback.</summary>
public sealed class ScriptResourceStore
{
    private readonly object gate = GatewayConfigurationLock.SyncRoot;
    private readonly string directory;
    private JsonObject draft;
    private JsonObject? published;
    private PublicationStore? application;
    public event Action? Published;
    public event Action<ScriptUpdateNotice>? Updated;
    public string DataDirectory => directory;
    private static readonly Regex Identifier = new("^[A-Za-z_][A-Za-z0-9_]{0,63}$", RegexOptions.CultureInvariant);
    private static readonly Regex ResourceId = new("^[A-Za-z_][A-Za-z0-9_-]{0,79}$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> PythonKeywords = new("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".Split(' '), StringComparer.Ordinal);

    public ScriptResourceStore(string dataDirectory)
    {
        directory = dataDirectory;
        Directory.CreateDirectory(directory);
        draft = Read("scripts-draft.json") ?? new JsonObject { ["revision"] = 0, ["resources"] = new JsonArray() };
        published = Read("scripts-published.json");
        draft = Normalize(draft, Revision(draft));
        if (published is not null)
        {
            var date = ProjectStore.Required(published, "publishedAt");
            published = Normalize(published, Revision(published));
            published["publishedAt"] = date;
        }
    }

    private JsonObject? Read(string name)
    {
        var path = Path.Combine(directory, name);
        return File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path))?.AsObject() ?? throw new InvalidOperationException("Stored script resources are invalid.") : null;
    }

    private void Persist(string name, JsonObject value)
    {
        var path = Path.Combine(directory, name);
        DurableJsonFile.Write(path, value, ProjectStore.Json);
    }

    public JsonObject GetDraft() { lock (gate) return draft.DeepClone().AsObject(); }
    public void AttachApplication(PublicationStore publication) { lock (gate) application = publication; }
    private JsonObject? ActivePublication => application?.CaptureScripts() ?? published;
    public JsonObject? CapturePublished() { lock (gate) return ActivePublication?.DeepClone().AsObject(); }
    public IReadOnlyDictionary<string, string> CaptureLibraries() { lock (gate) return ScriptLibrary.Capture(ActivePublication); }
    public void NotifyPublished() => Published?.Invoke();
    public JsonObject CaptureDraftForPublication(int? expectedRevision = null)
    {
        lock (gate)
        {
            if (expectedRevision is not null && expectedRevision != Revision(draft)) throw new InvalidOperationException("Script resources changed. Review the application again before publishing.");
            return ValidatePublication(draft);
        }
    }
    internal static JsonObject ValidatePublication(JsonObject document)
    {
        var next = Normalize(document, Revision(document));
        foreach (var resource in Resources(next))
            if (Enabled(resource) && string.IsNullOrWhiteSpace(ProjectStore.Required(resource, "code")))
                throw new ArgumentException("Enabled script resources need code before publication.");
        return next;
    }

    public JsonObject SaveDraft(JsonObject value, string actor = "system")
    {
        JsonObject result;
        ScriptUpdateNotice? notice;
        lock (gate)
        {
            var revision = Revision(draft);
            if (Revision(value) != revision) throw new InvalidOperationException("Script resources changed. Reload before saving.");
            var next = Normalize(value, checked(revision + 1));
            notice = Changes(draft, next, actor, "scriptsSaved");
            Persist("scripts-draft.json", next);
            draft = next;
            result = draft.DeepClone().AsObject();
        }
        if (notice is not null) NotifyUpdate(notice);
        return result;
    }

    public void NotifyUpdate(ScriptUpdateNotice notice) =>
        Updated?.Invoke(notice with { Resources = notice.Resources.DeepClone().AsObject() });

    private static ScriptUpdateNotice? Changes(JsonObject before, JsonObject after, string actor, string reason)
    {
        var previous = Resources(before).ToDictionary(resource => ProjectStore.Required(resource, "id"), StringComparer.Ordinal);
        var current = Resources(after).ToDictionary(resource => ProjectStore.Required(resource, "id"), StringComparer.Ordinal);
        static JsonNode Describe(JsonObject resource) => new JsonObject
        {
            ["id"] = resource["id"]!.DeepClone(), ["name"] = resource["name"]!.DeepClone(), ["type"] = resource["type"]!.DeepClone()
        };
        var added = new JsonArray(current.Where(pair => !previous.ContainsKey(pair.Key)).Select(pair => Describe(pair.Value)).ToArray());
        var removed = new JsonArray(previous.Where(pair => !current.ContainsKey(pair.Key)).Select(pair => Describe(pair.Value)).ToArray());
        var modified = new JsonArray(current.Where(pair => previous.TryGetValue(pair.Key, out var old) && !JsonNode.DeepEquals(old, pair.Value)).Select(pair => Describe(pair.Value)).ToArray());
        return added.Count + removed.Count + modified.Count == 0 ? null : new(actor,
            new JsonObject { ["added"] = added, ["removed"] = removed, ["modified"] = modified, ["manifestChanged"] = false }, reason);
    }

    public JsonObject Metadata()
    {
        lock (gate)
        {
            var published = ActivePublication;
            return published is null
            ? new JsonObject { ["published"] = false, ["draftRevision"] = Revision(draft) }
            : new JsonObject { ["published"] = true, ["revision"] = Revision(published), ["draftRevision"] = Revision(draft), ["publishedAt"] = published["publishedAt"]!.DeepClone() };
        }
    }

    public JsonObject Publish(int revision, string actor = "system")
    {
        JsonObject result;
        lock (gate)
        {
            if (application is not null) throw new InvalidOperationException("Publish the whole application from the publication review. Script resources are included in that release.");
            if (revision != Revision(draft)) throw new InvalidOperationException("Script resources changed. Save and reload before publishing.");
            // Repeated publication of an unchanged revision must not retrigger startup events.
            if (published is not null && Revision(published) == revision) return Metadata();
            var next = Normalize(draft, revision);
            foreach (var resource in Resources(next))
                if (Enabled(resource) && string.IsNullOrWhiteSpace(ProjectStore.Required(resource, "code")))
                    throw new ArgumentException("Enabled script resources need code before publication.");
            next["publishedAt"] = DateTimeOffset.UtcNow.ToString("O");
            Persist("scripts-published.json", next);
            published = next;
            result = Metadata();
        }
        // SaveDraft already reports resource changes. Publication replaces the active
        // generation without delivering the same resource update a second time.
        Published?.Invoke();
        return result;
    }

    public JsonObject GetClientResources()
    {
        lock (gate)
        {
            var published = ActivePublication;
            // Construct a positive projection: browser runtime never receives Python code.
            return new JsonObject
            {
                ["revision"] = published is null ? 0 : Revision(published),
                ["publishedAt"] = published?["publishedAt"]?.DeepClone(),
                ["resources"] = new JsonArray(Resources(published)
                    .Where(resource => ProjectStore.Required(resource, "type") == "client" && Enabled(resource))
                    .Select(resource => resource.DeepClone()).ToArray())
            };
        }
    }

    public ScriptRunSnapshot CaptureRun(string id, int revision, string? source)
    {
        source ??= "draft";
        if (source is not ("draft" or "published")) throw new ArgumentException("Script run source must be draft or published.");
        lock (gate)
        {
            var published = ActivePublication;
            var document = source == "draft" ? draft : published ?? throw new KeyNotFoundException("No script resources are published.");
            if (revision != Revision(document)) throw new InvalidOperationException("Script resources changed. Reload before running this script.");
            var resource = Resources(document).FirstOrDefault(item => ProjectStore.Required(item, "id") == id)
                ?? throw new KeyNotFoundException("Script resource not found.");
            if (ProjectStore.Required(resource, "type") == "client") throw new ArgumentException("Client JavaScript runs in the browser, not in the Python gateway.");
            return new ScriptRunSnapshot(resource.DeepClone().AsObject(), revision, source, ScriptLibrary.Capture(published), source == "published" ? published?["queries"]?.DeepClone().AsArray() : null, published?["publishedAt"]?.GetValue<string>());
        }
    }

    public static Dictionary<string, JsonElement> ResolveParameters(JsonObject resource, Dictionary<string, JsonElement>? supplied)
    {
        var defaults = resource["parameters"]!.AsObject();
        if (supplied is not null && supplied.Keys.Any(key => !defaults.ContainsKey(key)))
            throw new ArgumentException("An undeclared script parameter was supplied.");
        var result = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var (name, fallback) in defaults)
        {
            var defaultValue = JsonSerializer.SerializeToElement(fallback);
            var value = supplied is not null && supplied.TryGetValue(name, out var entry) ? entry : defaultValue;
            ValidateParameter(value);
            if (defaultValue.ValueKind != JsonValueKind.Null && value.ValueKind != defaultValue.ValueKind &&
                !(defaultValue.ValueKind is JsonValueKind.True or JsonValueKind.False && value.ValueKind is JsonValueKind.True or JsonValueKind.False))
                throw new ArgumentException($"Script parameter '{name}' must match its default value's scalar type.");
            result.Add(name, value.Clone());
        }
        return result;
    }

    public static IEnumerable<JsonObject> Resources(JsonObject? document) => document?["resources"]?.AsArray().OfType<JsonObject>() ?? [];
    public static int Revision(JsonObject document) => document["revision"] is JsonValue value && value.TryGetValue<int>(out var revision) && revision >= 0
        ? revision : throw new ArgumentException("A nonnegative script revision is required.");
    public static bool Enabled(JsonObject resource) => resource["enabled"]!.GetValue<bool>();

    /// <summary>Validate portable draft resources without publishing, executing, or writing files.</summary>
    public static JsonObject ValidateDraft(JsonObject value)
    {
        Revision(value);
        return Normalize(value, 0);
    }

    private static JsonObject Normalize(JsonObject value, int revision)
    {
        if (value["resources"] is not JsonArray list || list.Count > 100) throw new ArgumentException("Script resources must be an array of at most 100 entries.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var libraryNames = new HashSet<string>(StringComparer.Ordinal);
        var messageNames = new HashSet<string>(StringComparer.Ordinal);
        var resources = new JsonArray();
        var bytes = 0;
        foreach (var item in list)
        {
            if (item is not JsonObject resource) throw new ArgumentException("Every script resource must be an object.");
            var id = Text(resource, "id", 80);
            if (!ResourceId.IsMatch(id) || !ids.Add(id)) throw new ArgumentException("Script resource IDs must be unique identifiers.");
            var type = Text(resource, "type", 20);
            if (type is not ("library" or "gateway" or "client")) throw new ArgumentException("Script type must be library, gateway or client.");
            var name = Text(resource, "name", 100);
            if (type == "library" && (!Identifier.IsMatch(name) || PythonKeywords.Contains(name) || !libraryNames.Add(name)))
                throw new ArgumentException("Python library names must be unique Python identifiers, such as workorders.");
            if (resource["code"] is not JsonValue codeValue || !codeValue.TryGetValue<string>(out var code)) throw new ArgumentException("Script code must be text.");
            var length = Encoding.UTF8.GetByteCount(code);
            if (length > 65536 || (bytes += length) > 524288) throw new ArgumentException("Script code is limited to 64 KiB per resource and 512 KiB in total.");
            var enabled = type == "library";
            if (resource.ContainsKey("enabled"))
            {
                if (resource["enabled"] is not JsonValue flag || !flag.TryGetValue<bool>(out enabled)) throw new ArgumentException("Script enabled must be Boolean.");
            }
            var parameters = resource["parameters"] is null && !resource.ContainsKey("parameters") ? new JsonObject() : resource["parameters"] as JsonObject
                ?? throw new ArgumentException("Script parameters must be an object of scalar defaults.");
            if (parameters.Count > 64) throw new ArgumentException("Script resources support at most 64 parameters.");
            foreach (var (key, parameter) in parameters)
            {
                if (!Identifier.IsMatch(key)) throw new ArgumentException("Script parameter names must be identifiers.");
                ValidateParameter(JsonSerializer.SerializeToElement(parameter));
            }
            var next = new JsonObject { ["id"] = id, ["name"] = name, ["type"] = type, ["code"] = code, ["enabled"] = enabled, ["parameters"] = parameters.DeepClone() };
            if (type == "gateway")
            {
                foreach (var (key, setting) in GatewayScriptOptions.Normalize(resource)) next[key] = setting?.DeepClone();
                if (next["event"]!.GetValue<string>() == "message" && !messageNames.Add(name))
                    throw new ArgumentException("Gateway message handler names must be unique.");
            }
            else if (type == "client")
            {
                var trigger = resource.ContainsKey("event") ? Text(resource, "event", 20) : "startup";
                if (trigger is not ("startup" or "screenOpen")) throw new ArgumentException("Client events are startup or screenOpen.");
                next["event"] = trigger;
            }
            resources.Add(next);
        }
        return new JsonObject { ["revision"] = revision, ["resources"] = resources };
    }

    private static string Text(JsonObject resource, string key, int maximum)
    {
        var value = ProjectStore.Required(resource, key);
        if (value.Length > maximum || value.Any(char.IsControl)) throw new ArgumentException($"Script {key} is too long or contains control characters.");
        return value;
    }

    private static void ValidateParameter(JsonElement value)
    {
        if (value.ValueKind is JsonValueKind.Null or JsonValueKind.True or JsonValueKind.False) return;
        if (value.ValueKind == JsonValueKind.String && value.GetString()!.Length <= 4096) return;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && double.IsFinite(number) &&
            (Math.Truncate(number) != number || Math.Abs(number) <= 9007199254740991d)) return;
        throw new ArgumentException("Script parameters must be scalar JSON values; text is limited to 4096 characters and numbers must have safe integer precision.");
    }
}
