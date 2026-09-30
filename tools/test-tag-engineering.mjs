#!/usr/bin/env node
// Model tests use authored temporary data; API mode is restricted to an authenticated disposable 5091 gateway.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

if (process.argv.includes('--model')) await modelChecks(); else await apiChecks();

async function modelChecks() {
  const root = process.cwd(), directory = path.resolve('.data/test-evidence', `tag-engineering-${randomUUID()}`);
  assert.ok(directory.startsWith(path.resolve('.data') + path.sep)); await mkdir(directory, { recursive: true });
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const project = path.join(directory, 'TagEngineeringCheck.csproj');
  await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><ProjectReference Include="${escape(path.join(root, 'src/SparkStudio.Gateway/SparkStudio.Gateway.csproj'))}"/><None Update="workshop.json" CopyToOutputDirectory="Always"/></ItemGroup></Project>`);
  await writeFile(path.join(directory, 'workshop.json'), await readFile(path.join(root, 'examples/tag-engineering.json')));
  await writeFile(path.join(directory, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
  await writeFile(path.join(directory, 'Program.cs'), String.raw`
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

var directory = Path.Combine(AppContext.BaseDirectory, "fixture");
var protection = new EphemeralDataProtectionProvider();
var store = new ProjectStore(directory, protection, gatewayOnly: true);
JsonObject Memory(string name, object value, string type = "Double") => new() { ["path"] = "[default]Engineering/" + name, ["kind"] = "memory", ["dataType"] = type, ["value"] = JsonSerializer.SerializeToNode(value) };
JsonObject Expression(string name, string expression, string type = "Double", params (string Name, string Path)[] inputs) => new()
{
    ["path"] = "[default]Engineering/" + name, ["kind"] = "expression", ["dataType"] = type, ["expression"] = expression,
    ["inputs"] = new JsonObject(inputs.Select(item => KeyValuePair.Create<string, JsonNode?>(item.Name, JsonValue.Create("[default]Engineering/" + item.Path))))
};
JsonObject Package(params JsonObject[] definitions) => new() { ["format"] = "sparkstudio.tags", ["version"] = 1, ["tags"] = new JsonArray(definitions.Select(item => item.DeepClone()).ToArray()) };
void Reject(JsonObject package)
{
    var before = store.GetTagDefinitions().ToJsonString(); Throws<ArgumentException>(() => store.PreviewTagImport(package));
    Assert(store.GetTagDefinitions().ToJsonString() == before, "Rejected package changed state.");
}
var package = Package(Expression("Rate", "count * 60 / seconds", "Double", ("count", "Count"), ("seconds", "Seconds")), Memory("Count", 12), Memory("Seconds", 30),
    Expression("Ready", "rate >= 20 && rate <= 30", "Boolean", ("rate", "Rate")));
var preview = store.PreviewTagImport(package);
Assert(preview.TotalTags == 4 && preview.Changes.All(item => item.Action == "add") && store.GetTagDefinitions().Count == 0, "Preview mutated state or omitted rows.");
store.ApplyTagImport(new(package, preview.Revision, preview.PreviewToken));
Assert(store.GetTagDefinitions().Count == 4, "Atomic forward-reference import failed.");
Assert(TagExpressions.Order(store.GetTagDefinitions().OfType<JsonObject>().ToArray()).Select(item => item.Path).SequenceEqual(new[] { "[default]Engineering/Rate", "[default]Engineering/Ready" }), "Topological order is incorrect.");
var restarted = new ProjectStore(directory, protection, gatewayOnly: true);
Assert(JsonNode.DeepEquals(restarted.ExportTags(), store.ExportTags()), "Tag package did not survive restart.");
Console.WriteLine("PASS preview is read-only, forward references import atomically and exported definitions survive restart");

var changed = Package(Memory("Count", 13)); var review = store.PreviewTagImport(changed);
store.WriteMemoryTag("[default]Engineering/Count", JsonSerializer.SerializeToElement(14));
Assert(store.PreviewTagImport(changed).PreviewToken == review.PreviewToken, "Runtime writes invalidated a configuration-only preview.");
var unchanged = store.ExportTags(); var unchangedReview = store.PreviewTagImport(unchanged); store.ApplyTagImport(new(unchanged, unchangedReview.Revision, unchangedReview.PreviewToken));
store.FlushMemoryValues();
Assert(new ProjectStore(directory, protection, gatewayOnly: true).GetTagDefinitions().OfType<JsonObject>().Single(tag => tag["path"]!.GetValue<string>() == "[default]Engineering/Count")["value"]!.GetValue<double>() == 14,
    "Unchanged import or reload lost a checkpointed runtime value.");
store.SaveTag(Memory("Count", 14));
Throws<InvalidOperationException>(() => store.ApplyTagImport(new(changed, review.Revision, review.PreviewToken)));
review = store.PreviewTagImport(changed); changed["tags"]![0]!["value"] = 15;
Throws<InvalidOperationException>(() => store.ApplyTagImport(new(changed, review.Revision, review.PreviewToken)));
review = store.PreviewTagImport(changed);
store.SaveConnection(new JsonObject { ["id"] = "offline", ["name"] = "Offline fixture", ["type"] = "opcua", ["endpoint"] = "opc.tcp://127.0.0.1:1", ["enabled"] = false });
Throws<InvalidOperationException>(() => store.ApplyTagImport(new(changed, review.Revision, review.PreviewToken)));
review = store.PreviewTagImport(changed); store.ApplyTagImport(new(changed, review.Revision, review.PreviewToken));
Assert(store.GetTagDefinitions().Count == 4, "Merge deleted absent tags.");
Assert(store.GetTagDefinitions().OfType<JsonObject>().Single(tag => tag["path"]!.GetValue<string>() == "[default]Engineering/Count")["value"]!.GetValue<double>() == 15
    && new ProjectStore(directory, protection, gatewayOnly: true).GetTagDefinitions().OfType<JsonObject>().Single(tag => tag["path"]!.GetValue<string>() == "[default]Engineering/Count")["value"]!.GetValue<double>() == 15,
    "A checkpoint for the old configuration overrode a reviewed changed default before or after reload.");
Console.WriteLine("PASS runtime writes preserve configuration review and checkpoint across unchanged imports; configuration, edited packages and connections invalidate review; merge retains unrelated tags");

Reject(Package(Memory("Duplicate", 1), Memory("Duplicate", 2)));
Reject(Package(Expression("Missing", "x", "Double", ("x", "NotFound"))));
Reject(Package(Expression("CycleA", "b", "Double", ("b", "CycleB")), Expression("CycleB", "a", "Double", ("a", "CycleA"))));
Reject(Package(Memory("NoPartial", 1), new JsonObject { ["path"] = "[default]Engineering/Bad", ["kind"] = "udt" }));
var badPackage = Package(Memory("Unsupported", 1)); badPackage["providers"] = new JsonArray(); Reject(badPackage);
var badField = Memory("UnknownField", 1); badField["alarm"] = new JsonObject(); Reject(Package(badField));
var wrongKindField = Memory("WrongField", 1); wrongKindField["expression"] = "0"; Reject(Package(wrongKindField));
var oldVersion = Package(Memory("Version", 1)); oldVersion["version"] = 2; Reject(oldVersion);
Throws<ArgumentException>(() => store.DeleteTag("[default]Engineering/Count"));
Throws<ArgumentException>(() => store.SaveTag(Expression("Rate", "self", "Double", ("self", "Rate"))));
var chain = Enumerable.Range(0, 65).Select(index => index == 0 ? Expression("Chain0", "0") : Expression("Chain" + index, "prior", "Double", ("prior", "Chain" + (index - 1)))).ToArray();
Reject(Package(chain)); Reject(Package(chain.Reverse().ToArray()));
Console.WriteLine("PASS duplicate paths, unsupported definitions, missing dependencies, cycles, both chain orders and referenced deletion are rejected without mutation");

foreach (var invalid in new[] { "System.IO.File.ReadAllText(\"a\")", "x = 2", "unknown + 1", "1/", new string('(', 66) + "1" + new string(')', 66), string.Join("+", Enumerable.Repeat("1", 140)), "9007199254740993" })
    Throws<ArgumentException>(() => TagExpressions.Compile(Expression("Invalid", invalid)));
var timestamp = DateTimeOffset.Parse("2026-01-01T00:00:00Z");
var values = new Dictionary<string, TagValue>(StringComparer.Ordinal)
{
    ["[default]Engineering/Count"] = new("[default]Engineering/Count", 12, "Int32", "Good", timestamp, "memory"),
    ["[default]Engineering/Seconds"] = new("[default]Engineering/Seconds", 30, "Double", "Good", timestamp.AddSeconds(1), "opcua")
};
var plans = TagExpressions.Order(store.GetTagDefinitions().OfType<JsonObject>().ToArray());
foreach (var plan in plans) values[plan.Path] = TagExpressions.Evaluate(plan, values, DateTimeOffset.UtcNow);
Assert(((JsonElement)values[plans[0].Path].Value!).GetDouble() == 24 && ((JsonElement)values[plans[1].Path].Value!).GetBoolean(), "Typed arithmetic/Boolean result is incorrect.");
Assert(values[plans[1].Path].Timestamp == timestamp.AddSeconds(1), "Derived tag did not preserve newest contributing source time.");
values["[default]Engineering/Count"] = values["[default]Engineering/Count"] with { Quality = "Bad_CommunicationError" };
Assert(TagExpressions.Evaluate(plans[0], values, DateTimeOffset.UtcNow).Quality == "Bad_CommunicationError", "Bad dependency was reported good.");
values["[default]Engineering/Count"] = values["[default]Engineering/Count"] with { Quality = "Good", Value = 9223372036854775807L };
Assert(TagExpressions.Evaluate(plans[0], values, DateTimeOffset.UtcNow).Quality == "Bad_TypeMismatch", "Inexact Int64 arithmetic silently rounded.");
var divide = TagExpressions.Compile(Expression("Divide", "1 / 0"));
Assert(TagExpressions.Evaluate(divide, values, DateTimeOffset.UtcNow).Quality == "Bad_ExpressionError", "Divide by zero quality is incorrect.");
var fraction = TagExpressions.Compile(Expression("Fraction", "1 / 2", "Int32"));
Assert(TagExpressions.Evaluate(fraction, values, DateTimeOffset.UtcNow).Quality == "Bad_TypeMismatch", "Fraction was coerced into an integer.");
var literal = TagExpressions.Compile(Expression("Literal", "\"Running\"", "String"));
var first = TagExpressions.Evaluate(literal, values, timestamp); var second = TagExpressions.Evaluate(literal, values, timestamp.AddSeconds(5), first);
Assert(second.Timestamp == first.Timestamp && ((JsonElement)second.Value!).GetString() == "Running", "Constant expression timestamp churned.");
Console.WriteLine("PASS bounded grammar, typed evaluation, bad-quality propagation, source timestamps and precision rejection");

using var connector = new ConnectorService(directory);
using var engine = new TagEngine(store, connector, NullLogger<TagEngine>.Instance);
await engine.StartAsync(CancellationToken.None);
try
{
    await WaitFor(() => engine.Read(["[default]Engineering/Rate"], null)[0].Quality == "Good");
    Assert(engine.Read(["[default]Engineering/Rate"], null)[0].Source == "expression", "Expression entered OPC subscription path.");
    var paths = new[] { "[default]Engineering/Count" }; engine.WriteMemory(paths, [JsonSerializer.SerializeToElement(20)]);
    await WaitFor(() => engine.Read(["[default]Engineering/Rate"], null)[0].Value is JsonElement value && value.GetDouble() == 40);
    var disabled = store.GetTagDefinitions().OfType<JsonObject>().Single(item => item["path"]!.GetValue<string>() == paths[0]); disabled["enabled"] = false; engine.SaveDefinition(disabled);
    await WaitFor(() => engine.Read(["[default]Engineering/Ready"], null)[0].Quality == "Bad_Disabled");
    disabled["enabled"] = true; engine.SaveDefinition(disabled);
    await WaitFor(() => engine.Read(["[default]Engineering/Ready"], null)[0].Quality == "Good");
    Assert(JsonSerializer.SerializeToNode(engine.SubscriptionSnapshot())!.AsArray().Count == 0, "Expression tags started an OPC subscription.");
}
finally { await engine.StopAsync(CancellationToken.None); }
Console.WriteLine("PASS running engine refreshes dependency chains, propagates disabled status, recovers and never subscribes expressions as OPC tags");
var quarantinedDirectory = Path.Combine(directory, "quarantined"); Directory.CreateDirectory(quarantinedDirectory);
File.WriteAllText(Path.Combine(quarantinedDirectory, RecoveryQuarantine.MarkerName), new JsonObject { ["schemaVersion"] = 1, ["state"] = "quarantined", ["archiveId"] = Guid.NewGuid().ToString() }.ToJsonString());
File.WriteAllText(Path.Combine(quarantinedDirectory, "connections.json"), """[{"id":"restored-opc","name":"Restored connection","type":"opcua","endpoint":"opc.tcp://127.0.0.1:1","protectedPassword":"unreadable-restored-ciphertext"}]""");
var restoredStore = new ProjectStore(quarantinedDirectory, protection, gatewayOnly: true);
restoredStore.SaveTag(new JsonObject { ["path"] = "[default]Restored/Signal", ["kind"] = "opcua", ["connectionId"] = "restored-opc", ["nodeId"] = "ns=1;s=Signal" });
Throws<Exception>(() => restoredStore.GetConnection("restored-opc"));
var quarantine = new RecoveryQuarantine(quarantinedDirectory);
using var restoredConnector = new ConnectorService(quarantinedDirectory, quarantine.EnsureOperationsAllowed);
using var restoredEngine = new TagEngine(restoredStore, restoredConnector, NullLogger<TagEngine>.Instance, quarantine);
await restoredEngine.StartAsync(CancellationToken.None);
try
{
    await WaitFor(() => restoredEngine.Read(["[default]Restored/Signal"], null)[0].Quality == "Bad_RecoveryMode");
    await Task.Delay(650);
    Assert(restoredEngine.ExecuteTask?.IsCompleted == false, "Unreadable restored credentials faulted the quarantined tag engine.");
    Assert(JsonSerializer.SerializeToNode(restoredEngine.SubscriptionSnapshot())!.AsArray().Count == 0, "Recovery mode materialized an OPC watch.");
}
finally { await restoredEngine.StopAsync(CancellationToken.None); }
Console.WriteLine("PASS restored OPC tags remain Bad_RecoveryMode without reading unreadable credentials or creating subscriptions");
var workshop = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "workshop.json")))!.AsObject();
var catalog = new ProjectCatalog(Path.Combine(directory, "workshop"), protection);
var workshopPackage = new JsonObject { ["format"] = "sparkstudio.tags", ["version"] = 1, ["tags"] = workshop["tags"]!.DeepClone() };
var workshopPreview = catalog.GatewayStore.PreviewTagImport(workshopPackage);
catalog.GatewayStore.ApplyTagImport(new(workshopPackage, workshopPreview.Revision, workshopPreview.PreviewToken));
var workspace = catalog.Create("Tag engineering model workshop");
var draft = workspace.Store.GetProject(); draft["screens"] = workshop["screens"]!.DeepClone(); draft["navigation"] = workshop["navigation"]!.DeepClone();
draft = workspace.Store.SaveProject(draft);
var bytes = SparkProjectPackage.Export(workspace);
var imported = SparkProjectPackage.Import(catalog, bytes, "Imported tag engineering workshop");
Assert(imported.Publication.Metadata()["published"]!.GetValue<bool>() == false, "Import published workshop implicitly.");
imported.Publication.Publish(imported.Store, imported.Store.GetProject()["revision"]!.GetValue<int>());
Assert(JsonNode.DeepEquals(imported.Publication.GetProject()["navigation"], workshop["navigation"]), "Published workshop navigation changed.");
Assert(SparkProjectPackage.Export(imported).Length > 0 && catalog.GatewayStore.GetTagDefinitions().Count == 4, "Workshop did not re-export or gateway tags changed.");
Console.WriteLine("PASS authored workshop imports tag prerequisites, validates screens, exports/imports, explicitly publishes, exposes an operator snapshot and re-exports");
Console.WriteLine("7 tag engineering model groups passed.");
static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
static void Throws<T>(Action action) where T : Exception { try { action(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name); }
static async Task WaitFor(Func<bool> predicate) { var until = DateTime.UtcNow.AddSeconds(8); while (!predicate()) { if (DateTime.UtcNow >= until) throw new Exception("Timed out awaiting tag state."); await Task.Delay(100); } }
`);
  const dotnet = path.join(root, '.tools/dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, DOTNET_CLI_HOME: path.join(root, '.tools/dotnet-home'), NUGET_PACKAGES: path.join(root, '.tools/nuget'), DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' } };
  for (const args of [['restore', project, '--configfile', path.join(directory, 'NuGet.Config'), '-p:NuGetAudit=false', '--verbosity', 'quiet'], ['run', '--project', project, '--configuration', 'G10TagsModel', '--no-restore', '--no-launch-profile', '--verbosity', 'quiet']]) {
    const result = spawnSync(dotnet, args, options); process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); assert.equal(result.status, 0, 'Tag engineering model checks failed.');
  }
}

async function apiChecks() {
  const filename = path.resolve(process.env.SPARKSTUDIO_TEST_AUTH_FILE ?? '.data/test-evidence/security-test-accounts.json');
  assert.ok(filename.startsWith(path.resolve('.data') + path.sep));
  const accounts = JSON.parse(await readFile(filename, 'utf8')), base = new URL(accounts.baseUrl);
  assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && base.port === '5091' && base.pathname === '/' && !base.username && !base.password);
  const sessions = [], prefix = `[default]TagEngineering/${randomUUID().replaceAll('-', '')}`, paths = [prefix + '/Count', prefix + '/Doubled'];
  async function login(account, audience = 'engineering') {
    const response = await fetch(new URL('/api/auth/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...account, audience }) });
    assert.equal(response.status, 200); const body = await response.json();
    const session = { cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), csrf: body.csrfToken, audience }; sessions.push(session); return session;
  }
  async function request(session, route, method = 'GET', body, expected = 200) {
    const headers = { 'Content-Type': 'application/json' };
    if (session) Object.assign(headers, { Cookie: session.cookie, 'X-SPARK-AUDIENCE': session.audience, 'X-SPARK-CSRF': session.csrf });
    const response = await fetch(new URL(route, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'error' });
    const raw = await response.text(); assert.equal(response.status, expected, `${method} ${route}: ${raw.slice(0, 350)}`); return raw ? JSON.parse(raw) : null;
  }
  const admin = await login(accounts.admin); let imported = false;
  try {
    const designer = await login(accounts.designer), operator = await login(accounts.admin, 'operator');
    const package_ = { format: 'sparkstudio.tags', version: 1, tags: [
      { path: paths[1], kind: 'expression', dataType: 'Double', expression: 'count * 2', inputs: { count: paths[0] }, publishingIntervalMs: 100 },
      { path: paths[0], kind: 'memory', dataType: 'Int32', value: 21 },
    ] };
    for (const [session, expected] of [[null, 401], [designer, 403], [operator, 401]]) for (const [route, method, body] of [
      ['/api/tag-engineering/export', 'GET'], ['/api/tag-engineering/preview', 'POST', package_], ['/api/tag-engineering/apply', 'POST', { package: package_, revision: '', previewToken: '' }],
    ]) await request(session, route, method, body, expected);
    const before = await request(admin, '/api/tag-definitions');
    await request(admin, '/api/tag-engineering/preview', 'POST', null, 400);
    await request(admin, '/api/tag-engineering/apply', 'POST', { package: null, revision: '', previewToken: '' }, 400);
    let preview = await request(admin, '/api/tag-engineering/preview', 'POST', package_);
    assert.deepEqual(await request(admin, '/api/tag-definitions'), before);
    await request({ ...admin, csrf: '' }, '/api/tag-engineering/apply', 'POST', { package: package_, ...preview }, 403);
    await request(admin, '/api/tag-engineering/apply', 'POST', { package: package_, ...preview }); imported = true;
    for (let attempt = 0; attempt < 50; attempt++) {
      const tags = await request(admin, '/api/tags'), derived = tags.find(item => item.path === paths[1]);
      if (derived?.quality === 'Good' && derived.value === 42) break;
      assert.ok(attempt < 49, 'Expression did not reach expected value.'); await new Promise(resolve => setTimeout(resolve, 100));
    }
    const exported = await request(admin, '/api/tag-engineering/export'); assert.equal(exported.format, 'sparkstudio.tags'); assert.ok(exported.tags.some(item => item.path === paths[1] && item.inputs.count === paths[0]));
    console.log('PASS engineering administrator, audience and CSRF boundaries; read-only preview, atomic import, runtime expression and export');
    preview = await request(admin, '/api/tag-engineering/preview', 'POST', package_);
    await request(admin, '/api/tags', 'POST', { ...package_.tags[1], value: 22 });
    await request(admin, '/api/tag-engineering/apply', 'POST', { package: package_, ...preview }, 409);
    const cycle = structuredClone(package_); cycle.tags[0].inputs.count = paths[1];
    await request(admin, '/api/tag-engineering/preview', 'POST', cycle, 400);
    await request(admin, `/api/tag-definitions?path=${encodeURIComponent(paths[0])}`, 'DELETE', undefined, 400);
    console.log('PASS stale preview, dependency cycles and referenced deletion rejected through HTTP');
  } finally {
    if (imported) for (const tag of [...paths].reverse()) await request(admin, `/api/tag-definitions?path=${encodeURIComponent(tag)}`, 'DELETE', undefined, 204);
    for (const session of sessions) await request(session, '/api/auth/logout', 'POST', { audience: session.audience });
  }
}
