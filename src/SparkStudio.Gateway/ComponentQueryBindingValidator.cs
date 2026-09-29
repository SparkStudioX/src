using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Read-only named-query presentation bindings. No browser query definition or action authority is accepted.</summary>
internal static class ComponentQueryBindingValidator
{
    private static readonly Regex ParameterName = new(@"\A@?[A-Za-z_][A-Za-z0-9_]{0,127}\z", RegexOptions.CultureInvariant);

    public static void ValidateProject(JsonObject project)
    {
        RejectMisplaced(project);
        var templates = ProjectTemplates.Templates(project).ToHashSet();
        foreach (var document in ProjectTemplates.Documents(project))
        {
            RejectMisplaced(document);
            var context = ComponentBindingValidator.CreateExpressionContext(document, project["parameters"] as JsonObject,
                project["sessionState"] as JsonObject, templates.Contains(document), queryParameter: true);
            foreach (var component in document["components"]!.AsArray().OfType<JsonObject>())
            {
                RejectMisplaced(component);
                if (component["props"] is not JsonObject props || !props.ContainsKey("queryBindings")) continue;
                if (props["queryBindings"] is not JsonObject bindings || bindings.Count > 32)
                    throw new ArgumentException("Query bindings must be an object with at most 32 supported scalar targets.");
                var constants = new Dictionary<string, object>(StringComparer.Ordinal);
                if (props["bindings"] is JsonObject propertyExpressions)
                    foreach (var (target, raw) in propertyExpressions)
                    {
                        var expression = raw!.AsObject();
                        var constant = ComponentBindingValidator.ValidateExpression(ProjectStore.Required(expression, "expression"), expression["references"]!.AsObject().Select(pair => pair.Key));
                        if (constant.Constant) constants[target] = constant.Value!;
                    }
                foreach (var (target, raw) in bindings)
                {
                    var type = ProjectStore.Required(component, "type");
                    if (!ComponentBindingValidator.SupportsTarget(type, target))
                        throw new ArgumentException($"The {target} query binding is not supported on {type}.");
                    if (props["bindings"] is JsonObject expressions && expressions.ContainsKey(target))
                        throw new ArgumentException("A property cannot have both an expression binding and a query binding.");
                    if (raw is not JsonObject binding || binding.Any(pair => pair.Key is not ("queryId" or "column" or "parameters" or "refresh" or "transform")))
                        throw new ArgumentException("A query binding needs queryId, column, optional parameters, refresh policy and transform only.");
                    Text(binding, "queryId", 256); Text(binding, "column", 128);
                    if (binding.ContainsKey("transform"))
                    {
                        var transform = ComponentBindingValidator.ValidateExpression(Text(binding, "transform", 2048), ["value"]);
                        if (transform.Constant)
                        {
                            ComponentBindingValidator.ValidateScalarTarget(target, transform.Value!);
                            constants[target] = transform.Value!;
                        }
                    }
                    if (binding.ContainsKey("refresh"))
                    {
                        if (binding["refresh"] is not JsonObject refresh || refresh.Any(pair => pair.Key is not ("mode" or "intervalMs")))
                            throw new ArgumentException("A query refresh policy needs mode and an optional polling interval.");
                        var mode = Text(refresh, "mode", 16);
                        if (mode == "onChange")
                        {
                            if (refresh.Count != 1) throw new ArgumentException("An onChange query refresh policy cannot contain an interval.");
                        }
                        else if (mode != "poll" || refresh.Count != 2 || refresh["intervalMs"] is not JsonValue value ||
                            !value.TryGetValue<double>(out var interval) || !double.IsFinite(interval) || interval != Math.Truncate(interval) || interval is < 1000 or > 3600000)
                            throw new ArgumentException("A polling query refresh policy needs an integer interval from 1,000 to 3,600,000 milliseconds.");
                    }
                    if (!binding.ContainsKey("parameters")) continue;
                    if (binding["parameters"] is not JsonObject parameters || parameters.Count > 128)
                        throw new ArgumentException("Query parameter mappings must be an object with at most 128 declared SQL parameter names.");
                    foreach (var (name, expression) in parameters)
                    {
                        if (!ParameterName.IsMatch(name)) throw new ArgumentException("Query parameter mappings must name declared SQL parameters.");
                        ComponentBindingValidator.ValidatePropertyExpression(expression, component, context);
                    }
                }
                ProcessDisplayValidator.ValidateConstantRange(ProjectStore.Required(component, "type"), props, constants);
            }
        }
    }

    public static IEnumerable<JsonObject> Bindings(JsonObject component) => component["props"]?["queryBindings"] is JsonObject bindings
        ? bindings.Select(pair => pair.Value).OfType<JsonObject>() : [];

    public static IEnumerable<JsonObject> ParameterExpressions(JsonObject component) => Bindings(component)
        .Where(binding => binding["parameters"] is JsonObject)
        .SelectMany(binding => binding["parameters"]!.AsObject().Select(pair => pair.Value).OfType<JsonObject>());

    // Call with a consistent project/query snapshot on save, package import and
    // publish. The definitions, including defaults, remain owned by the gateway.
    public static void ValidateQueries(JsonObject project, JsonArray queries)
    {
        var referenced = ProjectTemplates.Components(project).SelectMany(Bindings).ToArray();
        if (referenced.Length == 0) return;
        var ids = referenced.Select(binding => Text(binding, "queryId", 256)).ToHashSet(StringComparer.Ordinal);
        var definitions = SparkProjectPackage.ValidateQueries(new JsonArray(queries.OfType<JsonObject>()
            .Where(query => ids.Contains(ProjectStore.Optional(query, "id") ?? "")).Select(query => query.DeepClone()).ToArray()))
            .OfType<JsonObject>().ToDictionary(query => ProjectStore.Required(query, "id"), StringComparer.Ordinal);
        foreach (var binding in referenced)
        {
            if (!definitions.TryGetValue(Text(binding, "queryId", 256), out var query))
                throw new ArgumentException("Every property query binding must reference an existing named query.");
            if (ProjectStore.Optional(query, "kind") == "update")
                throw new ArgumentException("Property query bindings require read queries, not update queries.");
            var parameters = query["parameters"]!.AsArray().OfType<JsonObject>()
                .ToDictionary(parameter => ProjectStore.Required(parameter, "name"), StringComparer.Ordinal);
            var mappings = binding["parameters"] as JsonObject ?? [];
            if (mappings.Any(pair => !parameters.ContainsKey(pair.Key)))
                throw new ArgumentException("Every property query parameter mapping must name a declared query parameter exactly.");
            foreach (var (name, definition) in parameters)
            {
                if (mappings[name] is not JsonObject expression)
                {
                    if (!definition.ContainsKey("defaultValue"))
                        throw new ArgumentException($"Property query parameter '{name}' needs a mapping or a saved query default.");
                    continue;
                }
                var result = ComponentBindingValidator.ValidateExpression(ProjectStore.Required(expression, "expression"), expression["references"]!.AsObject().Select(pair => pair.Key));
                if (result.Constant) ValidateMappedValue(ProjectStore.Required(definition, "type"), JsonSerializer.SerializeToElement(result.Value));
            }
        }
    }

    private static void ValidateMappedValue(string type, JsonElement value)
    {
        var number = value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var numeric) ? numeric : double.NaN;
        var safe = double.IsFinite(number) && (number != Math.Truncate(number) || Math.Abs(number) <= 9007199254740991);
        var valid = type switch
        {
            "string" or "nvarchar" or "date" or "datetime" or "datetime2" or "datetimeoffset" or "guid" or "uniqueidentifier" => value.ValueKind == JsonValueKind.String && value.GetString()!.Length <= 4096,
            "int" or "int32" or "integer" => safe && number == Math.Truncate(number) && number is >= int.MinValue and <= int.MaxValue,
            "long" or "int64" or "bigint" => safe && number == Math.Truncate(number),
            "number" or "double" or "float" or "decimal" => safe,
            "bool" or "boolean" or "bit" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
            _ => false
        };
        if (!valid) throw new ArgumentException($"Mapped query parameter expressions must produce a bounded native scalar matching declared type {type}.");
    }

    private static void RejectMisplaced(JsonObject owner)
    {
        if (owner.ContainsKey("queryBindings")) throw new ArgumentException("Query bindings belong only in a component's props.queryBindings object.");
    }

    private static string Text(JsonObject owner, string key, int maximum) => owner[key] is JsonValue value &&
        value.TryGetValue<string>(out var text) && text.Length <= maximum &&
        text.Any(character => character != '\uFEFF' && (character == '\u0085' || !char.IsWhiteSpace(character)))
        ? text : throw new ArgumentException($"Query binding {key} must be nonempty text up to {maximum} characters.");
}
