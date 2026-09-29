using SparkStudio.Connectors;

namespace SparkStudio.Gateway;

/// <summary>Each project owns its execution context; gateway tags and connections are shared.</summary>
public sealed class ProjectRuntimeRegistry(ProjectCatalog catalog, TagEngine tags, ConnectorService connectors,
    IConfiguration configuration, ILoggerFactory loggers, IHostApplicationLifetime lifetime) : IHostedService, IDisposable
{
    private readonly object gate = new();
    private readonly Dictionary<string, ProjectRuntime> runtimes = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim lifecycle = new(1, 1);

    public ProjectRuntime Get(string id)
    {
        lock (gate)
        {
            var workspace = catalog.Get(id);
            if (runtimes.TryGetValue(id, out var existing)) return existing;
            var queries = new QueryExecutor(workspace.Store, connectors);
            var python = new PythonRunner(tags, queries, workspace.Scripts, configuration);
            var events = new ScriptEventService(workspace.Scripts, python, loggers.CreateLogger<ScriptEventService>());
            var runtime = new ProjectRuntime(workspace, queries, python, events, new RuntimeActions(workspace.Publication, python, queries));
            events.StartAsync(lifetime.ApplicationStopping).GetAwaiter().GetResult();
            runtimes.Add(id, runtime);
            return runtime;
        }
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        foreach (var item in catalog.List().OfType<System.Text.Json.Nodes.JsonObject>())
            Get(ProjectStore.Required(item, "id"));
        return Task.CompletedTask;
    }

    public async Task DeactivateAsync(string id, CancellationToken cancellationToken)
    {
        ProjectRuntime? runtime;
        lock (gate) runtimes.Remove(id, out runtime);
        if (runtime is null) return;
        try { await runtime.Events.StopAsync(cancellationToken); }
        finally { runtime.Events.Dispose(); }
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
            if (archived) await DeactivateAsync(id, CancellationToken.None);
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
            foreach (var runtime in runtimes.Values) runtime.Events.Dispose();
            runtimes.Clear();
        }
    }
}

public sealed record ProjectRuntime(ProjectWorkspace Workspace, QueryExecutor Queries, PythonRunner Python,
    ScriptEventService Events, RuntimeActions Actions);
