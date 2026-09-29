import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';

process.on('uncaughtException',error=>{console.error(error.stack?.split('\n').filter(line=>!line.includes('data:')).join('\n')??error.message);process.exit(1);});
process.on('unhandledRejection',error=>{console.error(error?.message??error);process.exit(1);});
const require=createRequire(import.meta.url),cache=new Map();
function load(name){if(cache.has(name))return cache.get(name);const file=['ts','tsx'].map(ext=>new URL(`src/${name}.${ext}`,import.meta.url)).find(file=>fs.existsSync(file));assert.ok(file,name);
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText.replace(/import "\.\/[^"\n]+\.css";\r?\n/g,'')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g,(_all,prefix,_quote,dep)=>prefix+JSON.stringify(dep.startsWith('./')?load(dep.slice(2)):pathToFileURL(require.resolve(dep)).href));
  const url='data:text/javascript;base64,'+Buffer.from(code).toString('base64');cache.set(name,url);return url;
}
const {ComponentEventCoordinator,ComponentEventLifecycle,componentEventProperties,componentEventSamples,executeComponentEvent}=await import(load('componentEventModel'));
const {ApplicationStateStore}=await import(load('applicationStateModel'));
const {InputStateBindingForm}=await import(load('inputStateBindings'));
const {InputEventLifecycle}=await import(load('inputEvents'));
const {evaluateComponentBindings}=await import(load('propertyBindings'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const script=code=>({language:'javascript',code});
const c=(id,type,props={})=>({id,type,x:4,y:5,width:200,height:100,props});
const component=c('watched','label',{text:'Machine {machine}',componentEvents:{mount:script('mount'),unmount:script('unmount'),propertyChange:{...script('property'),properties:['text','width']}}});
const value=(v,error='')=>({value:error?null:v,available:!error,error});
const samples=(text='A',width=200)=>({text:value(text),width:value(width)});
const context=(overrides={})=>({key:'screen:a',component,components:[component],inputs:{},parameters:{machine:'A'},coordinator:new ComponentEventCoordinator(),...overrides});
function mounted(execute,ctx=context(),initial=samples(),timeout=2000,cleanup=1000){const runner=new ComponentEventLifecycle(execute,timeout,cleanup);runner.activate();runner.prepare(ctx,initial);runner.commit();return runner;}
let passed=0;async function check(name,run){await run();passed++;console.log(`PASS ${name}`);}

await check('property vocabulary excludes password values and observes authored/effective scalars without CSS/tag synthesis',()=>{
  assert.ok(componentEventProperties(c('input','spinner')).includes('value'));assert.ok(!componentEventProperties(c('password','passwordInput')).includes('value'));
  const watched={...component,props:{...component.props,componentEvents:{propertyChange:{...script('x'),properties:['text','width','enabled','visible','color']}}}};
  let observed=componentEventSamples(watched,watched,{}, {machine:'Press01'},undefined);
  assert.deepEqual(observed.text,value('Machine Press01'));assert.deepEqual(observed.enabled,value(true));assert.deepEqual(observed.visible,value(true));assert.deepEqual(observed.width,value(200));assert.equal(observed.color.available,false);
  const bound={...watched,props:{...watched.props,bindings:{text:{expression:"'{machine}'",references:{}}}}};const evaluated=evaluateComponentBindings(bound,{components:[bound],inputs:{},parameters:{machine:'Press01'},tags:[]});
  assert.deepEqual(componentEventSamples(bound,evaluated.component,evaluated.errors,{machine:'Press01'},undefined).text,value('{machine}'));
  const process=c('level','progressBar',{unit:'{unit}',componentEvents:{propertyChange:{...script('x'),properties:['value','min','unit']}}});
  const processSample=componentEventSamples(process,process,{}, {unit:'litres'},undefined);
  assert.deepEqual(processSample.unit,value('litres'));assert.equal(processSample.value.available,false);assert.equal(processSample.min.available,false);
});
await check('mount precedes queued property changes; initial sample is silent and authored watch order is deterministic',async()=>{
  const events=[],ctx=context();const runner=mounted((_s,e)=>events.push(e),ctx);assert.equal(events.length,0,'never execute inside commit/effect stack');
  runner.prepare(ctx,samples('B',250));runner.commit();await runner.whenIdle();assert.deepEqual(events.map(e=>e.type==='propertyChange'?e.property:e.type),['mount','text','width']);
  runner.prepare(ctx,samples('B',250));runner.commit();await runner.whenIdle();assert.equal(events.length,3);
  runner.deactivate();await runner.whenIdle();assert.equal(events.at(-1).type,'unmount');
});
await check('availability and diagnostic changes are explicit, equal unavailable samples stay silent, recovery is observable',async()=>{
  const events=[],ctx=context();const runner=mounted((_s,e)=>events.push(e),ctx);await runner.whenIdle();
  for(const sample of[value(null,'offline'),value(null,'offline'),value(null,'missing'),value('C')]){runner.prepare(ctx,{...samples(),text:sample});runner.commit();await runner.whenIdle();}
  const changes=events.filter(e=>e.type==='propertyChange');assert.equal(changes.length,3);assert.equal(changes[0].value,null);assert.equal(changes[0].available,false);assert.equal(changes[0].previousValue,'A');assert.equal(changes[1].previousError,'offline');assert.equal(changes[2].previousAvailable,false);
  runner.deactivate();await runner.whenIdle();
});
await check('each queued event receives frozen value/parameter/input snapshots with password fields removed',async()=>{
  const secret=c('secret','passwordInput',{fieldKey:'password'}),input=c('amount','numberInput',{fieldKey:'amount'}),events=[];
  const ctx=context({components:[component,secret,input],inputs:{amount:3,password:'never snapshot'},parameters:{machine:'A'}});
  const runner=mounted((_s,e,inputs,parameters)=>{assert.ok(Object.isFrozen(e));assert.ok(Object.isFrozen(inputs));assert.ok(Object.isFrozen(parameters));events.push({inputs,parameters});},ctx);
  ctx.inputs.amount=8;ctx.parameters.machine='B';await runner.whenIdle();assert.deepEqual(events[0],{inputs:{amount:3},parameters:{machine:'A'}});
  runner.deactivate();await runner.whenIdle();assert.equal(Object.hasOwn(events.at(-1).inputs,'password'),false);
});
await check('successful mount helpers stay live for timers until disposal; signal then aborts and every mutation/notify is revoked',async()=>{
  const calls=[],ctx=context({components:[component,c('amount','numberInput',{fieldKey:'amount'})],setInput:(...args)=>calls.push(args)});let app;
  const runner=mounted((_s,e,_i,_p,a)=>{if(e.type==='mount')app=a;},ctx);await runner.whenIdle();assert.equal(app.signal.aborted,false);
  await delay(5);app.setInput('amount',7);app.notify('current');assert.deepEqual(calls,[['amount',7]]);assert.equal(ctx.coordinator.snapshot().diagnostics.at(-1).message,'current');
  runner.deactivate();assert.equal(app.signal.aborted,true);app.setInput('amount',8);app.notify('expired');await runner.whenIdle();assert.equal(calls.length,1);assert.equal(ctx.coordinator.snapshot().diagnostics.at(-1).message,'current');
});
await check('timeouts revoke only the abandoned invocation and allow subsequent serial events to run',async()=>{
  const pending=defer(),calls=[],apps=[],ctx=context({components:[component,c('amount','numberInput',{fieldKey:'amount'})],setInput:(...args)=>calls.push(args)});
  const runner=mounted(async(_s,e,_i,_p,app)=>{apps.push(app);if(e.type==='mount')await pending.promise;else if(e.type==='propertyChange')app.setInput('amount',5);},ctx,samples(),15,10);
  runner.prepare(ctx,samples('B'));runner.commit();await runner.whenIdle();assert.deepEqual(calls,[['amount',5]]);assert.equal(apps[0].signal.aborted,true);apps[0].setInput('amount',99);pending.resolve();await delay(1);assert.equal(calls.length,1);assert.match(ctx.coordinator.snapshot().diagnostics[0].message,/timed out/);runner.deactivate();await runner.whenIdle();
});
await check('context changes synchronously abort stale helpers and queues before next commit',async()=>{
  const apps=[],ctx=context({components:[component,c('amount','numberInput',{fieldKey:'amount'})],setInput(){throw new Error('stale write');}});
  const runner=mounted((_s,e,_i,_p,app)=>{if(e.type==='mount')apps.push(app);},ctx);await runner.whenIdle();runner.prepare({...ctx,key:'screen:b'},samples());assert.equal(apps[0].signal.aborted,true);apps[0].setInput('amount',2);runner.commit();await runner.whenIdle();assert.equal(apps.length,2);runner.deactivate();await runner.whenIdle();
});
await check('StrictMode setup-cleanup-setup reuses prepared render without reviving captured helpers',async()=>{
  const apps=[],ctx=context(),runner=mounted((_s,e,_i,_p,app)=>{if(e.type==='mount')apps.push(app);},ctx);await runner.whenIdle();
  runner.deactivate();runner.activate();runner.commit();await runner.whenIdle();assert.equal(apps.length,2);assert.equal(apps[0].signal.aborted,true);assert.equal(apps[1].signal.aborted,false);
  apps[0].notify('stale');apps[1].notify('fresh');assert.deepEqual(ctx.coordinator.snapshot().diagnostics.map(item=>item.message),['fresh']);runner.deactivate();await runner.whenIdle();
});
await check('a replay waits for a fresh live scope before starting its replacement mount',async()=>{
  const store=new ApplicationStateStore();store.configure('p');const scope=store.activateScreen('main'),first=store.context(scope);let mounts=0;
  const ctx=context({isCurrent:first.isCurrent}),runner=mounted((_s,e)=>{if(e.type==='mount')mounts++;},ctx);await runner.whenIdle();
  store.suspend();runner.deactivate();store.resume();runner.activate();runner.commit();await runner.whenIdle();assert.equal(mounts,1);
  runner.prepare({...ctx,isCurrent:store.context(scope).isCurrent},samples());runner.commit();await runner.whenIdle();assert.equal(mounts,2);runner.deactivate();await runner.whenIdle();
});
await check('cleanup runs after revocation with captured read-only state and reports errors outside the closing component',async()=>{
  const store=new ApplicationStateStore();store.configure('p',{count:{type:'number',value:2}});const scope=store.activateScreen('main',{count:{type:'number',value:3}}),state=store.context(scope);const calls=[];let mountApp;
  const ctx=context({coordinator:store.componentEvents,state:state.api,stateValues:state.values,isCurrent:state.isCurrent,setInput(){calls.push('write');}});
  const runner=mounted((_s,e,_i,_p,app)=>{if(e.type==='mount'){mountApp=app;app.onCleanup(()=>{calls.push(mountApp.state.get('screen','count'));mountApp.state.set('session','count',99);throw new Error('callback cleanup failed');});}
    if(e.type==='unmount'){assert.equal(app.signal.aborted,true);calls.push(app.state.get('session','count'));app.state.set('screen','count',99);app.notify('gone');throw new Error('unmount failed');}},ctx);
  await runner.whenIdle();store.closeScope(scope);runner.deactivate();await runner.whenIdle();assert.deepEqual(calls,[2,3]);assert.equal(store.componentEvents.snapshot().diagnostics.length,2);assert.match(store.componentEvents.snapshot().diagnostics[1].message,/callback cleanup failed/);assert.equal(mountApp.state.get('screen','count'),undefined);
});
await check('cleanup callback count and aggregate time are bounded without permitting late writes',async()=>{
  const stuck=defer(),ctx=context();let mountApp;
  const runner=mounted((_s,e,_i,_p,app)=>{if(e.type==='mount'){mountApp=app;for(let i=0;i<16;i++)app.onCleanup(()=>i===0?stuck.promise:undefined);assert.throws(()=>app.onCleanup(()=>{}),/16/);}},ctx,samples(),30,12);
  await runner.whenIdle();runner.deactivate();await runner.whenIdle();assert.match(ctx.coordinator.snapshot().diagnostics.at(-1).message,/12 ms/);mountApp.notify('late');stuck.resolve();await delay(1);assert.equal(ctx.coordinator.snapshot().diagnostics.length,1);
});
await check('32-event queue bounds reject overflow while retaining deterministic order',async()=>{
  const gate=defer(),events=[],ctx=context();const runner=mounted(async(_s,e)=>{events.push(e);if(e.type==='mount')await gate.promise;},ctx);
  for(let i=1;i<=40;i++){runner.prepare(ctx,samples(String(i)));runner.commit();}gate.resolve();await runner.whenIdle();assert.equal(events.length,32);assert.match(ctx.coordinator.snapshot().diagnostics[0].message,/queue is full/);runner.deactivate();await runner.whenIdle();
});
await check('shared 512/sec circuit aborts every registered component and remains latched across instance churn',async()=>{
  let now=0;const coordinator=new ComponentEventCoordinator(()=>now);const ctx=context({coordinator});let app;
  const runner=mounted((_s,e,_i,_p,a)=>{if(e.type==='mount')app=a;},ctx);await runner.whenIdle();for(let i=0;i<511;i++)assert.equal(coordinator.accept('mount'),true);assert.equal(coordinator.accept('mount'),false);assert.equal(app.signal.aborted,true);
  now=5000;assert.equal(coordinator.accept('mount'),false);const changed=mounted(()=>{throw new Error('blocked');},context({coordinator}));await changed.whenIdle();assert.match(coordinator.snapshot().breaker,/512/);runner.deactivate();changed.deactivate();await Promise.all([runner.whenIdle(),changed.whenIdle()]);
});
await check('non-quiescent async feedback trips at 128 property changes even below the rolling rate',async()=>{
  let now=0,current=0,events=0;const coordinator=new ComponentEventCoordinator(()=>now),watched={...component,props:{componentEvents:{propertyChange:{...script('loop'),properties:['width']}}}},ctx=context({coordinator,component:watched,components:[watched]});
  const runner=mounted(async()=>{events++;await delay(2);now+=20;current++;runner.prepare(ctx,{width:value(current)});runner.commit();},ctx,{width:value(0)});
  current=1;runner.prepare(ctx,{width:value(current)});runner.commit();for(let i=0;i<600&&!coordinator.snapshot().breaker;i++)await delay(5);
  assert.equal(events,128);assert.match(coordinator.snapshot().breaker,/128 property/);runner.deactivate();await runner.whenIdle();
});
await check('independent quiet bursts reset cascade budget while active async work prevents a false quiet reset',async()=>{
  const coordinator=new ComponentEventCoordinator(()=>0);
  for(let round=0;round<2;round++){for(let i=0;i<70;i++){assert.equal(coordinator.accept('propertyChange'),true);coordinator.queued()();}await delay(65);}
  assert.equal(coordinator.snapshot().breaker,'');const active=coordinator.queued();await delay(65);for(let i=0;i<128;i++)assert.equal(coordinator.accept('propertyChange'),true);assert.equal(coordinator.accept('propertyChange'),false);active();assert.match(coordinator.snapshot().breaker,/128/);
});
await check('budget belongs to application screen run, not popup/instance scope creation or closure',()=>{
  const store=new ApplicationStateStore();store.configure('p');const screen=store.activateScreen('a');for(let i=0;i<513;i++)store.componentEvents.accept();assert.ok(store.componentEvents.snapshot().breaker);
  const popup=store.createScope('popup'),instance=store.createScope('instance');store.closeScope(popup);store.closeScope(instance);store.activateScreen('a');assert.ok(store.componentEvents.snapshot().breaker);
  store.activateScreen('b');assert.equal(store.componentEvents.snapshot().breaker,'');assert.equal(store.context(screen).isCurrent(),false);
});
await check('diagnostics retain only latest20, normal messages dismiss, breaker cannot be dismissed',()=>{
  const coordinator=new ComponentEventCoordinator();for(let i=0;i<25;i++)coordinator.report('c',String(i));assert.equal(coordinator.snapshot().diagnostics.length,20);assert.equal(coordinator.snapshot().diagnostics[0].message,'5');
  coordinator.dismiss(coordinator.snapshot().diagnostics[0].id);assert.equal(coordinator.snapshot().diagnostics.length,19);for(let i=0;i<513;i++)coordinator.accept();coordinator.dismiss(-1);assert.ok(coordinator.snapshot().breaker);
});
await check('automatic form assignments bypass user interaction locks but remain local, validated and lifetime fenced',async()=>{
  const store=new ApplicationStateStore();store.configure('p');const screen=store.activateScreen('main',{amount:{type:'number',value:2}}),state=store.context(screen);
  const input=c('amount','spinner',{fieldKey:'amount',min:0,max:10,stateBinding:{scope:'screen',key:'amount'}}),password=c('password','passwordInput',{fieldKey:'password'}),form=new InputStateBindingForm();
  form.update({document:{id:'main',name:'Main',width:1,height:1,components:[input,password]},tags:[],parameters:{},state,active:false,onEdit(){throw new Error('unexpected unbound edit');}});
  form.assignment()('amount',5);assert.equal(state.api.get('screen','amount'),2);
  const ctx=context({component:{...component,props:{...component.props,enabled:false,visible:false}},components:[input,password],state:state.api,stateValues:state.values,isCurrent:state.isCurrent,setInput:form.assignment(true)});
  const events=[],user=new InputEventLifecycle(()=>events.push('user'));user.activate();user.setContext({key:'input',component:input,components:[input],inputs:{amount:2},parameters:{},state:state.api,setInput:form.assignment(),notify(){},error(){}},2);
  const runner=mounted((_s,e,_i,_p,app)=>{if(e.type==='mount'){app.setInput('amount',7);assert.throws(()=>app.setInput('amount',11),/between|range|maximum|10/);assert.throws(()=>app.setInput('password','secret'),/password/);}},ctx);await runner.whenIdle();assert.equal(state.api.get('screen','amount'),7);assert.deepEqual(events,[]);
  const stale=form.assignment(true);store.closeScope(screen);stale('amount',8);assert.equal(state.api.get('screen','amount'),undefined);runner.deactivate();await runner.whenIdle();user.deactivate();
});
await check('trusted script entry point exposes only local helpers and frozen snapshots',async()=>{
  const seen=[],ctx=context({components:[component,c('amount','numberInput',{fieldKey:'amount'})],setInput:(...args)=>seen.push(args)});ctx.component={...component,props:{...component.props,componentEvents:{mount:script('if (!Object.isFrozen(parameters) || app.query || app.writeTag) throw new Error("bad contract"); app.setInput("amount", 4); app.onCleanup(() => {});')}}};
  const runner=mounted(executeComponentEvent,ctx);await runner.whenIdle();assert.deepEqual(seen,[['amount',4]]);assert.equal(ctx.coordinator.snapshot().diagnostics.length,0);runner.deactivate();await runner.whenIdle();
});
await check('read-only Preview never starts authored lifecycle JavaScript or its fetch', async()=>{
  const {setPreviewRequestContext}=await import(load('previewRequest'));
  const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return{};};
  try {
    setPreviewRequestContext({token:'x',mode:'read-only',expiresAt:new Date(Date.now()+60000).toISOString()});
    assert.throws(()=>executeComponentEvent(script('await fetch("https://example.invalid");'),{},{},{},{}),/read-only Preview/);assert.equal(calls,0);
    setPreviewRequestContext(null);assert.throws(()=>executeComponentEvent(script('await fetch("https://example.invalid");'),{},{},{},{}),/read-only Preview/);
    setPreviewRequestContext({token:'x',mode:'live-actions',expiresAt:new Date(Date.now()+60000).toISOString()});
    await executeComponentEvent(script('await fetch("https://example.invalid");'),{},{},{},{});assert.equal(calls,1);
    setPreviewRequestContext(null,false);await executeComponentEvent(script('await fetch("https://example.invalid");'),{},{},{},{});assert.equal(calls,2);
  } finally {globalThis.fetch=original;setPreviewRequestContext(null,false);}
});
await check('read-only owner cannot execute an unmount script after Preview has closed', async()=>{
  const {setPreviewRequestContext}=await import(load('previewRequest'));
  const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return{};};
  try {
    setPreviewRequestContext({token:'x',mode:'read-only',expiresAt:new Date(Date.now()+60000).toISOString()});
    const ctx=context();ctx.component={...ctx.component,props:{componentEvents:{unmount:script('await fetch("https://example.invalid");')}}};
    const runner=mounted(executeComponentEvent,ctx);await runner.whenIdle();setPreviewRequestContext(null,false);runner.deactivate();await runner.whenIdle();assert.equal(calls,0);
  } finally {globalThis.fetch=original;setPreviewRequestContext(null,false);}
});
console.log(`${passed} component-event checks passed.`);
