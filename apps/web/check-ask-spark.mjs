import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createTestModuleFiles } from './test-module-files.mjs';

const require = createRequire(import.meta.url), moduleFile = createTestModuleFiles();
const mockApi = moduleFile('let run=async()=>({}); export const setRequest=fn=>{run=fn}; export const api=(...args)=>run(...args);');
function loadSource(name, replacements = {}) {
  const source = fs.readFileSync(new URL(`src/${name}`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, name) => prefix + JSON.stringify(replacements[name] || (name === './api' ? mockApi : pathToFileURL(require.resolve(name)).href)));
  return moduleFile(output);
}
const clientUrl = loadSource('askSparkClient.ts'), client = await import(clientUrl);
const imagesUrl = loadSource('askSparkImages.ts'), images = await import(imagesUrl);
const retainedUrl = loadSource('askSparkRetainedImages.ts'), retained = await import(retainedUrl);
const navigationUrl = loadSource('askSparkProjectNavigation.ts'), navigation = await import(navigationUrl);
const cropUrl = moduleFile('export const cropRetainedImages=async({crops,resolveImage})=>({created:crops.map(crop=>({sourceImageId:resolveImage(crop.sourceImageId).id,name:crop.name}))});');
const api = await import(mockApi);
const tick = () => new Promise(resolve => setImmediate(resolve));
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await check('only explicitly parallel-safe reads overlap and mutations remain ordered barriers', async () => {
  const calls = ['a','b','write','c','unsafe','d'].map(name => ({ id:name, name, arguments:{}, kind:name==='write'?'write':'read', parallelSafe:name!=='unsafe' }));
  let active = 0, peak = 0; const events = [];
  const results = await client.executeAskSparkCalls(calls, async call => { active++; peak=Math.max(peak,active); events.push(`start:${call.name}`); if(call.name==='write'||call.name==='unsafe') assert.equal(active,1); await tick(); events.push(`end:${call.name}`); active--; return {id:call.id,name:call.name,result:call.name}; }, 2, new AbortController().signal);
  assert.equal(peak,2); assert.deepEqual(results.map(item=>item.id), calls.map(item=>item.id));
  assert.ok(events.indexOf('start:write') > events.indexOf('end:b')); assert.ok(events.indexOf('start:c') > events.indexOf('end:write')); assert.ok(events.indexOf('start:d') > events.indexOf('end:unsafe'));
});
await check('confirmation-required reads do not execute alongside independent reads', async () => {
  let active=0; const calls=[{id:'1',name:'review',kind:'read',confirmation:true,parallelSafe:true},{id:'2',name:'read',kind:'read',parallelSafe:true}];
  await client.executeAskSparkCalls(calls, async call=>{assert.equal(++active,1);await tick();active--;return{id:call.id,name:call.name,result:{}}},8,new AbortController().signal);
});
await check('cancellation prevents subsequent tool calls', async () => {
  const controller=new AbortController(), seen=[];
  await assert.rejects(client.executeAskSparkCalls([{id:'1',name:'one',kind:'write'},{id:'2',name:'two',kind:'write'}], async call=>{seen.push(call.name);controller.abort();return{id:call.id,name:call.name,result:{}}},3,controller.signal),/abort/i);
  assert.deepEqual(seen,['one']);
});
await check('captured context is bounded, copied, includes snapshot proof, and excludes credentials and callbacks', () => {
  const original={surface:'designer',editorAvailable:true,projectId:'project-a',snapshotToken:'snapshot-1',selectedComponentIds:['one'],password:'secret',resolveSecret(){},documentName:'a'.repeat(700),revision:3,nested:{secret:'never'}};
  const captured=client.captureAskSparkContext(original);original.selectedComponentIds.push('two');assert.deepEqual(captured.selectedComponentIds,['one']);assert.equal(captured.snapshotToken,'snapshot-1');assert.equal(captured.documentName.length,512);assert.equal(captured.password,undefined);assert.equal(captured.resolveSecret,undefined);assert.equal(captured.nested,undefined);
});
await check('image size/count/type/aggregate limits and actual signatures are enforced before upload', () => {
  assert.equal(images.imageAttachmentError([],100,'image/png'),undefined);assert.match(images.imageAttachmentError([],100,'image/svg+xml'),/PNG/);assert.match(images.imageAttachmentError([],6*1024*1024,'image/png'),/5 MiB/);assert.match(images.imageAttachmentError(Array.from({length:4},()=>({data:''})),1,'image/png'),/four/);assert.match(images.imageAttachmentError([{data:'x'.repeat(12*1024*1024)}],1,'image/png'),/combined/);
  assert.equal(images.validImageSignature(Uint8Array.from([137,80,78,71,13,10,26,10]),'image/png'),true);assert.equal(images.validImageSignature(new TextEncoder().encode('GIF89a'),'image/png'),false);assert.equal(images.validImageSignature(Uint8Array.from([255,216,255]),'image/jpeg'),true);assert.equal(images.validImageSignature(new TextEncoder().encode('RIFFxxxxWEBP'),'image/webp'),true);
});
const storage = new Map(); globalThis.sessionStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
await check('draft storage is user/audience scoped and contains no tool results or API credentials', () => {
  const one=client.askSparkStorageKey('one','engineering'),two=client.askSparkStorageKey('two','engineering');assert.notEqual(one,two);assert.notEqual(one,client.askSparkStorageKey('one','operator'));
  client.writeAskSparkSession(one,'conversation','draft');assert.deepEqual(client.readAskSparkSession(one),{conversationId:'conversation',draft:'draft'});assert.deepEqual(client.readAskSparkSession(two),{conversationId:undefined,draft:''});assert.deepEqual(Object.keys(JSON.parse(storage.get(one))),['conversationId','draft']);
});

const hooksUrl=moduleFile(`let slots=[],index=0,pending=[];export const begin=()=>{index=0};export const reset=()=>{for(const slot of slots)slot?.cleanup?.();slots=[];index=0;pending=[]};export const flush=()=>{for(const [slot,fn] of pending.splice(0)){slot.cleanup?.();slot.cleanup=fn()}};export const useState=initial=>{const at=index++;if(!(at in slots))slots[at]={value:typeof initial==='function'?initial():initial};const slot=slots[at];return[slot.value,value=>{slot.value=typeof value==='function'?value(slot.value):value}]};export const useRef=initial=>{const at=index++;return slots[at]??={current:initial}};const changed=(a,b)=>!a||!b||a.length!==b.length||a.some((item,i)=>item!==b[i]);export const useCallback=(fn,deps)=>{const at=index++;if(!slots[at]||changed(slots[at].deps,deps))slots[at]={value:fn,deps};return slots[at].value};export const useEffect=(fn,deps)=>{const at=index++;const old=slots[at];if(!old||changed(old.deps,deps)){const slot=slots[at]={deps,cleanup:old?.cleanup};pending.push([slot,fn])}};export const createContext=()=>({Provider:'provider'});export const useContext=context=>context.value;`);
const hooks=await import(hooksUrl), authUrl=moduleFile(`let current={user:{id:'test-one'},audience:'engineering',epoch:1};export const useAuth=()=>current;export const setAuth=value=>{current=value};`), auth=await import(authUrl);
const privateUrl=moduleFile('const cancel=()=>{};export const useAskSparkPrivateInputs=()=>({cancel,dialog:null,resolveSecret:async()=>({password:"private"}),resolveAttachment:async()=>new Blob()});');
const gatewayUrl=moduleFile('export const supportsGatewayTool=()=>false;export const executeGatewayTool=async()=>{throw new Error("unexpected gateway call")};');
const providerUrl=loadSource('askSparkContext.tsx',{react:hooksUrl,'./Auth':authUrl,'./askSparkPrivateInputs':privateUrl,'./askSparkGatewayTools':gatewayUrl,'./askSparkClient':clientUrl,'./askSparkImages':imagesUrl,'./askSparkRetainedImages':retainedUrl,'./askSparkProjectNavigation':navigationUrl,'./askSparkImageCrops':cropUrl});
const {AskSparkProvider}=await import(providerUrl);
globalThis.window={addEventListener(){},removeEventListener(){}};
let state;function render(){hooks.begin();state=AskSparkProvider({children:null}).props.value;return state;}
async function beginProvider(request){hooks.reset();storage.clear();auth.setAuth({user:{id:'test-one'},audience:'engineering',epoch:1});api.setRequest(request);render();hooks.flush();await tick();render();hooks.flush();render();}
const status={enabled:true,configured:true,model:'test-model',parallelLimit:3};
await check('resource context priority is independent of parent registration order and clears hidden canvas selection',async()=>{
  await beginProvider(async()=>status);
  const removeResource=state.registerContext('resource:connection',()=>client.connectionAskSparkContext('connection-a','Plant broker','security',false),20);
  const root=()=>({surface:'designer',editorAvailable:true,projectId:'project-a',section:'designer',documentId:'screen-a',documentName:'Screen',selectedComponentIds:['label'],snapshotToken:'snapshot-a'});
  const removeOldRoot=state.registerContext('designer',root);render();
  assert.equal(state.context.projectId,'project-a');assert.equal(state.context.section,'connections');assert.equal(state.context.connectionId,'connection-a');assert.equal(state.context.connectionSection,'security');assert.equal(state.context.editorAvailable,true);
  assert.equal(state.context.documentId,undefined);assert.equal(state.context.selectedComponentIds,undefined);assert.equal(state.context.snapshotToken,undefined);
  state.registerContext('designer',root);removeOldRoot();render();assert.equal(state.context.connectionId,'connection-a');assert.equal(state.context.projectId,'project-a');
  removeResource();render();assert.equal(state.context.section,'designer');assert.equal(state.context.documentId,'screen-a');assert.equal(state.context.snapshotToken,'snapshot-a');
});
await check('pinned and removed connection chips do not follow navigation while active workspace still updates',async()=>{
  await beginProvider(async()=>status);let selected='one';
  state.registerContext('gateway',()=>({surface:'gateway',section:'configuration',editorAvailable:false}));state.registerContext('resource:connection',()=>client.connectionAskSparkContext(selected,`Connection ${selected}`,'connection',false),20);render();
  state.togglePinned();selected='two';state.refreshContext();render();assert.equal(state.context.connectionId,'one');assert.equal(state.activeContext.connectionId,'two');assert.equal(state.context.editorAvailable,false);
  state.removeContext(client.contextChips(state.context).find(chip=>chip.key==='connection').remove);render();assert.equal(state.context.connectionId,undefined);assert.equal(state.context.connectionSection,undefined);assert.equal(state.context.section,'connections');
  state.refreshContext();render();assert.equal(state.context.connectionId,undefined);state.restoreContext();render();assert.equal(state.context.connectionId,'two');assert.equal(state.pinned,false);
});
await check('unsaved connection context has a removable name and no fabricated saved identity or secrets',()=>{
  const captured=client.captureAskSparkContext({...client.connectionAskSparkContext(undefined,'New MQTT subscriber','mappings',true),password:'private',sourceSettings:{token:'private'}});
  assert.equal(captured.connectionId,undefined);assert.equal(captured.connectionName,'New MQTT subscriber');assert.equal(captured.connectionSection,'mappings');assert.equal(captured.connectionHasUnsavedChanges,true);assert.equal(captured.password,undefined);assert.equal(captured.sourceSettings,undefined);
  const chip=client.contextChips(captured).find(chip=>chip.key==='connection');assert.match(chip.label,/New MQTT subscriber.*unsaved/);assert.ok(chip.remove.includes('connectionHasUnsavedChanges'));
});
await check('provider freezes submitted context and executes registered draft commands with undo receipts', async()=>{
  const requests=[],executed=[];let undo=0,selected=['original'];
  await beginProvider(async(path,method,body)=>{requests.push({path,method,body});if(path.endsWith('/status'))return status;if(body?.message)return{conversationId:'c1',continuationToken:'next',toolCalls:[{id:'call1',name:'draft_edit',arguments:{text:'new'},kind:'write',authorized:true}]};return{conversationId:'c1',reply:'Updated draft.'}});
  state.registerContext('designer',()=>({surface:'designer',projectId:'one',selectedComponentIds:selected,snapshotToken:'snap'}));state.registerExecutor({id:'designer',supports:name=>name==='draft_edit',execute:async(name,args,context)=>{executed.push({name,args,context});selected=['later'];return{result:{changed:1},summary:'Changed label',undo:()=>{undo++}}}});
  state.setDraft('Change this label');render();await state.send();render();assert.equal(executed.length,1);assert.deepEqual(executed[0].context.selectedComponentIds,['original']);assert.deepEqual(requests.find(item=>item.body?.toolResults).body.context.selectedComponentIds,['original']);assert.equal(state.messages.at(-1).text,'Updated draft.');assert.equal(state.actions[0].canUndo,true);await state.undo('call1');render();assert.equal(undo,1);assert.equal(state.actions[0].status,'undone');
});
await check('approval pauses exact proposed operation and declining never invokes its executor', async()=>{
  let executed=0;const requests=[];
  await beginProvider(async(path,method,body)=>{requests.push({path,method,body});if(path.endsWith('/status'))return status;if(path.endsWith('/confirm'))return{approved:false,toolCalls:[]};if(body?.message)return{conversationId:'review',continuationToken:'next',toolCalls:[{id:'review1',name:'delete_resource',arguments:{id:'exact-target'},kind:'destructive',confirmation:true,approvalToken:'one-use',authorized:false}]};return{conversationId:'review',reply:'Cancelled.'}});
  state.registerExecutor({id:'test',supports:()=>true,execute:async()=>{executed++;return{result:{}}}});state.setDraft('Delete it');render();const pending=state.send();await tick();render();assert.equal(executed,0);assert.equal(state.approval.arguments.id,'exact-target');state.approve(false);await pending;render();assert.equal(executed,0);assert.equal(requests.find(item=>item.path.endsWith('/confirm')).body.approved,false);assert.match(requests.find(item=>item.body?.toolResults).body.toolResults[0].result.error,/declined/);
});
await check('non-confirmation tool calls still require server authorization', async()=>{
  let executed=0;await beginProvider(async(path,_method,body)=>path.endsWith('/status')?status:body?.message?{conversationId:'denied',continuationToken:'next',toolCalls:[{id:'x',name:'edit',arguments:{},kind:'write',authorized:false}]}:{conversationId:'denied',reply:'Denied.'});
  state.registerExecutor({id:'test',supports:()=>true,execute:async()=>{executed++;return{result:{}}}});state.setDraft('Edit');render();await state.send();render();assert.equal(executed,0);assert.match(state.actions[0].summary,/did not authorize/);
});
await check('an account switch never writes the previous account draft into the new account storage', async()=>{
  await beginProvider(async()=>status);state.setDraft('private account one draft');render();hooks.flush();assert.equal(client.readAskSparkSession(client.askSparkStorageKey('test-one','engineering')).draft,'private account one draft');
  auth.setAuth({user:{id:'test-two'},audience:'engineering',epoch:2});render();assert.equal(state.draft,'');assert.deepEqual(state.messages,[]);hooks.flush();await tick();render();hooks.flush();render();assert.equal(state.draft,'');assert.equal(client.readAskSparkSession(client.askSparkStorageKey('test-two','engineering')).draft,'');assert.equal(storage.has(client.askSparkStorageKey('test-one','engineering')),false);
});
await check('stop while awaiting approval cannot execute or confirm the pending tool', async()=>{
  let executed=0,confirmed=0;await beginProvider(async(path,_method,body)=>{if(path.endsWith('/status'))return status;if(path.endsWith('/confirm')){confirmed++;return{approved:true,toolCalls:[]}}return{conversationId:'stop',continuationToken:'next',toolCalls:[{id:'stop1',name:'write',arguments:{},kind:'write',confirmation:true,approvalToken:'token'}]}});
  state.registerExecutor({id:'test',supports:()=>true,execute:async()=>{executed++;return{result:{}}}});state.setDraft('Write');render();const pending=state.send();await tick();render();assert.ok(state.approval);state.stop();await pending;render();assert.equal(executed,0);assert.equal(confirmed,0);assert.equal(state.busy,false);
});
await check('the final answer after one hundred tool rounds is consumed without extra tool execution',async()=>{
  let turns=0,executions=0;await beginProvider(async(path)=>{if(path.endsWith('/status'))return status;turns++;return turns<=100?{conversationId:'long',continuationToken:`step${turns}`,toolCalls:[{id:`tool${turns}`,name:'read',arguments:{},kind:'read',parallelSafe:true,authorized:true}]}:{conversationId:'long',reply:'All one hundred rounds are complete.'}});
  state.registerExecutor({id:'test',supports:()=>true,execute:async()=>{executions++;return{result:{}}}});state.setDraft('Do the complete investigation');render();await state.send();render();assert.equal(turns,101);assert.equal(executions,100);assert.equal(state.messages.at(-1).text,'All one hundred rounds are complete.');assert.equal(state.error,'');
});
await check('an additional tool round after the limit is never executed',async()=>{
  let turns=0,executions=0;await beginProvider(async(path)=>path.endsWith('/status')?status:{conversationId:'limit',continuationToken:'next',toolCalls:[{id:`tool${++turns}`,name:'read',arguments:{},kind:'read',authorized:true}]});
  state.registerExecutor({id:'test',supports:()=>true,execute:async()=>{executions++;return{result:{}}}});state.setDraft('Continue');render();await state.send();render();assert.equal(turns,1001);assert.equal(executions,1000);assert.match(state.error,/tool-step limit/);
});
await check('deleting the active conversation clears it only after confirmed gateway success',async()=>{
  let complete;const deletion=new Promise(resolve=>{complete=resolve});const calls=[];
  await beginProvider(async(path,method,body)=>{calls.push({path,method,body});if(path.endsWith('/status'))return status;if(method==='DELETE')return deletion;if(path.endsWith('/conversations'))return{conversations:[{id:'active',title:'Active'},{id:'other',title:'Other'}]};return{conversationId:'active',reply:'Saved reply'}});
  state.setDraft('Start');render();await state.send();await state.loadHistory();render();const pending=state.deleteConversation('active');render();assert.equal(state.messages.length,2);assert.equal(state.conversations.length,2);complete(null);assert.equal(await pending,true);render();assert.deepEqual(state.messages,[]);assert.deepEqual(state.conversations.map(item=>item.id),['other']);assert.equal(calls.find(item=>item.method==='DELETE').path,'/ask-spark/conversations/active');assert.equal(client.readAskSparkSession(client.askSparkStorageKey('test-one','engineering')).conversationId,undefined);
});
await check('failed conversation deletion preserves the active conversation and its messages',async()=>{
  await beginProvider(async(path,method)=>{if(path.endsWith('/status'))return status;if(method==='DELETE')throw new Error('Deletion failed');return{conversationId:'keep',reply:'Keep this message'}});state.setDraft('Start');render();await state.send();render();assert.equal(await state.deleteConversation('keep'),false);render();assert.equal(state.messages.at(-1).text,'Keep this message');assert.match(state.error,/Deletion failed/);
});
await check('an image-only draft sends a neutral description request only after explicit send',async()=>{
  const calls=[];globalThis.Image=class{naturalWidth=2;naturalHeight=2;set src(_value){queueMicrotask(()=>this.onload())}};
  globalThis.FileReader=class{readAsDataURL(blob){blob.arrayBuffer().then(data=>{this.result=`data:${blob.type};base64,${Buffer.from(data).toString('base64')}`;this.onload()})}};
  await beginProvider(async(path,method,body)=>{calls.push({path,method,body});return path.endsWith('/status')?status:{conversationId:'image',reply:'An image.'}});
  await state.addImages([new File([Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0])],'pasted.png',{type:'image/png'})]);render();assert.equal(calls.filter(item=>item.body?.images).length,0);assert.equal(state.draft,'');assert.equal(state.images.length,1);await state.send();render();const sent=calls.find(item=>item.body?.images);assert.equal(sent.body.message,'Describe the attached image(s).');assert.equal(sent.body.images[0].name,'pasted.png');assert.equal(sent.body.images[0].mimeType,'image/png');assert.ok(sent.body.images[0].data);assert.equal(state.images.length,0);
});

await check('sent images remain crop sources until the conversation changes, without browser persistence',async()=>{
  let sourceId, phase=0;const requests=[];
  await beginProvider(async(path,method,body)=>{requests.push({path,method,body});if(path.endsWith('/status'))return status;if(body?.images?.length){sourceId=body.images[0].id;return{conversationId:'retained',reply:'Image ready.'}}if(body?.message&&phase++===0)return{conversationId:'retained',continuationToken:'next',toolCalls:[{id:'crop',name:'spark_designer_crop_image_assets',arguments:{crops:[{sourceImageId:sourceId,name:'tile',box:{x:0,y:0,width:1,height:1}}]},kind:'write',authorized:true}]};return{conversationId:'retained',reply:'Crop complete.'}});
  state.registerContext('designer',()=>({projectId:'one',editorAvailable:true}));
  await state.addImages([new File([Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0])],'grid.png',{type:'image/png'})]);render();await state.send();render();
  state.setDraft('Crop the tile');render();await state.send();render();assert.equal(requests.find(item=>item.body?.toolResults).body.toolResults[0].result.created[0].sourceImageId,sourceId);
  assert.ok(requests.find(item=>item.body?.message==='Crop the tile').body.context.availableImageIds.includes(sourceId));assert.equal([...storage.values()].some(value=>value.includes('iVBOR')),false);
  const bank=new retained.AskSparkRetainedImages();bank.add([{id:'a',data:'abc'}]);assert.equal(bank.get('a').data,'abc');bank.clear();assert.throws(()=>bank.get('a'),/Paste it again/);assert.throws(()=>bank.add(Array.from({length:13},(_,i)=>({id:String(i),data:'x'}))),/limit/);
});
await check('trusted batch metadata is local only and resource refresh completes before the next tool',async()=>{
  const executions=[],events=[],requests=[];await beginProvider(async(path,_method,body)=>{requests.push(body);if(path.endsWith('/status'))return status;return body?.message?{conversationId:'batch',continuationToken:'next',toolCalls:[{id:'one',name:'queries_save',kind:'write',arguments:{},authorized:true},{id:'two',name:'edit',kind:'write',arguments:{},authorized:true}]}:{conversationId:'batch',reply:'Done'}});
  state.registerContext('designer',()=>({projectId:'one'}));state.registerMutationListener('designer',async event=>{await tick();events.push(event.name)});
  state.registerExecutor({id:'test',supports:()=>true,execute:async(name,_args,context)=>{executions.push(context);if(name==='edit')assert.deepEqual(events,['queries_save']);return{result:{saved:true}}}});
  state.setDraft('Save query, then bind');render();await state.send();assert.equal(executions[0].executionBatchId,executions[1].executionBatchId);assert.deepEqual(executions.map(value=>value.executionBatchIndex),[0,1]);assert.equal(requests.find(value=>value?.toolResults).context.executionBatchId,undefined);
});
await check('project opening continues the same message with the destination Designer context',async()=>{
  const requests=[];await beginProvider(async(path,_method,body)=>{requests.push(body);if(path.endsWith('/status'))return status;return body?.message?{conversationId:'opening',continuationToken:'move',toolCalls:[{id:'open',name:'spark_open_project',arguments:{projectId:'project-b'},kind:'read',authorized:true}]}:{conversationId:'opening',reply:'Opened project B.'}});
  state.registerContext('gateway',()=>({surface:'gateway',editorAvailable:false}));const dispose=navigation.registerAskSparkProjectNavigation(projectId=>state.registerContext('designer',()=>({surface:'designer',editorAvailable:true,projectId,documentId:'home',documentKind:'screen',snapshotToken:'fresh'})));
  state.setDraft('Open project B and continue');render();await state.send();render();dispose();const receipt=requests.find(value=>value?.toolResults);assert.equal(receipt.context.projectId,'project-b');assert.equal(receipt.toolResults[0].result.opened,true);assert.equal(state.messages.at(-1).text,'Opened project B.');assert.equal(state.messages[0].context.surface,'gateway');assert.equal(state.messages[0].context.projectId,undefined);
});
await check('project navigation refuses unsaved work and cancellation cannot report a ready Designer',async()=>{
  let navigated=0;const dispose=navigation.registerAskSparkProjectNavigation(()=>{navigated++});
  await assert.rejects(navigation.openAskSparkProject('new-project',()=>({projectId:'old',unsavedChanges:true}),new AbortController().signal),/Nothing was discarded/);assert.equal(navigated,0);
  const abort=new AbortController();abort.abort();await assert.rejects(navigation.openAskSparkProject('new-project',()=>({}),abort.signal));assert.equal(navigated,0);dispose();
});
await check('project permission refresh preserves the conversation but a principal change clears it',async()=>{
  await beginProvider(async(path)=>path.endsWith('/status')?status:{conversationId:'stable',reply:'Keep this conversation'});
  auth.setAuth({user:{id:'test-one'},audience:'engineering',epoch:1,identityEpoch:1});render();hooks.flush();state.setDraft('Hello');render();await state.send();render();
  auth.setAuth({user:{id:'test-one'},audience:'engineering',epoch:2,identityEpoch:1});render();hooks.flush();render();assert.equal(state.messages.at(-1).text,'Keep this conversation');
  auth.setAuth({user:{id:'test-two'},audience:'engineering',epoch:3,identityEpoch:2});render();assert.deepEqual(state.messages,[]);hooks.flush();await tick();render();assert.deepEqual(state.messages,[]);
});
await check('canvas pixels travel as tool images and never expand the JSON observation',async()=>{
  const requests=[];await beginProvider(async(path,_method,body)=>{requests.push(body);if(path.endsWith('/status'))return status;return body?.message?{conversationId:'capture',continuationToken:'next',toolCalls:[{id:'frame',name:'spark_designer_capture_canvas',kind:'read',arguments:{},authorized:true}]}:{conversationId:'capture',reply:'The labels fit.'}});
  const image={mimeType:'image/png',data:'synthetic-test-pixels',name:'Canvas.png'};
  state.registerExecutor({id:'designer',supports:()=>true,execute:async()=>({result:{width:320,height:180,snapshotToken:'current'},images:[image]})});
  state.setDraft('Check the rendered canvas');render();await state.send();
  const result=requests.find(value=>value?.toolResults).toolResults[0];assert.deepEqual(result.images,[image]);assert.equal(result.result.width,320);assert.equal(JSON.stringify(result.result).includes(image.data),false);
});
await check('refresh errors report the completed mutation without retrying it',async()=>{
  let writes=0;const requests=[];await beginProvider(async(path,_method,body)=>{requests.push(body);if(path.endsWith('/status'))return status;return body?.message?{conversationId:'refresh',continuationToken:'next',toolCalls:[{id:'saved',name:'scripts_save',kind:'write',arguments:{},authorized:true}]}:{conversationId:'refresh',reply:'Saved; refresh needs attention.'}});
  state.registerContext('designer',()=>({projectId:'one'}));state.registerMutationListener('designer',async()=>{throw new Error('Resource fetch failed')});
  state.registerExecutor({id:'test',supports:()=>true,execute:async()=>{writes++;return{result:{saved:true}}}});
  state.setDraft('Save the script');render();await state.send();render();const result=requests.find(value=>value?.toolResults).toolResults[0].result;
  assert.equal(writes,1);assert.equal(result.saved,true);assert.match(result.refreshWarning,/Resource fetch failed/);assert.equal(state.actions[0].status,'done');
});

const voiceUrl=loadSource('askSparkVoice.ts',{react:hooksUrl,'./askSparkClient':clientUrl}),{useAskSparkVoice}=await import(voiceUrl);
let recorded=[],stopped=0;const transcripts=[],voiceRequests=[];
class Recorder { static isTypeSupported(){return true} constructor(stream){this.stream=stream;this.mimeType='audio/webm';this.state='inactive';recorded.push(this)}start(){this.state='recording'}stop(){if(this.state==='inactive')return;this.state='inactive';this.ondataavailable?.({data:new Blob(['audio'],{type:this.mimeType})});this.onstop?.()} }
globalThis.MediaRecorder=Recorder;globalThis.FileReader=class{readAsDataURL(blob){blob.arrayBuffer().then(data=>{this.result=`data:${blob.type};base64,${Buffer.from(data).toString('base64')}`;this.onload()})}};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){stopped++}}]})}}});
window.setTimeout=setTimeout;window.clearTimeout=clearTimeout;
let voice;const renderVoice=()=>{hooks.begin();voice=useAskSparkVoice(text=>transcripts.push(text))};
await check('microphone stop transcribes audio into editable text without sending a conversation',async()=>{
  hooks.reset();recorded=[];transcripts.length=0;voiceRequests.length=0;api.setRequest(async(path,_method,body)=>{voiceRequests.push({path,body});return{text:'Draft transcript'}});renderVoice();hooks.flush();await voice.start();renderVoice();assert.equal(voice.phase,'recording');voice.stop();await tick();await tick();renderVoice();assert.deepEqual(transcripts,['Draft transcript']);assert.equal(voiceRequests.length,1);assert.equal(voiceRequests[0].path,'/ask-spark/transcribe');assert.equal(voice.phase,'idle');assert.ok(stopped>0);
});
await check('microphone cancellation releases tracks and never transcribes cancelled audio',async()=>{
  hooks.reset();let calls=0;api.setRequest(async()=>{calls++;return{text:'must not arrive'}});renderVoice();hooks.flush();await voice.start();voice.cancel();await tick();renderVoice();assert.equal(calls,0);assert.equal(voice.phase,'idle');
});
await check('cancelling pending microphone permission releases a subsequently granted stream',async()=>{
  hooks.reset();let grant;const gate=new Promise(resolve=>{grant=resolve});navigator.mediaDevices.getUserMedia=()=>gate;let released=0;renderVoice();hooks.flush();const pending=voice.start();voice.cancel();grant({getTracks:()=>[{stop(){released++}}]});await pending;renderVoice();assert.equal(released,1);assert.equal(voice.phase,'idle');
});
hooks.reset();
const aiContextUrl=moduleFile('const registrations=new Map();const registerContext=(owner,getter,priority)=>{const entry={owner,getter,priority};registrations.set(owner,entry);return()=>{if(registrations.get(owner)===entry)registrations.delete(owner)}};const context={registerContext};export const useAskSpark=()=>context;export const entries=()=>[...registrations.values()];export const snapshot=()=>Object.assign({},...[...registrations.values()].sort((a,b)=>a.priority-b.priority).map(entry=>entry.getter()));');
const aiContext=await import(aiContextUrl);
const aiUrl=loadSource('AISettings.tsx',{react:hooksUrl,'./Auth':authUrl,'./askSparkClient':clientUrl,'./askSparkContext':aiContextUrl}),{default:AISettings}=await import(aiUrl);
const nodes=node=>!node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(3).flatMap(nodes)];
let aiTree;const renderAi=()=>{hooks.begin();aiTree=AISettings()};
await check('AI settings retain an opaque revision and preserve a saved key when the password field is blank',async()=>{
  hooks.reset();auth.setAuth({gatewayAdmin:true});const calls=[],saved={revision:'opaque-revision',enabled:true,hasApiKey:true,model:'gemini-test',parallelLimit:3,modelStepLimit:100,monthlyTokenLimit:0};window.dispatchEvent=()=>{};
  api.setRequest(async(path,method,body)=>{calls.push({path,method,body});return saved});renderAi();hooks.flush();await tick();renderAi();
  const password=nodes(aiTree).find(node=>node.type==='input'&&node.props.type==='password');assert.equal(password.props.value,'');assert.match(password.props.placeholder,/key is saved/);assert.equal(password.props.autoComplete,'new-password');
  nodes(aiTree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();renderAi();const put=calls.find(call=>call.method==='PUT');assert.equal(put.body.revision,'opaque-revision');assert.equal(Object.hasOwn(put.body,'apiKey'),false);assert.equal(Object.hasOwn(put.body,'clearApiKey'),false);
});
await check('AI key entry is sent only in a gateway save and cleared after it completes',async()=>{
  const calls=[],saved={revision:'rev',enabled:true,hasApiKey:true,model:'gemini-test',parallelLimit:3,modelStepLimit:100,monthlyTokenLimit:0};api.setRequest(async(path,method,body)=>{calls.push({path,method,body});return saved});
  nodes(aiTree).find(node=>node.type==='input'&&node.props.type==='password').props.onChange({target:{value:'test-key-not-a-real-secret'}});renderAi();nodes(aiTree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();renderAi();assert.equal(calls.length,1);assert.equal(calls[0].path,'/gateway/ai');assert.equal(calls[0].body.apiKey,'test-key-not-a-real-secret');assert.equal(nodes(aiTree).find(node=>node.type==='input'&&node.props.type==='password').props.value,'');
});
await check('AI model steps default to 100 and both allowance controls validate before saving',async()=>{
  const calls=[];api.setRequest(async(path,method,body)=>{calls.push({path,method,body});return{...body,hasApiKey:true}});
  const inputFor=label=>nodes(nodes(aiTree).find(node=>node.type==='label'&&node.props.children[0]===label)).find(node=>node.type==='input');
  assert.equal(inputFor('Model steps per message').props.value,100);
  for(const value of [0,1001,1.5]) {inputFor('Model steps per message').props.onChange({target:{value:String(value)}});renderAi();nodes(aiTree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();renderAi();assert.equal(calls.length,0);}
  inputFor('Model steps per message').props.onChange({target:{value:'65'}});renderAi();
  inputFor('Monthly AI token allowance').props.onChange({target:{value:'-1'}});renderAi();nodes(aiTree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();renderAi();assert.equal(calls.length,0);
  inputFor('Monthly AI token allowance').props.onChange({target:{value:'100000'}});renderAi();nodes(aiTree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();renderAi();assert.equal(calls.length,1);assert.equal(calls[0].body.modelStepLimit,65);assert.equal(calls[0].body.monthlyTokenLimit,100000);
});
hooks.reset();
await check('pasted AI keys discard surrounding whitespace without changing the key',async()=>{
  const calls=[],saved={revision:'rev',enabled:true,hasApiKey:true,model:'gemini-test',parallelLimit:3,modelStepLimit:100,monthlyTokenLimit:0};auth.setAuth({gatewayAdmin:true});api.setRequest(async(path,method,body)=>{calls.push({path,method,body});return saved});renderAi();hooks.flush();await tick();renderAi();calls.length=0;
  const key='AQ.synthetic_pasted-key';nodes(aiTree).find(node=>node.type==='input'&&node.props.type==='password').props.onChange({target:{value:` \t\r\n\u00a0${key}\r\n `}});renderAi();
  nodes(aiTree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();renderAi();assert.equal(calls.length,1);assert.equal(calls[0].body.apiKey,key);assert.equal(nodes(aiTree).find(node=>node.type==='input'&&node.props.type==='password').props.value,'');
});
await check('opaque provider key punctuation is preserved instead of imposing a provider format',async()=>{
  const calls=[],saved={revision:'rev',enabled:true,hasApiKey:true,model:'gemini-test',parallelLimit:3,modelStepLimit:100,monthlyTokenLimit:0};api.setRequest(async(path,method,body)=>{calls.push({path,method,body});return saved});
  for(const key of ['AQ.synthetic.dotted-key', 'synthetic:opaque/+key==', 'S'.repeat(512)]) {
    nodes(aiTree).find(node=>node.type==='input'&&node.props.type==='password').props.onChange({target:{value:key}});renderAi();
    nodes(aiTree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();renderAi();assert.equal(calls.at(-1).body.apiKey,key);
  }
  assert.equal(calls.length,3);
});
await check('invalid pasted keys remain rejected and editing clears the stale validation error',async()=>{
  let calls=0;api.setRequest(async()=>{calls++;return {}});
  for(const value of [' \t\r\n ', 'first-key second-key', 'first-key\tsecond-key', 'key\u0000', 'key\u007f', 'key\u0080', 'S'.repeat(513)]) {
    nodes(aiTree).find(node=>node.type==='input'&&node.props.type==='password').props.onChange({target:{value}});renderAi();
    nodes(aiTree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();renderAi();assert.equal(calls,0);assert.ok(nodes(aiTree).some(node=>node.props?.role==='alert'));
  }
  nodes(aiTree).find(node=>node.type==='input'&&node.props.type==='password').props.onChange({target:{value:'corrected-synthetic-key'}});renderAi();assert.equal(nodes(aiTree).some(node=>node.props?.role==='alert'),false);
});
hooks.reset();
await check('AI settings block project navigation for unsaved settings, private key entry and removal without exposing values',async()=>{
  auth.setAuth({gatewayAdmin:true});const saved={revision:'guard-revision',enabled:true,hasApiKey:true,model:'gemini-test',parallelLimit:3,modelStepLimit:100,monthlyTokenLimit:0};
  api.setRequest(async(_path,method,body)=>method==='PUT'?{...saved,...body,hasApiKey:!body.clearApiKey,apiKey:undefined}:saved);
  renderAi();hooks.flush();await tick();renderAi();hooks.flush();assert.deepEqual(aiContext.snapshot(),{unsavedChanges:false});
  assert.equal(aiContext.entries().find(entry=>entry.owner==='gateway:ai-settings').priority,20);
  const password=()=>nodes(aiTree).find(node=>node.type==='input'&&node.props.type==='password');
  password().props.onChange({target:{value:'synthetic-private-entry'}});renderAi();hooks.flush();assert.deepEqual(aiContext.snapshot(),{unsavedChanges:true});
  assert.ok(!JSON.stringify(aiContext.snapshot()).includes('synthetic-private-entry'));
  await assert.rejects(navigation.openAskSparkProject('another-project',()=>({surface:'gateway',section:'ai',...aiContext.snapshot()}),new AbortController().signal),/unsaved edits.*Nothing was discarded/);
  password().props.onChange({target:{value:''}});renderAi();hooks.flush();assert.deepEqual(aiContext.snapshot(),{unsavedChanges:false});
  const checkboxes=()=>nodes(aiTree).filter(node=>node.type==='input'&&node.props.type==='checkbox');
  checkboxes()[1].props.onChange({target:{checked:true}});renderAi();hooks.flush();assert.deepEqual(aiContext.snapshot(),{unsavedChanges:true});
  checkboxes()[1].props.onChange({target:{checked:false}});renderAi();hooks.flush();
  checkboxes()[0].props.onChange({target:{checked:false}});renderAi();hooks.flush();assert.deepEqual(aiContext.snapshot(),{unsavedChanges:true});
  nodes(aiTree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});renderAi();hooks.flush();assert.deepEqual(aiContext.snapshot(),{unsavedChanges:true});
  await tick();renderAi();hooks.flush();assert.deepEqual(aiContext.snapshot(),{unsavedChanges:false});
  hooks.reset();assert.deepEqual(aiContext.snapshot(),{});
});
hooks.reset();
const shellReact=moduleFile(`export * from ${JSON.stringify(hooksUrl)};export {useEffect as useLayoutEffect} from ${JSON.stringify(hooksUrl)};`);
const shellContext=moduleFile('export const useAskSpark=()=>globalThis.__shellAskSpark;'),shellPanel=moduleFile('export const AskSparkPanel=()=>null;');
const shellUrl=loadSource('AskSparkShell.tsx',{react:shellReact,'./Auth':authUrl,'./askSparkContext':shellContext,'./AskSpark':shellPanel}),{trapAskSparkFocus,AskSparkShell}=await import(shellUrl);
await check('Properties switching follows the actual Designer workspace rather than a pinned request context',()=>{
  hooks.reset();window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});auth.setAuth({user:{id:'engineer'},audience:'engineering'});
  globalThis.__shellAskSpark={open:true,setOpen(){},context:{surface:'designer',section:'designer'},activeContext:{surface:'designer',section:'connections'}};
  hooks.begin();const connections=AskSparkShell({children:null});assert.equal(nodes(connections).some(node=>node.props?.className==='ask-spark-inspector-switch'),false);
  globalThis.__shellAskSpark.activeContext={surface:'designer',section:'designer'};hooks.begin();const designer=AskSparkShell({children:null});assert.equal(nodes(designer).some(node=>node.props?.className==='ask-spark-inspector-switch'),true);
});
await check('narrow assistant focus wraps in both directions without escaping behind its backdrop',()=>{
  const first={getClientRects:()=>[{}],closest:()=>null,focus(){document.activeElement=this}},last={getClientRects:()=>[{}],closest:()=>null,focus(){document.activeElement=this}};
  globalThis.document={activeElement:last};const container={querySelectorAll:()=>[first,last],contains:item=>[first,last].includes(item)};let prevented=0;
  trapAskSparkFocus({key:'Tab',shiftKey:false,preventDefault(){prevented++}},container);assert.equal(document.activeElement,first);
  trapAskSparkFocus({key:'Tab',shiftKey:true,preventDefault(){prevented++}},container);assert.equal(document.activeElement,last);assert.equal(prevented,2);
});
console.log(`${passed} Ask Spark checks passed.`);
