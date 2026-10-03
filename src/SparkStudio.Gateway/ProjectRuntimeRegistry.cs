using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

/// <summary>Each project owns its execution context; gateway tags and connections are shared.</summary>
public sealed class ProjectRuntimeRegistry(ProjectCatalog catalog, TagEngine tags, ConnectorService connectors,
    IConfiguration configuration, ILoggerFactory loggers, IHostApplicationLifetime lifetime, RecoveryQuarantine? recovery = null,
    RuntimeSessionMessaging? sessionMessaging = null, IHttpContextAccessor? httpContext = null, SecurityStore? security = null) : IHostedService, IDisposable
{
    private readonly object gate = new();
    private readonly Dictionary<string, ProjectRuntime> runtimes = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim lifecycle = new(1, 1);
    private readonly Dictionary<string, string> startupFailures = new(StringComparer.Ordinal);
    public IReadOnlyDictionary<string, string> StartupFailures { get { lock (gate) return new Dictionary<string, string>(startupFailures); } }

    public ProjectRuntime Get(string id)
    {
        lock (gate)
        {
            var workspace = catalog.Get(id);
            if (runtimes.TryGetValue(id, out var existing)) return existing;
            _ = workspace.Publication.Metadata();
            if (lifetime.ApplicationStopping.IsCancellationRequested) throw new InvalidOperationException("Gateway is stopping; new project runtimes cannot start.");
            var queries = new QueryExecutor(workspace.Store, connectors);
            var python = new PythonRunner(tags, queries, workspace.Scripts, configuration, recovery);
            if (sessionMessaging is not null)
            {
                python.UiMessageDispatch = (messageType, payload, sessionId) => sessionMessaging.Send(id, messageType, payload, sessionId);
                python.UiSessionInfo = () => sessionMessaging.GetSessionInfo(id);
            }
            var events = new ScriptEventService(workspace.Scripts, python, loggers.CreateLogger<ScriptEventService>(), tags) { MessageScope = id };
            python.MessageDispatch = (target, name, payload, oneWay, actor, cancellation, chain) =>
            {
                var destination = string.IsNullOrWhiteSpace(target) || target == id ? events : Get(target).Events;
                cancellation.ThrowIfCancellationRequested();
                return oneWay ? Task.FromResult(destination.SendMessage(name, payload, actor, null, chain))
                    : destination.DispatchMessageAsync(name, payload, actor, null, cancellation, chain);
            };
            var runtime = new ProjectRuntime(workspace, queries, python, events, new RuntimeActions(workspace.Publication, python, queries, path =>
            {
                var context = httpContext?.HttpContext;
                if (context is null || security is null || !GatewayAccess.CanReadTag(context, security, path))
                    throw new ArgumentException("The tag binding source is unavailable in this project session.");
                var tag = tags.Read([path], null)[0];
                if (!System.Text.RegularExpressions.Regex.IsMatch(tag.Quality, @"\Agood(?:$|[_ (])", System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant))
                    throw new ArgumentException("The tag binding source has unavailable quality.");
                return System.Text.Json.JsonSerializer.SerializeToElement(tag.Value);
            }));
            if (recovery?.Active != true) events.StartAsync(lifetime.ApplicationStopping).GetAwaiter().GetResult();
            runtimes.Add(id, runtime);
            startupFailures.Remove(id);
            return runtime;
        }
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        foreach (var id in catalog.ActiveIds())
        {
            cancellationToken.ThrowIfCancellationRequested();
            try { Get(id); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException or ArgumentException)
            {
                lock (gate) startupFailures[id] = "Project resources are unreadable; files were preserved for recovery.";
                GatewayLog.ProjectStartFailed(loggers.CreateLogger<ProjectRuntimeRegistry>(), id, error.GetType().Name, null);
            }
        }
        return Task.CompletedTask;
    }

    public async Task DeactivateAsync(string id, CancellationToken cancellationToken)
    {
        ProjectRuntime? runtime;
        lock (gate) runtimes.Remove(id, out runtime);
        if (runtime is null) return;
        try { await runtime.Events.StopAsync(cancellationToken); }
        finally { runtime.Events.Dispose(); runtime.Actions.CloseComponentEvents(); }
    }

    public async Task<System.Text.Json.Nodes.JsonObject> SetArchivedAsync(string id, bool archived)
    {
        // Restore must wait for the old scheduler and its workers to exit before
        // making the project available again. Concurrent HTTP requests can never
        // overlap two scheduler generations for the same project.
        await lifecycle.WaitAsync();
        try
        {
            var result = catalog.SetArchived(id, archived);
            if (archived) { await DeactivateAsync(id, CancellationToken.None); catalog.ReleaseArchived(id); }
            else Get(id);
            return result;
        }
        finally { lifecycle.Release(); }
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        string[] ids;
        lock (gate) ids = runtimes.Keys.ToArray();
        await Task.WhenAll(ids.Select(id => DeactivateAsync(id, cancellationToken)));
    }

    public void Dispose()
    {
        lock (gate)
        {
            foreach (var runtime in runtimes.Values) { runtime.Events.Dispose(); runtime.Actions.CloseComponentEvents(); }
            runtimes.Clear();
        }
    }
}

public sealed record ProjectRuntime(ProjectWorkspace Workspace, QueryExecutor Queries, PythonRunner Python,
    ScriptEventService Events, RuntimeActions Actions);
