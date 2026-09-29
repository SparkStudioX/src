using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>A bounded flat forest shared by saved and query-backed single selections.</summary>
internal static class TreeSelectionValidator
{
    public static void ValidateStatic(JsonArray options)
    {
        var parents = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var option in options.OfType<JsonObject>())
        {
            string? parent = null;
            if (option.ContainsKey("parentValue"))
            {
                if (option["parentValue"] is not JsonValue value || !value.TryGetValue<string>(out parent) || parent.Length > 4096)
                    throw new ArgumentException("A static tree parentValue must be text up to 4096 characters. Omit it or use empty text for a root.");
            }
            parents.Add(option["value"]!.GetValue<string>(), string.IsNullOrEmpty(parent) ? null : parent);
        }
        Validate(parents);
    }

    public static void Validate(IReadOnlyDictionary<string, string?> parents)
    {
        foreach (var key in parents.Keys)
        {
            var visited = new HashSet<string>(StringComparer.Ordinal);
            var current = key;
            var depth = 0;
            while (current is not null)
            {
                if (!parents.TryGetValue(current, out var parent)) throw new ArgumentException("Every tree parent must reference an existing option value.");
                if (!visited.Add(current)) throw new ArgumentException("Tree options cannot contain self links or cycles.");
                if (++depth > 16) throw new ArgumentException("Tree options can contain at most 16 levels, including the root.");
                current = parent;
            }
        }
    }
}
