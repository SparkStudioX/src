using System.Text.Json;
using System.Text.Json.Nodes;
using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

/// <summary>Traverses authored custom-property dependencies without accepting browser-computed values.</summary>
internal static class RuntimeCustomBindings
{
    private const int MaximumDepth = 32;
    private const int MaximumDependencies = 4096;
    internal sealed record Reference(JsonObject Owner, JsonObject Definition);

    internal static IReadOnlyList<Reference> References(JsonObject owner, IEnumerable<JsonObject> bindings,
        IReadOnlyDictionary<string, JsonObject> components, Action<JsonObject, string>? visitCustom = null)
    {
        var result = new List<Reference>();
        var active = new HashSet<(string, string)>();
        var visited = new HashSet<(string, string)>();
        var queries = 0;
        void Binding(JsonObject component, JsonObject binding, int depth)
        {
            if (depth > MaximumDepth) throw new ArgumentException("Custom property bindings exceed 32 dependency levels.");
            if (binding["references"] is not JsonObject references) return; // The expression validator reports malformed definitions.
            foreach (var raw in references.Select(pair => pair.Value).OfType<JsonObject>())
            {
                if (result.Count >= MaximumDependencies) throw new ArgumentException("Custom property bindings exceed 4,096 source dependencies.");
                result.Add(new(component, raw));
                if (ProjectStore.Optional(raw, "kind") != "custom") continue;
                var id = ProjectStore.Optional(raw, "componentId") ?? ProjectStore.Required(component, "id");
                if (!components.TryGetValue(id, out var target)) throw new ArgumentException("Custom property references must remain in their containing document.");
                var key = ProjectStore.Required(raw, "key");
                if (target["props"]?["customProperties"]?[key] is not JsonObject) throw new ArgumentException("A referenced custom property is missing.");
                var identity = (id, key);
                if (active.Contains(identity)) throw new ArgumentException("Custom property bindings cannot contain cycles.");
                if (!visited.Add(identity)) continue;
                if (active.Count >= MaximumDepth) throw new ArgumentException("Custom property bindings exceed 32 dependency levels.");
                if (target["props"]?["queryBindings"]?[$"customProperties.{key}.value"] is JsonObject && ++queries > 128)
                    throw new ArgumentException("A custom-property source context supports at most 128 query dependencies.");
                active.Add(identity);
                visitCustom?.Invoke(target, key);
                foreach (var expression in CustomExpressions(target, key)) Binding(target, expression, depth + 1);
                active.Remove(identity);
            }
        }
        foreach (var binding in bindings) Binding(owner, binding, 0);
        return result;
    }

    private static IEnumerable<JsonObject> CustomExpressions(JsonObject owner, string key)
    {
        var path = $"customProperties.{key}.value";
        if (owner["props"]?["bindings"]?[path] is JsonObject binding) yield return binding;
        if (owner["props"]?["queryBindings"]?[path]?["parameters"] is JsonObject mappings)
            foreach (var expression in mappings.Select(pair => pair.Value).OfType<JsonObject>()) yield return expression;
    }

    internal static void ValidateCycles(IReadOnlyDictionary<string, JsonObject> components)
    {
        foreach (var owner in components.Values)
        {
            if (owner["props"]?["customProperties"] is not JsonObject customs) continue;
            // Include a root reference so direct self references are diagnosed
            // even if their expression branch would not currently be selected.
            foreach (var key in customs.Select(pair => pair.Key))
                References(owner, [new JsonObject { ["references"] = new JsonObject { ["root"] = new JsonObject { ["kind"] = "custom", ["key"] = key } } }], components);
        }
    }

    internal static void ValidateRestrictedSources(JsonObject owner, JsonObject binding,
        IReadOnlyDictionary<string, JsonObject> components, bool allowTags)
    {
        foreach (var source in References(owner, [binding], components))
        {
            var kind = ProjectStore.Required(source.Definition, "kind");
            if (!allowTags && kind == "tag") throw new ArgumentException("Query parameter expressions cannot reference tags through custom properties.");
            if (kind == "input" && components.Values.Any(component => ProjectStore.Optional(component, "type") == "passwordInput" &&
                ProjectStore.Optional(component["props"]!.AsObject(), "fieldKey") == ProjectStore.Required(source.Definition, "key")))
                throw new ArgumentException("Parameter bindings cannot read password inputs through custom properties.");
        }
    }

    internal static IReadOnlyList<Reference> Capture(JsonObject scope, JsonObject instance, IReadOnlyDictionary<string, JsonObject> components)
    {
        var sources = new JsonArray();
        var bindings = (instance["props"]?["parameterBindings"] as JsonObject ?? []).Select(pair => pair.Value).OfType<JsonObject>();
        var references = References(instance, bindings, components, (owner, key) =>
        {
            var path = $"customProperties.{key}.value";
            sources.Add(new JsonObject
            {
                ["componentId"] = ProjectStore.Required(owner, "id"), ["key"] = key,
                ["definition"] = owner["props"]!["customProperties"]![key]!.DeepClone(),
                ["binding"] = owner["props"]?["bindings"]?[path]?.DeepClone(),
                ["queryBinding"] = owner["props"]?["queryBindings"]?[path]?.DeepClone()
            });
        });
        scope["bindingOwnerId"] = ProjectStore.Required(instance, "id");
        scope["bindingCustomSources"] = sources;
        return references;
    }

    internal static async Task<Dictionary<string, JsonElement>> EvaluateAsync(JsonObject scope, IReadOnlyDictionary<string, JsonElement> parameters,
        IReadOnlyDictionary<string, JsonElement>? inputs, ParameterBindingState? state, Func<string, JsonElement>? readTag,
        Func<string, Dictionary<string, JsonElement>, Task<QueryResult>> readQuery)
    {
        var sources = (scope["bindingCustomSources"] as JsonArray ?? []).OfType<JsonObject>().ToDictionary(
            source => (ProjectStore.Required(source, "componentId"), ProjectStore.Required(source, "key")));
        var completed = new Dictionary<(string, string), JsonElement>();
        var active = new HashSet<(string, string)>();
        var tagValues = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        async Task<JsonElement> Expression(JsonObject binding, string owner)
        {
            var references = binding["references"]!.AsObject();
            var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            foreach (var (alias, node) in references)
            {
                var reference = node!.AsObject();
                var kind = ProjectStore.Required(reference, "kind");
                if (kind == "tag")
                {
                    var path = TagBindingAddress.Resolve(ProjectStore.Required(reference, "path"), parameters);
                    if (!tagValues.TryGetValue(path, out var value)) tagValues[path] = value = readTag?.Invoke(path) ?? throw new ArgumentException("The gateway tag source is unavailable.");
                    values[alias] = value;
                }
                else
                {
                    var key = ProjectStore.Required(reference, "key");
                    values[alias] = kind switch
                    {
                        "custom" => await Custom(ProjectStore.Optional(reference, "componentId") ?? owner, key),
                        "parameter" when parameters.TryGetValue(key, out var value) => value,
                        "input" when inputs is not null && inputs.TryGetValue(key, out var value) => value,
                        _ when StateScope(kind) is { } stateScope && state is not null && state.TryGetValue(stateScope, out var valuesForScope) && valuesForScope.TryGetValue(key, out var value) => value,
                        _ => throw new ArgumentException("A parameter binding source is missing from its parent context.")
                    };
                }
                // Validate every source, including unselected expression branches.
                ComponentBindingValidator.EvaluateExpression(alias, [alias], _ => values[alias]);
            }
            return ComponentBindingValidator.EvaluateExpression(ProjectStore.Required(binding, "expression"), values.Keys, alias => values[alias]);
        }
        async Task<JsonElement> Custom(string owner, string key)
        {
            var identity = (owner, key);
            if (completed.TryGetValue(identity, out var cached)) return cached;
            if (active.Count >= MaximumDepth || !active.Add(identity)) throw new ArgumentException("Custom property bindings contain a cycle or exceed 32 dependency levels.");
            if (!sources.TryGetValue(identity, out var source)) throw new ArgumentException("A custom binding source is missing from the captured publication.");
            try
            {
                JsonElement value;
                if (source["binding"] is JsonObject binding) value = await Expression(binding, owner);
                else if (source["queryBinding"] is JsonObject query)
                {
                    var queryParameters = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
                    foreach (var (name, expression) in query["parameters"] as JsonObject ?? []) queryParameters[name] = await Expression(expression!.AsObject(), owner);
                    var result = await readQuery(ProjectStore.Required(query, "queryId"), queryParameters);
                    var column = ProjectStore.Required(query, "column");
                    if (!result.Columns.Contains(column, StringComparer.Ordinal) || result.Rows.Count != 1 || !result.Rows[0].TryGetValue(column, out var raw) || raw is null)
                        throw new ArgumentException("A bound custom-property query did not return its required scalar column.");
                    value = JsonSerializer.SerializeToElement(raw);
                    ComponentBindingValidator.EvaluateExpression("value", ["value"], _ => value);
                    if (query["transform"] is JsonValue transform)
                        value = ComponentBindingValidator.EvaluateExpression(transform.GetValue<string>(), ["value"], _ => value);
                }
                else value = JsonSerializer.SerializeToElement(source["definition"]!["value"]);
                ProjectStateValidator.ValidateSuppliedValue(ProjectStore.Required(source["definition"]!.AsObject(), "type"), value);
                completed[identity] = value.Clone();
                return value;
            }
            finally { active.Remove(identity); }
        }
        var resolved = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var (key, binding) in scope["parameterBindings"] as JsonObject ?? [])
            resolved[key] = await Expression(binding!.AsObject(), ProjectStore.Required(scope, "bindingOwnerId"));
        return resolved;
    }

    private static string? StateScope(string kind) => kind switch
    {
        "sessionState" => "session", "screenState" => "screen", "instanceState" => "instance", _ => null
    };
}
