import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url), moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const hooks = moduleUrl('export const useId=()=>"choice-test"; export const useState=v=>globalThis.__choiceHooks.useState(v); export const useRef=v=>globalThis.__choiceHooks.useRef(v); export const useEffect=(run,deps)=>globalThis.__choiceHooks.useEffect(run,deps);');
const queryHook = moduleUrl('export const useQueryOptions=()=>globalThis.__choiceQuery;');
function loader(fake = false) {
  const cache = new Map();
  return function url(name) {
    if (cache.has(name)) return cache.get(name);
    const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
      .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
      .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_match, prefix, _quote, dependency) => `${prefix}${JSON.stringify(fake && ['ListTreeInput','Components'].includes(name) && dependency === 'react' ? hooks : fake && name === 'ListTreeInput' && dependency === './useQueryOptions' ? queryHook : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
    const result = moduleUrl(code); cache.set(name, result); return result;
  };
}
const real = loader(), fake = loader(true);
const { validateListTreeOptions, visibleTreeOptions, treeAncestors } = await import(real('listTreeModel'));
const { queryOptions, loadQueryOptions, querySelectionChanges } = await import(real('queryOptions'));
const { initialInput, validateInputs, isInput } = await import(real('inputs'));
const { InputEventLifecycle } = await import(real('inputEvents'));
const { ChoiceCollection, default: ListTreeInput } = await import(fake('ListTreeInput'));
const { ComponentView } = await import(fake('Components'));
const { default: BoundComponent } = await import(real('BoundComponent'));
const options = [{ value: 'plant', label: 'Plant' }, { value: 'press', label: 'Press', parentValue: 'plant' }, { value: 'line', label: 'Line', parentValue: 'plant' }, { value: 'store', label: 'Store' }];
const listOptions = options.map(({value,label}) => ({value,label}));
const component = (type = 'treeView', props = {}) => ({ id: 'choice', type, x: 0, y: 0, width: 300, height: 240, props: { fieldKey: 'choice', text: 'Choose asset', options: type === 'list' ? listOptions : options, ...props } });
const form = components => ({ id: 'form', name: 'Form', width: 800, height: 600, components });
const source = { queryId: 'assets', valueColumn: 'id', labelColumn: 'name', parentColumn: 'parent' };
const result = rows => ({ columns: ['id','name','parent','quantity'], rows, durationMs: 1 });
const rows = [{ id: 1, name: 'Plant', parent: null, quantity: 5 }, { id: 'press', name: 'Press', parent: 1, quantity: 7 }];
const descendants = (node, predicate) => !node || typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...React.Children.toArray(node.props?.children).flatMap(child => descendants(child, predicate))];
function harness() {
  const values = [], effects = [], pending = []; let cursor = 0;
  const context = {
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return values[i] ??= { current: initial }; },
    useEffect(run,deps) { const i = cursor++, before = effects[i]; if (!before || deps.some((value,index) => value !== before.deps[index])) pending.push(() => { before?.cleanup?.(); effects[i] = {deps, cleanup:run()}; }); },
  };
  return { run(render) { cursor = 0; globalThis.__choiceHooks = context; return render(); }, commit() { while(pending.length) pending.shift()(); }, stop() { effects.forEach(effect => effect?.cleanup?.()); } };
}
const props = (changes = {}) => ({ component: component(), components: [component()], label: 'Choose asset', value: 'plant', inputs: { choice: 'plant' }, parameters: {}, queryScope: 'runtime', communicationLost: false, disabled: false, tabIndex: 0, onChange() {}, options, error: '', loading: false, contextKey: 'source:a', onChoose() {}, ...changes });
const collection = node => descendants(node, item => item.props.role === 'tree' || item.props.role === 'listbox')[0];
const items = node => descendants(node, item => item.props.role === 'treeitem' || item.props.role === 'option');
const key = (node, key) => collection(node).props.onKeyDown({key,preventDefault(){},ctrlKey:false,metaKey:false,altKey:false});
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await test('static graph validation preserves ordered exact identities and normalizes empty roots', () => {
  const authored = [{value:'__proto__',label:'Root',parentValue:''},{value:'constructor',label:'Child',parentValue:'__proto__'}], before = structuredClone(authored);
  assert.deepEqual(validateListTreeOptions('treeView', authored), [{value:'__proto__',label:'Root'},{value:'constructor',label:'Child',parentValue:'__proto__'}]);
  assert.deepEqual(authored,before); assert.deepEqual(validateListTreeOptions('list',listOptions),listOptions);
  for (const invalid of [[], null, [{value:'a',label:'A',extra:1}], [{value:' ',label:'A'}], [{value:'a',label:'x'.repeat(201)}], [{value:'a',label:'A'},{value:'a',label:'B'}]]) assert.throws(() => validateListTreeOptions('treeView',invalid));
  assert.throws(() => validateListTreeOptions('list',options), /only tree/);
  assert.throws(() => validateListTreeOptions('treeView',[{value:'a',label:'A',parentValue:null}]));
});
await test('whole trees reject orphans, self parents, cycles and depth beyond sixteen', () => {
  for (const invalid of [[{value:'a',label:'A',parentValue:'missing'}],[{value:'a',label:'A',parentValue:'a'}],[{value:'a',label:'A',parentValue:'b'},{value:'b',label:'B',parentValue:'a'}]]) assert.throws(() => validateListTreeOptions('treeView',invalid));
  const chain = length => Array.from({length},(_,i)=>({value:String(i),label:String(i),...(i?{parentValue:String(i-1)}:{})}));
  assert.equal(validateListTreeOptions('treeView',chain(16).reverse()).length,16); assert.throws(() => validateListTreeOptions('treeView',chain(17)),/16 levels/);
  assert.equal(validateListTreeOptions('list',chain(100).map(({value,label})=>({value,label}))).length,100);
  assert.throws(() => validateListTreeOptions('list',chain(101).map(({value,label})=>({value,label}))));
});
await test('visible hierarchy keeps sibling order and selected ancestor expansion without changing selection', () => {
  const shuffled = [options[2],options[0],options[1],options[3]], validated=validateListTreeOptions('treeView',shuffled);
  assert.deepEqual(visibleTreeOptions(validated,new Set()).map(item=>item.option.value),['plant','store']);
  assert.deepEqual(visibleTreeOptions(validated,new Set(['plant'])).map(item=>[item.option.value,item.depth,item.position,item.siblings]),[['plant',1,1,2],['line',2,1,2],['press',2,2,2],['store',1,2,2]]);
  assert.deepEqual([...treeAncestors(options,'press')],['plant']);
});
await test('query parent values share canonical identity and reject every malformed row set', () => {
  const parsed=queryOptions(result(rows),source); assert.equal(parsed[0].value,'1'); assert.equal(parsed[1].parentValue,'1'); assert.equal(parsed[0].parentValue,undefined);
  assert.equal(queryOptions(result([{id:'a',name:'A',parent:''}]),source)[0].parentValue,undefined);
  for (const invalid of [[...rows,{id:'orphan',name:'Orphan',parent:'missing'}],[{id:'a',name:'A',parent:false}],[{id:'a',name:'A'}],[{id:'a',name:'A',parent:'a'}],[...rows,{id:'1',name:'Duplicate',parent:null}]]) assert.throws(()=>queryOptions(result(invalid),source));
  assert.deepEqual(queryOptions(result([]),source),[]);
  assert.equal(queryOptions(result(Array.from({length:500},(_,i)=>({id:String(i),name:String(i),parent:null}))),source).length,500);
  assert.throws(()=>queryOptions(result(Array.from({length:501},(_,i)=>({id:String(i),name:String(i),parent:null}))),source),/500/);
});
await test('query loader preserves native parameter types and publication and validates hierarchy before returning', async () => {
  const calls=[];
  const parsed=await loadQueryOptions(source,'runtime',{plant:3,ignored:true},async(...args)=>{calls.push(args);return calls.length===1?[{id:'assets',kind:'query',parameters:[{name:'plant'}]}]:result(rows);},'version 2');
  assert.equal(parsed[1].parentValue,'1'); assert.equal(calls[0][0],'/runtime/queries?publishedAt=version%202'); assert.deepEqual(calls[1][2],{parameters:{plant:3},publishedAt:'version 2'});
  await assert.rejects(loadQueryOptions(source,'designer',{},async path=>path==='/queries'?[{id:'assets',parameters:[]}]:result([{id:'a',name:'A',parent:'missing'}])),/missing parent/);
});
await test('list and tree values join existing scoped input and membership validation', () => {
  for (const type of ['list','treeView']) {
    const item=component(type); assert.equal(isInput(type),true); assert.equal(initialInput(item,[],{}),'plant');
    assert.equal(initialInput({...item,props:{...item.props,defaultValue:'missing'}},[],{}),null);
    assert.equal(validateInputs(form([item]),{choice:'press'}),null); assert.match(validateInputs(form([item]),{choice:'missing'}),/available options/);
    assert.equal(initialInput({...item,props:{...item.props,optionsSource:type==='treeView'?source:{queryId:'assets',valueColumn:'id',labelColumn:'name'}}},[],{}),null);
  }
  const malformed=component('treeView',{options:[{value:'a',label:'A',parentValue:'missing'}]});
  assert.equal(initialInput(malformed,[],{}),null); assert.match(validateInputs(form([malformed]),{choice:'a'}),/missing parent/);
});
await test('keyboard list focus moves without writes and Enter or Space explicitly selects', () => {
  const h=harness(), changes=[], p=props({component:component('list'),options:listOptions,onChoose:option=>changes.push(option.value)}), render=()=>h.run(()=>ChoiceCollection(p));
  let tree=render(); assert.equal(collection(tree).props.role,'listbox'); key(tree,'ArrowDown'); tree=render(); assert.deepEqual(changes,[]);
  key(tree,'Enter'); assert.deepEqual(changes,['press']); key(render(),'End'); key(render(),' '); assert.deepEqual(changes,['press','store']);
  key(render(),'Home'); key(render(),'s'); key(render(),'Enter'); assert.equal(changes.at(-1),'store');
});
await test('tree arrows expand, traverse and collapse independently from selectable branch values', () => {
  const h=harness(), changes=[], p=props({onChoose:option=>changes.push(option.value)}),render=()=>h.run(()=>ChoiceCollection(p));
  assert.deepEqual(items(render()).map(item=>item.props['aria-level']),[1,1]);
  key(render(),'ArrowRight'); assert.equal(items(render()).length,4); assert.deepEqual(changes,[]);
  key(render(),'ArrowRight'); key(render(),'Enter'); assert.equal(changes.at(-1),'press');
  key(render(),'ArrowLeft'); key(render(),' '); assert.equal(changes.at(-1),'plant'); key(render(),'ArrowLeft'); assert.equal(items(render()).length,2);
});
await test('initial child selection is visible and graph/context changes discard obsolete keyboard state', () => {
  const h=harness(), p=props({value:'press'}),render=()=>h.run(()=>ChoiceCollection(p));
  assert.equal(items(render()).length,4); key(render(),'End'); assert.match(collection(render()).props['aria-activedescendant'],/node-3$/);
  p.contextKey='source:b'; p.value='plant'; assert.equal(items(render()).length,2); assert.match(collection(render()).props['aria-activedescendant'],/node-0$/);
});
await test('disabled, unavailable and loading sets reject clicks and keys without fabricating form edits', () => {
  for (const patch of [{disabled:true},{loading:true},{error:'Malformed tree'}]) {
    const h=harness(), p=props({...patch,onChoose:()=>assert.fail('unavailable selection')}),tree=h.run(()=>ChoiceCollection(p));
    assert.equal(collection(tree).props.tabIndex,-1); key(tree,'Enter'); items(tree)[0].props.onClick();
  }
  const h=harness(), p=props({value:'missing'}),tree=h.run(()=>ChoiceCollection(p)); assert.equal(collection(tree).props['aria-invalid'],true);
  assert.ok(descendants(tree,node=>node.props.role==='status').some(node=>node.props.children==='Selection no longer available'));
});
await test('query selections validate all mapped fields before applying any edits and can recover after a bad row', () => {
  const amount={id:'amount',type:'numberInput',x:0,y:0,width:100,height:40,props:{fieldKey:'amount',min:0,max:10,defaultValue:0}};
  const selected=component('treeView',{optionsSource:source,selectionFields:{amount:'quantity'}}),writes=[],p=props({component:selected,components:[selected,amount],onMappedChange:(...args)=>writes.push(args),onChange:value=>writes.push(['choice',value])});
  const h=harness(); globalThis.__choiceQuery={key:'query',options:queryOptions(result([...rows,{id:'bad',name:'Bad',parent:null,quantity:99}]),source),loading:false,error:'',refresh:async()=>null};
  const render=()=>h.run(()=>{const element=ListTreeInput(p);return element.type(element.props);});
  render().props.onChoose(globalThis.__choiceQuery.options[2]); assert.deepEqual(writes,[]); assert.equal(render().props.blocked,false);
  render().props.onChoose(globalThis.__choiceQuery.options[1]); assert.deepEqual(writes,[['amount',7],['choice','press']]);
  assert.throws(()=>querySelectionChanges(globalThis.__choiceQuery.options[1],{...selected,props:{...selected.props,selectionFields:{choice:'name'}}},[selected]),/cannot also/);
});
await test('explicit query reload expires on form edits or unmount and never auto-applies refreshed rows', async () => {
  const amount={id:'amount',type:'numberInput',x:0,y:0,width:100,height:40,props:{fieldKey:'amount',defaultValue:0}},selected=component('treeView',{optionsSource:source,selectionFields:{amount:'quantity'}}),writes=[];
  const p=props({component:selected,components:[selected,amount],value:'press',inputs:{choice:'press',amount:1},onMappedChange:(...args)=>writes.push(args),onChange:value=>writes.push(['choice',value])});
  let resolve; const h=harness(); globalThis.__choiceQuery={key:'query',options:queryOptions(result(rows),source),loading:false,error:'',refresh:()=>new Promise(done=>{resolve=done;})};
  const render=()=>h.run(()=>{const element=ListTreeInput(p);return element.type(element.props);});
  let element=render(); h.commit(); const pending=element.props.onReload(); p.inputs={choice:'press',amount:9}; render(); resolve(globalThis.__choiceQuery.options); await pending; assert.deepEqual(writes,[]);
  element=render(); const unmounted=element.props.onReload(); h.stop(); resolve(globalThis.__choiceQuery.options); await unmounted; assert.deepEqual(writes,[]);
});
await test('component callbacks emit same-scope change and commit, with lifecycle deduplication', async () => {
  for (const type of ['list','treeView']) {
    const item=component(type,{events:{change:{language:'javascript',code:'change'},commit:{language:'javascript',code:'commit'}}}),events=[],h=harness();
    const lifecycle=new InputEventLifecycle((_script,event)=>events.push(event)); lifecycle.setContext({key:type,component:item,components:[item],inputs:{choice:'plant'},parameters:{},setInput(){},notify(){},error:assert.fail},'plant'); lifecycle.activate();
    const tree=h.run(()=>ComponentView({component:item,tags:[],parameters:{},preview:true,inputs:{choice:'plant'},onNavigate(){},onInputChange:(_field,value)=>lifecycle.change(value),onInputCommit:(_field,value)=>lifecycle.commit(value)}));
    tree.props.onChange('press'); tree.props.onChange('press'); await lifecycle.whenIdle(); assert.deepEqual(events.map(event=>event.type),['change','commit']); lifecycle.deactivate();
  }
});
await test('actual SSR exposes tree/list semantics and explicit loading instead of stale query options', () => {
  for (const type of ['list','treeView']) {
    const item=component(type), rendered=renderToStaticMarkup(React.createElement(BoundComponent,{component:item,components:[item],tags:[],parameters:{},inputs:{choice:'press'},preview:true,onNavigate(){}}));
    assert.match(rendered,new RegExp(`role="${type==='list'?'listbox':'tree'}"`)); assert.match(rendered,/aria-selected="true"/);
    const query={...item,props:{...item.props,optionsSource:type==='treeView'?source:{queryId:'assets',valueColumn:'id',labelColumn:'name'}}};
    const loading=renderToStaticMarkup(React.createElement(BoundComponent,{component:query,components:[query],tags:[],parameters:{},inputs:{choice:'press'},preview:true,onNavigate(){}}));
    assert.match(loading,/Loading options/); assert.match(loading,/aria-disabled="true"/); assert.doesNotMatch(loading,/role="(?:treeitem|option)"/);
  }
});

delete globalThis.__choiceHooks; delete globalThis.__choiceQuery;
console.log(`${passed} list/tree model and renderer checks passed.`);
