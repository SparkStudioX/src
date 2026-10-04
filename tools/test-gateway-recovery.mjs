#!/usr/bin/env node
// Framework/model recovery fixtures only. Never reads installed or development gateway data.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const root = process.cwd();
const directory = path.resolve('.data/test-evidence', `recovery-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
await writeFile(path.join(directory, 'RecoveryCheck.csproj'), `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup>${['DataDirectoryLease.cs', 'GatewayRecovery.cs', 'GatewayRecoveryCli.cs'].map(file => `<Compile Include="${xml(path.join(root, 'src/SparkStudio.Gateway', file))}" Link="${file}"/>`).join('')}<PackageReference Include="Microsoft.Data.Sqlite" Version="10.0.12"/></ItemGroup></Project>`);
await writeFile(path.join(directory, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
await writeFile(path.join(directory, 'Program.cs'), String.raw`
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.Sqlite;
using SparkStudio.Gateway;

if (GatewayRecoveryCli.IsRequested(args)) { Environment.ExitCode = await GatewayRecoveryCli.RunAsync(args); return; }
if (args.Length > 0 && args[0] == "--hold-lease")
{
    using var held = DataDirectoryLease.Acquire(args[1]); Console.WriteLine("held"); await Console.In.ReadLineAsync(); return;
}
if (args.Length > 0 && args[0] == "--create-wal")
{
    var database = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = args[1], Pooling = false }.ToString());
    database.Open(); using var command = database.CreateCommand();
    command.CommandText = "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('committed-only-in-wal');";
    command.ExecuteNonQuery(); GC.KeepAlive(database);
    // Deliberately bypass SQLite close/checkpoint, like abrupt host exit. This
    // touches only this fixture DB and leaves committed WAL records for recovery.
    Environment.Exit(0); return;
}
var fixture = Path.Combine(AppContext.BaseDirectory, "fixture"); Directory.CreateDirectory(fixture);
var source = Path.Combine(fixture, "source"); Directory.CreateDirectory(source);
const string passphrase = "synthetic-recovery-passphrase-2026";
static void Check(bool value, string message) { if (!value) throw new Exception(message); }
static async Task Reject(Func<Task> action, string name)
{
    try { await action(); } catch (Exception error) when (error is ArgumentException or InvalidOperationException or InvalidDataException or IOException or UnauthorizedAccessException or OperationCanceledException) { return; }
    throw new Exception("Expected recovery rejection: " + name);
}
static Process Child(params string[] arguments)
{
    var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
    foreach (var argument in arguments) start.ArgumentList.Add(argument);
    return Process.Start(start)!;
}
void Put(string relative, string value)
{
    var file = Path.Combine(source, relative); Directory.CreateDirectory(Path.GetDirectoryName(file)!); File.WriteAllText(file, value);
}
Put("projects.json", "{\"defaultId\":\"test\",\"projects\":[]}");
Put("projects/test/project.json", "{\"name\":\"Synthetic recovery workshop\"}");
Put("projects/archived/published.json", "{\"revision\":3,\"history\":[1,2]}");
Put("projects/test/scripts-published.json", "{\"resources\":[\"do-not-run-fixture\"]}");
Put("projects/test/scripts-draft.json", "{\"resources\":[]}");
Put("projects/test/assets/example.json", "{\"name\":\"fixture\"}");
Put("projects/test/assets/example.bin", "synthetic-asset-canary");
Put("security/identities.json", "{\"accounts\":[\"synthetic-hash-canary\"]}");
Put("security/audit.jsonl", "{\"action\":\"fixture\"}\n"); Put("security/audit.jsonl.previous", "previous-audit-fixture");
Put("security/setup-code.txt", "synthetic-setup-canary");
Put("tags.json", """{"format":"sparkstudio.tags","version":3,"provider":{"name":"default","enabled":true},"tags":[],"scanGroups":[],"udtDefinitions":[],"instances":[],"hierarchy":[]}"""); Put("connections.json", "[]");
Put("deployment.json", "{\"revision\":2}"); Put("deployment.json.previous", "{\"revision\":1}");
Put("certificates/deployment/fixture.pem", "synthetic-noncertificate-fixture"); Put("pki/rejected/fixture.der", "synthetic-pki-fixture");
Put("unknown/operator-notes.txt", "additional-local-data-canary"); Put("projects/.orphan-fixture/state.tmp", "interrupted-local-state");
Put("backup-work/cached.sparkbak", "excluded-owned-backup-cache");
Put(GatewayRecovery.QuarantineFileName, "{\"state\":\"quarantined\"}");
Directory.CreateDirectory(Path.Combine(source, "keys"));
var provider = DataProtectionProvider.Create(new DirectoryInfo(Path.Combine(source, "keys")), builder =>
{
    builder.SetApplicationName("SparkStudio"); if (OperatingSystem.IsWindows()) builder.ProtectKeysWithDpapi();
});
var protectedValue = provider.CreateProtector("SparkStudio.ConnectionSecrets.v1").Protect("synthetic-protected-password");
Put("connections.json", JsonSerializer.Serialize(new { protectedPassword = protectedValue }));
Directory.CreateDirectory(Path.Combine(source, "databases"));
using (var wal = Child("--create-wal", Path.Combine(source, "databases", "fixture.db")))
{
    await wal.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20)); Check(wal.ExitCode == 0, await wal.StandardError.ReadToEndAsync());
}
Check(File.Exists(Path.Combine(source, "databases/fixture.db-wal")), "WAL-only fixture was checkpointed unexpectedly.");
var sourceHashes = Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories)
    .Where(file => Path.GetRelativePath(source, file) is not GatewayRecovery.QuarantineFileName and not DataDirectoryLease.FileName
        && !Path.GetRelativePath(source, file).Replace('\\', '/').StartsWith("backup-work/", StringComparison.Ordinal))
    .ToDictionary(file => Path.GetRelativePath(source, file).Replace('\\', '/'), file => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))));
var archive = Path.Combine(fixture, "gateway.sparkbak");
var report = await GatewayRecovery.BackupAsync(source, archive, passphrase);
Check(report.FileCount == sourceHashes.Count && report.SourceWasQuarantined && report.Categories["additional-local-data"] > 0, "Snapshot omitted source files or classification.");
Check(!Encoding.UTF8.GetString(File.ReadAllBytes(archive)).Contains("canary"), "Encrypted archive disclosed plaintext fixture values.");
var inspection = await GatewayRecovery.InspectAsync(archive, passphrase);
Check(inspection.ArchiveId == report.ArchiveId && inspection.TotalBytes == report.TotalBytes, "Authenticated inspection changed coverage.");
var restored = Path.Combine(fixture, "restored"); await GatewayRecovery.RestoreAsync(archive, restored, passphrase);
Check(report.Scope == "full" && report.ExcludedPaths!.Contains("backup-work/") && !Directory.Exists(Path.Combine(restored, "backup-work")), "Full archive scope/cache exclusion is incorrect.");
foreach (var (relative, digest) in sourceHashes)
    Check(Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(restored, relative)))) == digest, "Restored bytes changed: " + relative);
Check(JsonNode.Parse(File.ReadAllText(Path.Combine(restored, GatewayRecovery.QuarantineFileName)))?["state"]?.GetValue<string>() == "quarantined", "Restore omitted quarantine marker.");
if (OperatingSystem.IsWindows())
{
    var acl = new DirectoryInfo(restored).GetAccessControl();
    Check(acl.AreAccessRulesProtected, "Restore inherited broad parent ACLs.");
    var users = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
    foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        Check(rule.IdentityReference != users, "Restore granted broad Users access.");
}
Console.WriteLine("PASS complete classified encrypted snapshot, opaque resources, exact byte round-trip and private quarantine destination");

var restoredProvider = DataProtectionProvider.Create(new DirectoryInfo(Path.Combine(restored, "keys")), builder => builder.SetApplicationName("SparkStudio"));
Check(restoredProvider.CreateProtector("SparkStudio.ConnectionSecrets.v1").Unprotect(protectedValue) == "synthetic-protected-password", "Same-identity restored keyring did not decrypt fixture credentials.");
using (var database = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(restored, "databases/fixture.db"), Pooling = false }.ToString()))
{
    database.Open(); using var query = database.CreateCommand(); query.CommandText = "SELECT value FROM fixture";
    Check((string?)query.ExecuteScalar() == "committed-only-in-wal", "Restored SQLite omitted committed WAL content.");
}
foreach (var (relative, digest) in sourceHashes)
    Check(Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(source, relative)))) == digest, "Recovery modified source data.");
Console.WriteLine("PASS real SQLite committed WAL recovery and original-identity protected keyring; source bytes unchanged");

using (var holder = Child("--hold-lease", source))
{
    Check(await holder.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10)) == "held", "Lease holder failed.");
    await Reject(() => GatewayRecovery.BackupAsync(source, Path.Combine(fixture, "busy.sparkbak"), passphrase), "concurrent host lease");
    holder.StandardInput.Close(); await holder.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
}
using (DataDirectoryLease.Acquire(source)) { }
await Reject(() => GatewayRecovery.BackupAsync(source, archive, passphrase), "existing archive");
await Reject(() => GatewayRecovery.BackupAsync(source, Path.Combine(source, "self.sparkbak"), passphrase), "archive inside source");
await Reject(() => GatewayRecovery.RestoreAsync(archive, restored, passphrase), "existing destination");
Check(File.Exists(Path.Combine(restored, "projects/test/project.json")), "Rejected restore changed existing target.");
Console.WriteLine("PASS cross-process exclusive lease, released lease, archive isolation and non-replacing restore");
var directoryBudget = Path.Combine(fixture, "directory-budget"); Directory.CreateDirectory(directoryBudget);
foreach (var name in new[] { "one", "two", "three" }) Directory.CreateDirectory(Path.Combine(directoryBudget, name));
Check(GatewayRecovery.Inventory(directoryBudget, CancellationToken.None, 3).Length == 0, "Exactly bounded empty directories should be accepted.");
Directory.CreateDirectory(Path.Combine(directoryBudget, "four"));
await Reject(() => Task.Run(() => GatewayRecovery.Inventory(directoryBudget, CancellationToken.None, 3)), "empty-directory inventory budget");
File.WriteAllText(Path.Combine(directoryBudget, "ordinary.txt"), "fixture");
await Reject(() => Task.Run(() => GatewayRecovery.Inventory(directoryBudget, CancellationToken.None, 4)), "combined file and directory inventory budget");
Console.WriteLine("PASS inventory budget counts empty directories and files before recursion");
using (var writer = new FileStream(Path.Combine(source, "connections.json"), FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite))
    await Reject(() => GatewayRecovery.BackupAsync(source, Path.Combine(fixture, "writer.sparkbak"), passphrase), "external file writer");

await Reject(() => GatewayRecovery.InspectAsync(archive, "incorrect-passphrase"), "wrong passphrase");
var original = File.ReadAllBytes(archive);
foreach (var kind in new[] { "ciphertext", "truncated", "append", "version", "kdf" })
{
    var damaged = original.ToArray();
    if (kind == "ciphertext") damaged[70] ^= 1;
    if (kind == "truncated") damaged = damaged[..^1];
    if (kind == "append") damaged = [.. damaged, 1];
    if (kind == "version") damaged[8] = 99;
    if (kind == "kdf") Array.Fill<byte>(damaged, 255, 12, 4);
    var file = Path.Combine(fixture, kind + ".sparkbak"); File.WriteAllBytes(file, damaged);
    var target = Path.Combine(fixture, "reject-" + kind);
    await Reject(() => GatewayRecovery.RestoreAsync(file, target, passphrase), kind);
    Check(!Directory.Exists(target), "Damaged restore created a final destination.");
    Check(!Directory.EnumerateDirectories(fixture, ".sparkstudio-restore-*").Any(), "Failed restore left decrypted staging data.");
}
Console.WriteLine("PASS wrong password, authenticated corruption/truncation, trailing bytes, incompatible version and bounded KDF");

JsonObject manifest;
using (var input = File.OpenRead(archive)) using (var records = RecoveryRecords.Open(input, passphrase))
    manifest = JsonNode.Parse(records.Read(1, GatewayRecovery.MaxManifestBytes))!.AsObject();
var cases = new Dictionary<string, Action<JsonObject>>
{
    ["traversal"] = value => value["files"]![0]!["path"] = "../outside.txt",
    ["absolute"] = value => value["files"]![0]!["path"] = "/outside.txt",
    ["ads"] = value => value["files"]![0]!["path"] = "x:stream",
    ["device"] = value => value["files"]![0]!["path"] = "folder/CON.txt",
    ["reserved"] = value => value["files"]![0]!["path"] = GatewayRecovery.QuarantineFileName,
    ["dot"] = value => value["files"]![0]!["path"] = "directory./file",
    ["duplicate"] = value => value["files"]![1]!["path"] = value["files"]![0]!["path"]!.GetValue<string>().ToUpperInvariant(),
    ["file-directory"] = value => value["files"]![1]!["path"] = value["files"]![0]!["path"]!.GetValue<string>() + "/child",
    ["directory-case"] = value => { value["files"]![0]!["path"] = "Upper/a"; value["files"]![0]!["category"] = "additional-local-data"; value["files"]![1]!["path"] = "upper/b"; value["files"]![1]!["category"] = "additional-local-data"; },
    ["unknown-field"] = value => value["undeclared"] = true,
    ["missing-field"] = value => value.Remove("sourceWasQuarantined"),
    ["null-path"] = value => value["files"]![0]!["path"] = null,
    ["file-bound"] = value => value["files"]![0]!["length"] = GatewayRecovery.MaxFileBytes + 1,
    ["total"] = value => value["totalBytes"] = 0,
    ["digest"] = value => value["files"]![0]!["sha256"] = "bad",
    ["unknown-scope"] = value => value["scope"] = "partial-unknown",
    ["unsafe-exclusion"] = value => value["excludedPaths"] = new JsonArray("bad\npath")
};
foreach (var (name, change) in cases)
{
    var copy = (JsonObject)manifest.DeepClone(); change(copy);
    var file = Path.Combine(fixture, "manifest-" + name + ".sparkbak");
    using (var output = File.Create(file)) using (var records = RecoveryRecords.Create(output, passphrase))
    { records.Write(1, Encoding.UTF8.GetBytes(copy.ToJsonString())); records.Write(3, []); }
    await Reject(() => GatewayRecovery.InspectAsync(file, passphrase), name);
}
var duplicateJson = Path.Combine(fixture, "duplicate-json.sparkbak");
using (var output = File.Create(duplicateJson)) using (var records = RecoveryRecords.Create(output, passphrase))
    records.Write(1, Encoding.UTF8.GetBytes(manifest.ToJsonString().Insert(1, "\"schemaVersion\":1,")));
await Reject(() => GatewayRecovery.InspectAsync(duplicateJson, passphrase), "duplicate JSON fields");
var legacyManifest = (JsonObject)manifest.DeepClone(); legacyManifest.Remove("scope"); legacyManifest.Remove("excludedPaths");
legacyManifest["files"] = new JsonArray(); legacyManifest["totalBytes"] = 0;
var legacyArchive = Path.Combine(fixture, "legacy-scope.sparkbak");
using (var output = File.Create(legacyArchive)) using (var records = RecoveryRecords.Create(output, passphrase))
{ records.Write(1, Encoding.UTF8.GetBytes(legacyManifest.ToJsonString())); records.Write(3, []); }
Check((await GatewayRecovery.InspectAsync(legacyArchive, passphrase)).Scope == "full", "Original v1 archives must retain their full scope without the optional field.");
Console.WriteLine("PASS authenticated malformed manifest fields, traversal/device/ADS paths, aliases, collisions and declared size bounds");

var linked = Path.Combine(fixture, "linked-source"); Directory.CreateDirectory(linked);
var outside = Path.Combine(fixture, "outside.txt"); File.WriteAllText(outside, "outside-do-not-read");
if (OperatingSystem.IsWindows())
{
    var create = new ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
    create.ArgumentList.Add("/c"); create.ArgumentList.Add("mklink"); create.ArgumentList.Add("/J"); create.ArgumentList.Add(Path.Combine(linked, "escape")); create.ArgumentList.Add(source);
    using var junction = Process.Start(create)!; await junction.WaitForExitAsync(); Check(junction.ExitCode == 0, "Unable to create the disposable junction fixture.");
}
else Directory.CreateSymbolicLink(Path.Combine(linked, "escape"), source);
await Reject(() => GatewayRecovery.BackupAsync(linked, Path.Combine(fixture, "links.sparkbak"), passphrase), "source link");
Check(File.ReadAllText(outside) == "outside-do-not-read", "Rejected source link modified unrelated data.");
if (OperatingSystem.IsWindows())
{
    var hardRoot = Path.Combine(fixture, "hardlink-source"); Directory.CreateDirectory(hardRoot);
    Check(NativeFixture.CreateHardLink(Path.Combine(hardRoot, "linked.txt"), outside, IntPtr.Zero), "Unable to create synthetic hardlink.");
    await Reject(() => GatewayRecovery.BackupAsync(hardRoot, Path.Combine(fixture, "hardlink.sparkbak"), passphrase), "source hardlink");
}
Console.WriteLine("PASS nested source link rejection without copying or changing outside data");

var cancelSource = Path.Combine(fixture, "cancel-source"); Directory.CreateDirectory(cancelSource);
var large = new byte[16 * 1024 * 1024]; RandomNumberGenerator.Fill(large); File.WriteAllBytes(Path.Combine(cancelSource, "large.bin"), large);
var cancelArchive = Path.Combine(fixture, "cancel.sparkbak"); await GatewayRecovery.BackupAsync(cancelSource, cancelArchive, passphrase);
using (var cancellation = new CancellationTokenSource())
{
    var target = Path.Combine(fixture, "cancelled");
    var restore = GatewayRecovery.RestoreAsync(cancelArchive, target, passphrase, cancellation.Token);
    cancellation.Cancel(); await Reject(async () => await restore, "cancelled extraction");
    Check(!Directory.Exists(target) && !Directory.EnumerateDirectories(fixture, ".sparkstudio-restore-*").Any(), "Cancelled restore exposed destination or plaintext staging.");
}
Console.WriteLine("PASS interrupted extraction cleans its private staging and never promotes partial data");
var occupiedTarget = Path.Combine(fixture, "promotion-conflict");
var promotion = GatewayRecovery.RestoreAsync(cancelArchive, occupiedTarget, passphrase);
Check(!promotion.IsCompleted, "The promotion-collision fixture completed before the conflict could be established.");
Directory.CreateDirectory(occupiedTarget); File.WriteAllText(Path.Combine(occupiedTarget, "keep.txt"), "existing-target-canary");
await Reject(async () => await promotion, "final directory rename collision");
Check(File.ReadAllText(Path.Combine(occupiedTarget, "keep.txt")) == "existing-target-canary" && !File.Exists(Path.Combine(occupiedTarget, "large.bin")), "Failed promotion replaced or merged an existing directory.");
Check(!Directory.EnumerateDirectories(fixture, ".sparkstudio-restore-*").Any(), "Failed promotion retained decrypted staging.");
Console.WriteLine("PASS final-promotion failure preserves an independently created destination and removes staging");

var cliStart = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
foreach (var argument in new[] { "--recovery", "inspect", "--archive", archive, "--passphrase-env", "SPARKSTUDIO_TEST_RECOVERY_PASSPHRASE" }) cliStart.ArgumentList.Add(argument);
cliStart.Environment["SPARKSTUDIO_TEST_RECOVERY_PASSPHRASE"] = passphrase;
using (var cli = Process.Start(cliStart)!)
{
    var stdout = await cli.StandardOutput.ReadToEndAsync(); var stderr = await cli.StandardError.ReadToEndAsync(); await cli.WaitForExitAsync();
    Check(cli.ExitCode == 0 && !stdout.Contains(passphrase) && !stderr.Contains(passphrase), "CLI leaked passphrase or failed authenticated inspection.");
    Check(JsonNode.Parse(stdout)?["verified"]?.GetValue<bool>() == true, "CLI omitted authenticated success result.");
}
await Reject(() => Task.Run(() => GatewayRecoveryCli.ParseOptions(["--recovery", "inspect", "--passphrase", passphrase])), "passphrase argv");
Check(GatewayRecoveryCli.IsRequested(["--recovery=backup"]) && GatewayRecoveryCli.IsRequested(["--Recovery", "backup"]), "Malformed recovery spelling could fall through to normal gateway startup.");
await Reject(() => Task.Run(() => GatewayRecoveryCli.ParseOptions(["--recovery=backup"])), "unsupported recovery option form");
Console.WriteLine("PASS standalone CLI authenticated report, environment passphrase and secret-argument rejection");
Console.WriteLine("10 offline gateway recovery groups passed.");
internal static class NativeFixture
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool CreateHardLink(string link, string existing, IntPtr attributes);
}
`);
const dotnet = path.join(root, '.tools/dotnet/dotnet.exe');
await mkdir(path.join(directory, 'dotnet-roaming'), { recursive: true });
const options = { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 180000, env: { ...process.env, APPDATA: path.join(directory, 'dotnet-roaming'), DOTNET_CLI_HOME: path.join(root, '.tools/dotnet-home'), NUGET_PACKAGES: path.join(root, '.tools/nuget'), DOTNET_CLI_TELEMETRY_OPTOUT: '1' } };
for (const args of [
  ['restore', path.join(directory, 'RecoveryCheck.csproj'), '--configfile', path.join(directory, 'NuGet.Config'), '-p:NuGetAudit=false', '--verbosity', 'quiet'],
  ['run', '--project', path.join(directory, 'RecoveryCheck.csproj'), '--no-restore', '--no-launch-profile', '--configuration', 'RecoveryCheck', '--verbosity', 'quiet']
]) {
  const result = spawnSync(dotnet, args, options);
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  assert.equal(result.status, 0, `Recovery fixture failed (${result.error?.message ?? 'see output'}).`);
}
console.log(`Evidence: ${directory}`);
