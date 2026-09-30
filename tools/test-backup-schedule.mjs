// Synthetic local scheduler/settings checks; never touches an installed gateway or remote share.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = process.cwd(), fixture = path.resolve('.data/test-evidence', `backup-schedule-${randomUUID()}`);
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
var schedule=settings with { Enabled=true, TimeZoneId="UTC", DailyTime=clock.ToString("HH:mm"), Destination=new("ftp","ftp://127.0.0.1:1/test/","synthetic",TimeoutSeconds:30) };
backups.Save(new(Snapshot(backups)["revision"]!.GetValue<string>(),schedule));
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
    Assert(status["configurationError"] is not null && !status["saved"]!["enabled"]!.GetValue<bool>(),"Malformed settings did not disable scheduling safely.");
    broken.Save(new(status["revision"]!.GetValue<string>(),settings));
    Assert(Snapshot(broken)["configurationError"] is null,"Malformed settings could not be replaced after review.");
}
foreach(var (suffix,content) in new[] { ("null","null"),("oversized",new string('x',65537)),("version","{\"version\":999}") })
{
    var brokenRoot=Path.Combine(AppContext.BaseDirectory,"malformed-state-"+suffix); Directory.CreateDirectory(brokenRoot);
    File.WriteAllText(Path.Combine(brokenRoot,"backup-state.json"),content);
    using var broken=new GatewayBackups(brokenRoot,protection,new RecoveryQuarantine(brokenRoot),new SecurityStore(brokenRoot),lifetime);
    Assert(Snapshot(broken)["configurationError"] is null && Snapshot(broken)["lastRun"] is null,"Malformed operational state prevented startup/reset.");
}
Console.WriteLine("PASS null, oversized and unsupported persisted backup settings/state do not prevent gateway construction and settings can be repaired");

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
using(var lockedStatus=new FileStream(statusFile,FileMode.Open,FileAccess.Read,FileShare.Read))
    typeof(GatewayBackups).GetMethod("CompleteRun",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!.Invoke(completedBackup,[completion]);
var afterFailure=Snapshot(completedBackup);
Assert(afterFailure["lastRun"]!["status"]!.GetValue<string>()=="succeeded" && afterFailure["lastRun"]!["removedCount"]!.GetValue<int>()==2
    && afterFailure["lastRun"]!["bytes"]!.GetValue<long>()==completion.Bytes,"Persistence failure erased completed delivery metadata.");
Assert(afterFailure["lastRun"]!["message"]!.GetValue<string>().Contains("could not be saved locally") && afterFailure["configurationError"] is not null,"Non-durable success lacked an explicit persistence warning.");
Assert(File.ReadAllBytes(statusFile).SequenceEqual(beforeFailure),"Failed completion write damaged the prior durable status.");
Throws(()=>completedBackup.StartManual(false,actor));
var heldDownload=completedBackup.Download(completedSnapshot["downloadId"]!.GetValue<string>()); heldDownload.Stream.Dispose();
Console.WriteLine("PASS post-delivery state persistence failure preserves completed success/retention in memory, warns about restart, retains download and blocks scheduling pending review");

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
static void Assert(bool value,string message){if(!value)throw new Exception(message);}
static void Throws(Action action){try{action();}catch(Exception e)when(e is ArgumentException or InvalidOperationException or KeyNotFoundException){return;}throw new Exception("Expected rejection.");}
static async Task Wait(Func<Task<bool>> predicate){for(var i=0;i<200;i++){if(await predicate())return;await Task.Delay(50);}throw new Exception("Timed out.");}
sealed class Lifetime:IHostApplicationLifetime,IDisposable{readonly CancellationTokenSource source=new(); public CancellationToken ApplicationStarted=>CancellationToken.None;public CancellationToken ApplicationStopping=>source.Token;public CancellationToken ApplicationStopped=>CancellationToken.None;public void StopApplication()=>source.Cancel();public void Dispose()=>source.Dispose();}
`);
const dotnet = path.resolve('.tools/dotnet/dotnet.exe');
const check = spawnSync(dotnet, ['run','--project',path.join(fixture,'Check.csproj'),'-c','BackupScheduleModel','--verbosity','quiet',`-p:RestoreConfigFile=${path.join(fixture,'NuGet.Config')}`],{cwd:root,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024,env:{...process.env,DOTNET_ROOT:path.dirname(dotnet),DOTNET_CLI_HOME:path.resolve('.tools/dotnet-home'),NUGET_PACKAGES:path.resolve('.tools/nuget')}});
process.stdout.write(check.stdout ?? ''); process.stderr.write(check.stderr ?? ''); assert.equal(check.status,0,check.error?.message ?? 'Backup schedule checks failed.');
