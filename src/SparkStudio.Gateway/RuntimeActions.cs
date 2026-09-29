using System.Text.Json;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Executes the published action with only the fields declared by its published screen.</summary>
public sealed class RuntimeActions(PublicationStore publications, PythonRunner python, QueryExecutor queries)
{
    public async Task<JsonObject> ExecuteAsync(string screenId, string componentId,
        Dictionary<string, JsonElement>? parameters, Dictionary<string, JsonElement>? inputs,
        string? publishedAt, CancellationToken cancellation, string? instanceId = null, string? rowId = null, PopupOrigin? popupOrigin = null,
        IReadOnlyList<InstancePathStep>? instancePath = null, IReadOnlyList<Dictionary<string, JsonElement>>? bindingInputs = null)
    {
        if (string.IsNullOrWhiteSpace(publishedAt))
            throw new ArgumentException("Reload the published screen before executing an action.");
        // GetAction returns a detached snapshot so a concurrent publication cannot mix
        // an action's source with another publication's input definitions.
        var action = publications.GetAction(screenId, componentId, publishedAt, instanceId, rowId, popupOrigin, instancePath);
        var resolvedParameters = await ResolveContextAsync(action, parameters, bindingInputs, popupOrigin?.BindingInputs, cancellation);
        var capturedQueries = action["queries"]!.AsArray().OfType<JsonObject>().ToArray();

        var definitions = action["inputs"]!.AsArray().OfType<JsonObject>().ToArray();
        RejectUnknownKeys(inputs, definitions.Select(definition => definition["fieldKey"]!.GetValue<string>()), "input field");
        var resolvedInputs = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var definition in definitions)
        {
            var key = definition["fieldKey"]!.GetValue<string>();
            JsonElement value;
            if (inputs is not null && inputs.TryGetValue(key, out var supplied)) value = supplied;
            else if (definition["defaultValue"] is { } defaultValue) value = JsonSerializer.SerializeToElement(defaultValue);
            else throw new ArgumentException($"Input field '{key}' is required.");
            InputDefinitionValidator.ValidateValue(key, definition["type"]!.GetValue<string>(), definition, value);
            resolvedInputs.Add(key, value.Clone());
        }

        // Validate against the same detached publication as the action, never a
        // mutable draft or a later publication. Browser option lists are advisory.
        var optionResults = new Dictionary<string, SparkStudio.Connectors.QueryResult>(StringComparer.Ordinal);
        foreach (var definition in definitions.Where(InputDefinitionValidator.HasQueryOptions))
        {
            var source = definition["optionsSource"]!.AsObject();
            var queryId = ProjectStore.Required(source, "queryId");
            if (!optionResults.TryGetValue(queryId, out var result))
            {
                var query = capturedQueries.FirstOrDefault(item => ProjectStore.Optional(item, "id") == queryId)
                    ?? throw new ArgumentException("A selection options query is missing from this publication.");
                var queryParameters = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
                foreach (var parameter in (query["parameters"] as JsonArray ?? []).OfType<JsonObject>())
                {
                    var name = ProjectStore.Required(parameter, "name");
                    if (resolvedParameters.TryGetValue(name, out var value)) queryParameters[name] = value;
                    // QueryExecutor supplies the captured query's declared defaults.
                }
                result = await queries.ExecuteDefinitionAsync(query, queryParameters, cancellation);
                optionResults.Add(queryId, result);
            }
            var key = ProjectStore.Required(definition, "fieldKey");
            InputDefinitionValidator.ValidateQuerySelection(key, ProjectStore.Required(definition, "type"), source, result, resolvedInputs[key].GetString()!);
        }

        return await python.RunAsync(action["code"]!.GetValue<string>(), resolvedParameters, resolvedInputs, cancellation, action["queries"]!.AsArray());
    }

    public async Task<JsonObject> ExecuteTableEditAsync(string screenId, string componentId, TableEditRequest request, CancellationToken cancellation)
    {
        if (string.IsNullOrWhiteSpace(request.PublishedAt))
            throw new ArgumentException("Reload the published screen before editing a table.");
        var action = publications.GetTableEdit(screenId, componentId, request.PublishedAt, request.InstanceId, request.RowId, request.PopupOrigin, request.InstancePath);
        var context = await ResolveContextAsync(action, request.Parameters, request.BindingInputs, request.PopupOrigin?.BindingInputs, cancellation);
        var query = action["query"]!.AsObject();
        var queryParameters = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var parameter in (query["parameters"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var name = ProjectStore.Required(parameter, "name");
            if (context.TryGetValue(name, out var value)) queryParameters[name] = value;
        }
        var rows = await queries.ExecuteDefinitionAsync(query, queryParameters, cancellation);
        var inputs = TableEditValidator.Inputs(action["table"]!.AsObject(), rows, request);
        // This read is only a preflight. The authored update must include its key
        // and version in the WHERE clause and require exactly one affected row.
        return await python.RunAsync(action["code"]!.GetValue<string>(), context, inputs, cancellation, action["queries"]!.AsArray());
    }

    private async Task<Dictionary<string, JsonElement>> ResolveContextAsync(JsonObject action, Dictionary<string, JsonElement>? parameters,
        IReadOnlyList<Dictionary<string, JsonElement>>? bindingInputs, IReadOnlyList<Dictionary<string, JsonElement>>? popupBindingInputs, CancellationToken cancellation)
    {
        var declaredParameters = action["projectParameters"]!.AsObject();
        RejectUnknownKeys(parameters, declaredParameters.Select(pair => pair.Key), "context parameter");
        var context = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var (key, defaultValue) in declaredParameters)
        {
            var value = parameters is not null && parameters.TryGetValue(key, out var supplied)
                ? supplied : JsonSerializer.SerializeToElement(defaultValue);
            if (value.ValueKind != JsonValueKind.String) throw new ArgumentException($"Context parameter '{key}' must be text.");
            context.Add(key, value.Clone());
        }
        var rootParameters = new Dictionary<string, JsonElement>(context, StringComparer.Ordinal);
        var capturedQueries = action["queries"]!.AsArray().OfType<JsonObject>().ToArray();
        Overlay(context, action["screenParameters"] as JsonObject, rootParameters);
        if (action["popupOrigin"] is JsonObject opener)
        {
            var caller = new Dictionary<string, JsonElement>(rootParameters, StringComparer.Ordinal);
            Overlay(caller, opener["screenParameters"] as JsonObject, rootParameters);
            // Re-query and validate the published opener before resolving popup
            // mappings. Database strings remain literal after one substitution.
            await OverlayTemplatesAsync(caller, opener, capturedQueries, popupBindingInputs, cancellation);
            Overlay(context, opener["parameters"] as JsonObject, caller);
        }
        await OverlayTemplatesAsync(context, action, capturedQueries, bindingInputs, cancellation);
        return context;
    }

    private async Task OverlayTemplatesAsync(Dictionary<string, JsonElement> context, JsonObject owner, JsonObject[] capturedQueries,
        IReadOnlyList<Dictionary<string, JsonElement>>? bindingInputs, CancellationToken cancellation)
    {
        // Every scope was captured by walking the same immutable published graph.
        // Resolve from outer to inner so a child sees its parent's typed values,
        // after any root query row has been rechecked against current membership.
        var scopes = owner["templateScopes"]!.AsArray().OfType<JsonObject>().ToArray();
        if (bindingInputs is not null && (bindingInputs.Count != scopes.Length || bindingInputs.Count > ProjectTemplates.MaximumInstanceDepth || bindingInputs.Any(input => input is null)))
            throw new ArgumentException("Binding inputs must contain one input map per outer-to-inner template instance.");
        for (var index = 0; index < scopes.Length; index++)
            await OverlayTemplateAsync(context, scopes[index], capturedQueries, bindingInputs?[index], cancellation);
    }

    private async Task OverlayTemplateAsync(Dictionary<string, JsonElement> context, JsonObject scope, JsonObject[] capturedQueries,
        Dictionary<string, JsonElement>? bindingInputs, CancellationToken cancellation)
    {
        var parameterTypes = scope["templateParameterTypes"] as JsonObject;
        await ValidateBindingInputsAsync(scope, bindingInputs, context, capturedQueries, cancellation);
        // Every result is validated even when a saved/query row later overrides
        // that key. An invalid expression must never leave an actionable row.
        var boundParameters = TemplateParameterBindings.Evaluate(scope, context, bindingInputs)
            .ToDictionary(pair => pair.Key, pair => TemplateParameterTypes.Coerce(pair.Key, pair.Value, parameterTypes), StringComparer.Ordinal);
        Dictionary<string, JsonElement>? rowParameters = null;
        if (scope["rowsSource"] is JsonObject rowsSource)
        {
            var queryId = ProjectStore.Required(rowsSource, "queryId");
            var query = capturedQueries.FirstOrDefault(item => ProjectStore.Optional(item, "id") == queryId)
                ?? throw new ArgumentException("A repeater query is missing from this publication.");
            // Membership uses the calling screen context before template or row
            // overrides. Mutable form fields never select the actionable row.
            var queryParameters = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            foreach (var definition in (query["parameters"] as JsonArray ?? []).OfType<JsonObject>())
            {
                var name = ProjectStore.Required(definition, "name");
                if (context.TryGetValue(name, out var value)) queryParameters[name] = value;
            }
            var result = await queries.ExecuteDefinitionAsync(query, queryParameters, cancellation);
            rowParameters = QueryRepeaterSource.ResolveRow(rowsSource, result, ProjectStore.Required(scope, "rowId"), parameterTypes);
        }
        if (scope["templateParameters"] is not JsonObject authored) return;
        var resolved = ProjectTemplates.ResolveParameters(authored, context);
        foreach (var (key, value) in boundParameters) resolved[key] = value;
        if (scope["rowParameters"] is JsonObject savedRow)
            foreach (var (key, value) in ProjectTemplates.ResolveParameters(savedRow, context)) resolved[key] = value;
        // Database text is an already-resolved value, never another reference.
        if (rowParameters is not null)
            foreach (var (key, value) in rowParameters) resolved[key] = value;
        // Coercion happens after all authored and query overrides. Never accept
        // client-supplied template values as a substitute for this reconstruction.
        foreach (var (key, value) in resolved) context[key] = TemplateParameterTypes.Coerce(key, value, parameterTypes);
    }

    private async Task ValidateBindingInputsAsync(JsonObject scope, Dictionary<string, JsonElement>? inputs,
        IReadOnlyDictionary<string, JsonElement> parentParameters, JsonObject[] capturedQueries, CancellationToken cancellation)
    {
        var definitions = (scope["bindingInputDefinitions"] as JsonArray ?? []).OfType<JsonObject>().ToArray();
        RejectUnknownKeys(inputs, definitions.Select(item => ProjectStore.Required(item, "fieldKey")), "parameter binding input");
        var optionResults = new Dictionary<string, SparkStudio.Connectors.QueryResult>(StringComparer.Ordinal);
        foreach (var definition in definitions)
        {
            var key = ProjectStore.Required(definition, "fieldKey");
            if (inputs is null || !inputs.TryGetValue(key, out var value))
                throw new ArgumentException($"Parent input '{key}' is required by a parameter binding.");
            var type = ProjectStore.Required(definition, "type");
            InputDefinitionValidator.ValidateValue(key, type, definition, value);
            if (!InputDefinitionValidator.HasQueryOptions(definition)) continue;
            var source = definition["optionsSource"]!.AsObject();
            var queryId = ProjectStore.Required(source, "queryId");
            if (!optionResults.TryGetValue(queryId, out var result))
            {
                var query = capturedQueries.FirstOrDefault(item => ProjectStore.Optional(item, "id") == queryId)
                    ?? throw new ArgumentException("A binding input options query is missing from this publication.");
                var parameters = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
                foreach (var parameter in (query["parameters"] as JsonArray ?? []).OfType<JsonObject>())
                {
                    var name = ProjectStore.Required(parameter, "name");
                    if (parentParameters.TryGetValue(name, out var supplied)) parameters[name] = supplied;
                }
                result = await queries.ExecuteDefinitionAsync(query, parameters, cancellation);
                optionResults.Add(queryId, result);
            }
            InputDefinitionValidator.ValidateQuerySelection(key, type, source, result, value.GetString()!);
        }
    }

    private static void Overlay(Dictionary<string, JsonElement> target, JsonObject? definitions, IReadOnlyDictionary<string, JsonElement> context)
    {
        if (definitions is null) return;
        foreach (var (key, value) in ProjectTemplates.ResolveParameters(definitions, context)) target[key] = value;
    }

    private static void RejectUnknownKeys(Dictionary<string, JsonElement>? supplied, IEnumerable<string> declared, string description)
    {
        if (supplied is null) return;
        var allowed = declared.ToHashSet(StringComparer.Ordinal);
        if (supplied.Keys.Any(key => !allowed.Contains(key)))
            throw new ArgumentException($"The request includes an undeclared {description}.");
    }

}
