using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Portable draft project files; this is not a gateway or publication backup.</summary>
public static class SparkProjectPackage
{
    public const int MaximumArchiveBytes = 32 * 1024 * 1024;
    public const int MaximumExpandedBytes = 64 * 1024 * 1024;
    public const int MaximumAssets = 512;
    private const int MaximumEntries = 4 + MaximumAssets * 2;
    private static readonly string[] RequiredEntries = ["manifest.json", "project.json", "queries.json", "scripts-draft.json"];
    private static readonly string[] ProjectFields = ["id", "name", "revision", "parameters", "screens", "templates", "navigation", "sessionState"];
    private static readonly Regex AssetEntry = new(@"\Aassets/([a-f0-9]{64})\.(json|bin)\z", RegexOptions.CultureInvariant);
    private static readonly Regex AssetId = new(@"\A[a-f0-9]{64}\z", RegexOptions.CultureInvariant);
    private static readonly Regex ParameterName = new(@"\A@?[A-Za-z_][A-Za-z0-9_]{0,127}\z", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> ParameterTypes = new(StringComparer.Ordinal)
        { "string", "nvarchar", "int", "int32", "integer", "long", "int64", "bigint", "number", "double", "float", "decimal", "bool", "boolean", "bit", "date", "datetime", "datetime2", "datetimeoffset", "guid", "uniqueidentifier" };
    private static readonly uint[] CrcTable = CreateCrcTable();

    public static byte[] Export(ProjectWorkspace workspace)
    {
        var current = workspace.Store.GetProject();
        var snapshot = workspace.Store.CapturePublication(current["revision"]!.GetValue<int>());
        // A positive projection prevents gateway configuration accidentally
        // attached to an extensible project object from entering the package.
        var source = snapshot["project"]!.AsObject();
        var project = new JsonObject();
        foreach (var key in ProjectFields)
            if (source.ContainsKey(key)) project[key] = source[key]?.DeepClone();
        ValidateProject(project);
        var queries = ValidateQueries(snapshot["queries"]!.AsArray());
        ComponentQueryBindingValidator.ValidateQueries(project, queries);
        var scripts = ScriptResourceStore.ValidateDraft(workspace.Scripts.GetDraft());
        var dependencies = ConnectionDependencies(workspace.Store, queries);
        var manifest = new JsonObject
        {
            ["format"] = "sparkstudio-project", ["formatVersion"] = 1, ["content"] = "draft-only",
            ["projectName"] = Text(project, "name", 120), ["exportedAt"] = DateTimeOffset.UtcNow.ToString("O"),
            ["connectionDependencies"] = dependencies
        };
        var entries = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["manifest.json"] = JsonBytes(manifest), ["project.json"] = JsonBytes(project),
            ["queries.json"] = JsonBytes(queries), ["scripts-draft.json"] = JsonBytes(scripts)
        };
        foreach (var id in ReferencedAssets(project))
        {
            var asset = LocalAssetStore.ValidateContent(workspace.Assets.Read(id));
            entries.Add($"assets/{id}.json", JsonSerializer.SerializeToUtf8Bytes(asset.Metadata, ProjectStore.Json));
            entries.Add($"assets/{id}.bin", asset.Data);
        }
        CheckSizes(entries);
        using var output = new MemoryStream();
        using (var archive = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, data) in entries)
            {
                var entry = archive.CreateEntry(name, CompressionLevel.Optimal);
                using var stream = entry.Open();
                stream.Write(data);
            }
        }
        if (output.Length > MaximumArchiveBytes) throw new ArgumentException("A project package is limited to 32 MiB compressed.");
        return output.ToArray();
    }

    public static ProjectWorkspace Import(ProjectCatalog catalog, byte[] data, string? name = null)
    {
        // Nothing touches catalog files until every archive entry, definition,
        // dependency declaration and image has passed validation.
        var entries = ReadArchive(data);
        var manifest = Object(entries, "manifest.json");
        ValidateManifest(manifest);
        var project = Object(entries, "project.json");
        ValidateProject(project);
        if (Text(manifest, "projectName", 120) != Text(project, "name", 120)) throw new ArgumentException("The package project name does not match its manifest.");
        var queryNode = ParseJson(entries["queries.json"], "queries.json");
        if (queryNode is not JsonArray queryArray) throw new ArgumentException("queries.json must contain an array.");
        var queries = ValidateQueries(queryArray);
        ComponentQueryBindingValidator.ValidateQueries(project, queries);
        var scripts = ScriptResourceStore.ValidateDraft(Object(entries, "scripts-draft.json"));
        var connectionIds = queries.OfType<JsonObject>().Select(query => Text(query, "connectionId", 256)).ToHashSet(StringComparer.Ordinal);
        var declaredConnections = manifest["connectionDependencies"]!.AsArray().OfType<JsonObject>().Select(item => Text(item, "id", 256)).ToHashSet(StringComparer.Ordinal);
        if (!connectionIds.SetEquals(declaredConnections)) throw new ArgumentException("Connection dependencies must exactly match the named queries in the package.");

        var referenced = ReferencedAssets(project);
        var packaged = entries.Keys.Where(key => AssetEntry.IsMatch(key)).Select(key => AssetEntry.Match(key).Groups[1].Value).ToHashSet(StringComparer.Ordinal);
        if (!packaged.SetEquals(referenced)) throw new ArgumentException("The package must contain exactly the images referenced by its project draft.");
        var assets = new List<AssetContent>();
        foreach (var id in referenced)
        {
            if (!entries.TryGetValue($"assets/{id}.bin", out var content) || !entries.ContainsKey($"assets/{id}.json"))
                throw new ArgumentException("Each referenced image needs both metadata and content.");
            var metadataJson = Object(entries, $"assets/{id}.json");
            Only(metadataJson, ["id", "name", "contentType", "size", "width", "height"], "Image metadata");
            AssetMetadata metadata;
            try { metadata = metadataJson.Deserialize<AssetMetadata>(ProjectStore.Json) ?? throw new ArgumentException("Image metadata is invalid."); }
            catch (JsonException error) { throw new ArgumentException("Image metadata is invalid.", error); }
            if (metadata.Id != id) throw new ArgumentException("Image metadata ID does not match its package filename.");
            assets.Add(LocalAssetStore.ValidateContent(new AssetContent(metadata, content)));
        }
        return catalog.Create(name ?? Text(project, "name", 120), project, queries, scripts, assets);
    }

    /// <summary>Safe connection labels only; never connection definitions or secrets.</summary>
    public static JsonArray ConnectionDependencies(ProjectStore store, JsonArray queries)
    {
        var names = store.GetConnections().OfType<JsonObject>().ToDictionary(item => Text(item, "id", 256), item => Text(item, "name", 120), StringComparer.Ordinal);
        return new JsonArray(queries.OfType<JsonObject>().Select(query => Text(query, "connectionId", 256)).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).Select(id => (JsonNode)new JsonObject
        {
            ["id"] = id, ["name"] = names.TryGetValue(id, out var label) ? label : id == "sample" ? "Built-in sample" : id
        }).ToArray());
    }

    /// <summary>Validate every named query without executing SQL or resolving gateway connections.</summary>
    public static JsonArray ValidateQueries(JsonArray queries)
    {
        if (queries.Count > 500) throw new ArgumentException("A project can contain at most 500 named queries.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var normalized = new JsonArray();
        foreach (var node in queries)
        {
            if (node is not JsonObject query) throw new ArgumentException("Every named query must be an object.");
            Only(query, ["id", "name", "connectionId", "sql", "kind", "parameters"], "Named query");
            var id = Text(query, "id", 256);
            if (!ids.Add(id)) throw new ArgumentException("Named query IDs must be unique.");
            var kind = query.ContainsKey("kind") ? Text(query, "kind", 20) : "query";
            if (kind is not ("query" or "update")) throw new ArgumentException("Named query kind must be query or update.");
            var sql = Text(query, "sql", 65536, allowWhitespace: true);
            if (sql.Contains('\0')) throw new ArgumentException("Query SQL cannot contain null characters.");
            if (query["parameters"] is not JsonArray parameters || parameters.Count > 128) throw new ArgumentException("Named query parameters must be an array of at most 128 entries.");
            var parameterNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var nextParameters = new JsonArray();
            foreach (var parameterNode in parameters)
            {
                if (parameterNode is not JsonObject parameter) throw new ArgumentException("Each named query parameter must be an object.");
                Only(parameter, ["name", "type", "defaultValue"], "Named query parameter");
                var parameterName = Text(parameter, "name", 129);
                if (!ParameterName.IsMatch(parameterName) || !parameterNames.Add(parameterName.TrimStart('@'))) throw new ArgumentException("Query parameter names must be unique SQL identifiers.");
                var type = parameter.ContainsKey("type") ? Text(parameter, "type", 32).ToLowerInvariant() : "string";
                if (!ParameterTypes.Contains(type)) throw new ArgumentException("Unsupported named query parameter type.");
                var nextParameter = new JsonObject { ["name"] = parameterName, ["type"] = type };
                if (parameter.ContainsKey("defaultValue"))
                {
                    ValidateScalar(parameter["defaultValue"]);
                    nextParameter["defaultValue"] = parameter["defaultValue"]?.DeepClone();
                }
                nextParameters.Add(nextParameter);
            }
            normalized.Add(new JsonObject { ["id"] = id, ["name"] = Text(query, "name", 120), ["connectionId"] = Text(query, "connectionId", 256), ["sql"] = sql, ["kind"] = kind, ["parameters"] = nextParameters });
        }
        return normalized;
    }

    private static Dictionary<string, byte[]> ReadArchive(byte[] data)
    {
        if (data is null || data.Length is 0 or > MaximumArchiveBytes) throw new ArgumentException("Project packages must contain 1 byte to 32 MiB.");
        try
        {
            using var input = new MemoryStream(data, writable: false);
            using var archive = new ZipArchive(input, ZipArchiveMode.Read, leaveOpen: false);
            if (archive.Entries.Count is < 4 or > MaximumEntries) throw new ArgumentException($"Project packages need 4 to {MaximumEntries} entries.");
            var entries = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
            long expanded = 0;
            long compressed = 0;
            foreach (var entry in archive.Entries)
            {
                var name = entry.FullName;
                if (!RequiredEntries.Contains(name, StringComparer.Ordinal) && !AssetEntry.IsMatch(name)) throw new ArgumentException("The archive contains an unsupported or unsafe entry path.");
                if (entries.ContainsKey(name)) throw new ArgumentException("Archive entry names must be unique, ignoring case.");
                if (entry.IsEncrypted) throw new ArgumentException("Encrypted project package entries are not supported.");
                var unixKind = (entry.ExternalAttributes >> 16) & 0xf000;
                if (unixKind is not (0 or 0x8000) || (entry.ExternalAttributes & (0x10 | 0x400)) != 0) throw new ArgumentException("Archive entries must be ordinary files; links and directories are not supported.");
                var maximum = name.EndsWith(".bin", StringComparison.Ordinal) ? LocalAssetStore.MaximumBytes : MaximumExpandedBytes;
                if (entry.Length < 0 || entry.Length > maximum || entry.CompressedLength < 0 || entry.CompressedLength > MaximumArchiveBytes)
                    throw new ArgumentException("An archive entry exceeds its size limit.");
                expanded = checked(expanded + entry.Length);
                compressed = checked(compressed + entry.CompressedLength);
                if (expanded > MaximumExpandedBytes || compressed > MaximumArchiveBytes) throw new ArgumentException("Project packages are limited to 32 MiB compressed and 64 MiB expanded.");
                using var stream = entry.Open();
                using var output = new MemoryStream();
                var buffer = new byte[81920];
                var crc = uint.MaxValue;
                int read;
                while ((read = stream.Read(buffer)) > 0)
                {
                    if (output.Length + read > entry.Length || output.Length + read > maximum) throw new ArgumentException("Archive content exceeds its declared size.");
                    for (var index = 0; index < read; index++) crc = CrcTable[(byte)(crc ^ buffer[index])] ^ (crc >> 8);
                    output.Write(buffer, 0, read);
                }
                if (output.Length != entry.Length) throw new ArgumentException("Archive content is incomplete.");
                if (~crc != entry.Crc32) throw new ArgumentException("Archive entry content failed its checksum.");
                entries.Add(name, output.ToArray());
            }
            if (RequiredEntries.Any(name => !entries.ContainsKey(name))) throw new ArgumentException("The project package is missing required draft files.");
            return entries;
        }
        catch (Exception error) when (error is InvalidDataException or IOException or OverflowException or NotSupportedException)
        { throw new ArgumentException("The project archive is invalid, unsupported, or exceeds its size limits.", error); }
    }

    private static void ValidateManifest(JsonObject manifest)
    {
        Only(manifest, ["format", "formatVersion", "content", "projectName", "exportedAt", "connectionDependencies"], "Package manifest");
        if (Text(manifest, "format", 100) != "sparkstudio-project" || manifest["formatVersion"] is not JsonValue version || !version.TryGetValue<int>(out var number) || number != 1)
            throw new ArgumentException("Unsupported project package format or version.");
        if (Text(manifest, "content", 32) != "draft-only") throw new ArgumentException("Only draft project packages are supported.");
        Text(manifest, "projectName", 120);
        if (!DateTimeOffset.TryParse(Text(manifest, "exportedAt", 100), out _)) throw new ArgumentException("The package export timestamp is invalid.");
        if (manifest["connectionDependencies"] is not JsonArray dependencies || dependencies.Count > 500) throw new ArgumentException("Connection dependencies must be an array of up to 500 labels.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in dependencies)
        {
            if (node is not JsonObject dependency) throw new ArgumentException("Connection dependencies must contain ID/name objects.");
            Only(dependency, ["id", "name"], "Connection dependency");
            if (!ids.Add(Text(dependency, "id", 256))) throw new ArgumentException("Connection dependency IDs must be unique.");
            Text(dependency, "name", 256);
        }
    }

    private static void ValidateProject(JsonObject project)
    {
        Only(project, ProjectFields, "Project draft");
        Text(project, "id", 256); Text(project, "name", 120);
        if (project["revision"] is not JsonValue revision || !revision.TryGetValue<int>(out var number) || number < 0) throw new ArgumentException("A project draft needs a nonnegative revision.");
        ProjectTemplates.StringParameters(project["parameters"], "Project parameters");
        ProjectTemplates.ValidateStructure(project);
        foreach (var document in ProjectTemplates.Documents(project))
        {
            Text(document, "name", 120); Dimension(document, "width", 1); Dimension(document, "height", 1);
            if (document.ContainsKey("parameters")) ProjectTemplates.StringParameters(document["parameters"], "Document parameters");
            foreach (var component in document["components"]!.AsArray().OfType<JsonObject>())
            {
                if (component["props"] is not JsonObject) throw new ArgumentException("Every component needs a properties object.");
                Dimension(component, "x", 0); Dimension(component, "y", 0); Dimension(component, "width", 1); Dimension(component, "height", 1);
            }
        }
    }

    private static HashSet<string> ReferencedAssets(JsonObject project)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        foreach (var component in ProjectTemplates.Components(project).Where(item => ProjectStore.Optional(item, "type") == "image"))
        {
            var props = component["props"]!.AsObject();
            if (props.ContainsKey("url") || props.ContainsKey("src")) throw new ArgumentException("Portable images must use local asset IDs.");
            var id = ProjectStore.Optional(props, "assetId");
            if (string.IsNullOrEmpty(id)) continue; // An unconfigured draft image is allowed.
            if (!AssetId.IsMatch(id)) throw new ArgumentException("Image asset IDs must contain 64 lowercase hexadecimal characters.");
            result.Add(id);
        }
        if (result.Count > MaximumAssets) throw new ArgumentException($"Project packages contain at most {MaximumAssets} referenced images.");
        return result;
    }

    private static JsonObject Object(Dictionary<string, byte[]> entries, string name) => ParseJson(entries[name], name) as JsonObject
        ?? throw new ArgumentException($"{name} must contain an object.");
    private static JsonNode? ParseJson(byte[] data, string name)
    {
        try
        {
            using var document = JsonDocument.Parse(data, new JsonDocumentOptions { MaxDepth = 64 });
            CheckJsonKeys(document.RootElement);
            return JsonNode.Parse(data, documentOptions: new JsonDocumentOptions { MaxDepth = 64 });
        }
        catch (JsonException error) { throw new ArgumentException($"{name} contains invalid JSON.", error); }
    }
    private static void CheckJsonKeys(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in element.EnumerateObject())
            {
                if (!names.Add(property.Name)) throw new ArgumentException("Package JSON cannot contain duplicate property names.");
                CheckJsonKeys(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array) foreach (var item in element.EnumerateArray()) CheckJsonKeys(item);
    }
    private static void Only(JsonObject value, string[] keys, string description)
    {
        if (value.Any(pair => !keys.Contains(pair.Key, StringComparer.Ordinal))) throw new ArgumentException($"{description} contains unsupported fields.");
    }
    private static string Text(JsonObject value, string key, int maximum, bool allowWhitespace = false)
    {
        var text = ProjectStore.Required(value, key);
        if (text.Length > maximum || (!allowWhitespace && text.Any(char.IsControl))) throw new ArgumentException($"{key} is too long or contains control characters.");
        return text;
    }
    private static void Dimension(JsonObject value, string key, double minimum)
    {
        if (value[key] is not JsonValue scalar || !scalar.TryGetValue<double>(out var number) || !double.IsFinite(number) || number < minimum || number > 8192)
            throw new ArgumentException($"Project {key} must be between {minimum} and 8192.");
    }
    private static void ValidateScalar(JsonNode? value)
    {
        if (value is null) return;
        if (value is JsonValue scalar && (scalar.TryGetValue<bool>(out _) || scalar.TryGetValue<string>(out var text) && text.Length <= 4096 ||
            scalar.TryGetValue<double>(out var number) && double.IsFinite(number) && (number != Math.Truncate(number) || Math.Abs(number) <= 9007199254740991))) return;
        throw new ArgumentException("Query parameter defaults must be scalar values with bounded text and exact integer precision.");
    }
    private static byte[] JsonBytes(JsonNode value) => JsonSerializer.SerializeToUtf8Bytes(value, ProjectStore.Json);
    private static void CheckSizes(Dictionary<string, byte[]> entries)
    {
        if (entries.Count > MaximumEntries || entries.Sum(pair => (long)pair.Value.Length) > MaximumExpandedBytes) throw new ArgumentException("Project packages are limited to 64 MiB expanded and 512 images.");
    }
    private static uint[] CreateCrcTable()
    {
        var table = new uint[256];
        for (uint index = 0; index < table.Length; index++)
        {
            var value = index;
            for (var bit = 0; bit < 8; bit++) value = (value & 1) == 0 ? value >> 1 : (value >> 1) ^ 0xedb88320;
            table[index] = value;
        }
        return table;
    }
}
