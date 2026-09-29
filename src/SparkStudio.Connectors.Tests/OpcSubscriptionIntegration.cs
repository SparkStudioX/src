using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using Opc.Ua;
using Opc.Ua.Configuration;
using Opc.Ua.Server;
using SparkStudio.Connectors;

internal static class OpcSubscriptionIntegration
{
    public static async Task RunAsync(Action<bool, string> check, Uri? gateway = null)
    {
        // Only this disposable loopback server is stopped/restarted. No installed gateway or PLC is accessed.
        using var portReservation = new TcpListener(IPAddress.Loopback, 0);
        portReservation.Start();
        var port = ((IPEndPoint)portReservation.LocalEndpoint).Port;
        portReservation.Stop();
        var endpoint = $"opc.tcp://127.0.0.1:{port}";
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio-subscription-test-" + Guid.NewGuid().ToString("N"));
        var telemetry = DefaultTelemetry.Create(_ => { });
        var pki = Path.Combine(directory, "server-pki");
        var configuration = new ApplicationConfiguration(telemetry)
        {
            ApplicationName = "SparkStudio isolated subscription test", ApplicationUri = "urn:localhost:SparkStudioSubscriptionTest",
            ProductUri = "urn:sparkstudio:subscription-test", ApplicationType = ApplicationType.Server,
            SecurityConfiguration = new SecurityConfiguration
            {
                ApplicationCertificates = new CertificateIdentifierCollection
                {
                    new() { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "own"), SubjectName = "CN=SparkStudioSubscriptionTest", CertificateType = ObjectTypeIds.RsaSha256ApplicationCertificateType }
                },
                TrustedPeerCertificates = new CertificateTrustList { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "trusted") },
                TrustedIssuerCertificates = new CertificateTrustList { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "issuers") },
                RejectedCertificateStore = new CertificateTrustList { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "rejected") },
                AutoAcceptUntrustedCertificates = false, AddAppCertToTrustedStore = false
            },
            ServerConfiguration = new ServerConfiguration
            {
                BaseAddresses = new StringCollection { endpoint },
                SecurityPolicies = new ServerSecurityPolicyCollection { new() { SecurityMode = MessageSecurityMode.None, SecurityPolicyUri = SecurityPolicies.None } },
                UserTokenPolicies = new UserTokenPolicyCollection { new(UserTokenType.Anonymous) },
                MinPublishingInterval = 100, MaxPublishingInterval = 60000, MaxSubscriptionCount = 10,
                MaxSessionCount = 10, MaxMessageQueueSize = 100, MaxNotificationQueueSize = 100
            },
            TransportQuotas = new TransportQuotas { OperationTimeout = 5000 }
        };
        await configuration.ValidateAsync(ApplicationType.Server);
        var application = new ApplicationInstance(configuration, telemetry);
        await application.CheckApplicationInstanceCertificatesAsync(true);
        StandardServer? server = new TestServer();
        using var connector = new ConnectorService(Path.Combine(directory, "client"));
        using var lifetime = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        Task? watch = null;
        var statuses = new ConcurrentQueue<string>();
        var values = new ConcurrentQueue<ConnectorValue>();
        var connection = new ConnectionDefinition("isolated-test", "Isolated loopback test", "opcua", Endpoint: endpoint, SecurityMode: "None");
        try
        {
            await server.StartAsync(configuration, lifetime.Token);
            Console.WriteLine("Isolated OPC UA subscription test server started.");
            if (gateway is not null)
            {
                await GatewaySubscriptionLifecycle.RunAsync(gateway, endpoint, check);
                return;
            }
            watch = connector.WatchAsync(connection, [VariableIds.Server_ServerStatus_CurrentTime.ToString()], 250,
                batch => { foreach (var value in batch) values.Enqueue(value); }, statuses.Enqueue, lifetime.Token);
            await WaitUntilAsync(() => values.Count >= 3, lifetime.Token);
            check(statuses.Contains("Connected"), "isolated server subscription connects");
            check(values.All(value => value.Quality.StartsWith("Good")), "real monitored items preserve good quality");
            check(values.Select(value => value.Value).Distinct().Count() >= 2, "real monitored items deliver changing values after initial read");
            check((await connector.TestAsync(connection, lifetime.Token)).Success, "separate cached test session works while watch is active");
            await server.StopAsync(lifetime.Token);
            server.Dispose();
            server = null;
            await WaitUntilAsync(() => statuses.Contains("Error"), lifetime.Token);
            check(statuses.Contains("Error"), "subscription detects isolated server disconnection");
            var oldValues = values.Count;
            server = new TestServer();
            await server.StartAsync(configuration, lifetime.Token);
            await WaitUntilAsync(() => statuses.Count(status => status == "Connected") >= 2 && values.Count > oldValues + 1, lifetime.Token);
            check(statuses.Count(status => status == "Connected") >= 2, "subscription recreates session and monitored items after server restart");
            lifetime.Cancel();
            await watch.WaitAsync(TimeSpan.FromSeconds(5));
            check(watch.IsCompletedSuccessfully, "subscription cancellation completes normally with bounded cleanup");
            using var edgeChecks = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var badValue = new TaskCompletionSource<ConnectorValue>(TaskCreationOptions.RunContinuationsAsynchronously);
            var invalidWatch = connector.WatchAsync(connection, ["ns=1;s=missing-test-node"], 250,
                batch => { foreach (var value in batch) if (value.Quality.StartsWith("Bad")) badValue.TrySetResult(value); }, _ => { }, edgeChecks.Token);
            try
            {
                var invalid = await badValue.Task.WaitAsync(edgeChecks.Token);
                check(invalid.NodeId == "ns=1;s=missing-test-node" && invalid.Value is null, "invalid monitored node reports bad quality without crashing the watch");
            }
            finally { edgeChecks.Cancel(); await invalidWatch.WaitAsync(TimeSpan.FromSeconds(5)); }
            using var callbackCheck = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            try
            {
                await connector.WatchAsync(connection, [VariableIds.Server_ServerStatus_CurrentTime.ToString()], 250,
                    _ => throw new Exception("deliberate test callback failure"), _ => { }, callbackCheck.Token);
                throw new Exception("FAILED: callback failure must terminate the watch");
            }
            catch (InvalidOperationException error)
            {
                check(error.Message.Contains("callback failed"), "consumer callback failure terminates rather than endlessly reconnecting");
            }
        }
        finally
        {
            lifetime.Cancel();
            if (watch is not null)
                try { await watch.WaitAsync(TimeSpan.FromSeconds(5)); } catch { }
            if (server is not null)
            {
                using var stopping = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                try { await server.StopAsync(stopping.Token); }
                finally { server.Dispose(); }
            }
        }
    }

    private static async Task WaitUntilAsync(Func<bool> predicate, CancellationToken cancellation)
    {
        while (!predicate()) await Task.Delay(50, cancellation);
    }

    private sealed class TestServer : StandardServer
    {
        protected override ServerProperties LoadServerProperties() => new()
        {
            ManufacturerName = "SparkStudio tests", ProductName = "Isolated subscription test", ProductUri = "urn:sparkstudio:subscription-test",
            SoftwareVersion = "0.1.0", BuildNumber = "test", BuildDate = DateTime.UtcNow
        };
    }
}
