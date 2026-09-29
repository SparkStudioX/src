using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;

namespace SparkStudio.Gateway;

/// <summary>A project's persisted draft, publication, scripts and local assets.</summary>
public sealed class ProjectWorkspace
{
    public string Id { get; }
    public string Directory { get; }
    public ProjectStore Store { get; }
    public LocalAssetStore Assets { get; }
    public PublicationStore Publication { get; }
    public ScriptResourceStore Scripts { get; }

    internal ProjectWorkspace(string id, string directory, IDataProtectionProvider protection, ProjectStore gatewayStore)
    {
        Id = id;
        Directory = directory;
        Store = new ProjectStore(directory, protection, gatewayStore, id);
        Assets = new LocalAssetStore(directory);
        Publication = new PublicationStore(directory, Assets);
        Scripts = new ScriptResourceStore(directory);
    }
}

/// <summary>File-backed project identities, with one shared gateway connection/tag store.</summary>
public sealed class ProjectCatalog
{
    private sealed record Entry(string Id, string CreatedAt, bool Archived);
    private readonly object gate = new();
    private readonly string directory;
    private readonly string projectsDirectory;
    private readonly string catalogPath;
    private readonly IDataProtectionProvider protection;
    private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ProjectWorkspace> workspaces = new(StringComparer.Ordinal);
    private static readonly Regex ProjectId = new(@"\A[a-z][a-z0-9-]{0,63}\z", RegexOptions.CultureInvariant);
    private static readonly Regex SlugSeparators = new("[^a-z0-9]+", RegexOptions.CultureInvariant);
    private static readonly Regex WindowsDevice = new(@"\A(?:con|prn|aux|nul|com[0-9]|lpt[0-9])\z", RegexOptions.CultureInvariant);
    public ProjectStore GatewayStore { get; }
    public string DefaultId { get; private set; } = "default";

    public ProjectCatalog(string dataDirectory, IDataProtectionProvider protection)
    {
        this.protection = protection;
        directory = Path.GetFullPath(dataDirectory);
        System.IO.Directory.CreateDirectory(directory);
        projectsDirectory = Path.Combine(directory, "projects");
        System.IO.Directory.CreateDirectory(projectsDirectory);
        RejectLink(projectsDirectory);
        catalogPath = Path.Combine(directory, "projects.json");
        // A gateway-only store never reads or rewrites legacy project resources.
        // In particular, an existing catalog prevents those backup files from
        // being reimported or becoming a second live cache after migration.
        GatewayStore = new ProjectStore(directory, protection, gatewayOnly: true);
        if (File.Exists(catalogPath)) LoadCatalog();
        else MigrateDefault();
    }

    public JsonArray List(bool includeArchived = false)
    {
        lock (gate)
            return new JsonArray(entries.Values.Where(entry => includeArchived || !entry.Archived)
                .OrderBy(entry => entry.Id == DefaultId ? 0 : 1).ThenBy(entry => entry.CreatedAt, StringComparer.Ordinal)
                .Select(entry => (JsonNode)DescribeCore(entry)).ToArray());
    }

    public JsonObject Describe(string id, bool includeArchived = false)
    {
        lock (gate) return DescribeCore(RequireEntry(id, includeArchived));
    }

    public ProjectWorkspace Get(string id, bool includeArchived = false)
    {
        lock (gate)
        {
            var entry = RequireEntry(id, includeArchived);
            if (workspaces.TryGetValue(entry.Id, out var cached)) return cached;
            var path = ProjectDirectory(entry.Id);
            if (!System.IO.Directory.Exists(path) || !File.Exists(Path.Combine(path, "project.json")))
                throw new InvalidOperationException($"Stored project '{entry.Id}' is missing. Its catalog entry was preserved for recovery.");
            RejectLink(path);
            var workspace = new ProjectWorkspace(entry.Id, path, protection, GatewayStore);
            workspaces.Add(entry.Id, workspace);
            return workspace;
        }
    }

    public ProjectWorkspace Create(string name, JsonObject? project = null, JsonArray? queries = null,
        JsonObject? scripts = null, IReadOnlyList<AssetContent>? assets = null)
    {
        name = ValidateName(name);
        lock (gate)
        {
            if (entries.Count >= 1000) throw new ArgumentException("A gateway supports at most 1,000 projects, including archived projects.");
            var id = NewId(name);
            var draft = NormalizeProject(project ?? BlankProject(), id, name);
            var queryDraft = SparkProjectPackage.ValidateQueries(queries ?? []);
            var scriptDraft = ScriptResourceStore.ValidateDraft(scripts ?? new JsonObject { ["revision"] = 0, ["resources"] = new JsonArray() });
            var content = (assets ?? []).Select(LocalAssetStore.ValidateContent).ToArray();
            var stage = NewStage(id);
            var destination = ProjectDirectory(id);
            var moved = false;
            var committed = false;
            try
            {
                System.IO.Directory.CreateDirectory(stage);
                WriteJson(Path.Combine(stage, "project.json"), draft);
                WriteJson(Path.Combine(stage, "queries.json"), queryDraft);
                WriteJson(Path.Combine(stage, "scripts-draft.json"), scriptDraft);
                var assetStore = new LocalAssetStore(stage);
                foreach (var asset in content) assetStore.Add(asset);
                // Newly created, duplicated and imported resources remain drafts.
                // No published.json or scripts-published.json is created here.
                System.IO.Directory.Move(stage, destination);
                moved = true;
                var workspace = new ProjectWorkspace(id, destination, protection, GatewayStore);
                var entry = new Entry(id, DateTimeOffset.UtcNow.ToString("O"), false);
                PersistCatalog(entries.Values.Append(entry));
                committed = true;
                entries.Add(id, entry);
                workspaces.Add(id, workspace);
                return workspace;
            }
            catch
            {
                if (!committed) DeleteOwnedStage(moved ? destination : stage);
                throw;
            }
        }
    }

    public JsonObject Rename(string id, string name, int revision)
    {
        name = ValidateName(name);
        lock (gate)
        {
            var entry = RequireEntry(id, false);
            var workspace = Get(entry.Id);
            var draft = workspace.Store.GetProject();
            if (draft["revision"]?.GetValue<int>() != revision)
                throw new InvalidOperationException("The project changed since it was loaded. Reload before renaming.");
            draft["name"] = name;
            workspace.Store.SaveProject(draft);
            return DescribeCore(entry);
        }
    }

    public ProjectWorkspace Duplicate(string id, string name)
    {
        lock (gate)
        {
            var source = Get(id);
            var project = source.Store.GetProject();
            var snapshot = source.Store.CapturePublication(project["revision"]!.GetValue<int>());
            var assets = source.Assets.List().Select(asset => source.Assets.Read(asset.Id)).ToArray();
            return Create(name, snapshot["project"]!.AsObject(), snapshot["queries"]!.AsArray(), source.Scripts.GetDraft(), assets);
        }
    }

    public JsonObject SetArchived(string id, bool archived)
    {
        lock (gate)
        {
            var entry = RequireEntry(id, true);
            if (entry.Id == DefaultId && archived)
                throw new InvalidOperationException("The default project cannot be archived because legacy gateway URLs use it. Other projects can be archived and restored.");
            if (entry.Archived != archived)
            {
                var updated = entry with { Archived = archived };
                PersistCatalog(entries.Values.Select(value => value.Id == entry.Id ? updated : value));
                entries[entry.Id] = updated;
                entry = updated;
            }
            return DescribeCore(entry);
        }
    }

    public static string ValidateName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 120 || name.Any(char.IsControl))
            throw new ArgumentException("Project names must contain 1 to 120 characters without control characters.");
        return name.Trim();
    }

    public static string ValidateId(string? id) => id is not null && ProjectId.IsMatch(id) && !WindowsDevice.IsMatch(id)
        ? id : throw new ArgumentException("Project IDs must be safe lowercase slugs, up to 64 characters.");

    private Entry RequireEntry(string id, bool includeArchived)
    {
        ValidateId(id);
        return entries.TryGetValue(id, out var entry) && (includeArchived || !entry.Archived)
            ? entry : throw new KeyNotFoundException("Project not found or archived.");
    }

    private JsonObject DescribeCore(Entry entry)
    {
        var workspace = Get(entry.Id, includeArchived: true);
        var project = workspace.Store.GetProject();
        var publication = workspace.Publication.Metadata();
        var result = new JsonObject
        {
            ["id"] = entry.Id, ["name"] = project["name"]!.DeepClone(), ["revision"] = project["revision"]!.DeepClone(),
            ["archived"] = entry.Archived, ["createdAt"] = entry.CreatedAt, ["isDefault"] = entry.Id == DefaultId,
            ["published"] = publication["published"]!.DeepClone()
        };
        if (publication["revision"] is { } revision) result["publishedRevision"] = revision.DeepClone();
        if (publication["publishedAt"] is { } publishedAt) result["publishedAt"] = publishedAt.DeepClone();
        return result;
    }

    private static JsonObject BlankProject() => new()
    {
        ["parameters"] = new JsonObject(), ["templates"] = new JsonArray(),
        ["screens"] = new JsonArray(new JsonObject
        {
            ["id"] = "main", ["name"] = "Main", ["width"] = 1200d, ["height"] = 760d, ["components"] = new JsonArray()
        })
    };

    private static JsonObject NormalizeProject(JsonObject original, string id, string name)
    {
        var project = original.DeepClone().AsObject();
        project["id"] = id; project["name"] = name; project["revision"] = 0;
        project.Remove("publishedAt");
        ProjectTemplates.ValidateStructure(project);
        ProjectTemplates.StringParameters(project["parameters"], "Project parameters");
        foreach (var document in ProjectTemplates.Documents(project))
        {
            ProjectStore.Required(document, "name");
            Dimension(document, "width", 1); Dimension(document, "height", 1);
            if (document.ContainsKey("parameters")) ProjectTemplates.StringParameters(document["parameters"], "Document parameters");
            foreach (var component in document["components"]!.AsArray().OfType<JsonObject>())
            {
                Dimension(component, "x", 0); Dimension(component, "y", 0);
                Dimension(component, "width", 1); Dimension(component, "height", 1);
                if (component["props"] is not JsonObject) throw new ArgumentException("Every component needs a properties object.");
            }
        }
        return project;
    }

    private static void Dimension(JsonObject value, string key, double minimum)
    {
        if (value[key] is not JsonValue scalar || !scalar.TryGetValue<double>(out var number) || !double.IsFinite(number) || number < minimum || number > 8192)
            throw new ArgumentException($"Project {key} must be a finite number between {minimum} and 8192.");
    }

    private string NewId(string name)
    {
        var root = SlugSeparators.Replace(name.ToLowerInvariant(), "-").Trim('-');
        if (root.Length == 0) root = "project";
        if (root[0] is < 'a' or > 'z' || WindowsDevice.IsMatch(root)) root = "project-" + root;
        root = root[..Math.Min(root.Length, 58)].TrimEnd('-');
        var id = root;
        for (var suffix = 2; entries.ContainsKey(id) || System.IO.Directory.Exists(ProjectDirectory(id)) || File.Exists(ProjectDirectory(id)); suffix++)
        {
            var ending = "-" + suffix.ToString(CultureInfo.InvariantCulture);
            id = root[..Math.Min(root.Length, 64 - ending.Length)].TrimEnd('-') + ending;
        }
        return ValidateId(id);
    }

    private string ProjectDirectory(string id)
    {
        ValidateId(id);
        var path = Path.GetFullPath(Path.Combine(projectsDirectory, id));
        if (!string.Equals(Path.GetDirectoryName(path), projectsDirectory, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            throw new ArgumentException("Project directory escaped the gateway project root.");
        return path;
    }

    private string NewStage(string id) => Path.Combine(projectsDirectory, $".staging-{id}-{Guid.NewGuid():N}");

    private void LoadCatalog()
    {
        if (JsonNode.Parse(File.ReadAllText(catalogPath)) is not JsonObject catalog ||
            catalog["schemaVersion"] is not JsonValue version || !version.TryGetValue<int>(out var schema) || schema != 1 ||
            catalog["projects"] is not JsonArray list || list.Count is < 1 or > 1000)
            throw new InvalidOperationException("The project catalog is invalid. Legacy backup files were not reimported.");
        DefaultId = ValidateId(ProjectStore.Required(catalog, "defaultProjectId"));
        foreach (var node in list)
        {
            if (node is not JsonObject item) throw new InvalidOperationException("The project catalog contains an invalid entry.");
            var id = ValidateId(ProjectStore.Required(item, "id"));
            var created = ProjectStore.Required(item, "createdAt");
            if (!DateTimeOffset.TryParse(created, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _) ||
                item["archived"] is not JsonValue flag || !flag.TryGetValue<bool>(out var archived) || !entries.TryAdd(id, new Entry(id, created, archived)))
                throw new InvalidOperationException("The project catalog contains invalid or duplicate metadata.");
        }
        if (!entries.TryGetValue(DefaultId, out var initial) || initial.Archived)
            throw new InvalidOperationException("The project catalog must contain an active default project.");
    }

    private void MigrateDefault()
    {
        var stage = NewStage(DefaultId);
        var destination = ProjectDirectory(DefaultId);
        var moved = false;
        var committed = false;
        try
        {
            System.IO.Directory.CreateDirectory(stage);
            var legacyProject = ReadLegacy("project.json") switch
            {
                null => Seed.Project(), JsonObject value => value,
                _ => throw new InvalidOperationException("The legacy project draft must be an object.")
            };
            legacyProject["id"] = DefaultId;
            legacyProject["name"] = ValidateName(ProjectStore.Required(legacyProject, "name"));
            WriteJson(Path.Combine(stage, "project.json"), legacyProject);
            var legacyQueries = ReadLegacy("queries.json") switch
            {
                null => Seed.Queries(), JsonArray value => value,
                _ => throw new InvalidOperationException("The legacy named queries must be an array.")
            };
            WriteJson(Path.Combine(stage, "queries.json"), legacyQueries);
            foreach (var name in new[] { "scripts-draft.json", "scripts-published.json", "published.json" })
            {
                var document = ReadLegacy(name);
                if (document is null) continue;
                if (name == "published.json")
                {
                    if (document["project"] is not JsonObject publishedProject) throw new InvalidOperationException("The legacy project publication is invalid.");
                    publishedProject["id"] = DefaultId;
                }
                WriteJson(Path.Combine(stage, name), document);
            }
            var legacyAssetDirectory = Path.Combine(directory, "assets");
            if (System.IO.Directory.Exists(legacyAssetDirectory)) RejectLink(legacyAssetDirectory);
            var legacyAssets = new LocalAssetStore(directory);
            var assets = new LocalAssetStore(stage);
            foreach (var metadata in legacyAssets.List()) assets.Add(legacyAssets.Read(metadata.Id));
            // Validate all stores before replacing an interrupted migration's
            // unlisted destination. Keep that directory recoverable as well.
            _ = new ProjectWorkspace(DefaultId, stage, protection, GatewayStore);
            if (System.IO.Directory.Exists(destination))
            {
                RejectLink(destination);
                System.IO.Directory.Move(destination, Path.Combine(projectsDirectory, $".orphan-default-{Guid.NewGuid():N}"));
            }
            else if (File.Exists(destination)) throw new InvalidOperationException("A file blocks the default project directory.");
            System.IO.Directory.Move(stage, destination); moved = true;
            var workspace = new ProjectWorkspace(DefaultId, destination, protection, GatewayStore);
            var entry = new Entry(DefaultId, DateTimeOffset.UtcNow.ToString("O"), false);
            PersistCatalog([entry]); // Commit last: legacy originals remain untouched.
            committed = true;
            entries.Add(DefaultId, entry); workspaces.Add(DefaultId, workspace);
        }
        catch
        {
            if (!committed) DeleteOwnedStage(moved ? destination : stage);
            throw;
        }
    }

    private JsonNode? ReadLegacy(string name)
    {
        var path = Path.Combine(directory, name);
        return File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path)) ?? throw new InvalidOperationException($"Legacy {name} is empty.") : null;
    }

    private void PersistCatalog(IEnumerable<Entry> values)
    {
        var catalog = new JsonObject
        {
            ["schemaVersion"] = 1, ["defaultProjectId"] = DefaultId,
            ["projects"] = new JsonArray(values.Select(entry => (JsonNode)new JsonObject
            {
                ["id"] = entry.Id, ["createdAt"] = entry.CreatedAt, ["archived"] = entry.Archived
            }).ToArray())
        };
        var temporary = catalogPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { WriteJson(temporary, catalog); File.Move(temporary, catalogPath, overwrite: true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static void WriteJson(string path, JsonNode value) => File.WriteAllText(path, value.ToJsonString(ProjectStore.Json));
    private static void RejectLink(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("Project storage directories cannot be symbolic links or junctions.");
    }
    private void DeleteOwnedStage(string path)
    {
        var absolute = Path.GetFullPath(path);
        if (!string.Equals(Path.GetDirectoryName(absolute), projectsDirectory, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            throw new InvalidOperationException("Refused to clean a directory outside project storage.");
        if (!System.IO.Directory.Exists(absolute)) return;
        RejectLink(absolute);
        System.IO.Directory.Delete(absolute, recursive: true);
    }
}
