#!/usr/bin/env node
// Exercise the actual publication store with isolated filesystem failures.
// Generated harnesses and large synthetic query fixtures remain under .data/.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const root = process.cwd(), directory = path.resolve('.data/test-evidence', `publication-history-store-${randomUUID()}`);
assert.ok(directory.startsWith(path.resolve('.data') + path.sep));
await mkdir(directory, { recursive: true });
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
await writeFile(path.join(directory, 'PublicationHistoryStoreCheck.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><ProjectReference Include="${escape(path.join(root, 'src/SparkStudio.Gateway/SparkStudio.Gateway.csproj'))}"/></ItemGroup></Project>`);
await writeFile(path.join(directory, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
await writeFile(path.join(directory, 'Program.cs'), String.raw`
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using SparkStudio.Gateway;

var root = Path.Combine(AppContext.BaseDirectory, "fixture");
Directory.CreateDirectory(root);
var fixture = Create("atomic");
var path = Path.Combine(fixture.Directory, "published.json");
var first = fixture.Publications.Publish(fixture.Store, Revision(fixture.Store));
var firstId = fixture.Publications.History()["entries"]![0]!["id"]!.GetValue<string>();
var beforeBytes = File.ReadAllBytes(path);
var beforeHistory = fixture.Publications.History();
var draft = fixture.Store.GetProject(); draft["screens"]![0]!["components"]![0]!["props"]!["text"] = "Second version";
fixture.Store.SaveProject(draft);
var savedDraft = fixture.Store.GetProject();
Directory.CreateDirectory(path + ".tmp");
DeniesWrite(() => fixture.Publications.Publish(fixture.Store, Revision(fixture.Store)));
Assert(File.ReadAllBytes(path).SequenceEqual(beforeBytes), "A failed write changed the published file.");
Equal(beforeHistory, fixture.Publications.History(), "A failed publish exposed an uncommitted history candidate.");
Equal(first, fixture.Publications.Metadata(), "A failed write changed in-memory metadata.");
Equal(savedDraft, fixture.Store.GetProject(), "Failed publication changed the draft.");
Directory.Delete(path + ".tmp"); // Exact empty directory created above, under this isolated fixture.
var second = fixture.Publications.Publish(fixture.Store, Revision(fixture.Store));
Assert(fixture.Publications.History()["entries"]!.AsArray().Count == 2, "Retry retained an incomplete candidate.");
Console.WriteLine("PASS failed publication leaves current file, history, metadata and draft unchanged; retry records only the committed version");

beforeBytes = File.ReadAllBytes(path); beforeHistory = fixture.Publications.History();
Directory.CreateDirectory(path + ".tmp");
DeniesWrite(() => fixture.Publications.Rollback(firstId, second["publishedAt"]!.GetValue<string>()));
Assert(File.ReadAllBytes(path).SequenceEqual(beforeBytes), "A failed restore changed the published file.");
Equal(beforeHistory, fixture.Publications.History(), "A failed restore exposed an uncommitted history candidate.");
Equal(savedDraft, fixture.Store.GetProject(), "Failed restore changed the draft.");
Directory.Delete(path + ".tmp");
var restored = fixture.Publications.Rollback(firstId, second["publishedAt"]!.GetValue<string>());
Assert(fixture.Publications.GetProject()["screens"]![0]!["components"]![0]!["props"]!["text"]!.GetValue<string>() == "Original", "Restore did not recover the original content.");
Equal(savedDraft, fixture.Store.GetProject(), "Successful restore changed the draft.");
var reloaded = new PublicationStore(fixture.Directory, new LocalAssetStore(fixture.Directory));
Equal(fixture.Publications.History(), reloaded.History(), "Restart lost committed history.");
Equal(restored, reloaded.Metadata(), "Restart lost the current restored version.");
Assert(reloaded.History()["entries"]!.AsArray().Count == 3, "Restoration did not create one fresh history entry.");
Console.WriteLine("PASS failed restore is atomic; successful restore and history survive restart without touching the draft");

var empty = Create("first-failure");
Directory.CreateDirectory(Path.Combine(empty.Directory, "published.json.tmp"));
DeniesWrite(() => empty.Publications.Publish(empty.Store, Revision(empty.Store)));
Assert(!File.Exists(Path.Combine(empty.Directory, "published.json")), "First failed publish created a publication file.");
Assert(empty.Publications.Metadata()["published"]!.GetValue<bool>() == false, "First failed publish became active.");
Assert(empty.Publications.History()["entries"]!.AsArray().Count == 0, "First failed publish added history.");
Console.WriteLine("PASS failed first publication remains unpublished with empty history");

var oversized = Create("oversized");
oversized.Publications.Publish(oversized.Store, Revision(oversized.Store));
var oversizedPath = Path.Combine(oversized.Directory, "published.json");
var smallBytes = File.ReadAllBytes(oversizedPath); var smallHistory = oversized.Publications.History();
oversized.Store.SaveQuery("large-query", Query(new string('x', 17 * 1024 * 1024)));
DeniesValidation(() => oversized.Publications.Publish(oversized.Store, Revision(oversized.Store)), "16 MiB");
Assert(File.ReadAllBytes(oversizedPath).SequenceEqual(smallBytes), "An oversized snapshot changed the current file before rejection.");
Equal(smallHistory, oversized.Publications.History(), "An oversized snapshot poisoned history.");
Assert(!File.Exists(oversizedPath + ".tmp"), "Oversize preflight wrote a temporary publication.");
oversized.Store.SaveQuery("large-query", Query("SELECT 1"));
oversized.Publications.Publish(oversized.Store, Revision(oversized.Store));
Assert(oversized.Publications.History()["entries"]!.AsArray().Count == 2, "The valid retry did not recover after oversize rejection.");
Console.WriteLine("PASS oversized snapshot is rejected before any publication/history write and a corrected retry succeeds");

var budget = Create("byte-budget");
budget.Store.SaveQuery("large-query", Query(new string('x', 6 * 1024 * 1024)));
for (var index = 0; index < 5; index++) budget.Publications.Publish(budget.Store, Revision(budget.Store));
var budgetPath = Path.Combine(budget.Directory, "published.json");
Assert(new FileInfo(budgetPath).Length <= 32L * 1024 * 1024, "Publication exceeded its aggregate 32 MiB budget.");
var bounded = budget.Publications.History()["entries"]!.AsArray();
Assert(bounded.Count is > 0 and < 5, "Byte budget did not prune old history records.");
Assert(bounded[0]!["current"]!.GetValue<bool>(), "Byte pruning dropped the current snapshot.");
var serialized = JsonNode.Parse(File.ReadAllBytes(budgetPath))!.AsObject();
Assert(serialized["history"]!.AsArray().All(record => record!["snapshot"]!["history"] is null), "History snapshots recursively contain history.");
Equal(budget.Publications.History(), new PublicationStore(budget.Directory, new LocalAssetStore(budget.Directory)).History(), "Byte-pruned history failed restart validation.");
Console.WriteLine("PASS total-byte retention prunes oldest records, preserves current snapshot and never nests histories");

var validBytes = File.ReadAllBytes(path);
var corrupt = JsonNode.Parse(validBytes)!.AsObject();
corrupt["history"]![0]!["snapshot"]!["project"]!["name"] = "Tampered history";
File.WriteAllText(path, corrupt.ToJsonString(ProjectStore.Json));
var corruptBytes = File.ReadAllBytes(path);
var invalid = new PublicationStore(fixture.Directory, new LocalAssetStore(fixture.Directory));
DeniesValidation(() => invalid.History(), "checksum");
DeniesValidation(() => invalid.Publish(fixture.Store, Revision(fixture.Store)), "checksum");
DeniesValidation(() => invalid.Rollback(firstId, invalid.Metadata()["publishedAt"]!.GetValue<string>()), "checksum");
Assert(File.ReadAllBytes(path).SequenceEqual(corruptBytes), "A corrupt-history rejection overwrote the current file.");
File.WriteAllBytes(path, validBytes);
Equal(fixture.Publications.History(), new PublicationStore(fixture.Directory, new LocalAssetStore(fixture.Directory)).History(), "Restoring verified bytes did not recover history.");
Console.WriteLine("PASS corrupt snapshot checksum blocks history, publishing and restore without overwriting files; verified bytes recover");
var legacy = Create("legacy-oversized");
legacy.Publications.Publish(legacy.Store, Revision(legacy.Store));
var legacyPath = Path.Combine(legacy.Directory, "published.json");
var legacySnapshot = JsonNode.Parse(File.ReadAllBytes(legacyPath))!.AsObject();
legacySnapshot.Remove("history"); legacySnapshot.Remove("historyWarnings");
var legacyQuery = Query(new string('x', 17 * 1024 * 1024)); legacyQuery["id"] = "legacy-large";
legacySnapshot["scriptQueries"] = new JsonArray(legacyQuery);
legacySnapshot["publishedAt"] = DateTimeOffset.UtcNow.AddDays(-1).ToString("O");
File.WriteAllText(legacyPath, legacySnapshot.ToJsonString(ProjectStore.Json));
var legacyBytes = File.ReadAllBytes(legacyPath);
var migration = new PublicationStore(legacy.Directory, new LocalAssetStore(legacy.Directory));
var pending = migration.History();
Assert(pending["warnings"]!.AsArray().Count == 1 && pending["warnings"]![0]!.GetValue<string>().Contains("current legacy"), "History did not disclose the pending retention exception.");
Assert(pending["entries"]!.AsArray().Count == 0, "Legacy snapshot was incorrectly recorded as retained history.");
Directory.CreateDirectory(legacyPath + ".tmp");
DeniesWrite(() => migration.Publish(legacy.Store, Revision(legacy.Store)));
Assert(File.ReadAllBytes(legacyPath).SequenceEqual(legacyBytes), "Failed migration replaced the oversized legacy application.");
Equal(pending, migration.History(), "Failed migration committed a warning or changed history.");
Directory.Delete(legacyPath + ".tmp");
var migrated = migration.Publish(legacy.Store, Revision(legacy.Store));
Assert(migrated["warnings"]!.AsArray().Count == 1 && migrated["warnings"]![0]!.GetValue<string>().Contains("could not be retained"), "Migration success metadata did not visibly report the omitted legacy snapshot.");
Assert(migration.History()["entries"]!.AsArray().Count == 1, "Migration retained an oversized entry or lost the new current snapshot.");
Assert(new FileInfo(legacyPath).Length < 16 * 1024 * 1024, "Migration did not replace the oversized legacy file with the valid reduced snapshot.");
var afterMigration = new PublicationStore(legacy.Directory, new LocalAssetStore(legacy.Directory));
Equal(migration.History(), afterMigration.History(), "Migration warning or new history did not survive restart.");
afterMigration.Publish(legacy.Store, Revision(legacy.Store));
Assert(afterMigration.History()["warnings"]!.AsArray().Count == 1, "Subsequent publication lost or duplicated the migration warning.");
var migrationRoot = JsonNode.Parse(File.ReadAllBytes(legacyPath))!.AsObject();
Assert(migrationRoot["history"]!.AsArray().All(record => record!["snapshot"]!["history"] is null && record["snapshot"]!["historyWarnings"] is null), "Migration diagnostics became nested snapshot resources.");
Console.WriteLine("PASS oversized legacy migration is disclosed, remains atomic on failure, preserves a valid new history and retains its warning across restart and later publication");
Console.WriteLine("7 publication store failure and recovery groups passed.");

(string Directory, ProjectStore Store, PublicationStore Publications) Create(string name)
{
    var directory = Path.GetFullPath(Path.Combine(root, name));
    Assert(directory.StartsWith(Path.GetFullPath(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase), "Fixture escaped the isolated root.");
    Directory.CreateDirectory(directory);
    var store = new ProjectStore(directory, new EphemeralDataProtectionProvider(), projectId: "history-store-check");
    var project = JsonNode.Parse("""
      {"id":"history-store-check","name":"History fixture","revision":0,"parameters":{},"templates":[],"screens":[{"id":"main","name":"Main","width":640,"height":400,"components":[{"id":"title","type":"label","x":20,"y":20,"width":400,"height":60,"props":{"text":"Original"}}]}],"navigation":{"mode":"none","startupScreenId":"main","items":[]}}
      """)!.AsObject();
    project["revision"] = Revision(store); store.SaveProject(project);
    return (directory, store, new PublicationStore(directory, new LocalAssetStore(directory)));
}
static JsonObject Query(string sql) => new() { ["name"] = "Synthetic read query", ["connectionId"] = "synthetic-unused", ["kind"] = "query", ["sql"] = sql, ["parameters"] = new JsonArray() };
static int Revision(ProjectStore store) => store.GetProject()["revision"]!.GetValue<int>();
static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
static void Equal(JsonNode expected, JsonNode actual, string message) => Assert(JsonNode.DeepEquals(expected, actual), message);
static void DeniesWrite(Action action) { try { action(); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return; } throw new Exception("Expected a filesystem write failure."); }
static void DeniesValidation(Action action, string message) { try { action(); } catch (Exception error) when (error is ArgumentException or InvalidOperationException && error.Message.Contains(message, StringComparison.Ordinal)) { return; } throw new Exception("Expected validation failure containing: " + message); }
`);
const dotnet = path.join(root, '.tools/dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
const options = { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, DOTNET_CLI_HOME: path.join(root, '.tools/dotnet-home'), NUGET_PACKAGES: path.join(root, '.tools/nuget'), DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' } };
const project = path.join(directory, 'PublicationHistoryStoreCheck.csproj');
const restore = spawnSync(dotnet, ['restore', project, '--configfile', path.join(directory, 'NuGet.Config'), '-p:NuGetAudit=false', '--verbosity', 'quiet'], options);
process.stdout.write(restore.stdout || ''); process.stderr.write(restore.stderr || '');
assert.equal(restore.status, 0, 'Publication store harness restore failed.');
const result = spawnSync(dotnet, ['run', '--project', project, '--configuration', 'PublicationHistoryStoreCheck', '--no-restore', '--no-launch-profile', '--verbosity', 'quiet'], options);
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
assert.equal(result.status, 0, 'Publication store failure/recovery checks failed.');
