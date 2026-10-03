#!/usr/bin/env node
// Synthetic online configuration snapshots only; never reads installed gateway data.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { root, runIsolatedFixture } from './test-environment.mjs';

const directory = path.join(root, '.data/test-evidence', `configuration-backup-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
await writeFile(path.join(directory, 'Check.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><ProjectReference Include="${xml(path.join(root, 'src/SparkStudio.Gateway/SparkStudio.Gateway.csproj'))}"/></ItemGroup></Project>`);
await writeFile(path.join(directory, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
await writeFile(path.join(directory, 'Program.cs'), String.raw`
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using SparkStudio.Gateway;

var fixture = Path.Combine(AppContext.BaseDirectory, "fixture"); Directory.CreateDirectory(fixture);
var source = Path.Combine(fixture, "source"); Directory.CreateDirectory(source);
const string password = "synthetic-configuration-archive-passphrase";
var protection = DataProtectionProvider.Create(new DirectoryInfo(Path.Combine(source, "keys")), builder =>
{
    builder.SetApplicationName("SparkStudio"); if (OperatingSystem.IsWindows()) builder.ProtectKeysWithDpapi();
});
var catalog = new ProjectCatalog(source, protection);
var project = catalog.Create("Online configuration lab");
var draft = project.Store.GetProject();
project.Scripts.SaveDraft(project.Scripts.GetDraft());
var review = project.Publication.Review(project.Store);
project.Publication.Publish(project.Store, review["revision"]!.GetValue<int>(), review["scriptsRevision"]!.GetValue<int>(), review["reviewToken"]!.GetValue<string>());
draft["name"] = "Unpublished configuration draft"; project.Store.SaveProject(draft);
var security = new SecurityStore(source);
var account = security.Setup(File.ReadAllText(Path.Combine(source, "security/setup-code.txt")).Trim(), new("fixture-admin", "synthetic-account-password"));
catalog.GatewayStore.SaveConnection(new JsonObject { ["id"]="fixture-opc", ["name"]="Fixture", ["type"]="opcua", ["endpoint"]="opc.tcp://127.0.0.1:59999", ["password"]="synthetic-secret" });
Put("backup-settings.json", "{\"protectedPassphrase\":\"synthetic-protected-canary\"}");
Put("backup-state.json", "operational-history-canary"); Put("notes.txt", "unknown-user-file-canary");
Put("projects/" + project.Id + "/notes.txt", "unknown-project-file-canary");
Put("databases/active.db", "NOT-A-SQLITE-SNAPSHOT"); Put("databases/active.db-wal", "LIVE-WAL");
Put("certificates/deployment/tls.pem", "synthetic-certificate"); Put("pki/own/fixture.der", "synthetic-opc-certificate");
Put("backup-work/old.sparkbak", "excluded-archive-cache");
for (var index=0;index<150;index++) Put($"omitted-{index:D3}-{new string('x',60)}.txt", "not-configuration");
var archive = Path.Combine(source, "backup-work", "online.sparkbak");
using var runningGateway = DataDirectoryLease.Acquire(source);
// An active database writer must not prevent configuration backup: its data is excluded.
using var activeDatabase = new FileStream(Path.Combine(source, "databases/active.db"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
var report = await ConfigurationBackupSnapshot.CreateAsync(source, archive, password);
Assert(report.Scope == "configuration" && !report.SourceWasQuarantined, "Wrong snapshot scope/source state.");
var exclusions = report.ExcludedPaths ?? throw new Exception("Missing explicit exclusions.");
Assert(exclusions.Contains("databases/") && exclusions.Contains("backup-work/") && exclusions.Contains("backup-state.json")
    && exclusions.Contains("security/audit.jsonl") && exclusions.Contains("notes.txt"), "Exclusions were not explicit.");
var restored = Path.Combine(fixture, "restored"); await GatewayRecovery.RestoreAsync(archive, restored, password);
Assert(!Directory.Exists(Path.Combine(restored,"databases")) && !File.Exists(Path.Combine(restored,"security/audit.jsonl")), "Online backup copied active operational data.");
Assert(!File.Exists(Path.Combine(restored,"notes.txt")) && !Directory.Exists(Path.Combine(restored,"backup-work")), "Excluded content leaked into configuration snapshot.");
Assert(File.ReadAllText(Path.Combine(restored,"backup-settings.json")).Contains("protectedPassphrase"), "Backup configuration was omitted.");
Assert(JsonNode.Parse(File.ReadAllText(Path.Combine(restored, GatewayRecovery.QuarantineFileName)))!["scope"]!.GetValue<string>() == "configuration", "Restore receipt omitted scope.");
var receiptBytes = File.ReadAllBytes(Path.Combine(restored, GatewayRecovery.QuarantineFileName));
var receipt = JsonNode.Parse(receiptBytes)!.AsObject();
Assert(receiptBytes.Length <= 8192 && receipt["excludedPathCount"]!.GetValue<int>() == exclusions.Count && receipt["excludedPaths"]!.AsArray().Count <= 32, "Many exclusions exceeded the bounded receipt preview or lost its total count.");
Assert(new RecoveryQuarantine(restored).Active && !((System.Text.Json.Nodes.JsonObject)System.Text.Json.JsonSerializer.SerializeToNode(new RecoveryQuarantine(restored).Snapshot())!)["invalidMarker"]!.GetValue<bool>(), "Configuration receipt cannot be reviewed after restoring many excluded paths.");
var recoveredProtection = DataProtectionProvider.Create(new DirectoryInfo(Path.Combine(restored,"keys")), builder =>
{ builder.SetApplicationName("SparkStudio"); if(OperatingSystem.IsWindows()) builder.ProtectKeysWithDpapi(); });
var recovered = new ProjectCatalog(restored, recoveredProtection);
Assert(recovered.Get(project.Id).Store.GetProject()["name"]!.GetValue<string>() == "Unpublished configuration draft", "Unpublished draft was lost.");
Assert(recovered.Get(project.Id).Publication.GetProject()["name"]!.GetValue<string>() == "Online configuration lab", "Publication did not retain its own state.");
Assert(recovered.GatewayStore.GetConnection("fixture-opc").Password == "synthetic-secret", "Protected keyring and connection credential did not round-trip.");
Assert(new SecurityStore(restored).Login("fixture-admin","synthetic-account-password","127.0.0.1").Id == account.Id, "Account hashes/grants did not survive.");
Console.WriteLine("PASS running-host configuration snapshot restores drafts/publications/scripts/accounts/DPAPI/certificates and explicitly excludes active databases/audit/cache/unknown files");

using (var held = new FileStream(Path.Combine(source,"connections.json"), FileMode.Open,FileAccess.ReadWrite,FileShare.None))
    await Reject(() => ConfigurationBackupSnapshot.CreateAsync(source, Path.Combine(source,"backup-work/held.sparkbak"),password), "active configuration writer");
Assert(!File.Exists(Path.Combine(source,"backup-work/held.sparkbak")),"Conflicting writer produced archive.");
using (var cancelled = new CancellationTokenSource())
{
    var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    using var release = new ManualResetEventSlim();
    var holder = Task.Run(() => { lock(GatewayConfigurationLock.SyncRoot) { entered.SetResult(); release.Wait(); } });
    await entered.Task;
    try { var capture = ConfigurationBackupSnapshot.CreateAsync(source,Path.Combine(source,"backup-work/cancelled.sparkbak"),password,cancelled.Token); cancelled.Cancel(); await Reject(()=>capture,"cancellation waiting for configuration gate"); }
    finally { release.Set(); await holder; }
}
Assert(!Directory.GetDirectories(Path.Combine(source,"backup-work"),".sparkstudio-config-*").Any(),"Failed capture leaked plaintext staging.");
Console.WriteLine("PASS active configuration writer and cancellation fail without committing archives or leaving private staging");

// Real catalog creation writes several resource files plus the catalog. Racing it
// with a snapshot must recover either no entry or a complete usable project.
var creates = Task.Run(() => { for(var i=0;i<12;i++) catalog.Create("Concurrent configuration " + i); });
var concurrent = Path.Combine(source,"backup-work/concurrent.sparkbak");
await ConfigurationBackupSnapshot.CreateAsync(source, concurrent,password); await creates;
var concurrentRestore = Path.Combine(fixture,"concurrent-restore"); await GatewayRecovery.RestoreAsync(concurrent,concurrentRestore,password);
var concurrentCatalog = new ProjectCatalog(concurrentRestore,recoveredProtection);
foreach(var item in concurrentCatalog.List().OfType<JsonObject>())
{
    var workspace = concurrentCatalog.Get(item["id"]!.GetValue<string>());
    Assert(workspace.Store.GetProject()["id"]!.GetValue<string>() == workspace.Id,"Snapshot captured a partially created catalog entry.");
}
var gateEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
using var gateRelease = new ManualResetEventSlim();
var gateHolder = Task.Run(() => { lock(GatewayConfigurationLock.SyncRoot) { gateEntered.SetResult(); gateRelease.Wait(); } });
await gateEntered.Task;
try
{
    var writerStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var writer = Task.Run(() => { writerStarted.SetResult(); var value=project.Store.GetProject(); value["name"]="After capture gate"; return project.Store.SaveProject(value); });
    await writerStarted.Task; await Task.Delay(100);
    Assert(!writer.IsCompleted,"Real ProjectStore bypassed snapshot coordination.");
    gateRelease.Set(); await writer;
}
finally { gateRelease.Set(); await gateHolder; }
Console.WriteLine("PASS real project writers coordinate with capture and concurrent multi-file catalog creation remains consistent");

await Reject(()=>ConfigurationBackupSnapshot.CreateAsync(source,Path.Combine(source,"unsafe.sparkbak"),password),"archive within configuration");
var oversized=Path.Combine(source,"certificates/oversized.pem");
using(var file=File.Create(oversized)) file.SetLength(ConfigurationBackupSnapshot.MaximumFileBytes+1);
await Reject(()=>ConfigurationBackupSnapshot.CreateAsync(source,Path.Combine(source,"backup-work/oversized.sparkbak"),password),"configuration size limit");
Assert(!Directory.GetDirectories(Path.Combine(source,"backup-work"),".sparkstudio-config-*").Any(),"Oversize capture leaked staging.");
Console.WriteLine("PASS archive placement and configuration size budgets fail before commit and clean staging");
Console.WriteLine("4 online configuration backup groups passed.");

void Put(string relative,string content) { var file=Path.Combine(source,relative); Directory.CreateDirectory(Path.GetDirectoryName(file)!); File.WriteAllText(file,content); }
static void Assert(bool value,string message) { if(!value) throw new Exception(message); }
static async Task Reject(Func<Task> work,string description)
{ try { await work(); } catch(Exception error) when(error is ArgumentException or InvalidOperationException or InvalidDataException or IOException or UnauthorizedAccessException or OperationCanceledException) { return; } throw new Exception("Expected rejection: "+description); }
`);
await mkdir(path.join(directory, 'dotnet-roaming'), { recursive: true });
const result = await runIsolatedFixture(path.join(directory, 'Check.csproj'), 'ConfigurationBackupModel');
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
assert.equal(result.status, 0, result.error?.message ?? 'Online configuration backup tests failed.');
console.log('PASS isolated configuration backup fixture preserves the calling production dependency assets.');
console.log(`Evidence: ${directory}`);
