import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const uri = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const hooks = uri(`
let slots=[],index=0,effects=[],changed=false,mounted=true,lateWrites=0;
const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((value,i)=>value===b[i]);
export const clear=()=>{slots=[];index=0;effects=[];changed=false;mounted=true;lateWrites=0};
export const begin=()=>{index=0;changed=false}; export const dirty=()=>changed;
export const useState=initial=>{const at=index++;if(!(at in slots))slots[at]={value:typeof initial==='function'?initial():initial};return[slots[at].value,value=>{if(!mounted){lateWrites++;return}const next=typeof value==='function'?value(slots[at].value):value;if(!Object.is(next,slots[at].value)){slots[at].value=next;changed=true}}]};
export const useRef=value=>slots[index++]??={current:value};
export const useMemo=(callback,deps)=>{const at=index++;if(!slots[at]||!equal(slots[at].deps,deps))slots[at]={value:callback(),deps};return slots[at].value};
export const useCallback=(callback,deps)=>useMemo(()=>callback,deps);
export const useEffect=(callback,deps)=>{const at=index++;if(!slots[at]||!equal(slots[at].deps,deps)){const old=slots[at];slots[at]={effect:callback,deps};effects.push(()=>{if(mounted){old?.cleanup?.();slots[at].cleanup=callback()}})}};
export const flush=()=>effects.splice(0).forEach(callback=>callback());
export const replay=()=>{for(const slot of slots)if(slot?.effect){slot.cleanup?.();slot.cleanup=slot.effect()}};
export const unmount=()=>{mounted=false;for(const slot of slots)slot?.cleanup?.()};
export const updatesAfterUnmount=()=>lateWrites;
`);
const api = uri(`export const api=(...args)=>globalThis.__deploymentApi(...args); export const apiUrl=route=>'/api'+route; export const authenticatedFetch=(...args)=>globalThis.__deploymentFetch(...args); export const assertAuthResponseCurrent=()=>{};`);
const auth = uri(`export const useAuth=()=>({gatewayAdmin:true,gatewayCapabilities:{diagnostics:true,configuration:true,sessions:true,backups:true,audit:true}});`);
const modules = new Map();
function module(name) {
  if (modules.has(name)) return modules.get(name);
  const file = ['tsx', 'ts'].map(extension => new URL(`src/${name}.${extension}`, import.meta.url)).find(candidate => fs.existsSync(candidate)); assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dependency) => prefix + JSON.stringify(dependency === 'react' ? hooks : dependency === './api' ? api : dependency === './Auth' ? auth : dependency === './deviceConnections' ? module('deviceConnections') : dependency.startsWith('./') ? uri(`export default function ${dependency.slice(2)}(){return null}`) : pathToFileURL(require.resolve(dependency)).href));
  const url = uri(code); modules.set(name, url); return url;
}
const [{default: Deployment},{default: Listener},{default: Recovery},{default: Console},lifecycle] = await Promise.all([
  import(module('GatewayDeployment')),import(module('GatewayDeploymentSettings')),import(module('GatewayRecovery')),import(module('GatewayConsole')),import(hooks),
]);
const {default: ConnectionPanel} = await import(module('ConnectionDiagnostics'));
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : !node || typeof node !== 'object' ? [] : [node,...nodes(node.props?.children)];
const text = node => Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : text(node.props?.children);
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve,reject; const promise=new Promise((done,fail)=>{resolve=done;reject=fail}); return {promise,resolve,reject}; };
let timers,events,checks=0;
const check = async (name,run) => { try { await run(); checks++; console.log(`PASS ${name}`); } finally { lifecycle.unmount(); } };
async function start(Component,handler,{hash='#overview',fetch}={}) {
  lifecycle.clear(); timers=new Map();events=new Map();let nextTimer=1,tree;
  globalThis.window={location:{hash},setInterval:(callback,ms)=>{const id=nextTimer++;timers.set(id,{callback,ms});return id},clearInterval:id=>timers.delete(id),setTimeout:(callback,ms)=>{const id=nextTimer++;timers.set(id,{callback,ms});return id},addEventListener:(name,callback)=>events.set(name,callback),removeEventListener:name=>events.delete(name)};
  globalThis.document={visibilityState:'visible',createElement:()=>({click(){}})};
  const calls=[];
  globalThis.__deploymentApi=(route,method='GET',body,signal)=>{calls.push({route,method,body:body&&structuredClone(body),signal});return handler(route,method,body,signal)};
  globalThis.__deploymentFetch=fetch??(()=>{throw new Error('Unexpected download')});
  const render=()=>{let passes=0;do{assert.ok(passes++<20,'Effects must settle');lifecycle.begin();tree=Component();lifecycle.flush()}while(lifecycle.dirty())};
  const find=(predicate,label)=>{const result=nodes(tree).find(predicate);assert.ok(result,label);return result};
  const button=label=>find(node=>node.type==='button'&&text(node)===label,`button ${label}`);
  const field=label=>{const enclosing=find(node=>node.type==='label'&&text(node).startsWith(label),`field ${label}`);return nodes(enclosing).find(node=>['input','textarea','select'].includes(node.type))};
  const click=label=>{const control=button(label);assert.ok(!control.props.disabled,`${label} is enabled`);control.props.onClick();render()};
  const change=(label,value)=>{const control=field(label);control.props.onChange({target:control.props.type==='checkbox'?{checked:value}:{value}});render()};
  const poll=ms=>{for(const timer of [...timers.values()])if(timer.ms===ms)timer.callback();render()};
  const hashChange=next=>{window.location.hash=next;events.get('hashchange')?.();render()};
  const submit=()=>{find(node=>node.type==='form','form').props.onSubmit({preventDefault(){}});render()};
  render();await settle();render();
  return {calls,render,button,field,click,change,poll,hashChange,submit,all:()=>nodes(tree),text:()=>text(tree)};
}
const snapshot=(name='fixture')=>({observedAt:new Date().toISOString(),startedAt:new Date().toISOString(),environment:{value:name,source:'fixture'},hosting:{kind:'interactive',description:'Synthetic gateway'},listeners:{addresses:['http://127.0.0.1:5091'],httpsEnabled:false,loopbackOnly:true,omittedEntries:0},configuration:{capturedAt:new Date().toISOString(),urls:{values:[],source:'fixture',omittedEntries:0},kestrelEndpoints:{values:[],source:'fixture',omittedEntries:0},allowedHosts:{values:[],source:'fixture',omittedEntries:0},dataDirectory:{value:'synthetic-data',source:'fixture'},restartNote:'A restart applies listener changes.'},publicOperatorAddress:{value:null,source:'request-origin',description:'Uses this gateway.'},transport:{requestHttps:false,requestLoopback:true,forwardedHeadersEnabled:false,forwardedHeadersHostOverride:false,proxyNote:'No proxy fixture.',certificate:{status:'unavailable',expiresAt:null,note:'Not observed.'}}});
const listener=(revision='r1',port=5090)=>({revision,saved:{enabled:false,url:`http://127.0.0.1:${port}`,certificateFile:null,privateKeyFile:null},startupIntent:null,startupState:'unmanaged',state:'unmanaged',restartRequired:false,overrideReason:null,recovery:null,previousAvailable:false,certificateDirectory:'synthetic-certs',installerManagementPort:5090,restartNote:'Restart the synthetic gateway.'});
const recovery=(revision=null,patch={})=>({active:revision!==null,restartRequired:false,invalidMarker:false,revision,dataDirectory:'synthetic-data',restoredAtUtc:null,archiveId:revision,sourceVersion:'0.2.0-fixture',fileCount:2,totalBytes:100,coverage:'Synthetic configuration only.',portability:'Use the matching build.',backupMode:'Stop the gateway before offline backup.',...patch});
const overview=(identity='Fixture gateway')=>({identity,version:'0.2.0-fixture',framework:'.NET fixture',platform:'Synthetic host',observedAt:new Date().toISOString(),recoveryMode:false,currentSessionId:'fixture-admin',sessions:[],projects:[],connections:[],tags:{total:2,configured:2,good:2,unavailable:0},metrics:{observedAt:new Date().toISOString(),uptimeSeconds:120,cpuPercent:1,processWorkingSetBytes:1024,managedMemoryBytes:512,diskAvailableBytes:1024,activeRequests:0,completedRequests:1,failedRequests:0,retention:'Synthetic metrics.',requestWindow:[]}});
const connection={id:'fixture-opc',revision:7,type:'opcua'};
const connectionSnapshot=(revision=7,value='Fixture value')=>({capturedAt:new Date().toISOString(),revision,enabled:true,dependencyCount:1,omittedDependencies:0,omittedValues:0,note:'Synthetic diagnostics',dependencies:[{scope:'Gateway',id:'fixture-tag',name:'Synthetic tag'}],values:[{path:'[default]Fixture/Value',quality:'Good',dataType:'String',timestamp:new Date().toISOString(),displayValue:value}],subscriptions:[]});
const noToolbarReload=ui=>assert.ok(!ui.all().some(node=>node.type==='button'&&/^(Refresh|Reload)\b/.test(text(node))),'No routine refresh/reload controls');

await check('deployment polls quietly, prevents overlapping reads and retains the current observation',async()=>{
  let reads=0;const next=deferred();const ui=await start(Deployment,async()=>++reads===1?snapshot():next.promise);
  noToolbarReload(ui);ui.poll(30000);ui.poll(30000);assert.equal(reads,2);assert.match(ui.text(),/fixture/);assert.doesNotMatch(ui.text(),/Loading deployment status/);
  next.resolve(snapshot('updated environment'));await settle();ui.render();assert.match(ui.text(),/updated environment/);
});
await check('deployment failed observations retain data, expose contextual Retry and fence unmount',async()=>{
  let reads=0;const late=deferred();const ui=await start(Deployment,async()=>{if(++reads===1)return snapshot();if(reads===2)throw new Error('Temporary deployment outage');return late.promise});
  ui.poll(30000);await settle();ui.render();assert.match(ui.text(),/Temporary deployment outage/);assert.match(ui.text(),/Last observation may be outdated/);assert.match(ui.text(),/fixture/);
  ui.click('Retry deployment status');lifecycle.unmount();late.resolve(snapshot('late observation'));await settle();assert.equal(lifecycle.updatesAfterUnmount(),0);assert.equal(timers.size,0);
});
await check('Strict Mode replay fences the old deployment observation and resumes automatic reads',async()=>{
  const first=deferred(),second=deferred();let reads=0;const ui=await start(Deployment,async()=>++reads===1?first.promise:second.promise);
  lifecycle.replay();ui.render();assert.equal(reads,2);second.resolve(snapshot('current replay'));await settle();ui.render();first.resolve(snapshot('old replay'));await settle();ui.render();assert.match(ui.text(),/current replay/);assert.doesNotMatch(ui.text(),/old replay/);
});
await check('listener errors have contextual Retry and Cancel loads the latest saved intent after conflict',async()=>{
  let reads=0;const latest=listener('r2',6001);const ui=await start(Listener,async(route,method)=>{
    if(method==='GET'){if(++reads===1)throw new Error('Temporary listener outage');return reads===2?listener():latest}
    if(route.endsWith('/validate'))return {settings:listener().saved,certificateExpiresAt:null,overrideReason:null,message:'Fixture intent valid'};
    throw new Error('Listener settings changed.');
  });
  noToolbarReload(ui);ui.click('Retry listener settings');await settle();ui.render();
  ui.change('Listener URL','http://127.0.0.1:6000');ui.change('Use the saved listener at startup',true);ui.submit();await settle();ui.render();ui.click('Save for next start');await settle();ui.render();
  assert.equal(ui.field('Listener URL').props.value,'http://127.0.0.1:6000');assert.match(ui.text(),/Listener settings changed/);
  ui.click('Cancel changes');await settle();ui.render();assert.equal(ui.field('Listener URL').props.value,'http://127.0.0.1:6001');assert.equal(ui.button('Save for next start').props.disabled,true);assert.equal(reads,3);
});
await check('failed listener cancellation preserves the draft and late validation cannot update after unmount',async()=>{
  let reads=0;const validation=deferred();const ui=await start(Listener,async(route,method)=>{if(method==='GET'){if(++reads===2)throw new Error('Cancel load unavailable');return listener()}return validation.promise});
  ui.change('Listener URL','http://127.0.0.1:6000');ui.click('Cancel changes');await settle();ui.render();assert.equal(ui.field('Listener URL').props.value,'http://127.0.0.1:6000');assert.match(ui.text(),/Cancel load unavailable/);
  ui.submit();lifecycle.unmount();validation.resolve({settings:listener().saved,certificateExpiresAt:null,overrideReason:null,message:'Valid'});await settle();assert.equal(lifecycle.updatesAfterUnmount(),0);
});
await check('recovery polls quietly without overlap and a new receipt requires fresh acknowledgements',async()=>{
  let reads=0;const next=deferred();const ui=await start(Recovery,async()=>++reads===1?recovery('r1'):next.promise);
  noToolbarReload(ui);for(const label of ['I reviewed connection','I reviewed published','I reviewed accounts'])ui.change(label,true);ui.change('Enter RESUME RESTORED GATEWAY','RESUME RESTORED GATEWAY');
  assert.equal(ui.button('Approve resuming after restart').props.disabled,false);ui.poll(30000);ui.poll(30000);assert.equal(reads,2);assert.equal(ui.button('Approve resuming after restart').props.disabled,false,'Quiet observations do not flicker form locks');
  next.resolve(recovery('r2'));await settle();ui.render();for(const label of ['I reviewed connection','I reviewed published','I reviewed accounts'])assert.equal(ui.field(label).props.checked,false);assert.equal(ui.field('Enter RESUME RESTORED GATEWAY').props.value,'');assert.equal(ui.button('Approve resuming after restart').props.disabled,true);
});
await check('recovery approval fences an outstanding read, blocks duplicate approval and keeps restart required',async()=>{
  const read=deferred(),approval=deferred();let reads=0,posts=0;const ui=await start(Recovery,async(_route,method)=>method==='POST'?(posts++,approval.promise):++reads===1?recovery('r1'):read.promise);
  for(const label of ['I reviewed connection','I reviewed published','I reviewed accounts'])ui.change(label,true);ui.change('Enter RESUME RESTORED GATEWAY','RESUME RESTORED GATEWAY');
  ui.poll(30000);const control=ui.button('Approve resuming after restart');control.props.onClick();control.props.onClick();ui.render();assert.equal(posts,1);assert.equal(ui.calls[1].signal.aborted,true);ui.poll(30000);assert.equal(reads,2);
  approval.resolve(recovery('r1',{restartRequired:true}));await settle();ui.render();read.resolve(recovery('r2'));await settle();ui.render();assert.match(ui.text(),/Recovery reviewed. Restart/);assert.equal(ui.button('Approve resuming after restart').props.disabled,true);assert.equal(ui.field('Enter RESUME RESTORED GATEWAY').props.disabled,true);
});
await check('recovery load failures retry in context and late approvals are fenced after unmount',async()=>{
  let reads=0;const approval=deferred();const ui=await start(Recovery,async(_route,method)=>{if(method==='POST')return approval.promise;if(++reads===1)throw new Error('Temporary recovery outage');return recovery('r1')});
  ui.click('Retry recovery status');await settle();ui.render();for(const label of ['I reviewed connection','I reviewed published','I reviewed accounts'])ui.change(label,true);ui.change('Enter RESUME RESTORED GATEWAY','RESUME RESTORED GATEWAY');ui.click('Approve resuming after restart');lifecycle.unmount();approval.resolve(recovery('r1',{restartRequired:true}));await settle();assert.equal(lifecycle.updatesAfterUnmount(),0);assert.equal(timers.size,0);
});
await check('successful recovery polling does not erase a failed approval or automatically retry it',async()=>{
  const ui=await start(Recovery,async(_route,method)=>{if(method==='POST')throw new Error('Approval could not be recorded');return recovery('r1')});
  for(const label of ['I reviewed connection','I reviewed published','I reviewed accounts'])ui.change(label,true);ui.change('Enter RESUME RESTORED GATEWAY','RESUME RESTORED GATEWAY');ui.click('Approve resuming after restart');await settle();ui.render();
  ui.poll(30000);await settle();ui.render();assert.match(ui.text(),/Approval could not be recorded/);assert.equal(ui.calls.filter(call=>call.method==='POST').length,1);assert.equal(ui.button('Approve resuming after restart').props.disabled,false);
});
await check('gateway observations poll only visible status sections and a tab change fences an old response',async()=>{
  let reads=0;const old=deferred();const ui=await start(Console,async()=>{if(++reads===1)return overview();if(reads===2)return old.promise;return overview('Current gateway')});
  noToolbarReload(ui);document.visibilityState='hidden';ui.poll(15000);assert.equal(reads,1);document.visibilityState='visible';ui.poll(15000);ui.poll(15000);assert.equal(reads,2);
  ui.hashChange('#security');await settle();ui.render();assert.equal(reads,3);old.resolve(overview('Outdated gateway'));await settle();ui.render();assert.match(ui.text(),/Current gateway/);assert.doesNotMatch(ui.text(),/Outdated gateway/);assert.ok(![...timers.values()].some(timer=>timer.ms===15000));
});
await check('quiet gateway status reads preserve support-download action locks and late reads cannot write after unmount',async()=>{
  const download=deferred(),read=deferred();let reads=0;const ui=await start(Console,async()=>++reads===1?overview():reads===2?overview('Updated gateway'):read.promise,{hash:'#diagnostics',fetch:()=>download.promise});
  ui.click('Download support snapshot');assert.equal(ui.button('Download support snapshot').props.disabled,true);ui.poll(15000);await settle();ui.render();assert.equal(ui.button('Download support snapshot').props.disabled,true,'Quiet status completion must not release a download lock');
  download.resolve(new Response('fixture'));await settle();ui.render();assert.equal(ui.button('Download support snapshot').props.disabled,false);
  ui.poll(15000);lifecycle.unmount();read.resolve(overview('Late gateway'));await settle();assert.equal(lifecycle.updatesAfterUnmount(),0);
});
await check('connection diagnostics retain valid data on failure and reject results for another saved revision',async()=>{
  let reads=0;const next=deferred();const ui=await start(()=>ConnectionPanel({connection,expanded:true,onExpandedChange:()=>{}}),async()=>{if(++reads===1)return connectionSnapshot();if(reads===2)throw new Error('Temporary diagnostics outage');return next.promise});
  noToolbarReload(ui);document.visibilityState='hidden';ui.poll(15000);assert.equal(reads,1);document.visibilityState='visible';ui.poll(15000);await settle();ui.render();assert.match(ui.text(),/Fixture value/);assert.match(ui.text(),/Last update may be outdated/);assert.match(ui.text(),/Temporary diagnostics outage/);
  ui.click('Retry diagnostics');ui.poll(15000);assert.equal(reads,3);next.resolve(connectionSnapshot(8,'Mismatched value'));await settle();ui.render();assert.match(ui.text(),/This connection changed/);assert.match(ui.text(),/Fixture value/);assert.doesNotMatch(ui.text(),/Mismatched value/);
});
await check('connection diagnostics retry in context, prevent duplicate reads and fence a late response after unmount',async()=>{
  let reads=0;const late=deferred();const ui=await start(()=>ConnectionPanel({connection,expanded:true,onExpandedChange:()=>{}}),async()=>{if(++reads===1)throw new Error('Diagnostics unavailable');return late.promise});
  const retry=ui.button('Retry diagnostics');retry.props.onClick();retry.props.onClick();ui.render();assert.equal(reads,2);lifecycle.unmount();late.resolve(connectionSnapshot());await settle();assert.equal(lifecycle.updatesAfterUnmount(),0);assert.equal(timers.size,0);
});
console.log(`${checks} gateway deployment/recovery lifecycle groups passed.`);
