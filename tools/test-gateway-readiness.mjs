#!/usr/bin/env node
// Isolated, framework-only checks. No installed gateway, service, account or project is modified.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const root = process.cwd();
const directory = path.resolve('.data/test-evidence', `readiness-${randomUUID()}`);
assert.ok(directory.startsWith(path.resolve('.data') + path.sep));
await mkdir(directory, { recursive: true });
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const source = await readFile('src/SparkStudio.Gateway/GatewaySecurity.cs', 'utf8');
// Compile the actual production loopback helper without pulling in unrelated security stores/dependencies.
const loopback = source.match(/public static bool IsLoopback\(HttpContext context\)\s*\{[^}]+\}/)?.[0];
assert.ok(loopback, 'Production loopback helper was not found.');
await writeFile(path.join(directory, 'GatewaySecurity.cs'), `using System.Net; namespace SparkStudio.Gateway; public static class GatewaySecurity { ${loopback} }`);
await writeFile(path.join(directory, 'ReadyCheck.csproj'), `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><Compile Include="${xml(path.join(root, 'src/SparkStudio.Gateway/GatewayReadiness.cs'))}" Link="GatewayReadiness.cs"/></ItemGroup></Project>`);
await writeFile(path.join(directory, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
await writeFile(path.join(directory, 'Program.cs'), String.raw`
using System.Diagnostics;
using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using SparkStudio.Gateway;

var root = args[0];
var python = Path.Combine(root, "runtimes", "python", "windows-x64", "python.exe");
var worker = Path.Combine(root, "runtimes", "python", "worker.py");
var fixture = Path.Combine(AppContext.BaseDirectory, "fixture");
Directory.CreateDirectory(fixture);
static void Check(bool condition, string failure) { if (!condition) throw new Exception(failure); }
foreach (var text in new[] { "127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1" })
{
    var context = new DefaultHttpContext();
    context.Features.Set(new GatewayReadinessPeer(IPAddress.Parse(text)));
    context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.2");
    Check(GatewayReadiness.IsLocalPeer(context), "Loopback transport peer was rejected.");
}
foreach (var text in new string?[] { null, "198.51.100.2", "::ffff:198.51.100.2" })
{
    var context = new DefaultHttpContext();
    context.Features.Set(new GatewayReadinessPeer(text is null ? null : IPAddress.Parse(text)));
    context.Connection.RemoteIpAddress = IPAddress.Loopback;
    context.Request.Headers["X-Forwarded-For"] = "127.0.0.1";
    Check(!GatewayReadiness.IsLocalPeer(context), "Missing/remote transport peer trusted rewritten connection or forwarded headers.");
}
Check(!GatewayReadiness.IsLocalPeer(new DefaultHttpContext()), "Missing transport feature was treated as local.");
Console.WriteLine("PASS raw-peer loopback, mapped IPv4, null/remote and spoofed-forwarding policy");

var calls = 0;
var gate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
using var ready = new GatewayReadiness(async cancellation => { Interlocked.Increment(ref calls); return await gate.Task.WaitAsync(cancellation); });
Check(!ready.Snapshot().PythonAvailable && ready.Snapshot().Status == "not-ready", "Initial state claimed readiness.");
var starts = Enumerable.Range(0, 20).Select(_ => ready.StartAsync(CancellationToken.None)).ToArray();
Check(calls == 1, "Repeated startup launched more than one probe.");
gate.SetResult(true); await Task.WhenAll(starts);
for (var index = 0; index < 100; index++) Check(ready.Snapshot().PythonAvailable, "Cached success missing.");
Check(calls == 1 && ready.Snapshot().ProcessId == Environment.ProcessId, "Polling reran a probe or returned the wrong process.");
using var failed = new GatewayReadiness(_ => throw new InvalidOperationException("secret-canary"));
await failed.StartAsync(CancellationToken.None);
Check(failed.Snapshot().Status == "not-ready" && !JsonSerializer.Serialize(failed.Snapshot()).Contains("secret-canary"), "Failure leaked or claimed readiness.");
Console.WriteLine("PASS single-flight startup, cached observations, process identity and sanitized failure");

using var cancelled = new GatewayReadiness(async token => { await Task.Delay(Timeout.Infinite, token); return true; });
using var startupCancellation = new CancellationTokenSource();
var cancelledStart = cancelled.StartAsync(startupCancellation.Token); startupCancellation.Cancel();
await cancelledStart.WaitAsync(TimeSpan.FromSeconds(2));
Check(!cancelled.Snapshot().PythonAvailable, "Cancelled startup became ready.");
using var timed = new GatewayReadiness(async token => { await Task.Delay(Timeout.Infinite, token); return true; }, TimeSpan.FromMilliseconds(100));
await timed.StartAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(2));
Check(!timed.Snapshot().PythonAvailable, "Timed-out startup became ready.");
Console.WriteLine("PASS startup cancellation and deadline fail closed");

var configured = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Python:Executable"] = "configured-python" }).Build();
var previous = Environment.GetEnvironmentVariable("SPARKSTUDIO_PYTHON");
try
{
    Environment.SetEnvironmentVariable("SPARKSTUDIO_PYTHON", null);
    Check(GatewayReadiness.FindPython(configured) == "configured-python", "Configured Python was ignored.");
    Environment.SetEnvironmentVariable("SPARKSTUDIO_PYTHON", "environment-python");
    Check(GatewayReadiness.FindPython(configured) == "environment-python", "Python environment precedence changed.");
}
finally { Environment.SetEnvironmentVariable("SPARKSTUDIO_PYTHON", previous); }
using var actual = new GatewayReadiness(token => GatewayReadiness.ProbePythonAsync(python, worker, token));
await actual.StartAsync(CancellationToken.None);
Check(actual.Snapshot().PythonAvailable, "Bundled CPython/worker fixed startup test failed.");
using var missing = new GatewayReadiness(token => GatewayReadiness.ProbePythonAsync(Path.Combine(fixture, "missing.exe"), worker, token));
await missing.StartAsync(CancellationToken.None);
Check(!missing.Snapshot().PythonAvailable, "Missing executable claimed readiness.");
using var absentWorker = new GatewayReadiness(token => GatewayReadiness.ProbePythonAsync(python, Path.Combine(fixture, "missing.py"), token));
await absentWorker.StartAsync(CancellationToken.None);
Check(!absentWorker.Snapshot().PythonAvailable, "Missing worker claimed readiness.");
Console.WriteLine("PASS configured interpreter precedence, real bundled Python/worker success and missing payload failures");

var brokenWorker = Path.Combine(fixture, "broken.py"); await File.WriteAllTextAsync(brokenWorker, "this is not valid Python !!!");
using var broken = new GatewayReadiness(token => GatewayReadiness.ProbePythonAsync(python, brokenWorker, token));
await broken.StartAsync(CancellationToken.None);
Check(!broken.Snapshot().PythonAvailable, "Invalid worker claimed readiness.");
var hangingWorker = Path.Combine(fixture, "hanging.py"); var pidPath = Path.Combine(fixture, "probe.pid");
await File.WriteAllTextAsync(hangingWorker, "import os,time\nopen(" + JsonSerializer.Serialize(pidPath) + ", 'w').write(str(os.getpid()))\ntime.sleep(30)\n");
using var hanging = new GatewayReadiness(token => GatewayReadiness.ProbePythonAsync(python, hangingWorker, token), TimeSpan.FromMilliseconds(1000));
var clock = Stopwatch.StartNew(); await hanging.StartAsync(CancellationToken.None);
Check(!hanging.Snapshot().PythonAvailable && clock.Elapsed < TimeSpan.FromSeconds(4), "Hanging worker escaped deadline.");
Check(File.Exists(pidPath), "Hanging child never started; termination was not exercised.");
var childId = int.Parse(await File.ReadAllTextAsync(pidPath));
try { using var child = Process.GetProcessById(childId); Check(child.HasExited, "Owned child survived cancellation."); }
catch (ArgumentException) { }
Console.WriteLine("PASS broken worker fails quietly; bounded timeout terminates its actual owned child");

var builder = WebApplication.CreateBuilder(); builder.Logging.ClearProviders();
builder.WebHost.ConfigureKestrel(options => { GatewayReadiness.ConfigureTransport(options); options.Listen(IPAddress.Loopback, 0); });
await using var app = builder.Build();
app.UseRouting();
app.Use(async (context, next) => { context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.2"); await next(); });
app.MapGet("/api/ready", (HttpContext context) => GatewayReadiness.Respond(context, actual));
app.MapGet("/failed", (HttpContext context) => GatewayReadiness.Respond(context, failed));
app.MapGet("/remote", (HttpContext context) => { context.Features.Set(new GatewayReadinessPeer(IPAddress.Parse("198.51.100.2"))); return GatewayReadiness.Respond(context, actual); });
await app.StartAsync();
var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
using var http = new HttpClient { BaseAddress = new Uri(address) };
foreach (var test in new[] { ("/api/ready", 200, true, "ready"), ("/failed", 503, false, "not-ready") })
{
    using var response = await http.GetAsync(test.Item1);
    Check((int)response.StatusCode == test.Item2 && response.Headers.CacheControl?.NoStore == true, "Response status/cache policy changed.");
    using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()); var value = json.RootElement;
    Check(value.EnumerateObject().Select(property => property.Name).Order().SequenceEqual(new[] { "processId", "product", "pythonAvailable", "status" }), "Readiness disclosed extra fields.");
    Check(value.GetProperty("product").GetString() == "SparkStudio" && value.GetProperty("status").GetString() == test.Item4 && value.GetProperty("pythonAvailable").GetBoolean() == test.Item3 && value.GetProperty("processId").GetInt32() == Environment.ProcessId, "Readiness response contract mismatch.");
}
using (var remote = await http.GetAsync("/remote")) Check((int)remote.StatusCode == 403 && (await remote.Content.ReadAsStringAsync()).Length == 0, "Remote request disclosed readiness.");
await app.StopAsync();
await actual.StopAsync(CancellationToken.None);
Check(!actual.Snapshot().PythonAvailable, "Stopped host retained readiness.");
Console.WriteLine("PASS real Kestrel raw-peer capture survives request rewriting; exact anonymous JSON/503/403/no-store contract");
Console.WriteLine("6 gateway readiness groups passed.");
`);
const dotnet = path.join(root, '.tools/dotnet/dotnet.exe');
await mkdir(path.join(directory, 'dotnet-roaming'), { recursive: true });
const options = { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120000, env: { ...process.env, APPDATA: path.join(directory, 'dotnet-roaming'), DOTNET_CLI_HOME: path.join(root, '.tools/dotnet-home'), NUGET_PACKAGES: path.join(root, '.tools/nuget'), DOTNET_CLI_TELEMETRY_OPTOUT: '1' } };
for (const args of [
  ['restore', path.join(directory, 'ReadyCheck.csproj'), '--configfile', path.join(directory, 'NuGet.Config'), '-p:NuGetAudit=false', '--verbosity', 'quiet'],
  ['run', '--project', path.join(directory, 'ReadyCheck.csproj'), '--no-restore', '--no-launch-profile', '--configuration', 'ReadinessCheck', '--verbosity', 'quiet', '--', root]
]) {
  const result = spawnSync(dotnet, args, options);
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  assert.equal(result.status, 0, `Readiness fixture failed (${result.error?.message ?? 'see output'}).`);
}
