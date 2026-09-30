using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

if (GatewayRecoveryCli.IsRequested(args))
{
    Environment.ExitCode = await GatewayRecoveryCli.RunAsync(args);
    return;
}
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddWindowsService(options => options.ServiceName = "SparkStudio");
builder.Logging.ClearProviders().AddConsole();
builder.WebHost.ConfigureKestrel(options =>
{
    options.Limits.MaxRequestBodySize = 1_048_576;
    GatewayReadiness.ConfigureTransport(options);
});
builder.Services.ConfigureHttpJsonOptions(options => options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);
var dataDir = Path.GetFullPath(Environment.GetEnvironmentVariable("SPARKSTUDIO_DATA_DIR") ?? builder.Configuration["DataDirectory"] ?? Path.Combine(AppContext.BaseDirectory, "data"));
Directory.CreateDirectory(dataDir);
using var dataLease = DataDirectoryLease.Acquire(dataDir);
var recovery = new RecoveryQuarantine(dataDir);
builder.Services.AddSingleton(recovery);
DeploymentSettings.Configure(builder, dataDir, recovery.Active ? "Gateway recovery quarantine" : null);
recovery.ConfigureIsolation(builder);
var protection = builder.Services.AddDataProtection().SetApplicationName("SparkStudio").PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(dataDir, "keys")));
if (OperatingSystem.IsWindows()) protection.ProtectKeysWithDpapi();
builder.Services.AddGatewaySecurity(dataDir);
builder.Services.AddSingleton<GatewayReadiness>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<GatewayReadiness>());
builder.Services.AddSingleton(new GatewayDeployment(builder.Configuration, builder.Environment, dataDir));
builder.Services.AddSingleton(new GatewayObservations(dataDir));
builder.Services.AddSingleton<PreviewSessions>();
builder.Services.AddSingleton<RuntimeSessionMessaging>();
builder.Services.AddSingleton(sp => new ProjectCatalog(dataDir, sp.GetRequiredService<IDataProtectionProvider>()));
builder.Services.AddSingleton(_ => new ConnectorService(dataDir, recovery.EnsureOperationsAllowed));
builder.Services.AddSingleton(sp => new TagEngine(sp.GetRequiredService<ProjectCatalog>().GatewayStore,
    sp.GetRequiredService<ConnectorService>(), sp.GetRequiredService<ILogger<TagEngine>>(), recovery));
builder.Services.AddHostedService(sp => sp.GetRequiredService<TagEngine>());
builder.Services.AddSingleton<ProjectRuntimeRegistry>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<ProjectRuntimeRegistry>());
builder.Services.AddSingleton(sp => new GatewayBackups(dataDir, sp.GetRequiredService<IDataProtectionProvider>(), recovery,
    sp.GetRequiredService<SecurityStore>(), sp.GetRequiredService<IHostApplicationLifetime>()));
builder.Services.AddHostedService(sp => sp.GetRequiredService<GatewayBackups>());
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped(sp => sp.GetRequiredService<ProjectRuntimeRegistry>().Get(
    sp.GetRequiredService<IHttpContextAccessor>().HttpContext?.Request.RouteValues["projectId"]?.ToString()
        ?? sp.GetRequiredService<ProjectCatalog>().DefaultId));
builder.Services.AddScoped(sp => sp.GetRequiredService<ProjectRuntime>().Workspace.Store);
builder.Services.AddScoped(sp => sp.GetRequiredService<ProjectRuntime>().Workspace.Assets);
builder.Services.AddScoped(sp => sp.GetRequiredService<ProjectRuntime>().Workspace.Publication);
builder.Services.AddScoped(sp => sp.GetRequiredService<ProjectRuntime>().Workspace.Scripts);
builder.Services.AddScoped(sp => sp.GetRequiredService<ProjectRuntime>().Queries);
builder.Services.AddScoped(sp => sp.GetRequiredService<ProjectRuntime>().Python);
builder.Services.AddScoped(sp => sp.GetRequiredService<ProjectRuntime>().Actions);
var app = builder.Build();

app.Use(async (context, next) =>
{
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["Referrer-Policy"] = "same-origin";
    if (context.Request.Path.StartsWithSegments("/api") && context.Request.Headers.Origin.FirstOrDefault() is { } origin)
    {
        var expected = $"{context.Request.Scheme}://{context.Request.Host}";
        var development = app.Environment.IsDevelopment() && origin is "http://localhost:5173" or "http://127.0.0.1:5173";
        if (!string.Equals(origin, expected, StringComparison.OrdinalIgnoreCase) && !development)
        { context.Response.StatusCode = 403; await context.Response.WriteAsJsonAsync(new { error = "Cross-origin API requests are not allowed." }); return; }
    }
    try { await next(); }
    catch (Exception ex) when (!context.Response.HasStarted && ex is not OperationCanceledException)
    {
        context.Response.StatusCode = ex switch { BadHttpRequestException bad => bad.StatusCode, UnauthorizedAccessException => 403, KeyNotFoundException => 404, ArgumentException or JsonException or FormatException => 400, InvalidOperationException => 409, ReadQueryTimeoutException => 504, _ => 502 };
        await context.Response.WriteAsJsonAsync(new { error = ex.Message });
    }
});
app.UseRouting();
app.UseGatewayObservations();
app.UseApplicationAccess();
app.Use(async (context, next) =>
{
    if (recovery.Active && GatewayAccess.IsOperator(context))
    {
        context.Response.StatusCode = 503;
        await context.Response.WriteAsJsonAsync(new { error = "This restored gateway is in recovery mode. An administrator must review it before operator applications can run." });
        return;
    }
    await next();
});
app.UsePreviewCommunication();
app.MapGatewaySecurityEndpoints();
app.MapGatewayConsoleEndpoints();
app.MapGatewayDeploymentEndpoints();
app.MapDeploymentSettingsEndpoints();
app.MapGatewayRecoveryEndpoints();
app.MapGatewayBackupEndpoints();
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapGet("/api/ready", GatewayReadiness.Respond);
app.MapGet("/api/projects", (HttpContext context, ProjectCatalog catalog, SecurityStore security) => GatewayAccess.Catalog(context, catalog, security)).Access("signedIn", "context");
app.MapPost("/api/projects", (CreateProjectRequest request, ProjectCatalog catalog) => catalog.Describe(catalog.Create(request.Name).Id)).Access("admin", audit: true);
app.MapPatch("/api/projects/{projectId}", (string projectId, RenameProjectRequest request, ProjectCatalog catalog) => catalog.Rename(projectId, request.Name, request.Revision)).Access("admin", audit: true);
app.MapPost("/api/projects/{projectId}/duplicate", (string projectId, CreateProjectRequest request, ProjectCatalog catalog) => catalog.Describe(catalog.Duplicate(projectId, request.Name).Id)).Access("admin", audit: true);
app.MapPost("/api/projects/{projectId}/archive", (string projectId, ArchiveProjectRequest request, ProjectRuntimeRegistry runtimes)
    => runtimes.SetArchivedAsync(projectId, request.Archived)).Access("admin", audit: true);
app.MapGet("/api/projects/{projectId}/export", (string projectId, ProjectCatalog catalog) =>
    Results.File(SparkProjectPackage.Export(catalog.Get(projectId, includeArchived: true)), "application/zip", projectId + ".sparkproj")).Access("design", audit: true);
app.MapPost("/api/projects/import", async (HttpContext context, ProjectCatalog catalog) =>
{
    const long limit = 32 * 1024 * 1024;
    var size = context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
    if (size is { IsReadOnly: false }) size.MaxRequestBodySize = limit;
    if (context.Request.ContentLength > limit) throw new BadHttpRequestException("Project packages are limited to 32 MiB.", 413);
    using var data = new MemoryStream();
    var buffer = new byte[81920];
    int count;
    while ((count = await context.Request.Body.ReadAsync(buffer, context.RequestAborted)) > 0)
    {
        if (data.Length + count > limit) throw new BadHttpRequestException("Project packages are limited to 32 MiB.", 413);
        await data.WriteAsync(buffer.AsMemory(0, count), context.RequestAborted);
    }
    return catalog.Describe(SparkProjectPackage.Import(catalog, data.ToArray(), context.Request.Query["name"].FirstOrDefault()).Id);
}).Access("admin", audit: true);
MapProjectEndpoints(app.MapGroup("/api"));
var projectRoutes = app.MapGroup("/api/projects/{projectId}");
projectRoutes.AddEndpointFilter(async (context, next) =>
{
    context.HttpContext.RequestServices.GetRequiredService<ProjectCatalog>()
        .Get(context.HttpContext.Request.RouteValues["projectId"]!.ToString()!);
    return await next(context);
});
MapProjectEndpoints(projectRoutes);
app.MapFallbackToFile("index.html");
app.Run();

static void MapProjectEndpoints(RouteGroupBuilder routes)
{
routes.MapTagEngineeringEndpoints();
routes.MapPreviewEndpoints();
routes.MapPythonComponentEventEndpoints();
routes.MapRuntimeSessionMessageEndpoints();
routes.MapGet("/health", (PythonRunner python) => new { status = "ok", version = typeof(PythonRunner).Assembly
    .GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false)
    .OfType<System.Reflection.AssemblyInformationalVersionAttribute>().FirstOrDefault()?.InformationalVersion ?? "unknown",
    pythonAvailable = python.Available, demoMode = true, deployment = "local-development" }).Access("signedIn", "context");
routes.MapGet("/project", (ProjectStore store) => store.GetProject()).Access("design");
routes.MapGet("/assets", (LocalAssetStore assets) => assets.List()).Access("design");
routes.MapPost("/assets", (AssetUpload upload, LocalAssetStore assets, ScriptResourceStore scripts, HttpContext context) =>
{
    var prior = assets.List().Select(item => item.Id).ToHashSet(StringComparer.Ordinal);
    var saved = assets.Add(upload);
    if (!prior.Contains(saved.Id)) scripts.NotifyUpdate(ScriptProjectUpdates.Resource(GatewayAccess.Actor(context).Username, "asset", saved.Id, true));
    return saved;
}).Access("design", audit: true);
routes.MapGet("/assets/{**id}", (string id, HttpContext context, LocalAssetStore assets) =>
{
    var asset = assets.Read(id);
    context.Response.Headers.CacheControl = "private, no-store";
    return Results.File(asset.Data, asset.Metadata.ContentType, entityTag: new Microsoft.Net.Http.Headers.EntityTagHeaderValue($"\"{asset.Metadata.Id}\""));
}).Access("design");
routes.MapGet("/runtime/assets/{**id}", (string id, HttpContext context, LocalAssetStore assets, PublicationStore publication) =>
{
    var published = publication.GetProject();
    if (!ProjectTemplates.Components(published).Any(component => ProjectStore.Optional(component, "type") == "image" &&
        component["props"] is JsonObject props && ProjectStore.Optional(props, "assetId") == id))
        return Results.NotFound(new { error = "Image is not part of the published application." });
    var asset = assets.Read(id);
    context.Response.Headers.CacheControl = "private, no-store";
    return Results.File(asset.Data, asset.Metadata.ContentType);
}).Access("view", "operator");
routes.MapPut("/project", (JsonObject project, ProjectStore store, ScriptResourceStore scripts, HttpContext context) =>
{
    if (!GatewayAccess.Actor(context).GatewayAdmin && ProjectStore.Optional(project, "name") != ProjectStore.Optional(store.GetProject(), "name"))
        throw new BadHttpRequestException("Gateway administrator permission is required to rename a project.", 403);
    var before = store.GetProject();
    var saved = store.SaveProject(project);
    var notice = ScriptProjectUpdates.Project(GatewayAccess.Actor(context).Username, before, saved);
    if (notice.Resources["manifestChanged"]!.GetValue<bool>() || new[] { "added", "removed", "modified" }.Any(key => notice.Resources[key]!.AsArray().Count > 0))
        scripts.NotifyUpdate(notice);
    return saved;
}).Access("design", audit: true);
routes.MapGet("/project/publication", (PublicationStore publication) => publication.Metadata()).Access("read", "context");
routes.MapGet("/project/history", (PublicationStore publication) => publication.History()).Access("design");
routes.MapPost("/project/history/{id}/restore", (string id, PublicationRollbackRequest request, PublicationStore publication) => publication.Rollback(id, request.ExpectedPublishedAt)).Access("publish", audit: true);
routes.MapPost("/project/publish", (PublishRequest request, ProjectStore store, PublicationStore publication, ScriptResourceStore scripts, HttpContext context) =>
{
    var before = publication.Metadata();
    var saved = publication.Publish(store, request.Revision);
    if (!JsonNode.DeepEquals(before, publication.Metadata())) scripts.NotifyUpdate(ScriptProjectUpdates.Resource(GatewayAccess.Actor(context).Username, "publication", "application", false, "projectPublished"));
    return saved;
}).Access("publish", audit: true);
routes.MapGet("/runtime/project", (PublicationStore publication) => publication.GetProject()).Access("view", "operator");
routes.MapGet("/runtime/queries", (string? publishedAt, PublicationStore publication) => publication.GetQueries(publishedAt)).Access("view", "operator");
routes.MapPost("/runtime/queries/{id}/execute", (string id, QueryRequest request, PublicationStore publication, QueryExecutor queries, CancellationToken cancellation)
    => queries.ExecuteDefinitionAsync(publication.GetQuery(id, request.PublishedAt), request.Parameters, cancellation)).Access("view", "operator");
routes.MapPost("/runtime/screens/{screenId}/components/{componentId}/action", async (string screenId, string componentId, RuntimeActionRequest request, RuntimeActions actions, HttpContext context, CancellationToken cancellation) =>
{
    var result = await actions.ExecuteAsync(screenId, componentId, request.Parameters, request.Inputs, request.PublishedAt, cancellation, request.InstanceId, request.RowId, request.PopupOrigin, request.InstancePath, request.BindingInputs, request.BindingState, request.Ui);
    context.Items["spark.actionOutcome"] = result["success"]?.GetValue<bool>() == true ? "Completed" : "Action failed";
    return result;
}).Access("operate", "operator", audit: true);
routes.MapPost("/runtime/screens/{screenId}/components/{componentId}/table-edit", async (string screenId, string componentId, TableEditRequest request, RuntimeActions actions, HttpContext context, CancellationToken cancellation) =>
{
    var result = await actions.ExecuteTableEditAsync(screenId, componentId, request, cancellation);
    context.Items["spark.actionOutcome"] = result["success"]?.GetValue<bool>() == true ? "Completed" : "Action failed";
    return result;
}).Access("operate", "operator", audit: true);
routes.MapGet("/tags", (HttpContext context, SecurityStore security, TagEngine tags) => GatewayAccess.Tags(context, security, tags.Snapshot())).Access("read", "context");
routes.MapPost("/tags/read", (TagReadRequest request, HttpContext context, SecurityStore security, TagEngine tags) =>
{
    var values = tags.Read(request.Paths, request.Parameters);
    if (values.Any(value => !GatewayAccess.CanReadTag(context, security, value.Path)))
        throw new BadHttpRequestException("One or more tags are outside this project's readable tag scope.", 403);
    return values;
}).Access("read", "context");
routes.MapGet("/tag-definitions", (ProjectStore store) => store.GetTagDefinitions()).Access("admin");
routes.MapGet("/opcua/subscriptions", (TagEngine tags) => tags.SubscriptionSnapshot()).Access("admin");
routes.MapPost("/tags", (JsonObject value, TagEngine tags) => tags.SaveDefinition(value)).Access("admin", audit: true);
routes.MapDelete("/tag-definitions", (string path, TagEngine tags) => tags.DeleteDefinition(path) ? Results.NoContent() : Results.NotFound(new { error = "Tag definition not found." })).Access("admin", audit: true);
routes.MapGet("/connections", (ProjectStore store) => store.GetConnections()).Access("admin");
routes.MapGet("/opcua/endpoints", (string endpoint, ConnectorService connector, CancellationToken cancellation) => connector.DiscoverEndpointsAsync(endpoint, cancellation)).Access("admin");
routes.MapPost("/connections", (JsonObject connection, TagEngine tags) => tags.SaveConnection(connection)).Access("admin", audit: true);
routes.MapGatewayConnectionEndpoints();
routes.MapGet("/connections/{id}/browse", (string id, string? nodeId, ProjectStore store, ConnectorService connector, CancellationToken cancellation) => connector.BrowseAsync(store.GetConnection(id), nodeId, cancellation)).Access("admin");
routes.MapPost("/connections/{id}/database", (string id, CreateDatabaseRequest request, ProjectStore store, ConnectorService connector, CancellationToken cancellation)
    => connector.CreateSqliteDatabaseAsync(store.GetConnection(id), request.InitializeSampleData, cancellation)).Access("admin", audit: true);
routes.MapGet("/connections/{id}/schema", (string id, ProjectStore store, ConnectorService connector, CancellationToken cancellation)
    => connector.BrowseSqliteSchemaAsync(store.GetConnection(id), cancellation)).Access("admin");
routes.MapGet("/queries", (ProjectStore store) => store.GetQueries()).Access("design");
routes.MapPut("/queries/{id}", (string id, JsonObject query, ProjectStore store, ScriptResourceStore scripts, HttpContext context) =>
{
    var before = store.GetQueries().OfType<JsonObject>().FirstOrDefault(item => ProjectStore.Optional(item, "id") == id);
    var saved = store.SaveQuery(id, query);
    if (!JsonNode.DeepEquals(before, saved)) scripts.NotifyUpdate(ScriptProjectUpdates.Resource(GatewayAccess.Actor(context).Username, "query", id, before is null));
    return saved;
}).Access("design", audit: true);
routes.MapPost("/queries/{id}/execute", (string id, QueryRequest request, QueryExecutor queries, ProjectStore store, HttpContext context, CancellationToken cancellation) =>
{
    var definition = store.GetQuery(id);
    if (ProjectStore.Optional(definition, "kind") == "update") GatewayAccess.RequireAdmin(context);
    return queries.ExecuteScriptDefinitionAsync(definition, request.Parameters, cancellation, request.TimeoutMs);
}).Access("design");
routes.MapGet("/scripts/resources", (ScriptResourceStore scripts) => scripts.GetDraft()).Access("design");
routes.MapPost("/scripts/validate", (ScriptSyntaxRequest request, PythonRunner python, CancellationToken cancellation)
    => python.ValidateSyntaxAsync(request.Code, cancellation)).Access("design");
routes.MapPut("/scripts/resources", (JsonObject draft, ScriptResourceStore scripts, HttpContext context) => scripts.SaveDraft(draft, GatewayAccess.Actor(context).Username)).Access("design", audit: true);
routes.MapGet("/scripts/publication", (ScriptResourceStore scripts) => scripts.Metadata()).Access("design");
routes.MapPost("/scripts/publish", (PublishRequest request, ScriptResourceStore scripts, HttpContext context) => scripts.Publish(request.Revision, GatewayAccess.Actor(context).Username)).Access("publish", audit: true);
routes.MapScriptMessageEndpoints();
routes.MapGet("/scripts/events/status", (ProjectRuntime runtime) => runtime.Events.Status()).Access("design");
routes.MapGet("/scripts/events/logs", (ProjectRuntime runtime) => runtime.Events.Logs()).Access("design");
routes.MapPost("/scripts/resources/{id}/run", (string id, ScriptRunRequest request, ProjectRuntime runtime, HttpContext context, CancellationToken cancellation)
    => runtime.Events.RunAsync(id, request, cancellation, GatewayAccess.Actor(context).Username)).Access("admin", audit: true);
routes.MapGet("/runtime/scripts", (ScriptResourceStore scripts) => scripts.GetClientResources()).Access("view", "operator");
routes.MapPost("/scripts/run", (ScriptRequest request, PythonRunner python, ScriptResourceStore scripts, ProjectStore store, HttpContext context, CancellationToken cancellation)
    => python.RunWithLibrariesAsync(request.Code, request.Parameters, request.Inputs, scripts.CaptureLibraries(), cancellation,
        eventContext: new JsonObject { ["type"] = "manual", ["reason"] = "console", ["timestamp"] = DateTimeOffset.UtcNow.ToString("O"),
            ["actor"] = GatewayAccess.Actor(context).Username }, uiContext: PythonUiContext.ForPreview(store, request.UiContext, request.Ui))).Access("admin", audit: true);
routes.MapGet("/events", async (HttpContext context, TagEngine tags, SecurityStore security) =>
{
    context.Response.ContentType = "text/event-stream";
    context.Response.Headers.CacheControl = "no-store";
    try
    {
        while (!context.RequestAborted.IsCancellationRequested)
        {
            if (!GatewayAccess.SessionStillAllowed(context, security)) break;
            await context.Response.WriteAsync("event: tags\ndata: " + JsonSerializer.Serialize(GatewayAccess.Tags(context, security, tags.Snapshot()), new JsonSerializerOptions(JsonSerializerDefaults.Web)) + "\n\n", context.RequestAborted);
            await context.Response.Body.FlushAsync(context.RequestAborted);
            await Task.Delay(1000, context.RequestAborted);
        }
    }
    catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
}).Access("read", "context");
}

public record TagReadRequest(string[] Paths, Dictionary<string, JsonElement>? Parameters);
public record CreateProjectRequest(string Name);
public record RenameProjectRequest(string Name, int Revision);
public record ArchiveProjectRequest(bool Archived);
public record QueryRequest(Dictionary<string, JsonElement>? Parameters, string? PublishedAt = null, int? TimeoutMs = null);
public record CreateDatabaseRequest(bool InitializeSampleData = false);
[System.Text.Json.Serialization.JsonUnmappedMemberHandling(System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow)]
public record ScriptRequest(string Code, Dictionary<string, JsonElement>? Parameters, Dictionary<string, JsonElement>? Inputs, JsonObject? Ui = null, JsonObject? UiContext = null);
[System.Text.Json.Serialization.JsonUnmappedMemberHandling(System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow)]
public record ScriptSyntaxRequest(string Code);
public record PublishRequest(int Revision);
[System.Text.Json.Serialization.JsonUnmappedMemberHandling(System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow)]
public record RuntimeActionRequest(Dictionary<string, JsonElement>? Parameters, Dictionary<string, JsonElement>? Inputs, string? PublishedAt, string? InstanceId = null, string? RowId = null, PopupOrigin? PopupOrigin = null,
    IReadOnlyList<InstancePathStep>? InstancePath = null, IReadOnlyList<Dictionary<string, JsonElement>>? BindingInputs = null,
    IReadOnlyList<ParameterBindingState>? BindingState = null, JsonObject? Ui = null);
