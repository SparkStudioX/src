namespace SparkStudio.Gateway;

public static class ModelReadEndpoints
{
    public static void MapModelReadEndpoints(this RouteGroupBuilder routes)
    {
        routes.MapGet("/model/units", () => new { items = ModelFieldContract.Units }).Access("modelRead", "context");
        routes.MapGet("/model/issues", (HttpContext context, SecurityStore security, TagEngine tags, string? path, int? offset, int? limit) =>
            tags.ReadModel(index => index.PrepareIssues(member => GatewayAccess.CanReadTag(context, security, member), path, offset ?? 0, limit ?? 100, CanConfigure(context, security)))).Access("modelRead", "context");
        routes.MapGet("/model/types", (HttpContext context, SecurityStore security, ProjectStore store, string? type, int? offset, int? limit) =>
            store.GetModelReadIndex().Types(path => GatewayAccess.CanReadTag(context, security, path), IncludeEmpty(context), type, offset ?? 0, limit ?? 100, CanConfigure(context, security))).Access("modelRead", "context");
        routes.MapGet("/model/instances", (HttpContext context, SecurityStore security, ProjectStore store, string? type, int? version, string? under, int? offset, int? limit) =>
            store.GetModelReadIndex().Instances(path => GatewayAccess.CanReadTag(context, security, path), type, ValidVersion(version), under, offset ?? 0, limit ?? 100, CanConfigure(context, security))).Access("modelRead", "context");
        routes.MapGet("/model/tree", (HttpContext context, SecurityStore security, TagEngine tags, string? path, int? depth, int? offset, int? limit) =>
            tags.ReadModel(index => index.PrepareTree(member => GatewayAccess.CanReadTag(context, security, member), IncludeEmpty(context), path, depth ?? 1, offset ?? 0, limit ?? 100, CanConfigure(context, security)))).Access("modelRead", "context");
        routes.MapGet("/model/object", (HttpContext context, SecurityStore security, TagEngine tags, string path) =>
            tags.ReadModel(index => index.PrepareObject(path, member => GatewayAccess.CanReadTag(context, security, member), CanConfigure(context, security)))).Access("modelRead", "context");
    }

    private static bool IncludeEmpty(HttpContext context) => !GatewayAccess.IsOperator(context) || GatewayAccess.Actor(context).GatewayAdmin;
    private static bool CanConfigure(HttpContext context, SecurityStore security) => !GatewayAccess.IsOperator(context) && security.Can(GatewayAccess.Actor(context), null, "configuration");
    private static int? ValidVersion(int? version) => version is < 1 or > 1000000 ? throw new ArgumentException("Type version must be from 1 through 1000000.") : version;
}
