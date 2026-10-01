using Microsoft.Data.Sqlite;
using SparkStudio.Connectors;

public static class ConnectorReliabilityChecks
{
    private sealed class Resource : IDisposable { public bool Disposed; public void Dispose() => Disposed = true; }
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool condition, string text) { if (!condition) throw new Exception(text); passed++; }
        var resources = new List<Resource>();
        using (var pool = new ConnectionResourcePool<Resource>(1, (_, _) =>
            { var resource = new Resource(); resources.Add(resource); return Task.FromResult(resource); }, item => !item.Disposed,
            _ => Task.CompletedTask, error => error is ArgumentException))
        {
            var connection = new ConnectionDefinition("reuse", "reuse", "opcua");
            await pool.RunAsync(connection, (_, _) => Task.FromResult(true), default);
            try { await pool.RunAsync<bool>(connection, (_, _) => throw new ArgumentException("application rejection"), default); } catch (ArgumentException) { }
            await pool.RunAsync(connection, (_, _) => Task.FromResult(true), default);
            Check(resources.Count == 1 && !resources[0].Disposed, "known application rejection retains a healthy session");
            try { await pool.RunAsync<bool>(connection, (_, _) => throw new IOException("transport failure"), default); } catch (IOException) { }
            await pool.RunAsync(connection, (_, _) => Task.FromResult(true), default);
            Check(resources.Count == 2 && resources[0].Disposed, "transport failure still retires session before reconnect");
        }
        using (var pool = new ConnectionResourcePool<Resource>(4, (_, _) => Task.FromResult(new Resource()), _ => true, _ => Task.CompletedTask,
            maximumConcurrencyPerConnection: 2))
        {
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var active = 0;
            async Task<bool> Action(Resource resource, CancellationToken cancellation)
            { if (Interlocked.Increment(ref active) == 2) entered.TrySetResult(); await release.Task.WaitAsync(cancellation); return true; }
            var connection = new ConnectionDefinition("parallel", "parallel", "opcua");
            var first = pool.RunAsync(connection, Action, default); var second = pool.RunAsync(connection, Action, default);
            try { await entered.Task.WaitAsync(TimeSpan.FromSeconds(2)); Check(active == 2, "bounded parallel lanes allow independent operations on one endpoint"); }
            finally { release.TrySetResult(); await Task.WhenAll(first, second); }
        }
        passed += await RemovalChecks();
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.ConnectorReliability." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            using var connectors = new ConnectorService(directory);
            var connection = new ConnectionDefinition("wal", "WAL test", "sqlite", Database: "wal.db");
            await connectors.CreateSqliteDatabaseAsync(connection, true, default);
            using (var writer = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(directory, "databases", "wal.db"), Pooling = false }.ToString()))
            {
                writer.Open();
                using var command = writer.CreateCommand();
                command.CommandText = "PRAGMA journal_mode";
                Check(Convert.ToString(command.ExecuteScalar()) == "wal", "new managed databases use WAL");
                using var transaction = writer.BeginTransaction();
                command.Transaction = transaction; command.CommandText = "UPDATE production_records SET quantity=99 WHERE id=1"; command.ExecuteNonQuery();
                var read = await connectors.QueryAsync(connection, "SELECT quantity FROM production_records WHERE id=1", [], default).WaitAsync(TimeSpan.FromSeconds(2));
                Check(Convert.ToInt64(read.Rows[0]["quantity"]) == 0, "reader proceeds during uncommitted writer and sees committed snapshot");
                transaction.Commit();
                var after = await connectors.QueryAsync(connection, "SELECT quantity FROM production_records WHERE id=1", [], default);
                Check(Convert.ToInt64(after.Rows[0]["quantity"]) == 99, "reader observes committed value on next operation");
            }
            return passed;
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); }
    }

    private static async Task<int> RemovalChecks()
    {
        var passed = 0;
        void Check(bool condition, string message) { if (!condition) throw new Exception(message); passed++; }
        async Task Reject(Func<Task> action)
        {
            try { await action(); } catch (InvalidOperationException) { passed++; return; }
            throw new Exception("Expected an in-use or removed connection conflict.");
        }
        var resources = new List<Resource>();
        using var pool = new ConnectionResourcePool<Resource>(4, (_, _) =>
            { var item = new Resource(); resources.Add(item); return Task.FromResult(item); }, item => !item.Disposed,
            _ => throw new IOException("Synthetic graceful-close failure"));
        var connection = new ConnectionDefinition("remove", "Remove fixture", "opcua");
        var other = new ConnectionDefinition("preserve", "Other fixture", "opcua");
        await pool.RunAsync(connection, (_, _) => Task.FromResult(true), default);
        await pool.RunAsync(other, (_, _) => Task.FromResult(true), default);
        var commits = 0;
        try { await pool.PrepareConnectionRemoval(connection.Id, () => throw new IOException("Synthetic persistence failure"))(); }
        catch (IOException) { passed++; }
        Check(!resources[0].Disposed && !resources[1].Disposed, "a failed persistence callback leaves cached sessions intact");
        await pool.RunAsync(connection, (_, _) => Task.FromResult(true), default);
        Check(resources.Count == 2, "failed removal still allows the same healthy session to be reused");
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var active = pool.RunAsync(connection, async (_, cancellation) =>
            { entered.SetResult(); await release.Task.WaitAsync(cancellation); return true; }, default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        try
        {
            await Reject(() => pool.PrepareConnectionRemoval(connection.Id, () => commits++)());
            Check(commits == 0 && !resources[0].Disposed, "an active OPC lease blocks removal before persistence or disposal");
        }
        finally { release.SetResult(); await active; }
        var cleanup = pool.PrepareConnectionRemoval(connection.Id, () => commits++);
        Check(commits == 1 && !resources[0].Disposed, "removal reserves and persists first while deferring transport close until after configuration locks are released");
        await cleanup();
        Check(commits == 1 && resources[0].Disposed && !resources[1].Disposed, "removal releases only the selected connection even when graceful close fails");
        await Reject(() => pool.RunAsync(connection, (_, _) => Task.FromResult(true), default));
        Check(resources.Count == 2, "an old captured configuration cannot reopen a deleted connection");
        var replacement = connection with { Id = "replacement" };
        await pool.RunAsync(replacement, (_, _) => Task.FromResult(true), default);
        Check(resources.Count == 3 && !resources[2].Disposed, "a fresh identity can create a replacement session without reopening the removed identity");
        return passed;
    }
}
