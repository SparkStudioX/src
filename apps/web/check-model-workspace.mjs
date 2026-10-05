import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';
import { createTestModuleFiles } from './test-module-files.mjs';

// Authored offline modeler checks: no gateway, source acquisition or live user data.
const file = createTestModuleFiles(), modules = new Map(), require = createRequire(import.meta.url);
const hooksUrl = file(`let values=[],index=0,pending=[];
export const begin=()=>{index=0;};
export const clear=()=>{values.forEach(item=>item?.cleanup?.());values=[];index=0;pending=[];};
export const useState=initial=>{const at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return [values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next;}];};
export const useRef=initial=>{const at=index++;return values[at]??={current:initial};};
export const useId=()=>{const at=index++;return values[at]??='model-'+at;};
export const useMemo=(run)=>run();
export const useCallback=callback=>callback;
export const useEffect=(run,deps)=>{const at=index++,old=values[at];if(!old||deps.some((item,i)=>item!==old.deps[i]))pending.push(()=>{old?.cleanup?.();values[at]={deps,cleanup:run()};});};
export const flush=()=>{const jobs=pending;pending=[];jobs.forEach(run=>run());};`);
const apiUrl = file('export const api=(...args)=>globalThis.__modelApi(...args);export const displayValue=value=>JSON.stringify(value??null);export const apiUrl=path=>"/api"+path;export const authenticatedFetch=(...args)=>globalThis.__modelFetch(...args);export const assertAuthResponseCurrent=response=>globalThis.__modelResponseCurrent(response);export class ApiError extends Error {constructor(message,status){super(message);this.status=status;}}');
modules.set('api', apiUrl);
modules.set('askSparkContext', file('const registerContext=()=>()=>{};const refreshContext=()=>{};export const useAskSpark=()=>({registerContext,refreshContext});'));
modules.set('modelBuilder', file('export default function ModelBuilder(){return null;}export const emptyBuilderModel=model=>({id:"Model"+(model.udtDefinitions.length+1),version:1,parameters:[],members:[]});'));
function load(name) {
  if (modules.has(name)) return modules.get(name);
  if (name.endsWith('.json')) { const result = file(`export default ${fs.readFileSync(new URL(`src/${name}`, import.meta.url), 'utf8')};`); modules.set(name, result); return result; }
  const source = ['ts','tsx'].map(extension => new URL(`src/${name}.${extension}`, import.meta.url)).find(path => fs.existsSync(path));
  assert.ok(source, name);
  const code = ts.transpileModule(fs.readFileSync(source,'utf8'), { compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX} }).outputText
    .replace(/import\s+["'][^"']+\.css["'];?/g,'')
    .replace(/from (["'])([^"']+)\1/g,(_match,_quote,dependency)=>`from ${JSON.stringify(dependency==='react'?hooksUrl:dependency.startsWith('./')?load(dependency.slice(2)):pathToFileURL(require.resolve(dependency)).href)}`);
  const result=file(code);modules.set(name,result);return result;
}
const model = await import(load('modelWorkspace'));
const namespace = await import(load('modelWorkspaceNamespace'));
const {modelPreviewField,ModelReferenceTargets} = await import(load('modelWorkspaceReview'));
const {readModelExport,previewModelImport,applyModelImport} = await import(load('modelWorkspaceDownload'));
const {default:TagModels}=await import(load('TagModels'));
const {useModelWorkspace}=await import(load('useModelWorkspace'));
const hooks=await import(hooksUrl);
const events=[],storage=new Map();
globalThis.sessionStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
globalThis.window={location:{href:'http://localhost/designer?workspace=models&view=build',search:'?workspace=models&view=build'},history:{state:null,replaceState(_state,_unused,url){window.location.href=String(url);window.location.search=new URL(url).search;}},addEventListener(){},removeEventListener(){},dispatchEvent:event=>{events.push(event.type);return true;}};
globalThis.CustomEvent=class extends Event {};
let passed=0;const check=async(name,run)=>{await run();passed++;console.log(`PASS ${name}`);};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};};
const spindle={id:'Spindle',version:1,parameters:[{name:'Device',type:'String',required:true},{name:'Limit',type:'Double',default:80},{name:'Enabled',type:'Boolean',default:true}],members:[{path:'Speed',kind:'reference',dataType:'Double',target:'[default]Raw/{Device}/Speed',unit:'rpm'}]};
const cnc={id:'CNC',version:1,parameters:[],members:[{path:'Spindle',kind:'type',definitionId:'Spindle',version:1,parameters:{Device:'Haas01'}}]};
const saved={...model.emptyModelPackage(),provider:{name:'default',enabled:true},udtDefinitions:[spindle,cnc],hierarchy:[{path:'[default]Acme',level:'Enterprise'},{path:'[default]Acme/Line',level:'Line'}],instances:[{path:'[default]Acme/Line/CNC01',definitionId:'CNC',version:1,parameters:{},overrides:{'Spindle/Speed':{unit:'rev/min'}}}],scanGroups:[{name:'Normal',publishingIntervalMs:1000,enabled:true}]};
const definition={path:'[default]Acme/Line/CNC01/Spindle/Speed',modelPath:'Spindle/Speed',kind:'reference',dataType:'Double',target:'[default]Raw/Haas01/Speed',udtInstance:'[default]Acme/Line/CNC01',udtDefinition:'CNC',udtVersion:1,unit:'rev/min'};
const preview={revision:'config-4',previewToken:'review-5',totalTags:1,canApply:true,changes:[{path:'CNC@2',kind:'udt',action:'add'}],expandedTags:[definition]};
await check('CSV quotes preserve commas, newlines, escaped quotes and CRLF',()=>{
  assert.deepEqual(model.parseModelCsv('a,b\r\n"one, two","a""b\nnext"\r\n'),[['a','b'],['one, two','a"b\nnext']]);
  for(const text of ['a\n"unterminated','a\n"closed"tail','a\none"two'])assert.throws(()=>model.parseModelCsv(text),/quot/i);
});
await check('bulk instances coerce typed values and omit blank defaults',()=>{
  const result=model.bulkModelInstances('\uFEFFpath,definitionId,version,Device,Limit,Enabled\n[default]A,Spindle,1,Haas01,42.5,false\n[default]B,Spindle,1,Haas02,,',[spindle]);
  assert.deepEqual(result[0].parameters,{Device:'Haas01',Limit:42.5,Enabled:false});assert.deepEqual(result[1].parameters,{Device:'Haas02'});
});
await check('Int64 parameters preserve full-range decimal text without floating point rounding',()=>{
  const type={...cnc,parameters:[{name:'Count',type:'Int64'}]},header='path,definitionId,version,Count\n';
  for(const value of ['9223372036854775807','-9223372036854775808']){assert.equal(model.modelScalar(value,'Int64'),value);assert.equal(model.bulkModelInstances(header+'[default]A,CNC,1,'+value,[type])[0].parameters.Count,value);}
  for(const value of ['9223372036854775808','-9223372036854775809','1.25','9007199254740993x'])assert.throws(()=>model.bulkModelInstances(header+'[default]A,CNC,1,'+value,[type]),/must be Int64/);
});
await check('current model download preserves full-range Int64 strings exactly without a format selector',async()=>{
  globalThis.__modelResponseCurrent=()=>{};
  const raw='{ "format":"sparkstudio.tags", "version":3, "tags":[{"value":"9223372036854775807"}] }\n';globalThis.__modelFetch=async path=>{assert.equal(path,'/api/tag-engineering/export');return new Response(raw);};assert.equal(await readModelExport(),raw);
  globalThis.__modelFetch=async()=>Response.json({format:'sparkstudio.tags',version:2});await assert.rejects(readModelExport(),/invalid current model export/);
  globalThis.__modelFetch=async()=>Response.json({format:'sparkstudio.tags',version:3});globalThis.__modelResponseCurrent=()=>{throw new Error('Signed-in account changed');};await assert.rejects(readModelExport(),/account changed/);globalThis.__modelResponseCurrent=()=>{};
});
await check('current preview and apply preserve exact package text and reject obsolete formats before transport',async()=>{
  const packageText='{ "format":"sparkstudio.tags", "version":3, "tags":[{"path":"[default]Count","kind":"memory","dataType":"Int64","value":"9223372036854775807"}] }\n';
  const revision='config-"exact"',previewToken='review\\token',calls=[];
  globalThis.__modelResponseCurrent=()=>{};
  globalThis.__modelFetch=async(path,options)=>{calls.push({path,...options});return Response.json({revision,previewToken,canApply:true});};
  assert.deepEqual(await previewModelImport(packageText),{revision,previewToken,canApply:true});
  assert.equal(calls[0].body,packageText);assert.equal(calls[0].method,'POST');assert.equal(calls[0].headers['Content-Type'],'application/json');
  await applyModelImport(packageText,revision,previewToken);
  assert.equal(calls[1].body,`{"package":${packageText},"revision":${JSON.stringify(revision)},"previewToken":${JSON.stringify(previewToken)}}`);
  const before=calls.length;for(const invalid of ['null','[]','42','{} trailing'])await assert.rejects(previewModelImport(invalid));await assert.rejects(applyModelImport(packageText,'',''),/Preview/);assert.equal(calls.length,before);
  for(const version of [1,2,4]){const unsupported=JSON.stringify({format:'sparkstudio.tags',version,tags:[]});await assert.rejects(previewModelImport(unsupported),/unsupported format/);await assert.rejects(applyModelImport(unsupported,revision,previewToken),/unsupported format/);}assert.equal(calls.length,before);
  globalThis.__modelFetch=async()=>{calls.push({});return Response.json({error:'Configuration changed; preview again.'},{status:409});};await assert.rejects(applyModelImport(packageText,revision,previewToken),/preview again/);assert.equal(calls.length,before+1,'A failed apply is never replayed');
});
await check('bulk refuses ambiguous headers, bad row shape, duplicate and existing paths',()=>{
  const header='path,definitionId,version,Device\n',row='[default]A,Spindle,1,Haas01';
  for(const csv of ['path,path,version\na,b,1',header+row+'\n'+row,header+'[default]A,Spindle,1',header+'[default]A,Missing,1,Haas01'])assert.throws(()=>model.bulkModelInstances(csv,[spindle]));
  assert.throws(()=>model.bulkModelInstances(header+row,[spindle],[{path:'[default]A'}]),/already exists/);
  assert.throws(()=>model.bulkModelInstances('path,definitionId,version,Limit\n[default]A,Spindle,1,not-a-number',[spindle]),/must be Double/);
  assert.throws(()=>model.bulkModelInstances('path,definitionId,version,Typo\n[default]A,Spindle,1,x',[spindle]),/not a parameter/);
});
await check('bulk review admits 2000 rows and rejects 2001',()=>{
  const csv='path,definitionId,version\n'+Array.from({length:2000},(_,i)=>`[default]A${i},CNC,1`).join('\n');
  assert.equal(model.bulkModelInstances(csv,[cnc]).length,2000);assert.throws(()=>model.bulkModelInstances(csv+'\n[default]Overflow,CNC,1',[cnc]),/2,000/);
});
await check('upgrades retain explicit parameters, member overrides and disabled state',()=>{
  const before={...saved.instances[0],parameters:{Device:'old'},enabled:false},next=model.upgradeModelInstances([before],[before.path],{...cnc,version:2});
  assert.deepEqual(next[0],{...before,version:2});next[0].overrides['Spindle/Speed'].unit='changed';assert.equal(before.overrides['Spindle/Speed'].unit,'rev/min');
  assert.throws(()=>model.upgradeModelInstances([before],[],cnc),/Select/);assert.throws(()=>model.upgradeModelInstances([before],[before.path],spindle),/selected type/);
});
await check('nested authoring leaves use full paths and stop cycles',()=>{
  assert.deepEqual(model.modelLeaves(cnc,[cnc,spindle]).map(item=>item.path),['Spindle/Speed']);
  const cycle={id:'Cycle',version:1,members:[{path:'Again',kind:'type',definitionId:'Cycle',version:1}]};assert.deepEqual(model.modelLeaves(cycle,[cycle]),[]);
  assert.equal(model.nextModelDefinition({...saved,udtDefinitions:[cnc,{...cnc,version:3}]},'CNC@1').version,4);
});
await check('resolved input provenance shows the actual nested source path',()=>{
  assert.equal(modelPreviewField({inputs:{speed:'[default]Machine/Speed'}},'inputs.speed'),'[default]Machine/Speed');
  assert.equal(modelPreviewField({unit:'rpm'},'unit'),'rpm');
});
const source={id:'mqtt1',name:'MQTT',type:'mqtt',source:{points:[{id:'p1',name:'Speed',address:'plant/speed',mappingId:'map1',dataType:'Double'},{id:'p2',name:'Speed',address:'plant/speed',mappingId:'map2',dataType:'Double'}]}};
const sourceTags=[{path:'[default]Raw/Machine/Speed',kind:'device',connectionId:'mqtt1',nodeId:'p1',dataType:'Double'},{path:'[default]Other/Speed',kind:'device',connectionId:'mqtt1',nodeId:'p2',dataType:'Double'}];
const entry={name:'Spindle speed',address:'plant/speed',mappingId:'map1',isVariable:true,dataType:'Double',metadata:{units:'rpm'}};
await check('source type creation references only imported tags in the selected mapping',()=>{
  const draft=model.modelFromSource(source,[entry],sourceTags);assert.equal(draft.members.length,1);assert.equal(draft.members[0].target,'{SourceRoot}/Speed');assert.equal(draft.members[0].unit,'rpm');assert.equal(draft.parameters[0].default,'[default]Raw/Machine');
  assert.throws(()=>model.modelFromSource(source,[entry,{...entry,name:'Missing',address:'plant/missing'}],sourceTags),/Import Missing/);
  assert.throws(()=>model.modelFromSource(source,[entry],[]),/Import/);
});
await check('location defaults follow declared ancestors including Custom and undeclared folders',()=>{
  const package_={...saved,hierarchy:[{path:'[default]Acme',level:'Enterprise'},{path:'[default]Acme/Dallas',level:'Site'},{path:'[default]Acme/Dallas/Other',level:'Custom'},{path:'[default]Acme/Dallas/Work',level:'WorkCenter'}]};
  assert.equal(namespace.nextModelLocationLevel(package_,'[default]'),'Enterprise');
  assert.equal(namespace.nextModelLocationLevel(package_,'[default]Acme'),'Site');
  assert.equal(namespace.nextModelLocationLevel(package_,'[default]Acme/Dallas'),'Area');
  assert.equal(namespace.nextModelLocationLevel(package_,'[default]Acme/Dallas/Other/Folder'),'Area');
  assert.equal(namespace.nextModelLocationLevel(package_,'[default]Acme/Dallas/Work'),'Custom');
});
await check('atomic location rename preserves path-to-kind identity and descendants without rewriting source targets',()=>{
  const root='[default]Acme',site=root+'/Dallas',line=site+'/Area',instance={...saved.instances[0],path:line+'/Press01',parameters:{Device:'Press01'}};
  const package_={...saved,hierarchy:[{path:root,level:'Enterprise'},{path:site,level:'Site'},{path:line,level:'Area',description:'Line location'},{path:line+'/Cell1',level:'Cell'}],instances:[instance]};
  const snapshot=structuredClone(package_);const next=namespace.renameModelLocation(package_,line,'Line1');
  assert.deepEqual(next.hierarchy.map(item=>[item.path,item.level]),[[root,'Enterprise'],[site,'Site'],[site+'/Line1','Area'],[site+'/Line1/Cell1','Cell']]);
  assert.equal(next.hierarchy[2].description,'Line location');assert.equal(next.instances[0].path,site+'/Line1/Press01');assert.deepEqual(next.instances[0].parameters,instance.parameters);assert.deepEqual(next.udtDefinitions,package_.udtDefinitions);assert.deepEqual(next.tags,package_.tags);assert.deepEqual(package_,snapshot);
  const renamedRoot=namespace.renameModelLocation(next,root,'Company');assert.equal(renamedRoot.hierarchy[0].path,'[default]Company');assert.equal(renamedRoot.instances[0].path,'[default]Company/Dallas/Line1/Press01');assert.equal(namespace.modelLocationName('[default]Company'),'Company');
});
await check('location rename rejects collisions and invalid segments before changing the draft',()=>{
  const root='[default]Acme',line=root+'/Line',package_={...saved,hierarchy:[...saved.hierarchy,{path:root+'/Other',level:'Line'}],tags:[{path:root+'/Data/Value',kind:'memory',dataType:'Double',value:1}]};const snapshot=structuredClone(package_);
  for(const value of ['', ' ', '.', '..', 'a/b', 'a\\b', '[default]Bad', '{Bad}', 'bad\nname'])assert.throws(()=>namespace.renameModelLocation(package_,line,value),/name/);
  for(const value of ['Other','Data'])assert.throws(()=>namespace.renameModelLocation(package_,line,value),/already exists/);
  assert.throws(()=>namespace.renameModelLocation(package_,line,'x'.repeat(512)),/512/);assert.throws(()=>namespace.renameModelLocation({...package_,hierarchy:[...package_.hierarchy,package_.hierarchy[1]]},line,'New'),/unique/);assert.deepEqual(package_,snapshot);
  assert.equal(namespace.renameModelLocation(package_,line,' Line '),package_);
});
await check('namespace ancestors, qualities, levels and undeclared instances filter correctly',()=>{
  const extra={...saved.instances[0],path:'[default]Unorganized/CNC02'},defs=[definition,{...definition,path:extra.path+'/Spindle/Speed',udtInstance:extra.path}];
  const all=namespace.modelNamespace({...saved,instances:[...saved.instances,extra]},defs,[{path:definition.path,value:42,quality:'Good'}]);
  const filter={text:'',type:'',level:'',quality:'',outside:false};
  const good=namespace.filterModelNamespace(all,{...filter,quality:'Good'});assert.ok(good.some(item=>item.path==='[default]Acme'));assert.ok(!good.some(item=>item.path===extra.path));
  assert.ok(namespace.filterModelNamespace(all,{...filter,outside:true}).some(item=>item.path===extra.path));
  assert.ok(!namespace.filterModelNamespace(all,{...filter,level:'Line'}).some(item=>item.path===extra.path));
  const expanded=new Set(all.map(item=>item.path));expanded.delete('[default]Acme');assert.ok(!namespace.visibleModelNamespace(all,expanded).some(item=>item.path===definition.path));
});
await check('draft handoff is single-use, owner-scoped and cleared at logout',()=>{
  model.openModelDraft({definition:cnc},'owner-a');assert.equal(events.at(-1),model.modelDraftEvent);assert.deepEqual(model.takeModelDraft('owner-a'),{definition:cnc});assert.equal(model.takeModelDraft('owner-a'),undefined);
  model.openModelDraft({csv:'draft'},'owner-a');assert.equal(model.takeModelDraft('owner-b'),undefined);assert.equal(storage.size,0);
  model.openModelDraft({csv:'draft'},'owner-a');model.clearModelDraft();assert.equal(model.takeModelDraft('owner-a'),undefined);
});
await check('invalid and oversized assistant drafts never enter the form',()=>{
  for(const draft of [{},{csv:42},{definition:{id:'Missing members',version:1}},{definition:{...cnc,members:[null]}},{definition:{...cnc,attributes:null}},{definition:{...cnc,members:[{...spindle.members[0],inputs:{speed:{bad:true}}}]}}])assert.throws(()=>model.openModelDraft(draft,'owner-a'));
  assert.throws(()=>model.openModelDraft({csv:'é'.repeat(600000)},'owner-a'),/1 MiB/);assert.throws(()=>model.openModelDraft({csv:'x'},''),/Sign in/);
  storage.set('sparkstudio.model-draft','broken');assert.equal(model.takeModelDraft('owner-a'),undefined);assert.equal(storage.size,0);
});
const shellParts=new Set(['ModelHeader','ModelDetail','ModelDraftBar','ModelFirstRun']);
const content=node=>typeof node==='string'||typeof node==='number'?String(node):!node?'':typeof node.type==='function'&&shellParts.has(node.type.name)?content(node.type(node.props)):React.Children.toArray(node.props?.children).map(content).join('');
const nodes=node=>!node||typeof node!=='object'?[]:typeof node.type==='function'&&shellParts.has(node.type.name)?nodes(node.type(node.props)):[node,...React.Children.toArray(node.props?.children).flatMap(nodes)];
async function workspace(handler=()=>undefined,initialDraft,tags) {
  hooks.clear();storage.clear();window.location={href:'http://localhost/designer?workspace=models&view=build',search:'?workspace=models&view=build'};
  const calls=[],applied=[];let tree;
  const defaults={'/tag-engineering/export':saved,'/tag-engineering/values':[],'/tag-engineering/definitions':[definition],'/tag-engineering/status':{state:'Running',configuredTags:1,goodTags:1,unavailableTags:0,disabledTags:0},'/connections':[]};
  globalThis.__modelApi=async(...args)=>{calls.push(args);const result=handler(...args);return result===undefined?structuredClone(defaults[args[0]]??preview):result;};
  const render=()=>{hooks.begin();tree=TagModels({ownerId:'model-test-user',initialDraft,tags,onApplied:()=>applied.push(true)});hooks.flush();};
  const find=predicate=>{const item=nodes(tree).find(predicate);assert.ok(item,'Requested model control exists');return item;};
  const button=label=>find(node=>node.type==='button'&&(node.props['aria-label']||content(node))===label);
  const click=label=>{const item=button(label);assert.ok(!item.props.disabled,label);item.props.onClick({currentTarget:{closest:()=>null},preventDefault(){}});render();};
  const component=name=>find(node=>typeof node.type==='function'&&node.type.name===name);
  const change=model=>{component('ModelBuilder').props.onChange(model);render();};
  const changeType=type=>change({...component('ModelBuilder').props.model,udtDefinitions:[...saved.udtDefinitions,type]});
  const review=()=>component('ModelWorkspaceReviewPanel');
  const previewChanges=()=>{find(node=>node.type==='button'&&content(node)==='Review & apply').props.onClick();render();};
  const explore=focus=>{component('ModelExplorer').props.onFocus(focus);render();};
  const menu=label=>{const item=nodes(tree).filter(node=>typeof node.type==='function'&&node.type.name==='ModelMenu').flatMap(node=>node.props.items).find(entry=>entry.label===label);assert.ok(item&&!item.disabled,label);item.onSelect();render();};
  render();await settle();render();await settle();render();return{render,find,button,click,explore,menu,component,change,changeType,review,previewChanges,calls,applied,setTags:next=>{tags=next;render();},text:()=>content(tree)};
}
await check('Models workspace keeps its own heading and one combined header review',async()=>{
  const view=await workspace();assert.ok(view.calls.some(([url])=>url==='/tag-engineering/values'));assert.ok(!view.calls.some(([url])=>url==='/tags'||url==='/tag-definitions'));
  assert.equal(content(view.find(node=>node.type==='h1')),'Models');assert.equal(new URL(window.location.href).searchParams.get('workspace'),'models');
  assert.ok(!view.text().includes('Review & apply'));assert.equal(new URL(window.location.href).searchParams.get('view'),'models');assert.equal(view.component('ModelExplorer').props.lens,'models');
  view.changeType({...cnc,version:2});view.previewChanges();await settle();view.render();assert.equal(view.review().props.review.preview.canApply,true);
  assert.equal(view.review().props.review.preview.expandedTags[0].modelPath,'Spindle/Speed');
  view.changeType({...cnc,version:3});assert.equal(view.review().props.review,null);
});
await check('live gateway snapshots update the Models header and an empty snapshot does not restore stale values',async()=>{
  const values=[{path:definition.path,value:42,quality:'Good'}];
  const view=await workspace(url=>url==='/tag-engineering/values'?values:undefined);
  assert.match(view.text(),/Data running/);
  view.setTags([]);assert.match(view.text(),/1 waiting for data/);assert.ok(!view.text().includes('Data running'));
  assert.deepEqual(view.component('ModelBuilder').props.tags,[]);
  view.setTags([{...values[0],quality:'Bad_WaitingForInitialData'}]);assert.match(view.text(),/1 waiting for data/);
  view.setTags(values);assert.match(view.text(),/Data running/);assert.ok(!view.text().includes('unavailable'));
});
await check('one draft includes type, instances, namespace and provider across view switches',async()=>{
  const view=await workspace(),base=view.component('ModelBuilder').props.model;
  const next={...base,udtDefinitions:[...base.udtDefinitions,{...cnc,version:2}],instances:[...base.instances,...[1,2,3].map(i=>({path:'[default]Line/Press'+i,definitionId:'CNC',version:2,parameters:{},overrides:{}}))],hierarchy:[...base.hierarchy,{path:'[default]Line',level:'Line'}]};
  view.change(next);view.menu('Data update settings');view.component('ModelWorkspaceSettings').props.onChange({...next,provider:{...next.provider,requireDeclaredHierarchy:true}});view.render();view.explore({kind:'home'});view.explore({kind:'model',key:''});
  assert.equal(view.component('ModelBuilder').props.model.instances.length,4);view.previewChanges();await settle();view.render();
  const package_=view.calls.filter(([url])=>url==='/tag-engineering/preview').at(-1)[2];assert.equal(package_.udtDefinitions.length,1);assert.equal(package_.instances.length,3);assert.equal(package_.hierarchy.length,1);assert.equal(package_.provider.requireDeclaredHierarchy,true);
});
await check('atomic apply sends the reviewed immutable snapshot/token once and refreshes observers',async()=>{
  const pending=deferred();const view=await workspace(url=>url==='/tag-engineering/apply'?pending.promise:undefined);
  view.changeType({...cnc,version:2});view.previewChanges();await settle();view.render();
  const apply=view.review().props.onApply;apply();apply();await settle();
  const calls=view.calls.filter(([url])=>url==='/tag-engineering/apply');assert.equal(calls.length,1);assert.equal(calls[0][2].revision,'config-4');assert.equal(calls[0][2].previewToken,'review-5');assert.equal(calls[0][2].package.udtDefinitions[0].version,2);
  pending.resolve({});await settle();view.render();assert.equal(view.applied.length,1);assert.equal(events.at(-1),'sparkstudio:model-changed');assert.ok(!view.text().includes('Not live until you apply'));
});
await check('successful apply notice clears when changing views and on the next draft edit',async()=>{
  const view=await workspace();view.changeType({...cnc,version:2});view.previewChanges();await settle();view.render();
  view.review().props.onApply();await settle();view.render();assert.match(view.text(),/All reviewed model changes were applied together/);
  view.explore({kind:'home'});assert.ok(!view.text().includes('All reviewed model changes were applied together'));
  view.explore({kind:'model',key:''});view.changeType({...cnc,version:3});view.previewChanges();await settle();view.render();
  view.review().props.onApply();await settle();view.render();assert.match(view.text(),/All reviewed model changes were applied together/);
  view.changeType({...cnc,version:4});assert.ok(!view.text().includes('All reviewed model changes were applied together'));
});
await check('apply refresh failure stays visible across view changes without resubmitting the applied draft',async()=>{
  let refreshing=false;
  const view=await workspace(url=>{
    if(url==='/tag-engineering/apply'){refreshing=true;return {};}
    if(refreshing&&url==='/tag-engineering/export')return Promise.reject(new Error('Network unavailable'));
  });
  view.changeType({...cnc,version:2});view.previewChanges();await settle();view.render();view.review().props.onApply();await settle();view.render();
  assert.match(view.text(),/Changes applied, but the model library and data status could not refresh/);
  assert.ok(!view.text().includes('Not live until you apply'));
  view.explore({kind:'home'});assert.match(view.text(),/could not refresh/);
  assert.equal(view.calls.filter(([url])=>url==='/tag-engineering/apply').length,1);
});
await check('pending review rejects non-form edits and subsequent edits invalidate the completed preview',async()=>{
  const pending=deferred();const view=await workspace(url=>url==='/tag-engineering/preview'?pending.promise:undefined,{definition:{...cnc,version:2}});
  view.previewChanges();assert.equal(view.component('ModelBuilder').props.disabled,true);view.changeType({...cnc,version:3});assert.ok(!view.component('ModelBuilder').props.model.udtDefinitions.some(item=>item.version===3));
  pending.resolve(preview);await settle();view.render();assert.equal(view.review().props.review.preview.canApply,true);
  view.changeType({...cnc,version:3});assert.equal(view.review().props.review,null);assert.equal(view.calls.filter(([url])=>url==='/tag-engineering/apply').length,0);
});
async function workspaceHook(handler=()=>undefined,recoveryText) {
  hooks.clear();storage.clear();if(recoveryText!==undefined)storage.set('sparkstudio.model-workspace.model-test-user',recoveryText);let current;
  const calls=[],defaults={'/tag-engineering/export':saved,'/tag-engineering/values':[],'/tag-engineering/definitions':[definition],'/tag-engineering/status':null,'/connections':[]};
  globalThis.__modelApi=async(...args)=>{calls.push(args);const result=handler(...args);return result===undefined?structuredClone(defaults[args[0]]??preview):result;};
  const render=()=>{hooks.begin();current=useModelWorkspace('model-test-user',undefined,()=>{});hooks.flush();};
  render();await settle();render();await settle();render();return{render,get:()=>current,calls};
}
await check('apply locks change, undo, redo, discard and imports through the post-apply refresh',async()=>{
  const applied=deferred(),refresh=deferred();let refreshing=false;
  const view=await workspaceHook(url=>url==='/tag-engineering/apply'?applied.promise:refreshing&&url==='/tag-engineering/export'?refresh.promise:undefined);
  const edited={...saved,udtDefinitions:[...saved.udtDefinitions,{...cnc,version:2}]};view.get().change(edited);view.render();await view.get().preview();view.render();
  const operation=view.get().apply();view.render();const snapshot=view.get().state;
  view.get().change({...edited,instances:[]});view.get().undo();view.get().redo();view.get().discard();view.get().discardRecovery();assert.throws(()=>view.get().importText(JSON.stringify({...model.emptyModelPackage(),instances:[{...saved.instances[0],path:'[default]Extra'}]})),/pasted package/);view.render();
  assert.equal(view.get().state,snapshot);assert.match(view.get().error,/Wait/);assert.equal(view.calls.filter(([url])=>url==='/tag-engineering/apply').length,1);
  refreshing=true;applied.resolve({});await settle();view.render();const accepted=view.get().state;
  view.get().change({...accepted.present,instances:[]});view.render();assert.equal(view.get().state,accepted);
  refresh.resolve(edited);await operation;view.render();assert.equal(view.get().busy,false);assert.equal(view.get().changes.length,0);
});
await check('failed session recovery preserves exact bytes across edits and apply until explicit discard',async()=>{
  const raw='{ broken saved draft\n',key='sparkstudio.model-workspace.model-test-user',view=await workspaceHook(undefined,raw);
  assert.equal(view.get().recoveryDraft,raw);assert.match(view.get().recoveryWarning,/paused/);assert.equal(storage.get(key),raw);
  view.get().change({...saved,udtDefinitions:[...saved.udtDefinitions,{...cnc,version:2}]});view.render();assert.equal(storage.get(key),raw);
  await view.get().preview();view.render();await view.get().apply();view.render();assert.equal(storage.get(key),raw);assert.equal(view.get().recoveryDraft,raw);
  view.get().discardRecovery();view.render();assert.equal(storage.has(key),false);assert.equal(view.get().recoveryDraft,'');
  view.get().change({...saved,hierarchy:[...saved.hierarchy,{path:'[default]Other',level:'Site'}]});view.render();assert.ok(storage.get(key).includes('[default]Other'));
});
await check('malformed imported shapes reject before replacing or persisting the current draft',async()=>{
  const view=await workspaceHook();view.get().change({...saved,udtDefinitions:[...saved.udtDefinitions,{...cnc,version:2}]});view.render();
  const before=view.get().state,serialized=storage.get('sparkstudio.model-workspace.model-test-user');
  for(const invalid of [{udtDefinitions:[{id:'Broken',version:1,members:null}]},{instances:[{...saved.instances[0],parameters:'invalid'}]},{hierarchy:[{path:12,level:'Site'}]},{instances:[{...saved.instances[0],overrides:{'Spindle/Speed':null}}]}])assert.throws(()=>view.get().importText(JSON.stringify({...model.emptyModelPackage(),...invalid})));
  view.render();assert.equal(view.get().state,before);assert.equal(storage.get('sparkstudio.model-workspace.model-test-user'),serialized);
});
await check('failed apply retains draft, invalidates review and never retries automatically',async()=>{
  const view=await workspace(url=>url==='/tag-engineering/apply'?Promise.reject(new Error('Configuration changed; preview again')):undefined,{definition:{...cnc,version:2}});
  view.previewChanges();await settle();view.render();view.review().props.onApply();await settle();view.render();assert.match(view.review().props.error,/Configuration changed/);assert.ok(view.component('ModelBuilder').props.model.udtDefinitions.some(type=>type.id==='CNC'&&type.version===2));assert.equal(view.review().props.review,null);assert.equal(view.calls.filter(([url])=>url==='/tag-engineering/apply').length,1);
  view.review().props.onClose();view.render();view.explore({kind:'home'});assert.match(view.text(),/Configuration changed/);
});
await check('moving multiple instances preserves parameters and stages one combined namespace edit',()=>{
  const first=saved.instances[0],second={...first,path:'[default]Other/CNC02'};const package_={...saved,instances:[first,second]};
  const next=namespace.moveModelInstances(package_,[first.path,second.path],'[default]Acme/Line');assert.equal(next.instances[1].path,'[default]Acme/Line/CNC02');assert.deepEqual(next.instances[1].overrides,second.overrides);assert.equal(package_.instances[1].path,'[default]Other/CNC02');
  assert.throws(()=>namespace.moveModelInstances({...package_,instances:[first,{...second,path:'[default]Other/CNC01'}]},[second.path],'[default]Acme/Line'));
  assert.throws(()=>namespace.moveModelInstances(package_,[first.path],'[default]Missing'),/location/);
});
await check('reference review exposes resolved targets for direct aliases and model members with bounded pages',()=>{
  hooks.clear();const tags=Array.from({length:101},(_,index)=>({...definition,path:`[default]Alias${index}`,target:`[default]Private/Value${index}`,...(index?{udtInstance:undefined}:{})}));
  tags.push({...definition,path:'[default]Memory',kind:'memory',target:undefined});let tree;
  const render=()=>{hooks.begin();tree=ModelReferenceTargets({tags});};render();
  assert.match(content(tree),/cannot read the target path directly/);assert.match(content(tree),/101 total/);
  assert.equal(nodes(tree).filter(node=>node.type==='tbody').flatMap(node=>React.Children.toArray(node.props.children)).length,100);
  assert.match(content(tree),/\[default\]Private\/Value0/);assert.ok(!content(tree).includes('[default]Memory'));
  nodes(tree).find(node=>node.type==='button'&&content(node)==='Next reference targets').props.onClick();render();
  assert.match(content(tree),/\[default\]Private\/Value100/);
  nodes(tree).find(node=>node.type==='input').props.onChange({target:{value:'Private/Value42'}});render();
  assert.match(content(tree),/1–1 of 1 matching references/);assert.match(content(tree),/\[default\]Alias42/);
});
await check('selective bundles import only their package into the shared draft and show external setup',async()=>{
  const view=await workspaceHook(),definition={id:'Portable',version:1,members:[{path:'Value',kind:'memory',dataType:'Double',value:1}]};
  view.get().importText(JSON.stringify({format:'sparkstudio.model-bundle',version:1,package:{...model.emptyModelPackage(),udtDefinitions:[definition]},externalDependencies:[{kind:'connection',id:'plc',reason:'Configure this gateway connection'}]}));view.render();
  assert.ok(view.get().state.present.udtDefinitions.some(item=>item.id==='Portable'));assert.match(view.get().notice,/Configure this gateway connection/);assert.ok(!view.calls.some(call=>call[0].includes('/apply')));
  assert.throws(()=>view.get().importText(JSON.stringify({format:'sparkstudio.model-bundle',version:2,package:model.emptyModelPackage()})),/Unsupported/);
});
hooks.clear();console.log(`${passed} Model workspace checks passed.`);
