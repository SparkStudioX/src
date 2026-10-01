import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
process.on('uncaughtException',error=>{console.error(error.stack?.split('\n').filter(line=>!line.includes('data:')).join('\n')??error.message);process.exit(1);});
const modules = new Map();
function load(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  if (modules.has(name)) return modules.get(name);
  const source = fs.readFileSync(new URL(`src/${name}.ts`, import.meta.url),'utf8');
  const code = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/from "\.\/([^"\n]+)"/g,(_,child)=>`from ${JSON.stringify(load(child))}`);
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`; modules.set(name,url); return url;
}
const {validateDataset,validateDatasetSource,resolveDatasetParameters,loadDataset}=await import(load('datasets'));
const {resolveParameterBindings}=await import(load('templateParameterBindings'));
const {resolveTagAddress}=await import(load('propertyBindings'));
const {createPopup,validatePopupSource}=await import(load('popupModel'));
const {queryRepeaterRows}=await import(load('queryRepeater'));
const {queryTemplateParameters,templateExpansion}=await import(load('templateModel'));
const {QueryPropertyCoordinator,queryPropertyRequestKey}=await import(load('queryPropertyCoordinator'));
const {ComponentEventCoordinator}=await import(load('componentEventModel'));
let passed=0; async function check(name,run){await run();passed++;console.log(`PASS ${name}`);}
const expr=(kind,key)=>({expression:'value',references:{value:{kind,key}}});
const host={id:'host',type:'template',x:0,y:0,width:400,height:200,props:{templateId:'t',parameterBindings:{count:{expression:'live',references:{live:{kind:'tag',path:'[default]{machine}/Count'}}}}}};
const template={id:'t',name:'T',width:400,height:200,parameters:{count:'0'},parameterTypes:{count:'number'},components:[]};
const context={components:[host],parameters:{machine:'A'},inputs:{},tags:[{path:'[default]A/Count',value:12.5,quality:'Good',source:'memory'}]};
await check('tag parameter bindings preserve native values and require every referenced source quality',()=>{
  assert.deepEqual(resolveParameterBindings(host,template,context),{count:12.5});
  for(const quality of ['Bad','Uncertain','Goodness',''])assert.throws(()=>resolveParameterBindings(host,template,{...context,tags:[{...context.tags[0],quality}]}),/quality/);
  assert.throws(()=>resolveParameterBindings(host,template,{...context,communicationLost:true}),/offline/);
  assert.throws(()=>resolveParameterBindings({...host,props:{...host.props,parameterBindings:{count:{expression:'1',references:host.props.parameterBindings.count.references}}}},template,{...context,tags:[]}),/not found/);
  for(const value of [null,{},NaN,Infinity,9007199254740992])assert.throws(()=>resolveParameterBindings(host,template,{...context,tags:[{...context.tags[0],value}]}));
});
await check('bounded addresses substitute parent values once and reject recursive/control/malformed sources',()=>{
  assert.equal(resolveTagAddress('[default]{machine}/Count',{machine:'A'}),'[default]A/Count');
  for(const [path,parameters] of [['x{missing}',{}],['x{machine',{machine:'A'}],['x{machine}',{machine:'{other}'}],['x{machine}',{machine:'A\nB'}],['{machine}'.repeat(17),{machine:'A'}],['x'.repeat(1025),{}]])assert.throws(()=>resolveTagAddress(path,parameters));
});
const data={columns:['x','y','ok'],rows:[{x:'A',y:2,ok:true},{x:'B',y:null,ok:false}]};
await check('datasets preserve null and native scalar cells and fail complete malformed results',()=>{
  assert.deepEqual(validateDataset(data),data); assert.deepEqual(validateDataset({columns:[],rows:[]}),{columns:[],rows:[]});
  for(const bad of [{...data,columns:['x','x']},{...data,rows:[{x:'A',y:2}]},{...data,rows:[{x:'A',y:2,ok:true,extra:0}]},{...data,rows:Array(1001).fill(data.rows[0])},{columns:Array.from({length:65},(_,i)=>`c${i}`),rows:[]},{columns:['__proto__'],rows:[]}])assert.throws(()=>validateDataset(bad));
  for(const value of [undefined,{},[],Infinity,9007199254740992,'x'.repeat(4097)])assert.throws(()=>validateDataset({...data,rows:[{...data.rows[0],y:value}]}));
});
const chart={...host,id:'chart',type:'chart',props:{bindings:{text:{expression:'"A caption"',references:{}}}}},query={id:'read',kind:'query',parameters:[{name:'machine',type:'string'}]},source={queryId:'read',parameters:{machine:expr('parameter','machine')}};
await check('dataset query mappings coexist with scalar captions and validate declared types without tags',()=>{
  assert.equal(validateDatasetSource(source,chart,context,[query]),undefined);assert.deepEqual(resolveDatasetParameters(source,chart,context),{machine:'A'});
  assert.match(validateDatasetSource({...source,parameters:{machine:host.props.parameterBindings.count}},chart,context,[query]),/tags/);
  assert.ok(validateDatasetSource({...source,refresh:{mode:'poll',intervalMs:999}},chart,context,[query]));
});
await check('dataset loader pins metadata and execution, forwards only mappings, and rejects late canceled data',async()=>{
  const calls=[];const request=async(...args)=>{calls.push(args);return args[0].includes('execute')?data:[query];};
  assert.deepEqual(await loadDataset(source,chart,context,'runtime',request,'revision A'),data);
  assert.equal(calls[0][0],'/runtime/queries?publishedAt=revision%20A');assert.deepEqual(calls[1][2],{parameters:{machine:'A'},publishedAt:'revision A'});
  const controller=new AbortController();controller.abort();await assert.rejects(()=>loadDataset(source,chart,context,'runtime',request,'v',controller.signal));assert.equal(calls.length,2);
  const changedType={...query,parameters:[{name:'machine',type:'int'}]};await assert.rejects(()=>loadDataset(source,chart,context,'designer',async()=>[changedType]),/int/);
});
const fixture=JSON.parse(fs.readFileSync(new URL('../../examples/dataset-nested-queries.json',import.meta.url),'utf8'));
const project={...fixture,id:'dataset',revision:0};
const screen=project.screens[0],group=project.templates[0],detail=project.templates[1],parent=screen.components.find(c=>c.id==='groups'),child=group.components[0],opener=detail.components.find(c=>c.id==='inspect');
const records=[{Line:'Line1',Product:'Assembly A',Produced:13640,Target:15000},{Line:'Line2',Product:'Assembly B',Produced:15280,Target:18000}];
const result=rows=>({columns:['Line','Product','Produced','Target'],rows,durationMs:1});
const outerRows=queryRepeaterRows(result(records),parent.props.rowsSource,group),innerRows=queryRepeaterRows(result([records[0]]),child.props.rowsSource,detail);
const outer=queryTemplateParameters(group,project.parameters,{},outerRows[0].parameters),inner=queryTemplateParameters(detail,outer,{},innerRows[0].parameters);
const popup=createPopup(project,screen,opener,project.parameters,inner,{instanceId:'groups',rowId:'Line1',instancePath:[{instanceId:'groups',rowId:'Line1'},{instanceId:'rows',rowId:'Line1'}],template:detail,parameters:inner,inputs:{note:'local'},sourceParameterScopes:[outer,inner]});
await check('two nested query levels reserve bounded rows; default 100x100 fails the expansion budget',()=>{
  assert.equal(templateExpansion(screen.components,project.templates).error,undefined);
  const bad=structuredClone(project);delete bad.screens[0].components.find(c=>c.id==='groups').props.rowsSource.maxRows;delete bad.templates[0].components[0].props.rowsSource.maxRows;
  assert.match(templateExpansion(bad.screens[0].components,bad.templates).error,/10,000/);
  assert.throws(()=>queryRepeaterRows(result(records),{...parent.props.rowsSource,maxRows:1},group),/more than 1/);
});
await check('popup verification replays each query against its containing row and rejects changed ancestors',async()=>{
  const calls=[];let rows=records;
  const api=async(path,_method,body)=>{calls.push({path,body});return path.includes('/execute')?result(rows.filter(row=>!body.parameters.line||row.Line===body.parameters.line)):project.queries;};
  assert.deepEqual(await validatePopupSource(project,popup,[],'runtime',api,'v1'),{ready:true,stale:false,message:''});
  assert.deepEqual(calls.filter(call=>call.path.includes('/execute')).map(call=>call.body.parameters),[{line:''},{line:'Line1'}]);
  rows=records.map(row=>({...row,Produced:row.Produced+1}));assert.equal((await validatePopupSource(project,popup,[],'runtime',api,'v1')).stale,true);
  rows=[records[1]];assert.equal((await validatePopupSource(project,popup,[],'runtime',api,'v1')).stale,true);
});
await check('popup source failures fail closed and canceled checks cannot yield a ready context',async()=>{
  assert.equal((await validatePopupSource(project,popup,[],'runtime',async()=>{throw new Error('disconnected');},'v1')).ready,false);
  const controller=new AbortController();controller.abort();await assert.rejects(()=>validatePopupSource(project,popup,[],'runtime',async()=>project.queries,'v1',controller.signal));
});
await check('coordinator inherited query context filters extras and preserves native scalar values',async()=>{
  const calls=[];const coordinator=new QueryPropertyCoordinator(new ComponentEventCoordinator(),async(path,_method,body)=>path.includes('/execute')?(calls.push(body),result(records)):[{id:'read',kind:'query',parameters:[{name:'count',type:'number'},{name:'permit',type:'boolean'}]}]);
  const request={queryId:'read',scope:'runtime',projectId:'p',publishedAt:'v',inheritParameters:true,parameters:{count:4,permit:true,secret:'not a query parameter'}};
  const stop=coordinator.subscribe(request,()=>{});for(let i=0;i<30&&!coordinator.peek(queryPropertyRequestKey(request))?.result;i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.deepEqual(calls,[{parameters:{count:4,permit:true},publishedAt:'v'}]);stop();
});
console.log(`${passed} binding/dataset/nested-query groups passed.`);
