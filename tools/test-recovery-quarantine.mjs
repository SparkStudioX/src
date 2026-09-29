// Isolated recovery-mode boundary checks; never reads installed gateway data.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const root = process.cwd(), directory = path.resolve('.data/test-evidence', `recovery-quarantine-${randomUUID()}`);
assert.ok(directory.startsWith(path.resolve('.data') + path.sep));
await mkdir(directory, { recursive: true });
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
await writeFile(path.join(directory, 'Check.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><ProjectReference Include="${escape(path.join(root, 'src/SparkStudio.Gateway/SparkStudio.Gateway.csproj'))}"/></ItemGroup></Project>`);
await writeFile(path.join(directory, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
await writeFile(path.join(directory, 'Program.cs'), String.raw`
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

var root = Path.Combine(AppContext.BaseDirectory, "fixture"); Directory.CreateDirectory(root);
var marker = Path.Combine(root, RecoveryQuarantine.MarkerName);
Assert(!new RecoveryQuarantine(root).Active, "Ordinary gateway should run normally.");
File.WriteAllText(marker, "{invalid}");
var invalid = new RecoveryQuarantine(root);
Assert(invalid.Active && Status(invalid)["invalidMarker"]!.GetValue<bool>(), "Invalid marker must fail closed.");
Throws(() => invalid.ApproveForRestart(new("x", "RESUME RESTORED GATEWAY", true, true, true)));
File.WriteAllText(marker, JsonSerializer.Serialize(new { schemaVersion=1, state="quarantined", archiveId=Guid.NewGuid(), restoredAtUtc=DateTimeOffset.UtcNow, sourceVersion="synthetic-fixture", fileCount=3, totalBytes=100 }));
var recovery = new RecoveryQuarantine(root);
Assert(recovery.Active && !Status(recovery)["invalidMarker"]!.GetValue<bool>(), "Expected valid recovery receipt.");
Throws(recovery.EnsureOperationsAllowed);
Console.WriteLine("PASS absent, valid and malformed receipts preserve fail-closed recovery state");

using var connectors = new ConnectorService(root, recovery.EnsureOperationsAllowed);
// Invalid arguments deliberately prove the quarantine gate runs before connector parsing or IO.
await Blocked(() => connectors.TestAsync(null!, default));
await Blocked(() => connectors.DiscoverEndpointsAsync("invalid", default));
await Blocked(() => connectors.BrowseAsync(null!, null, default));
await Blocked(() => connectors.ReadAsync(null!, [], default));
await Blocked(() => connectors.QueryAsync(null!, "invalid", [], default));
await Blocked(() => connectors.ExecuteAsync(null!, "invalid", [], default));
await Blocked(() => connectors.WatchAsync(null!, [], 1000, _ => {}, _ => {}, default));
await Blocked(() => connectors.CreateSqliteDatabaseAsync(null!, false, default));
await Blocked(() => connectors.BrowseSqliteSchemaAsync(null!, default));
var python = new PythonRunner(null!, null!, null!, new ConfigurationBuilder().Build(), recovery);
await Blocked(() => python.RunWithLibrariesAsync("raise Exception('must not run')", null, null, new Dictionary<string,string>(), default));
Assert(!Directory.Exists(Path.Combine(root,"databases")), "Blocked calls created a database directory.");
Console.WriteLine("PASS every connector entry and Python execution are blocked before side effects");

var listener = new TcpListener(IPAddress.Loopback,0); listener.Start(); var port=((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args=[] });
builder.Logging.ClearProviders();
builder.Configuration["RecoveryPort"] = port.ToString();
builder.Configuration["AllowedHosts"] = "unreachable-restored-host.invalid";
builder.Configuration["Kestrel:Endpoints:Unwanted:Url"] = "http://0.0.0.0:15999";
builder.WebHost.UseUrls("http://0.0.0.0:15998");
recovery.ConfigureIsolation(builder);
await using (var app=builder.Build())
{
  app.MapGet("/ping", () => "isolated");
  await app.StartAsync();
  var addresses=app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses;
  Assert(addresses.Count==1 && addresses.Single()==$"http://127.0.0.1:{port}", "Inherited network endpoint escaped recovery isolation.");
  using var client=new HttpClient(); Assert(await client.GetStringAsync($"http://127.0.0.1:{port}/ping")=="isolated", "Recovery listener unavailable.");
  await app.StopAsync();
}
Console.WriteLine("PASS a real recovery listener replaces inherited URL and Kestrel network endpoints");

var revision=Status(recovery)["revision"]!.GetValue<string>();
Throws(() => recovery.ApproveForRestart(new(revision,"wrong",true,true,true)));
Throws(() => recovery.ApproveForRestart(new(revision,"RESUME RESTORED GATEWAY",false,true,true)));
Throws(() => recovery.ApproveForRestart(new("stale","RESUME RESTORED GATEWAY",true,true,true)));
var original=File.ReadAllText(marker); File.AppendAllText(marker," ");
Throws(() => recovery.ApproveForRestart(new(revision,"RESUME RESTORED GATEWAY",true,true,true)));
File.WriteAllText(marker,original);
recovery.ApproveForRestart(new(revision,"RESUME RESTORED GATEWAY",true,true,true));
Assert(recovery.Active && Status(recovery)["restartRequired"]!.GetValue<bool>(), "Approval activated the running process.");
Throws(recovery.EnsureOperationsAllowed);
Assert(!File.Exists(marker) && Directory.GetFiles(root,"recovery-reviewed-*.json").Length==1,"Approval did not retain receipt.");
Assert(!new RecoveryQuarantine(root).Active,"A fresh process did not observe approval.");
Console.WriteLine("PASS review acknowledgements, revision conflicts and restart-only approval preserve the isolation boundary");

static JsonObject Status(RecoveryQuarantine value) => JsonSerializer.SerializeToNode(value.Snapshot())!.AsObject();
static void Assert(bool ok,string message) { if(!ok) throw new Exception(message); }
static void Throws(Action work) { try { work(); } catch(Exception e) when(e is ArgumentException or InvalidOperationException) { return; } throw new Exception("Expected validation failure."); }
static async Task Blocked(Func<Task> work) { try { await work(); } catch(InvalidOperationException error) when(error.Message==RecoveryQuarantine.BlockedMessage) { return; } throw new Exception("Expected recovery operation block."); }
`);
const dotnet = path.resolve('.tools/dotnet/dotnet.exe');
const result = spawnSync(dotnet, ['run', '--project', path.join(directory, 'Check.csproj'), '--configuration', 'RecoveryQuarantineModel', '--verbosity', 'quiet', `-p:RestoreConfigFile=${path.join(directory, 'NuGet.Config')}`], {
  cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, DOTNET_ROOT: path.dirname(dotnet), DOTNET_CLI_HOME: path.resolve('.tools/dotnet-home'), NUGET_PACKAGES: path.resolve('.tools/nuget'), DOTNET_CLI_TELEMETRY_OPTOUT: '1' },
});
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
assert.equal(result.status, 0, result.error?.message ?? 'Recovery quarantine checks failed.');
