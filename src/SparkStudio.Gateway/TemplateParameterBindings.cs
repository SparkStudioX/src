using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

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
                            default: throw new ArgumentException("Parameter bindings support parent parameters, custom properties and non-password inputs.");
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
    public static void Capture(JsonObject result, JsonObject parent, JsonObject instance)
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
    }

    public static Dictionary<string, JsonElement> Evaluate(JsonObject scope, IReadOnlyDictionary<string, JsonElement> parentParameters,
        IReadOnlyDictionary<string, JsonElement>? inputs)
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
                    _ => throw new ArgumentException("A parameter binding source is missing from its parent context.")
                };
            });
        }
        return resolved;
    }
}
