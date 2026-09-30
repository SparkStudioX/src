using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>One invocation's validated, browser-local UI snapshot and staged effects.</summary>
public sealed class PythonUiContext
{
    private static readonly HashSet<string> Properties = new(StringComparer.Ordinal)
        { "text", "enabled", "visible", "color", "backgroundColor", "foregroundColor", "borderColor", "borderWidth", "fontSize" };
    private static readonly Regex HexColor = new(@"\A#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\z", RegexOptions.CultureInvariant);
    private readonly JsonObject description;
    private readonly Dictionary<string, JsonObject> components;
    private readonly JsonObject definitions;
    private readonly JsonObject state = new();
    private readonly JsonObject overrides = new();
    private readonly JsonObject inputValues = new();
    private JsonArray effects = new();
    private readonly bool readOnly;

    public PythonUiContext(JsonObject description, JsonObject? snapshot = null, bool readOnly = false)
    {
        this.readOnly = readOnly;
        this.description = description.DeepClone().AsObject();
        definitions = this.description["state"]!.AsObject();
        components = this.description["components"]!.AsArray().OfType<JsonObject>()
            .ToDictionary(component => ProjectStore.Required(component, "id"), StringComparer.Ordinal);
        RequireComponent(ProjectStore.Required(description, "selfId"));
        if (snapshot is not null)
        {
            Exact(snapshot, "UI snapshot", "state", "properties");
            if (Utf8Size(snapshot) > 262_144) throw new ArgumentException("UI snapshots are limited to 256 KiB of UTF-8 JSON.");
            if (snapshot["state"] is not JsonObject submitted || snapshot["properties"] is not JsonObject)
                throw new ArgumentException("UI snapshot state and properties must be objects.");
            if (!submitted.ContainsKey("session") || !submitted.ContainsKey("screen") || submitted.Any(pair => !definitions.ContainsKey(pair.Key)))
                throw new ArgumentException("UI snapshot needs session and screen state, with instance state only inside a template.");
            foreach (var (scope, values) in submitted)
            {
                if (values is not JsonObject supplied) throw new ArgumentException("UI state scopes must be objects.");
                foreach (var (key, value) in supplied) ValidateState(scope, key, value);
            }
        }
        foreach (var (scope, entries) in definitions)
        {
            var values = new JsonObject();
            foreach (var (key, definition) in entries!.AsObject())
                values[key] = snapshot?["state"]?[scope] is JsonObject supplied && supplied.ContainsKey(key)
                    ? supplied[key]!.DeepClone() : definition!["value"]!.DeepClone();
            state[scope] = values;
        }
        if (snapshot?["properties"] is JsonObject properties)
            foreach (var (id, entries) in properties)
            {
                RequireComponent(id);
                if (entries is not JsonObject supplied) throw new ArgumentException("UI property overrides must be objects keyed by component ID.");
                foreach (var (property, value) in supplied) { RequireProperty(id, property); ValidateProperty(property, value); }
                overrides[id] = supplied.DeepClone();
            }
    }

    // Only server-resolved project resources create this description. It is never
    // accepted in a runtime request or exposed as browser execution authority.
    public static JsonObject Describe(JsonObject project, JsonObject screen, JsonObject document, string componentId, bool instance)
    {
        var state = new JsonObject
        {
            ["session"] = project["sessionState"]?.DeepClone() ?? new JsonObject(),
            ["screen"] = screen["state"]?.DeepClone() ?? new JsonObject()
        };
        if (instance) state["instance"] = document["instanceState"]?.DeepClone() ?? new JsonObject();
        return new JsonObject { ["selfId"] = componentId, ["documentId"] = document["id"]!.DeepClone(),
            ["documentName"] = document["name"]?.DeepClone() ?? document["id"]!.DeepClone(),
            ["customScope"] = instance ? "instance" : "screen", ["state"] = state, ["components"] = document["components"]!.DeepClone() };
    }

    public static PythonUiContext? ForPreview(ProjectStore store, JsonObject? identity, JsonObject? snapshot)
    {
        if (identity is null)
        {
            if (snapshot is not null) throw new ArgumentException("UI Preview requires its saved screen and component context. Save the project before testing UI scripts.");
            return null;
        }
        if (identity.Any(pair => pair.Key is not ("screenId" or "templateId" or "componentId" or "instanceId" or "rowId" or "instancePath")) || identity.ContainsKey("screenId") == identity.ContainsKey("templateId"))
            throw new ArgumentException("UI Preview context needs exactly one screenId or templateId, componentId and an optional instance path.");
        var standalone = identity.ContainsKey("templateId");
        var documentId = ProjectStore.Required(identity, standalone ? "templateId" : "screenId");
        var componentId = ProjectStore.Required(identity, "componentId");
        var project = store.GetProject();
        try
        {
            var screen = (standalone ? project["templates"] as JsonArray ?? new JsonArray() : project["screens"]!.AsArray()).OfType<JsonObject>()
                .FirstOrDefault(item => ProjectStore.Optional(item, "id") == documentId) ?? throw new KeyNotFoundException("Saved screen or template not found.");
            var path = identity["instancePath"]?.Deserialize<InstancePathStep[]>(ProjectStore.Json);
            var resolved = ProjectInteractions.ResolveLeaf(project, screen, componentId, ProjectStore.Optional(identity, "instanceId"), ProjectStore.Optional(identity, "rowId"), path);
            if (ProjectStore.Optional(resolved.Component, "type") != "button" || resolved.Component["props"] is not JsonObject props || ProjectStore.Optional(props, "action") != "script")
                throw new ArgumentException("UI Preview context must identify a saved Python button. Save the project before testing UI scripts.");
            return new PythonUiContext(Describe(project, screen, resolved.Scope, componentId, standalone || resolved.TemplateScopes.Count > 0), snapshot);
        }
        catch (Exception error) when (error is KeyNotFoundException or JsonException)
        { throw new ArgumentException("Save the project before UI Preview so its screen, button and instance path can be resolved.", error); }
    }

    public JsonObject WorkerContext() => new()
    {
        ["selfId"] = description["selfId"]!.DeepClone(), ["parentId"] = description["documentId"]!.DeepClone(),
        ["parentName"] = description["documentName"]!.DeepClone(), ["customScope"] = description["customScope"]!.DeepClone(),
        ["componentIds"] = new JsonArray(components.Values.Select(component => component["id"]!.DeepClone()).ToArray())
    };

    public void CaptureInputs(Dictionary<string, JsonElement>? inputs)
    {
        inputValues.Clear();
        foreach (var component in components.Values.Where(item => InputDefinitionValidator.IsInput(ProjectStore.Required(item, "type")) && ProjectStore.Optional(item, "type") != "passwordInput"))
        {
            var props = component["props"]!.AsObject(); var key = ProjectStore.Required(props, "fieldKey");
            var value = inputs is not null && inputs.TryGetValue(key, out var supplied) ? supplied : JsonSerializer.SerializeToElement(props["defaultValue"]);
            if (value.ValueKind is not (JsonValueKind.Null or JsonValueKind.True or JsonValueKind.False) &&
                !(value.ValueKind == JsonValueKind.String && value.GetString()!.Length <= 4096) &&
                !(value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && double.IsFinite(number) && (Math.Truncate(number) != number || Math.Abs(number) <= 9007199254740991d)))
                throw new ArgumentException("UI input snapshots require bounded scalar values.");
            inputValues[ProjectStore.Required(component, "id")] = JsonSerializer.SerializeToNode(value);
        }
    }

    public JsonNode? Dispatch(string method, JsonObject arguments)
    {
        switch (method)
        {
            case "ui.getState":
                Exact(arguments, "getState arguments", "scope", "key");
                return GetState(Text(arguments, "scope"), Text(arguments, "key"));
            case "ui.setState":
                Exact(arguments, "setState arguments", "scope", "key", "value");
                SetState(Text(arguments, "scope"), Text(arguments, "key"), arguments["value"]); return null;
            case "ui.getProperty":
                Exact(arguments, "getProperty arguments", "componentId", "property");
                return GetProperty(Text(arguments, "componentId"), Text(arguments, "property"));
            case "ui.setProperty":
                Exact(arguments, "setProperty arguments", "componentId", "property", "value");
                SetProperty(Text(arguments, "componentId"), Text(arguments, "property"), arguments["value"]); return null;
            default: throw new ArgumentException("Unknown UI scripting function.");
        }
    }

    public JsonNode GetState(string scope, string key)
    {
        StateDefinition(scope, key);
        return state[scope]![key]!.DeepClone();
    }
    public void SetState(string scope, string key, JsonNode? value)
    {
        RequireWritable();
        ValidateState(scope, key, value);
        Stage(new JsonObject { ["kind"] = "state", ["scope"] = scope, ["key"] = key, ["value"] = value!.DeepClone() });
        state[scope]![key] = value!.DeepClone();
    }
    public JsonNode? GetProperty(string componentId, string property)
    {
        if (property == "value")
        {
            RequireInput(componentId, writing: false);
            return inputValues.TryGetPropertyValue(componentId, out var input) ? input?.DeepClone() : throw new ArgumentException("This execution has no captured input value.");
        }
        var component = RequireProperty(componentId, property);
        if (overrides[componentId] is JsonObject local && local.ContainsKey(property)) return local[property]!.DeepClone();
        var value = component["props"]?[property];
        if (value is not null) { ValidateProperty(property, value); return value.DeepClone(); }
        return property switch { "text" => JsonValue.Create(""), "enabled" or "visible" => JsonValue.Create(true), _ => null };
    }
    public void SetProperty(string componentId, string property, JsonNode? value)
    {
        RequireWritable();
        if (property == "value")
        {
            var component = RequireInput(componentId, writing: true);
            var props = component["props"]!.AsObject();
            InputDefinitionValidator.ValidateValue(ProjectStore.Required(props, "fieldKey"), ProjectStore.Required(component, "type"), props, JsonSerializer.SerializeToElement(value));
            Stage(new JsonObject { ["kind"] = "input", ["componentId"] = componentId, ["value"] = value!.DeepClone() });
            inputValues[componentId] = value.DeepClone();
            return;
        }
        RequireProperty(componentId, property); ValidateProperty(property, value);
        Stage(new JsonObject { ["kind"] = "property", ["componentId"] = componentId, ["property"] = property, ["value"] = value!.DeepClone() });
        if (overrides[componentId] is not JsonObject) overrides[componentId] = new JsonObject();
        overrides[componentId]![property] = value!.DeepClone();
    }

    public static JsonObject CompleteResponse(JsonObject response, PythonUiContext? context)
    {
        // Worker-authored result fields never define UI capabilities or effects.
        response.Remove("uiEffects");
        if (context is not null && response["success"] is JsonValue value && value.TryGetValue<bool>(out var success) && success)
            response["uiEffects"] = context.effects.DeepClone();
        if (context is not null) context.effects = new JsonArray();
        return response;
    }

    private void Stage(JsonObject effect)
    {
        var next = effects.DeepClone().AsArray();
        var index = next.Select((item, position) => (item: item!.AsObject(), position)).FirstOrDefault(entry =>
            entry.item["kind"]!.GetValue<string>() == effect["kind"]!.GetValue<string>() && (effect["kind"]!.GetValue<string>() == "state"
                ? entry.item["scope"]!.GetValue<string>() == effect["scope"]!.GetValue<string>() && entry.item["key"]!.GetValue<string>() == effect["key"]!.GetValue<string>()
                : entry.item["componentId"]!.GetValue<string>() == effect["componentId"]!.GetValue<string>() &&
                    (effect["kind"]!.GetValue<string>() == "input" || entry.item["property"]!.GetValue<string>() == effect["property"]!.GetValue<string>())));
        if (index.item is not null) next[index.position] = effect; else next.Add(effect);
        if (next.Count > 128 || Utf8Size(next) > 65_536) throw new ArgumentException("UI effects are limited to 128 changed targets and 64 KiB of UTF-8 JSON.");
        effects = next;
    }
    private void RequireWritable()
    {
        if (readOnly) throw new ArgumentException("Unmount UI state is read-only. The component has retired; local presentation changes are unavailable during cleanup.");
    }
    private JsonObject StateDefinition(string scope, string key) => definitions[scope] is JsonObject entries && entries[key] is JsonObject definition
        ? definition : throw new ArgumentException($"UI {scope} state '{key}' is not declared in this context.");
    private void ValidateState(string scope, string key, JsonNode? value) => ProjectStateValidator.ValidateSuppliedValue(
        StateDefinition(scope, key)["type"]!.GetValue<string>(), JsonSerializer.SerializeToElement(value));
    private JsonObject RequireComponent(string id) => components.TryGetValue(id, out var component)
        ? component : throw new ArgumentException($"UI component ID '{id}' is unavailable in this form; navigation cannot cross form boundaries.");
    private JsonObject RequireInput(string id, bool writing)
    {
        var component = RequireComponent(id); var type = ProjectStore.Required(component, "type");
        if (type == "passwordInput" || !InputDefinitionValidator.IsInput(type)) throw new ArgumentException("UI value access requires a non-password input in this form.");
        var props = component["props"]!.AsObject();
        if (writing && (props.ContainsKey("stateBinding") || !string.IsNullOrEmpty(ProjectStore.Optional(props, "tagPath")) || props.ContainsKey("optionsSource") || props.ContainsKey("selectionFields") ||
            props["readOnly"] is JsonValue flag && flag.TryGetValue<bool>(out var readOnly) && readOnly ||
            props["bindings"] is JsonObject bindings && bindings.ContainsKey("value") || props["queryBindings"] is JsonObject queries && queries.ContainsKey("value")))
            throw new ArgumentException("This input value is read-only or has a tag, state, query or selection binding. Update its source instead.");
        return component;
    }
    private JsonObject RequireProperty(string id, string property)
    {
        var component = RequireComponent(id);
        if (ProjectStore.Optional(component, "type") == "passwordInput" && property is "text" or "value")
            throw new ArgumentException("Password text and value are unavailable to UI scripting. Only presentation flags and appearance properties can be accessed.");
        if (!Properties.Contains(property)) throw new ArgumentException($"UI property '{property}' is not supported.");
        var props = component["props"]!.AsObject();
        if (props["bindings"] is JsonObject expressions && expressions.ContainsKey(property) || props["queryBindings"] is JsonObject queries && queries.ContainsKey(property))
            throw new ArgumentException($"UI property '{id}.{property}' has a binding. Read or change its source state, tag or query instead.");
        return component;
    }
    private static void ValidateProperty(string property, JsonNode? value)
    {
        var element = JsonSerializer.SerializeToElement(value);
        var valid = property switch
        {
            "text" => element.ValueKind == JsonValueKind.String && element.GetString()!.Length <= 4096,
            "enabled" or "visible" => element.ValueKind is JsonValueKind.True or JsonValueKind.False,
            "color" or "backgroundColor" or "foregroundColor" or "borderColor" => element.ValueKind == JsonValueKind.String && HexColor.IsMatch(element.GetString()!),
            "borderWidth" or "fontSize" => element.ValueKind == JsonValueKind.Number && element.TryGetDouble(out var number) && double.IsFinite(number) &&
                (property == "borderWidth" ? number is >= 0 and <= 32 : number is >= 1 and <= 256),
            _ => false
        };
        if (!valid) throw new ArgumentException($"UI property '{property}' needs a supported bounded scalar value.");
    }
    private static string Text(JsonObject value, string key) => value[key] is JsonValue scalar && scalar.TryGetValue<string>(out var text) ? text : throw new ArgumentException($"UI {key} must be text.");
    private static void Exact(JsonObject value, string description, params string[] keys)
    {
        if (value.Count != keys.Length || value.Any(pair => !keys.Contains(pair.Key, StringComparer.Ordinal))) throw new ArgumentException(description + " contains missing or unknown fields.");
    }
    private static long Utf8Size(JsonNode? value)
    {
        if (value is null) return 4;
        if (value is JsonObject obj) return 2 + Math.Max(0, obj.Count - 1) + obj.Sum(pair => ComponentEventValidator.JsonStringBytes(pair.Key) + 1 + Utf8Size(pair.Value));
        if (value is JsonArray array) return 2 + Math.Max(0, array.Count - 1) + array.Sum(Utf8Size);
        var scalar = JsonSerializer.SerializeToElement(value);
        return scalar.ValueKind switch
        {
            JsonValueKind.String => ComponentEventValidator.JsonStringBytes(scalar.GetString()!),
            JsonValueKind.True => 4, JsonValueKind.False => 5,
            JsonValueKind.Number when scalar.TryGetDouble(out var number) && double.IsFinite(number) => ComponentEventValidator.JsonNumberBytes(number),
            _ => throw new ArgumentException("UI snapshots accept only JSON scalar values and object maps.")
        };
    }
}
