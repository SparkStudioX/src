using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public sealed partial class ProjectStore
{
    public JsonObject ValidateAuthoringProject(JsonObject candidate)
    {
        lock (gate)
        {
            ProjectTemplates.ValidateStructure(candidate);
            ComponentQueryBindingValidator.ValidateQueries(candidate, queries);
            if (candidate["revision"]?.GetValue<int>() != project["revision"]?.GetValue<int>())
                throw new InvalidOperationException("The saved project changed. Reload before applying this draft.");
            return new() { ["valid"] = true, ["revision"] = project["revision"]?.DeepClone() };
        }
    }

    private JsonObject? FindReviewQuery(string id) => queries.OfType<JsonObject>().FirstOrDefault(item => Optional(item, "id") == id);
    private static string QueryFingerprint(JsonObject? query) => query is null ? "missing"
        : Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(query.ToJsonString()))).ToLowerInvariant();

    public JsonObject ReviewQuery(string id)
    {
        lock (gate)
        {
            var query = FindReviewQuery(id);
            return new() { ["query"] = query?.DeepClone(), ["fingerprint"] = QueryFingerprint(query) };
        }
    }

    public JsonObject SaveReviewedQuery(string id, JsonObject query, string expectedFingerprint)
    {
        lock (gate)
        {
            RequireQueryFingerprint(id, expectedFingerprint);
            return SaveQuery(id, query);
        }
    }

    public void DeleteReviewedQuery(string id, string expectedFingerprint)
    {
        lock (gate)
        {
            RequireQueryFingerprint(id, expectedFingerprint);
            var existing = FindReviewQuery(id) ?? throw new KeyNotFoundException("Named query not found.");
            var next = (JsonArray)queries.DeepClone();
            next.Remove(next.OfType<JsonObject>().Single(item => Optional(item, "id") == Optional(existing, "id")));
            ComponentQueryBindingValidator.ValidateQueries(project, next);
            Persist("queries.json", next);
            queries = next;
        }
    }

    private void RequireQueryFingerprint(string id, string expectedFingerprint)
    {
        if (string.IsNullOrEmpty(expectedFingerprint) || QueryFingerprint(FindReviewQuery(id)) != expectedFingerprint)
            throw new InvalidOperationException("The named query changed. Review it again before applying this change.");
    }
}

public sealed record ReviewedQueryRequest(JsonObject Query, string ExpectedFingerprint);

public static class ProjectAuthoringReviewEndpoints
{
    public static void MapProjectAuthoringReview(this RouteGroupBuilder routes)
    {
        routes.MapPost("/project/validate", (JsonObject project, ProjectStore store) => store.ValidateAuthoringProject(project)).Access("design");
        routes.MapGet("/queries/{id}/review", (string id, ProjectStore store) => store.ReviewQuery(id)).Access("design");
        routes.MapPut("/queries/{id}/reviewed", (string id, ReviewedQueryRequest request, ProjectStore store, ScriptResourceStore scripts, HttpContext context) =>
        {
            var saved = store.SaveReviewedQuery(id, request.Query, request.ExpectedFingerprint);
            scripts.NotifyUpdate(ScriptProjectUpdates.Resource(GatewayAccess.Actor(context).Username, "query", id, request.ExpectedFingerprint == "missing"));
            return saved;
        }).Access("design", audit: true);
        routes.MapDelete("/queries/{id}/reviewed", (string id, string expectedFingerprint, ProjectStore store) =>
        {
            store.DeleteReviewedQuery(id, expectedFingerprint);
            return Results.NoContent();
        }).Access("design", audit: true);
    }
}
