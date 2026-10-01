using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>The browser and gateway share an explicit presentation-property contract.</summary>
internal static class RuntimePropertyCatalog
{
    internal const int MaximumBindings = 128;
    private static readonly JsonObject[] Properties = Load();
    private static readonly Regex Color = new(@"\A#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\z", RegexOptions.CultureInvariant);
    private static JsonObject[] Load()
    {
        using var stream = typeof(RuntimePropertyCatalog).Assembly.GetManifestResourceStream("SparkStudio.RuntimeProperties.json")
            ?? throw new InvalidOperationException("The runtime property catalog is missing.");
        return JsonNode.Parse(stream)!["properties"]!.AsArray().OfType<JsonObject>().ToArray();
    }

    internal static JsonObject? Definition(JsonObject component, string target)
    {
        if (target == "data" && component["props"]?["tableEdit"] is not null) return null;
        var parts = target.Split('.');
        if (parts.Length == 3 && parts[0] == "customProperties" && parts[2] == "value" &&
            ProjectStateValidator.ValidKey(parts[1]) && parts[1] is not ("true" or "false" or "null") &&
            component["props"]?["customProperties"] is JsonObject customs && customs[parts[1]] is JsonObject definition)
            return new JsonObject { ["path"] = target, ["type"] = definition["type"]?.DeepClone(), ["maxLength"] = 4096 };
        var type = ProjectStore.Required(component, "type");
        foreach (var property in Properties)
        {
            if (!property["components"]!.AsArray().Any(value => value!.GetValue<string>() is "*" || value.GetValue<string>() == type)) continue;
            var pattern = ProjectStore.Required(property, "path").Split('.');
            if (pattern.Length != parts.Length) continue;
            JsonNode? owner = component["props"];
            var matches = true;
            for (var index = 0; index < parts.Length; index++)
            {
                if (pattern[index] == "*")
                {
                    if (!int.TryParse(parts[index], out var item) || item.ToString(System.Globalization.CultureInfo.InvariantCulture) != parts[index] ||
                        owner is not JsonArray array || item < 0 || item >= array.Count) { matches = false; break; }
                    owner = array[item];
                }
                else
                {
                    if (pattern[index] != parts[index]) { matches = false; break; }
                    owner = owner is JsonObject obj ? obj[parts[index]] : null;
                }
            }
            if (matches)
            {
                if (parts.Length == 4 && parts[0] == "viewLayout" && parts[1] == "panes" && parts[3] != "label")
                {
                    var layout = component["props"]?["viewLayout"];
                    if (layout?["kind"]?.GetValue<string>() != "dock" || parts[3] == "size" && layout["panes"]![int.Parse(parts[2], System.Globalization.CultureInfo.InvariantCulture)]!["edge"]?.GetValue<string>() == "center") return null;
                }
                return property;
            }
        }
        return null;
    }

    internal static JsonNode ValidateTargetValue(JsonObject component, string target, object value)
    {
        var definition = Definition(component, target) ?? throw new ArgumentException($"The {target} binding is not supported on {ProjectStore.Required(component, "type")}.");
        var type = ProjectStore.Required(definition, "type");
        var number = value is double numeric ? numeric : double.NaN;
        var safe = double.IsFinite(number) && (number != Math.Truncate(number) || Math.Abs(number) <= 9007199254740991d);
        var valid = type switch
        {
            "number" => safe && (definition["min"] is null || number >= definition["min"]!.GetValue<double>()) &&
                (definition["exclusiveMin"]?.GetValue<bool>() != true || number > definition["min"]!.GetValue<double>()) &&
                (definition["max"] is null || number <= definition["max"]!.GetValue<double>()) && (definition["integer"]?.GetValue<bool>() != true || number == Math.Truncate(number)),
            "boolean" => value is bool,
            "string" => value is string text && TrimLength(text) >= (definition["minLength"]?.GetValue<int>() ?? 0) && text.Length <= (definition["maxLength"]?.GetValue<int>() ?? 4096),
            "scalar" => value is bool || safe || value is string scalar && scalar.Length <= 4096,
            "color" => value is string color && (Color.IsMatch(color) || target == "fillColor" && color == "none"),
            "tagPath" => value is string path && path.Length is > 0 and <= 1024 && TrimLength(path) > 0 && !path.Any(character => character < 32 || character == 127 || character is '{' or '}'),
            "json" => value is string json && json.Length <= 4096,
            _ => false
        };
        if (!valid || type != "color" && definition["enum"] is JsonArray choices && !choices.Any(choice => JsonNode.DeepEquals(choice, JsonSerializer.SerializeToNode(value))))
            throw new ArgumentException($"The {target} binding must produce a valid bounded {type} value.");
        if (target == "icon" && (value is not string icon || !ProjectInteractions.Icons.Contains(icon)))
            throw new ArgumentException("An icon binding must select a built-in icon name.");
        if (target == "assetId" && (value is not string asset || !Regex.IsMatch(asset, @"\A[a-f0-9]{64}\z", RegexOptions.CultureInvariant)))
            throw new ArgumentException("An image asset binding must produce a local asset hash.");
        if (target == "imageUrl") ValidateImageUrl(value);
        if (type != "json") return JsonNode.Parse(JsonSerializer.Serialize(value))!;
        JsonNode? parsed;
        try { parsed = JsonNode.Parse((string)value, documentOptions: new JsonDocumentOptions { MaxDepth = 12 }); }
        catch (JsonException error) { throw new ArgumentException($"The {target} binding must produce valid bounded JSON text.", error); }
        if (parsed is not (JsonArray or JsonObject)) throw new ArgumentException($"The {target} binding must produce a JSON array or object.");
        var nodes = 0;
        void Check(JsonNode? node)
        {
            if (++nodes > 4096) throw new ArgumentException("Structured binding values support at most 4,096 values.");
            if (node is JsonObject obj)
            {
                if (obj.Count > 128) throw new ArgumentException("Structured objects support at most 128 properties.");
                foreach (var (key, child) in obj)
                {
                    if (key.Length > 256 || key is "__proto__" or "constructor" or "prototype") throw new ArgumentException("Structured binding values contain an unsafe key.");
                    Check(child);
                }
            }
            else if (node is JsonArray array)
            {
                if (array.Count > 1000) throw new ArgumentException("Structured arrays support at most 1,000 entries.");
                foreach (var child in array) Check(child);
            }
            else if (node is JsonValue scalar && scalar.TryGetValue<double>(out var numeric) &&
                (!double.IsFinite(numeric) || numeric == Math.Truncate(numeric) && Math.Abs(numeric) > 9007199254740991d))
                throw new ArgumentException("Structured binding numbers must be finite and exact.");
        }
        Check(parsed);
        ValidateStructured(ProjectStore.Required(definition, "schema"), parsed, component);
        return parsed;
    }

    private static int TrimLength(string text)
    {
        // ECMAScript trim includes BOM and excludes Unicode NEL.
        static bool Space(char value) => value == '\uFEFF' || value != '\u0085' && char.IsWhiteSpace(value);
        var first = 0; var last = text.Length;
        while (first < last && Space(text[first])) first++;
        while (last > first && Space(text[last - 1])) last--;
        return last - first;
    }

    // The gateway validates shape only. The browser additionally requires its
    // current origin before dereferencing a transient object URL.
    internal static void ValidateImageUrl(object value)
    {
        if (value is not string text || text.Length > 4096) throw new ArgumentException("Image URL must be text up to 4096 characters.");
        if (text.Length == 0) return;
        if (!text.StartsWith("blob:", StringComparison.Ordinal) || text.Any(character => char.IsWhiteSpace(character) || char.IsControl(character)) ||
            !Uri.TryCreate(text[5..], UriKind.Absolute, out var inner) || inner.Scheme is not ("http" or "https") ||
            inner.UserInfo.Length > 0 || inner.Host.Length == 0 || inner.AbsolutePath.Length <= 1 || inner.Query.Length > 0 || inner.Fragment.Length > 0)
            throw new ArgumentException("Image URL must be empty or a local browser blob URL.");
    }

    private static void ValidateStructured(string schema, JsonNode value, JsonObject component)
    {
        var type = ProjectStore.Required(component, "type");
        switch (schema)
        {
            case "dataset": DatasetBindingValidator.ValidateData(value); break;
            case "points": DrawingComponentValidator.Validate(type, new JsonObject { ["points"] = value.DeepClone() }); break;
            case "states": StateControlValidator.ValidateIndicator(new JsonObject { ["states"] = value.DeepClone() }); break;
            case "tableColumns": TableColumnValidator.Validate(type, new JsonObject { ["tableColumns"] = value.DeepClone() }); break;
            case "options":
                if (value is not JsonArray options || options.OfType<JsonObject>().Any(option => option.Any(pair => pair.Key is not ("value" or "label") && !(type == "treeView" && pair.Key == "parentValue"))))
                    throw new ArgumentException("Bound options contain only value and label; tree options also support parentValue.");
                InputDefinitionValidator.ValidateDefinition(type, new JsonObject { ["fieldKey"] = "binding", ["options"] = value.DeepClone() }, []);
                break;
            case "chartSeries":
                ChartValidator.Validate(type, new JsonObject { ["chart"] = new JsonObject { ["kind"] = "line", ["xKey"] = "x", ["series"] = value.DeepClone() }, ["dataSource"] = new JsonObject() });
                break;
            case "historyPaths":
                if (value is not JsonArray paths || paths.Count > 8) throw new ArgumentException("Bound historical trends support at most eight tag paths.");
                ProcessDataComponentValidator.Validate(new JsonObject { ["screens"] = new JsonArray(new JsonObject { ["components"] = new JsonArray(new JsonObject
                    { ["type"] = "historicalTrend", ["props"] = new JsonObject { ["historyPaths"] = value.DeepClone() } }) }) });
                break;
            default: throw new ArgumentException("Unsupported structured runtime property schema.");
        }
    }

    internal static void SetValue(JsonObject component, string target, JsonNode value)
    {
        if (target is "x" or "y" or "width" or "height") { component[target] = value.DeepClone(); return; }
        var parts = target.Split('.');
        JsonNode owner = component["props"]!.AsObject();
        for (var index = 0; index < parts.Length - 1; index++)
        {
            if (owner is JsonArray array) owner = array[int.Parse(parts[index], System.Globalization.CultureInfo.InvariantCulture)]!;
            else
            {
                var obj = owner.AsObject();
                if (obj[parts[index]] is null) obj[parts[index]] = new JsonObject();
                owner = obj[parts[index]]!;
            }
        }
        owner.AsObject()[parts[^1]] = value.DeepClone();
    }

    // Validate the combined constant projection, so paired changes (e.g. both
    // chart bounds) are checked together against the existing family contract.
    internal static void ValidateConstants(JsonObject component, IReadOnlyDictionary<string, object> constants)
    {
        if (constants.Count == 0) return;
        var projected = component.DeepClone().AsObject();
        foreach (var (target, value) in constants) SetValue(projected, target, ValidateTargetValue(component, target, value));
        var type = ProjectStore.Required(projected, "type");
        var props = projected["props"]!.AsObject();
        var unresolved = ((component["props"]?["bindings"] as JsonObject ?? []).Select(pair => pair.Key)
            .Concat((component["props"]?["queryBindings"] as JsonObject ?? []).Select(pair => pair.Key))).Where(key => !constants.ContainsKey(key)).ToHashSet(StringComparer.Ordinal);
        if (ProcessDisplayValidator.Types.Contains(type)) ProcessDisplayValidator.ValidateConstantRange(type, component["props"]!.AsObject(), constants);
        if (DrawingComponentValidator.Types.Contains(type)) DrawingComponentValidator.Validate(type, props);
        if (InputDefinitionValidator.IsInput(type))
        {
            // Runtime rules do not rewrite the saved input default or authorize
            // values outside the server's authored input contract.
            var input = props.DeepClone().AsObject(); input.Remove("defaultValue");
            if (constants.ContainsKey("options")) input.Remove("optionsSource");
            if (unresolved.Contains("min") || unresolved.Contains("max"))
            {
                if (type == "slider") { input["min"] = 0; input["max"] = 100; }
                else { input.Remove("min"); input.Remove("max"); }
            }
            if ((unresolved.Contains("validation.minLength") || unresolved.Contains("validation.maxLength")) && input["validation"] is JsonObject validation)
            { validation.Remove("minLength"); validation.Remove("maxLength"); }
            InputDefinitionValidator.ValidateDefinition(type, input, []);
        }
        if (type == "multiStateIndicator")
        {
            if (props["stateValue"] is JsonValue state && !state.TryGetValue<string>(out _)) props["stateValue"] = props["stateValue"]!.ToJsonString();
            StateControlValidator.ValidateIndicator(props);
        }
        if (props.ContainsKey("data")) DatasetBindingValidator.ValidateData(props["data"]);
        if (type == "table" && constants.ContainsKey("data") && props.ContainsKey("tableEdit"))
            throw new ArgumentException("A table with supplied data cannot expose query-backed table edits.");
        if (type is "chart" or "sparkline" && !unresolved.Any(target => target.StartsWith("chart.", StringComparison.Ordinal) || target == "data"))
        {
            ChartValidator.Validate(type, props);
        }
        TableColumnValidator.Validate(type, props);
        TableEditValidator.Validate(type, props);
        if (!unresolved.Any(target => target.StartsWith("viewLayout.", StringComparison.Ordinal))) ViewContainerValidator.Validate(type, props);
        if (type == "gauge" && !unresolved.Contains("min") && !unresolved.Contains("max") && (props["min"]?.GetValue<double>() ?? 0) >= (props["max"]?.GetValue<double>() ?? 100))
            throw new ArgumentException("A gauge minimum must be below its maximum.");
        if (type is "historicalTrend" or "alarmStatusTable" or "alarmJournalTable")
            ProcessDataComponentValidator.Validate(new JsonObject { ["screens"] = new JsonArray(new JsonObject { ["components"] = new JsonArray(projected) }) });
    }
}
