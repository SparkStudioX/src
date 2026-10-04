using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

public sealed partial class ProjectStore
{
    private static readonly string[] OpcAuthenticationFailures = ["BadIdentityTokenInvalid", "BadIdentityTokenRejected", "BadUserAccessDenied"];
    private readonly object gate = GatewayConfigurationLock.SyncRoot;
    private readonly string directory;
    private readonly IDataProtector protector;
    private readonly ProjectStore? gatewayStore;
    private readonly string? projectId;
    private JsonObject project;
    private JsonArray connections;
    private JsonArray queries;
    private JsonArray definitions = [];
    private readonly Dictionary<string, string> connectionTests = new(StringComparer.Ordinal);
    private readonly HashSet<string> removedConnectionIds = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (JsonObject Saved, long Generation, ConnectionDefinition Definition)> sourceConnectionCache = new(StringComparer.Ordinal);
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public ProjectStore(string directory, IDataProtectionProvider protection, ProjectStore? gatewayStore = null, string? projectId = null, bool gatewayOnly = false)
    {
        this.directory = directory;
        this.gatewayStore = gatewayStore;
        this.projectId = projectId;
        Directory.CreateDirectory(directory);
        protector = protection.CreateProtector("SparkStudio.ConnectionSecrets.v1");
        RecoverSourceCommit();
        project = gatewayOnly ? Seed.Project() : Load("project.json") switch
        { null => Seed.Project(), JsonObject document => document, _ => throw new InvalidOperationException("Stored project draft must be an object.") };
        if (project["name"] is not JsonValue projectName || !projectName.TryGetValue<string>(out _) ||
            project["revision"] is not JsonValue projectRevision || !projectRevision.TryGetValue<int>(out _))
            throw new InvalidOperationException("Stored project metadata is invalid.");
        if (projectId is not null) project["id"] = projectId;
        connections = gatewayStore is null ? Load("connections.json") switch
        { null => [], JsonArray items => items, _ => throw new InvalidOperationException("Stored connections must be an array.") } : [];
        queries = gatewayOnly ? [] : Load("queries.json") switch
        { null => gatewayStore is null ? Seed.Queries() : [], JsonArray items => items, _ => throw new InvalidOperationException("Stored queries must be an array.") };
        if (gatewayStore is null) {
            LoadSourceDiscovery();
            LoadTagModel(Load("tags.json"));
            ValidateRestoredSourceOwnership();
        }
    }
    private JsonNode? Load(string name) => File.Exists(Path.Combine(directory, name)) ? JsonNode.Parse(File.ReadAllText(Path.Combine(directory, name)))
        ?? throw new InvalidOperationException($"Stored {name} cannot be empty.") : null;
    private void Persist(string name, JsonNode node)
    {
        if (name == "tags.json")
        {
            TagModel.RequireCurrentFormat(node);
            GatewayDataMigrations.Prepare(directory);
        }
        DurableJsonFile.Write(Path.Combine(directory, name), node, Json);
    }
    public JsonObject ProjectMetadata()
    {
        lock (gate) return new() { ["name"] = project["name"]?.DeepClone(), ["revision"] = project["revision"]?.DeepClone() };
    }
    public JsonObject GetProject() { lock (gate) return (JsonObject)project.DeepClone(); }
    public JsonObject CapturePublication(int expectedRevision)
    {
        lock (gate)
        {
            var revision = project["revision"]?.GetValue<int>() ?? 0;
            if (revision != expectedRevision) throw new InvalidOperationException("The project changed since it was loaded. Reload before publishing.");
            return new JsonObject { ["project"] = project.DeepClone(), ["queries"] = queries.DeepClone() };
        }
    }
    public JsonObject SaveProject(JsonObject value)
    {
        lock (gate)
        {
            ProjectTemplates.ValidateStructure(value);
            ComponentQueryBindingValidator.ValidateQueries(value, queries);
            var revision = project["revision"]?.GetValue<int>() ?? 0;
            if ((value["revision"]?.GetValue<int>() ?? -1) != revision) throw new InvalidOperationException("The project changed since it was loaded. Reload before saving.");
            var next = (JsonObject)value.DeepClone();
            if (projectId is not null)
            {
                next["id"] = projectId;
                next["name"] = ProjectCatalog.ValidateName(Required(next, "name"));
            }
            next["revision"] = revision + 1;
            Persist("project.json", next);
            project = next;
            return (JsonObject)project.DeepClone();
        }
    }
    public JsonArray GetConnections()
    {
        if (gatewayStore is not null) return gatewayStore.GetConnections();
        lock (gate)
        {
            return new JsonArray(connections.Select(item => item is JsonObject saved ? (JsonNode)SafeConnection(saved) : item?.DeepClone()).ToArray());
        }
    }
    private JsonObject SafeConnection(JsonObject saved)
    {
        var item = (JsonObject)saved.DeepClone();
        item["revision"] ??= 0;
        item["enabled"] ??= true;
        item["hasPassword"] = item.ContainsKey("protectedPassword");
        item.Remove("protectedPassword");
        item.Remove("password");
        RedactSourceSecrets(item);
        if (item["source"] is JsonObject source) {
            var points = source["points"] as JsonArray ?? [];
            foreach (var point in SourceOwnedPoints(Required(item, "id"))) {
                var owned = JsonSerializer.SerializeToNode(point, Json)!.AsObject(); owned["owned"] = true;
                points.Add(owned);
            }
            source["points"] = points;
        }
        return item;
    }
    public JsonObject SaveConnection(JsonObject value)
    {
        if (gatewayStore is not null) return gatewayStore.SaveConnection(value);
        lock (gate)
        {
            var id = Optional(value, "id") ?? Guid.NewGuid().ToString("N");
            if (removedConnectionIds.Contains(id))
                throw new InvalidOperationException("This connection identity was removed. Create a new connection with a fresh ID.");
            var type = Required(value, "type");
            if (type is not ("opcua" or "sqlserver" or "sqlite") && !DeviceConfiguration.IsDevice(type) && !SourceConfiguration.IsSource(type)) throw new ArgumentException("Choose a supported industrial or database connection.");
            var old = connections.OfType<JsonObject>().FirstOrDefault(x => Optional(x, "id") == id);
            var revision = old?["revision"]?.GetValue<int>() ?? 0;
            if (value.ContainsKey("revision") && (value["revision"] is not JsonValue supplied || !supplied.TryGetValue<int>(out var suppliedRevision) || suppliedRevision < 0))
                throw new ArgumentException("Connection revision must be a nonnegative integer.");
            if (old is null && value.ContainsKey("revision"))
                throw new InvalidOperationException("This connection was removed. Create a new connection instead of saving an obsolete edit.");
            if (old is not null && value["revision"]?.GetValue<int>() != revision)
                throw new InvalidOperationException("The connection changed since it was loaded. Reload before saving.");
            if (old is not null && Optional(old, "type") != type)
                throw new ArgumentException("Create a new connection to change its type.");
            if (value.ContainsKey("enabled") && (value["enabled"] is not JsonValue flag || !flag.TryGetValue<bool>(out _)))
                throw new ArgumentException("Connection enabled must be true or false.");
            var enabled = value["enabled"]?.GetValue<bool>() ?? true;
            var node = new JsonObject { ["id"] = id, ["name"] = ProjectCatalog.ValidateName(Required(value, "name")), ["type"] = type,
                ["revision"] = revision + 1, ["enabled"] = enabled, ["status"] = enabled ? "configured" : "disabled" };
            foreach (var key in new[] { "endpoint", "server", "database", "username", "securityMode", "serverCertificateSha256" })
                if (value[key] is { } item) node[key] = item.DeepClone();
            node["trustServerCertificate"] = value["trustServerCertificate"]?.DeepClone() ?? JsonValue.Create(false);
            if (DeviceConfiguration.IsDevice(type))
            {
                var settings = value["device"]?.Deserialize<DeviceSettings>(Json) ?? throw new ArgumentException("Industrial connections require device settings and a saved point map.");
                DeviceConfiguration.Validate(settings, type);
                ValidateDeviceMapChange(id, settings);
                node["device"] = JsonSerializer.SerializeToNode(settings, Json);
            }
            SourceDiscoveryState? updatedSourceState = null;
            if (SourceConfiguration.IsSource(type))
            {
                var settings = ReadSourceSettingsForSave(value, old);
                settings = SourceConfiguration.Normalize(type, settings);
                ValidateSourceMapChange(id, settings);
                updatedSourceState = PrepareSourceMappingChange(id, settings, Optional(value, "sourceMigrationToken"));
                node["source"] = ProtectSourceSettings(settings);
            }
            var password = Optional(value, "password");
            if (password is not null && password.Length > 0) node["protectedPassword"] = protector.Protect(password);
            else if (password is null && old?["protectedPassword"] is { } secret) node["protectedPassword"] = secret.DeepClone();
            if (type == "opcua" && (!Uri.TryCreate(Required(node, "endpoint"), UriKind.Absolute, out var endpoint) || endpoint.Scheme != "opc.tcp" || !string.IsNullOrEmpty(endpoint.UserInfo)))
                throw new ArgumentException("An opc.tcp endpoint URL without embedded credentials is required.");
            if (type == "sqlserver") { Required(node, "server"); Required(node, "database"); }
            if (type == "sqlite") node["database"] = ConnectorService.ValidateSqliteDatabaseName(Required(node, "database"));
            if (SourceConfiguration.IsSource(type) && updatedSourceState is null) {
                var index = old is null ? -1 : connections.IndexOf(old);
                var candidate = connections.ToList();
                if (index < 0) candidate.Add(node); else candidate[index] = node;
                DurableJsonFile.WriteArray(Path.Combine(directory, "connections.json"), candidate, Json);
                if (index < 0) connections.Add(node); else connections[index] = node;
            }
            else {
                var next = (JsonArray)connections.DeepClone();
                var previous = next.OfType<JsonObject>().FirstOrDefault(x => Optional(x, "id") == id);
                if (previous is not null) next.Remove(previous);
                next.Add(node);
                if (updatedSourceState is not null) CommitSourceConfiguration(next, updatedSourceState);
                else { Persist("connections.json", next); connections = next; }
            }
            tagConfigurationGeneration++;
            // Source map validation preserves every referenced type and read-only
            // access. Endpoint, enable and display edits do not change authored
            // expansion; migration commits invalidate it independently.
            if (!SourceConfiguration.IsSource(type)) expandedTagDefinitions = null;
            expandedTagIndex = null;
            connectionTests.Remove(id);
            return SafeConnection(node);
        }
    }
    public ConnectionDefinition GetConnection(string id, bool allowDisabled = false)
    {
        if (gatewayStore is not null) return gatewayStore.GetConnection(id, allowDisabled);
        lock (gate)
        {
            var value = connections.OfType<JsonObject>().FirstOrDefault(x => Optional(x, "id") == id) ?? throw new KeyNotFoundException("Connection not found.");
            if (!allowDisabled && value["enabled"]?.GetValue<bool>() == false)
                throw new InvalidOperationException("This connection is disabled. Enable and save it before starting an operation.");
            var sourceType = SourceConfiguration.IsSource(Required(value, "type"));
            if (sourceType && sourceConnectionCache.TryGetValue(id, out var cached) && ReferenceEquals(cached.Saved, value) && cached.Generation == sourcePointCatalogGeneration)
                return cached.Definition;
            var encrypted = Optional(value, "protectedPassword");
            var source = UnprotectSourceSettings(value);
            if (source is not null) source = source with { Points = source.SavedPoints.Concat(SourceOwnedPoints(id)).DistinctBy(point => point.Id).ToArray() };
            var result = new ConnectionDefinition(id, Required(value, "name"), Required(value, "type"), Optional(value, "endpoint"), Optional(value, "server"), Optional(value, "database"), Optional(value, "username"), encrypted is null ? null : protector.Unprotect(encrypted), Optional(value, "securityMode"), value["trustServerCertificate"]?.GetValue<bool>() ?? false, Optional(value, "serverCertificateSha256"), value["device"]?.Deserialize<DeviceSettings>(Json), source, value["revision"]?.GetValue<int>() ?? 0);
            if (sourceType) sourceConnectionCache[id] = (value, sourcePointCatalogGeneration, result);
            return result;
        }
    }

    private void ValidateDeviceMapChange(string id, DeviceSettings settings)
    {
        var oldSettings = connections.OfType<JsonObject>().FirstOrDefault(item => Optional(item, "id") == id)?["device"]?.Deserialize<DeviceSettings>(Json);
        var bindings = GetRuntimeTagDefinitions().OfType<JsonObject>()
            .Concat(tagModel["udtDefinitions"]!.AsArray().OfType<JsonObject>().SelectMany(definition => definition["members"]!.AsArray().OfType<JsonObject>()));
        foreach (var binding in bindings.Where(item => Optional(item, "kind") == "device" && Optional(item, "connectionId") == id))
        {
            var point = settings.Points.SingleOrDefault(item => item.Id == Required(binding, "nodeId"));
            var expectedType = Optional(binding, "dataType") ?? oldSettings?.Points.FirstOrDefault(item => item.Id == Required(binding, "nodeId"))?.DataType;
            if (point is null || expectedType is not null && point.DataType != expectedType)
                throw new ArgumentException("A saved tag or UDT member references a point missing from this map or with a different data type. Update its binding before changing the connection map.");
        }
    }
    internal void DeleteConnection(string id, int revision)
    {
        if (gatewayStore is not null) { gatewayStore.DeleteConnection(id, revision); return; }
        lock (gate)
        {
            if (revision < 0) throw new ArgumentException("Connection revision must be a nonnegative integer.");
            var next = (JsonArray)connections.DeepClone();
            var old = next.OfType<JsonObject>().FirstOrDefault(item => Optional(item, "id") == id)
                ?? throw new KeyNotFoundException("Connection not found.");
            if ((old["revision"]?.GetValue<int>() ?? 0) != revision)
                throw new InvalidOperationException("The connection changed since it was loaded. Select it again before deleting.");
            next.Remove(old);
            if (SourceConfiguration.IsSource(Required(old, "type")) && OwnedLeaves.Any(leaf => leaf.ConnectionId == id))
            {
                CommitSourceConfiguration(next, new(1, sourceDiscovery.Generation + 1, OwnedLeaves.Where(leaf => leaf.ConnectionId != id).ToArray()));
            }
            else
            {
            Persist("connections.json", next);
            connections = next;
            }
            removedConnectionIds.Add(id);
            tagConfigurationGeneration++;
            expandedTagDefinitions = null;
            expandedTagIndex = null;
            connectionTests.Remove(id);
        }
    }
    public ConnectionTestCapture BeginConnectionTest(string id)
    {
        if (gatewayStore is not null) return gatewayStore.BeginConnectionTest(id);
        lock (gate)
        {
            var connection = GetConnection(id);
            var value = connections.OfType<JsonObject>().Single(x => Optional(x, "id") == id);
            var token = Guid.NewGuid().ToString("N");
            connectionTests[id] = token;
            return new(connection, value["revision"]?.GetValue<int>() ?? 0, token, DateTimeOffset.UtcNow);
        }
    }
    public JsonObject CompleteConnectionTest(ConnectionTestCapture capture, bool success, double durationMs, string? connectorMessage = null)
    {
        if (gatewayStore is not null) return gatewayStore.CompleteConnectionTest(capture, success, durationMs, connectorMessage);
        lock (gate)
        {
            // Store fixed messages only: connector exception details can include credentials or remote data.
            var result = new JsonObject { ["success"] = success, ["message"] = SafeConnectionTestMessage(success, connectorMessage),
                ["startedAt"] = capture.StartedAt.ToString("O"), ["completedAt"] = DateTimeOffset.UtcNow.ToString("O"),
                ["durationMs"] = Math.Round(Math.Max(0, durationMs), 1), ["revision"] = capture.Revision };
            var next = (JsonArray)connections.DeepClone();
            var value = next.OfType<JsonObject>().FirstOrDefault(x => Optional(x, "id") == capture.Connection.Id);
            var accepted = value is not null && (value["revision"]?.GetValue<int>() ?? 0) == capture.Revision
                && value["enabled"]?.GetValue<bool>() != false && connectionTests.GetValueOrDefault(capture.Connection.Id) == capture.Token;
            result["accepted"] = accepted;
            if (accepted)
            {
                value!["lastTest"] = result.DeepClone();
                value["status"] = success ? "tested" : "error";
                value["lastError"] = success ? null : result["message"]!.DeepClone();
                Persist("connections.json", next);
                connections = next;
                connectionTests.Remove(capture.Connection.Id);
            }
            return result;
        }
    }
    private static string SafeConnectionTestMessage(bool success, string? message)
    {
        const string missingDatabase = "Managed SQLite database does not exist. Create it explicitly before testing or querying this connection.";
        if (success) return "Connection and read check succeeded.";
        if (message == missingDatabase) return missingDatabase;
        if (message is "Username authentication requires Sign or SignAndEncrypt. Anonymous access is supported for explicitly unsecured connections."
            or "Server certificate pin must be a 64-character SHA-256 fingerprint.") return message;
        foreach (var mode in new[] { "None", "Sign", "SignAndEncrypt" })
        {
            foreach (var advice in new[]
            {
                $"The server has no supported {mode} endpoint. Discover endpoints and choose a supported security mode; no weaker fallback was attempted.",
                $"The server requires a username and password for the selected {mode} endpoint. Enter credentials before testing.",
                $"The selected {mode} endpoint does not support username/password authentication. Discover endpoints and check the server authentication settings."
            }) if (message == advice) return advice;
            foreach (var authentication in new[] { "Anonymous", "UserName" })
                if (message == $"Server offers no supported {mode} endpoint for {authentication} authentication. No weaker security fallback was attempted.")
                    return $"No supported {mode} endpoint accepts the selected authentication. Discover endpoints and check the security mode and account settings; no weaker fallback was attempted.";
        }
        if (message == "The server certificate does not match this connection's configured SHA-256 fingerprint.")
            return "The server certificate does not match the saved fingerprint. Discover endpoints and verify its fingerprint independently before updating the pin.";
        bool Status(string status) => message?.StartsWith($"OPC UA failed ({status}, ", StringComparison.Ordinal) == true;
        if (Status("BadCertificateUntrusted"))
            return "The OPC UA server certificate is not trusted. Discover endpoints and verify its fingerprint independently, then set the connection pin or trust its public certificate in Gateway Settings.";
        if (Status("BadCertificateHostNameInvalid"))
            return "The endpoint hostname or IP address does not match the server certificate. Use an address listed in the certificate's subject alternative names.";
        if (Status("BadCertificateTimeInvalid") || Status("BadCertificateIssuerTimeInvalid"))
            return "An OPC UA certificate is expired or not yet valid. Check its validity dates and the clocks on both computers.";
        if (Status("BadCertificateUriInvalid"))
            return "The OPC UA server application URI does not match its certificate. Correct the server's application URI or certificate.";
        if (Status("BadSecurityChecksFailed"))
            return "OPC UA security validation failed. Check that the server trusts SparkStudio's client certificate, the gateway trusts the server, and the endpoint address matches the server certificate.";
        if (OpcAuthenticationFailures
            .Any(status => message?.StartsWith($"OPC UA failed ({status}, ", StringComparison.Ordinal) == true))
            return "OPC UA authentication failed. Check the account credentials and server permissions.";
        return "Connection check failed. Verify the address, authentication and certificate settings.";
    }
    public JsonArray GetQueries() { lock (gate) return (JsonArray)queries.DeepClone(); }
    public JsonObject GetQuery(string id) { lock (gate) return (JsonObject)(queries.OfType<JsonObject>().FirstOrDefault(q => Optional(q, "id") == id)?.DeepClone() ?? throw new KeyNotFoundException("Named query not found.")); }
    public JsonObject SaveQuery(string id, JsonObject query)
    {
        lock (gate)
        {
            Required(query, "name"); Required(query, "connectionId"); Required(query, "sql");
            if ((Optional(query, "kind") ?? "query") is not ("query" or "update")) throw new ArgumentException("Named query kind must be query or update.");
            var node = (JsonObject)query.DeepClone();
            node["id"] = id;
            var next = (JsonArray)queries.DeepClone();
            var old = next.OfType<JsonObject>().FirstOrDefault(x => Optional(x, "id") == id);
            if (old is not null) next.Remove(old);
            next.Add(node);
            ComponentQueryBindingValidator.ValidateQueries(project, next);
            Persist("queries.json", next);
            queries = next;
            return (JsonObject)node.DeepClone();
        }
    }
    public JsonArray GetTagDefinitions()
    {
        if (gatewayStore is not null) return gatewayStore.GetTagDefinitions();
        lock (gate)
        {
            expandedTagDefinitions ??= ExpandTagModel(tagModel);
            ValidateOwnedNamespaces(expandedTagDefinitions);
            var result = (JsonArray)expandedTagDefinitions.DeepClone();
            foreach (var owned in SourceOwnedDefinitions()) result.Add(owned!.DeepClone());
            ApplyMemoryState(result);
            return result;
        }
    }
    internal JsonObject ConnectionMetadata(string id)
    {
        if (gatewayStore is not null) return gatewayStore.ConnectionMetadata(id);
        lock (gate) {
            var item = connections.OfType<JsonObject>().SingleOrDefault(item => Optional(item, "id") == id) ?? throw new KeyNotFoundException("Connection not found.");
            return new() { ["id"] = id, ["type"] = Required(item, "type"), ["revision"] = item["revision"]?.GetValue<int>() ?? 0, ["enabled"] = item["enabled"]?.GetValue<bool>() ?? true };
        }
    }
    internal ConnectionDefinition[] EnabledSourceConnections()
    {
        if (gatewayStore is not null) return gatewayStore.EnabledSourceConnections();
        lock (gate) return connections.OfType<JsonObject>().Where(item => SourceConfiguration.IsSource(Required(item, "type")) && item["enabled"]?.GetValue<bool>() != false)
            .Select(item => GetConnection(Required(item, "id"))).ToArray();
    }
    internal string[] ConnectionTagPaths(string id, bool includeOwned = true)
    {
        if (gatewayStore is not null) return gatewayStore.ConnectionTagPaths(id, includeOwned);
        lock (gate) {
            expandedTagDefinitions ??= ExpandTagModel(tagModel);
            return expandedTagDefinitions.OfType<JsonObject>().Where(tag => Optional(tag, "connectionId") == id).Select(tag => Required(tag, "path"))
                .Concat(includeOwned ? OwnedLeaves.Where(leaf => leaf.ConnectionId == id && !leaf.Suppressed && !leaf.Pruned).Select(leaf => leaf.Path) : []).ToArray();
        }
    }
    internal string[] ConnectionUdtReferences(string id)
    {
        if (gatewayStore is not null) return gatewayStore.ConnectionUdtReferences(id);
        lock (gate) return tagModel["udtDefinitions"]!.AsArray().OfType<JsonObject>()
            .SelectMany(definition => definition["members"]!.AsArray().OfType<JsonObject>().Where(member => Optional(member, "connectionId") == id)
                .Select(member => TagModel.DefinitionKey(definition) + "/" + Required(member, "path"))).ToArray();
    }
    internal (string Path, bool Enabled)[] ConnectionRuntimeBindings(string id)
    {
        if (gatewayStore is not null) return gatewayStore.ConnectionRuntimeBindings(id);
        lock (gate) {
            expandedTagDefinitions ??= ExpandTagModel(tagModel);
            return expandedTagDefinitions.OfType<JsonObject>().Where(tag => Optional(tag, "connectionId") == id)
                .Select(tag => (Required(tag, "path"), tag["effectiveEnabled"]?.GetValue<bool>() != false))
                .Concat(OwnedLeaves.Where(leaf => leaf.ConnectionId == id && !leaf.Suppressed && !leaf.Pruned)
                    .Select(leaf => (leaf.Path, DefaultTagProviderEnabled()))).ToArray();
        }
    }
    public JsonObject SaveTag(JsonObject value)
    {
        if (gatewayStore is not null) return gatewayStore.SaveTag(value);
        lock (gate)
        {
            var node = NormalizeTag(value);
            var tagPath = Required(node, "path");
            var current = GetTagDefinitions();
            if (current.OfType<JsonObject>().Any(tag => Optional(tag, "path") == tagPath && tag["sourceOwned"]?.GetValue<bool>() == true))
                throw new ArgumentException("A source-owned tag is edited through its mapping; it cannot be replaced by an authored definition.");
            if (current.OfType<JsonObject>().Any(tag => Optional(tag, "path") == tagPath && tag["udtInstance"] is not null))
                throw new ArgumentException("Edit UDT members through a reviewed instance override or a new definition version.");
            var next = (JsonArray)definitions.DeepClone();
            var old = next.OfType<JsonObject>().FirstOrDefault(x => Optional(x, "path") == tagPath);
            if (old is null && current.Count >= TagModel.MaximumTags) throw new ArgumentException($"A gateway supports at most {TagModel.MaximumTags} configured tags, including UDT members.");
            if (old is not null) next.Remove(old);
            next.Add(node);
            var model = ModelWithTags(next); var expanded = ExpandTagModel(model);
            PersistTagModel(model);
            return (JsonObject)expanded.OfType<JsonObject>().Single(tag => Required(tag, "path") == tagPath).DeepClone();
        }
    }
    public bool DeleteTag(string path)
    {
        if (gatewayStore is not null) return gatewayStore.DeleteTag(path);
        lock (gate)
        {
            TagDefinitionValidator.Path(path);
            if (DeleteOwnedTag(path)) return true;
            if (GetTagDefinitions().OfType<JsonObject>().Any(tag => Optional(tag, "path") == path && tag["udtInstance"] is not null))
                throw new ArgumentException("Remove a UDT instance through a reviewed tag model change.");
            var next = (JsonArray)definitions.DeepClone();
            var old = next.OfType<JsonObject>().FirstOrDefault(x => Optional(x, "path") == path);
            if (old is null) return false;
            next.Remove(old);
            var model = ModelWithTags(next); ExpandTagModel(model); PersistTagModel(model);
            return true;
        }
    }
    public JsonObject WriteMemoryTag(string path, JsonElement value)
    {
        if (gatewayStore is not null) return gatewayStore.WriteMemoryTag(path, value);
        lock (gate)
        {
            TagDefinitionValidator.Path(path);
            expandedTagDefinitions ??= ExpandTagModel(tagModel);
            expandedTagIndex ??= expandedTagDefinitions.OfType<JsonObject>().ToDictionary(tag => Required(tag, "path"), StringComparer.Ordinal);
            var old = expandedTagIndex.TryGetValue(path, out var definition) ? (JsonObject)definition.DeepClone()
                : throw new KeyNotFoundException("Tag definition not found.");
            if (TagDefinitionValidator.Kind(old) != "memory") throw new ArgumentException("Only configured memory tags can be written.");
            if (old["effectiveEnabled"]?.GetValue<bool>() != true) throw new ArgumentException("Disabled memory tags cannot be written.");
            var typed = TagDefinitionValidator.MemoryValue(TagDefinitionValidator.DataType(old), value);
            memoryTagState[path] = new JsonObject { ["dataType"] = old["dataType"]!.DeepClone(), ["configuration"] = Hash(old.ToJsonString()), ["value"] = typed.DeepClone() };
            memoryStateGeneration++;
            old["value"] = typed.DeepClone();
            return old;
        }
    }
    public static string Required(JsonObject value, string key) => !string.IsNullOrWhiteSpace(Optional(value, key)) ? Optional(value, key)! : throw new ArgumentException($"{key} is required.");
    public static string? Optional(JsonObject value, string key) => value[key] is null ? null
        : value[key] is JsonValue scalar && scalar.TryGetValue<string>(out var text) ? text : throw new ArgumentException($"{key} must be text.");
}

public sealed record ConnectionTestCapture(ConnectionDefinition Connection, int Revision, string Token, DateTimeOffset StartedAt);
