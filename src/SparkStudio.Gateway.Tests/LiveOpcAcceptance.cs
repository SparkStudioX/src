using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

/// <summary>Explicit opt-in real endpoint acceptance; never part of the offline test suite.</summary>
public static class LiveOpcAcceptance
{
    public static async Task RunAsync()
    {
        string Required(string name) => Environment.GetEnvironmentVariable(name) is { Length: > 0 } value ? value : throw new ArgumentException($"Set {name} explicitly.");
        var directory = Path.GetFullPath(Required("SPARKSTUDIO_LIVE_OPC_DATA"));
        var connectionId = Required("SPARKSTUDIO_LIVE_OPC_CONNECTION");
        var nodeId = Required("SPARKSTUDIO_LIVE_OPC_NODE");
        var reportPath = Path.GetFullPath(Required("SPARKSTUDIO_LIVE_OPC_REPORT"));
        var protection = DataProtectionProvider.Create(new DirectoryInfo(Path.Combine(directory, "keys")), builder => builder.SetApplicationName("SparkStudio"));
        var store = new ProjectStore(directory, protection, gatewayOnly: true);
        var connection = store.GetConnection(connectionId);
        using var connectors = new ConnectorService(directory);
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var report = new JsonObject { ["startedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["endpoint"] = connection.Endpoint,
            ["securityMode"] = connection.SecurityMode, ["configuredCertificateSha256"] = connection.ServerCertificateSha256, ["nodeId"] = nodeId };
        Task? watch = null; using var watching = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token);
        ConnectorValue? original = null; var dispatchAttempted = false;
        try
        {
            report["endpoints"] = JsonSerializer.SerializeToNode(await connectors.DiscoverEndpointsAsync(connection.Endpoint!, deadline.Token));
            Console.WriteLine("Endpoint discovery completed with configured trust; no certificates were automatically accepted.");
            report["browse"] = JsonSerializer.SerializeToNode(await connectors.BrowseAsync(connection, null, deadline.Token));
            original = (await connectors.ReadAsync(connection, [nodeId], deadline.Token)).Single();
            report["initial"] = JsonSerializer.SerializeToNode(original);
            if (!original.Quality.StartsWith("Good", StringComparison.Ordinal)) throw new InvalidOperationException("The selected tag has unavailable quality; no write attempted.");
            var received = new ConcurrentQueue<ConnectorValue>(); var first = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var statuses = new ConcurrentQueue<string>();
            watch = connectors.WatchAsync(connection, [nodeId], 250, values => { foreach (var value in values) received.Enqueue(value); first.TrySetResult(); },
                status => statuses.Enqueue(status), watching.Token, new Dictionary<string, OpcMonitorSettings> { [nodeId] = new(0, 16) });
            await first.Task.WaitAsync(TimeSpan.FromSeconds(30), deadline.Token);
            report["subscriptionInitial"] = JsonSerializer.SerializeToNode(received.ToArray());
            report["subscriptionStatus"] = JsonSerializer.SerializeToNode(statuses.ToArray());
            if (Environment.GetEnvironmentVariable("SPARKSTUDIO_LIVE_OPC_WRITE_AND_RESTORE") != "yes")
            { report["write"] = "not-requested"; report["success"] = true; return; }
            if (original.Value is not (ushort or short or int or uint)) throw new ArgumentException("This acceptance runner writes only 16/32-bit integer fixture tags.");
            var target = long.Parse(Required("SPARKSTUDIO_LIVE_OPC_WRITE_VALUE"), System.Globalization.CultureInfo.InvariantCulture);
            var expected = long.Parse(Required("SPARKSTUDIO_LIVE_OPC_EXPECTED_ORIGINAL"), System.Globalization.CultureInfo.InvariantCulture);
            if (Convert.ToInt64(original.Value) != expected) throw new InvalidOperationException("The tag changed from the explicitly expected original value. No write attempted.");
            var type = original.DataType;
            var status = await connectors.WriteValueAsync(connection, nodeId, type, JsonSerializer.SerializeToElement(target), deadline.Token, () => dispatchAttempted = true);
            report["writeStatus"] = status; report["requestedValue"] = target;
            if (!status.StartsWith("Good", StringComparison.Ordinal)) throw new InvalidOperationException("The server rejected the test write.");
            ConnectorValue readback = original;
            for (var attempt = 0; attempt < 20; attempt++)
            {
                readback = (await connectors.ReadAsync(connection, [nodeId], deadline.Token)).Single();
                if (readback.Quality.StartsWith("Good", StringComparison.Ordinal) && Convert.ToInt64(readback.Value) == target) break;
                await Task.Delay(100, deadline.Token);
            }
            report["readback"] = JsonSerializer.SerializeToNode(readback);
            if (!readback.Quality.StartsWith("Good", StringComparison.Ordinal) || Convert.ToInt64(readback.Value) != target)
                throw new InvalidOperationException("Good-quality readback did not confirm the test value; restoration is still attempted.");
            await Task.Delay(600, deadline.Token);
            report["subscriptionObservedWrite"] = received.Any(value => value.Quality.StartsWith("Good", StringComparison.Ordinal) && Convert.ToInt64(value.Value) == target);
            if (report["subscriptionObservedWrite"]!.GetValue<bool>() != true) throw new InvalidOperationException("Subscription did not observe the written value.");
            report["success"] = true;
        }
        catch (Exception error)
        {
            report["success"] = false; report["errorType"] = error.GetType().Name;
            report["error"] = error is InvalidOperationException or ArgumentException ? error.Message : "Endpoint acceptance failed; inspect the trusted local test environment.";
            throw;
        }
        finally
        {
            if (dispatchAttempted && original is not null)
            {
                using var restoreDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                try
                {
                    var status = await connectors.WriteValueAsync(connection, nodeId, original.DataType, JsonSerializer.SerializeToElement(original.Value), restoreDeadline.Token);
                    var restored = (await connectors.ReadAsync(connection, [nodeId], restoreDeadline.Token)).Single();
                    report["restoreStatus"] = status; report["restored"] = JsonSerializer.SerializeToNode(restored);
                    report["restoreConfirmed"] = status.StartsWith("Good", StringComparison.Ordinal) && restored.Quality.StartsWith("Good", StringComparison.Ordinal) && Convert.ToInt64(restored.Value) == Convert.ToInt64(original.Value);
                }
                catch (Exception error) { report["restoreConfirmed"] = false; report["restoreErrorType"] = error.GetType().Name; }
            }
            watching.Cancel();
            Exception? watchError = null;
            try { if (watch is not null) await watch; }
            catch (OperationCanceledException) when (watching.IsCancellationRequested) { }
            catch (Exception error) { watchError = error; report["success"] = false; report["subscriptionErrorType"] = error.GetType().Name; }
            report["completedAt"] = DateTimeOffset.UtcNow.ToString("O");
            Directory.CreateDirectory(Path.GetDirectoryName(reportPath)!); File.WriteAllText(reportPath, report.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"Sanitized OPC acceptance report: {reportPath}");
            if (dispatchAttempted && report["restoreConfirmed"]?.GetValue<bool>() != true) throw new InvalidOperationException("Restoration was not confirmed. Inspect the selected device tag before repeating acceptance.");
            if (watchError is not null) throw new InvalidOperationException("Subscription failed; sanitized evidence was saved.", watchError);
        }
    }
}
