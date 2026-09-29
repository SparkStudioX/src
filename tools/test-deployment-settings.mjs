#!/usr/bin/env node
// Isolated tests only: --model creates local fixtures; default uses disposable accounts on 5091.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

if (process.argv.includes('--model')) await model(); else await integration();

async function model() {
  const root = process.cwd(), directory = path.resolve('.data/test-evidence', `deployment-settings-${randomUUID()}`);
  assert.ok(directory.startsWith(path.resolve('.data') + path.sep));
  await mkdir(directory, { recursive: true });
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const project = path.join(directory, 'DeploymentSettingsCheck.csproj');
  await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><ProjectReference Include="${escape(path.join(root, 'src/SparkStudio.Gateway/SparkStudio.Gateway.csproj'))}"/></ItemGroup></Project>`);
  await writeFile(path.join(directory, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
  await writeFile(path.join(directory, 'Program.cs'), String.raw`
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.HostFiltering;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using SparkStudio.Gateway;

Environment.SetEnvironmentVariable("SPARKSTUDIO_DEPLOYMENT_DISABLE", null);
var directory = Path.Combine(AppContext.BaseDirectory, "fixture"); Directory.CreateDirectory(directory);
var store = new DeploymentSettings(directory);
var initial = store.Snapshot();
Assert(initial.Revision == "0" && !initial.Saved.Enabled && !initial.RestartRequired, "Unexpected initial state.");
foreach (var url in new[] { "http://0.0.0.0:5090", "http://+:5090", "http://example.test:5090", "http://127.0.0.1:80", "http://127.0.0.1:5090/path", "http://user:secret@127.0.0.1:5090", "http://127.0.0.1:5090/?x=secret", "ftp://127.0.0.1:5090", "http://[::ffff:127.0.0.1]:5090", "http://127.0.0.2:5090" })
  Throws<ArgumentException>(() => store.Validate(new(true, url, null, null)));
Throws<ArgumentException>(() => store.Validate(new(true, "http://127.0.0.1:5090", "cert.pem", "key.pem")));
Throws<ArgumentException>(() => store.Validate(new(true, "https://127.0.0.1:5443", "../cert.pem", "key.pem")));
Assert(store.Validate(new(true, "http://127.0.0.1:5090/", null, null)).Settings.Url == "http://127.0.0.1:5090", "URL normalization failed.");
Console.WriteLine("PASS strict loopback-only listener validation rejects credentials, paths and unsupported certificate references");

var httpIntent = new DeploymentIntent(true, "http://127.0.0.1:15090", null, null);
var saved = store.Save(new(initial.Revision, httpIntent));
Assert(saved.RestartRequired && saved.State == "restart-required" && saved.StartupIntent == initial.Saved, "Saving changed startup intent.");
Throws<InvalidOperationException>(() => store.Save(new(initial.Revision, httpIntent)));
Assert(new DeploymentSettings(directory).Snapshot().Saved == httpIntent, "Restart cannot load saved intent.");
var changed = store.Save(new(saved.Revision, httpIntent with { Url = "http://127.0.0.1:15091" }));
Assert(changed.PreviousAvailable, "No previous version retained.");
var restored = store.Restore(new(changed.Revision));
Assert(restored.Saved == httpIntent && restored.Revision != changed.Revision, "Restore did not use a fresh revision.");
Console.WriteLine("PASS atomic settings survive a fresh store; stale revisions fail and previous intent restores explicitly");

var config = new ConfigurationBuilder().AddCommandLine(new[] { "--urls", "http://127.0.0.1:5091" }).Build();
Assert(DeploymentSettings.ExternalOverride(config) is not null, "Command-line URL did not override saved settings.");
var kestrel = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?> { ["Kestrel:Endpoints:Local:Url"] = "https://127.0.0.1:5443" }).Build();
Assert(DeploymentSettings.ExternalOverride(kestrel) is not null, "Kestrel endpoint did not override saved settings.");
Environment.SetEnvironmentVariable("SPARKSTUDIO_DEPLOYMENT_DISABLE", "1");
Assert(DeploymentSettings.ExternalOverride(new ConfigurationBuilder().Build())?.Contains("DISABLE") == true, "Recovery bypass missing.");
Environment.SetEnvironmentVariable("SPARKSTUDIO_DEPLOYMENT_DISABLE", null);
var external = new DeploymentSettings(directory, "External override fixture");
var ignoredBuilder = Builder(); external.ApplyStartup(ignoredBuilder);
Assert(external.Snapshot().StartupState == "overridden" && external.Snapshot().State == "overridden", "Override not reported.");
var conflictingInstaller = Builder(); conflictingInstaller.Configuration["InstallerManagementPort"] = "15090"; conflictingInstaller.Configuration["Urls"] = "http://0.0.0.0:15090";
Throws<InvalidOperationException>(() => DeploymentSettings.Configure(conflictingInstaller, directory));
File.WriteAllText(Path.Combine(AppContext.BaseDirectory, "appsettings.Production.json"), "{\"Kestrel\":{\"Endpoints\":{\"Lan\":{\"Url\":\"http://0.0.0.0:15090\"}}}}");
var profileOverride = Builder(); profileOverride.Configuration.AddJsonFile("appsettings.Production.json", optional: false); profileOverride.Configuration["InstallerManagementPort"] = "15090";
Throws<InvalidOperationException>(() => DeploymentSettings.Configure(profileOverride, directory));
var quarantinedInstaller = Builder(); quarantinedInstaller.Configuration["InstallerManagementPort"] = "15090"; quarantinedInstaller.Configuration["Urls"] = "http://0.0.0.0:15090";
var quarantineSnapshot = DeploymentSettings.Configure(quarantinedInstaller, directory, "Gateway recovery quarantine").Snapshot();
Assert(quarantineSnapshot.OverrideReason == "Gateway recovery quarantine", "Quarantine did not supersede conflicting installer overrides.");
Console.WriteLine("PASS external overrides bypass ordinary managed settings; installer-managed conflicting overrides fail closed and recovery isolation takes precedence");

var filename = Path.Combine(directory, "deployment.json");
var bytes = File.ReadAllBytes(filename);
File.WriteAllText(filename, "{ invalid-json-canary");
Throws<InvalidOperationException>(() => store.Save(new(restored.Revision, httpIntent)));
var corrupt = new DeploymentSettings(directory); corrupt.ApplyStartup(Builder());
Assert(corrupt.Snapshot().Recovery is not null && corrupt.Snapshot().StartupState == "recovery", "Invalid document did not enter recovery.");
var usablePrevious = File.ReadAllBytes(filename + ".previous");
if (OperatingSystem.IsWindows())
{
  // Read sharing permits validation/fingerprinting but prevents atomic replacement on Windows.
  using (var locked = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.Read))
    Throws<UnauthorizedAccessException>(() => corrupt.Restore(new(corrupt.Snapshot().Revision)));
  Assert(File.ReadAllBytes(filename + ".previous").SequenceEqual(usablePrevious), "Failed recovery replaced the last usable previous file with corrupted bytes.");
}
var disabled = corrupt.Save(new(corrupt.Snapshot().Revision, DeploymentSettings.Default));
Assert(!disabled.Saved.Enabled && disabled.Recovery is null && !File.ReadAllText(filename).Contains("invalid-json-canary"), "Explicit recovery did not replace invalid document.");
Assert(File.ReadAllBytes(filename + ".previous").SequenceEqual(usablePrevious), "Replacing a damaged current file destroyed previous recovery settings.");
File.WriteAllBytes(filename, bytes);
Console.WriteLine("PASS external file edits reject saves; malformed persisted files retain host configuration and can be replaced");

var certificateDirectory = Path.Combine(directory, "certificates", "deployment"); Directory.CreateDirectory(certificateDirectory);
using var rsa = RSA.Create(2048);
var certificateRequest = new CertificateRequest("CN=SparkStudio isolated loopback fixture", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
var san = new SubjectAlternativeNameBuilder(); san.AddIpAddress(IPAddress.Loopback); san.AddDnsName("gateway.fixture.test"); certificateRequest.CertificateExtensions.Add(san.Build());
certificateRequest.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
certificateRequest.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new Oid("1.3.6.1.5.5.7.3.1") }, false));
using var certificate = certificateRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddDays(2));
File.WriteAllText(Path.Combine(certificateDirectory, "fixture-cert.pem"), certificate.ExportCertificatePem());
File.WriteAllText(Path.Combine(certificateDirectory, "fixture-key.pem"), rsa.ExportPkcs8PrivateKeyPem());
var tlsPort = Port();
var tlsIntent = new DeploymentIntent(true, $"https://127.0.0.1:{tlsPort}", "fixture-cert.pem", "fixture-key.pem");
var tlsStore = new DeploymentSettings(directory);
var validation = tlsStore.Validate(tlsIntent);
Assert(validation.CertificateExpiresAt > DateTimeOffset.UtcNow, "Expiry observation missing.");
Throws<ArgumentException>(() => tlsStore.Validate(tlsIntent with { Url = $"https://[::1]:{tlsPort}" }));
var clientCertificateRequest = new CertificateRequest("CN=Client-only fixture", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
clientCertificateRequest.CertificateExtensions.Add(san.Build());
clientCertificateRequest.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new Oid("1.3.6.1.5.5.7.3.2") }, false));
using var clientCertificate = clientCertificateRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddDays(2));
File.WriteAllText(Path.Combine(certificateDirectory, "client-cert.pem"), clientCertificate.ExportCertificatePem());
Throws<ArgumentException>(() => tlsStore.Validate(tlsIntent with { CertificateFile = "client-cert.pem" }));
tlsStore.Save(new(tlsStore.Snapshot().Revision, tlsIntent));
Assert(!File.ReadAllText(filename).Contains("PRIVATE KEY"), "Private key bytes entered deployment settings.");
Console.WriteLine("PASS offline PEM pair validates expiry, matching key and SAN without storing private key material");

var startup = new DeploymentSettings(directory);
var builder = Builder(); startup.ApplyStartup(builder);
await using (var app = builder.Build())
{
  app.MapGet("/fixture", () => "loopback TLS fixture"); await app.StartAsync();
  using var handler = new HttpClientHandler { ServerCertificateCustomValidationCallback = (_, presented, _, _) => presented?.Thumbprint == certificate.Thumbprint };
  using var client = new HttpClient(handler);
  Assert(await client.GetStringAsync(tlsIntent.Url + "/fixture") == "loopback TLS fixture", "Managed HTTPS listener did not respond.");
  var addresses = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses;
  Assert(addresses.Contains(tlsIntent.Url) && startup.Snapshot().StartupState == "managed", "HTTPS startup observation incorrect.");
  var next = startup.Save(new(startup.Snapshot().Revision, DeploymentSettings.Default));
  Assert(next.RestartRequired && await client.GetStringAsync(tlsIntent.Url + "/fixture") == "loopback TLS fixture", "Saving changed the running listener.");
  await app.StopAsync();
}
Console.WriteLine("PASS real loopback HTTPS handshake uses staged certificate after restart; saving never changes the running listener");

var badCertificateStore = new DeploymentSettings(directory);
badCertificateStore.Save(new(badCertificateStore.Snapshot().Revision, tlsIntent));
File.Delete(Path.Combine(certificateDirectory, "fixture-key.pem"));
var fallback = new DeploymentSettings(directory);
var fallbackBuilder = Builder(); var fallbackUrl = $"http://127.0.0.1:{Port()}"; fallbackBuilder.WebHost.UseUrls(fallbackUrl);
fallback.ApplyStartup(fallbackBuilder);
await using (var app = fallbackBuilder.Build())
{
  app.MapGet("/fixture", () => "recovered"); await app.StartAsync();
  using var client = new HttpClient(); Assert(await client.GetStringAsync(fallbackUrl + "/fixture") == "recovered", "Invalid certificate removed host recovery listener.");
  Assert(fallback.Snapshot().Recovery is not null && fallback.Snapshot().StartupState == "recovery", "Certificate failure hidden.");
  await app.StopAsync();
}
Console.WriteLine("PASS missing certificate at restart preserves the existing host recovery listener");
// Installer-managed LAN TLS is additional to local recovery; certificate identity is the DNS name, never 0.0.0.0.
File.WriteAllText(Path.Combine(certificateDirectory, "fixture-key.pem"), rsa.ExportPkcs8PrivateKeyPem());
var localPort = Port(); var networkPort = Port();
var networkIntent = new DeploymentIntent(true, $"https://0.0.0.0:{networkPort}", "fixture-cert.pem", "fixture-key.pem", "gateway.fixture.test");
var networkStore = new DeploymentSettings(directory, installerManagementPort: localPort);
Throws<ArgumentException>(() => networkStore.Validate(networkIntent with { PublicHostname = null }));
Throws<ArgumentException>(() => networkStore.Validate(networkIntent with { PublicHostname = "different.fixture.test" }));
Throws<ArgumentException>(() => networkStore.Validate(networkIntent with { PublicHostname = "*.fixture.test" }));
Throws<ArgumentException>(() => networkStore.Validate(networkIntent with { Url = $"https://0.0.0.0:{localPort}" }));
networkStore.Save(new(networkStore.Snapshot().Revision, networkIntent));
var networkStartup = new DeploymentSettings(directory, installerManagementPort: localPort);
var networkBuilder = Builder();
File.WriteAllText(Path.Combine(AppContext.BaseDirectory, "appsettings.json"), "{\"AllowedHosts\":\"localhost;127.0.0.1;[::1]\"}");
networkBuilder.Configuration.AddJsonFile("appsettings.json", optional: false);
networkStartup.ApplyStartup(networkBuilder);
networkBuilder.Services.AddHostFiltering(options => options.AllowedHosts = networkBuilder.Configuration["AllowedHosts"]!.Split(';'));
Assert(networkBuilder.Configuration["AllowedHosts"]!.Contains("gateway.fixture.test"), "Public hostname not added to bundled host policy.");
await using (var app = networkBuilder.Build())
{
  app.UseHostFiltering();
  app.MapGet("/fixture", () => "dual listener fixture"); await app.StartAsync();
  using var handler = new HttpClientHandler { UseProxy = false, ServerCertificateCustomValidationCallback = (_, presented, _, _) => presented?.Thumbprint == certificate.Thumbprint };
  using var client = new HttpClient(handler);
  Assert(await client.GetStringAsync($"http://127.0.0.1:{localPort}/fixture") == "dual listener fixture", "Local management listener missing.");
  Assert(await client.GetStringAsync($"https://127.0.0.1:{networkPort}/fixture") == "dual listener fixture", "Network HTTPS listener missing.");
  using var namedRequest = new HttpRequestMessage(HttpMethod.Get, $"https://127.0.0.1:{networkPort}/fixture"); namedRequest.Headers.Host = $"gateway.fixture.test:{networkPort}";
  using var namedResponse = await client.SendAsync(namedRequest); Assert(namedResponse.IsSuccessStatusCode, "DNS Host header was rejected after successful TLS.");
  using var hostileRequest = new HttpRequestMessage(HttpMethod.Get, $"https://127.0.0.1:{networkPort}/fixture"); hostileRequest.Headers.Host = "unrelated.fixture.test";
  using var hostileResponse = await client.SendAsync(hostileRequest); Assert(hostileResponse.StatusCode == HttpStatusCode.BadRequest, "Unrelated Host header was accepted.");
  var addresses = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses;
  Assert(addresses.Count == 2 && addresses.Contains(networkIntent.Url), "Unexpected listener set.");
  Assert(networkStartup.Snapshot().InstallerManagementPort == localPort && networkStartup.Snapshot().Saved.PublicHostname == "gateway.fixture.test", "Managed network identity not observed.");
  await app.StopAsync();
}
var restricted = new DeploymentSettings(directory, installerManagementPort: localPort);
var restrictedBuilder = Builder(); restrictedBuilder.Configuration["AllowedHosts"] = "another.factory.test"; restricted.ApplyStartup(restrictedBuilder);
Assert(restricted.Snapshot().StartupState == "recovery" && restrictedBuilder.Configuration["AllowedHosts"] == "another.factory.test", "Explicit host policy was weakened.");
File.Delete(Path.Combine(certificateDirectory, "fixture-key.pem"));
var networkFallback = new DeploymentSettings(directory, installerManagementPort: localPort);
var networkFallbackBuilder = Builder(); networkFallback.ApplyStartup(networkFallbackBuilder);
await using (var app = networkFallbackBuilder.Build())
{
  app.MapGet("/fixture", () => "local recovery only"); await app.StartAsync();
  var addresses = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses;
  Assert(addresses.Count == 1 && addresses.Single() == $"http://127.0.0.1:{localPort}", "Missing certificate exposed a fallback network listener.");
  Assert(networkFallback.Snapshot().StartupState == "recovery", "Network certificate failure not reported.");
  await app.StopAsync();
}
Console.WriteLine("PASS network HTTPS validates separate DNS identity and port; dual listeners start and invalid certificates retain only local recovery");
Console.WriteLine("8 deployment settings model/TLS groups passed.");

static WebApplicationBuilder Builder() { var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [], ContentRootPath = AppContext.BaseDirectory }); builder.Configuration.Sources.Clear(); builder.Configuration.AddInMemoryCollection(); builder.Logging.ClearProviders(); return builder; }
static int Port() { var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return port; }
static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
static void Throws<T>(Action action) where T : Exception { try { action(); } catch (T) { return; } throw new Exception($"Expected {typeof(T).Name}."); }
`);
  const dotnet = path.join(root, '.tools/dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, DOTNET_CLI_HOME: path.join(root, '.tools/dotnet-home'), NUGET_PACKAGES: path.join(root, '.tools/nuget'), DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' } };
  for (const args of [['restore', project, '--configfile', path.join(directory, 'NuGet.Config'), '-p:NuGetAudit=false', '--verbosity', 'quiet'], ['run', '--project', project, '--configuration', 'DeploymentSettingsCheck', '--no-restore', '--no-launch-profile', '--verbosity', 'quiet']]) {
    const result = spawnSync(dotnet, args, options); process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); assert.equal(result.status, 0, 'Deployment settings fixture failed.');
  }
}

async function integration() {
  const filename = path.resolve(process.env.SPARKSTUDIO_TEST_AUTH_FILE ?? '.data/test-evidence/security-test-accounts.json');
  assert.ok(filename.startsWith(path.resolve('.data') + path.sep));
  const accounts = JSON.parse(await readFile(filename, 'utf8')), base = new URL(accounts.baseUrl);
  assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && base.port === '5091' && base.pathname === '/');
  const sessions = [];
  async function login(account, audience = 'engineering') {
    const response = await fetch(new URL('/api/auth/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...account, audience }) });
    assert.equal(response.status, 200); const result = await response.json();
    const session = { cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), csrf: result.csrfToken, audience }; sessions.push(session); return session;
  }
  async function request(session, suffix = '', method = 'GET', body, csrf = true, extra = {}) {
    return fetch(new URL('/api/gateway/deployment/settings' + suffix, base), { method, headers: { ...(session ? { Cookie: session.cookie, 'X-SPARK-AUDIENCE': session.audience, ...(csrf ? { 'X-SPARK-CSRF': session.csrf } : {}) } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  let admin, original;
  try {
    admin = await login(accounts.admin); const designer = await login(accounts.designer), operator = await login(accounts.admin, 'operator');
    for (const [session, status] of [[null, 401], [designer, 403], [operator, 401]]) {
      assert.equal((await request(session)).status, status);
      assert.equal((await request(session, '', 'PUT', { revision: '0', settings: { enabled: false, url: base.origin, certificateFile: null, privateKeyFile: null } })).status, status);
    }
    const initial = await request(admin); assert.equal(initial.status, 200); assert.equal(initial.headers.get('cache-control'), 'no-store'); original = await initial.json();
    assert.ok(original.overrideReason, '5091 must use an explicit URL override.');
    const intent = { enabled: true, url: 'http://127.0.0.1:15095', certificateFile: null, privateKeyFile: null };
    assert.equal((await request(admin, '/validate', 'POST', intent, false)).status, 403);
    assert.equal((await request(admin, '', 'PUT', { revision: original.revision, settings: intent }, false)).status, 403);
    assert.equal((await request(admin, '/restore', 'POST', { revision: original.revision }, false)).status, 403);
    assert.equal((await request(admin, '', 'PUT', { revision: original.revision, settings: intent }, true, { Origin: 'https://cross-origin.example' })).status, 403);
    console.log('PASS deployment settings reads/writes enforce engineering administrator, CSRF and same-origin access');
    assert.equal((await request(admin, '/validate', 'POST', { ...intent, url: 'http://0.0.0.0:5090' })).status, 400);
    assert.equal((await request(admin, '/validate', 'POST', intent)).status, 200);
    assert.deepEqual(await (await request(admin)).json(), original, 'Validation mutated saved settings.');
    const savedResponse = await request(admin, '', 'PUT', { revision: original.revision, settings: intent }); assert.equal(savedResponse.status, 200); const saved = await savedResponse.json();
    assert.deepEqual(saved.saved, intent); assert.equal(saved.state, 'overridden'); assert.notEqual(saved.revision, original.revision);
    assert.equal((await request(admin, '', 'PUT', { revision: original.revision, settings: intent })).status, 409);
    const actual = await fetch(new URL('/api/gateway/deployment', base), { headers: { Cookie: admin.cookie, 'X-SPARK-AUDIENCE': 'engineering' } });
    assert.ok((await actual.json()).listeners.addresses.includes(base.origin));
    console.log('PASS validation is read-only; revisioned save is explicit, preserves override and does not rebind the running listener');
    const changed = await request(admin, '', 'PUT', { revision: saved.revision, settings: { ...intent, url: 'http://127.0.0.1:15096' } }); assert.equal(changed.status, 200); const second = await changed.json();
    assert.equal((await request(admin, '/restore', 'POST', { revision: saved.revision })).status, 409);
    const restore = await request(admin, '/restore', 'POST', { revision: second.revision }); assert.equal(restore.status, 200); assert.deepEqual((await restore.json()).saved, intent);
    console.log('PASS previous intent restores only with the current revision');
    console.log('3 deployment settings API groups passed.');
  } finally {
    if (admin && original) { const current = await request(admin); if (current.ok) { const state = await current.json(); assert.equal((await request(admin, '', 'PUT', { revision: state.revision, settings: original.saved })).status, 200); } }
    for (const session of sessions) await fetch(new URL('/api/auth/logout', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-SPARK-AUDIENCE': session.audience, 'X-SPARK-CSRF': session.csrf }, body: JSON.stringify({ audience: session.audience }) });
  }
}
