using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Permission-filtered progressive disclosure of shipped tool definitions.</summary>
public static class AskSparkToolSearch
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly HashSet<string> Core = new(StringComparer.Ordinal)
    {
        "find_tools", "navigate_workspace", "spark_open_project", "projects_list", "gateway_overview",
        "spark_designer_inspect_context", "spark_designer_search", "spark_designer_find_references"
    };
    private static readonly Dictionary<string, string[]> PageCategories = new(StringComparer.Ordinal)
    {
        ["overview"] = ["gateway"], ["diagnostics"] = ["gateway"], ["data"] = ["connections", "sources"],
        ["connections"] = ["connections", "sources"], ["tags"] = ["tags"], ["models"] = ["model"], ["designer"] = ["designer"],
        ["screens"] = ["designer"], ["templates"] = ["designer"], ["queries"] = ["queries"], ["scripts"] = ["scripts"],
        ["projects"] = ["projects"], ["publication"] = ["publication"], ["assets"] = ["assets"],
        ["alarms"] = ["process-data"], ["history"] = ["process-data"], ["process-data"] = ["process-data"],
        ["security"] = ["security"], ["sessions"] = ["security"], ["audit"] = ["security"],
        ["deployment"] = ["deployment"], ["certificates"] = ["deployment"], ["backups"] = ["backups", "recovery"], ["recovery"] = ["recovery"],
        ["commands"] = ["commands"], ["ai"] = []
    };

    public static AskSparkTool Declaration() => new("find_tools",
        "Search the available tool directory by capability, category, or exact tool name. An exact name returns only that tool. Returns complete matching definitions and loads them for the next model round. It never executes the discovered tools. Use * with offset to page through all tools you may use.",
        new JsonObject
        {
            ["type"] = "object", ["properties"] = new JsonObject
            {
                ["query"] = new JsonObject { ["type"] = "string", ["minLength"] = 1, ["maxLength"] = 256 },
                ["offset"] = new JsonObject { ["type"] = "integer", ["minimum"] = 0, ["maximum"] = 10000 },
                ["limit"] = new JsonObject { ["type"] = "integer", ["minimum"] = 1, ["maximum"] = 8 }
            },
            ["required"] = new JsonArray("query"), ["additionalProperties"] = false
        }, "core", "read", "server", "signedIn", false, true);

    public static AskSparkTool[] LoadForRound(AskSparkConversation conversation, IReadOnlyList<AskSparkTool> allowed)
    {
        var section = conversation.ToolContext["section"]?.GetValue<string>() ?? "";
        var categories = PageCategories.GetValueOrDefault(section, []);
        var loaded = conversation.LoadedTools.ToHashSet(StringComparer.Ordinal);
        foreach (var tool in allowed)
            if (Core.Contains(tool.Name) || tool.Category == "core" || categories.Contains(tool.Category, StringComparer.Ordinal)) loaded.Add(tool.Name);
        var result = allowed.Where(tool => loaded.Contains(tool.Name)).ToArray();
        conversation.LoadedTools = result.Select(tool => tool.Name).ToArray();
        return result;
    }

    public static string Directory(IReadOnlyList<AskSparkTool> allowed)
        => "Available tools (directory only; call find_tools to load complete definitions before using a tool not currently declared):\n"
            + string.Join('\n', allowed.Select(tool => tool.Name + " [" + tool.Category + "] — " + Summary(tool.Description)));

    public static string Scope(SecurityUser actor, AskSparkConversation conversation)
    {
        var canonical = new JsonObject
        {
            ["actorId"] = actor.Id, ["actorRevision"] = actor.Revision, ["projectId"] = conversation.ProjectId,
            ["surface"] = conversation.ToolContext["surface"]?.DeepClone(), ["section"] = conversation.ToolContext["section"]?.DeepClone(),
            ["editorAvailable"] = conversation.ToolContext["editorAvailable"]?.DeepClone(),
            ["previewActive"] = conversation.ToolContext["previewActive"]?.DeepClone()
        };
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToJsonString())));
    }

    public static JsonObject Find(JsonObject arguments, AskSparkConversation conversation, IReadOnlyList<AskSparkTool> allowed)
    {
        AskSparkSchema.Validate(arguments, Declaration().Parameters);
        var query = arguments["query"]!.GetValue<string>().Trim();
        if (query.Length == 0) throw new ArgumentException("Enter a capability, category, or tool name to find.");
        var terms = Words(query);
        var exact = allowed.FirstOrDefault(tool => string.Equals(tool.Name, query, StringComparison.OrdinalIgnoreCase));
        IEnumerable<AskSparkTool> candidates = exact is null ? allowed : [exact];
        var matches = candidates.Select(tool => (Tool: tool, Score: Score(tool, query, terms)))
            .Where(item => item.Score > 0).OrderByDescending(item => item.Score).ThenBy(item => item.Tool.Name, StringComparer.Ordinal).ToArray();
        var offset = arguments["offset"]?.GetValue<int>() ?? 0;
        var limit = arguments["limit"]?.GetValue<int>() ?? 6;
        var definitions = new JsonArray();
        var loaded = conversation.LoadedTools.ToHashSet(StringComparer.Ordinal);
        var bytes = 0;
        foreach (var match in matches.Skip(offset).Take(limit))
        {
            var definition = JsonSerializer.SerializeToNode(match.Tool, Json)!;
            var size = Encoding.UTF8.GetByteCount(definition.ToJsonString());
            if (bytes + size > 220_000) break;
            bytes += size;
            definitions.Add(definition);
            loaded.Add(match.Tool.Name);
        }
        conversation.LoadedTools = loaded.Order(StringComparer.Ordinal).ToArray();
        var next = offset + definitions.Count;
        return new JsonObject
        {
            ["tools"] = definitions, ["total"] = matches.Length, ["offset"] = offset,
            ["nextOffset"] = next < matches.Length ? JsonValue.Create(next) : null,
            ["availableFrom"] = "next model round",
            ["notice"] = definitions.Count == 0 && next < matches.Length
                ? "A matching definition exceeds the response bound; narrow the search. No definition was truncated or loaded."
                : "Definitions are complete. These tools still enforce the current project, permissions, revisions, and approvals."
        };
    }

    private static int Score(AskSparkTool tool, string query, string[] terms)
    {
        if (query == "*" || string.Equals(tool.Name, query, StringComparison.OrdinalIgnoreCase)) return 1000;
        if (terms.Length == 0) return 0;
        var name = OneLine(tool.Name.Replace('_', ' '));
        var text = tool.Category + " " + name + " " + tool.Description;
        return terms.Sum(term => name.Contains(term, StringComparison.OrdinalIgnoreCase) ? 20
            : tool.Category.Contains(term, StringComparison.OrdinalIgnoreCase) ? 10 : text.Contains(term, StringComparison.OrdinalIgnoreCase) ? 1 : 0);
    }

    private static string[] Words(string query) => Regex.Split(query, @"[^\p{L}\p{N}]+", RegexOptions.CultureInvariant)
        .Where(term => term.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).Take(32).ToArray();
    private static string Summary(string description)
    {
        var line = OneLine(description);
        var sentenceEnd = line.IndexOf(". ", StringComparison.Ordinal);
        if (sentenceEnd >= 0) line = line[..(sentenceEnd + 1)];
        return line.Length <= 240 ? line : line[..239] + "…";
    }
    private static string OneLine(string text) => string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
}
