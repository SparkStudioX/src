#!/usr/bin/env node
// Model mode stays offline; API mode creates disposable fixtures only on isolated port 5091.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

if (process.argv.includes('--model')) await modelChecks();
else await apiChecks();

async function modelChecks() {
  const root = process.cwd(), directory = path.resolve('.data/test-evidence', `gateway-connections-${randomUUID()}`);
  assert.ok(directory.startsWith(path.resolve('.data') + path.sep));
  await mkdir(directory, { recursive: true });
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const project = path.join(directory, 'GatewayConnectionsCheck.csproj');
  await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><ProjectReference Include="${escape(path.join(root, 'src/SparkStudio.Gateway/SparkStudio.Gateway.csproj'))}"/></ItemGroup></Project>`);
  await writeFile(path.join(directory, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
  await writeFile(path.join(directory, 'Program.cs'), String.raw`
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

var directory = Path.Combine(AppContext.BaseDirectory, "fixture");
Directory.CreateDirectory(directory);
File.WriteAllText(Path.Combine(directory, "connections.json"), """[{"id":"legacy","name":"Legacy SQLite","type":"sqlite","database":"legacy.db"}]""");
var protection = new EphemeralDataProtectionProvider();
var catalog = new ProjectCatalog(directory, protection);
var store = catalog.GatewayStore;
var legacy = Saved("legacy");
Assert(legacy["revision"]!.GetValue<int>() == 0 && legacy["enabled"]!.GetValue<bool>(), "Legacy defaults missing.");
Assert(store.GetConnection("legacy").Database == "legacy.db", "Legacy connection stopped working.");
legacy["name"] = "Renamed legacy";
legacy = store.SaveConnection(legacy);
Assert(legacy["revision"]!.GetValue<int>() == 1 && legacy["name"]!.GetValue<string>() == "Renamed legacy", "Revision-checked legacy rename failed.");
Console.WriteLine("PASS legacy records remain usable and become revisioned on save");

var saved = store.SaveConnection(new JsonObject { ["id"] = "fixture", ["name"] = "Fixture database", ["type"] = "sqlite", ["database"] = "fixture.db", ["password"] = "connection-secret-canary" });
Assert(saved["revision"]!.GetValue<int>() == 1 && saved["hasPassword"]!.GetValue<bool>(), "New connection defaults missing.");
Assert(!saved.ToJsonString().Contains("connection-secret-canary") && !File.ReadAllText(Path.Combine(directory, "connections.json")).Contains("connection-secret-canary"), "Credential was exposed or stored in plaintext.");
var before = store.GetConnections().ToJsonString();
var stale = (JsonObject)saved.DeepClone(); stale["revision"] = 0;
Throws<InvalidOperationException>(() => store.SaveConnection(stale));
stale.Remove("revision"); Throws<InvalidOperationException>(() => store.SaveConnection(stale));
var invalid = (JsonObject)saved.DeepClone(); invalid["enabled"] = "false";
Throws<ArgumentException>(() => store.SaveConnection(invalid));
Assert(store.GetConnections().ToJsonString() == before, "Rejected edits changed stored state.");
saved["name"] = "Renamed fixture"; saved = store.SaveConnection(saved);
Assert(store.GetConnection("fixture").Password == "connection-secret-canary", "Omitted password was not retained.");
Console.WriteLine("PASS new IDs, revision conflicts, validation and protected-password retention");

var oldTest = store.BeginConnectionTest("fixture");
var newTest = store.BeginConnectionTest("fixture");
Assert(!store.CompleteConnectionTest(oldTest, true, 5)["accepted"]!.GetValue<bool>(), "Older overlapping test was accepted.");
var failed = store.CompleteConnectionTest(newTest, false, 12, "connection-secret-canary remote exception");
Assert(failed["accepted"]!.GetValue<bool>() && !failed.ToJsonString().Contains("connection-secret-canary"), "Safe latest test was not accepted.");
Assert(DateTimeOffset.Parse(failed["completedAt"]!.GetValue<string>()) >= DateTimeOffset.Parse(failed["startedAt"]!.GetValue<string>()), "Test timestamps invalid.");
var restarted = new ProjectStore(directory, protection, gatewayOnly: true);
Assert(restarted.GetConnections().OfType<JsonObject>().Single(item => item["id"]!.GetValue<string>() == "fixture")["lastTest"]!.ToJsonString() == failed.ToJsonString(), "Last test was not durable.");
Console.WriteLine("PASS overlapping test ordering, redacted messages and durable timestamps");

oldTest = store.BeginConnectionTest("fixture");
saved = Saved("fixture"); saved["enabled"] = false; saved = store.SaveConnection(saved);
Assert(saved["status"]!.GetValue<string>() == "disabled" && saved["lastTest"] is null, "Disable retained obsolete test status.");
Throws<InvalidOperationException>(() => store.GetConnection("fixture"));
Throws<InvalidOperationException>(() => store.BeginConnectionTest("fixture"));
Assert(!store.CompleteConnectionTest(oldTest, true, 30)["accepted"]!.GetValue<bool>(), "Old test overwrote disabled configuration.");
Assert(store.GetConnection("fixture", allowDisabled: true).Id == "fixture", "Metadata inspection cannot see disabled connection.");
saved["enabled"] = true; saved = store.SaveConnection(saved);
Assert(store.GetConnection("fixture").Id == "fixture" && saved["lastTest"] is null, "Re-enable failed.");
Console.WriteLine("PASS disable blocks new operations and rejects tests captured before configuration changes");

using var connectors = new ConnectorService(directory);
using var engine = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance);
engine.SaveConnection(new JsonObject { ["id"] = "opc-fixture", ["name"] = "Disabled OPC fixture", ["type"] = "opcua", ["endpoint"] = "opc.tcp://127.0.0.1:1", ["enabled"] = false });
var tagPath = "[default]ConnectionFixture/Value";
engine.SaveDefinition(new JsonObject { ["path"] = tagPath, ["connectionId"] = "opc-fixture", ["nodeId"] = "ns=1;s=Value" });
Assert(engine.Read([tagPath], null)[0].Quality == "Bad_Disabled", "Disabled connection tag did not become unavailable immediately.");
await engine.StartAsync(CancellationToken.None);
await Task.Delay(750);
Assert(engine.Read([tagPath], null)[0].Quality == "Bad_Disabled" && JsonSerializer.Serialize(engine.SubscriptionSnapshot()) == "[]", "Disabled connection created a subscription.");
await engine.StopAsync(CancellationToken.None);
Console.WriteLine("PASS disabled connections leave no active tag subscriptions and expose Bad_Disabled quality");

var workspace = catalog.Create("Connection dependency fixture");
workspace.Store.SaveQuery("published-only", new JsonObject { ["name"] = "Published dependency", ["connectionId"] = "fixture", ["sql"] = "SELECT 1", ["parameters"] = new JsonArray() });
workspace.Publication.Publish(workspace.Store, workspace.Store.GetProject()["revision"]!.GetValue<int>());
workspace.Store.SaveQuery("published-only", new JsonObject { ["name"] = "Draft now uses another connection", ["connectionId"] = "legacy", ["sql"] = "SELECT 2", ["parameters"] = new JsonArray() });
catalog.SetArchived(workspace.Id, true);
var snapshot = JsonSerializer.SerializeToNode(GatewayConnections.Snapshot("fixture", catalog, engine))!.AsObject();
var references = snapshot["dependencies"]!.AsArray();
Assert(references.OfType<JsonObject>().Any(item => item["Scope"]!.GetValue<string>() == "published query" && item["ProjectId"]!.GetValue<string>() == workspace.Id), "Archived published-only query dependency was omitted.");
var opcSnapshot = JsonSerializer.SerializeToNode(GatewayConnections.Snapshot("opc-fixture", catalog, engine))!.AsObject();
Assert(opcSnapshot["values"]!.AsArray().Count == 1 && opcSnapshot["values"]![0]!["Quality"]!.GetValue<string>() == "Bad_Disabled", "Quick watch did not report disabled quality.");
Assert(!snapshot.ToJsonString().Contains("SELECT") && !snapshot.ToJsonString().Contains("connection-secret-canary"), "Dependency response exposed SQL or credentials.");
Console.WriteLine("PASS archived published-only dependencies and bounded read-only quality snapshots");
Console.WriteLine("6 gateway connection model groups passed.");
JsonObject Saved(string id) => store.GetConnections().OfType<JsonObject>().Single(item => item["id"]!.GetValue<string>() == id);
static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
static void Throws<T>(Action action) where T : Exception { try { action(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name); }
`);
  const dotnet = path.join(root, '.tools/dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, DOTNET_CLI_HOME: path.join(root, '.tools/dotnet-home'), NUGET_PACKAGES: path.join(root, '.tools/nuget'), DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' } };
  for (const args of [['restore', project, '--configfile', path.join(directory, 'NuGet.Config'), '-p:NuGetAudit=false', '--verbosity', 'quiet'], ['run', '--project', project, '--configuration', 'G05ConnectionsModel', '--no-restore', '--no-launch-profile', '--verbosity', 'quiet']]) {
    const result = spawnSync(dotnet, args, options);
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    assert.equal(result.status, 0, 'Connection model checks failed.');
  }
}

async function apiChecks() {
  const filename = path.resolve(process.env.SPARKSTUDIO_TEST_AUTH_FILE ?? '.data/test-evidence/security-test-accounts.json');
  assert.ok(filename.startsWith(path.resolve('.data') + path.sep));
  const accounts = JSON.parse(await readFile(filename, 'utf8')), base = new URL(accounts.baseUrl);
  assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && base.port === '5091' && base.pathname === '/' && !base.username && !base.password);
  const sessions = [], run = randomUUID().replaceAll('-', ''), id = `connection-test-${run}`, opcId = `${id}-opc`, tag = `[default]Connections/${run}`;
  let saved, opc, project;
  async function login(account, audience = 'engineering') {
    const response = await fetch(new URL('/api/auth/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...account, audience }) });
    assert.equal(response.status, 200); const body = await response.json();
    const session = { cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), csrf: body.csrfToken, audience };
    sessions.push(session); return session;
  }
  async function request(session, route, method = 'GET', body, expected = 200) {
    const headers = { 'Content-Type': 'application/json' };
    if (session) Object.assign(headers, { Cookie: session.cookie, 'X-SPARK-AUDIENCE': session.audience, 'X-SPARK-CSRF': session.csrf });
    const response = await fetch(new URL(route, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, expected, `${method} ${route}`);
    return response.status === 204 ? null : response.json();
  }
  const admin = await login(accounts.admin);
  try {
    const designer = await login(accounts.designer), operator = await login(accounts.admin, 'operator');
    for (const [session, expected] of [[null, 401], [designer, 403], [operator, 401]]) {
      await request(session, `/api/connections/${id}/diagnostics`, 'GET', undefined, expected);
      await request(session, `/api/connections/${id}/test`, 'POST', undefined, expected);
    }
    console.log('PASS connection lifecycle diagnostics require an engineering administrator');
    saved = await request(admin, '/api/connections', 'POST', { id, name: 'Disposable connection lifecycle', type: 'sqlite', database: `${run}.db` });
    assert.equal(saved.revision, 1); assert.equal(saved.enabled, true);
    await request(admin, '/api/connections', 'POST', { ...saved, revision: 0, name: 'Must not win' }, 409);
    saved = await request(admin, '/api/connections', 'POST', { ...saved, name: 'Renamed lifecycle fixture' });
    assert.equal(saved.revision, 2);
    const failed = await request(admin, `/api/connections/${id}/test`, 'POST');
    assert.equal(failed.success, false); assert.equal(failed.accepted, true); assert.ok(Number.isFinite(Date.parse(failed.completedAt)));
    assert.equal((await request(admin, `/api/connections/${id}/database`, 'POST', { initializeSampleData: false })).success, true);
    const passed = await request(admin, `/api/connections/${id}/test`, 'POST');
    assert.equal(passed.success, true); assert.equal(passed.revision, 2);
    assert.deepEqual((await request(admin, '/api/connections')).find(item => item.id === id).lastTest, passed);
    console.log('PASS revisions protect renames and timestamped connection tests persist through list reads');
    project = await request(admin, '/api/projects', 'POST', { name: `Connection diagnostics ${run}` });
    await request(admin, `/api/projects/${project.id}/queries/reference`, 'PUT', { name: 'Published reference', connectionId: id, sql: 'SELECT 1 AS value', kind: 'query', parameters: [] });
    await request(admin, `/api/projects/${project.id}/project/publish`, 'POST', { revision: project.revision });
    let snapshot = await request(admin, `/api/connections/${id}/diagnostics`);
    assert.ok(snapshot.dependencies.some(item => item.scope === 'draft query' && item.projectId === project.id));
    assert.ok(snapshot.dependencies.some(item => item.scope === 'published query' && item.projectId === project.id));
    saved = await request(admin, '/api/connections', 'POST', { ...saved, enabled: false });
    for (const [route, method, body] of [[`/api/connections/${id}/test`, 'POST'], [`/api/connections/${id}/schema`, 'GET'], [`/api/connections/${id}/database`, 'POST', { initializeSampleData: false }], [`/api/projects/${project.id}/queries/reference/execute`, 'POST', { parameters: {} }]])
      await request(admin, route, method, body, 409);
    assert.equal(saved.lastTest, undefined); assert.equal(saved.status, 'disabled');
    snapshot = await request(admin, `/api/connections/${id}/diagnostics`); assert.equal(snapshot.enabled, false);
    saved = await request(admin, '/api/connections', 'POST', { ...saved, enabled: true });
    assert.equal((await request(admin, `/api/connections/${id}/test`, 'POST')).success, true);
    console.log('PASS disable blocks new connector/query operations while dependencies remain visible; re-enable recovers');
    opc = await request(admin, '/api/connections', 'POST', { id: opcId, name: 'Disabled OPC diagnostics fixture', type: 'opcua', endpoint: 'opc.tcp://127.0.0.1:1', enabled: false });
    await request(admin, '/api/tags', 'POST', { path: tag, connectionId: opcId, nodeId: 'ns=1;s=Value' });
    snapshot = await request(admin, `/api/connections/${opcId}/diagnostics`);
    assert.equal(snapshot.values[0].quality, 'Bad_Disabled'); assert.equal(snapshot.values[0].path, tag); assert.deepEqual(snapshot.subscriptions, []);
    assert.equal(snapshot.dependencies[0].scope, 'tag'); assert.ok(Number.isFinite(Date.parse(snapshot.capturedAt)));
    console.log('PASS disabled OPC UA quick watch exposes quality without creating a server connection');
    console.log('4 gateway connection API groups passed.');
  } finally {
    if (saved) {
      const latest = (await request(admin, '/api/connections')).find(item => item.id === id);
      await request(admin, '/api/connections', 'POST', { ...latest, enabled: false });
    }
    if (opc) await request(admin, `/api/tag-definitions?path=${encodeURIComponent(tag)}`, 'DELETE', undefined, 204);
    if (project) await request(admin, `/api/projects/${project.id}/archive`, 'POST', { archived: true });
    for (const session of sessions) await request(session, '/api/auth/logout', 'POST', { audience: session.audience });
  }
}
