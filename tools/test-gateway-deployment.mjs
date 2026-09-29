#!/usr/bin/env node
// --model exercises allowlisted observations offline; the default mode uses disposable accounts on port 5091 only.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

if (process.argv.includes('--model')) await modelChecks();
else await apiChecks();

async function modelChecks() {
  const root = process.cwd(), directory = path.resolve('.data/test-evidence', `gateway-deployment-${randomUUID()}`);
  assert.ok(directory.startsWith(path.resolve('.data') + path.sep));
  await mkdir(directory, { recursive: true });
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const project = path.join(directory, 'GatewayDeploymentCheck.csproj');
  await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><ProjectReference Include="${escape(path.join(root, 'src/SparkStudio.Gateway/SparkStudio.Gateway.csproj'))}"/></ItemGroup></Project>`);
  await writeFile(path.join(directory, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
  await writeFile(path.join(directory, 'Program.cs'), String.raw`
using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using SparkStudio.Gateway;

foreach (var key in new[] { "SPARKSTUDIO_DATA_DIR", "SPARKSTUDIO_PUBLIC_BASE_URL", "ASPNETCORE_IIS_PHYSICAL_PATH", "ASPNETCORE_PORT" }) Environment.SetEnvironmentVariable(key, null);
var directory = Path.Combine(AppContext.BaseDirectory, "fixture");
var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> {
  ["Urls"] = "http://127.0.0.1:7000", ["AllowedHosts"] = "localhost;127.0.0.1;[::1]", ["DataDirectory"] = directory,
  ["environment"] = "Fixture", ["Security:PublicBaseUrl"] = "https://bootstrap.example",
  ["ConnectionStrings:Database"] = "excluded-connection-canary", ["Kestrel:Certificates:Default:Password"] = "excluded-password-canary",
  ["Unrelated:PrivateValue"] = "excluded-private-canary"
}).Build();
var host = new FixtureHost();
var deployment = new GatewayDeployment(config, host, directory);
var security = new SecurityStore(directory, "https://saved.example");
security.Setup(File.ReadAllText(Path.Combine(directory, "security", "setup-code.txt")).Trim(), new("fixture-admin", Convert.ToHexString(RandomNumberGenerator.GetBytes(32)), "Fixture"));
var server = new FixtureServer("http://127.0.0.1:5091");
var context = new DefaultHttpContext();
context.Request.Scheme = "http"; context.Request.Host = new HostString("127.0.0.1", 5091); context.Connection.RemoteIpAddress = IPAddress.Loopback;
var first = deployment.Snapshot(context, server, security);
Assert(first.Configuration.Urls.Values.SequenceEqual(new[] { "http://127.0.0.1:7000" }), "Startup URL missing.");
Assert(first.Listeners.Addresses.SequenceEqual(new[] { "http://127.0.0.1:5091" }), "Observed listener replaced by configuration.");
Assert(first.Configuration.Urls.Source == "In-memory host configuration", "Wrong provider source.");
Assert(first.PublicOperatorAddress.Value == "https://saved.example" && first.PublicOperatorAddress.Source == "gateway-settings", "Bootstrap replaced persisted public URL.");
Console.WriteLine("PASS configured addresses, observed listeners and persisted public URL retain separate sources");

config["Urls"] = "https://changed.example:7443"; config["AllowedHosts"] = "changed.example"; config["DataDirectory"] = "changed";
var later = deployment.Snapshot(context, server, security);
Assert(JsonSerializer.Serialize(first.Configuration) == JsonSerializer.Serialize(later.Configuration), "Reload changed startup snapshot.");
Assert(later.ObservedAt >= first.ObservedAt && later.StartedAt == first.StartedAt, "Observation/startup timestamps are misleading.");
Console.WriteLine("PASS startup values remain frozen while observations carry fresh timestamps");

security.UpdateSettings(new(security.Settings.Revision, null, new()));
context.Request.Headers["X-Forwarded-Host"] = "forged.example"; context.Request.Headers["X-Forwarded-Proto"] = "https"; context.Request.Headers["X-Forwarded-For"] = "198.51.100.10";
var fallback = deployment.Snapshot(context, server, security);
Assert(fallback.PublicOperatorAddress.Value == "http://127.0.0.1:5091" && fallback.PublicOperatorAddress.Source == "request-origin", "Blank saved URL must use request origin, not bootstrap or forwarded header.");
Assert(!fallback.Transport.RequestHttps && fallback.Transport.RequestLoopback && fallback.Transport.ForwardedHeadersEnabled == false, "Default request observations read forwarded header strings.");
Assert(fallback.Transport.Certificate.Status == "unavailable" && fallback.Transport.Certificate.ExpiresAt is null, "Plain HTTP claimed a certificate expiry.");
Console.WriteLine("PASS blank public setting uses the actual request origin; direct header strings cannot fabricate transport/certificates");

var hostile = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> {
  ["Urls"] = "http://127.0.0.1:5091;https://user:url-secret-canary@example.test;https://example.test/?url-query-canary;https://example.test/#url-fragment-canary;https://example.test/url-path-canary;https://example.test:99999",
  ["AllowedHosts"] = "localhost;host-secret-canary@example.test;host-query-canary?",
  ["Kestrel:Endpoints:PasswordLikeName:Url"] = "https://user:endpoint-secret-canary@example.test",
  ["Kestrel:Certificates:Default:Password"] = "excluded-password-canary",
  ["ConnectionStrings:Database"] = "excluded-connection-canary", ["Unrelated:PrivateValue"] = "excluded-private-canary"
}).Build();
var redacted = new GatewayDeployment(hostile, host, directory).Snapshot(context, server, security);
Assert(redacted.Configuration.Urls.OmittedEntries == 5 && redacted.Configuration.KestrelEndpoints.OmittedEntries == 1 && redacted.Configuration.AllowedHosts.OmittedEntries == 2, "Unsafe entries were not omitted/countable.");
var serialized = JsonSerializer.Serialize(redacted);
foreach (var canary in new[] { "url-secret-canary", "url-query-canary", "url-fragment-canary", "url-path-canary", "host-secret-canary", "host-query-canary", "endpoint-secret-canary", "PasswordLikeName", "excluded-password-canary", "excluded-connection-canary", "excluded-private-canary" }) Assert(!serialized.Contains(canary), "An excluded configuration value leaked.");
Console.WriteLine("PASS unsafe addresses and non-allowlisted configuration values never enter the snapshot");

var unknown = deployment.Snapshot(context, new FixtureServer(), security);
Assert(unknown.Listeners.Addresses.Length == 0 && unknown.Listeners.HttpsEnabled is null && unknown.Listeners.LoopbackOnly is null, "No listeners appeared as known HTTP/loopback.");
var partial = deployment.Snapshot(context, new FixtureServer("http://127.0.0.1:5091", "https://user:listener-canary@example.test"), security);
Assert(partial.Listeners.OmittedEntries == 1 && partial.Listeners.HttpsEnabled is null && partial.Listeners.LoopbackOnly is null, "Partial listener set appeared complete.");
Assert(!JsonSerializer.Serialize(partial).Contains("listener-canary"), "Listener credentials leaked.");
var tls = deployment.Snapshot(context, new FixtureServer("https://0.0.0.0:7443", "invalid"), security);
Assert(tls.Listeners.HttpsEnabled == true && tls.Listeners.LoopbackOnly == false && !tls.Transport.RequestHttps, "Listener and request transport states were conflated.");
Console.WriteLine("PASS unknown/partial listener inventory stays explicit while positive HTTPS/nonloopback observations remain known");

var many = new ConfigurationBuilder().AddInMemoryCollection(Enumerable.Range(0, 150).ToDictionary(i => $"Kestrel:Endpoints:e{i:D3}:Url", i => (string?)$"http://127.0.0.1:{10000+i}")).Build();
var bounded = new GatewayDeployment(many, host, directory).Snapshot(context, new FixtureServer(Enumerable.Range(0, 150).Select(i => $"http://127.0.0.1:{10000+i}").ToArray()), security);
Assert(bounded.Configuration.KestrelEndpoints.Values.Length == 128 && bounded.Configuration.KestrelEndpoints.OmittedEntries > 0 && bounded.Listeners.Addresses.Length == 128 && bounded.Listeners.OmittedEntries > 0, "Listener/configuration bounds silently truncated.");
Console.WriteLine("PASS large configured and observed address lists are bounded with omission indicators");

config["FORWARDEDHEADERS_ENABLED"] = "true";
var forwarded = new GatewayDeployment(config, host, directory);
config["FORWARDEDHEADERS_ENABLED"] = "false";
Assert(forwarded.Snapshot(context, server, security).Transport is { ForwardedHeadersHostOverride: true, ForwardedHeadersEnabled: true }, "Framework forwarding startup override was hidden or reread.");
Environment.SetEnvironmentVariable("ASPNETCORE_IIS_PHYSICAL_PATH", "not-returned-iis-path-canary");
var iis = new GatewayDeployment(config, host, directory).Snapshot(context, server, security);
Assert(iis.Transport.ForwardedHeadersEnabled is null && !JsonSerializer.Serialize(iis).Contains("not-returned-iis-path-canary"), "IIS processing was claimed disabled or its environment value leaked.");
Console.WriteLine("PASS framework forwarding and IIS indicators qualify observations without changing transport policy");

var command = new ConfigurationBuilder().AddCommandLine(new[] { "--Urls", "http://localhost:5012" }).Build();
Assert(new GatewayDeployment(command, host, directory).Snapshot(context, server, security).Configuration.Urls.Source == "Command-line arguments", "CLI provenance missing.");
Environment.SetEnvironmentVariable("SPARKSTUDIO_DATA_DIR", directory);
Assert(new GatewayDeployment(command, host, directory).Snapshot(context, server, security).Configuration.DataDirectory.Source == "SPARKSTUDIO_DATA_DIR environment variable", "Explicit data-directory env precedence missing.");
Console.WriteLine("PASS allowlisted provider labels and data-directory environment precedence are recorded");
Console.WriteLine("8 offline gateway deployment groups passed.");

static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
sealed class FixtureHost : IHostEnvironment {
  public string EnvironmentName { get; set; } = "Fixture"; public string ApplicationName { get; set; } = "Fixture";
  public string ContentRootPath { get; set; } = AppContext.BaseDirectory; public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
}
sealed class FixtureServer : IServer {
  public IFeatureCollection Features { get; } = new FeatureCollection();
  public FixtureServer(params string[] addresses) { var feature = new ServerAddressesFeature(); foreach (var address in addresses) feature.Addresses.Add(address); Features.Set<IServerAddressesFeature>(feature); }
  public Task StartAsync<TContext>(IHttpApplication<TContext> application, CancellationToken cancellationToken) where TContext : notnull => Task.CompletedTask;
  public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask; public void Dispose() { }
}
`);
  const dotnet = path.join(root, '.tools/dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, DOTNET_CLI_HOME: path.join(root, '.tools/dotnet-home'), NUGET_PACKAGES: path.join(root, '.tools/nuget'), DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' } };
  const restore = spawnSync(dotnet, ['restore', project, '--configfile', path.join(directory, 'NuGet.Config'), '-p:NuGetAudit=false', '--verbosity', 'quiet'], options);
  process.stdout.write(restore.stdout || ''); process.stderr.write(restore.stderr || ''); assert.equal(restore.status, 0, 'Deployment model harness restore failed.');
  const result = spawnSync(dotnet, ['run', '--project', project, '--configuration', 'GatewayDeploymentCheck', '--no-restore', '--no-launch-profile', '--verbosity', 'quiet'], options);
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); assert.equal(result.status, 0, 'Deployment model checks failed.');
}

async function apiChecks() {
  const filename = path.resolve(process.env.SPARKSTUDIO_TEST_AUTH_FILE ?? '.data/test-evidence/security-test-accounts.json');
  assert.ok(filename.startsWith(path.resolve('.data') + path.sep));
  const accounts = JSON.parse(await readFile(filename, 'utf8')), base = new URL(accounts.baseUrl);
  assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && base.port === '5091' && base.pathname === '/');
  const sessions = [];
  async function login(account, audience = 'engineering') {
    const response = await fetch(new URL('/api/auth/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...account, audience }) });
    assert.equal(response.status, 200); const body = await response.json();
    const session = { cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), csrf: body.csrfToken, audience };
    sessions.push(session); return session;
  }
  async function request(session, extra = {}, route = '/api/gateway/deployment') {
    const headers = new Headers(extra); if (session) { headers.set('Cookie', session.cookie); headers.set('X-SPARK-AUDIENCE', session.audience); }
    return fetch(new URL(route, base), { headers });
  }
  try {
    const admin = await login(accounts.admin), operator = await login(accounts.admin, 'operator'), designer = await login(accounts.designer);
    assert.equal((await request()).status, 401); assert.equal((await request(operator)).status, 401); assert.equal((await request(designer)).status, 403);
    const response = await request(admin); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const snapshot = await response.json();
    assert.deepEqual(Object.keys(snapshot).sort(), ['observedAt', 'startedAt', 'environment', 'hosting', 'listeners', 'configuration', 'publicOperatorAddress', 'transport'].sort());
    console.log('PASS deployment endpoint is engineering-administrator-only and disables response caching');
    assert.ok(Number.isFinite(Date.parse(snapshot.observedAt))); assert.ok(Number.isFinite(Date.parse(snapshot.configuration.capturedAt)));
    assert.ok(snapshot.listeners.addresses.includes(base.origin)); assert.equal(snapshot.listeners.httpsEnabled, false); assert.equal(snapshot.listeners.loopbackOnly, true);
    assert.equal(snapshot.transport.requestHttps, false); assert.equal(snapshot.transport.requestLoopback, true); assert.equal(snapshot.transport.forwardedHeadersEnabled, false);
    assert.equal(snapshot.transport.forwardedHeadersHostOverride, false); assert.equal(snapshot.transport.certificate.status, 'unavailable'); assert.equal(snapshot.transport.certificate.expiresAt, null);
    assert.ok(['windows-service', 'container', 'interactive', 'unknown'].includes(snapshot.hosting.kind));
    console.log('PASS isolated HTTP listeners, hosting observations and unavailable certificate status are explicit');
    const canary = 'deployment-forwarded-canary';
    const forwardedResponse = await request(admin, { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': `${canary}.example`, 'X-Forwarded-For': '198.51.100.10' });
    assert.equal(forwardedResponse.status, 200); const forwarded = await forwardedResponse.json();
    assert.deepEqual(forwarded.transport, snapshot.transport); assert.deepEqual(forwarded.publicOperatorAddress, snapshot.publicOperatorAddress);
    const text = JSON.stringify(forwarded);
    for (const secret of [canary, accounts.admin.password, admin.csrf, admin.cookie]) assert.ok(!text.includes(secret));
    console.log('PASS forged forwarded headers do not change default transport observations or expose request secrets');
    const settingsResponse = await request(admin, {}, '/api/security/settings'); assert.equal(settingsResponse.status, 200); const settings = await settingsResponse.json();
    assert.equal(snapshot.publicOperatorAddress.value, settings.publicBaseUrl ?? base.origin); assert.equal(snapshot.publicOperatorAddress.source, settings.publicBaseUrl ? 'gateway-settings' : 'request-origin');
    assert.deepEqual(snapshot.configuration, forwarded.configuration);
    assert.equal((await request(admin, { Origin: 'https://cross-origin.example' })).status, 403);
    console.log('PASS effective saved public URL, stable startup provenance and same-origin access hold');
    console.log('4 gateway deployment API groups passed.');
  } finally {
    for (const session of sessions) await fetch(new URL('/api/auth/logout', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-SPARK-AUDIENCE': session.audience, 'X-SPARK-CSRF': session.csrf }, body: JSON.stringify({ audience: session.audience }) });
  }
}
