using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Globalization;

namespace SparkStudio.Gateway;

/// <summary>Only shipped declarations can be invoked. Model-generated tool definitions are never accepted.</summary>
public sealed class AskSparkCatalog
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly Regex ToolName = new(@"\A[a-z][a-z0-9_]{0,63}\z", RegexOptions.CultureInvariant);
    private readonly Dictionary<string, AskSparkTool> tools;

    public AskSparkCatalog() : this(Load()) { }
    public AskSparkCatalog(IEnumerable<AskSparkTool> declarations)
    {
        tools = new(StringComparer.Ordinal);
        foreach (var tool in declarations.Append(AskSparkToolSearch.Declaration()).Append(AskSparkProjectNavigation.Declaration()))
        {
            ValidateDeclaration(tool);
            if (!tools.TryAdd(tool.Name, tool)) throw new InvalidDataException("Ask Spark has duplicate tool declarations.");
        }
    }

    public AskSparkTool[] Allowed(SecurityStore security, SecurityUser actor, string? projectId, bool editorAvailable, bool previewActive = false)
        => tools.Values.Where(tool => IsAllowed(tool, security, actor, projectId, editorAvailable, previewActive)).OrderBy(tool => tool.Name, StringComparer.Ordinal).ToArray();

    public AskSparkTool Require(string name, JsonObject arguments, SecurityStore security, SecurityUser actor, string? projectId, bool editorAvailable, bool previewActive = false)
    {
        var tool = RequireAvailable(name, security, actor, projectId, editorAvailable, previewActive);
        AskSparkSchema.Validate(arguments, tool.Parameters);
        // Navigation may address another project; opening its live Designer also requires an explicit grant below.
        if (tool.Name is not ("navigate_workspace" or "spark_open_project") && arguments["projectId"] is JsonValue supplied && supplied.GetValue<string>() != projectId)
            throw new BadHttpRequestException("The tool must use the current project. Open that project before continuing.", 403);
        if (tool.Name == "spark_open_project" && !security.Can(actor, arguments["projectId"]?.GetValue<string>(), "design"))
            throw new BadHttpRequestException("Design permission is required to open this project.", 403);
        return tool;
    }

    public AskSparkTool RequireAvailable(string name, SecurityStore security, SecurityUser actor, string? projectId, bool editorAvailable, bool previewActive = false)
    {
        if (!tools.TryGetValue(name, out var tool) || !IsAllowed(tool, security, actor, projectId, editorAvailable, previewActive))
            throw new BadHttpRequestException("This Ask Spark tool is unavailable in your current context or permissions.", 403);
        return tool;
    }

    private static bool IsAllowed(AskSparkTool tool, SecurityStore security, SecurityUser actor, string? projectId, bool editorAvailable, bool previewActive)
    {
        if (previewActive && (tool.Kind != "read" || tool.Name == "spark_open_project")) return false;
        if (tool.Target == "designer" && (!editorAvailable || projectId is null)) return false;
        // Runtime testing uses a separately authenticated same-account operator session at execution time.
        // Engineering discovery itself also requires design and the exact existing runtime grant.
        if (tool.Permission is "view" or "operate" or "command")
            return projectId is not null && security.Can(actor, projectId, "design") && security.Can(actor, projectId, tool.Permission);
        if (tool.Permission == "signedIn") return security.GetUser(actor.Id)?.Revision == actor.Revision;
        var permission = tool.Permission switch { "admin" => "gatewayAdmin", "read" => "design", _ => tool.Permission };
        return security.Can(actor, projectId, permission);
    }

    private static void ValidateDeclaration(AskSparkTool tool)
    {
        if (!ToolName.IsMatch(tool.Name) || string.IsNullOrWhiteSpace(tool.Description) || tool.Parameters["type"]?.GetValue<string>() != "object")
            throw new InvalidDataException("Ask Spark tool declaration is invalid.");
        if (tool.Kind is not ("read" or "draft" or "write" or "destructive") || tool.Target is not ("designer" or "gateway" or "server"))
            throw new InvalidDataException("Ask Spark tool metadata is invalid.");
        if (tool.Target == "server" && tool.Name != "find_tools") throw new InvalidDataException("Unknown server tool.");
        if (tool.ParallelSafe && tool.Kind != "read") throw new InvalidDataException("Only read tools can run in parallel.");
    }

    private static IEnumerable<AskSparkTool> Load()
    {
        var assembly = typeof(AskSparkCatalog).Assembly;
        foreach (var name in assembly.GetManifestResourceNames().Where(name => name.StartsWith("SparkStudio.AskSpark.", StringComparison.Ordinal) && name.EndsWith(".json", StringComparison.Ordinal)))
        {
            using var stream = assembly.GetManifestResourceStream(name)!;
            foreach (var tool in JsonSerializer.Deserialize<AskSparkTool[]>(stream, Json) ?? []) yield return tool;
        }
    }
}

public static class AskSparkSchema
{
    public static void Validate(JsonObject arguments, JsonObject schema)
    {
        if (arguments.ToJsonString().Length > 65_536) throw new ArgumentException("Tool arguments exceed 64 KiB.");
        ValidateValue(arguments, schema, 0);
    }

    private static void ValidateValue(JsonNode? value, JsonObject schema, int depth)
    {
        if (depth > 16) throw new ArgumentException("Tool arguments are nested too deeply.");
        if (schema["enum"] is JsonArray choices && !choices.Any(choice => JsonNode.DeepEquals(choice, value)))
            throw new ArgumentException("A tool argument is outside its allowed choices.");
        if (value is null && schema["nullable"]?.GetValue<bool>() == true) return;
        if (!MatchesSchema(value, schema["type"])) throw new ArgumentException("A tool argument has the wrong type.");
        if (value is JsonObject obj) ValidateObject(obj, schema, depth);
        if (value is JsonArray array) ValidateArray(array, schema, depth);
        if (value is JsonValue scalar) ValidateScalar(scalar, schema);
    }

    private static bool MatchesSchema(JsonNode? value, JsonNode? type)
        => type is JsonArray union ? union.Any(item => Matches(value, item?.GetValue<string>())) : Matches(value, type?.GetValue<string>());

    private static bool Matches(JsonNode? value, string? type) => type?.ToLowerInvariant() switch
    {
        null => true, "object" => value is JsonObject, "array" => value is JsonArray,
        "string" => value is JsonValue text && text.TryGetValue<string>(out _),
        "boolean" => value is JsonValue flag && flag.TryGetValue<bool>(out _),
        "number" => Number(value, out _),
        "integer" => Number(value, out var number) && Math.Truncate(number) == number,
        "null" => value is null, _ => false
    };

    private static bool Number(JsonNode? value, out double number)
    {
        number = 0;
        return value is JsonValue scalar && scalar.GetValueKind() == JsonValueKind.Number
            && double.TryParse(scalar.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out number) && double.IsFinite(number);
    }

    private static void ValidateObject(JsonObject value, JsonObject schema, int depth)
    {
        if (value.Count > 256) throw new ArgumentException("A tool object has too many properties.");
        foreach (var required in schema["required"] as JsonArray ?? [])
            if (required is not null && !value.ContainsKey(required.GetValue<string>())) throw new ArgumentException("A required tool argument is missing.");
        var properties = schema["properties"] as JsonObject ?? new JsonObject();
        foreach (var property in value)
        {
            if (properties[property.Key] is JsonObject child) ValidateValue(property.Value, child, depth + 1);
            else if (schema["additionalProperties"] is JsonObject extra) ValidateValue(property.Value, extra, depth + 1);
            else if (schema["additionalProperties"] is JsonValue additional && additional.TryGetValue<bool>(out var allowed) && !allowed)
                throw new ArgumentException("An unknown tool argument was supplied.");
        }
    }

    private static void ValidateArray(JsonArray array, JsonObject schema, int depth)
    {
        if (array.Count > 1000 || array.Count > (schema["maxItems"]?.GetValue<int>() ?? 1000)) throw new ArgumentException("A tool array exceeds its allowed size.");
        if (array.Count < (schema["minItems"]?.GetValue<int>() ?? 0)) throw new ArgumentException("A tool array needs more entries.");
        if (schema["items"] is JsonObject item) foreach (var value in array) ValidateValue(value, item, depth + 1);
    }

    private static void ValidateScalar(JsonValue value, JsonObject schema)
    {
        if (value.TryGetValue<string>(out var text)) ValidateText(text, schema);
        if (!Number(value, out var number)) return;
        var minimum = Number(schema["minimum"], out var lower) ? lower : double.NegativeInfinity;
        var maximum = Number(schema["maximum"], out var upper) ? upper : double.PositiveInfinity;
        if (number < minimum || number > maximum)
            throw new ArgumentException("A tool number is outside its allowed range.");
    }

    private static void ValidateText(string text, JsonObject schema)
    {
        if (text.Length > (schema["maxLength"]?.GetValue<int>() ?? 65_536) || text.Length < (schema["minLength"]?.GetValue<int>() ?? 0))
            throw new ArgumentException("A tool string has an invalid length.");
        if (schema["pattern"]?.GetValue<string>() is not { } pattern) return;
        try
        {
            if (!Regex.IsMatch(text, pattern, RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50)))
                throw new ArgumentException("A tool string has an invalid format.");
        }
        catch (RegexMatchTimeoutException) { throw new ArgumentException("A tool string could not be validated within its deadline."); }
    }
}
