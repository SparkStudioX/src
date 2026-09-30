#!/usr/bin/env node
// Uses independently authored temporary fixtures only; never connects to a gateway or device.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd(), directory = path.resolve('.data/test-evidence', `tag-model-${randomUUID()}`);
assert.ok(directory.startsWith(path.resolve('.data') + path.sep)); await mkdir(directory, { recursive: true });
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const project = path.join(directory, 'TagModelCheck.csproj');
await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><ProjectReference Include="${escape(path.join(root, 'src/SparkStudio.Gateway/SparkStudio.Gateway.csproj'))}"/><None Update="workshop.json" CopyToOutputDirectory="Always"/></ItemGroup></Project>`);
await writeFile(path.join(directory, 'workshop.json'), await readFile(path.join(root, 'examples/unit-model-workshop.json')));
await writeFile(path.join(directory, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
await writeFile(path.join(directory, 'Program.cs'), String.raw`
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

var directory = Path.Combine(AppContext.BaseDirectory, "fixture"); Directory.CreateDirectory(directory);
var protection = new EphemeralDataProtectionProvider();
File.WriteAllText(Path.Combine(directory, "tags.json"), """[{"path":"[default]Legacy/Count","kind":"memory","dataType":"Int32","value":3}]""");
var store = new ProjectStore(directory, protection, gatewayOnly: true);
var original = File.ReadAllText(Path.Combine(directory, "tags.json"));
Assert(store.GetTagDefinitions().Count == 1 && store.ExportTags()["version"]!.GetValue<int>() == 2, "Legacy array did not migrate in memory.");
Assert(File.ReadAllText(Path.Combine(directory, "tags.json")) == original, "Loading legacy tags changed disk.");
JsonObject Package() => new() { ["format"] = "sparkstudio.tags", ["version"] = 2, ["tags"] = new JsonArray(), ["scanGroups"] = new JsonArray(), ["udtDefinitions"] = new JsonArray(), ["instances"] = new JsonArray() };
JsonObject Read(string json) => JsonNode.Parse(json)!.AsObject();
JsonObject Definition(int version, int initial = 4) => Read("""{"id":"Counter","version":1,"members":[{"path":"Count","kind":"memory","dataType":"Int32","value":4},{"path":"Twice","kind":"expression","dataType":"Int32","expression":"count * 2","inputs":{"count":"./Count"},"scanGroup":"Fast"}]}""").WithVersion(version, initial);
JsonObject Instance(string unit, int version = 1) => new() { ["path"] = "[default]Units/" + unit, ["definitionId"] = "Counter", ["version"] = version, ["enabled"] = true, ["overrides"] = new JsonObject() };
void Apply(JsonObject package) { var preview = store.PreviewTagImport(package); Assert(preview.CanApply, string.Join(" ", preview.Conflicts ?? [])); store.ApplyTagImport(new(package, preview.Revision, preview.PreviewToken)); }
void Conflict(JsonObject package, string phrase)
{
    var before = store.ExportTags().ToJsonString(); var disk = File.ReadAllText(Path.Combine(directory, "tags.json"));
    var preview = store.PreviewTagImport(package); Assert(!preview.CanApply && preview.Conflicts!.Any(item => item.Contains(phrase, StringComparison.OrdinalIgnoreCase)), "Expected conflict: " + phrase);
    Throws<ArgumentException>(() => store.ApplyTagImport(new(package, preview.Revision, preview.PreviewToken)));
    Assert(store.ExportTags().ToJsonString() == before && File.ReadAllText(Path.Combine(directory, "tags.json")) == disk, "Rejected model changed memory or disk.");
}
var package = Package(); package["scanGroups"]!.AsArray().Add(Read("""{"name":"Fast","publishingIntervalMs":100,"enabled":true}"""));
package["udtDefinitions"]!.AsArray().Add(Definition(1));
var a = Instance("A"); a["overrides"]!["Count"] = new JsonObject { ["value"] = 7 };
package["instances"]!.AsArray().Add(a); package["instances"]!.AsArray().Add(Instance("B"));
var preview = store.PreviewTagImport(package);
Assert(preview.CanApply && preview.TotalTags == 5 && store.GetTagDefinitions().Count == 1, "Preview mutated the store or missed expanded tags.");
store.ApplyTagImport(new(package, preview.Revision, preview.PreviewToken));
Assert(JsonNode.Parse(File.ReadAllText(Path.Combine(directory, "tags.json"))) is JsonObject, "First mutation did not persist atomic envelope.");
var expanded = store.GetTagDefinitions().OfType<JsonObject>().ToDictionary(tag => tag["path"]!.GetValue<string>());
Assert(expanded["[default]Units/A/Twice"]["inputs"]!["count"]!.GetValue<string>() == "[default]Units/A/Count", "Relative member binding escaped instance.");
Assert(expanded["[default]Units/A/Twice"]["publishingIntervalMs"]!.GetValue<int>() == 100, "Scan group interval was ignored.");
Assert(expanded["[default]Units/A/Count"]["value"]!.GetValue<int>() == 7 && expanded["[default]Units/B/Count"]["value"]!.GetValue<int>() == 4, "Instance override leaked.");
Console.WriteLine("PASS legacy migration is read-only until mutation; relative members and independent overrides expand atomically");

var addVersion = Package(); addVersion["udtDefinitions"]!.AsArray().Add(Definition(2, 10)); Apply(addVersion);
Assert(store.GetTagDefinitions().OfType<JsonObject>().Single(tag => tag["path"]!.GetValue<string>() == "[default]Units/B/Count")["value"]!.GetValue<int>() == 4, "New version propagated without explicit pin update.");
var upgrade = Package(); var upgradeA = (JsonObject)a.DeepClone(); upgradeA["version"] = 2; upgrade["instances"]!.AsArray().Add(upgradeA); upgrade["instances"]!.AsArray().Add(Instance("B", 2));
preview = store.PreviewTagImport(upgrade);
Assert(preview.CanApply && preview.Changes.Single(item => item.Path == "[default]Units/A/Count").OverrideFields!.Contains("value"), "Preview omitted retained overrides.");
store.ApplyTagImport(new(upgrade, preview.Revision, preview.PreviewToken));
expanded = store.GetTagDefinitions().OfType<JsonObject>().ToDictionary(tag => tag["path"]!.GetValue<string>());
Assert(expanded["[default]Units/A/Count"]["value"]!.GetValue<int>() == 7 && expanded["[default]Units/B/Count"]["value"]!.GetValue<int>() == 10, "Upgrade did not preserve overrides and propagate defaults.");
var mutate = Package(); mutate["udtDefinitions"]!.AsArray().Add(Definition(2, 11)); Throws<ArgumentException>(() => store.PreviewTagImport(mutate));
store.WriteMemoryTag("[default]Units/B/Count", JsonSerializer.SerializeToElement(12));
Assert(store.ExportTags()["instances"]!.AsArray().OfType<JsonObject>().Single(item => item["path"]!.GetValue<string>().EndsWith("/B"))["overrides"]!["Count"]!["value"]!.GetValue<int>() == 12, "Memory write was not a persistent instance override.");
Throws<ArgumentException>(() => store.SaveTag(expanded["[default]Units/A/Count"])); Throws<ArgumentException>(() => store.DeleteTag("[default]Units/A/Count"));
Console.WriteLine("PASS versions are immutable and pinned; explicit upgrades preserve override fields; memory writes persist overrides");

var removedMember = Package(); var third = Definition(3); third["members"]!.AsArray().RemoveAt(0); third["members"]![0]!["inputs"] = new JsonObject(); third["members"]![0]!["expression"] = "1";
removedMember["udtDefinitions"]!.AsArray().Add(third); var incompatible = (JsonObject)upgradeA.DeepClone(); incompatible["version"] = 3; removedMember["instances"]!.AsArray().Add(incompatible); Conflict(removedMember, "Override references");
var wrongType = Package(); var changedType = Definition(3); changedType["members"]![0]!["dataType"] = "Boolean"; changedType["members"]![0]!["value"] = true; wrongType["udtDefinitions"]!.AsArray().Add(changedType); wrongType["instances"]!.AsArray().Add(incompatible.DeepClone()); Conflict(wrongType, "Boolean");
var missingGroup = Package(); missingGroup["removeScanGroups"] = new JsonArray("Fast"); Conflict(missingGroup, "Missing scan group");
var missingType = Package(); missingType["removeUdtDefinitions"] = new JsonArray("Counter@2"); Conflict(missingType, "Missing UDT definition");
var collision = Package(); collision["tags"]!.AsArray().Add(Read("""{"path":"[default]Units/A/Other","kind":"memory","dataType":"Int32","value":0}""")); Conflict(collision, "namespace");
var missingInput = Package(); missingInput["tags"]!.AsArray().Add(Read("""{"path":"[default]Consumer","kind":"expression","dataType":"Int32","expression":"value","inputs":{"value":"[default]Units/A/Count"}}""")); Apply(missingInput);
var removeInstance = Package(); removeInstance["removeInstances"] = new JsonArray("[default]Units/A"); Conflict(removeInstance, "does not exist");
var multiProvider = Package(); multiProvider["provider"] = Read("""{"name":"remote","enabled":true}"""); Conflict(multiProvider, "Only the default");
var stale = Package(); stale["scanGroups"]!.AsArray().Add(Read("""{"name":"Fast","publishingIntervalMs":200,"enabled":true}""")); preview = store.PreviewTagImport(stale);
store.WriteMemoryTag("[default]Units/B/Count", JsonSerializer.SerializeToElement(13)); Throws<InvalidOperationException>(() => store.ApplyTagImport(new(stale, preview.Revision, preview.PreviewToken)));
Assert(JsonNode.DeepEquals(new ProjectStore(directory, protection, gatewayOnly: true).ExportTags(), store.ExportTags()), "Restart lost model or memory override.");
Console.WriteLine("PASS removed/typed override conflicts, missing groups/types, namespaces, dependent deletion and stale previews reject atomically; restart retains model");

using var connector = new ConnectorService(directory);
using var engine = new TagEngine(store, connector, NullLogger<TagEngine>.Instance);
void ApplyRuntime(JsonObject update) { var review = store.PreviewTagImport(update); Assert(review.CanApply, "Runtime update conflicted."); engine.ApplyImport(new(update, review.Revision, review.PreviewToken)); }
await engine.StartAsync(CancellationToken.None);
try
{
    await WaitFor(() => engine.Read(["[default]Units/B/Twice"], null)[0].Quality == "Good");
    var memory = engine.Read(["[default]Units/B/Count"], null)[0]; var expression = engine.Read(["[default]Units/B/Twice"], null)[0];
    Assert(expression.Value is JsonElement value && value.GetInt32() == 26 && expression.DataType == "Int32" && expression.Timestamp == memory.Timestamp, "UDT expression lost type, source time or override.");
    await Task.Delay(600); Assert(engine.Read([memory.Path], null)[0].Timestamp == memory.Timestamp, "Memory timestamp changed on scan.");
    var disabledGroup = Package(); disabledGroup["scanGroups"]!.AsArray().Add(Read("""{"name":"Fast","publishingIntervalMs":100,"enabled":false}""")); ApplyRuntime(disabledGroup);
    await WaitFor(() => engine.Read([expression.Path], null)[0].Quality == "Bad_Disabled");
    Assert(engine.Read([memory.Path], null)[0].Quality == "Good", "Disabling expression scan group disabled ungrouped memory.");
    disabledGroup["scanGroups"]![0]!["enabled"] = true; ApplyRuntime(disabledGroup); await WaitFor(() => engine.Read([expression.Path], null)[0].Quality == "Good");
    var provider = Package(); provider["provider"] = Read("""{"name":"default","enabled":false}"""); ApplyRuntime(provider);
    await WaitFor(() => engine.Read([memory.Path], null)[0].Quality == "Bad_Disabled");
    Throws<ArgumentException>(() => store.WriteMemoryTag(memory.Path, JsonSerializer.SerializeToElement(14)));
    Assert(JsonSerializer.SerializeToNode(engine.ProviderSnapshot())!["state"]!.GetValue<string>() == "Disabled", "Provider health omitted disabled state.");
    provider["provider"]!["enabled"] = true; ApplyRuntime(provider); await WaitFor(() => engine.Read([expression.Path], null)[0].Quality == "Good");
    Assert(JsonSerializer.SerializeToNode(engine.SubscriptionSnapshot())!.AsArray().Count == 0, "Synthetic UDTs created device subscriptions.");
}
finally { await engine.StopAsync(CancellationToken.None); }
Console.WriteLine("PASS running UDTs preserve scalar type, source timestamp, scan availability and provider health without device subscriptions");

var workshop = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "workshop.json")))!.AsObject();
var catalog = new ProjectCatalog(Path.Combine(directory, "workshop"), protection); var workshopPackage = workshop["tagPackage"]!.AsObject();
preview = catalog.GatewayStore.PreviewTagImport(workshopPackage); Assert(preview.CanApply && preview.TotalTags == 6, "Workshop setup invalid.");
catalog.GatewayStore.ApplyTagImport(new(workshopPackage, preview.Revision, preview.PreviewToken));
var workspace = catalog.Create(workshop["name"]!.GetValue<string>()); var draft = workspace.Store.GetProject(); draft["screens"] = workshop["screens"]!.DeepClone(); draft["navigation"] = workshop["navigation"]!.DeepClone(); workspace.Store.SaveProject(draft);
var bytes = SparkProjectPackage.Export(workspace); var imported = SparkProjectPackage.Import(catalog, bytes, "Imported unit workshop");
Assert(imported.Publication.Metadata()["published"]!.GetValue<bool>() == false, "Workshop import published implicitly.");
imported.Publication.Publish(imported.Store, imported.Store.GetProject()["revision"]!.GetValue<int>());
Assert(SparkProjectPackage.Export(imported).Length > 0 && catalog.GatewayStore.GetTagDefinitions().Count == 6, "Workshop re-export or separate gateway model failed.");
var samples = catalog.GatewayStore.GetTagDefinitions().OfType<JsonObject>().ToArray();
var now = DateTimeOffset.UtcNow; var values = samples.Where(tag => TagDefinitionValidator.Kind(tag) == "memory").ToDictionary(tag => tag["path"]!.GetValue<string>(), tag => new TagValue(tag["path"]!.GetValue<string>(), tag["value"]!.Deserialize<JsonElement>(), tag["dataType"]!.GetValue<string>(), "Good", now, "memory"));
foreach (var plan in TagExpressions.Order(samples)) values[plan.Path] = TagExpressions.Evaluate(plan, values, now);
Assert(((JsonElement)values["[default]UnitModelWorkshop/West/Progress"].Value!).GetDouble() == 50 && ((JsonElement)values["[default]UnitModelWorkshop/East/Progress"].Value!).GetDouble() == 75, "Workshop expected values incorrect.");
Console.WriteLine("PASS independent workshop validates setup, expected values, project export/import, explicit publication and re-export");
Console.WriteLine("5 tag model groups passed.");
static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
static void Throws<T>(Action action) where T : Exception { try { action(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name); }
static async Task WaitFor(Func<bool> predicate) { var until = DateTime.UtcNow.AddSeconds(8); while (!predicate()) { if (DateTime.UtcNow >= until) throw new Exception("Timed out awaiting tag model state."); await Task.Delay(100); } }
static class Fixtures { public static JsonObject WithVersion(this JsonObject model, int version, int initial) { model["version"] = version; model["members"]![0]!["value"] = initial; return model; } }
`);
const dotnet = path.join(root, '.tools/dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
const options = { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, APPDATA: path.join(root, '.tools/test-appdata'), DOTNET_CLI_HOME: path.join(root, '.tools/dotnet-home'), NUGET_PACKAGES: path.join(root, '.tools/nuget'), DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' } };
for (const args of [['restore', project, '--configfile', path.join(directory, 'NuGet.Config'), '-p:NuGetAudit=false', '--verbosity', 'quiet'], ['run', '--project', project, '--configuration', 'G10TagModel', '--no-restore', '--no-launch-profile', '--verbosity', 'quiet']]) {
  const result = spawnSync(dotnet, args, options); process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); assert.equal(result.status, 0, 'Tag model checks failed.');
}
