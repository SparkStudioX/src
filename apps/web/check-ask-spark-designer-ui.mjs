import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createTestModuleFiles } from './test-module-files.mjs';

const require = createRequire(import.meta.url), moduleFile = createTestModuleFiles();
const hooksUrl = moduleFile(`
let slots=[],index=0,pending=[],changed=false;
export const reset=()=>{for(const slot of slots)slot?.cleanup?.();slots=[];pending=[];index=0;changed=false};
export const begin=()=>{index=0;changed=false};export const dirty=()=>changed;
export const flush=()=>{for(const[slot,callback]of pending.splice(0)){slot.cleanup?.();slot.cleanup=callback()}};
export const useState=initial=>{const at=index++;if(!(at in slots))slots[at]={value:typeof initial==='function'?initial():initial};const slot=slots[at];return[slot.value,value=>{const next=typeof value==='function'?value(slot.value):value;if(!Object.is(next,slot.value)){slot.value=next;changed=true}}]};
export const useRef=initial=>slots[index++]??={current:initial};
const differs=(a,b)=>!a||!b||a.length!==b.length||a.some((value,i)=>value!==b[i]);
export const useMemo=(fn,deps)=>{const at=index++;if(!slots[at]||differs(slots[at].deps,deps))slots[at]={value:fn(),deps};return slots[at].value};
export const useCallback=(fn,deps)=>useMemo(()=>fn,deps);
export const useEffect=(fn,deps)=>{const at=index++,old=slots[at];if(!old||differs(old.deps,deps)){const slot=slots[at]={deps,cleanup:old?.cleanup};pending.push([slot,fn])}};
`);
const hooks = await import(hooksUrl), modules = new Map();
const apiUrl = moduleFile(`export class ApiError extends Error{};export const api=(...args)=>globalThis.__designerUiApi(...args);export const displayValue=value=>JSON.stringify(value);export const id=value=>'new-'+value;export const projectPage=value=>'/'+value;export const projectStorageKey=value=>value;`);
const contextUrl = moduleFile(`export const useAskSpark=()=>globalThis.__designerUiContext;`);
const executorUrl = moduleFile(`export const supportsDesignerTool=()=>true;export const executeDesignerTool=async bridge=>{globalThis.__designerUiBridge=bridge;return{result:{}}};`);
const stubs = {
  api: apiUrl, askSparkContext: contextUrl, askSparkDesignerTools: executorUrl,
  App: moduleFile('export const Field=()=>null;'), Icon: moduleFile('export default function Icon(){return null}'),
  Auth: moduleFile('export const useAuth=()=>({gatewayAdmin:true,permissions:{design:true}});'),
  ScriptEditor: moduleFile('export default function ScriptEditor(){return null}'),
  ApplicationPublishDialog: moduleFile('export default function ApplicationPublishDialog(){return null}'),
  eventScriptAuthoring: moduleFile('export const pythonSystemCompletions=[];'),
};
function load(name) {
  if (stubs[name]) return stubs[name];
  if (modules.has(name)) return modules.get(name);
  const file = ['tsx','ts'].map(extension=>new URL(`src/${name}.${extension}`,import.meta.url)).find(file=>fs.existsSync(file));
  const output = ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText
    .replace(/(from\s+)(["'])([^"']+)\2/g,(_all,prefix,_quote,dependency)=>prefix+JSON.stringify(dependency==='react'?hooksUrl:dependency==='react-dom'?moduleFile('export const flushSync=callback=>{callback();globalThis.__designerUiFlush?.()};'):dependency.startsWith('./')?load(dependency.slice(2)):pathToFileURL(require.resolve(dependency)).href));
  const url=moduleFile(output);modules.set(name,url);return url;
}
const Queries=(await import(load('Queries'))).default, Scripts=(await import(load('Scripts'))).default;
const {useAskSparkDesigner,designerSnapshotToken}=await import(load('useAskSparkDesigner'));
const nodes=node=>Array.isArray(node)?node.flatMap(nodes):!node||typeof node!=='object'?[]:[node,...nodes(node.props?.children)];
const text=node=>Array.isArray(node)?node.map(text).join(''):typeof node==='string'||typeof node==='number'?String(node):!node||typeof node!=='object'?'':text(node.props?.children);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const oldWindow=globalThis.window,oldStorage=globalThis.localStorage;
globalThis.window={addEventListener(){},removeEventListener(){}};globalThis.localStorage={getItem(){return null},setItem(){}};
const originalInterval=globalThis.setInterval;globalThis.setInterval=()=>0;
const query=()=>({id:'query-a',name:'Query A',connectionId:'db',sql:'SELECT 1',parameters:[]});
const script=()=>({id:'script-a',name:'Script A',type:'library',code:'print("saved")',parameters:{},enabled:true});
globalThis.__designerUiApi=async route=>route==='/scripts/resources'?{revision:1,resources:[script()]}:route==='/scripts/publication'?{published:false}:route==='/scripts/events/logs'?[]:{resources:[]};
async function start(Component,extra={}) {
  hooks.reset();let tree,props={queries:[query()],connections:[{id:'db',name:'DB',type:'sqlite'}],parameters:{},pythonAvailable:true,notify(){},onChange(){},onDirtyChange(){},...extra};
  const render=()=>{hooks.begin();tree=Component(props);hooks.flush();return tree};
  const settle=async()=>{for(let i=0;i<8;i++){render();await tick();if(!hooks.dirty()){render();if(!hooks.dirty())break}}return tree};
  await settle();return{get tree(){return tree},update:async patch=>{props={...props,...patch};return settle()},settle};
}
const button=(ui,label)=>nodes(ui.tree).find(node=>node.type==='button'&&text(node)===label);
const querySql=ui=>nodes(ui.tree).find(node=>node.type==='textarea'&&node.props.value?.startsWith('SELECT'));
const scriptCode=ui=>nodes(ui.tree).find(node=>node.type?.name==='ScriptEditor');
let passed=0;async function check(name,work){await work();passed++;console.log(`PASS ${name}`)}
try {
  await check('query refresh displays saved changes and retains the selected query',async()=>{
    const ui=await start(Queries);assert.equal(querySql(ui).props.value,'SELECT 1');
    const next=[{...query(),sql:'SELECT 2'}];await ui.update({queries:next,externalRefresh:next});assert.equal(querySql(ui).props.value,'SELECT 2');
  });
  await check('query refresh preserves unsaved text until explicit discard',async()=>{
    const ui=await start(Queries);querySql(ui).props.onChange({target:{value:'SELECT 7'}});await ui.settle();
    const next=[{...query(),sql:'SELECT 2'}];await ui.update({queries:next,externalRefresh:next});
    assert.equal(querySql(ui).props.value,'SELECT 7');assert.match(text(ui.tree),/unsaved query text is retained/);
    button(ui,'Discard changes').props.onClick();await ui.settle();assert.equal(querySql(ui).props.value,'SELECT 2');
  });
  await check('deleting the selected saved query falls back to the remaining query',async()=>{
    const ui=await start(Queries);const next=[{...query(),id:'query-b',sql:'SELECT 9'}];await ui.update({queries:next,externalRefresh:next});assert.equal(querySql(ui).props.value,'SELECT 9');
  });
  await check('script refresh updates clean editors while keeping the selected script open',async()=>{
    const ui=await start(Scripts,{navigationRequest:{id:'script-a',token:1}});assert.equal(scriptCode(ui).props.value,'print("saved")');
    await ui.update({externalRefresh:{revision:2,resources:[{...script(),code:'print("updated")'}]}});assert.equal(scriptCode(ui).props.value,'print("updated")');
  });
  await check('script refresh preserves unsaved source and displays a reload notice',async()=>{
    let searchResources;const ui=await start(Scripts,{navigationRequest:{id:'script-a',token:1},onSearchResources:resources=>{searchResources=resources}});scriptCode(ui).props.onChange('print("local draft")');await ui.settle();
    await ui.update({externalRefresh:{revision:2,resources:[{...script(),code:'print("updated")'}]}});
    assert.equal(scriptCode(ui).props.value,'print("local draft")');assert.match(text(ui.tree),/unsaved script text is retained/);assert.equal(searchResources[0].code,'print("local draft")');
  });
  await check('Designer bridge commits publish the new snapshot synchronously and mutation listeners stay scoped',async()=>{
    hooks.reset();let project={id:'one',name:'One',revision:1,screens:[{id:'home',name:'Home',components:[]}]},queued=null,executor,listener,context;
    globalThis.__designerUiContext={open:false,registerContext:(_owner,getter)=>{context=getter;return()=>{}},registerExecutor:value=>{executor=value;return()=>{}},registerMutationListener:(_owner,value)=>{listener=value;return()=>{}},refreshContext(){}};
    let refreshed=0;
    const integration=()=>({snapshot:()=>({project,documentId:'home',documentKind:'screen',selectedComponentIds:[],queries:[],scripts:[],tags:[],assets:[]}),change:update=>{queued=()=>{project=update(project)}},select(){},save:async()=>({}),preview:async()=>({}),refreshResources:async()=>{refreshed++},editable:true,workspace:'designer',dirty:false});
    const render=()=>{hooks.begin();useAskSparkDesigner(integration());hooks.flush()};
    globalThis.__designerUiFlush=()=>{queued?.();queued=null;render()};render();await executor.execute('anything',{}, {},new AbortController().signal);
    const bridge=globalThis.__designerUiBridge,initial=designerSnapshotToken(project);bridge.commit({...project,name:'Changed'},initial);
    assert.notEqual(bridge.snapshot().token,initial);assert.equal(bridge.snapshot().project.name,'Changed');assert.equal(context().projectName,'Changed');
    await listener({projectId:'other',name:'queries_save'},new AbortController().signal);assert.equal(refreshed,0);
    await listener({projectId:'one',name:'queries_save'},new AbortController().signal);assert.equal(refreshed,1);
  });
} finally { hooks.reset();globalThis.window=oldWindow;globalThis.localStorage=oldStorage;globalThis.setInterval=originalInterval;delete globalThis.__designerUiFlush; }
console.log(`${passed} Ask Spark designer UI checks passed.`);
