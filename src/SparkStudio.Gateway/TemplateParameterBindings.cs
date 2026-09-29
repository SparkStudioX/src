using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Sparse browser-provided source values; never a gateway state store or authority claim.</summary>
public sealed class ParameterBindingState : Dictionary<string, Dictionary<string, JsonElement>>
{
    public ParameterBindingState() : base(StringComparer.Ordinal) { }
}

/// <summary>Instance parameter expressions read the caller, never another child parameter.</summary>
internal static class TemplateParameterBindings
{
    public static void ValidateProject(JsonObject project)
    {
        RejectMisplaced(project);
        var templates = ProjectTemplates.Templates(project).ToDictionary(item => ProjectStore.Required(item, "id"), StringComparer.Ordinal);
        foreach (var document in ProjectTemplates.Documents(project))
        {
            RejectMisplaced(document);
            var templateDocument = templates.Values.Contains(document);
            var components = document["components"]!.AsArray().OfType<JsonObject>()
                .ToDictionary(item => ProjectStore.Required(item, "id"), StringComparer.Ordinal);
            var parameters = (project["parameters"] as JsonObject ?? []).Select(pair => pair.Key)
                .Concat((document["parameters"] as JsonObject ?? []).Select(pair => pair.Key)).ToHashSet(StringComparer.Ordinal);
            foreach (var component in components.Values)
            {
                RejectMisplaced(component);
                if (component["props"] is not JsonObject props) continue;
                if (props["rows"] is JsonArray rows)
                    foreach (var row in rows.OfType<JsonObject>()) RejectMisplaced(row);
                if (!props.ContainsKey("parameterBindings")) continue;
                if (ProjectStore.Optional(component, "type") is not ("template" or "repeater"))
                    throw new ArgumentException("Parameter bindings belong only to template instances and repeaters.");
                if (!templates.TryGetValue(ProjectStore.Optional(props, "templateId") ?? "", out var template))
                    throw new ArgumentException("Parameter bindings need an existing template.");
                if (props["parameterBindings"] is not JsonObject bindings || bindings.Count > 64)
                    throw new ArgumentException("Parameter bindings must be an object with at most 64 declared template parameters.");
                foreach (var (key, node) in bindings)
                {
                    if (template["parameters"] is not JsonObject declared || !declared.ContainsKey(key))
                        throw new ArgumentException("Parameter bindings may name only parameters declared by the referenced template.");
                    if (node is not JsonObject binding || binding.Count != 2 || binding.Any(pair => pair.Key is not ("expression" or "references")) ||
                        binding["expression"] is not JsonValue expressionValue || !expressionValue.TryGetValue<string>(out var expression) ||
                        binding["references"] is not JsonObject references || references.Count > 32)
                        throw new ArgumentException("A parameter binding needs an expression and a map of at most 32 references.");
                    foreach (var (alias, referenceNode) in references)
                    {
                        if (!Alias(alias) || referenceNode is not JsonObject reference)
                            throw new ArgumentException("Parameter binding references need valid identifier aliases and definitions.");
                        var kind = ProjectStore.Required(reference, "kind");
                        var allowed = kind == "custom" ? new[] { "kind", "key", "componentId" } : ["kind", "key"];
                        if (reference.Any(pair => !allowed.Contains(pair.Key, StringComparer.Ordinal)))
                            throw new ArgumentException("A parameter binding reference has unsupported fields.");
                        var source = ProjectStore.Required(reference, "key");
                        if (source.Length > 256 || source is "__proto__" or "constructor" or "prototype")
                            throw new ArgumentException("A parameter binding source key is invalid.");
                        switch (kind)
                        {
                            case "parameter":
                                if (!parameters.Contains(source)) throw new ArgumentException("Parameter bindings may read only declared parameters in their parent screen or template.");
                                break;
                            case "custom":
                                var owner = component;
                                if (reference.ContainsKey("componentId"))
                                {
                                    var id = ProjectStore.Required(reference, "componentId");
                                    if (id.Length > 256 || id is "__proto__" or "constructor" or "prototype" || !components.TryGetValue(id, out owner))
                                        throw new ArgumentException("Custom property sources must stay within the parent screen or template.");
                                }
                                if (!Alias(source) || owner["props"]?["customProperties"] is not JsonObject customs || !customs.ContainsKey(source))
                                    throw new ArgumentException("The referenced parent custom property does not exist.");
                                break;
                            case "input":
                                if (!components.Values.Any(item => ProjectStore.Optional(item, "type") != "passwordInput" &&
                                    InputDefinitionValidator.IsInput(ProjectStore.Required(item, "type")) && ProjectStore.Optional(item["props"]!.AsObject(), "fieldKey") == source))
                                    throw new ArgumentException("Parameter bindings may read only non-password inputs in the parent screen or template.");
                                break;
                            case "sessionState":
                            case "screenState":
                            case "instanceState":
                                ProjectStateValidator.ValidateReference(kind, source, project["sessionState"] as JsonObject, document, templateDocument);
                                break;
                            default: throw new ArgumentException("Parameter bindings support parent parameters, custom properties, non-password inputs and declared browser state.");
                        }
                    }
                    var (constant, _) = ComponentBindingValidator.ValidateExpression(expression, references.Select(pair => pair.Key));
                    if (constant)
                    {
                        var value = ComponentBindingValidator.EvaluateExpression(expression, [], _ => throw new ArgumentException("A constant cannot read a reference."));
                        TemplateParameterTypes.Coerce(key, value, template["parameterTypes"] as JsonObject);
                    }
                }
            }
        }
    }

    private static bool Alias(string value) => ProjectStateValidator.ValidKey(value) && value is not ("true" or "false" or "null");
    private static void RejectMisplaced(JsonObject owner)
    {
        if (owner.ContainsKey("parameterBindings")) throw new ArgumentException("Parameter bindings belong to a template instance's properties only.");
    }

    /// <summary>Capture only authored source definitions used by this instance, from the same publication.</summary>
    public static void Capture(JsonObject result, JsonObject project, JsonObject screen, JsonObject parent, JsonObject instance)
    {
        var bindings = instance["props"]?["parameterBindings"] as JsonObject ?? [];
        result["parameterBindings"] = bindings.DeepClone();
        var components = parent["components"]!.AsArray().OfType<JsonObject>().ToArray();
        var inputKeys = bindings.SelectMany(pair => pair.Value!["references"]!.AsObject())
            .Where(pair => ProjectStore.Optional(pair.Value!.AsObject(), "kind") == "input")
            .Select(pair => ProjectStore.Required(pair.Value!.AsObject(), "key")).ToHashSet(StringComparer.Ordinal);
        result["bindingInputDefinitions"] = new JsonArray(components.Where(item => InputDefinitionValidator.IsInput(ProjectStore.Required(item, "type")) &&
            inputKeys.Contains(ProjectStore.Required(item["props"]!.AsObject(), "fieldKey"))).Select(item =>
            {
                var definition = new JsonObject { ["type"] = item["type"]!.DeepClone() };
                foreach (var key in new[] { "fieldKey", "min", "max", "step", "options", "optionsSource" })
                    if (item["props"]![key] is { } value) definition[key] = value.DeepClone();
                return (JsonNode)definition;
            }).ToArray());
        var customValues = new JsonObject();
        foreach (var (parameter, node) in bindings)
        {
            var values = new JsonObject();
            foreach (var (alias, referenceNode) in node!["references"]!.AsObject())
            {
                var reference = referenceNode!.AsObject();
                if (ProjectStore.Optional(reference, "kind") != "custom") continue;
                var owner = reference.ContainsKey("componentId")
                    ? components.First(item => ProjectStore.Required(item, "id") == ProjectStore.Required(reference, "componentId")) : instance;
                values[alias] = owner["props"]!["customProperties"]![ProjectStore.Required(reference, "key")]!["value"]!.DeepClone();
            }
            customValues[parameter] = values;
        }
        result["bindingCustomValues"] = customValues;
        var stateDefinitions = new JsonObject();
        foreach (var reference in bindings.SelectMany(pair => pair.Value!["references"]!.AsObject()).Select(pair => pair.Value!.AsObject()))
        {
            var kind = ProjectStore.Required(reference, "kind");
            var stateScope = StateScope(kind);
            if (stateScope is null) continue;
            var key = ProjectStore.Required(reference, "key");
            var declarations = kind switch
            {
                "sessionState" => project["sessionState"],
                "screenState" => screen["state"],
                _ => parent["instanceState"]
            };
            if (declarations?[key] is not JsonObject declaration)
                throw new ArgumentException("A parameter binding state declaration is missing from the published containing scope.");
            // Capture only types from the publication. Runtime values must be
            // submitted explicitly; authored defaults never fill missing state.
            if (stateDefinitions[stateScope] is not JsonObject definitions)
                stateDefinitions[stateScope] = definitions = new JsonObject();
            definitions[key] = ProjectStore.Required(declaration, "type");
        }
        result["bindingStateDefinitions"] = stateDefinitions;
    }

    public static Dictionary<string, JsonElement> Evaluate(JsonObject scope, IReadOnlyDictionary<string, JsonElement> parentParameters,
        IReadOnlyDictionary<string, JsonElement>? inputs, ParameterBindingState? state)
    {
        var resolved = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var (parameter, node) in scope["parameterBindings"] as JsonObject ?? [])
        {
            var binding = node!.AsObject();
            var references = binding["references"]!.AsObject();
            resolved[parameter] = ComponentBindingValidator.EvaluateExpression(ProjectStore.Required(binding, "expression"), references.Select(pair => pair.Key), alias =>
            {
                var reference = references[alias]!.AsObject();
                var key = ProjectStore.Required(reference, "key");
                return ProjectStore.Required(reference, "kind") switch
                {
                    "custom" => JsonSerializer.SerializeToElement(scope["bindingCustomValues"]![parameter]![alias]),
                    "parameter" when parentParameters.TryGetValue(key, out var value) => value,
                    "input" when inputs is not null && inputs.TryGetValue(key, out var value) => value,
                    var kind when StateScope(kind) is { } stateScope && state is not null && state.TryGetValue(stateScope, out var values) && values.TryGetValue(key, out var value) => value,
                    _ => throw new ArgumentException("A parameter binding source is missing from its parent context.")
                };
            });
        }
        return resolved;
    }

    private static string? StateScope(string kind) => kind switch
    {
        "sessionState" => "session", "screenState" => "screen", "instanceState" => "instance", _ => null
    };

    public static void ValidateState(JsonObject[] scopes, IReadOnlyList<ParameterBindingState>? supplied)
    {
        if (supplied is not null && (supplied.Count != scopes.Length || supplied.Count > ProjectTemplates.MaximumInstanceDepth || supplied.Any(state => state is null)))
            throw new ArgumentException("Binding state must contain one sparse state map per outer-to-inner template instance.");
        var shared = new Dictionary<(string Scope, string Key), JsonElement>();
        for (var index = 0; index < scopes.Length; index++)
        {
            var definitions = scopes[index]["bindingStateDefinitions"] as JsonObject ?? [];
            var state = supplied?[index];
            if (state is not null && state.Keys.Any(key => !definitions.ContainsKey(key)))
                throw new ArgumentException("Binding state includes an unreferenced state scope.");
            foreach (var (scope, declarationNode) in definitions)
            {
                var declared = declarationNode!.AsObject();
                if (state is null || !state.TryGetValue(scope, out var values) || values is null)
                    throw new ArgumentException($"Referenced {scope} state values must be explicitly supplied.");
                if (values.Count != declared.Count || values.Keys.Any(key => !declared.ContainsKey(key)))
                    throw new ArgumentException("Binding state must contain exactly the referenced declaration keys.");
                foreach (var (key, type) in declared)
                {
                    if (!values.TryGetValue(key, out var value)) throw new ArgumentException($"Binding state '{key}' is missing.");
                    ProjectStateValidator.ValidateSuppliedValue(type!.GetValue<string>(), value);
                    if (scope == "instance") continue;
                    // Screen and session are shared across this path. The popup
                    // opener is validated separately as an earlier snapshot.
                    if (shared.TryGetValue((scope, key), out var prior) && !SameScalar(prior, value))
                        throw new ArgumentException($"Repeated {scope} state '{key}' must have one consistent value within its instance path.");
                    shared[(scope, key)] = value;
                }
            }
        }
    }

    private static bool SameScalar(JsonElement left, JsonElement right) => left.ValueKind == right.ValueKind && left.ValueKind switch
    {
        JsonValueKind.String => left.GetString() == right.GetString(),
        JsonValueKind.Number => left.GetDouble() == right.GetDouble(),
        JsonValueKind.True or JsonValueKind.False => true,
        _ => false
    };
}
