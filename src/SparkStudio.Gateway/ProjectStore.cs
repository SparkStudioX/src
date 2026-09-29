using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

public sealed class ProjectStore
{
    private readonly object gate = new();
    private readonly string directory;
    private readonly IDataProtector protector;
    private readonly ProjectStore? gatewayStore;
    private readonly string? projectId;
    private JsonObject project;
    private JsonArray connections;
    private JsonArray queries;
    private JsonArray definitions;
    private readonly Dictionary<string, string> connectionTests = new(StringComparer.Ordinal);
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public ProjectStore(string directory, IDataProtectionProvider protection, ProjectStore? gatewayStore = null, string? projectId = null, bool gatewayOnly = false)
    {
        this.directory = directory;
        this.gatewayStore = gatewayStore;
        this.projectId = projectId;
        Directory.CreateDirectory(directory);
        protector = protection.CreateProtector("SparkStudio.ConnectionSecrets.v1");
        project = gatewayOnly ? Seed.Project() : Load("project.json") as JsonObject ?? Seed.Project();
        if (projectId is not null) project["id"] = projectId;
        connections = gatewayStore is null ? Load("connections.json") as JsonArray ?? [] : [];
        queries = gatewayOnly ? [] : Load("queries.json") as JsonArray ?? (gatewayStore is null ? Seed.Queries() : []);
        definitions = gatewayStore is null ? Load("tags.json") as JsonArray ?? [] : [];
    }
    private JsonNode? Load(string name) => File.Exists(Path.Combine(directory, name)) ? JsonNode.Parse(File.ReadAllText(Path.Combine(directory, name))) : null;
    private void Persist(string name, JsonNode node)
    {
        var path = Path.Combine(directory, name);
        File.WriteAllText(path + ".tmp", node.ToJsonString(Json));
        File.Move(path + ".tmp", path, true);
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
            var safe = (JsonArray)connections.DeepClone();
            foreach (var item in safe.OfType<JsonObject>())
            {
                item["revision"] ??= 0;
                item["enabled"] ??= true;
                item["hasPassword"] = item.ContainsKey("protectedPassword");
                item.Remove("protectedPassword");
                item.Remove("password");
            }
            return safe;
        }
    }
    public JsonObject SaveConnection(JsonObject value)
    {
        if (gatewayStore is not null) return gatewayStore.SaveConnection(value);
        lock (gate)
        {
            var id = Optional(value, "id") ?? Guid.NewGuid().ToString("N");
            var type = Required(value, "type");
            if (type is not ("opcua" or "sqlserver" or "sqlite")) throw new ArgumentException("Choose an OPC UA, SQL Server, or SQLite connection.");
            var next = (JsonArray)connections.DeepClone();
            var old = next.OfType<JsonObject>().FirstOrDefault(x => Optional(x, "id") == id);
            var revision = old?["revision"]?.GetValue<int>() ?? 0;
            if (value.ContainsKey("revision") && (value["revision"] is not JsonValue supplied || !supplied.TryGetValue<int>(out var suppliedRevision) || suppliedRevision < 0))
                throw new ArgumentException("Connection revision must be a nonnegative integer.");
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
            var password = Optional(value, "password");
            if (password is not null && password.Length > 0) node["protectedPassword"] = protector.Protect(password);
            else if (password is null && old?["protectedPassword"] is { } secret) node["protectedPassword"] = secret.DeepClone();
            if (type == "opcua" && (!Uri.TryCreate(Required(node, "endpoint"), UriKind.Absolute, out var endpoint) || endpoint.Scheme != "opc.tcp" || !string.IsNullOrEmpty(endpoint.UserInfo)))
                throw new ArgumentException("An opc.tcp endpoint URL without embedded credentials is required.");
            if (type == "sqlserver") { Required(node, "server"); Required(node, "database"); }
            if (type == "sqlite") node["database"] = ConnectorService.ValidateSqliteDatabaseName(Required(node, "database"));
            if (old is not null) next.Remove(old);
            next.Add(node);
            Persist("connections.json", next);
            connections = next;
            connectionTests.Remove(id);
            return (JsonObject)GetConnections().OfType<JsonObject>().Single(x => Optional(x, "id") == id).DeepClone();
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
            var encrypted = Optional(value, "protectedPassword");
            return new ConnectionDefinition(id, Required(value, "name"), Required(value, "type"), Optional(value, "endpoint"), Optional(value, "server"), Optional(value, "database"), Optional(value, "username"), encrypted is null ? null : protector.Unprotect(encrypted), Optional(value, "securityMode"), value["trustServerCertificate"]?.GetValue<bool>() ?? false, Optional(value, "serverCertificateSha256"));
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
        if (new[] { "BadSecurityChecksFailed", "BadCertificateUntrusted", "BadCertificateHostNameInvalid", "BadCertificateTimeInvalid", "BadCertificateIssuerTimeInvalid", "BadCertificateUriInvalid" }
            .Any(status => message?.StartsWith($"OPC UA failed ({status}, ", StringComparison.Ordinal) == true))
            return "OPC UA certificate or security validation failed. Check certificate trust, validity, hostname and endpoint security mode.";
        if (new[] { "BadIdentityTokenInvalid", "BadIdentityTokenRejected", "BadUserAccessDenied" }
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
            return new JsonArray(definitions.Select(node => node is JsonObject value
                ? (JsonNode)TagDefinitionValidator.WithLegacyDefaults(value)
                : node?.DeepClone()).ToArray());
        }
    }
    public JsonObject SaveTag(JsonObject value)
    {
        if (gatewayStore is not null) return gatewayStore.SaveTag(value);
        lock (gate)
        {
            var tagPath = TagDefinitionValidator.Path(TagDefinitionValidator.Text(value, "path"));
            var kind = TagDefinitionValidator.Kind(value);
            if (kind is not ("opcua" or "memory")) throw new ArgumentException("kind must be opcua or memory.");
            var node = new JsonObject
            {
                ["path"] = tagPath, ["kind"] = kind,
                ["enabled"] = TagDefinitionValidator.Enabled(value),
                ["publishingIntervalMs"] = TagDefinitionValidator.PublishingInterval(value)
            };
            if (kind == "opcua")
            {
                var connectionId = TagDefinitionValidator.Text(value, "connectionId");
                ConnectionDefinition connection;
                try { connection = GetConnection(connectionId, allowDisabled: true); }
                catch (KeyNotFoundException error) { throw new ArgumentException("An existing OPC UA connection is required.", error); }
                if (connection.Type != "opcua") throw new ArgumentException("Tag bindings require an OPC UA connection.");
                node["connectionId"] = connectionId;
                node["nodeId"] = TagDefinitionValidator.NodeIdentifier(value);
                if (value.ContainsKey("dataType")) node["dataType"] = TagDefinitionValidator.DataType(value);
            }
            else
            {
                var type = TagDefinitionValidator.DataType(value);
                node["dataType"] = type;
                node["value"] = TagDefinitionValidator.MemoryValue(type, value["value"]);
            }
            var next = (JsonArray)definitions.DeepClone();
            var old = next.OfType<JsonObject>().FirstOrDefault(x => Optional(x, "path") == tagPath);
            if (old is null && next.Count >= 1000) throw new ArgumentException("A gateway supports at most 1000 configured tags in this version.");
            if (old is not null) next.Remove(old);
            next.Add(node);
            Persist("tags.json", next);
            definitions = next;
            return (JsonObject)node.DeepClone();
        }
    }
    public bool DeleteTag(string path)
    {
        if (gatewayStore is not null) return gatewayStore.DeleteTag(path);
        lock (gate)
        {
            TagDefinitionValidator.Path(path);
            var next = (JsonArray)definitions.DeepClone();
            var old = next.OfType<JsonObject>().FirstOrDefault(x => Optional(x, "path") == path);
            if (old is null) return false;
            next.Remove(old);
            Persist("tags.json", next);
            definitions = next;
            return true;
        }
    }
    public JsonObject WriteMemoryTag(string path, JsonElement value)
    {
        if (gatewayStore is not null) return gatewayStore.WriteMemoryTag(path, value);
        lock (gate)
        {
            TagDefinitionValidator.Path(path);
            var next = (JsonArray)definitions.DeepClone();
            var old = next.OfType<JsonObject>().FirstOrDefault(x => Optional(x, "path") == path)
                ?? throw new KeyNotFoundException("Tag definition not found.");
            if (TagDefinitionValidator.Kind(old) != "memory") throw new ArgumentException("Only configured memory tags can be written.");
            if (!TagDefinitionValidator.Enabled(old)) throw new ArgumentException("Disabled memory tags cannot be written.");
            old["value"] = TagDefinitionValidator.MemoryValue(TagDefinitionValidator.DataType(old), value);
            Persist("tags.json", next);
            definitions = next;
            return TagDefinitionValidator.WithLegacyDefaults(old);
        }
    }
    public static string Required(JsonObject value, string key) => !string.IsNullOrWhiteSpace(Optional(value, key)) ? Optional(value, key)! : throw new ArgumentException($"{key} is required.");
    public static string? Optional(JsonObject value, string key) => value[key] is null ? null
        : value[key] is JsonValue scalar && scalar.TryGetValue<string>(out var text) ? text : throw new ArgumentException($"{key} must be text.");
}

public sealed record ConnectionTestCapture(ConnectionDefinition Connection, int Revision, string Token, DateTimeOffset StartedAt);
