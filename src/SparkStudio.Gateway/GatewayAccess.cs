using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>Every application API declares an audience and capability; unknown APIs fail closed.</summary>
public sealed record GatewayAccessRequirement(string Permission, string Audience = "engineering", bool Audit = false);

public static class GatewayAccess
{
    private static readonly string[] ApplicationAliases = ["/api/project", "/api/queries", "/api/scripts", "/api/assets", "/api/runtime", "/api/preview"];
    private static readonly System.Text.Json.JsonSerializerOptions PermissionJson = new(System.Text.Json.JsonSerializerDefaults.Web);
    private const string ActorKey = "spark.actor";
    private const string ProjectKey = "spark.project";
    private const string AudienceKey = "spark.audience";

    public static T Access<T>(this T endpoint, string permission, string audience = "engineering", bool audit = false)
        where T : IEndpointConventionBuilder
    {
        endpoint.WithMetadata(new GatewayAccessRequirement(permission, audience, audit));
        return endpoint;
    }

    public static void UseApplicationAccess(this WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            if (!context.Request.Path.StartsWithSegments("/api")) { await next(); return; }
            context.Response.Headers.CacheControl = "no-store";
            var endpoint = context.GetEndpoint();
            // These concrete endpoints own bootstrap/login/admin policy internally.
            var route = (endpoint as RouteEndpoint)?.RoutePattern.RawText;
            // Readiness exposes only the local process startup result; it owns a raw-peer
            // loopback check and does not grant access to health, accounts or project APIs.
            if (route == "/api/ready" && HttpMethods.IsGet(context.Request.Method))
            { await next(); return; }
            if (route?.StartsWith("/api/auth/", StringComparison.Ordinal) == true ||
                route?.StartsWith("/api/security/", StringComparison.Ordinal) == true)
            { await next(); return; }
            if (!GatewaySecurity.IsSecureTransport(context))
            { await Reject(context, 403, "Use HTTPS to access this gateway from another computer."); return; }
            var policy = endpoint?.Metadata.GetMetadata<GatewayAccessRequirement>();
            if (policy is null) { await Reject(context, 404, "API endpoint not found."); return; }
            var audience = policy.Audience == "context" ? Audience(context) : policy.Audience;
            if (audience is not ("engineering" or "operator"))
            { await Reject(context, 400, "Choose an engineering or operator session."); return; }
            var store = context.RequestServices.GetRequiredService<SecurityStore>();
            var actor = await GatewaySecurity.AuthenticateAsync(context, audience);
            if (actor is null) { await Reject(context, 401, "Sign in to continue."); return; }
            RequireExpectedUser(context, actor);
            var catalog = context.RequestServices.GetRequiredService<ProjectCatalog>();
            // Legacy application aliases always resolve the default project in DI.
            // A routing header must never authorize another project's grant for them.
            var alias = route is not null && ApplicationAliases
                .Any(prefix => route == prefix || route.StartsWith(prefix + "/", StringComparison.Ordinal));
            var projectId = context.Request.RouteValues["projectId"]?.ToString()
                ?? (alias ? catalog.DefaultId : context.Request.Headers["X-SPARK-PROJECT"].FirstOrDefault()
                    ?? context.Request.Query["projectId"].FirstOrDefault() ?? catalog.DefaultId);
            context.Items[ActorKey] = actor;
            context.Items[ProjectKey] = projectId;
            context.Items[AudienceKey] = audience;
            var permissions = store.GetPermissions(actor, projectId);
            // Gateway model authoring does not require a project. Explicit project routes
            // and all operator reads retain their existing project grants and tag scopes.
            var sharedModelConfiguration = policy.Permission == "modelRead" && audience == "engineering"
                && !context.Request.RouteValues.ContainsKey("projectId") && store.Can(actor, null, "configuration");
            var permitted = policy.Permission switch
            {
                "signedIn" => true,
                "admin" => audience == "engineering" && permissions.GatewayAdmin,
                "gateway" or "diagnostics" or "configuration" or "backups" or "audit" or "sessions" => audience == "engineering" && store.Can(actor, null, policy.Permission),
                "design" => audience == "engineering" && permissions.Design,
                "publish" => audience == "engineering" && permissions.Design && permissions.Publish,
                "view" => audience == "operator" && permissions.View,
                "operate" => audience == "operator" && permissions.Operate,
                "command" => audience == "operator" && permissions.Commands && permissions.Operate && permissions.View,
                "read" => audience == "operator" ? permissions.View : permissions.Design,
                "modelRead" => sharedModelConfiguration || (audience == "operator" ? permissions.View : permissions.Design),
                _ => false,
            };
            if (!permitted)
            {
                var denialAction = $"denied {context.Request.Method} {route}";
                store.Audit(actor, AuditAction(denialAction), projectId, "denied", resource: Resource(context));
                await Reject(context, 403, "Your account does not have permission for this operation."); return;
            }
            if (!sharedModelConfiguration && policy.Permission is "design" or "publish" or "read" or "modelRead" or "view" or "operate" or "command"
                && route?.EndsWith("/export", StringComparison.Ordinal) != true)
                catalog.Get(projectId);
            if (!HttpMethods.IsGet(context.Request.Method) && !HttpMethods.IsHead(context.Request.Method))
                GatewaySecurity.RequireCsrf(context);
            var sessionValid = GatewaySecurity.CaptureSessionValidator(context);
            bool TagAllowed(string path, bool write)
            {
                if (!sessionValid() || !store.Can(actor, projectId, write ? "operate" : "view")) return false;
                if (actor.GatewayAdmin) return true;
                return store.CanReadProjectTag(projectId, path);
            }
            using var scriptAuthority = PythonExecutionAccess.Enter(audience == "operator"
                ? new PythonExecutionAccess(path => TagAllowed(path, false), path => TagAllowed(path, true)) : null);
            // Do not cache authenticated assets or project data after sign-out.
            if (!policy.Audit) { await next(); return; }
            var auditAction = AuditAction(context.Request.Method + " " + route);
            // Persist an attempt before allowing a side effect. A failed final append
            // cannot make the entire operation disappear from the local trail.
            store.Audit(actor, auditAction, projectId, "Started", resource: Resource(context));
            try
            {
                await next();
                store.Audit(actor, auditAction, projectId,
                    context.Items["spark.actionOutcome"]?.ToString() ?? $"HTTP {context.Response.StatusCode}", resource: Resource(context));
            }
            catch (Exception exception)
            {
                store.Audit(actor, auditAction, projectId,
                    exception is OperationCanceledException ? "Cancelled" : "Failed", resource: Resource(context));
                throw;
            }
        });
    }

    // Retain both the operation prefix and route suffix so long component API
    // routes still distinguish review from execution. Resource carries the path.
    internal static string AuditAction(string action) => action.Length <= 100 ? action : action[..64] + "..." + action[^33..];

    private static string Audience(HttpContext context) =>
        context.Request.Headers["X-SPARK-AUDIENCE"].FirstOrDefault()
        ?? context.Request.Query["audience"].FirstOrDefault() ?? "engineering";

    private static string Resource(HttpContext context)
    {
        var path = context.Request.Path.Value ?? "/";
        return path[..Math.Min(path.Length, 512)];
    }

    public static SecurityUser Actor(HttpContext context) => (SecurityUser)context.Items[ActorKey]!;
    /// <summary>An optional identity fence only restricts an already authenticated request; it never authenticates or grants access.</summary>
    public static void RequireExpectedUser(HttpContext context, SecurityUser? actor)
    {
        if (!context.Request.Headers.TryGetValue("X-SPARK-EXPECTED-USER", out var expected)) return;
        if (expected.Count != 1 || string.IsNullOrEmpty(expected[0]) || actor is null || !string.Equals(expected[0], actor.Id, StringComparison.Ordinal))
            throw new BadHttpRequestException("The operator account changed. Sign in with the engineering account before runtime testing.", 403);
    }
    public static string ProjectId(HttpContext context) => (string)context.Items[ProjectKey]!;
    public static bool IsOperator(HttpContext context) => context.Items[AudienceKey]?.ToString() == "operator";

    public static object Catalog(HttpContext context, ProjectCatalog catalog, SecurityStore security)
    {
        var actor = Actor(context);
        var operation = IsOperator(context);
        var projects = catalog.List(includeArchived: !operation && actor.GatewayAdmin).OfType<JsonObject>()
            .Where(project => operation ? security.GetPermissions(actor, project["id"]!.GetValue<string>()).View
                : security.GetPermissions(actor, project["id"]!.GetValue<string>()).Design)
            .Select(project =>
            {
                var item = project.DeepClone().AsObject();
                item["permissions"] = System.Text.Json.JsonSerializer.SerializeToNode(
                    security.GetPermissions(actor, item["id"]!.GetValue<string>()), PermissionJson);
                return item;
            }).ToArray();
        // An inaccessible default ID is never a redirect into an unauthorized project.
        return new { defaultProjectId = projects.Any(project => project["id"]!.GetValue<string>() == catalog.DefaultId)
            ? catalog.DefaultId : projects.FirstOrDefault()?["id"]?.GetValue<string>(), projects };
    }

    public static bool SessionStillAllowed(HttpContext context, SecurityStore security)
    {
        if (!GatewaySecurity.SessionStillValid(context)) return false;
        var actor = Actor(context);
        try { context.RequestServices.GetRequiredService<ProjectCatalog>().Get(ProjectId(context)); }
        catch (KeyNotFoundException) { return false; }
        var current = security.GetUser(actor.Id);
        if (current is null || current.Disabled || current.Revision != actor.Revision) return false;
        var permissions = security.GetPermissions(current, ProjectId(context));
        return IsOperator(context) ? permissions.View : permissions.Design;
    }

    public static bool CanReadTag(HttpContext context, SecurityStore security, string path)
    {
        if (!IsOperator(context) || Actor(context).GatewayAdmin) return true;
        return security.CanReadProjectTag(ProjectId(context), path);
    }

    public static TagValue[] Tags(HttpContext context, SecurityStore security, TagValue[] values) =>
        values.Where(tag => CanReadTag(context, security, tag.Path)).ToArray();

    public static void RequireAdmin(HttpContext context)
    {
        if (IsOperator(context) || !Actor(context).GatewayAdmin)
            throw new BadHttpRequestException("Gateway administrator permission is required for this operation.", 403);
    }

    private static async Task Reject(HttpContext context, int status, string message)
    {
        context.Response.StatusCode = status;
        await context.Response.WriteAsJsonAsync(new { error = message });
    }
}
