using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public sealed partial class PublicationStore
{
    internal const string LegacyScopeWarning = "Legacy snapshot: Python libraries and gateway/browser scripts were published separately and are not included. Restoring it preserves the currently active script resources; review their compatibility before restoring.";

    private JsonArray PublicationWarnings()
    {
        var warnings = HistoryWarnings();
        if (publication is not null && (publication["scripts"] is not JsonObject || publication["legacyScriptCompatibility"]?.GetValue<bool>() == true)) warnings.Add(LegacyScopeWarning);
        return warnings;
    }

    /// <summary>The review fingerprint guards queries as well as both independently saved draft revisions.</summary>
    public JsonObject Review(ProjectStore store)
    {
        lock (gate)
        {
            var project = store.GetProject();
            var snapshot = store.CapturePublication(project["revision"]!.GetValue<int>());
            var resources = scripts?.GetDraft() ?? new JsonObject { ["revision"] = 0, ["resources"] = new JsonArray() };
            snapshot["scripts"] = resources;
            snapshot["expectedPublishedAt"] = publication?["publishedAt"]?.DeepClone();
            return new JsonObject {
                ["reviewToken"] = SnapshotHash(snapshot), ["revision"] = project["revision"]!.DeepClone(),
                ["requiresScriptApproval"] = ExecutablePublication.Changed(publication, snapshot),
                ["scriptsRevision"] = resources["revision"]!.DeepClone(), ["name"] = project["name"]!.DeepClone(),
                ["screens"] = project["screens"]!.AsArray().Count, ["templates"] = (project["templates"] as JsonArray)?.Count ?? 0,
                ["queries"] = snapshot["queries"]!.AsArray().Count,
                ["resources"] = new JsonArray(ScriptResourceStore.Resources(resources).Select(resource => (JsonNode)new JsonObject {
                    ["name"] = resource["name"]!.DeepClone(), ["type"] = resource["type"]!.DeepClone(),
                    ["enabled"] = resource["enabled"]!.DeepClone(), ["event"] = resource["event"]?.DeepClone()
                }).ToArray()), ["warnings"] = PublicationWarnings()
            };
        }
    }

    // ScriptResourceStore falls back to the old independent publication only for legacy files.
    internal JsonObject? CaptureScripts()
    {
        lock (gate)
        {
            if (publication?["scripts"] is not JsonObject resources) return null;
            var snapshot = resources.DeepClone().AsObject();
            snapshot["publishedAt"] = publication["publishedAt"]!.DeepClone();
            snapshot["queries"] = (publication["scriptQueries"] ?? publication["queries"])!.DeepClone();
            return snapshot;
        }
    }

    private JsonObject CaptureLibraries(JsonObject current)
    {
        var libraries = current["scripts"] is JsonObject resources ? ScriptLibrary.Capture(resources) : scripts?.CaptureLibraries() ?? new Dictionary<string, string>();
        return new JsonObject(libraries.Select(pair => new KeyValuePair<string, JsonNode?>(pair.Key, JsonValue.Create(pair.Value))));
    }

    public JsonObject GetClientResources(string? publishedAt)
    {
        lock (gate)
        {
            RequirePublication(publishedAt);
            var result = scripts?.GetClientResources() ?? new JsonObject { ["revision"] = 0, ["resources"] = new JsonArray() };
            // Even legacy browser resources are pinned to the operator application's stamp.
            result["applicationPublishedAt"] = publication!["publishedAt"]!.DeepClone();
            return result;
        }
    }
}
