using System.Data;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Opc.Ua;
using SparkStudio.Connectors;

var suites = new List<(string Name, Func<Task<int>> Run)> { ("Connector guards and pooling", RunModelChecks) };
if (args.Contains("--sqlite-integration")) suites.Add(("SQLite integration", async () => {
    var passed = 0;
    await SqliteIntegration.RunAsync((condition, message) => { if (!condition) throw new Exception(message); passed++; });
    return passed;
}));
var gatewayArgument = Array.IndexOf(args, "--gateway");
Uri? gatewayAddress = null;
if (gatewayArgument >= 0)
{
    if (gatewayArgument + 1 >= args.Length) throw new ArgumentException("Pass the isolated gateway URL after --gateway.");
    gatewayAddress = new Uri(args[gatewayArgument + 1]);
    GatewaySubscriptionLifecycle.ValidateAddress(gatewayAddress);
}
if (args.Contains("--opc-integration") || gatewayAddress is not null) suites.Add(("OPC integration", async () => {
    var passed = 0;
    await OpcSubscriptionIntegration.RunAsync((condition, message) => { if (!condition) throw new Exception(message); passed++; }, gatewayAddress);
    return passed;
}));
suites.Add(("Connector reliability", ConnectorReliabilityChecks.RunAsync));
await TestReport.RunAsync("Connectors", args, suites);

static async Task<int> RunModelChecks()
{
var passed = 0;
void Check(bool condition, string description)
{
    if (!condition) throw new Exception("FAILED: " + description);
    passed++;
}
void Reject(Action action, string description)
{
    try { action(); } catch (ArgumentException) { passed++; return; }
    throw new Exception("FAILED to reject: " + description);
}

foreach (var sql in new[]
{
    "SELECT 1", " SELECT TOP (10) * FROM dbo.Events WHERE Id = @id; -- end",
    "/* header /* nested */ fine */ SELECT 'delete; drop table x' AS [update]",
    "SELECT 'it''s safe' AS [escaped]]identifier]", "SELECT 1 AS \"DELETE\"",
    "WITH x AS (SELECT 1 AS n) SELECT n FROM x", "WITH a AS (SELECT 1 AS n), b AS (SELECT n FROM a) SELECT * FROM b",
    "SELECT 1 UNION ALL SELECT 2", "SELECT 1 INTERSECT SELECT 1", "SELECT * FROM (SELECT 1 AS n) AS x",
    "SELECT @update AS value", "SELECT * FROM dbo.Events WITH (NOLOCK)"
})
{
    Check(SqlQueryGuard.Validate(sql) == sql, "valid read query");
}
foreach (var sql in new[]
{
    "DELETE FROM x", "SELECT 1; DELETE FROM x", "SELECT 1 SELECT 2",
    "SELECT 1 /*c*/ ; /*c*/ SELECT 2", "WITH x AS (SELECT 1 AS n) UPDATE x SET n=2",
    "WITH x AS (SELECT 1 AS n) DELETE FROM x", "SELECT * INTO backup FROM x",
    "SELECT 1 EXEC('DELETE FROM x')", "SELECT NEXT VALUE FOR seq", "SELECT * FROM OPENROWSET('x', 'y', 'z')",
    "SELECT * FROM OPENQUERY(remote, 'select 1')", "SELECT 1 WAITFOR DELAY '00:01'", "SELECT 1\nGO\nSELECT 2",
    "SELECT 1; /* dangling", "SELECT 'dangling", "SELECT [dangling", "SELECT (1", "SELECT 1)",
    "SELECT 1;;", "SELECT 1 UNION", "WITH x AS (SELECT 1 AS n)", "/*only comment*/", "SELECT 1 USE other"
})
{
    Reject(() => SqlQueryGuard.Validate(sql), sql);
}
Check(ConnectorService.UniqueColumns(["Value", "Value", "value", "Value_2", "", ""]).SequenceEqual(
    new[] { "Value", "Value_2", "value_3", "Value_2_2", "Column5", "Column6" }), "duplicate and empty result column preservation");
using var input = JsonDocument.Parse("42");
var parameter = ConnectorService.BuildParameter(new("id", "int", input.RootElement));
Check(parameter.ParameterName == "@id" && parameter.SqlDbType == SqlDbType.Int && (int)parameter.Value == 42, "typed numeric JSON parameter");
var quoted = ConnectorService.BuildParameter(new("text", "string", "'; DROP TABLE x;--"));
Check((string)quoted.Value == "'; DROP TABLE x;--" && quoted.SqlDbType == SqlDbType.NVarChar, "SQL-looking parameter remains data");
Check(ConnectorService.BuildParameter(new("none", "int", null)).Value is DBNull, "SQL null parameter");
Reject(() => ConnectorService.BuildParameter(new("id;DROP", "int", 1)), "invalid parameter name");
Reject(() => ConnectorService.BuildParameter(new("id", "executable", "x")), "unsupported parameter type");
var definition = new ConnectionDefinition("x", "test", "sqlserver", Server: "localhost", Database: "db", Username: "u", Password: "p;Encrypt=false");
var builder = new SqlConnectionStringBuilder(ConnectorService.BuildConnectionString(definition));
Check(builder.Encrypt == SqlConnectionEncryptOption.Mandatory && !builder.TrustServerCertificate && builder.Password == "p;Encrypt=false", "connection string injection cannot weaken encryption");
Check(builder.ApplicationIntent == ApplicationIntent.ReadOnly && !builder.PersistSecurityInfo, "read intent and credential hiding");
Check(ConnectorService.ParseSecurityMode(null) == MessageSecurityMode.SignAndEncrypt, "secure OPC default");
Check(ConnectorService.ParseSecurityMode("None") == MessageSecurityMode.None, "explicit unsecured opt-in");
Reject(() => ConnectorService.ParseSecurityMode("auto"), "no automatic security downgrade");
Check(ConnectorService.NormalizeValue(double.NaN) is string, "nonfinite OPC value is JSON serializable");
Check((string)ConnectorService.NormalizeValue(new byte[] { 1, 2, 3 })! == "AQID", "binary value is base64");
Check(ConnectorService.OpcError(2148728832).Contains("BadSecurityChecksFailed, 0x80130000") && ConnectorService.OpcError(2148728832).Contains("rejected-client"), "security failure has symbolic status and client trust guidance");
Check(ConnectorService.OpcError(StatusCodes.BadCertificateHostNameInvalid).Contains("subject alternative names"), "certificate hostname failure is actionable");
var resources = new List<FakeResource>();
using (var pool = new ConnectionResourcePool<FakeResource>(2,
    (_, _) => { var item = new FakeResource(); resources.Add(item); return Task.FromResult(item); },
    item => !item.Disposed, _ => Task.CompletedTask))
{
    var config = new ConnectionDefinition("opc-a", "A", "opcua", Endpoint: "opc.tcp://server:4840", Password: "first", ServerCertificateSha256: new string('A', 64));
    var initial = await pool.RunAsync(config, (item, _) => Task.FromResult(item), default);
    Check(ReferenceEquals(initial, await pool.RunAsync(config, (item, _) => Task.FromResult(item), default)), "session reused for unchanged configuration");
    foreach (var changed in new[] { config with { Password = "second" }, config with { Username = "different" }, config with { Endpoint = "opc.tcp://other:4840" }, config with { SecurityMode = "Sign" }, config with { ServerCertificateSha256 = new string('B', 64) } })
    {
        var previous = resources[^1];
        await pool.RunAsync(changed, (item, _) => Task.FromResult(item), default);
        Check(previous.Disposed && !resources[^1].Disposed, "changed credentials/endpoint/security/pin replace and dispose the previous session");
    }
    var beforeFailure = resources[^1];
    try { await pool.RunAsync(config, (_, _) => Task.FromException<bool>(new InvalidOperationException("transport failed")), default); }
    catch (InvalidOperationException) { }
    Check(beforeFailure.Disposed && resources[^1].Disposed, "failed operation invalidates cached session");
    var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var first = pool.RunAsync(config, async (_, _) => { entered.SetResult(); await release.Task; return true; }, default);
    await entered.Task;
    var secondEntered = false;
    var second = pool.RunAsync(config, (_, _) => { secondEntered = true; return Task.FromResult(true); }, default);
    await Task.Delay(25);
    Check(!secondEntered, "parallel operations on one connection are serialized");
    release.SetResult();
    await Task.WhenAll(first, second);
    Check(secondEntered, "queued operation resumes after previous operation");
    var a = resources[^1];
    await pool.RunAsync(config with { Id = "opc-b" }, (_, _) => Task.FromResult(true), default);
    await Task.Delay(2);
    await pool.RunAsync(config with { Id = "opc-c" }, (_, _) => Task.FromResult(true), default);
    Check(a.Disposed && resources.Count(item => !item.Disposed) == 2, "capacity evicts idle resources and bounds live sessions");
}
Check(resources.All(item => item.Disposed), "pool disposal releases cached resources");
var stoppingResource = new FakeResource();
var stoppingPool = new ConnectionResourcePool<FakeResource>(1, (_, _) => Task.FromResult(stoppingResource), _ => true, _ => Task.CompletedTask);
var active = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
var running = stoppingPool.RunAsync(new("stop", "Stop", "opcua"), async (_, cancellation) => { active.SetResult(); await Task.Delay(Timeout.Infinite, cancellation); return true; }, default);
await active.Task;
stoppingPool.Dispose();
try { await running; } catch (OperationCanceledException) { }
Check(stoppingResource.Disposed, "shutdown cancels in-flight work and disposes its session");
var watchConnection = new ConnectionDefinition("watch", "Watch", "opcua", Endpoint: "opc.tcp://localhost:4840", SecurityMode: "None");
Check(ConnectorService.ValidateWatch(watchConnection, ["ns=2;s=Temperature", "ns=2;s=Temperature"], 250).Count == 1, "watch deduplicates node IDs");
Reject(() => ConnectorService.ValidateWatch(watchConnection, [], 250), "watch requires nodes");
Reject(() => ConnectorService.ValidateWatch(watchConnection, ["ns=2;s=X"], 0), "watch rejects invalid publishing interval");
Reject(() => ConnectorService.ValidateWatch(watchConnection with { ServerCertificateSha256 = "invalid" }, ["ns=2;s=X"], 250), "watch rejects malformed certificate pin before network activity");
Check(ConnectorService.WatchReconnectDelay(0).TotalSeconds == 1 && ConnectorService.WatchReconnectDelay(20).TotalSeconds == 15, "watch reconnect backoff is bounded");
var sourceTime = new DateTime(2026, 9, 28, 10, 0, 0, DateTimeKind.Utc);
var serverTime = sourceTime.AddSeconds(1);
var mapped = ConnectorService.ToConnectorValue("i=1", new DataValue(new Variant(123), StatusCodes.Uncertain, sourceTime, serverTime));
Check(mapped.Timestamp == new DateTimeOffset(sourceTime) && mapped.Quality.StartsWith("Uncertain") && (int)mapped.Value! == 123, "watch preserves source timestamp, value and uncertain quality");
Check(ConnectorService.ToConnectorValue("i=1", new DataValue(new Variant(123), StatusCodes.Good, DateTime.MinValue, serverTime)).Timestamp == new DateTimeOffset(serverTime), "watch preserves server timestamp when source timestamp is absent");
var valueQueue = new SubscriptionValueQueue();
valueQueue.Put(new("a", 1, "Int32", "Good", DateTimeOffset.UtcNow));
valueQueue.Put(new("a", 2, "Int32", "Good", DateTimeOffset.UtcNow));
valueQueue.Put(new("b", 3, "Int32", "Good", DateTimeOffset.UtcNow));
var queued = await valueQueue.ReadAsync(default);
Check(queued.Count == 2 && (int)queued.Single(value => value.NodeId == "a").Value! == 2, "notification queue coalesces to latest values without losing other nodes");
valueQueue.Fail(StatusCodes.BadNoCommunication);
try { await valueQueue.ReadAsync(default); throw new Exception("FAILED: subscription failure must interrupt queue reads"); }
catch (ServiceResultException error) { Check(error.StatusCode == StatusCodes.BadNoCommunication, "subscription failure interrupts pending data delivery"); }
var emptyQueue = new SubscriptionValueQueue();
using (var cancelRead = new CancellationTokenSource())
{
    var waiting = emptyQueue.ReadAsync(cancelRead.Token);
    cancelRead.Cancel();
    try { await waiting; throw new Exception("FAILED: waiting subscription must cancel"); }
    catch (OperationCanceledException) { passed++; }
}
return passed;
}

sealed class FakeResource : IDisposable
{
    public bool Disposed { get; private set; }
    public void Dispose() => Disposed = true;
}
