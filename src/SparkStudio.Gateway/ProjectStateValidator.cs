using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Typed browser-local state declarations and validation of explicit referenced scalar data.</summary>
internal static class ProjectStateValidator
{
    private const double MaximumSafeInteger = 9007199254740991;
    private static readonly Regex Identifier = new(@"\A[A-Za-z_][A-Za-z0-9_]{0,63}\z", RegexOptions.CultureInvariant);

    public static bool ValidKey(string key) => Identifier.IsMatch(key) && key is not ("__proto__" or "constructor" or "prototype");

    public static void ValidateProject(JsonObject project)
    {
        RejectInstanceDeclarations(project);
        if (project.ContainsKey("sessionState")) ValidateDefinitions(project["sessionState"], "Session state");
    }

    public static void ValidateDocument(JsonObject document, bool template)
    {
        if (document.ContainsKey("state"))
        {
            if (template) throw new ArgumentException("Templates inherit their containing screen state and cannot declare state; use instanceState for private instance defaults.");
            ValidateDefinitions(document["state"], "Screen state");
        }
        if (!template) RejectInstanceDeclarations(document);
        else if (document.ContainsKey("instanceState")) ValidateDefinitions(document["instanceState"], "Instance state");
        // A declaration belongs to the reusable template schema, never to an
        // instance wrapper, saved row, input properties or browser submission.
        foreach (var component in (document["components"] as JsonArray ?? []).OfType<JsonObject>())
        {
            RejectInstanceDeclarations(component);
            if (component["props"] is not JsonObject props) continue;
            RejectInstanceDeclarations(props);
            if (props["rows"] is JsonArray rows)
                foreach (var row in rows.OfType<JsonObject>()) RejectInstanceDeclarations(row);
        }
    }

    private static void RejectInstanceDeclarations(JsonObject owner)
    {
        if (owner.ContainsKey("instanceState")) throw new ArgumentException("Private instance state declarations belong only to template definitions.");
    }

    private static void ValidateDefinitions(JsonNode? node, string description)
    {
        if (node is not JsonObject definitions || definitions.Count > 64)
            throw new ArgumentException($"{description} must be an object with at most 64 declarations.");
        foreach (var (key, entry) in definitions)
        {
            if (!ValidKey(key) || entry is not JsonObject definition || definition.Count != 2 ||
                definition.Any(pair => pair.Key is not ("type" or "value")) ||
                definition["type"] is not JsonValue typeNode || !typeNode.TryGetValue<string>(out var type) ||
                definition["value"] is not JsonValue value || !(type switch
                {
                    "string" => value.TryGetValue<string>(out var text) && text.Length <= 4096,
                    "number" => value.TryGetValue<double>(out var number) && double.IsFinite(number) &&
                        (number != Math.Truncate(number) || Math.Abs(number) <= MaximumSafeInteger),
                    "boolean" => value.TryGetValue<bool>(out _),
                    _ => false
                }))
                throw new ArgumentException($"{description} declarations need identifier keys, a number, string or Boolean type, and a matching bounded value.");
        }
    }

    internal static void ValidateSuppliedValue(string type, JsonElement value)
    {
        var valid = type switch
        {
            "string" => value.ValueKind == JsonValueKind.String && value.GetString()!.Length <= 4096,
            "boolean" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
            "number" => value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && double.IsFinite(number) &&
                (number != Math.Truncate(number) || Math.Abs(number) <= MaximumSafeInteger),
            _ => false
        };
        if (!valid) throw new ArgumentException("Binding state values must match their published type: bounded text, Boolean, or an exact finite number.");
    }

    public static void ValidateReference(string kind, string key, JsonObject? sessionState, JsonObject document, bool template)
    {
        if (!ValidKey(key)) throw new ArgumentException("State references must name valid state identifiers.");
        if (kind == "sessionState")
        {
            if (sessionState?.ContainsKey(key) != true)
                throw new ArgumentException($"Session state '{key}' is not declared by the project.");
        }
        else if (kind == "instanceState")
        {
            if (!template || (document["instanceState"] as JsonObject)?.ContainsKey(key) != true)
                throw new ArgumentException($"Instance state '{key}' must be declared by the immediately containing template.");
        }
        else if (!template && (document["state"] as JsonObject)?.ContainsKey(key) != true)
            throw new ArgumentException($"Screen state '{key}' is not declared by its screen.");
    }

    public static void ValidateInputBindings(JsonObject document, JsonObject? sessionState, bool template)
    {
        foreach (var component in document["components"]!.AsArray().OfType<JsonObject>())
        {
            if (component["props"] is not JsonObject props || !props.ContainsKey("stateBinding")) continue;
            var (scope, key, expectedType) = InputBinding(component);
            if (scope == "session") ValidateBoundDeclaration(component, sessionState, key, expectedType, "Session");
            else if (scope == "instance")
            {
                if (!template) throw new ArgumentException("Only inputs inside template definitions can bind to instance state.");
                ValidateBoundDeclaration(component, document["instanceState"] as JsonObject, key, expectedType, "Instance");
            }
            else if (!template) ValidateBoundDeclaration(component, document["state"] as JsonObject, key, expectedType, "Screen");
        }
    }

    private static (string Scope, string Key, string Type) InputBinding(JsonObject component)
    {
        var props = component["props"]!.AsObject();
        if (props["stateBinding"] is not JsonObject binding || binding.Count != 2 ||
            binding.Any(pair => pair.Key is not ("scope" or "key")) ||
            binding["scope"] is not JsonValue scopeNode || !scopeNode.TryGetValue<string>(out var scope) || scope is not ("session" or "screen" or "instance") ||
            binding["key"] is not JsonValue keyNode || !keyNode.TryGetValue<string>(out var key) || !ValidKey(key))
            throw new ArgumentException("Input state bindings need only scope (session, screen or instance) and a valid state key.");
        var expectedType = ProjectStore.Required(component, "type") switch
        {
            "textInput" or "textArea" or "dateTimeInput" or "select" or "list" or "treeView" or "radioGroup" or "multiStateButton" => "string",
            "numberInput" or "spinner" or "slider" => "number",
            "checkbox" or "toggle" => "boolean",
            _ => throw new ArgumentException("State bindings support non-password inputs only.")
        };
        if (props.ContainsKey("tagPath") && (props["tagPath"] is not JsonValue path || !path.TryGetValue<string>(out var tagPath) || tagPath.Length != 0))
            throw new ArgumentException("An input cannot combine a tag binding with a state binding.");
        if (props.ContainsKey("optionsSource") || props.ContainsKey("selectionFields"))
            throw new ArgumentException("State-bound inputs support static options without selection mappings.");
        return (scope, key, expectedType);
    }

    private static void ValidateBoundDeclaration(JsonObject component, JsonObject? declarations, string key, string expectedType, string scope)
    {
        if (declarations?[key] is not JsonObject declaration)
            throw new ArgumentException($"{scope} state '{key}' is not declared for input '{ProjectStore.Required(component, "id")}'.");
        if (ProjectStore.Optional(declaration, "type") != expectedType)
            throw new ArgumentException($"{scope} state '{key}' must have type {expectedType} for input '{ProjectStore.Required(component, "id")}'.");
        var props = component["props"]!.AsObject();
        // A state declaration is the bound control's initial value. Keep saved
        // defaults compatible with its ordinary range, option and date rules.
        InputDefinitionValidator.ValidateValue(ProjectStore.Required(props, "fieldKey"), ProjectStore.Required(component, "type"), props,
            JsonSerializer.SerializeToElement(declaration["value"]));
    }

    // A template may be drafted without a placement. Publication checks every
    // placement, because a shared template reads the containing screen's state.
    public static void ValidatePlacement(JsonObject template, JsonObject screen)
    {
        var declarations = screen["state"] as JsonObject;
        foreach (var component in template["components"]!.AsArray().OfType<JsonObject>())
        {
            if (component["props"] is JsonObject props && props.ContainsKey("stateBinding"))
            {
                var (scope, key, expectedType) = InputBinding(component);
                if (scope == "screen") ValidateBoundDeclaration(component, declarations, key, expectedType, "Screen");
            }
            foreach (var field in new[] { "bindings", "parameterBindings" })
            if (component["props"]?[field] is JsonObject bindings)
                foreach (var binding in bindings.Select(pair => pair.Value).OfType<JsonObject>())
                    if (binding["references"] is JsonObject references)
                        foreach (var reference in references.Select(pair => pair.Value).OfType<JsonObject>())
                            if (ProjectStore.Optional(reference, "kind") == "screenState" &&
                                ProjectStore.Optional(reference, "key") is { } key && declarations?.ContainsKey(key) != true)
                                throw new ArgumentException($"Template '{ProjectStore.Optional(template, "name") ?? ProjectStore.Optional(template, "id")}' requires screen state '{key}' in screen '{ProjectStore.Optional(screen, "name") ?? ProjectStore.Optional(screen, "id")}'.");
        }
    }
}
