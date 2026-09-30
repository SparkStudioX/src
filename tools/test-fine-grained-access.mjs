#!/usr/bin/env node
// Isolated in-process loopback API with authored temporary data; no live gateway or device operations.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = process.cwd(), directory = path.resolve('.data/test-evidence', `access-capabilities-${randomUUID()}`);
assert.ok(directory.startsWith(path.resolve('.data') + path.sep)); await mkdir(directory, { recursive: true });
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const project = path.join(directory, 'AccessCheck.csproj');
await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><ProjectReference Include="${escape(path.join(root, 'src/SparkStudio.Gateway/SparkStudio.Gateway.csproj'))}"/><None Update="workshop.json" CopyToOutputDirectory="Always"/></ItemGroup></Project>`);
await writeFile(path.join(directory, 'workshop.json'), await readFile(path.join(root, 'examples/access-permissions-workshop.json')));
await writeFile(path.join(directory, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
await writeFile(path.join(directory, 'Program.cs'), String.raw`
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

var directory = Path.Combine(AppContext.BaseDirectory, "fixture"); Directory.CreateDirectory(directory);
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { ContentRootPath = directory });
builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
var protection = new EphemeralDataProtectionProvider(); builder.Services.AddSingleton<IDataProtectionProvider>(protection);
builder.Services.AddGatewaySecurity(directory);
var catalog = new ProjectCatalog(directory, protection); var projectId = catalog.DefaultId;
builder.Services.AddSingleton(catalog); builder.Services.AddSingleton(catalog.GatewayStore);
builder.Services.AddSingleton(new ConnectorService(directory)); builder.Services.AddSingleton<TagEngine>();
builder.Services.AddSingleton(new RecoveryQuarantine(directory)); builder.Services.AddSingleton(new GatewayObservations(directory));
builder.Services.AddSingleton(new DeploymentSettings(directory));
builder.Services.AddSingleton(service => new GatewayDeployment(builder.Configuration, builder.Environment, directory));
builder.Services.AddSingleton(service => new GatewayBackups(directory, protection, service.GetRequiredService<RecoveryQuarantine>(), service.GetRequiredService<SecurityStore>(), service.GetRequiredService<IHostApplicationLifetime>()));
await using var app = builder.Build();
app.Use(async (context, next) => { try { await next(); } catch (Exception error) { context.Response.StatusCode = error is BadHttpRequestException bad ? bad.StatusCode : error is ArgumentException ? 400 : error is KeyNotFoundException ? 404 : error is InvalidOperationException ? 409 : 500; await context.Response.WriteAsJsonAsync(new { error = error.Message }); } });
app.UseRouting(); app.UseAuthentication(); app.UseApplicationAccess();
app.MapGatewaySecurityEndpoints(); app.MapGatewayConsoleEndpoints(); app.MapGatewayDeploymentEndpoints(); app.MapDeploymentSettingsEndpoints(); app.MapGatewayBackupEndpoints(); app.MapGatewayRecoveryEndpoints();
app.MapGroup("/api").MapTagEngineeringEndpoints();
var calls = 0;
app.MapPost("/api/projects/{projectId}/command-check", () => { calls++; return new { accepted = true }; }).Access("command", "operator", audit: true);
app.MapPost("/api/projects/{projectId}/operate-check", () => new { accepted = true }).Access("operate", "operator", audit: true);
app.MapPost("/api/admin-check", () => new { accepted = true }).Access("admin", audit: true);
await app.StartAsync();
var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
var security = app.Services.GetRequiredService<SecurityStore>();
var password = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
var admin = security.Setup(File.ReadAllText(Path.Combine(directory, "security", "setup-code.txt")).Trim(), new("adminuser", password));
SecurityUser User(string name, SecurityProjectGrant? grant = null, SecurityGatewayCapabilities? capabilities = null) => security.CreateUser(new(name, password, ProjectGrants: grant is null ? [] : new() { [projectId] = grant }, GatewayCapabilities: capabilities));
var viewer = User("viewer", new(View: true)); var operatorUser = User("operator", new(View: true, Operate: true)); var commander = User("commander", new(Commands: true));
Assert(security.GetPermissions(commander, projectId) is { Commands: true, Operate: true, View: true }, "Commands did not imply operate/view.");
Assert(!security.GetPermissions(operatorUser, projectId).Commands && !security.Can(operatorUser, projectId, "command"), "Legacy operate silently granted equipment commands.");
Assert(!JsonSerializer.Deserialize<SecurityProjectGrant>("{\"view\":true,\"operate\":true}", new JsonSerializerOptions(JsonSerializerDefaults.Web))!.Commands, "Legacy serialized grant acquired Commands.");
var accounts = new Dictionary<string, SecurityUser> {
    ["diagnostics"] = User("diagnostics", capabilities: new(Diagnostics: true)), ["configuration"] = User("configuration", capabilities: new(Configuration: true)),
    ["backups"] = User("backups", capabilities: new(Backups: true)), ["audit"] = User("auditor", capabilities: new(Audit: true)), ["sessions"] = User("sessions", capabilities: new(Sessions: true)) };
var allowedPaths = new Dictionary<string, string> { ["diagnostics"] = "/api/gateway/diagnostics", ["configuration"] = "/api/tag-engineering/export", ["backups"] = "/api/gateway/backups", ["audit"] = "/api/security/audit", ["sessions"] = "/api/gateway/overview" };
var clients = new List<Client>();
async Task<Client> Login(SecurityUser user, string audience = "engineering", string? project = null) { var client = new Client(address, audience, project); clients.Add(client); await client.Login(user.Username, password); return client; }
try
{
    var guest = new Client(address, "operator", projectId); clients.Add(guest);
    await guest.Request($"/api/projects/{projectId}/command-check", "POST", new { }, 401);
    var view = await Login(viewer, "operator", projectId); var operate = await Login(operatorUser, "operator", projectId); var command = await Login(commander, "operator", projectId);
    await view.Request($"/api/projects/{projectId}/command-check", "POST", new { }, 403);
    await operate.Request($"/api/projects/{projectId}/command-check", "POST", new { }, 403);
    await operate.Request($"/api/projects/{projectId}/operate-check", "POST", new { });
    await command.Request($"/api/projects/{projectId}/command-check", "POST", new { }, 403, csrf: false);
    Assert(calls == 0, "Denied command reached its operation.");
    await command.Request($"/api/projects/{projectId}/command-check", "POST", new { }); Assert(calls == 1, "Authorized command did not reach operation.");
    await command.Request("/api/projects/ungranted/command-check", "POST", new { }, 403);
    await command.Request("/api/admin-check", "POST", new { }, 401);
    Console.WriteLine("PASS command privilege defaults off, implies view/operate, rejects viewer/ordinary operator/wrong project/CSRF/audience and reaches operation only when authorized");

    foreach (var pair in accounts)
    {
        var client = await Login(pair.Value);
        var session = await client.Request("/api/auth/session?audience=engineering");
        Assert(session["gatewayCapabilities"]![pair.Key]!.GetValue<bool>() && !session["permissions"]!["design"]!.GetValue<bool>() && !session["permissions"]!["commands"]!.GetValue<bool>(), "Capability login added project permissions.");
        await client.Request(allowedPaths[pair.Key]);
        foreach (var denied in allowedPaths.Where(item => item.Key != pair.Key && item.Key != "sessions")) await client.Request(denied.Value, status: 403);
        await client.Request("/api/security/users", status: 403); await client.Request("/api/security/settings", status: 403);
        await client.Request("/api/gateway/recovery", status: 403); await client.Request("/api/admin-check", "POST", new { }, 403);
        if (pair.Key != "sessions") await client.Request("/api/gateway/sessions/missing/revoke", "POST", new { }, 403);
        else await client.Request("/api/gateway/sessions/" + Guid.NewGuid().ToString("N") + "/revoke", "POST", new { }, 404);
        var overview = await client.Request("/api/gateway/overview");
        Assert(pair.Key == "sessions" ? overview["sessions"]!.AsArray().Count > 0 : overview["sessions"]!.AsArray().Count == 0, "Overview leaked or omitted session inventory.");
        Assert((overview["metrics"] is not null) == (pair.Key == "diagnostics"), "Overview leaked or omitted diagnostic metrics.");
        if (pair.Key == "sessions")
        {
            var viewerSession = overview["sessions"]!.AsArray().OfType<JsonObject>().Single(item => item["username"]!.GetValue<string>() == "viewer");
            await client.Request("/api/gateway/sessions/" + viewerSession["id"]!.GetValue<string>() + "/revoke", "POST", new { });
            await view.Request($"/api/projects/{projectId}/command-check", "POST", new { }, 401);
        }
        if (pair.Key is "audit" or "backups" or "sessions") Assert(overview["projects"]!.AsArray().Count == 0 && overview["connections"]!.AsArray().Count == 0, "Overview leaked resource names to unrelated capability.");
        if (pair.Key == "configuration") { await client.Request("/api/gateway/deployment"); await client.Request("/api/gateway/deployment/settings"); }
    }
    Console.WriteLine("PASS each standalone gateway capability signs in, reaches its actual API, rejects other capability/admin APIs and receives redacted overview");

    var configuration = await Login(accounts["configuration"]);
    var package = JsonNode.Parse("""{"format":"sparkstudio.tags","version":1,"tags":[{"path":"[default]AccessWorkshop/Value","kind":"memory","dataType":"Int32","value":1}]}""")!;
    var preview = await configuration.Request("/api/tag-engineering/preview", "POST", package);
    var request = new { package, revision = preview["revision"]!.GetValue<string>(), previewToken = preview["previewToken"]!.GetValue<string>() };
    await configuration.Request("/api/tag-engineering/apply", "POST", request, 403, csrf: false);
    await configuration.Request("/api/tag-engineering/apply", "POST", request);
    Assert(catalog.GatewayStore.GetTagDefinitions().Count == 1, "Configuration capability could not apply reviewed synthetic tags.");
    var auditor = await Login(accounts["audit"]); var audit = (await auditor.Request("/api/security/audit?limit=100"))["entries"]!.AsArray();
    Assert(audit.OfType<JsonObject>().Any(item => item["actor"]!.GetValue<string>() == "configuration" && item["action"]!.GetValue<string>().Contains("/tag-engineering/apply") && item["outcome"]!.GetValue<string>() == "HTTP 200"), "Mutation attribution missing.");
    Assert(audit.OfType<JsonObject>().Any(item => item["actor"]!.GetValue<string>() == "operator" && item["outcome"]!.GetValue<string>() == "denied"), "Denied command attribution missing.");
    var current = accounts["configuration"];
    security.UpdateUser(current.Id, new(current.Revision, current.DisplayName, false, false, new(), GatewayCapabilities: new()));
    await configuration.Request("/api/tag-engineering/export", status: 401);
    Assert(!security.GetGatewayCapabilities(current).Any, "Stale identity retained capabilities.");
    var administrator = await Login(admin); foreach (var route in allowedPaths.Values.Distinct()) await administrator.Request(route);
    await administrator.Request("/api/security/users");
    Assert(new SecurityStore(directory).GetGatewayCapabilities(new SecurityStore(directory).Users.Single(user => user.Id == accounts["audit"].Id)).Audit, "Capability persistence lost audit grant.");
    Console.WriteLine("PASS configuration edits require CSRF, mutations and denials are attributed, grant revocation expires sessions, admins retain all access and capabilities persist");
    var workshop = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "workshop.json")))!.AsObject();
    var workshopPackage = workshop["tagPackage"]!.AsObject(); var workshopPreview = catalog.GatewayStore.PreviewTagImport(workshopPackage);
    catalog.GatewayStore.ApplyTagImport(new(workshopPackage, workshopPreview.Revision, workshopPreview.PreviewToken));
    var workspace = catalog.Create(workshop["name"]!.GetValue<string>()); var draft = workspace.Store.GetProject(); draft["screens"] = workshop["screens"]!.DeepClone(); draft["navigation"] = workshop["navigation"]!.DeepClone(); workspace.Store.SaveProject(draft);
    var imported = SparkProjectPackage.Import(catalog, SparkProjectPackage.Export(workspace), "Imported access workshop");
    Assert(imported.Publication.Metadata()["published"]!.GetValue<bool>() == false, "Workshop import published implicitly.");
    imported.Publication.Publish(imported.Store, imported.Store.GetProject()["revision"]!.GetValue<int>());
    Assert(SparkProjectPackage.Export(imported).Length > 0, "Access workshop re-export failed.");
    Assert(workshop["roles"]!.AsArray().Count == 8, "Workshop role matrix is incomplete.");
    var standardRole = workshop["roles"]!.AsArray().OfType<JsonObject>().Single(role => role["name"]!.GetValue<string>() == "Operator");
    Assert(!standardRole["projectGrants"]!["commands"]!.GetValue<bool>() && standardRole["projectGrants"]!["operate"]!.GetValue<bool>(), "Workshop implicitly elevated operator commands.");
    Console.WriteLine("PASS authored access workshop separates eight roles and validates tag setup, project import, explicit publication and re-export");
    Console.WriteLine("4 fine-grained access API/model groups passed.");
}
finally { foreach (var client in clients) client.Dispose(); await app.StopAsync(); }
static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
sealed class Client : IDisposable
{
    private readonly HttpClient http; private readonly string audience; private readonly string? project; private string? csrf;
    public Client(string address, string audience, string? project) { http = new HttpClient(new HttpClientHandler { CookieContainer = new CookieContainer(), AllowAutoRedirect = false }) { BaseAddress = new Uri(address), Timeout = TimeSpan.FromSeconds(20) }; this.audience = audience; this.project = project; }
    public async Task Login(string username, string password) { var result = await Request("/api/auth/login", "POST", new { audience, username, password, projectId = project }); csrf = result["csrfToken"]!.GetValue<string>(); }
    public async Task<JsonObject> Request(string path, string method = "GET", object? body = null, int status = 200, bool csrf = true)
    {
        using var request = new HttpRequestMessage(new HttpMethod(method), path); request.Headers.Add("X-SPARK-AUDIENCE", audience); if (project is not null) request.Headers.Add("X-SPARK-PROJECT", project);
        if (csrf && this.csrf is not null) request.Headers.Add("X-SPARK-CSRF", this.csrf); if (body is not null) request.Content = JsonContent.Create(body);
        using var response = await http.SendAsync(request); var text = await response.Content.ReadAsStringAsync();
        if ((int)response.StatusCode != status) throw new Exception($"{method} {path}: expected {status}, got {(int)response.StatusCode}: {text[..Math.Min(text.Length, 250)]}");
        return JsonNode.Parse(text) as JsonObject ?? new JsonObject();
    }
    public void Dispose() => http.Dispose();
}
`);
const dotnet = path.join(root, '.tools/dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
const options = { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, APPDATA: path.join(root, '.tools/test-appdata'), DOTNET_CLI_HOME: path.join(root, '.tools/dotnet-home'), NUGET_PACKAGES: path.join(root, '.tools/nuget'), DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' } };
for (const args of [['restore', project, '--configfile', path.join(directory, 'NuGet.Config'), '-p:NuGetAudit=false', '--verbosity', 'quiet'], ['run', '--project', project, '--configuration', 'G07AccessCheck', '--no-restore', '--no-launch-profile', '--verbosity', 'quiet']]) {
  const result = spawnSync(dotnet, args, options); process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); assert.equal(result.status, 0, 'Fine-grained access checks failed.');
}
