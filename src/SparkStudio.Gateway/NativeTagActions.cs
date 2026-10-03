using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>A native button writes one saved scalar to one saved, concrete tag.</summary>
public static class NativeTagActionDefinitions
{
    public static JsonObject Validate(JsonNode? node)
    {
        if (node is not JsonObject value || value.Any(pair => pair.Key is not ("tagPath" or "dataType" or "value" or "valueReference" or "confirmation")) || value.ContainsKey("value") == value.ContainsKey("valueReference"))
            throw new ArgumentException("Set tag value requires a tagPath, dataType and exactly one scalar value or component property reference, with optional confirmation text.");
        TagDefinitionValidator.Path(ProjectStore.Required(value, "tagPath"));
        var type = TagDefinitionValidator.DataType(value);
        if (value.ContainsKey("value"))
        {
            var typed = TagDefinitionValidator.MemoryValue(type, value["value"]);
            if (type == "String" && typed.GetValue<string>().Length > 1024)
                throw new ArgumentException("Set tag value text is limited to 1,024 characters.");
            if (type is not ("String" or "Boolean"))
            {
                var number = typed.Deserialize<double>();
                if (Math.Abs(number) > 9007199254740991d && number == Math.Truncate(number))
                    throw new ArgumentException("Set tag value numbers must preserve browser integer precision.");
            }
        }
        else ValidateReference(value["valueReference"]);
        if (value.ContainsKey("confirmation") && (value["confirmation"] is not JsonValue text || !text.TryGetValue<string>(out var confirmation) || string.IsNullOrWhiteSpace(confirmation) || confirmation.Length > 512))
            throw new ArgumentException("Confirmation must be nonempty text of at most 512 characters.");
        return value;
    }

    internal static JsonObject ValidateReference(JsonNode? node)
    {
        if (node is not JsonObject reference || reference.Any(pair => pair.Key is not ("kind" or "componentId" or "property")))
            throw new ArgumentException("A tag value reference needs a supported property and optional component ID.");
        var kind = ProjectStore.Required(reference, "kind"); var property = ProjectStore.Required(reference, "property");
        if (property.Length > 256) throw new ArgumentException("A component property path is limited to 256 characters.");
        if (kind == "parentProperty")
        {
            if (reference.ContainsKey("componentId") || property is not ("name" or "width" or "height"))
                throw new ArgumentException("Parent references support authored name, width and height only.");
        }
        else if (kind != "property" || reference.ContainsKey("componentId") && (ProjectStore.Required(reference, "componentId").Length > 256 || ProjectStore.Required(reference, "componentId") is "__proto__" or "constructor" or "prototype"))
            throw new ArgumentException("Choose a property in this component's containing form.");
        return reference;
    }

    internal static string ValidateReferenceOwner(JsonObject reference, JsonObject owner, IReadOnlyDictionary<string, JsonObject> components)
    {
        if (ProjectStore.Required(reference, "kind") == "parentProperty") return ProjectStore.Required(reference, "property") == "name" ? "string" : "number";
        var id = ProjectStore.Optional(reference, "componentId") ?? ProjectStore.Required(owner, "id");
        if (!components.TryGetValue(id, out var source)) throw new ArgumentException("Tag value property references must remain in the same screen or template instance.");
        var property = ProjectStore.Required(reference, "property"); var type = ProjectStore.Required(source, "type");
        if (type == "passwordInput" && property is "text" or "value") throw new ArgumentException("Tag value sources cannot read password text or values.");
        if (property == "value" && InputDefinitionValidator.IsInput(type)) return type is "numberInput" or "spinner" or "slider" ? "number" : type is "checkbox" or "toggle" ? "boolean" : "string";
        var definition = RuntimePropertyCatalog.Definition(source, property);
        if (definition is null || ProjectStore.Required(definition, "type") == "json") throw new ArgumentException("Tag value sources require a supported scalar runtime property.");
        return ProjectStore.Required(definition, "type");
    }

    public static void ValidateProject(JsonObject project)
    {
        foreach (var document in ProjectTemplates.Documents(project))
        {
            var components = document["components"]!.AsArray().OfType<JsonObject>().ToDictionary(item => ProjectStore.Required(item, "id"), StringComparer.Ordinal);
            foreach (var component in components.Values)
            {
                if (component["props"] is not JsonObject props) continue;
                if (ProjectStore.Optional(props, "action") != "setTagValue") continue;
                if (ProjectStore.Optional(component, "type") != "button") throw new ArgumentException("Only buttons support Set tag value actions.");
                var native = Validate(props["tagWrite"]);
                if (native["valueReference"] is JsonObject reference)
                {
                    var sourceType = ValidateReferenceOwner(reference, component, components);
                    var targetType = TagDefinitionValidator.DataType(native);
                    if (sourceType == "boolean" ? targetType != "Boolean" : sourceType is "number" or "integer" ? targetType is "String" or "Boolean" : targetType != "String")
                        throw new ArgumentException("The selected property type must match the tag data type; no text-to-number or Boolean conversion is applied.");
                }
                _ = Command(props, project["commands"] as JsonArray);
            }
        }
    }

    internal static JsonObject Command(JsonObject props, JsonArray? commands, JsonElement? resolvedValue = null)
    {
        var action = Validate(props["tagWrite"]);
        var path = ProjectStore.Required(action, "tagPath");
        var declared = (commands ?? []).OfType<JsonObject>().Where(item => ProjectStore.Optional(item, "tagPath") == path).ToArray();
        if (declared.Length > 1) throw new ArgumentException("Multiple equipment commands target this tag. Use a declared command control instead of Set tag value.");
        JsonObject result;
        if (declared.Length == 1)
        {
            if (TagDefinitionValidator.DataType(declared[0]) != TagDefinitionValidator.DataType(action))
                throw new ArgumentException("Set tag value must match the equipment command's declared data type.");
            result = declared[0].DeepClone().AsObject();
        }
        else
        {
            var type = TagDefinitionValidator.DataType(action);
            result = new JsonObject { ["id"] = "native-tag", ["name"] = "Set " + path,
                ["tagPath"] = path, ["dataType"] = type,
                ["confirmation"] = ProjectStore.Optional(action, "confirmation") ?? "" };
            if (type == "String") result["maxLength"] = 1024;
            else if (type != "Boolean") { result["min"] = -9007199254740991d; result["max"] = 9007199254740991d; }
        }
        // Existing command bounds, confirmation and readback always win. This
        // validates a native declaration against them at save and at dispatch.
        if (resolvedValue is { } supplied) result["value"] = EquipmentCommandDefinitions.Value(result, supplied);
        else if (action.ContainsKey("value")) result["value"] = EquipmentCommandDefinitions.Value(result, JsonSerializer.SerializeToElement(action["value"]));
        return result;
    }
}

[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1001:Types that own disposable fields should be disposable",
    Justification = "ProjectRuntimeRegistry owns these shared actions. Request-scoped DI factories return them, so IDisposable would close the shared semaphore after each request. The registry calls CloseComponentEvents, which retires admission and disposes after active leases finish.")]
public sealed partial class RuntimeActions
{
    internal void CloseComponentEvents()
    {
        lock (componentEventGate) {
            if (componentEventsClosed) return;
            componentEventsClosed = true;
            if (componentEventUsers == 0) componentEventSlots.Dispose();
        }
    }

    public async Task<JsonObject> CaptureTagActionAsync(string screenId, string componentId, RuntimeActionRequest request, CancellationToken cancellation)
    {
        if (JsonSerializer.SerializeToUtf8Bytes(request, ProjectStore.Json).Length > 262144) throw new ArgumentException("Native tag action source snapshots are limited to 256 KiB of JSON.");
        if (string.IsNullOrWhiteSpace(request.PublishedAt)) throw new ArgumentException("Load the published application before setting a tag.");
        var action = publications.GetTagAction(screenId, componentId, request.PublishedAt, request.InstanceId, request.RowId, request.PopupOrigin, request.InstancePath);
        RejectUnknownKeys(request.Inputs, action["inputs"]!.AsArray().OfType<JsonObject>().Select(definition => ProjectStore.Required(definition, "fieldKey")), "input field");
        foreach (var definition in action["inputs"]!.AsArray().OfType<JsonObject>())
        {
            var key = ProjectStore.Required(definition, "fieldKey");
            if (request.Inputs?.TryGetValue(key, out var supplied) != true) continue;
            var type = ProjectStore.Required(definition, "type");
            if (type == "passwordInput") throw new ArgumentException("Native tag action snapshots cannot contain passwords.");
            // Other fields may still be in an editing state. Bound their buffers
            // here; only consumed sources must satisfy their complete typed input
            // contract. A fixed write does not submit an unrelated form.
            if (supplied.ValueKind is JsonValueKind.Array or JsonValueKind.Object or JsonValueKind.Undefined ||
                supplied.ValueKind == JsonValueKind.String && supplied.GetString()!.Length > 4096 ||
                supplied.ValueKind == JsonValueKind.Number && (!supplied.TryGetDouble(out var number) || !double.IsFinite(number) || number == Math.Truncate(number) && Math.Abs(number) > 9007199254740991d))
                throw new ArgumentException("Native input source snapshots require bounded scalar editing values.");
        }
        if (request.Ui is not null) _ = new PythonUiContext(action["nativeContext"]!.AsObject(), request.Ui, readOnly: true);
        // Even a constant write must prove the published popup/template/repeater
        // identity. Query row membership and typed parameter bindings are rebuilt.
        var parameters = await ResolveContextAsync(action, request.Parameters, request.BindingInputs, request.PopupOrigin?.BindingInputs,
            request.BindingState, request.PopupOrigin?.BindingState, cancellation);
        JsonElement? value = null;
        if (action["tagWrite"]?["valueReference"] is JsonObject reference)
        {
            var evaluator = new NativeTagPropertyValues(action, request, parameters, readBindingTag, async (queryId, mappings) =>
            {
                var definition = action["queries"]!.AsArray().OfType<JsonObject>().FirstOrDefault(item => ProjectStore.Optional(item, "id") == queryId)
                    ?? throw new ArgumentException("A native value source query is missing from this publication.");
                if (ProjectStore.Optional(definition, "kind") == "update") throw new ArgumentException("Native value sources require read queries.");
                foreach (var (name, supplied) in mappings)
                {
                    var declaration = (definition["parameters"] as JsonArray ?? []).OfType<JsonObject>().FirstOrDefault(item => ProjectStore.Optional(item, "name") == name)
                        ?? throw new ArgumentException("A native value source supplied an undeclared query parameter.");
                    ComponentQueryBindingValidator.ValidateMappedValue(ProjectStore.Required(declaration, "type"), supplied);
                }
                return await queries.ExecuteDefinitionAsync(definition, mappings, cancellation);
            });
            value = await evaluator.ResolveAsync(reference);
        }
        return NativeTagActionDefinitions.Command(new JsonObject { ["tagWrite"] = action["tagWrite"]!.DeepClone() }, action["commands"] as JsonArray, value);
    }
}

public static class NativeTagActionEndpoints
{
    public static void MapNativeTagActionEndpoints(this RouteGroupBuilder routes)
    {
        routes.MapPost("/runtime/screens/{screenId}/components/{componentId}/tag-action/review", async (string screenId, string componentId,
            RuntimeActionRequest request, RuntimeActions actions, HttpContext context, ProjectStore store, EquipmentCommands commands, CancellationToken cancellation) =>
        {
            // The one-use ticket owns a detached scope request, never the mutable
            // model binding maps or UI objects belonging to a completed request.
            var captured = JsonSerializer.SerializeToElement(request, ProjectStore.Json).Deserialize<RuntimeActionRequest>(ProjectStore.Json)!;
            return await commands.ReviewNative(context, store, Resource(screenId, componentId), captured.PublishedAt ?? "",
                token => actions.CaptureTagActionAsync(screenId, componentId, captured, token), cancellation, GatewaySecurity.CaptureSessionValidator(context));
        }).Access("command", "operator", audit: true);
        routes.MapPost("/runtime/screens/{screenId}/components/{componentId}/tag-action/execute", async (string screenId, string componentId,
            CommandExecuteRequest request, HttpContext context, ProjectStore store, PublicationStore publication, EquipmentCommands commands, CancellationToken cancellation) =>
            await commands.ExecuteNative(context, store, publication, Resource(screenId, componentId), request, cancellation)).Access("command", "operator", audit: true);
    }
    internal static string Resource(string screenId, string componentId) => "tag-action:" + JsonSerializer.Serialize(new[] { screenId, componentId });
}
