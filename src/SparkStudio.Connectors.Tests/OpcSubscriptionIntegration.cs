using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Opc.Ua;
using Opc.Ua.Configuration;
using Opc.Ua.Server;
using SparkStudio.Connectors;

internal static class OpcSubscriptionIntegration
{
    public static async Task RunAsync(Action<bool, string> check, Uri? gateway = null,
        Func<string, string, string, CancellationToken, Task>? nativeFixture = null)
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
                SecurityPolicies = new ServerSecurityPolicyCollection
                {
                    new() { SecurityMode = MessageSecurityMode.None, SecurityPolicyUri = SecurityPolicies.None },
                    new() { SecurityMode = MessageSecurityMode.SignAndEncrypt, SecurityPolicyUri = SecurityPolicies.Basic256Sha256 }
                },
                UserTokenPolicies = new UserTokenPolicyCollection { new(UserTokenType.Anonymous) },
                MinPublishingInterval = 100, MaxPublishingInterval = 60000, MaxSubscriptionCount = 10,
                MaxSessionCount = 10, MaxMessageQueueSize = 100, MaxNotificationQueueSize = 100
            },
            TransportQuotas = new TransportQuotas { OperationTimeout = 5000 }
        };
        using var serverCertificate = CertificateFactory.CreateCertificate(configuration.ApplicationUri, configuration.ApplicationName,
            "CN=SparkStudioSubscriptionTest", [Dns.GetHostName(), "localhost", "127.0.0.1"]).CreateForRSA();
        using (var certificateStore = configuration.SecurityConfiguration.ApplicationCertificates[0].OpenStore(telemetry))
            await certificateStore.AddAsync(serverCertificate);
        configuration.SecurityConfiguration.ApplicationCertificates[0].Certificate = serverCertificate;
        await configuration.ValidateAsync(ApplicationType.Server);
        // This disposable loopback fixture accepts untrusted client certificates.
        // Production ConnectorService still rejects untrusted server certificates unless explicitly pinned/trusted.
        configuration.CertificateValidator.CertificateValidation += (_, args) =>
        {
            if (args.Error.StatusCode == StatusCodes.BadCertificateUntrusted) args.Accept = true;
        };
        var application = new ApplicationInstance(configuration, telemetry);
        await application.CheckApplicationInstanceCertificatesAsync(true);
        StandardServer? server = new TestServer();
        using var connector = new ConnectorService(Path.Combine(directory, "client"));
        using var lifetime = new CancellationTokenSource(TimeSpan.FromSeconds(nativeFixture is null ? 60 : 120));
        Task? watch = null;
        var statuses = new ConcurrentQueue<string>();
        var values = new ConcurrentQueue<ConnectorValue>();
        var connection = new ConnectionDefinition("isolated-test", "Isolated loopback test", "opcua", Endpoint: endpoint, SecurityMode: "None");
        try
        {
            await server.StartAsync(configuration, lifetime.Token);
            Console.WriteLine("Isolated OPC UA subscription test server started.");
            var writable = ((TestServer)server).Writes!.Writable.ToString();
            var readOnly = ((TestServer)server).Writes!.ReadOnly.ToString();
            if (nativeFixture is not null)
            {
                await nativeFixture(endpoint, writable, readOnly, lifetime.Token);
                return;
            }
            if (gateway is not null)
            {
                await GatewaySubscriptionLifecycle.RunAsync(gateway, endpoint, check);
                return;
            }
            var endpoints = await connector.DiscoverEndpointsAsync(endpoint, lifetime.Token);
            var encrypted = endpoints.First(candidate => candidate.SecurityMode == "SignAndEncrypt" && candidate.SecurityPolicy == SecurityPolicies.Basic256Sha256);
            check(encrypted.ServerCertificateSha256 == serverCertificate.GetCertHashString(System.Security.Cryptography.HashAlgorithmName.SHA256), "disposable server advertises its explicit loopback certificate");
            var secure = connection with { Id = "isolated-secure", SecurityMode = "SignAndEncrypt" };
            var untrusted = await connector.TestAsync(secure, lifetime.Token);
            check(!untrusted.Success && untrusted.Message.Contains("BadCertificateUntrusted", StringComparison.Ordinal), "typing a secure endpoint alone reports untrusted certificate without weakening security: " + untrusted.Message);
            var pinned = secure with { ServerCertificateSha256 = encrypted.ServerCertificateSha256 };
            check((await connector.TestAsync(pinned, lifetime.Token)).Success, "verified discovery fingerprint allows a secure manual endpoint and server read");
            var incorrectPin = await connector.TestAsync(pinned with { ServerCertificateSha256 = new string('0', 64) }, lifetime.Token);
            check(!incorrectPin.Success && incorrectPin.Message.Contains("does not match", StringComparison.Ordinal), "incorrect server certificate pin is rejected before session admission");
            check(!(await connector.TestAsync(secure, lifetime.Token)).Success, "one connection's explicit pin never trusts another unpinned connection");
            var dispatches = 0;
            var write = await connector.WriteValueAsync(connection, writable, "Int32", JsonSerializer.SerializeToElement(42), lifetime.Token, () => dispatches++);
            check(write.StartsWith("Good", StringComparison.Ordinal) && dispatches == 1, "isolated OPC UA scalar command dispatches exactly once and receives Good");
            var written = (await connector.ReadAsync(connection, [writable], lifetime.Token)).Single();
            check(Convert.ToInt32(written.Value) == 42 && written.Quality.StartsWith("Good", StringComparison.Ordinal), "actual device readback matches accepted typed write");
            write = await connector.WriteValueAsync(connection, writable, "String", JsonSerializer.SerializeToElement("wrong-type"), lifetime.Token);
            check(write.StartsWith("Bad", StringComparison.Ordinal) && Convert.ToInt32((await connector.ReadAsync(connection, [writable], lifetime.Token)).Single().Value) == 42, "OPC server rejects mismatching write type without changing the value");
            write = await connector.WriteValueAsync(connection, readOnly, "Int32", JsonSerializer.SerializeToElement(99), lifetime.Token);
            check(write.StartsWith("Bad", StringComparison.Ordinal), "read-only OPC node explicitly rejects a command");
            try
            {
                await connector.WriteValueAsync(connection, writable, "Int32", JsonSerializer.SerializeToElement(99), lifetime.Token, () => throw new InvalidOperationException("guard rejected"));
                throw new Exception("FAILED: pre-dispatch guard must prevent write");
            }
            catch (InvalidOperationException error) when (error.Message == "guard rejected") { check(true, "command guard revalidates after session admission and before device dispatch"); }
            check(Convert.ToInt32((await connector.ReadAsync(connection, [writable], lifetime.Token)).Single().Value) == 42, "failed pre-dispatch guard leaves the server value unchanged");
            using (var cancelled = new CancellationTokenSource())
            {
                cancelled.Cancel();
                try { await connector.WriteValueAsync(connection, writable, "Int32", JsonSerializer.SerializeToElement(99), cancelled.Token, () => dispatches++); throw new Exception("FAILED: cancelled command wrote"); }
                catch (OperationCanceledException) { check(dispatches == 1, "cancelled OPC request never reaches dispatch callback"); }
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
        public WriteNodeManager? Writes { get; private set; }
        protected override MasterNodeManager CreateMasterNodeManager(IServerInternal server, ApplicationConfiguration configuration)
        {
            Writes = new WriteNodeManager(server, configuration);
            return new MasterNodeManager(server, configuration, null, Writes);
        }
        protected override ServerProperties LoadServerProperties() => new()
        {
            ManufacturerName = "SparkStudio tests", ProductName = "Isolated subscription test", ProductUri = "urn:sparkstudio:subscription-test",
            SoftwareVersion = "0.1.0", BuildNumber = "test", BuildDate = DateTime.UtcNow
        };
    }

    private sealed class WriteNodeManager(IServerInternal server, ApplicationConfiguration configuration)
        : CustomNodeManager2(server, configuration, "urn:sparkstudio:isolated-write-fixture")
    {
        public NodeId Writable => new("Writable", NamespaceIndex);
        public NodeId ReadOnly => new("ReadOnly", NamespaceIndex);
        public override void CreateAddressSpace(IDictionary<NodeId, IList<IReference>> externalReferences)
        {
            foreach (var writable in new[] { true, false })
            {
                var name = writable ? "Writable" : "ReadOnly";
                var node = new BaseDataVariableState(null) {
                    NodeId = writable ? Writable : ReadOnly, BrowseName = new QualifiedName(name, NamespaceIndex), DisplayName = name,
                    TypeDefinitionId = VariableTypeIds.BaseDataVariableType, DataType = DataTypeIds.Int32, ValueRank = ValueRanks.Scalar,
                    AccessLevel = writable ? AccessLevels.CurrentReadOrWrite : AccessLevels.CurrentRead,
                    UserAccessLevel = writable ? AccessLevels.CurrentReadOrWrite : AccessLevels.CurrentRead,
                    Value = 0, StatusCode = StatusCodes.Good, Timestamp = DateTime.UtcNow
                };
                AddPredefinedNode(SystemContext, node);
            }
        }
    }
}
