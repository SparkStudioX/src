using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Update events expose resource identities, never source code or credentials.</summary>
public static class ScriptProjectUpdates
{
    public static ScriptUpdateNotice Project(string actor, JsonObject before, JsonObject after)
    {
        var added = new JsonArray(); var removed = new JsonArray(); var modified = new JsonArray();
        foreach (var kind in new[] { "screens", "templates" })
        {
            var prior = Items(before, kind); var next = Items(after, kind);
            foreach (var (id, item) in next)
            {
                if (!prior.TryGetValue(id, out var old)) added.Add(Identity(kind, id, item));
                else if (!JsonNode.DeepEquals(old, item)) modified.Add(Identity(kind, id, item));
            }
            foreach (var (id, item) in prior.Where(item => !next.ContainsKey(item.Key))) removed.Add(Identity(kind, id, item));
        }
        var oldManifest = before.DeepClone().AsObject(); var newManifest = after.DeepClone().AsObject();
        foreach (var key in new[] { "screens", "templates", "revision" }) { oldManifest.Remove(key); newManifest.Remove(key); }
        return new(actor, new JsonObject { ["added"] = added, ["removed"] = removed, ["modified"] = modified,
            ["manifestChanged"] = !JsonNode.DeepEquals(oldManifest, newManifest) }, "projectSaved");
    }

    public static ScriptUpdateNotice Resource(string actor, string kind, string id, bool added, string reason = "resourceSaved")
        => new(actor, new JsonObject { ["added"] = added ? new JsonArray(Identity(kind, id, null)) : new JsonArray(),
            ["removed"] = new JsonArray(), ["modified"] = added ? new JsonArray() : new JsonArray(Identity(kind, id, null)),
            ["manifestChanged"] = false }, reason);

    private static JsonObject Identity(string kind, string id, JsonObject? resource) => new()
        { ["type"] = kind, ["id"] = id, ["name"] = resource?["name"]?.DeepClone() ?? JsonValue.Create(id) };
    private static Dictionary<string, JsonObject> Items(JsonObject project, string key) =>
        (project[key] as JsonArray)?.OfType<JsonObject>().ToDictionary(item => ProjectStore.Required(item, "id"), StringComparer.Ordinal) ?? new();
}
