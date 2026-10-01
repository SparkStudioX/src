// Synthetic local scheduler/settings checks; never touches an installed gateway or remote share.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root, dotnet, testEnv } from './test-environment.mjs';
const fixture = path.join(root, '.data/test-evidence', `backup-schedule-${randomUUID()}`);
await mkdir(fixture, { recursive: true });
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
await writeFile(path.join(fixture, 'Check.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><ProjectReference Include="${xml(path.join(root, 'src/SparkStudio.Gateway/SparkStudio.Gateway.csproj'))}"/></ItemGroup></Project>`);
await writeFile(path.join(fixture, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
await writeFile(path.join(fixture, 'Program.cs'), String.raw`
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.DependencyInjection;
using SparkStudio.Gateway;

var root = Path.Combine(AppContext.BaseDirectory,"fixture"); Directory.CreateDirectory(root);
var settings=GatewayBackups.Defaults() with { TimeZoneId="America/Chicago" };
Assert(settings.DailyTime=="02:00" && settings.RetentionDays==7 && !settings.Enabled,"Defaults changed.");
Assert(GatewayBackups.DueDate(settings,null,DateTimeOffset.Parse("2026-03-08T08:00:00Z"))=="2026-03-08","Skipped spring time should run after gap.");
Assert(GatewayBackups.DueDate(settings,"2026-03-08",DateTimeOffset.Parse("2026-03-08T09:00:00Z"))==null,"Same day ran twice.");
var fall=settings with { DailyTime="01:30" };
Assert(GatewayBackups.DueDate(fall,null,DateTimeOffset.Parse("2026-11-01T06:30:00Z"))=="2026-11-01","First fall occurrence missing.");
Assert(GatewayBackups.DueDate(fall,"2026-11-01",DateTimeOffset.Parse("2026-11-01T07:30:00Z"))==null,"Repeated fall occurrence ran twice.");
Assert(GatewayBackups.NextDue(settings,null,DateTimeOffset.Parse("2026-03-08T07:00:00Z"))==DateTimeOffset.Parse("2026-03-08T08:00:00Z"),"Spring next due wrong.");
Assert(GatewayBackups.NextDue(fall,null,DateTimeOffset.Parse("2026-11-01T05:00:00Z"))==DateTimeOffset.Parse("2026-11-01T06:30:00Z"),"Ambiguous time should show first occurrence.");
Assert(GatewayBackups.NextDue(settings,"2026-04-01",DateTimeOffset.Parse("2026-03-08T07:00:00Z"))>DateTimeOffset.Parse("2026-04-01T00:00:00Z"),"Clock rollback next due was wrong.");
var weekly=new BackupNamedSchedule("weekly","Monday backup",true,"target","02:00","UTC",30,[1]);
Assert(GatewayBackups.DueDate(weekly,null,DateTimeOffset.Parse("2026-09-28T03:00:00Z"))=="2026-09-28","Selected weekly day was not due.");
Assert(GatewayBackups.DueDate(weekly,null,DateTimeOffset.Parse("2026-09-29T03:00:00Z"))==null,"Unselected weekly day was due.");
Assert(GatewayBackups.NextDue(weekly,"2026-09-28",DateTimeOffset.Parse("2026-09-28T03:00:00Z"))==DateTimeOffset.Parse("2026-10-05T02:00:00Z"),"Weekly next due skipped the wrong days.");
Throws(()=>GatewayBackups.ValidateSettings(settings with { DailyTime="25:00" }));
Throws(()=>GatewayBackups.ValidateSettings(settings with { RetentionDays=0 }));
Throws(()=>GatewayBackups.ValidateSettings(settings with { Enabled=true }));
Console.WriteLine("PASS daily schedule, seven-day defaults, missed runs, DST and backward clock behavior");

var security=new SecurityStore(root);
var actor=security.Setup(File.ReadAllText(Path.Combine(root,"security/setup-code.txt")).Trim(),new("backup-admin",Convert.ToBase64String(RandomNumberGenerator.GetBytes(30))));
var protection=new EphemeralDataProtectionProvider();
var quarantine=new RecoveryQuarantine(root);
using var lifetime=new Lifetime();
using var backups=new GatewayBackups(root,protection,quarantine,security,lifetime);
var initial=Snapshot(backups); var revision=initial["revision"]!.GetValue<string>();
var passphrase=Convert.ToBase64String(RandomNumberGenerator.GetBytes(30));
var remoteSecret=Convert.ToBase64String(RandomNumberGenerator.GetBytes(30));
backups.Save(new(revision,settings,remoteSecret,passphrase));
Assert(!File.ReadAllText(Path.Combine(root,"backup-settings.json")).Contains(passphrase),"Plain archive passphrase persisted.");
Assert(!File.ReadAllText(Path.Combine(root,"backup-settings.json")).Contains(remoteSecret),"Plain destination secret persisted.");
Assert(!Snapshot(backups).ToJsonString().Contains(passphrase) && Snapshot(backups)["hasArchivePassphrase"]!.GetValue<bool>(),"Secret leaked in status.");
Throws(()=>backups.Save(new(revision,settings)));
var saved=Snapshot(backups); backups.Save(new(saved["revision"]!.GetValue<string>(),settings));
Assert(Snapshot(backups)["hasDestinationPassword"]!.GetValue<bool>(),"Omitted secret was cleared.");
Console.WriteLine("PASS protected settings, redaction, retained secrets and stale revision rejection");

File.WriteAllText(Path.Combine(root,"project.json"),"{\"name\":\"Synthetic backup fixture\"}");
Directory.CreateDirectory(Path.Combine(root,"databases")); File.WriteAllText(Path.Combine(root,"databases/test.db"),"synthetic excluded data");
backups.StartManual(false,actor);
Throws(()=>backups.StartManual(false,actor));
Throws(()=>backups.Save(new(Snapshot(backups)["revision"]!.GetValue<string>(),settings)));
await Wait(async()=> { await Task.Yield(); return !Snapshot(backups)["running"]!.GetValue<bool>(); });
var result=Snapshot(backups);
Assert(result["lastRun"]!["status"]!.GetValue<string>()=="succeeded",result.ToJsonString());
var downloadId=result["downloadId"]!.GetValue<string>();
var downloaded=Path.Combine(AppContext.BaseDirectory,"download.sparkbak");
var file=backups.Download(downloadId); using(var output=File.Create(downloaded)) await using(var stream=file.Stream) await stream.CopyToAsync(output);
var inspected=await GatewayRecovery.InspectAsync(downloaded,passphrase);
Assert(inspected.Scope=="configuration" && inspected.ExcludedPaths!.Contains("databases/"),"Wrong backup scope.");
var restored=Path.Combine(AppContext.BaseDirectory,"restored"); await GatewayRecovery.RestoreAsync(downloaded,restored,passphrase);
Assert(new RecoveryQuarantine(restored).Active && !Directory.Exists(Path.Combine(restored,"databases")),"Restore scope/isolation failed.");
Assert(File.ReadAllText(Path.Combine(root,"project.json"))==File.ReadAllText(Path.Combine(restored,"project.json")),"Configuration changed.");
Throws(()=>backups.Download(Guid.NewGuid().ToString("N")));
Console.WriteLine("PASS manual encrypted download, one-run exclusion, inspect and isolated configuration restore");

var modified=Snapshot(backups); backups.Save(new(modified["revision"]!.GetValue<string>(),settings,ClearDestinationPassword:true));
Assert(!Snapshot(backups)["hasDestinationPassword"]!.GetValue<bool>(),"Clear destination password failed.");
var clock=DateTimeOffset.UtcNow;
var schedule=settings with { Enabled=true, TimeZoneId="UTC", DailyTime=clock.ToString("HH:mm"), Destination=new("ftp","ftp://127.0.0.1:1/test/","synthetic",TimeoutSeconds:30,AllowInsecureFtp:true) };
backups.Save(new(Snapshot(backups)["revision"]!.GetValue<string>(),schedule,DestinationPassword:remoteSecret));
await backups.StartAsync(CancellationToken.None);
await Wait(async()=> { await Task.Yield(); return Snapshot(backups)["lastRun"]?["status"]?.GetValue<string>()=="failed" && !Snapshot(backups)["running"]!.GetValue<bool>(); });
var failedId=Snapshot(backups)["lastRun"]!["id"]!.GetValue<string>();
Assert(File.ReadAllText(Path.Combine(root,"backup-state.json")).Contains(clock.ToString("yyyy-MM-dd")),"Scheduled attempt was not recorded durably.");
await Task.Delay(15500);
Assert(Snapshot(backups)["lastRun"]!["id"]!.GetValue<string>()==failedId,"Failed daily run retried repeatedly.");
backups.Save(new(Snapshot(backups)["revision"]!.GetValue<string>(),settings));
await backups.StopAsync(CancellationToken.None);
Console.WriteLine("PASS real scheduler executes a due job, preserves failure state and avoids same-day retry loops");
using var blocked=new GatewayBackups(restored,protection,new RecoveryQuarantine(restored),new SecurityStore(restored),lifetime);
Throws(()=>blocked.StartManual(false,actor));
File.AppendAllText(Path.Combine(root,"backup-settings.json")," ");
Throws(()=>backups.Save(new(Snapshot(backups)["revision"]!.GetValue<string>(),settings)));
Console.WriteLine("PASS explicit secret clearing, external edit conflicts and recovery suppression");

var validSettings = JsonSerializer.SerializeToNode(new BackupSettingsDocument(1,Guid.NewGuid(),"fixture-revision",settings,null,null))!.AsObject();
var invalidVersion = validSettings.DeepClone().AsObject(); invalidVersion["Version"] = 999;
var invalidOwner = validSettings.DeepClone().AsObject(); invalidOwner["OwnerId"] = Guid.Empty.ToString();
var malformedSettings = new[] { "null", new string('x',65537), invalidVersion.ToJsonString(), invalidOwner.ToJsonString() };
for(var index=0;index<malformedSettings.Length;index++)
{
    var brokenRoot=Path.Combine(AppContext.BaseDirectory,"malformed-settings-"+index); Directory.CreateDirectory(brokenRoot);
    File.WriteAllText(Path.Combine(brokenRoot,"backup-settings.json"),malformedSettings[index]);
    using var broken=new GatewayBackups(brokenRoot,protection,new RecoveryQuarantine(brokenRoot),new SecurityStore(brokenRoot),lifetime);
    var status=Snapshot(broken);
    Assert(status["configurationError"] is not null && !status["saved"]!["schedules"]![0]!["enabled"]!.GetValue<bool>(),"Malformed settings did not disable scheduling safely.");
    Assert(File.ReadAllText(Path.Combine(brokenRoot,"backup-settings.json"))==malformedSettings[index],"Invalid/future settings were overwritten during startup.");
    broken.Save(new(status["revision"]!.GetValue<string>(),settings));
    Assert(Snapshot(broken)["configurationError"] is null,"Malformed settings could not be replaced after review.");
}
foreach(var (suffix,content) in new[] { ("null","null"),("oversized",new string('x',65537)),("version","{\"version\":999}") })
{
    var brokenRoot=Path.Combine(AppContext.BaseDirectory,"malformed-state-"+suffix); Directory.CreateDirectory(brokenRoot);
    File.WriteAllText(Path.Combine(brokenRoot,"backup-state.json"),content);
    using var broken=new GatewayBackups(brokenRoot,protection,new RecoveryQuarantine(brokenRoot),new SecurityStore(brokenRoot),lifetime);
    Assert(Snapshot(broken)["configurationError"] is not null && Snapshot(broken)["lastRun"] is null && Snapshot(broken)["nextDueAt"] is null,"Malformed operational state did not disable scheduling.");
    Throws(()=>broken.StartManual(false,actor));
    Assert(File.ReadAllText(Path.Combine(brokenRoot,"backup-state.json"))==content,"Unreadable state was overwritten without review.");
    broken.Save(new(Snapshot(broken)["revision"]!.GetValue<string>(),settings));
    Assert(Snapshot(broken)["configurationError"] is null,"Reviewed replacement did not repair invalid state.");
}
Console.WriteLine("PASS invalid or future settings/state preserve disk bytes, disable scheduling and can be repaired after review");

var faultRoot=Path.Combine(AppContext.BaseDirectory,"completed-status-write-fault"); Directory.CreateDirectory(faultRoot);
using var completedBackup=new GatewayBackups(faultRoot,protection,new RecoveryQuarantine(faultRoot),new SecurityStore(faultRoot),lifetime);
completedBackup.Save(new(Snapshot(completedBackup)["revision"]!.GetValue<string>(),settings,ArchivePassphrase:passphrase));
completedBackup.StartManual(false,actor);
await Wait(async()=>{await Task.Yield();return !Snapshot(completedBackup)["running"]!.GetValue<bool>();});
var completedSnapshot=Snapshot(completedBackup);
Assert(completedSnapshot["lastRun"]!["status"]!.GetValue<string>()=="succeeded","Fault fixture did not create a verified local archive.");
var completion=completedSnapshot["lastRun"]!.Deserialize<BackupRunStatus>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!
    with { Message="Backup copied and verified.", RemovedCount=2 };
var statusFile=Path.Combine(faultRoot,"backup-state.json"); var beforeFailure=File.ReadAllBytes(statusFile);
// The private completion boundary accepts a known completed delivery result. A
// real file handle denies atomic replacement, reproducing the post-delivery disk
// failure without introducing a test-only transport API into production code.
void CompleteFaultedRun() => typeof(GatewayBackups).GetMethod("CompleteRun",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!.Invoke(completedBackup,[completion]);
if (OperatingSystem.IsWindows())
{
    using var lockedStatus = new FileStream(statusFile,FileMode.Open,FileAccess.Read,FileShare.Read);
    CompleteFaultedRun();
}
else
{
    // POSIX permits rename over open files. A directory collision forces the
    // same final replacement failure while preserving this fixture's old bytes.
    var held = statusFile + ".fixture-held"; File.Move(statusFile, held); Directory.CreateDirectory(statusFile);
    try { CompleteFaultedRun(); }
    finally { Directory.Delete(statusFile); File.Move(held, statusFile); }
}
var afterFailure=Snapshot(completedBackup);
Assert(afterFailure["lastRun"]!["status"]!.GetValue<string>()=="succeeded" && afterFailure["lastRun"]!["removedCount"]!.GetValue<int>()==2
    && afterFailure["lastRun"]!["bytes"]!.GetValue<long>()==completion.Bytes,"Persistence failure erased completed delivery metadata.");
Assert(afterFailure["lastRun"]!["message"]!.GetValue<string>().Contains("could not be saved locally") && afterFailure["configurationError"] is not null,"Non-durable success lacked an explicit persistence warning.");
Assert(File.ReadAllBytes(statusFile).SequenceEqual(beforeFailure),"Failed completion write damaged the prior durable status.");
Throws(()=>completedBackup.StartManual(false,actor));
var heldDownload=completedBackup.Download(completedSnapshot["downloadId"]!.GetValue<string>()); heldDownload.Stream.Dispose();
Console.WriteLine("PASS post-delivery state persistence failure preserves completed success/retention in memory, warns about restart, retains download and blocks scheduling pending review");

var scopeRoot=Path.Combine(root,"multiple-schedules"); Directory.CreateDirectory(scopeRoot);
using var scoped=new GatewayBackups(scopeRoot,protection,new RecoveryQuarantine(scopeRoot),new SecurityStore(scopeRoot),lifetime);
var targetSettings=new BackupDestinationSettings("ftp","ftp://127.0.0.1:1/synthetic/","synthetic",TimeoutSeconds:30,AllowInsecureFtp:true);
var targets=new[] { new BackupNamedDestination("a","Primary",targetSettings),new BackupNamedDestination("b","Secondary",targetSettings) };
var scopeSettings=new BackupConfigurationSettings(targets,[new("one","Daily",false,"a","02:00","UTC",7),new("two","Weekly",false,"a","03:00","UTC",30,[1])]);
scoped.SaveConfiguration(new(Snapshot(scoped)["revision"]!.GetValue<string>(),scopeSettings,[new("a",Password:remoteSecret),new("b",Password:remoteSecret)],passphrase));
var scopeDocument=Stored(scopeRoot);
Assert(scopeDocument.Schedules[0].RetentionOwnerId!=scopeDocument.Schedules[1].RetentionOwnerId,"Shared-folder schedules share destructive retention ownership.");
Assert(scopeDocument.Destinations.Select(item=>item.ManualRetentionOwnerId).Concat(scopeDocument.Schedules.Select(item=>item.RetentionOwnerId)).Distinct().Count()==4,"Manual and scheduled delivery scopes overlap.");
var originalScope=scopeDocument.Schedules[0].RetentionOwnerId;
var renamed=scopeSettings with { Schedules=[scopeSettings.Schedules[0] with { Name="Renamed",DailyTime="04:00" },scopeSettings.Schedules[1]] };
scoped.SaveConfiguration(new(Snapshot(scoped)["revision"]!.GetValue<string>(),renamed));
Assert(Stored(scopeRoot).Schedules[0].RetentionOwnerId==originalScope,"Renaming or timing changes adopted a new retention scope.");
var moved=renamed with { Schedules=[renamed.Schedules[0] with { DestinationId="b" },renamed.Schedules[1]] };
scoped.SaveConfiguration(new(Snapshot(scoped)["revision"]!.GetValue<string>(),moved));
Assert(Stored(scopeRoot).Schedules[0].RetentionOwnerId!=originalScope,"Changing the destination kept ownership of the previous target's archives.");
var removed=moved with { Schedules=[moved.Schedules[1]] };
var beforeDelete=Stored(scopeRoot).Schedules[0].RetentionOwnerId;
scoped.SaveConfiguration(new(Snapshot(scoped)["revision"]!.GetValue<string>(),removed));
scoped.SaveConfiguration(new(Snapshot(scoped)["revision"]!.GetValue<string>(),moved));
Assert(Stored(scopeRoot).Schedules[0].RetentionOwnerId!=beforeDelete,"Deleting/readding a schedule ID adopted deleted archive ownership.");
Throws(()=>scoped.SaveConfiguration(new(Snapshot(scoped)["revision"]!.GetValue<string>(),moved,[new("a",Password:"")])));
Throws(()=>scoped.SaveConfiguration(new(Snapshot(scoped)["revision"]!.GetValue<string>(),moved,[new("a",Password:remoteSecret,ClearPassword:true)])));
Throws(()=>scoped.SaveConfiguration(new(Snapshot(scoped)["revision"]!.GetValue<string>(),moved,[new("missing",Password:remoteSecret)])));
Throws(()=>GatewayBackups.ValidateSettings(moved with { Schedules=[moved.Schedules[0] with { DaysOfWeek=[1,1] }] }));
Throws(()=>GatewayBackups.ValidateSettings(moved with { Destinations=Enumerable.Range(0,33).Select(index=>new BackupNamedDestination("d"+index,"Target",targetSettings)).ToArray() }));
Throws(()=>scoped.StartManual(new BackupRunRequest(true,DestinationId:"a",ScheduleId:"one"),actor));
Console.WriteLine("PASS named destination/schedule bounds, weekly days, stable isolated retention scopes and delete/readd ownership fencing");

var s3=new BackupNamedDestination("cloud","S3",new("s3","",Bucket:"synthetic-backup-bucket",Region:"us-east-1",AccessKeyId:"SYNTHETICKEY",Prefix:"gateway/"));
var s3Settings=new BackupConfigurationSettings([s3],[new("cloud-weekly","Cloud weekly",false,"cloud","02:00","UTC",30,[1])]);
var accessSecret=Convert.ToBase64String(RandomNumberGenerator.GetBytes(30)); var tokenSecret=Convert.ToBase64String(RandomNumberGenerator.GetBytes(30));
scoped.SaveConfiguration(new(Snapshot(scoped)["revision"]!.GetValue<string>(),s3Settings,[new("cloud",SecretAccessKey:accessSecret,SessionToken:tokenSecret)]));
Assert(!File.ReadAllText(Path.Combine(scopeRoot,"backup-settings.json")).Contains(accessSecret) && !Snapshot(scoped).ToJsonString().Contains(tokenSecret),"S3 credentials leaked.");
scoped.SaveConfiguration(new(Snapshot(scoped)["revision"]!.GetValue<string>(),s3Settings));
Assert(Snapshot(scoped)["destinationSecrets"]![0]!["hasSecretAccessKey"]!.GetValue<bool>() && Snapshot(scoped)["destinationSecrets"]![0]!["hasSessionToken"]!.GetValue<bool>(),"Omitted S3 secrets were cleared.");
scoped.SaveConfiguration(new(Snapshot(scoped)["revision"]!.GetValue<string>(),s3Settings,[new("cloud",ClearSessionToken:true)]));
Assert(!Snapshot(scoped)["destinationSecrets"]![0]!["hasSessionToken"]!.GetValue<bool>(),"S3 session token could not be cleared.");
Throws(()=>scoped.SaveConfiguration(new(Snapshot(scoped)["revision"]!.GetValue<string>(),s3Settings with { Schedules=[s3Settings.Schedules[0] with { Enabled=true }] },[new("cloud",ClearSecretAccessKey:true)])));
Console.WriteLine("PASS independent protected S3 credentials, omitted-secret preservation and explicit clear/enabled credential validation");
var readTransport=typeof(GatewayBackups).GetMethod("ReadTransport",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!;
var cloudDocument=Stored(scopeRoot).Destinations[0] with { ProtectedPassword="invalid-unused-password" };
var cloudTransport=(BackupDestination)readTransport.Invoke(scoped,[cloudDocument])!;
Assert(cloudTransport.Password is null && cloudTransport.SecretAccessKey==accessSecret,"Switching to S3 loaded an unrelated old SMB/FTP password.");
var ftpDocument=cloudDocument with { Destination=cloudDocument.Destination with { Settings=targetSettings },ProtectedPassword=protection.CreateProtector("SparkStudio.BackupSettings.v1").Protect(remoteSecret),ProtectedSecretAccessKey="invalid-unused-s3-secret",ProtectedSessionToken="invalid-unused-s3-token" };
var ftpTransport=(BackupDestination)readTransport.Invoke(scoped,[ftpDocument])!;
Assert(ftpTransport.Password==remoteSecret && ftpTransport.SecretAccessKey is null && ftpTransport.SessionToken is null,"Switching away from S3 loaded unrelated old S3 credentials.");
Console.WriteLine("PASS destination type changes ignore unrelated protected credentials, including unreadable old secret blobs");

// Restart from an authored v1 fixture: migration preserves secrets, owner scope,
// attempted date, completed metadata and an already verified local download.
var migrateRoot=Path.Combine(root,"version-one-migration"); Directory.CreateDirectory(migrateRoot);
var legacyOwner=Guid.NewGuid(); var legacyRun=Guid.NewGuid().ToString("N"); var legacyDate=DateTimeOffset.UtcNow.ToString("yyyy-MM-dd");
var legacyName=BackupDestinations.CreateArchiveName(legacyOwner,DateTimeOffset.UtcNow,Guid.ParseExact(legacyRun,"N"));
Directory.CreateDirectory(Path.Combine(migrateRoot,"backup-work")); File.Copy(downloaded,Path.Combine(migrateRoot,"backup-work",legacyName));
var originalProtector=protection.CreateProtector("SparkStudio.BackupSettings.v1");
var legacySettings=new BackupSettingsDocument(1,legacyOwner,"legacy-revision",schedule,originalProtector.Protect(remoteSecret),originalProtector.Protect(passphrase));
var legacyStatus=new BackupRunStatus(legacyRun,"succeeded",DateTimeOffset.UtcNow,DateTimeOffset.UtcNow,"Legacy completed",legacyName,new FileInfo(downloaded).Length,2);
File.WriteAllText(Path.Combine(migrateRoot,"backup-settings.json"),JsonSerializer.Serialize(legacySettings,new JsonSerializerOptions(JsonSerializerDefaults.Web)));
File.WriteAllText(Path.Combine(migrateRoot,"backup-state.json"),JsonSerializer.Serialize(new BackupRunDocument(1,legacyDate,legacyStatus,legacyRun,legacyName),new JsonSerializerOptions(JsonSerializerDefaults.Web)));
using var migrated=new GatewayBackups(migrateRoot,protection,new RecoveryQuarantine(migrateRoot),new SecurityStore(migrateRoot),lifetime);
var migratedDocument=Stored(migrateRoot); var migratedSnapshot=Snapshot(migrated);
Assert(migratedDocument.Version==2 && migratedDocument.OwnerId==legacyOwner && migratedDocument.Revision=="legacy-revision" && migratedDocument.Schedules[0].RetentionOwnerId==legacyOwner,"Migration changed the gateway/legacy retention identity.");
Assert(migratedDocument.ProtectedArchivePassphrase==legacySettings.ProtectedArchivePassphrase && migratedDocument.Destinations[0].ProtectedPassword==legacySettings.ProtectedDestinationPassword,"Migration reprotected or lost v1 credentials.");
Assert(migratedSnapshot["scheduleStates"]![0]!["lastScheduledDate"]!.GetValue<string>()==legacyDate && migratedSnapshot["lastRun"]!["removedCount"]!.GetValue<int>()==2 && migratedSnapshot["downloadId"]!.GetValue<string>()==legacyRun,"Migration lost dates, run metadata or download ownership.");
Assert(GatewayBackups.DueDate(migratedDocument.Schedules[0].Schedule,legacyDate,DateTimeOffset.UtcNow)==null,"Migration can repeat today's scheduled attempt.");
var migratedDownload=migrated.Download(legacyRun); migratedDownload.Stream.Dispose();
migrated.StartManual(new BackupRunRequest(true,ScheduleId:"default-schedule"),actor);
await Wait(async()=>{await Task.Yield();return !Snapshot(migrated)["running"]!.GetValue<bool>();});
Assert(Snapshot(migrated)["scheduleStates"]![0]!["lastScheduledDate"]!.GetValue<string>()==legacyDate,"Manual schedule run changed the durable automatic attempted date.");
Console.WriteLine("PASS v1 migration preserves protection, gateway/retention ownership, attempted dates, run metadata and local downloads");
var pristineRoot=Path.Combine(root,"pristine-version-one"); Directory.CreateDirectory(pristineRoot);
File.WriteAllText(Path.Combine(pristineRoot,"backup-settings.json"),JsonSerializer.Serialize(new BackupSettingsDocument(1,Guid.NewGuid(),"pristine-v1",settings,null,null),new JsonSerializerOptions(JsonSerializerDefaults.Web)));
using var pristine=new GatewayBackups(pristineRoot,protection,new RecoveryQuarantine(pristineRoot),new SecurityStore(pristineRoot),lifetime);
Assert(Snapshot(pristine)["configurationError"] is null && !Snapshot(pristine)["saved"]!["schedules"]![0]!["enabled"]!.GetValue<bool>(),"Pristine disabled v1 settings could not migrate.");
pristine.SaveConfiguration(new(Snapshot(pristine)["revision"]!.GetValue<string>(),GatewayBackups.ConfigurationDefaults(),ArchivePassphrase:passphrase));
Assert(Snapshot(pristine)["hasArchivePassphrase"]!.GetValue<bool>(),"Pristine incomplete placeholder blocked a global passphrase-only save.");
Console.WriteLine("PASS pristine disabled v1 migration keeps its incomplete placeholder usable for passphrase-only saves");

// Every due job receives a turn after the previous one fails. All delivery goes
// to an owned loopback port with no listener; no real remote storage is used.
var serialRoot=Path.Combine(root,"serial-scheduler"); Directory.CreateDirectory(serialRoot);
using var serial=new GatewayBackups(serialRoot,protection,new RecoveryQuarantine(serialRoot),new SecurityStore(serialRoot),lifetime);
var serialClock=DateTimeOffset.UtcNow; var dueTime=serialClock.ToString("HH:mm");
var dueSettings=new BackupConfigurationSettings(targets,[new("one","Daily A",true,"a",dueTime,"UTC",7),new("two","Daily B",true,"b",dueTime,"UTC",30)]);
serial.SaveConfiguration(new(Snapshot(serial)["revision"]!.GetValue<string>(),dueSettings,[new("a",Password:remoteSecret),new("b",Password:remoteSecret)],passphrase));
await serial.StartAsync(CancellationToken.None);
await Wait(async()=>{await Task.Yield();return Snapshot(serial)["scheduleStates"]!.AsArray().All(item=>item!["lastRun"]?["status"]?.GetValue<string>()=="failed") && !Snapshot(serial)["running"]!.GetValue<bool>();});
var serialRuns=Snapshot(serial)["scheduleStates"]!.AsArray().Select(item=>item!["lastRun"]!.Deserialize<BackupRunStatus>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!).OrderBy(item=>item.StartedAt).ToArray();
Assert(serialRuns[0].CompletedAt<=serialRuns[1].StartedAt && serialRuns.Select(item=>item.ScheduleId).Distinct().Count()==2,"Scheduled runs overlapped or one due target was starved.");
Assert(Snapshot(serial)["configurationError"] is null,"One target failure disabled independent schedules.");
await serial.StopAsync(CancellationToken.None);
var badStateRoot=Path.Combine(root,"unreadable-state-blocks-due"); Directory.CreateDirectory(badStateRoot);
File.Copy(Path.Combine(serialRoot,"backup-settings.json"),Path.Combine(badStateRoot,"backup-settings.json"));
const string futureState="{\"version\":999}"; File.WriteAllText(Path.Combine(badStateRoot,"backup-state.json"),futureState);
using var stateBlocked=new GatewayBackups(badStateRoot,protection,new RecoveryQuarantine(badStateRoot),new SecurityStore(badStateRoot),lifetime);
await stateBlocked.StartAsync(CancellationToken.None); await Task.Delay(200);
Assert(Snapshot(stateBlocked)["configurationError"] is not null && Snapshot(stateBlocked)["lastRun"] is null && File.ReadAllText(Path.Combine(badStateRoot,"backup-state.json"))==futureState,"Unverifiable dates were silently reset and due jobs rerun.");
stateBlocked.SaveConfiguration(new(Snapshot(stateBlocked)["revision"]!.GetValue<string>(),dueSettings with { Schedules=dueSettings.Schedules.Select(item=>item with { Enabled=false }).ToArray() }));
Assert(Snapshot(stateBlocked)["configurationError"] is null,"Explicit reviewed save could not repair operational state.");
await stateBlocked.StopAsync(CancellationToken.None);
Console.WriteLine("PASS fair serial independent schedules, per-job durable once/date failures and corrupt state prevents automatic reclaims until repair");

var disposalRoot = Path.Combine(root, "host-disposal"); Directory.CreateDirectory(disposalRoot);
var services = new ServiceCollection();
services.AddSingleton(_ => new GatewayBackups(disposalRoot, protection, new RecoveryQuarantine(disposalRoot), new SecurityStore(disposalRoot), lifetime));
services.AddHostedService(provider => provider.GetRequiredService<GatewayBackups>());
var provider = services.BuildServiceProvider();
var owned = provider.GetRequiredService<GatewayBackups>();
var hosted = provider.GetServices<IHostedService>().Single();
Assert(ReferenceEquals(owned, hosted), "Test must reproduce the host's dual registration.");
await hosted.StartAsync(CancellationToken.None);
await hosted.StopAsync(CancellationToken.None);
await provider.DisposeAsync();
Parallel.For(0, 16, _ => owned.Dispose());
Throws(() => owned.StartManual(false, actor));
Console.WriteLine("PASS actual singleton/hosted-service disposal and repeated concurrent cleanup do not crash; disposed backup service rejects new work");

static JsonObject Snapshot(GatewayBackups value)=>JsonSerializer.SerializeToNode(value.Snapshot(),new JsonSerializerOptions(JsonSerializerDefaults.Web))!.AsObject();
static BackupSettingsDocumentV2 Stored(string directory)=>JsonSerializer.Deserialize<BackupSettingsDocumentV2>(File.ReadAllText(Path.Combine(directory,"backup-settings.json")),new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
static void Assert(bool value,string message){if(!value)throw new Exception(message);}
static void Throws(Action action){try{action();}catch(Exception e)when(e is ArgumentException or InvalidOperationException or KeyNotFoundException){return;}throw new Exception("Expected rejection.");}
static async Task Wait(Func<Task<bool>> predicate){for(var i=0;i<200;i++){if(await predicate())return;await Task.Delay(50);}throw new Exception("Timed out.");}
sealed class Lifetime:IHostApplicationLifetime,IDisposable{readonly CancellationTokenSource source=new(); public CancellationToken ApplicationStarted=>CancellationToken.None;public CancellationToken ApplicationStopping=>source.Token;public CancellationToken ApplicationStopped=>CancellationToken.None;public void StopApplication()=>source.Cancel();public void Dispose()=>source.Dispose();}
`);
const check = spawnSync(dotnet, ['run','--project',path.join(fixture,'Check.csproj'),'-c','BackupScheduleModel','--verbosity','quiet',`-p:RestoreConfigFile=${path.join(fixture,'NuGet.Config')}`],{cwd:root,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024,env:testEnv});
process.stdout.write(check.stdout ?? ''); process.stderr.write(check.stderr ?? ''); assert.equal(check.status,0,check.error?.message ?? 'Backup schedule checks failed.');
