import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

process.on('uncaughtException',error=>{console.error(error.stack?.split('\n').filter(line=>!line.includes('data:')).join('\n')??error.message);process.exit(1);});
process.on('unhandledRejection',error=>{console.error(error?.message??error);process.exit(1);});
const require=createRequire(import.meta.url),url=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const reactUrl=pathToFileURL(require.resolve('react')).href;
const hookUrl=url(`export * from ${JSON.stringify(reactUrl)};export const useRef=x=>globalThis.__queryHooks.useRef(x);export const useState=x=>globalThis.__queryHooks.useState(x);export const useEffect=(f,d)=>globalThis.__queryHooks.useEffect(f,d);`);
const apiUrl=url('export const api=(...args)=>globalThis.__queryApi(...args);export const currentProjectId=()=>null;');
function loader(harness=false){const cache=new Map();return function load(name){if(cache.has(name))return cache.get(name);
  const file=['tsx','ts'].map(ext=>new URL(`src/${name}.${ext}`,import.meta.url)).find(file=>fs.existsSync(file));assert.ok(file,name);
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g,'').replace(/(from\s+|import\s+)(["'])([^"']+)\2/g,(_all,prefix,_quote,dependency)=>{
      const stub=harness&&name==='useQueryPropertyBindings'&&dependency==='react'?hookUrl
        :harness&&['useQueryPropertyBindings','queryPropertyCoordinator'].includes(name)&&dependency==='./api'?apiUrl:undefined;
      return prefix+JSON.stringify(stub??(dependency.startsWith('./')?load(dependency.slice(2)):pathToFileURL(require.resolve(dependency)).href));});
  const result=url(code);cache.set(name,result);return result;};}
const model=loader(),hook=loader(true);
const {validateQueryPropertyBinding,resolveQueryPropertyParameters,queryPropertyValue,transformQueryPropertyValue,loadQueryProperty}=await import(model('queryPropertyModel'));
const {QueryPropertyCoordinator,queryPropertyRequestKey}=await import(model('queryPropertyCoordinator'));
const {ComponentEventCoordinator,componentEventSamples}=await import(model('componentEventModel'));
const {ApplicationStateStore}=await import(model('applicationStateModel'));
const {evaluateComponentBindings,componentGeometry,validatePropertyBinding}=await import(model('propertyBindings'));
const {runtimeBindingHealth}=await import(model('runtimeQuality'));
const {QueryPropertyProvider}=await import(model('useQueryPropertyBindings'));
const {useQueryPropertyBindings}=await import(hook('useQueryPropertyBindings'));
const {default:BoundComponent}=await import(model('BoundComponent'));
const {ProjectComponentView}=await import(model('templates'));
const {ApplicationStateProvider}=await import(model('applicationState'));
const component=(id,type,props={})=>({id,type,x:1,y:2,width:200,height:80,props});
const label=component('caption','label',{text:'Fallback'}),input=component('amount','numberInput',{fieldKey:'amount',defaultValue:2,min:1,max:20}),secret=component('secret','passwordInput',{fieldKey:'secret'});
const reference=(kind,key)=>({expression:'value',references:{value:{kind,key}}});
const context={components:[label,input,secret],tags:[],parameters:{line:'A',unused:'Never send'},inputs:{amount:3,secret:'Never send'},state:{session:{line:'B'},screen:{amount:4},instance:{amount:5}}};
const query={id:'read',name:'Read',kind:'query',parameters:[{name:'line',type:'string',defaultValue:'Default'},{name:'amount',type:'int',defaultValue:1}]};
const binding={queryId:'read',column:'value',parameters:{line:reference('sessionState','line'),amount:reference('instanceState','amount')}};
const result=value=>({columns:['value'],rows:[{value}],durationMs:1});
const request=(id='read',parameters={})=>({queryId:id,parameters,scope:'runtime',projectId:'project',publishedAt:'v1'});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,ms=2500){const start=Date.now();while(!test()){if(Date.now()-start>ms)throw new Error('Timed out waiting for query state.');await sleep(5);}}
let passed=0;async function check(name,run){await run();passed++;console.log(`PASS ${name}`);}

await check('query definitions validate exact shape, existing scalar targets, conflicts and bounded refresh policies',()=>{
  assert.equal(validateQueryPropertyBinding(binding,'text',label,context,[query]),undefined);
  for(const bad of [null,[],{...binding,extra:1},{...binding,queryId:''},{...binding,column:'x'.repeat(129)},{...binding,refresh:{mode:'onChange',intervalMs:1000}},{...binding,refresh:{mode:'poll',intervalMs:999}},{...binding,refresh:{mode:'poll',intervalMs:3600001}},{...binding,refresh:{mode:'poll',intervalMs:1000.5}}])assert.ok(validateQueryPropertyBinding(bad,'text',label,context,[query]));
  assert.ok(validateQueryPropertyBinding(binding,'value',input,context,[query]));assert.ok(validateQueryPropertyBinding(binding,'text',{...label,props:{bindings:{text:reference('parameter','line')}}},context,[query]));
});
await check('mapped parameters preserve native containing-scope values and omit unmapped ambient values',()=>{
  assert.deepEqual(resolveQueryPropertyParameters(binding,label,context),{line:'B',amount:5});
  assert.deepEqual(resolveQueryPropertyParameters({...binding,parameters:{}},label,context),{});
  assert.equal(validateQueryPropertyBinding({...binding,parameters:{missing:reference('parameter','line')}},'text',label,context,[query]).includes('not declared'),true);
  assert.match(validateQueryPropertyBinding({...binding,parameters:{}},'text',label,context,[{...query,parameters:[{name:'required',type:'string'}]}]),/mapping or a saved default/);
  assert.equal(validateQueryPropertyBinding({...binding,parameters:{line:reference('parameter','line')}},'text',label,context,[{...query,parameters:[{name:'line',defaultValue:'Default'}]}]),undefined);
});
await check('range validation shares constant expression/query values and defers dynamic opposite bounds',()=>{
  const range=component('range','progressBar',{min:0,max:100}),fixed=value=>({expression:String(value),references:{}}),queryRange=transform=>({queryId:'read',column:'value',...(transform===undefined?{}:{transform})});
  assert.equal(validatePropertyBinding(fixed(200),'min',{...range,props:{...range.props,queryBindings:{max:queryRange('value * 100')}}}),undefined);
  assert.equal(validatePropertyBinding(fixed(200),'min',{...range,props:{...range.props,queryBindings:{max:queryRange()}}}),undefined);
  assert.match(validatePropertyBinding(fixed(20),'min',{...range,props:{...range.props,queryBindings:{max:queryRange('10')}}}),/Minimum must be less/);
  assert.match(validateQueryPropertyBinding(queryRange('20'),'min',{...range,props:{...range.props,queryBindings:{max:queryRange('10')}}},context,[query]),/Minimum must be less/);
  assert.match(validateQueryPropertyBinding(queryRange('20'),'min',{...range,props:{...range.props,bindings:{max:fixed(10)}}},context,[query]),/Minimum must be less/);
  assert.equal(validateQueryPropertyBinding(queryRange('200'),'min',{...range,props:{...range.props,queryBindings:{max:queryRange('value * 100')}}},context,[query]),undefined);
  assert.equal(validateQueryPropertyBinding(queryRange('200'),'min',{...range,props:{...range.props,bindings:{max:reference('parameter','line')}}},context,[query]),undefined);
  assert.match(validateQueryPropertyBinding(queryRange('200'),'min',range,context,[query]),/Minimum must be less/);
});
await check('all aliases validate even unused; password, tag, invalid input drafts and malformed state fail closed',()=>{
  for(const source of [{kind:'input',key:'secret'},{kind:'tag',path:'[default]Live'},{kind:'screenState',key:'missing'},{kind:'parameter',key:'missing'}]){
    const changed={...binding,parameters:{amount:{expression:'false ? value : 1',references:{value:source}}}};assert.throws(()=>resolveQueryPropertyParameters(changed,label,context));
  }
  const changed={...binding,parameters:{amount:{expression:'1',references:{unused:{kind:'input',key:'amount'}}}}};
  assert.throws(()=>resolveQueryPropertyParameters(changed,label,{...context,inputs:{...context.inputs,amount:''}}));
  assert.throws(()=>resolveQueryPropertyParameters(binding,label,{...context,state:{...context.state,instance:{amount:Infinity}}}));
});
await check('scalar selection requires exactly one row, an own column, and bounded non-null exact scalar',()=>{
  for(const value of [0,false,'','{literal}',Number.MAX_SAFE_INTEGER])assert.equal(queryPropertyValue(result(value),'value'),value);
  for(const bad of [{columns:['value'],rows:[]},{columns:['value'],rows:[{value:1},{value:2}]},{columns:['other'],rows:[{value:1}]},result(null),result({}),result(Infinity),result(Number.MAX_SAFE_INTEGER+1),result('x'.repeat(4097))])assert.throws(()=>queryPropertyValue(bad,'value'));
});
await check('result transforms have exactly value alias and existing strict scalar target semantics',()=>{
  assert.equal(transformQueryPropertyValue(1,'value > 0','enabled'),true);assert.equal(transformQueryPropertyValue(4,'value * 20','width'),80);
  assert.equal(transformQueryPropertyValue(5,undefined,'text'),'5');assert.equal(transformQueryPropertyValue('{x}',undefined,'text'),'{x}');
  for(const transform of ['window.location','value + unknown','value / 0'])assert.throws(()=>transformQueryPropertyValue(1,transform,'width'));
  assert.throws(()=>transformQueryPropertyValue(1,undefined,'enabled'));assert.throws(()=>transformQueryPropertyValue(10000,undefined,'width'));
  assert.ok(validateQueryPropertyBinding({...binding,transform:'"bad"'},'width',label,context,[query]));
});
await check('explicit preview sends only authored mappings, pins publication, and supports abort without late completion',async()=>{
  const calls=[];const api=async(path,method,body,signal)=>{calls.push({path,method,body,signal});return path.includes('/execute')?result(1):[query];};
  assert.equal(await loadQueryProperty({...binding,transform:'value > 0'},'enabled',label,context,'runtime',api,'v1'),true);
  assert.equal(calls.length,2);assert.match(calls[0].path,/publishedAt=v1/);assert.deepEqual(calls[1].body,{parameters:{line:'B',amount:5},publishedAt:'v1'});assert.ok(calls.every(call=>call.signal instanceof AbortSignal));
  let finish;const controller=new AbortController(),pending=loadQueryProperty(binding,'text',label,context,'designer',async()=>new Promise(resolve=>{finish=resolve;}),undefined,controller.signal);
  controller.abort(new Error('Cancelled preview'));await assert.rejects(pending,/Cancelled preview/);finish([query]);
});
await check('shared requests deduplicate catalog and exact query contexts across components and columns',async()=>{
  const events=new ComponentEventCoordinator(),calls=[];let finish;
  const coordinator=new QueryPropertyCoordinator(events,async(path,_method,body)=>{calls.push({path,body});if(!path.includes('/execute'))return[query];return await new Promise(resolve=>{finish=resolve;});});
  const req=request(),key=queryPropertyRequestKey(req),a=coordinator.subscribe(req,()=>{}),b=coordinator.subscribe(req,()=>{});
  await until(()=>Boolean(finish));assert.equal(calls.length,2);finish(result(9));await until(()=>coordinator.peek(key)?.result);assert.equal(coordinator.peek(key).result.rows[0].value,9);a();b();
});
await check('refresh coalesces while busy, keeps a current value during refresh, and drops it on failure',async()=>{
  const pending=[];const coordinator=new QueryPropertyCoordinator(new ComponentEventCoordinator(),async path=>path.includes('/execute')?await new Promise((resolve,reject)=>pending.push({resolve,reject})):[query]);
  const req=request(),key=queryPropertyRequestKey(req),stop=coordinator.subscribe(req,()=>{});await until(()=>pending.length===1);pending[0].resolve(result(4));await until(()=>coordinator.peek(key)?.result);
  coordinator.refresh();coordinator.refresh();coordinator.refresh();await until(()=>pending.length===2);assert.equal(coordinator.peek(key).result.rows[0].value,4);assert.equal(coordinator.peek(key).loading,true);
  pending[1].resolve(result(5));await until(()=>pending.length===3);pending[2].reject(new Error('Database unavailable'));await until(()=>coordinator.peek(key)?.error);assert.equal(coordinator.peek(key).result,undefined);assert.match(coordinator.peek(key).error,/Database unavailable/);stop();
});
await check('last subscriber aborts pending work; a remaining subscriber retains shared work and late results cannot resurrect it',async()=>{
  let signal,finish;const coordinator=new QueryPropertyCoordinator(new ComponentEventCoordinator(),async(path,_method,_body,current)=>{if(!path.includes('/execute'))return[query];signal=current;return await new Promise(resolve=>{finish=resolve;});});
  const req=request(),key=queryPropertyRequestKey(req),a=coordinator.subscribe(req,()=>{}),b=coordinator.subscribe(req,()=>{});await until(()=>signal);a();assert.equal(signal.aborted,false);b();assert.equal(signal.aborted,true);finish(result(99));await sleep(10);assert.equal(coordinator.peek(key),undefined);
});
await check('catalog cache clears after final unsubscribe, including a later Preview run on the same owner',async()=>{
  let catalogs=0,read=0;const coordinator=new QueryPropertyCoordinator(new ComponentEventCoordinator(),async path=>path.includes('/execute')?result(++read):(catalogs++,[query]));
  const req=request(),key=queryPropertyRequestKey(req);let stop=coordinator.subscribe(req,()=>{});await until(()=>coordinator.peek(key)?.result);stop();stop=coordinator.subscribe(req,()=>{});await until(()=>coordinator.peek(key)?.result);assert.equal(catalogs,2);stop();
});
await check('denied and stale-publication reads do not retry on polling but explicit refresh can recheck',async()=>{
  for(const status of [401,403,409]){
    let count=0;const coordinator=new QueryPropertyCoordinator(new ComponentEventCoordinator(),async path=>{if(!path.includes('/execute'))return[query];count++;throw Object.assign(new Error('Denied'),{status});});
    const req=request(),key=queryPropertyRequestKey(req),stop=coordinator.subscribe(req,()=>{},10);await until(()=>coordinator.peek(key)?.error);await sleep(50);assert.equal(count,1);coordinator.refresh();await until(()=>count===2);stop();
  }
});
await check('concurrency is capped at eight and excess contexts fail visibly until a slot is released',async()=>{
  let running=0,peak=0;const pending=[];const coordinator=new QueryPropertyCoordinator(new ComponentEventCoordinator(),async(path,_method,body,signal)=>{if(!path.includes('/execute'))return[query];running++;peak=Math.max(peak,running);return await new Promise(resolve=>{signal.addEventListener('abort',()=>{running--;},{once:true});pending.push(()=>{running--;resolve(result(body.parameters.amount));});});});
  const stops=Array.from({length:129},(_,i)=>coordinator.subscribe(request('read',{amount:i}),()=>{}));await until(()=>pending.length===8);assert.equal(peak,8);assert.match(coordinator.capacityError(queryPropertyRequestKey(request('read',{amount:128}))),/128/);
  stops[0]();await until(()=>!coordinator.capacityError(queryPropertyRequestKey(request('read',{amount:128}))));stops.slice(1).forEach(stop=>stop());await sleep(10);assert.ok(peak<=8);
});

function hookHarness(components,context,options){const slots=[];let cursor=0,pending=[],dirty=false;
  const hooks={useRef(initial){return slots[cursor++]??={current:initial};},useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return[slots[index],value=>{slots[index]=typeof value==='function'?value(slots[index]):value;dirty=true;}];},useEffect(run,deps){const index=cursor++,old=slots[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i])))pending.push(()=>{old?.cleanup?.();slots[index]={deps,cleanup:run()};});}};
  const h={components,context,options,render(){cursor=0;pending=[];dirty=false;globalThis.__queryHooks=hooks;h.values=useQueryPropertyBindings(h.components,h.context,h.options);pending.forEach(run=>run());return h.values;},async settle(){for(let i=0;i<40;i++){await sleep(2);if(dirty)h.render();}return h.values;},stop(){slots.forEach(slot=>slot?.cleanup?.());}};return h;}
function stateOwner(){const store=new ApplicationStateStore();store.configure('run',{});const screen=store.activateScreen('main',{});return{...store.context(screen),store};}
await check('form hook never fetches during Design and parameter changes leave unrelated onChange subscriptions intact',async()=>{
  const calls=[];globalThis.__queryApi=async(path,_method,body)=>{calls.push({path,body});return path.includes('/execute')?result(body.parameters.amount??9):[query];};
  const first={...label,props:{queryBindings:{width:{...binding,parameters:{amount:reference('input','amount')}}}}},second=component('other','label',{queryBindings:{text:{queryId:'read',column:'value'}}});
  const h=hookHarness([first,second],{...context,components:[first,second,input]},{state:stateOwner(),scope:'runtime',publishedAt:'v1',active:false});
  try{h.render();await h.settle();assert.equal(calls.length,0);assert.equal(h.values.caption.width.status,'idle');h.options.active=true;h.render();await h.settle();assert.equal(calls.filter(call=>call.path.includes('/execute')).length,2);
    h.context={...h.context,inputs:{amount:4}};h.render();assert.equal(h.values.caption.width.status,'loading');await h.settle();assert.equal(calls.filter(call=>call.path.includes('/execute')).length,3);assert.equal(h.values.caption.width.value,4);assert.equal(h.values.other.text.value,'9');
    h.components=[{...first,props:{queryBindings:{width:{...first.props.queryBindings.width,transform:'value * 2'}}}},second];h.render();await h.settle();assert.equal(calls.filter(call=>call.path.includes('/execute')).length,3);assert.equal(h.values.caption.width.value,8);
  }finally{h.stop();}
});
await check('offline/context replacement clears samples synchronously and cancels work without overwriting inputs',async()=>{
  let signal,finish;globalThis.__queryApi=async(path,_method,_body,current)=>{if(!path.includes('/execute'))return[query];signal=current;return await new Promise(resolve=>{finish=resolve;});};
  const item={...label,props:{queryBindings:{text:binding}}},h=hookHarness([item],context,{state:stateOwner(),scope:'runtime',publishedAt:'v1',active:true});
  try{h.render();await until(()=>signal);h.context={...context,communicationLost:true};h.render();assert.equal(h.values.caption.text.status,'error');assert.equal(signal.aborted,true);finish(result('late'));await h.settle();assert.equal(h.values.caption.text.status,'error');assert.equal(context.inputs.amount,3);}finally{h.stop();}
});
await check('geometry, rendered literals, process units and event samples consume the same transformed query values',()=>{
  const item=component('display','progressBar',{text:'Default',unit:'Default',value:7,queryBindings:{width:{queryId:'read',column:'value'},text:{queryId:'read',column:'value'},unit:{queryId:'read',column:'value'}},componentEvents:{propertyChange:{properties:['text','width','unit'],language:'javascript',code:'noop'}}});
  const queryProperties={display:{width:{status:'ready',value:420},text:{status:'ready',value:'{literal}'},unit:{status:'ready',value:'{unit}'}}};
  const ctx={...context,parameters:{literal:'Expanded',unit:'Expanded'},queryProperties},resolved=evaluateComponentBindings(item,ctx);
  assert.equal(componentGeometry(item,ctx).width,420);assert.equal(componentEventSamples(item,resolved.component,resolved.errors,ctx.parameters).text.value,'{literal}');
  const html=renderToStaticMarkup(React.createElement(QueryPropertyProvider,{value:queryProperties},React.createElement(BoundComponent,{component:item,components:[item],tags:[],parameters:ctx.parameters,inputs:{},preview:true,onNavigate(){}})));
  assert.match(html,/\{literal\}/);assert.match(html,/\{unit\}/);assert.doesNotMatch(html,/Expanded/);
});
await check('query loading and failure have distinct diagnostics; ordinary refresh does not change value availability',()=>{
  const item={...label,props:{queryBindings:{text:binding},componentEvents:{propertyChange:{properties:['text'],language:'javascript',code:'noop'}}}};
  const view=sample=>renderToStaticMarkup(React.createElement(QueryPropertyProvider,{value:{caption:{text:sample}}},React.createElement(BoundComponent,{component:item,components:[item],tags:[],parameters:{},inputs:{},preview:true,onNavigate(){}})));
  assert.match(view({status:'loading'}),/Loading query/);assert.match(view({status:'error',error:'Database failed'}),/Query unavailable/);
  const samples=refreshing=>{const result=evaluateComponentBindings(item,{...context,queryProperties:{caption:{text:{status:'ready',value:'Current',refreshing}}}});return componentEventSamples(item,result.component,result.errors,{});};
  assert.deepEqual(samples(false),samples(true));assert.match(view({status:'ready',value:'Current',refreshing:true}),/Refreshing query/);
});
await check('template wrapper query properties stay in the parent scope and do not become child parameter inputs',()=>{
  const template={id:'inner',name:'Inner',width:300,height:200,parameters:{caption:'Child'},components:[component('child-label','label',{text:'{caption}'})]};
  const host=component('host','template',{templateId:'inner',text:'Authored',queryBindings:{text:{queryId:'read',column:'value'}}});const state=stateOwner();
  const html=renderToStaticMarkup(React.createElement(ApplicationStateProvider,{value:state},React.createElement(QueryPropertyProvider,{value:{host:{text:{status:'ready',value:'{wrapper}'}}}},React.createElement(ProjectComponentView,{component:host,components:[host],templates:[template],screenId:'main',tags:[],parameters:{wrapper:'Expanded'},inputs:{},preview:true,onNavigate(){}}))));
  assert.match(html,/aria-label="\{wrapper\}"/);assert.match(html,/>Child</);assert.doesNotMatch(html,/Expanded/);
});
await check('unknown nested query samples do not conceal unrelated expression/tag errors or descendants',()=>{
  const nested={id:'nested',name:'Nested',width:400,height:200,parameters:{},components:[component('bad','value',{tagPath:'Missing',queryBindings:{color:{queryId:'read',column:'value'}}}),component('broken','label',{bindings:{text:{expression:'value',references:{value:{kind:'parameter',key:'missing'}}}},queryBindings:{color:{queryId:'read',column:'value'}}})]};
  const outer={id:'outer',name:'Outer',width:400,height:200,parameters:{},components:[component('wrap','template',{templateId:'nested',queryBindings:{text:{queryId:'read',column:'value'}}})]};
  const screen={id:'main',name:'Main',width:600,height:400,components:[component('root','template',{templateId:'outer'})]};
  const health=runtimeBindingHealth(screen,[outer,nested],[],{},{});assert.equal(health.badCount,2);assert.equal(health.unknownCount,3);
});
await check('unobservable bound, private-state and live-query forms disclose a partial summary before descendant traversal',()=>{
  const template={id:'panel',name:'Panel',width:400,height:200,parameters:{name:'Default'},components:[component('query','label',{queryBindings:{text:{queryId:'read',column:'value'}}})]};
  const host=component('host','template',{templateId:'panel'}),screen={id:'main',name:'Main',width:600,height:300,components:[host]};
  const health=(item,definition)=>runtimeBindingHealth({...screen,components:[item]},[definition],[],{},{});
  assert.equal(health({...host,props:{...host.props,parameterBindings:{name:{expression:'"Literal"',references:{}}}}},template).unknownCount,1);
  assert.equal(health(host,{...template,instanceState:{count:{type:'number',value:0}}}).unknownCount,1);
  assert.equal(health({...host,type:'repeater',props:{...host.props,rowsSource:{queryId:'read',rowKey:'id',parameterMap:{}}}},template).unknownCount,1);
});
await check('owner reset aborts immediately but defers subscriber notifications until after the render boundary',async()=>{
  let notifications=0;const events=new ComponentEventCoordinator(),coordinator=new QueryPropertyCoordinator(events,async path=>path.includes('/execute')?result(1):[query]);
  const req=request(),key=queryPropertyRequestKey(req),stop=coordinator.subscribe(req,()=>notifications++);await until(()=>coordinator.peek(key)?.result);await Promise.resolve();const before=notifications;
  events.reset();assert.equal(notifications,before);assert.equal(coordinator.peek(key).result,undefined);await Promise.resolve();assert.ok(notifications>before);stop();
});
await check('slow database feedback retains the shared non-quiescent cascade budget across network waits',async()=>{
  const events=new ComponentEventCoordinator(),coordinator=new QueryPropertyCoordinator(events,async(path,_method,body)=>{if(!path.includes('/execute'))return[query];await sleep(60);return result(body.parameters.amount+1);});
  let stop=()=>{},reads=0;const follow=amount=>{const req=request('read',{amount}),key=queryPropertyRequestKey(req);let handled=false;
    const next=coordinator.subscribe(req,()=>{const sample=coordinator.peek(key);if(!sample?.result||handled)return;handled=true;reads++;queueMicrotask(()=>{if(events.accept('propertyChange'))follow(sample.result.rows[0].value);});});const old=stop;stop=next;old();};
  follow(0);try{await until(()=>Boolean(events.snapshot().breaker),18000);assert.match(events.snapshot().breaker,/128 property changes/);assert.equal(reads,129);}finally{stop();}
});
console.log(`${passed} query property checks passed.`);
