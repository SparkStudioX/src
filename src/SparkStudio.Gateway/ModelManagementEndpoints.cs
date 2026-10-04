using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public sealed record ModelVersionCompareRequest(JsonObject Definition, int? FromVersion = null, JsonObject[]? Definitions = null);

public static class ModelManagementEndpoints
{
    public static void MapModelManagementEndpoints(this RouteGroupBuilder routes)
    {
        routes.MapGet("/model/starters", () => new { items = ModelStarters.Items() }).Access("configuration");
        routes.MapPost("/model/versions/compare", (ModelVersionCompareRequest request, ProjectStore store, ProjectCatalog catalog, HttpContext context, SecurityStore security) =>
            Compare(request, store, catalog, context, security)).Access("configuration");
        routes.MapGet("/model/dependencies", (ProjectStore store, ProjectCatalog catalog, HttpContext context, SecurityStore security, string? type, string? instance, string? query) =>
            ModelDependencies.Build(store.ExportTags(), store.GetTagDefinitions(), store.GetConnections(), Documents(catalog, context, security), type, instance, query)).Access("configuration");
        routes.MapPost("/model/export", (ModelExportSelection request, ProjectStore store) =>
            ModelSelectiveExport.Export(store.ExportTags(), store.GetTagDefinitions(), request)).Access("configuration");
    }
    private static ModelDependencyDocument[] Documents(ProjectCatalog catalog, HttpContext context, SecurityStore security) =>
        ModelDependencies.Documents(catalog, id => security.Can(GatewayAccess.Actor(context), id, "design"));
    private static ModelVersionImpact Compare(ModelVersionCompareRequest request, ProjectStore store, ProjectCatalog catalog, HttpContext context, SecurityStore security)
    {
        if (request.Definition is null) throw new ArgumentException("Choose a proposed model definition.");
        var model = store.ExportTags(); var impact = ModelVersionComparison.Compare(model, request.Definition, request.FromVersion, request.Definitions);
        var paths = impact.Usage.Select(item => item.Path).ToArray();
        var projects = Documents(catalog, context, security).Where(document => ModelDependencies.Strings(document.Content).Any(text => paths.Any(path => text.Contains(path, StringComparison.Ordinal))))
            .Select(document => document.ProjectId).Distinct(StringComparer.Ordinal)
            .Select(id => new ModelAffectedProject(id, ModelMappingProfiles.Text(catalog.Describe(id), "name"))).ToArray();
        return impact with { AffectedProjects = projects };
    }
}
