import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';

process.on('uncaughtException', error => { console.error(error.stack?.split('\n').filter(line => !line.includes('data:')).join('\n') ?? error.message); process.exit(1); });
process.on('unhandledRejection', error => { console.error(error?.message ?? error); process.exit(1); });
const require=createRequire(import.meta.url),asModule=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64'),cache=new Map();
const hookUrl=asModule(`let refs=[],at=0,effects=[],previous=[],cleanups=[];export const begin=()=>{at=0;effects=[];};export const useRef=value=>refs[at++]??={current:value};export const useEffect=(fn,deps)=>{const index=at++;effects.push({index,fn,deps});};export const flush=()=>{for(const item of effects){if(!previous[item.index]||item.deps.some((value,index)=>value!==previous[item.index][index])){cleanups[item.index]?.();cleanups[item.index]=item.fn();previous[item.index]=item.deps;}}};export const cleanup=()=>{cleanups.forEach(fn=>fn?.());refs=[];previous=[];cleanups=[];};`);
const authUrl=asModule(`export let state={epoch:1,phase:'ready'};export let revision=1;export const useAuth=()=>state;export const setAuth=value=>{state={...state,...value};};export const advance=()=>revision++;export const authSessionRevision=()=>revision;`);
const apiUrl=asModule(`export const calls=[];export let register;export const setRegister=fn=>register=fn;export const api=(path,method,body,signal)=>{calls.push({path,method,body,signal});return method==='POST'?register(signal):Promise.resolve();};export const apiUrl=(path,project)=>'/api/projects/'+project+path;`);
function load(name){
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');if(cache.has(name))return cache.get(name);const file=['ts','tsx'].map(ext=>new URL('src/'+name+'.'+ext,import.meta.url)).find(file=>fs.existsSync(file));assert.ok(file,name);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText.replace(/import "\.\/[^"\n]+\.css";\r?\n/g,'').replace(/(from\s+|import\s+)(["'])([^"']+)\2/g,(_all,prefix,_quote,dep)=>prefix+JSON.stringify(name==='useRuntimeSessionMessaging'&&dep==='react'?hookUrl:name==='useRuntimeSessionMessaging'&&(dep==='./Auth'||dep==='./authSession')?authUrl:name==='useRuntimeSessionMessaging'&&dep==='./api'?apiUrl:dep.startsWith('./')?load(dep.slice(2)):pathToFileURL(require.resolve(dep)).href));const result=asModule(code);cache.set(name,result);return result;}
const {RuntimeSessionConnection,runtimeSessionIdentity,gatewaySessionMessage}=await import(load('runtimeSessionMessaging'));
const hooks=await import(hookUrl),auth=await import(authUrl),api=await import(apiUrl),{useRuntimeSessionMessaging}=await import(load('useRuntimeSessionMessaging'));
const identity=(sessionId='a'.repeat(32),patch={})=>({sessionId,projectId:'line-a',publishedAt:'2026-09-30T10:00:00Z',...patch});
const envelope=(owner=identity(),patch={})=>({...owner,messageId:'message-1',messageType:'orders.refresh',scope:'session',timestamp:'2026-09-30T11:00:00Z',payload:{quantity:4},...patch});
const tick=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
class FakeStream{listeners=new Map();closed=false;addEventListener(name,listener){const callbacks=this.listeners.get(name)??[];callbacks.push(listener);this.listeners.set(name,callbacks);}close(){this.closed=true;}emit(name,value,raw=false){for(const listener of this.listeners.get(name)??[])listener({data:raw?value:JSON.stringify(value)});}}
function environment(overrides={}){const registrations=[],streams=[],retired=[],tags=[],messages=[],statuses=[],timers=new Map(),canceled=new Set();let serial=0;
 const transport={register:signal=>{const pending=deferred();registrations.push({...pending,signal});return pending.promise;},open:owner=>{const stream=new FakeStream();streams.push({owner,stream});return stream;},unregister:owner=>{retired.push(owner);return Promise.resolve();},tags:values=>tags.push(values),message:value=>messages.push(value),status:(connected,error)=>statuses.push({connected,error}),schedule:(fn,delay)=>{const timer=++serial;timers.set(timer,{fn,delay});return timer;},cancel:timer=>{canceled.add(timer);timers.delete(timer);},...overrides};
 const connection=new RuntimeSessionConnection('line-a',identity().publishedAt,transport);
 const fire=delay=>{const found=[...timers].find(([,timer])=>timer.delay===delay);assert.ok(found,`Timer ${delay}`);timers.delete(found[0]);found[1].fn();return found[1].fn;};
 const ready=async(owner=identity())=>{connection.start();registrations.at(-1).resolve(owner);await tick();const stream=streams.at(-1).stream;stream.emit('ready',owner);return stream;};
 return{transport,connection,registrations,streams,retired,tags,messages,statuses,timers,canceled,fire,ready};}
let passed=0;const check=async(name,run)=>{await run();passed++;console.log(`PASS ${name}`);};
await check('registration and ready must match exact project, publication and server session',async()=>{
 const env=environment();env.connection.start();env.registrations[0].resolve(identity());await tick();const stream=env.streams[0].stream;
 stream.emit('tags',[]);stream.emit('message',envelope());assert.equal(env.tags.length,0);assert.equal(env.messages.length,0);
 stream.emit('ready',identity('b'.repeat(32)));assert.equal(stream.closed,true);assert.equal(env.retired.length,1);assert.equal(env.statuses.at(-1).connected,false);assert.ok([...env.timers.values()].some(timer=>timer.delay===1000));env.connection.stop();
 for(const patch of [{projectId:'other'},{publishedAt:'other'},{sessionId:'bad/path'},{sessionId:'short'}])assert.throws(()=>runtimeSessionIdentity({...identity(),...patch},'line-a',identity().publishedAt));
});
await check('ready stream delivers validated tags and detached bounded session messages',async()=>{
 const env=environment(),stream=await env.ready();stream.emit('tags',[{path:'x',value:2}]);stream.emit('message',envelope());assert.equal(env.statuses[0].connected,true);assert.deepEqual(env.tags,[[{path:'x',value:2}]]);assert.equal(env.messages[0].messageId,'message-1');assert.ok(Object.isFrozen(env.messages[0].payload));
 for(const patch of [{sessionId:'b'.repeat(32)},{projectId:'other'},{publishedAt:'old'},{scope:'screen'},{messageId:'bad\n'},{messageType:' padded'},{timestamp:'no'},{payload:[]},{payload:{x:'a'.repeat(65537)}}])stream.emit('message',envelope(identity(),patch));
 assert.equal(env.messages.length,1);assert.equal(env.tags.length,1);assert.equal(stream.closed,false);env.connection.stop();
});
await check('malformed full snapshots reconnect rather than keeping an incomplete catalog alive',async()=>{
 for(const mode of ['json','shape','sample']){const env=environment({tags:()=>{if(mode==='sample')throw new Error('Invalid sample.');}}),stream=await env.ready();
 stream.emit('tags',mode==='json'?'{':mode==='shape'?{}:[{path:'invalid'}],mode==='json');assert.equal(stream.closed,true);assert.equal(env.retired.length,1);assert.equal(env.statuses.at(-1).connected,false);
 env.fire(1000);assert.equal(env.registrations.length,2);env.connection.stop();assert.equal(env.timers.size,0);}
});
await check('delta and heartbeat frames stay scoped to the current ready session',async()=>{
 const deltas=[];let beats=0,current=true;const env=environment({tagDelta:value=>deltas.push(value),heartbeat:()=>beats++,isCurrent:()=>current});
 env.connection.start();env.registrations[0].resolve(identity());await tick();const stream=env.streams[0].stream,delta={upserts:[{path:'x',value:2}],removed:['old']};
 stream.emit('tags-delta',delta);stream.emit('heartbeat',{});assert.equal(deltas.length,0);assert.equal(beats,0);
 stream.emit('ready',identity());const timer=[...env.timers.keys()][0];stream.emit('tags-delta',delta);assert.deepEqual(deltas,[delta]);assert.ok(env.canceled.has(timer));
 stream.emit('heartbeat',{});assert.equal(beats,1);current=false;stream.emit('tags-delta',delta);stream.emit('heartbeat',{});assert.equal(deltas.length,1);assert.equal(beats,1);
 env.connection.stop();current=true;stream.emit('tags-delta',delta);stream.emit('heartbeat',{});assert.equal(deltas.length,1);assert.equal(beats,1);assert.equal(env.timers.size,0);
});
await check('invalid delta payloads retire the stream and obtain a fresh snapshot session',async()=>{
 for(const invalidJson of [false,true]){const env=environment({tagDelta:()=>{throw new Error('Invalid tag delta.');}}),stream=await env.ready();
 stream.emit('tags-delta',invalidJson?'{':{upserts:'malformed'},invalidJson);assert.equal(stream.closed,true);assert.equal(env.retired.length,1);assert.equal(env.statuses.at(-1).connected,false);
 env.fire(1000);assert.equal(env.registrations.length,2);env.connection.stop();assert.equal(env.timers.size,0);}
});
await check('stop rejects late registration and all late stream callbacks',async()=>{
 const pending=environment();pending.connection.start();pending.connection.stop();assert.ok(pending.registrations[0].signal.aborted);pending.registrations[0].resolve(identity());await tick();assert.equal(pending.streams.length,0);assert.equal(pending.retired.length,1);
 const env=environment(),stream=await env.ready();env.connection.stop();stream.emit('message',envelope());stream.emit('tags',[]);stream.emit('ready',identity());stream.emit('error',{});assert.equal(env.messages.length,0);assert.equal(env.tags.length,0);assert.equal(env.statuses.length,1);assert.equal(env.timers.size,0);
});
await check('registration timeout retires the attempt even if transport ignores abort',async()=>{
 const env=environment();env.connection.start();env.fire(10000);assert.ok(env.registrations[0].signal.aborted);env.fire(1000);assert.equal(env.registrations.length,2);env.registrations[0].resolve(identity());await tick();assert.equal(env.streams.length,0);assert.equal(env.retired.length,1);env.registrations[1].resolve(identity('b'.repeat(32)));await tick();assert.equal(env.streams.length,1);env.connection.stop();
});
await check('ready timeout closes a never-ready stream and reconnects with a new identity',async()=>{
 const env=environment();env.connection.start();env.registrations[0].resolve(identity());await tick();env.fire(10000);assert.ok(env.streams[0].stream.closed);assert.equal(env.retired[0].sessionId,identity().sessionId);env.fire(1000);env.registrations[1].resolve(identity('b'.repeat(32)));await tick();env.streams[1].stream.emit('ready',identity('b'.repeat(32)));env.streams[0].stream.emit('message',envelope());env.streams[1].stream.emit('message',envelope(identity('b'.repeat(32))));assert.equal(env.messages.length,1);env.connection.stop();
});
await check('idle watchdog refreshes on valid frames and replaces stalled stream after fifteen seconds',async()=>{
 const env=environment(),stream=await env.ready();const first=[...env.timers.keys()][0];stream.emit('tags',[]);assert.ok(env.canceled.has(first));const second=[...env.timers.keys()][0];stream.emit('message',envelope());assert.ok(env.canceled.has(second));env.fire(15000);assert.ok(stream.closed);assert.equal(env.retired.length,1);env.fire(1000);assert.equal(env.registrations.length,2);env.connection.stop();
});
await check('reconnect has bounded backoff, ignores retired callbacks, and resets after ready',async()=>{
 const env=environment();env.connection.start();for(const delay of [1000,2000,4000,8000,15000,15000]){env.registrations.at(-1).reject(new Error('offline'));await tick();env.fire(delay);}
 env.registrations.at(-1).resolve(identity());await tick();const stream=env.streams.at(-1).stream;stream.emit('ready',identity());stream.emit('error',{});stream.emit('error',{});assert.equal([...env.timers.values()].filter(timer=>timer.delay===1000).length,1);env.fire(1000);assert.equal(env.registrations.length,8);env.connection.stop();
});
await check('terminal auth and publication errors never spin reconnect attempts',async()=>{
 for(const status of [401,403,404,409]){const env=environment();env.connection.start();env.registrations[0].reject(Object.assign(new Error('rejected'),{status}));await tick();assert.equal(env.timers.size,0);assert.equal(env.statuses[0].connected,false);if(status===409)assert.match(env.statuses[0].error,/published project changed/);env.connection.stop();}
});
await check('canceled retry callback cannot create a second connection after restart',async()=>{
 const env=environment(),stream=await env.ready();stream.emit('error',{});const retry=[...env.timers.values()].find(timer=>timer.delay===1000).fn;env.connection.stop();env.connection.start();retry();assert.equal(env.registrations.length,2);env.connection.stop();
});
await check('external auth or context invalidation blocks messages before effect cleanup',async()=>{
 let current=true;const env=environment({isCurrent:()=>current}),stream=await env.ready();current=false;stream.emit('message',envelope());stream.emit('tags',[]);stream.emit('error',{});assert.equal(env.messages.length,0);assert.equal(env.tags.length,0);assert.equal(env.statuses.length,1);env.connection.stop();
});
await check('hook guards auth generation immediately and unregisters only under original credentials',async()=>{
 const sources=[];globalThis.EventSource=class extends FakeStream{constructor(url){super();this.url=url;sources.push(this);}};
 api.setRegister(()=>Promise.resolve(identity()));const received=[],tags=[],reports=[];const render=(project='line-a',published=identity().publishedAt)=>{hooks.begin();useRuntimeSessionMessaging(project,published,value=>tags.push(value),value=>received.push(value),value=>reports.push(value));};
 render();hooks.flush();await tick();sources[0].emit('ready',identity());assert.equal(api.calls.at(-1).path,'/projects/line-a/runtime/sessions');assert.equal(sources[0].url,'/api/projects/line-a/runtime/sessions/'+identity().sessionId+'/messages?audience=operator');
 auth.advance();sources[0].emit('message',envelope());sources[0].emit('tags',[]);assert.equal(received.length,0);assert.equal(tags.length,0);const before=api.calls.length;hooks.cleanup();assert.equal(api.calls.length,before);delete globalThis.EventSource;
});
await check('hook blocks a retired publication on render and uses captured project for cleanup',async()=>{
 const sources=[];globalThis.EventSource=class extends FakeStream{constructor(url){super();this.url=url;sources.push(this);}};api.setRegister(()=>Promise.resolve(identity()));const received=[];
 const render=(project,published)=>{hooks.begin();useRuntimeSessionMessaging(project,published,()=>{},value=>received.push(value),()=>{});};render('line-a',identity().publishedAt);hooks.flush();await tick();sources[0].emit('ready',identity());render('line-b','new-publication');sources[0].emit('message',envelope());assert.equal(received.length,0);hooks.cleanup();assert.equal(api.calls.at(-1).path,'/projects/line-a/runtime/sessions/'+identity().sessionId);assert.equal(api.calls.at(-1).method,'DELETE');delete globalThis.EventSource;
});
await check('operator wiring keeps tag polling when session messaging fails and rejects old publications',()=>{
 const source=fs.readFileSync(new URL('src/OperatorRuntime.tsx',import.meta.url),'utf8');assert.match(source,/Date\.now\(\) - lastReceived\.current > 8000\) poll\(\)/);assert.match(source,/api<Tag\[\]>\("\/tags"\)/);assert.match(source,/message\.projectId !== currentProject\.current\?\.id/);assert.match(source,/message\.publishedAt !== currentProject\.current\?\.publishedAt/);assert.match(source,/applicationState\.isCurrent\(\)/);
});
console.log(`${passed}/${passed} runtime session messaging checks passed.`);
