#!/usr/bin/env node
// Authored container fixtures; disposable local gateway state, no device connections.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const root=process.cwd(),directory=path.resolve('.data/test-evidence',`view-containers-${randomUUID()}`);
assert.ok(directory.startsWith(path.resolve('.data')+path.sep));await mkdir(directory,{recursive:true});
const escape=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const project=path.join(directory,'ViewContainers.csproj');
await writeFile(project,`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><ProjectReference Include="${escape(path.join(root,'src/SparkStudio.Gateway/SparkStudio.Gateway.csproj'))}"/><None Update="workshop.json" CopyToOutputDirectory="Always"/></ItemGroup></Project>`);
await writeFile(path.join(directory,'workshop.json'),await readFile(path.join(root,'examples/view-containers.json')));
await writeFile(path.join(directory,'NuGet.Config'),'<configuration><packageSources><clear/></packageSources></configuration>');
await writeFile(path.join(directory,'Program.cs'),String.raw`
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

var directory = Path.Combine(AppContext.BaseDirectory, "fixture");
var catalog = new ProjectCatalog(directory, new EphemeralDataProtectionProvider());
var fixture = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"workshop.json")))!.AsObject();
fixture.Remove("tags"); fixture["id"] = "container-check"; fixture["revision"] = 0; fixture["parameters"] = new JsonObject();
var workspace = catalog.Create("Container check", fixture);
JsonObject Draft() => workspace.Store.GetProject();
JsonObject Layout(JsonObject value, int screen = 0) => value["screens"]![screen]!["components"]!.AsArray().OfType<JsonObject>().Single(item => item["type"]!.GetValue<string>() == "viewContainer")["props"]!["viewLayout"]!.AsObject();
void Invalid(Action<JsonObject> change) { var draft=Draft(); change(draft); Reject(()=>workspace.Store.SaveProject(draft)); }
foreach(var bad in new[]{"", "1pane", "same space", new string('a',65)}) Invalid(draft=>Layout(draft)["panes"]![0]!["id"]=bad);
Invalid(draft=>Layout(draft)["panes"]![1]!["id"]="west");
Invalid(draft=>Layout(draft)["initialPaneId"]="missing");
Invalid(draft=>Layout(draft,1)["ratio"]=9);
Invalid(draft=>Layout(draft,1)["ratio"]=91);
Invalid(draft=>Layout(draft,1)["orientation"]="diagonal");
Invalid(draft=>Layout(draft,2)["panes"]![1]!["edge"]="center");
Invalid(draft=>Layout(draft,2)["panes"]![0]!["initiallyOpen"]=false);
Invalid(draft=>Layout(draft,2)["panes"]![1]!["size"]=79);
Invalid(draft=>Layout(draft)["panes"]![0]!["parameters"]!["station"]=false);
Invalid(draft=>Layout(draft)["panes"]![0]!["parameters"]!["station"]=new string('a',4097));
Invalid(draft=>Layout(draft)["panes"]![0]!["parameterBindings"]=new JsonObject());
Invalid(draft=>draft["screens"]![0]!["components"]![0]!["props"]!["viewLayout"]=Layout(draft).DeepClone());
Console.WriteLine("PASS layout bounds, pane identities, strict fields, parameter limits and misplaced definitions reject atomically");
var stamp=workspace.Publication.Publish(workspace.Store,Draft()["revision"]!.GetValue<int>())["publishedAt"]!.GetValue<string>();
var west=workspace.Publication.GetAction("tabs","run",stamp,instanceId:"views",rowId:"west");
Assert(west["templateScopes"]![0]!["templateParameters"]!["station"]!.GetValue<string>()=="West","West saved pane context");
var eastPath=new[]{new InstancePathStep("views","east"),new InstancePathStep("nested","content")};
var east=workspace.Publication.GetAction("tabs","run",stamp,instancePath:eastPath);
Assert(east["templateScopes"]!.AsArray().Count==2,"Nested container boundaries");
Reject(()=>workspace.Publication.GetAction("tabs","run",stamp,instanceId:"views"));
Reject(()=>workspace.Publication.GetAction("tabs","run",stamp,instanceId:"views",rowId:"forged"));
Reject(()=>workspace.Publication.GetAction("tabs","run",stamp,instancePath:[new("views","west"),new("nested","content")]));
Reject(()=>workspace.Publication.GetAction("tabs","run",stamp));
Console.WriteLine("PASS gateway reconstructs saved pane paths and rejects missing, forged and cross-template identities");
void CannotPublish(Action<JsonObject> change) { var draft=Draft(); change(draft); var other=catalog.Create("Invalid composition",draft); Reject(()=>other.Publication.Publish(other.Store,other.Store.GetProject()["revision"]!.GetValue<int>())); }
CannotPublish(draft=>Layout(draft,2)["panes"]![2]!["templateId"]="missing-hidden");
CannotPublish(draft=>draft["templates"]![1]!["components"]![0]!["props"]!["viewLayout"]!["panes"]![0]!["templateId"]="nested-container-form");
CannotPublish(draft=>Layout(draft)["panes"]![0]!["parameters"]!["station"]="{undeclared}");
Invalid(draft=>Layout(draft)["panes"]![0]!["parameters"]!["extra"]="not declared");
CannotPublish(draft=>{ for(var i=0;i<3;i++){ var child=draft["templates"]![1]!.DeepClone().AsObject();child["id"]="depth"+i;child["components"]![0]!["props"]!["viewLayout"]!["panes"]![0]!["templateId"]=i==2?"container-form":"depth"+(i+1);draft["templates"]!.AsArray().Add(child); }draft["templates"]![1]!["components"]![0]!["props"]!["viewLayout"]!["panes"]![0]!["templateId"]="depth0"; });
var limit=Draft();
var heavy=new JsonObject { ["id"]="heavy",["name"]="Heavy",["width"]=400,["height"]=300,["parameters"]=new JsonObject(),["components"]=new JsonArray() };
for(var i=0;i<500;i++) heavy["components"]!.AsArray().Add(new JsonObject{["id"]="label"+i,["type"]="label",["x"]=0,["y"]=0,["width"]=1,["height"]=1,["props"]=new JsonObject()});
limit["templates"]!.AsArray().Add(heavy);
var panes=new JsonArray();for(var i=0;i<16;i++)panes.Add(new JsonObject{["id"]="p"+i,["label"]="Pane",["templateId"]="heavy"});
Layout(limit)["panes"]=panes;Layout(limit).Remove("initialPaneId");
var copy=limit["screens"]![0]!["components"]![2]!.DeepClone().AsObject();copy["id"]="another";limit["screens"]![0]!["components"]!.AsArray().Add(copy);
var oversized=catalog.Create("Oversized container",JsonNode.Parse(limit.ToJsonString())!.AsObject());Reject(()=>oversized.Publication.Publish(oversized.Store,oversized.Store.GetProject()["revision"]!.GetValue<int>()));
Console.WriteLine("PASS hidden pane dependencies, cycles, parameter references and total expansion are publication-checked");
using var connectors=new ConnectorService(directory);
using var tags=new TagEngine(catalog.GatewayStore,connectors,NullLogger<TagEngine>.Instance);
var queries=new QueryExecutor(workspace.Store,connectors);
var python=Path.GetFullPath(OperatingSystem.IsWindows()?"runtimes/python/windows-x64/python.exe":"/usr/bin/python3");
var runner=new PythonRunner(tags,queries,workspace.Scripts,new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?>{{"Python:Executable",python}}).Build());
var actions=new RuntimeActions(workspace.Publication,runner,queries);
var output=await actions.ExecuteAsync("tabs","run",null,new(){["quantity"]=JsonSerializer.SerializeToElement(7)},stamp,CancellationToken.None,instancePath:eastPath);
Assert(output["success"]!.GetValue<bool>()&&output["result"]!["station"]!.GetValue<string>()=="East"&&output["result"]!["quantity"]!.GetValue<int>()==7,"Scoped Python form result");
var origin=new PopupOrigin("tabs","popup",InstancePath:eastPath);
var popup=await actions.ExecuteAsync("pane-popup","run",null,null,stamp,CancellationToken.None,popupOrigin:origin);
Assert(popup["success"]!.GetValue<bool>()&&popup["result"]!["station"]!.GetValue<string>()=="East","Scoped popup context");
Console.WriteLine("PASS actual local Python actions and popup actions preserve nested pane parameters and validated inputs");
var bytes=SparkProjectPackage.Export(workspace);var imported=SparkProjectPackage.Import(catalog,bytes,"Imported container workshop");
Assert(imported.Publication.Metadata()["published"]!.GetValue<bool>()==false,"Import must remain a draft");
var importedStamp=imported.Publication.Publish(imported.Store,imported.Store.GetProject()["revision"]!.GetValue<int>())["publishedAt"]!.GetValue<string>();
Assert(SparkProjectPackage.Export(imported).Length>0&&imported.Publication.GetAction("tabs","run",importedStamp,instancePath:eastPath)["templateScopes"]!.AsArray().Count==2,"Portable re-export/context roundtrip");
Console.WriteLine("PASS portable workshop exports, imports, explicitly publishes and re-exports without gateway setup");
static void Assert(bool condition,string message){if(!condition)throw new Exception(message);}
static void Reject(Action action){try{action();}catch(ArgumentException){return;}catch(KeyNotFoundException){return;}throw new Exception("Expected rejection");}
`);
const dotnet=path.join(root,'.tools/dotnet',process.platform==='win32'?'dotnet.exe':'dotnet');
const options={cwd:root,encoding:'utf8',maxBuffer:2*1024*1024,env:{...process.env,APPDATA:path.join(root,'.tools/test-appdata'),DOTNET_CLI_HOME:path.join(root,'.tools/dotnet-home'),NUGET_PACKAGES:path.join(root,'.tools/nuget'),DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1'}};
for(const args of [['restore',project,'--configfile',path.join(directory,'NuGet.Config'),'-p:NuGetAudit=false','--verbosity','quiet'],['run','--project',project,'--configuration','ViewContainers','--no-restore','--no-launch-profile','--verbosity','quiet']]){const result=spawnSync(dotnet,args,options);process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');assert.equal(result.status,0,'View container checks failed.');}
