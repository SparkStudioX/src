using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record CommandReviewRequest(string PublishedAt, JsonElement Value);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record CommandExecuteRequest(string Token, bool Confirmed);

public static class EquipmentCommandDefinitions
{
    public static void Validate(JsonObject project)
    {
        if (!project.ContainsKey("commands"))
        {
            if (ProjectTemplates.Components(project).Any(item => ProjectStore.Optional(item, "type") == "equipmentCommand" || item["props"]?["commandId"] is not null)) throw new ArgumentException("Declare project equipment commands before adding a command control or setpoint input.");
            return;
        }
        if (project["commands"] is not JsonArray commands || commands.Count > 128) throw new ArgumentException("A project supports up to 128 equipment commands.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in commands)
        {
            if (node is not JsonObject command || command.Any(pair => pair.Key is not ("id" or "name" or "tagPath" or "dataType" or "min" or "max" or "maxLength" or "confirmation" or "readbackPath" or "timeoutMs" or "tolerance"))) throw new ArgumentException("Unsupported equipment command definition.");
            var id = ProjectStore.Required(command, "id");
            if (!Regex.IsMatch(id, @"\A[a-zA-Z][a-zA-Z0-9_-]{0,63}\z") || !ids.Add(id)) throw new ArgumentException("Equipment commands require unique stable IDs.");
            if (ProjectStore.Required(command, "name").Length > 128 || ProjectStore.Required(command, "confirmation").Length > 512) throw new ArgumentException("Command names allow 128 characters and confirmation text allows 512.");
            TagDefinitionValidator.Path(ProjectStore.Required(command, "tagPath"));
            if (command.ContainsKey("readbackPath")) TagDefinitionValidator.Path(ProjectStore.Required(command, "readbackPath"));
            var type = TagDefinitionValidator.DataType(command);
            if (type is not ("String" or "Boolean"))
            {
                var min = Number(command, "min"); var max = Number(command, "max");
                if (min > max) throw new ArgumentException("Command minimum cannot exceed maximum.");
            }
            else if (command.ContainsKey("min") || command.ContainsKey("max") || command.ContainsKey("tolerance")) throw new ArgumentException("Text and Boolean commands do not accept numeric bounds or tolerance.");
            if (command.ContainsKey("maxLength") && (type != "String" || Integer(command, "maxLength") is < 1 or > 1024)) throw new ArgumentException("Text command length must be from 1 to 1,024.");
            if (command.ContainsKey("timeoutMs") && Integer(command, "timeoutMs") is < 100 or > 10000) throw new ArgumentException("Command readback timeout must be 100–10,000 milliseconds.");
            if (command.ContainsKey("tolerance") && Number(command, "tolerance") < 0) throw new ArgumentException("Readback tolerance cannot be negative.");
        }
        foreach (var component in ProjectTemplates.Components(project).Where(item => ProjectStore.Optional(item, "type") == "equipmentCommand"))
            if (component["props"] is not JsonObject props || !ids.Contains(ProjectStore.Required(props, "commandId"))) throw new ArgumentException("An equipment command control must reference a declared project command.");
        foreach (var component in ProjectTemplates.Components(project).Where(item => ProjectStore.Optional(item, "type") != "equipmentCommand" && item["props"]?["commandId"] is not null))
        {
            if (ProjectStore.Optional(component, "type") != "numberInput") throw new ArgumentException("Write-on-commit commands require a numeric input.");
            var id = ProjectStore.Required(component["props"]!.AsObject(), "commandId");
            var command = commands.OfType<JsonObject>().FirstOrDefault(item => ProjectStore.Required(item, "id") == id);
            if (command is null || TagDefinitionValidator.DataType(command) is "String" or "Boolean") throw new ArgumentException("A setpoint input must reference a declared numeric equipment command.");
        }
    }
    public static JsonNode Value(JsonObject definition, JsonElement value)
    {
        var type = TagDefinitionValidator.DataType(definition);
        var result = TagDefinitionValidator.MemoryValue(type, value);
        if (type == "String" && result.GetValue<string>().Length > (definition.ContainsKey("maxLength") ? Integer(definition, "maxLength") : 128)) throw new ArgumentException("Requested text exceeds the command's length limit.");
        if (type is not ("String" or "Boolean"))
        {
            var number = result.Deserialize<double>();
            if (Math.Abs(number) > 9007199254740991d && number == Math.Truncate(number) || number < Number(definition, "min") || number > Number(definition, "max")) throw new ArgumentException("Requested value is outside the command's permitted range or precision.");
        }
        return result;
    }
    internal static double Number(JsonObject value, string key)
    {
        if (value[key] is not JsonValue scalar || !scalar.TryGetValue<double>(out var number) || !double.IsFinite(number) || Math.Abs(number) > 9007199254740991d && number == Math.Truncate(number)) throw new ArgumentException($"{key} must be a finite precise number.");
        return number;
    }
    private static int Integer(JsonObject value, string key) => value[key] is JsonValue scalar && scalar.TryGetValue<int>(out var number) ? number : throw new ArgumentException($"{key} must be an integer.");
}

/// <summary>Short-lived reviewed intents; equipment writes are never implicitly retried.</summary>
public sealed class EquipmentCommands(ConnectorService connectors, TagEngine tags, SecurityStore security, RecoveryQuarantine recovery, TimeProvider? timeProvider = null)
{
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
    private sealed record Ticket(string Id, string UserId, long UserRevision, string ProjectId, string PublishedAt, string Resource, JsonObject Definition, JsonNode Value, JsonNode Expected, string Configuration, DateTimeOffset Expires, Func<CancellationToken, Task<JsonObject>>? Resolver = null, Func<bool>? CurrentSession = null);
    private readonly object gate = new();
    private readonly Dictionary<string, Ticket> tickets = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> paths = new(StringComparer.Ordinal);
    private static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    internal static JsonObject Definition(PublicationStore publication, string id, string? stamp)
    {
        var project = publication.GetProject();
        if (stamp is not null && ProjectStore.Required(project, "publishedAt") != stamp) throw new InvalidOperationException("The application changed. Load its current publication before commanding equipment.");
        return (project["commands"] as JsonArray)?.OfType<JsonObject>().SingleOrDefault(item => ProjectStore.Optional(item, "id") == id)?.DeepClone().AsObject() ?? throw new KeyNotFoundException("The published equipment command does not exist.");
    }
    private static JsonObject Tag(ProjectStore store, string path)
    {
        var tag = store.GetRuntimeTagDefinitions().OfType<JsonObject>().SingleOrDefault(item => ProjectStore.Optional(item, "path") == path) ?? throw new ArgumentException("The configured command tag is unavailable.");
        if (!TagDefinitionValidator.Enabled(tag) || tag["effectiveEnabled"]?.GetValue<bool>() == false || !store.DefaultTagProviderEnabled() || TagDefinitionValidator.Kind(tag) is not ("memory" or "opcua")) throw new ArgumentException("Commands require enabled memory or OPC UA tags.");
        return tag;
    }
    private static string Configuration(ProjectStore store, JsonObject definition)
    {
        var target = Tag(store, ProjectStore.Required(definition, "tagPath"));
        var readback = Tag(store, ProjectStore.Optional(definition, "readbackPath") ?? ProjectStore.Required(definition, "tagPath"));
        var type = TagDefinitionValidator.DataType(definition);
        if (TagDefinitionValidator.DataType(target) != type || TagDefinitionValidator.DataType(readback) != type) throw new ArgumentException("Command and readback tag types must match the configured command.");
        // Memory values are compared separately; configuration identity includes all
        // tag options and public connection revisions, never decrypted credentials.
        target.Remove("value"); readback.Remove("value");
        foreach (var tag in new[] { target, readback }) if (TagDefinitionValidator.Kind(tag) == "opcua") _ = store.GetConnection(ProjectStore.Required(tag, "connectionId"));
        return Hash(target.ToJsonString() + readback.ToJsonString() + store.GetConnections().ToJsonString());
    }
    private async Task<JsonNode> Read(ProjectStore store, string path, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        var definition = Tag(store, path);
        if (TagDefinitionValidator.Kind(definition) == "memory") return definition["value"]?.DeepClone() ?? throw new InvalidOperationException("The memory value is unavailable.");
        var result = (await connectors.ReadAsync(store.GetConnection(ProjectStore.Required(definition, "connectionId")), [ProjectStore.Required(definition, "nodeId")], cancellation)).Single();
        if (!result.Quality.StartsWith("Good", StringComparison.OrdinalIgnoreCase) || result.Value is null) throw new InvalidOperationException("The device did not return a good-quality value.");
        return JsonSerializer.SerializeToNode(result.Value) ?? throw new InvalidOperationException("The device value is unavailable.");
    }
    public async Task<object> Review(HttpContext context, ProjectStore store, PublicationStore publication, string id, CommandReviewRequest request, CancellationToken cancellation)
        => await ReviewDefinition(context, store, id, request.PublishedAt, Definition(publication, id, request.PublishedAt), request.Value, "command:" + id, null, cancellation);

    public async Task<object> ReviewNative(HttpContext context, ProjectStore store, string resource, string stamp,
        Func<CancellationToken, Task<JsonObject>> resolver, CancellationToken cancellation, Func<bool>? currentSession = null)
    {
        if (!GatewayAccess.IsOperator(context) || !security.Can(GatewayAccess.Actor(context), GatewayAccess.ProjectId(context), "command") || currentSession?.Invoke() == false)
            throw new BadHttpRequestException("Equipment command permission and a current operator session are required.", 403);
        recovery.EnsureOperationsAllowed();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation); deadline.CancelAfter(TimeSpan.FromSeconds(10));
        var definition = await resolver(deadline.Token);
        return await ReviewDefinition(context, store, ProjectStore.Required(definition, "id"), stamp, definition,
            JsonSerializer.SerializeToElement(definition["value"]), resource, resolver, deadline.Token, currentSession);
    }

    private async Task<object> ReviewDefinition(HttpContext context, ProjectStore store, string id, string stamp, JsonObject definition,
        JsonElement requested, string resource, Func<CancellationToken, Task<JsonObject>>? resolver, CancellationToken cancellation, Func<bool>? currentSession = null)
    {
        recovery.EnsureOperationsAllowed();
        if (string.IsNullOrWhiteSpace(stamp)) throw new ArgumentException("Load the published application before reviewing a command.");
        var actor = GatewayAccess.Actor(context);
        if (!GatewayAccess.IsOperator(context) || !security.Can(actor, GatewayAccess.ProjectId(context), "command")) throw new BadHttpRequestException("Equipment command permission is required.", 403);
        if (!CanReadTargets(context, definition)) throw new BadHttpRequestException("This project's tag access does not include the command target and readback.", 403);
        var value = EquipmentCommandDefinitions.Value(definition, requested);
        var configuration = Configuration(store, definition);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation); timeout.CancelAfter(TimeSpan.FromSeconds(10));
        var expected = await Read(store, ProjectStore.Required(definition, "tagPath"), timeout.Token);
        if (currentSession?.Invoke() == false) throw new BadHttpRequestException("The operator session ended before review completed.", 403);
        var ticket = new Ticket(Guid.NewGuid().ToString("N"), actor.Id, actor.Revision, GatewayAccess.ProjectId(context), stamp, resource, definition, value, expected, configuration, clock.GetUtcNow().AddSeconds(30), resolver, currentSession);
        lock (gate)
        {
            foreach (var expired in tickets.Where(pair => pair.Value.Expires <= clock.GetUtcNow()).Select(pair => pair.Key).ToArray()) tickets.Remove(expired);
            if (tickets.Count >= 128 || tickets.Values.Count(item => item.UserId == actor.Id) >= 8) throw new InvalidOperationException("Too many pending command reviews. Wait for them to expire.");
            tickets.Add(ticket.Id, ticket);
        }
        security.Audit(actor, "equipment.review", ticket.ProjectId, "Reviewed", resource: ticket.Id + ":" + id);
        return new { token = ticket.Id, commandId = id, name = ProjectStore.Required(definition, "name"), currentValue = expected, requestedValue = value, confirmation = ProjectStore.Optional(definition, "confirmation") ?? "", expiresAt = ticket.Expires };
    }
    public async Task<object> Execute(HttpContext context, ProjectStore store, PublicationStore publication, string id, CommandExecuteRequest request, CancellationToken cancellation)
        => await ExecuteDefinition(context, store, publication, id, "command:" + id, request, cancellation);

    public async Task<object> ExecuteNative(HttpContext context, ProjectStore store, PublicationStore publication, string resource, CommandExecuteRequest request, CancellationToken cancellation)
        => await ExecuteDefinition(context, store, publication, null, resource, request, cancellation);

    private async Task<object> ExecuteDefinition(HttpContext context, ProjectStore store, PublicationStore publication, string? id, string resource, CommandExecuteRequest request, CancellationToken cancellation)
    {
        recovery.EnsureOperationsAllowed();
        var actor = GatewayAccess.Actor(context);
        Ticket ticket;
        lock (gate)
        {
            if (!request.Confirmed || !tickets.TryGetValue(request.Token, out ticket!) || ticket.UserId != actor.Id || ticket.UserRevision != actor.Revision || ticket.ProjectId != GatewayAccess.ProjectId(context) || ticket.Resource != resource) throw new InvalidOperationException("Review this command and explicitly confirm it before execution.");
            tickets.Remove(request.Token); // A reviewed intent can dispatch at most once, including after failure.
        }
        if (ticket.Expires <= clock.GetUtcNow()) throw new InvalidOperationException("This command review expired. Review current equipment state again.");
        var path = ProjectStore.Required(ticket.Definition, "tagPath");
        if (paths.Count >= 4096 && !paths.ContainsKey(path)) throw new InvalidOperationException("The command path capacity has been reached.");
        var serial = paths.GetOrAdd(path, _ => new SemaphoreSlim(1, 1));
        if (!await serial.WaitAsync(0, cancellation)) throw new InvalidOperationException("Another command to this tag is in progress. Review current state when it finishes.");
        var dispatched = false;
        try
        {
            security.Audit(actor, "equipment.command", ticket.ProjectId, "Started", resource: ticket.Id + ":" + ProjectStore.Required(ticket.Definition, "id"));
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation); timeout.CancelAfter(TimeSpan.FromSeconds(15));
            var definition = ticket.Resolver is null ? Definition(publication, id!, ticket.PublishedAt) : await ticket.Resolver(timeout.Token);
            if (!JsonNode.DeepEquals(definition, ticket.Definition) || Configuration(store, definition) != ticket.Configuration) throw new InvalidOperationException("Equipment configuration changed. Review the command again.");
            var current = await Read(store, path, timeout.Token);
            if (!Matches(current, ticket.Expected, 0)) throw new InvalidOperationException("The equipment value changed after review. Review it again.");
            void ValidateDispatch()
            {
                timeout.Token.ThrowIfCancellationRequested();
                recovery.EnsureOperationsAllowed();
                if (ticket.CurrentSession?.Invoke() == false) throw new BadHttpRequestException("The operator session ended before dispatch.", 403);
                if (!GatewayAccess.IsOperator(context) || !security.Can(actor, ticket.ProjectId, "command")) throw new BadHttpRequestException("Equipment command permission changed. Sign in and review again.", 403);
                if (!CanReadTargets(context, definition)) throw new BadHttpRequestException("This project's command tag access changed. Review its tag access before commanding equipment.", 403);
                if (Configuration(store, definition) != ticket.Configuration) throw new InvalidOperationException("Equipment configuration changed before dispatch.");
                // Publication validation is synchronous at the dispatch boundary. The
                // native resolver has already rechecked instance/query membership above.
                var active = publication.GetProject();
                if (ProjectStore.Required(active, "publishedAt") != ticket.PublishedAt) throw new InvalidOperationException("The application changed before dispatch.");
                if (ticket.Resolver is null) _ = Definition(publication, id!, ticket.PublishedAt);
            }
            ValidateDispatch();
            var tag = Tag(store, path);
            var element = JsonSerializer.SerializeToElement(ticket.Value);
            string status;
            if (TagDefinitionValidator.Kind(tag) == "memory") status = tags.WriteReviewedMemory(path, element, () => {
                ValidateDispatch();
                if (!Matches(Tag(store, path)["value"], ticket.Expected, 0)) throw new InvalidOperationException("The equipment value changed after review. Review it again.");
                dispatched = true;
            });
            else status = await connectors.WriteValueAsync(store.GetConnection(ProjectStore.Required(tag, "connectionId")), ProjectStore.Required(tag, "nodeId"), TagDefinitionValidator.DataType(definition), element, timeout.Token,
                () => { ValidateDispatch(); dispatched = true; });
            if (!status.StartsWith("Good", StringComparison.Ordinal)) return Result("rejected", "The target rejected the write: " + status);
            var readbackPath = ProjectStore.Optional(definition, "readbackPath") ?? path;
            using var readbackDeadline = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token);
            readbackDeadline.CancelAfter(definition["timeoutMs"]?.GetValue<int>() ?? 3000);
            var tolerance = definition.ContainsKey("tolerance") ? EquipmentCommandDefinitions.Number(definition, "tolerance") : 0;
            JsonNode? observed = null;
            try
            {
                while (true)
                {
                    observed = await Read(store, readbackPath, readbackDeadline.Token);
                    if (Matches(observed, ticket.Value, tolerance)) return Result("confirmed", "Write accepted and matching readback observed.", observed);
                    await Task.Delay(100, readbackDeadline.Token);
                }
            }
            catch (OperationCanceledException) when (!timeout.IsCancellationRequested && readbackDeadline.IsCancellationRequested) { }
            return Result("notConfirmed", "Write accepted, but matching readback was not observed. Do not assume the equipment reached the requested state.", observed);
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            return Result(dispatched ? "uncertain" : "rejected", dispatched ? "Communication or readback failed after dispatch. The target may have changed; inspect its current state before another command." : error is ArgumentException or InvalidOperationException ? error.Message : "The command could not be validated; no write was dispatched.");
        }
        finally { serial.Release(); }
        object Result(string status, string message, JsonNode? observed = null)
        {
            security.Audit(actor, "equipment.command", ticket.ProjectId, status, resource: ticket.Id + ":" + ProjectStore.Required(ticket.Definition, "id"));
            context.Items["spark.actionOutcome"] = status;
            return new { correlationId = ticket.Id, status, message, requestedValue = ticket.Value, observedValue = observed, completedAt = DateTimeOffset.UtcNow };
        }
    }
    internal static bool Matches(JsonNode? left, JsonNode? right, double tolerance)
    {
        if (left?.GetValueKind() == JsonValueKind.Number && right?.GetValueKind() == JsonValueKind.Number)
        {
            // Optimistic state checks must not collapse distinct Int64 values
            // through double precision when a device is outside authored bounds.
            if (tolerance == 0 && JsonSerializer.SerializeToElement(left).TryGetDecimal(out var exactLeft) &&
                JsonSerializer.SerializeToElement(right).TryGetDecimal(out var exactRight)) return exactLeft == exactRight;
            var av = left.Deserialize<double>(); var bv = right.Deserialize<double>();
            return double.IsFinite(av) && double.IsFinite(bv) && Math.Abs(av - bv) <= tolerance;
        }
        return JsonNode.DeepEquals(left, right);
    }
    private bool CanReadTargets(HttpContext context, JsonObject definition)
        => GatewayAccess.CanReadTag(context, security, ProjectStore.Required(definition, "tagPath")) &&
           GatewayAccess.CanReadTag(context, security, ProjectStore.Optional(definition, "readbackPath") ?? ProjectStore.Required(definition, "tagPath"));
}

public static class EquipmentCommandEndpoints
{
    public static void MapEquipmentCommandEndpoints(this RouteGroupBuilder routes)
    {
        routes.MapGet("/runtime/commands", (PublicationStore publication, string? publishedAt) =>
        {
            var project = publication.GetProject();
            if (publishedAt is not null && ProjectStore.Required(project, "publishedAt") != publishedAt) throw new InvalidOperationException("Reload the published application.");
            return project["commands"]?.DeepClone() ?? new JsonArray();
        }).Access("view", "operator");
        routes.MapPost("/runtime/commands/{id}/review", (string id, CommandReviewRequest request, HttpContext context, ProjectStore store, PublicationStore publication, EquipmentCommands commands, CancellationToken cancellation) => commands.Review(context, store, publication, id, request, cancellation)).Access("command", "operator", audit: true);
        routes.MapPost("/runtime/commands/{id}/execute", (string id, CommandExecuteRequest request, HttpContext context, ProjectStore store, PublicationStore publication, EquipmentCommands commands, CancellationToken cancellation) => commands.Execute(context, store, publication, id, request, cancellation)).Access("command", "operator", audit: true);
    }
}
