using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

/// <summary>Reconstructs a selected scalar property from the saved graph and typed source snapshots.</summary>
internal sealed class NativeTagPropertyValues
{
    private readonly JsonObject action;
    private readonly RuntimeActionRequest request;
    private readonly IReadOnlyDictionary<string, JsonElement> parameters;
    private readonly Func<string, JsonElement>? readTag;
    private readonly Func<string, Dictionary<string, JsonElement>, Task<QueryResult>> readQuery;
    private readonly Dictionary<string, JsonObject> components;
    private readonly PythonUiContext ui;
    private readonly Dictionary<(string, string), JsonElement> completed = new();
    private readonly HashSet<(string, string)> active = new();
    private readonly Dictionary<string, QueryResult> queries = new(StringComparer.Ordinal);
    private readonly Dictionary<string, JsonElement> tags = new(StringComparer.Ordinal);
    private readonly Dictionary<string, JsonElement> inputValues = new(StringComparer.Ordinal);
    private static readonly HashSet<string> Appearance = new(StringComparer.Ordinal) { "color", "backgroundColor", "foregroundColor", "borderColor", "borderWidth", "fontSize" };
    private static readonly Regex Tokens = new(@"\{([^{}]+)\}", RegexOptions.CultureInvariant);
    private int dependencies;

    internal NativeTagPropertyValues(JsonObject action, RuntimeActionRequest request, IReadOnlyDictionary<string, JsonElement> parameters,
        Func<string, JsonElement>? readTag, Func<string, Dictionary<string, JsonElement>, Task<QueryResult>> readQuery)
    {
        this.action = action; this.request = request; this.parameters = parameters; this.readTag = readTag; this.readQuery = readQuery;
        var description = action["nativeContext"]!.AsObject();
        components = description["components"]!.AsArray().OfType<JsonObject>().ToDictionary(item => ProjectStore.Required(item, "id"), StringComparer.Ordinal);
        ui = new PythonUiContext(description, request.Ui, readOnly: true);
    }

    internal async Task<JsonElement> ResolveAsync(JsonObject reference)
    {
        NativeTagActionDefinitions.ValidateReference(reference);
        var self = components[ProjectStore.Required(action["nativeContext"]!.AsObject(), "selfId")];
        NativeTagActionDefinitions.ValidateReferenceOwner(reference, self, components);
        var property = ProjectStore.Required(reference, "property");
        if (ProjectStore.Required(reference, "kind") == "parentProperty")
            return Scalar(JsonSerializer.SerializeToElement(action["nativeParent"]?[property]));
        var id = ProjectStore.Optional(reference, "componentId") ?? ProjectStore.Required(self, "id");
        var result = await Property(id, property);
        // Resolve the complete component binding projection before checking related
        // limits. A displayed property with a failed binding never falls back.
        var constants = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var target in ((components[id]["props"]?["bindings"] as JsonObject ?? []).Select(pair => pair.Key)
            .Concat((components[id]["props"]?["queryBindings"] as JsonObject ?? []).Select(pair => pair.Key))).Distinct(StringComparer.Ordinal))
        {
            var value = await Property(id, target);
            constants[target] = value.ValueKind is JsonValueKind.Array or JsonValueKind.Object ? value.GetRawText() : Native(value);
        }
        RuntimePropertyCatalog.ValidateConstants(components[id], constants);
        return Scalar(result);
    }

    private async Task<JsonElement> Property(string id, string property)
    {
        var identity = (id, property);
        if (completed.TryGetValue(identity, out var known)) return known;
        if (++dependencies > 4096 || active.Count >= 32 || !active.Add(identity)) throw new ArgumentException("Native property sources contain a cycle or exceed their dependency limits.");
        try
        {
            if (!components.TryGetValue(id, out var component)) throw new ArgumentException("Native property sources must remain in their containing form.");
            var props = component["props"]!.AsObject(); var type = ProjectStore.Required(component, "type");
            JsonElement value;
            if (property == "value" && InputDefinitionValidator.IsInput(type)) value = await Input(component);
            else
            {
                var definition = RuntimePropertyCatalog.Definition(component, property) ?? throw new ArgumentException("The native source property is unavailable.");
                if (type == "passwordInput" && property == "text") throw new ArgumentException("Native tag sources cannot read passwords.");
                if (props["bindings"]?[property] is JsonObject binding) value = await Expression(component, binding);
                else if (props["queryBindings"]?[property] is JsonObject query)
                {
                    var mappings = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
                    foreach (var (name, raw) in query["parameters"] as JsonObject ?? []) mappings[name] = await Expression(component, raw!.AsObject());
                    var rows = await Query(ProjectStore.Required(query, "queryId"), mappings); var column = ProjectStore.Required(query, "column");
                    if (!rows.Columns.Contains(column, StringComparer.Ordinal) || rows.Rows.Count != 1 || !rows.Rows[0].TryGetValue(column, out var rawValue) || rawValue is null)
                        throw new ArgumentException("A native property query source did not return its required scalar column.");
                    value = Scalar(JsonSerializer.SerializeToElement(rawValue));
                    if (query["transform"] is JsonValue transform) value = ComponentBindingValidator.EvaluateExpression(transform.GetValue<string>(), ["value"], _ => value);
                }
                else if (request.Ui?["properties"]?[id] is JsonObject overrides && overrides.ContainsKey(property)) value = JsonSerializer.SerializeToElement(ui.GetProperty(id, property));
                else
                {
                    JsonNode? saved = property is "x" or "y" or "width" or "height" ? component[property] : props;
                    if (property is not ("x" or "y" or "width" or "height"))
                        foreach (var segment in property.Split('.')) saved = saved is JsonArray array && int.TryParse(segment, out var index) && index >= 0 && index < array.Count ? array[index] : saved is JsonObject obj ? obj[segment] : null;
                    if (saved is null && Appearance.Contains(property))
                    {
                        var style = (action["nativeStyles"] as JsonArray ?? []).OfType<JsonObject>()
                            .SingleOrDefault(item => ProjectStore.Optional(item, "id") == ProjectStore.Optional(props, "styleId"));
                        saved = style?["properties"]?[property];
                        if (saved is null) throw new ArgumentException("This appearance source is supplied by a parent or browser theme. Configure a local property, assigned style or binding before using it as a tag value.");
                    }
                    value = JsonSerializer.SerializeToElement(saved ?? definition["default"]);
                    if (value.ValueKind == JsonValueKind.String && property is "text" or "tagPath" or "stateValue" or "unit" or "alt")
                        value = JsonSerializer.SerializeToElement(Tokens.Replace(value.GetString()!, match => parameters.TryGetValue(match.Groups[1].Value, out var parameter) ? TemplateParameterTypes.ScalarText(parameter) : match.Value));
                }
                var normalized = RuntimePropertyCatalog.ValidateTargetValue(component, property, Native(value));
                // The display contract represents caption/state scalars as text.
                if (ProjectStore.Required(definition, "type") == "scalar") normalized = JsonValue.Create(TemplateParameterTypes.ScalarText(value))!;
                value = JsonSerializer.SerializeToElement(normalized);
            }
            completed[identity] = value.Clone();
            return value;
        }
        finally { active.Remove(identity); }
    }

    private async Task<JsonElement> Input(JsonObject component)
    {
        var type = ProjectStore.Required(component, "type");
        if (type == "passwordInput") throw new ArgumentException("Native tag sources cannot read passwords.");
        var props = component["props"]!.AsObject(); var key = ProjectStore.Required(props, "fieldKey");
        if (inputValues.TryGetValue(key, out var known)) return known;
        if (request.Inputs is null || !request.Inputs.TryGetValue(key, out var value)) throw new ArgumentException($"The current source input '{key}' is required.");
        InputDefinitionValidator.ValidateValue(key, type, props, value);
        inputValues[key] = Scalar(value);
        // Authored input bounds remain authoritative. Dynamic display constraints
        // can narrow them and are reconstructed before accepting this source.
        var projected = component.DeepClone().AsObject();
        foreach (var target in ((props["bindings"] as JsonObject ?? []).Select(pair => pair.Key)
            .Concat((props["queryBindings"] as JsonObject ?? []).Select(pair => pair.Key))).Distinct(StringComparer.Ordinal))
            RuntimePropertyCatalog.SetValue(projected, target, JsonSerializer.SerializeToNode(await Property(ProjectStore.Required(component, "id"), target))!);
        var effective = projected["props"]!.AsObject();
        if (props["bindings"]?["options"] is not null || props["queryBindings"]?["options"] is not null) effective.Remove("optionsSource");
        InputDefinitionValidator.ValidateValue(key, type, effective, value);
        if (InputDefinitionValidator.HasQueryOptions(effective))
        {
            var source = effective["optionsSource"]!.AsObject(); var queryId = ProjectStore.Required(source, "queryId");
            var definition = action["queries"]!.AsArray().OfType<JsonObject>().First(item => ProjectStore.Optional(item, "id") == queryId);
            var mappings = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            foreach (var declared in (definition["parameters"] as JsonArray ?? []).OfType<JsonObject>())
            { var name = ProjectStore.Required(declared, "name"); if (parameters.TryGetValue(name, out var supplied)) mappings[name] = supplied; }
            InputDefinitionValidator.ValidateQuerySelection(key, type, source, await Query(queryId, mappings), value.GetString()!);
        }
        return Scalar(value);
    }

    private async Task<JsonElement> Expression(JsonObject owner, JsonObject binding)
    {
        var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var (alias, node) in binding["references"]!.AsObject())
        {
            var reference = node!.AsObject(); var kind = ProjectStore.Required(reference, "kind");
            if (kind == "custom") values[alias] = await Property(ProjectStore.Optional(reference, "componentId") ?? ProjectStore.Required(owner, "id"), "customProperties." + ProjectStore.Required(reference, "key") + ".value");
            else if (kind == "input")
            {
                var key = ProjectStore.Required(reference, "key"); var source = components.Values.SingleOrDefault(item => InputDefinitionValidator.IsInput(ProjectStore.Required(item, "type")) && ProjectStore.Optional(item["props"]!.AsObject(), "fieldKey") == key)
                    ?? throw new ArgumentException("The native input source is unavailable.");
                values[alias] = await Input(source);
            }
            else if (kind == "parameter") values[alias] = parameters.TryGetValue(ProjectStore.Required(reference, "key"), out var value) ? value : throw new ArgumentException("A native source parameter is unavailable.");
            else if (kind == "tag")
            {
                var path = TagBindingAddress.Resolve(ProjectStore.Required(reference, "path"), parameters);
                if (!tags.TryGetValue(path, out var value)) tags[path] = value = readTag?.Invoke(path) ?? throw new ArgumentException("A native source tag is unavailable.");
                values[alias] = value;
            }
            else
            {
                var scope = kind switch { "sessionState" => "session", "screenState" => "screen", "instanceState" => "instance", _ => throw new ArgumentException("Unsupported native source reference.") };
                var key = ProjectStore.Required(reference, "key");
                if (request.Ui?["state"]?[scope] is not JsonObject state || !state.ContainsKey(key)) throw new ArgumentException("Current declared state is required for a bound native value source.");
                values[alias] = JsonSerializer.SerializeToElement(ui.GetState(scope, key));
            }
            Scalar(values[alias]); // Validate every branch before the expression runs.
        }
        return ComponentBindingValidator.EvaluateExpression(ProjectStore.Required(binding, "expression"), values.Keys, alias => values[alias]);
    }

    private async Task<QueryResult> Query(string id, Dictionary<string, JsonElement> mappings)
    {
        var key = id + ":" + JsonSerializer.Serialize(mappings.OrderBy(pair => pair.Key, StringComparer.Ordinal));
        if (queries.TryGetValue(key, out var result)) return result;
        if (queries.Count >= 128) throw new ArgumentException("Native property sources support at most 128 query dependencies.");
        result = await readQuery(id, mappings); queries[key] = result; return result;
    }
    private static JsonElement Scalar(JsonElement value) => ComponentBindingValidator.EvaluateExpression("value", ["value"], _ => value);
    private static object Native(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString()!, JsonValueKind.Number when value.TryGetDouble(out var number) => number,
        JsonValueKind.True => true, JsonValueKind.False => false, _ => throw new ArgumentException("The native property source must be a bounded scalar.")
    };
}
