#!/usr/bin/env node
// Execute the actual gateway capability store with a controlled clock and real
// SecurityStore sessions. Generated harness output stays under ignored .data/.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const root = process.cwd(), directory = path.resolve('.data/test-evidence', `preview-store-${randomUUID()}`);
assert.ok(directory.startsWith(path.resolve('.data') + path.sep));
await mkdir(directory, { recursive: true });
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
await writeFile(path.join(directory, 'PreviewStoreCheck.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><ProjectReference Include="${escape(path.join(root, 'src/SparkStudio.Gateway/SparkStudio.Gateway.csproj'))}"/></ItemGroup></Project>`);
await writeFile(path.join(directory, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
await writeFile(path.join(directory, 'Program.cs'), String.raw`
using System.Reflection;
using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using SparkStudio.Gateway;

var data = Path.Combine(AppContext.BaseDirectory, "fixture");
var security = new SecurityStore(data);
var user = security.Setup(File.ReadAllText(Path.Combine(data, "security", "setup-code.txt")).Trim(), new SecurityCreateUser("preview-test", Guid.NewGuid().ToString("N"), GatewayAdmin: true));
var engineering = security.CreateSession(user, "engineering");
var services = new ServiceCollection().AddSingleton(security).BuildServiceProvider();
var context = new DefaultHttpContext { RequestServices = services, User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("spark:session", engineering.Id) }, "test")) };
context.Items[typeof(GatewaySecurity).GetField("SessionKey", BindingFlags.NonPublic | BindingFlags.Static)!.GetValue(null)!] = engineering;
context.Items["spark.actor"] = user; context.Items["spark.audience"] = "engineering"; context.Items["spark.project"] = "fixture";
var clock = new TestClock();
using var sessions = new PreviewSessions(clock);
var first = sessions.Start(context, "read-only"); context.Request.Headers[PreviewSessions.Header] = first.Token;
var cancellation = sessions.Require(context);
Assert(!cancellation.IsCancellationRequested, "Fresh capability must be current.");
clock.Now += TimeSpan.FromMinutes(15);
Deny(() => sessions.Require(context), "Capability must be expired at its exact deadline.");
context.Request.Headers.Remove(PreviewSessions.Header);
var next = sessions.Start(context, "live-actions");
Assert(cancellation.IsCancellationRequested, "Purging an expired capability must cancel its work.");
context.Request.Headers[PreviewSessions.Header] = next.Token;
var liveCancellation = sessions.Require(context, liveActions: true);
sessions.Revoke(context);
Assert(liveCancellation.IsCancellationRequested, "Revocation must cancel live work.");
Deny(() => sessions.Require(context), "Revoked capability must stay denied.");
context.Request.Headers.Remove(PreviewSessions.Header);
var current = sessions.Start(context, "read-only");
context.Request.Headers[PreviewSessions.Header] = current.Token;
security.RevokeSession(engineering.Id);
Deny(() => sessions.Require(context), "Revoking authentication must invalidate the capability.");
Console.WriteLine("PASS exact expiry, expired cleanup cancellation, explicit revocation and authentication revocation");
static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
static void Deny(Action action, string message) { try { action(); } catch (BadHttpRequestException error) when (error.StatusCode == 403) { return; } throw new Exception(message); }
sealed class TestClock : TimeProvider { public DateTimeOffset Now = DateTimeOffset.UtcNow; public override DateTimeOffset GetUtcNow() => Now; }
`);
const dotnet = path.join(root, '.tools/dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
const options = {
  cwd: root, encoding: 'utf8', env: { ...process.env, DOTNET_CLI_HOME: path.join(root, '.tools/dotnet-home'), NUGET_PACKAGES: path.join(root, '.tools/nuget'), DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' },
};
const restore = spawnSync(dotnet, ['restore', path.join(directory, 'PreviewStoreCheck.csproj'), '--configfile', path.join(directory, 'NuGet.Config'), '-p:NuGetAudit=false', '--verbosity', 'quiet'], options);
process.stdout.write(restore.stdout || ''); process.stderr.write(restore.stderr || '');
assert.equal(restore.status, 0, 'Preview store harness restore failed.');
const result = spawnSync(dotnet, ['run', '--project', path.join(directory, 'PreviewStoreCheck.csproj'), '--configuration', 'PreviewStoreCheck', '--no-restore', '--no-launch-profile', '--verbosity', 'quiet'], options);
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
assert.equal(result.status, 0, 'Preview store checks failed.');
