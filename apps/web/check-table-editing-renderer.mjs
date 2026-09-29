import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

// The real renderer and its validation/formatting models run with a tiny hook
// host. Key changes run cleanup and discard hook slots just as React does.
const require=createRequire(import.meta.url), modules=new Map();
const asModule=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const hooks=asModule('export const useState=v=>globalThis.__editHooks.useState(v); export const useEffect=(run,deps)=>globalThis.__editHooks.useEffect(run,deps); export const useRef=v=>globalThis.__editHooks.useRef(v);');
const api=asModule('export const api=(...args)=>globalThis.__editApi(...args); export const scriptFailureMessage=value=>value;');
function load(name){
  if(modules.has(name))return modules.get(name);
  const file=['tsx','ts'].map(ext=>new URL(`src/${name}.${ext}`,import.meta.url)).find(file=>fs.existsSync(file));
  assert.ok(file,name);
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g,'')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g,(_all,prefix,_quote,dependency)=>`${prefix}${JSON.stringify(name==='QueryTable'&&dependency==='react'?hooks:name==='QueryTable'&&dependency==='./api'?api:dependency.startsWith('./')?load(dependency.slice(2)):pathToFileURL(require.resolve(dependency)).href)}`);
  const url=asModule(code);modules.set(name,url);return url;
}
const {QueryTable}=await import(load('QueryTable'));
const descendants=(node,predicate)=>!node||typeof node!=='object'?[]:[...(predicate(node)?[node]:[]),...React.Children.toArray(node.props?.children).flatMap(child=>descendants(child,predicate))];
const text=node=>node===null||node===undefined?'':typeof node==='string'||typeof node==='number'?String(node):React.Children.toArray(node.props?.children).map(text).join('');
const named=(tree,type,label)=>descendants(tree,node=>node.type===type&&node.props['aria-label']===label)[0];
const button=(tree,label)=>descendants(tree,node=>node.type==='button'&&text(node)===label)[0];
const editor=tree=>descendants(tree,node=>node.props?.className==='table-cell-editor')[0];
const html=tree=>renderToStaticMarkup(tree);
const keyboard=(key,tagName='INPUT',isComposing=false)=>({key,target:{tagName},nativeEvent:{isComposing},stopped:false,prevented:false,stopPropagation(){this.stopped=true;},preventDefault(){this.prevented=true;}});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const success={success:true,stdout:'saved',stderr:'',durationMs:1};
const timers=new Map();let nextTimer=0;
globalThis.window=new EventTarget();
globalThis.setInterval=run=>{const id=++nextTimer;timers.set(id,run);return id;};
globalThis.clearInterval=id=>timers.delete(id);
function harness(changes={}){
  let values=[],effects=[],cursor=0,sessionKey,stopped=false;
  const pending=new Map(),calls=[],saves=[],selections=[];
  const fixture={columns:['id','version','name','quantity','enabled'],rows:[{id:'A',version:1,name:'Alpha',quantity:2,enabled:true},{id:'B',version:3,name:'Beta',quantity:7,enabled:false}],durationMs:1};
  const p={queryId:'records',title:'Production',parameters:{area:'North'},queryScope:'runtime',publishedAt:'v1',pageSize:1,rowKey:'id',
    tableColumns:[{key:'id',visible:false},{key:'version',visible:false},{key:'name',label:'Name'},{key:'quantity',label:'Quantity',format:'number',precision:0},{key:'enabled',label:'Enabled',format:'boolean'}],
    tableEdit:{versionColumn:'version',columns:[{key:'name',type:'string',required:true,maxLength:12},{key:'quantity',type:'number',integer:true,min:0,max:10},{key:'enabled',type:'boolean'}]},
    selectionFields:{selectedName:'name'},components:[{id:'name-input',type:'textInput',props:{fieldKey:'selectedName'}}],onSelect:(...args)=>selections.push(args),
    onTableEdit:async payload=>{saves.push(payload);return success;},...changes};
  const h={p,fixture,calls,saves,selections,queryError:null};
  globalThis.__editApi=async(path,method,body)=>{
    calls.push({path,method,body});
    if(path.endsWith('/execute')){if(h.queryError)throw h.queryError;return structuredClone(h.fixture);}
    return[{id:p.queryId,kind:'query',parameters:[{name:'area'}]}];
  };
  const context={
    useState(initial){const slots=values,i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];},
    useRef(initial){const i=cursor++;if(!(i in values))values[i]={current:initial};return values[i];},
    useEffect(run,deps){const i=cursor++,previous=effects[i];if(!previous||deps.length!==previous.deps.length||deps.some((v,n)=>!Object.is(v,previous.deps[n])))pending.set(i,()=>{previous?.cleanup?.();effects[i]={deps,cleanup:run()};});},
  };
  h.render=()=>{
    assert.equal(stopped,false);
    const element=QueryTable(p);
    if(sessionKey!==element.key){effects.forEach(e=>e?.cleanup?.());values=[];effects=[];pending.clear();sessionKey=element.key;}
    cursor=0;globalThis.__editHooks=context;
    const tree=element.type(element.props);
    for(const run of pending.values())run();pending.clear();
    return tree;
  };
  h.ready=async()=>{for(let i=0;i<8;i++){h.render();await Promise.resolve();}return h.render();};
  h.poll=async()=>{for(const run of [...timers.values()])run();await Promise.resolve();return h.ready();};
  h.edit=(label,key='A')=>{const event=keyboard('');const target=named(h.render(),'button',`Edit ${label} for row ${key}`);assert.ok(target,`Missing Edit ${label}`);assert.equal(target.props.disabled,false);target.props.onClick(event);assert.equal(event.stopped,true);return h.render();};
  h.change=(label,value)=>{const tree=h.render(),target=named(tree,'input',`New ${label}`)||named(tree,'select',`New ${label}`);assert.ok(target);target.props.onChange({target:{value}});return h.render();};
  h.stop=()=>{effects.forEach(e=>e?.cleanup?.());stopped=true;};
  return h;
}
let passed=0;
async function test(name,run){try{await run();passed++;console.log('PASS '+name);}catch(error){console.error('FAIL '+name+'\n'+error.message);process.exit(1);}assert.equal(timers.size,0,'Each test cleans polling subscriptions');}

await test('only operator sessions with an edit callback expose visible cell Edit buttons',async()=>{
  for(const changes of [{onTableEdit:undefined},{queryScope:'designer',tableEdit:{versionColumn:'version',columns:[{key:'name',type:'string'}],script:'pass'}}]){
    const h=harness(changes);try{const tree=await h.ready();assert.equal(descendants(tree,node=>node.props?.className==='table-cell-edit').length,0);assert.match(html(tree),/editing is (unavailable|available in the published)/i);}finally{h.stop();}
  }
  const h=harness({tableColumns:[{key:'name',visible:false},{key:'quantity',label:'Quantity'}]});try{const tree=await h.ready();assert.equal(descendants(tree,node=>node.props?.className==='table-cell-edit').length,1);assert.ok(named(tree,'button','Edit Quantity for row A'));assert.equal(h.saves.length,0);}finally{h.stop();}
});
await test('numeric zero is a typed explicit save and one draft freezes table navigation and row selection',async()=>{
  const h=harness();try{await h.ready();let tree=h.edit('Quantity');tree=h.change('Quantity','0');assert.equal(h.saves.length,0);
    assert.equal(named(tree,'input','Filter Production').props.disabled,true);assert.equal(named(tree,'button','Next page of Production').props.disabled,true);
    assert.ok(descendants(tree,node=>node.props?.className==='table-sort').every(node=>node.props.disabled));
    const refresh=descendants(tree,node=>node.type==='button'&&node.props.title==='Refresh Production')[0];assert.equal(refresh.props.disabled,true);
    named(tree,'input','Filter Production').props.onChange({target:{value:'Beta'}});named(tree,'button','Next page of Production').props.onClick();refresh.props.onClick();
    descendants(tree,node=>node.type==='tr'&&node.props.onClick)[0].props.onClick();assert.deepEqual(h.selections,[]);
    tree=h.render();assert.equal(named(tree,'input','Filter Production').props.value,'');assert.ok(named(tree,'input','New Quantity'));assert.equal(button(tree,'Save').props.disabled,false);
    button(tree,'Save').props.onClick();await h.ready();assert.deepEqual(h.saves,[{key:'A',version:1,column:'quantity',value:0}]);assert.equal(editor(h.render()),undefined);assert.match(html(h.render()),/Saved quantity\./);assert.doesNotMatch(html(h.render()),/Loading current data/);
    assert.ok(h.calls.filter(call=>call.path.endsWith('/execute')).length>=2,'success reloads fresh data');
  }finally{h.stop();}
});
await test('string and Boolean native editors preserve empty text and false without autosave',async()=>{
  for(const [label,key,value,expected] of [['Name','name','',''],['Enabled','enabled','false',false]]){
    const h=harness();h.p.tableEdit.columns[0].required=false;
    try{await h.ready();h.edit(label);let tree=h.change(label,value);assert.equal(h.saves.length,0);assert.equal(button(tree,'Save').props.disabled,false);button(tree,'Save').props.onClick();await h.ready();assert.deepEqual(h.saves,[{key:'A',version:1,column:key,value:expected}]);}finally{h.stop();}
  }
  const h=harness();h.fixture.rows[0].enabled=null;
  try{await h.ready();let tree=h.edit('Enabled');assert.equal(named(tree,'select','New Enabled').props.value,'');assert.equal(button(tree,'Save').props.disabled,true);assert.match(html(tree),/Choose true or false/);tree=h.change('Enabled','false');assert.equal(button(tree,'Save').props.disabled,false);}finally{h.stop();}
});
await test('invalid edits remain local and cannot submit coercions, unsafe numbers or constraint violations',async()=>{
  const h=harness();try{await h.ready();h.edit('Quantity');for(const value of ['','0x10','NaN','Infinity','1.5','-1','11','9007199254740992']){const tree=h.change('Quantity',value);assert.equal(button(tree,'Save').props.disabled,true,value);button(tree,'Save').props.onClick();assert.equal(h.saves.length,0);}
    button(h.render(),'Cancel').props.onClick();h.edit('Name');for(const value of ['','  ','x'.repeat(13)]){const tree=h.change('Name',value);assert.equal(button(tree,'Save').props.disabled,true);}
  }finally{h.stop();}
});
await test('keyboard editing isolates row shortcuts and Cancel cannot turn into Save through Enter bubbling',async()=>{
  const h=harness();try{await h.ready();h.edit('Name');h.change('Name','New name');
    let event=keyboard('Enter','BUTTON');editor(h.render()).props.onKeyDown(event);assert.equal(event.stopped,true);assert.equal(event.prevented,false);assert.equal(h.saves.length,0);
    event=keyboard('Enter','INPUT',true);editor(h.render()).props.onKeyDown(event);assert.equal(h.saves.length,0);
    event=keyboard('Escape');editor(h.render()).props.onKeyDown(event);assert.equal(event.stopped,true);assert.equal(event.prevented,true);assert.equal(editor(h.render()),undefined);assert.equal(h.saves.length,0);
    h.edit('Name');h.change('Name','New name');event=keyboard('Enter');editor(h.render()).props.onKeyDown(event);await h.ready();assert.equal(event.stopped,true);assert.equal(event.prevented,true);assert.equal(h.saves.length,1);assert.equal(h.selections.length,0);
  }finally{h.stop();}
});
await test('busy callback disappearance preserves the pending draft and duplicate saves are ignored',async()=>{
  const pending=deferred(),saves=[];const callback=payload=>{saves.push(payload);return pending.promise;};
  const h=harness({onTableEdit:callback});try{await h.ready();h.edit('Quantity');h.change('Quantity','5');const save=button(h.render(),'Save');save.props.onClick();save.props.onClick();assert.equal(saves.length,1);
    h.p.onTableEdit=undefined;let tree=await h.ready();assert.ok(editor(tree));assert.equal(named(tree,'input','New Quantity').props.value,'5');assert.equal(named(tree,'input','New Quantity').props.disabled,true);assert.equal(button(tree,'Cancel').props.disabled,true);
    const busyStatus=descendants(tree,node=>node.props?.className?.startsWith('table-edit-status')&&text(node).includes('Saving this cell'))[0];assert.ok(busyStatus);assert.equal(busyStatus.props.role,'status');assert.equal(busyStatus.props.className,'table-edit-status');assert.doesNotMatch(html(tree),/Editing is unavailable/);
    named(tree,'input','New Quantity').props.onChange({target:{value:'8'}});assert.equal(named(h.render(),'input','New Quantity').props.value,'5');
    pending.resolve(success);await h.ready();assert.equal(editor(h.render()),undefined);assert.match(html(h.render()),/Saved quantity/);h.p.onTableEdit=callback;
  }finally{h.stop();}
});
await test('polling changed versions retains the draft and snapshot until explicit reload discards it',async()=>{
  const h=harness();try{await h.ready();h.edit('Name');h.change('Name','My draft');h.fixture.rows[0].version=2;h.fixture.rows[0].name='Server name';let tree=await h.poll();
    assert.equal(named(tree,'input','New Name').props.value,'My draft');assert.match(html(tree),/changed while you were editing/);assert.equal(button(tree,'Save').props.disabled,true);assert.doesNotMatch(html(tree),/>Server name</);
    h.fixture.rows[0].version=1;tree=await h.poll();assert.equal(button(tree,'Save').props.disabled,true,'conflict remains sticky even if a later result returns the old version');
    h.fixture.rows[0].version=2;button(tree,'Reload and discard edit').props.onClick();tree=await h.ready();assert.equal(editor(tree),undefined);assert.match(html(tree),/Server name/);assert.equal(h.saves.length,0);
  }finally{h.stop();}
});
await test('missing rows and missing editable values anywhere in a refreshed result block a retained draft',async()=>{
  for(const alter of [h=>{h.fixture.rows.shift();},h=>{delete h.fixture.rows[1].enabled;}]){
    const h=harness();try{await h.ready();h.edit('Quantity');h.change('Quantity','6');alter(h);const tree=await h.poll();assert.equal(named(tree,'input','New Quantity').props.value,'6');assert.equal(button(tree,'Save').props.disabled,true);assert.ok(button(tree,'Reload and discard edit'));assert.equal(h.saves.length,0);}finally{h.stop();}
  }
});
await test('offline and failed query checks preserve draft text and require fresh verification on recovery',async()=>{
  const h=harness();try{await h.ready();h.edit('Name');h.change('Name','My draft');h.p.communicationLost=true;let tree=await h.ready();assert.equal(named(tree,'input','New Name').props.value,'My draft');assert.equal(button(tree,'Save').props.disabled,true);assert.match(html(tree),/Communication lost/);
    h.queryError=new Error('SQL unavailable');h.p.communicationLost=false;tree=await h.ready();assert.equal(named(tree,'input','New Name').props.value,'My draft');assert.equal(button(tree,'Save').props.disabled,true);assert.match(html(tree),/could not be verified/);
    h.queryError=null;tree=await h.poll();assert.equal(button(tree,'Save').props.disabled,false);assert.equal(named(tree,'input','New Name').props.value,'My draft');assert.equal(h.saves.length,0);
  }finally{h.stop();}
});
await test('script failures and unknown network outcomes retain drafts without enabling blind retry',async()=>{
  for(const fail of [async()=>({...success,success:false,stderr:'Version changed in transaction'}),async()=>{throw new Error('connection closed');}]){
    const saves=[],h=harness({onTableEdit:async payload=>{saves.push(payload);return fail();}});
    try{await h.ready();h.edit('Quantity');h.change('Quantity','4');button(h.render(),'Save').props.onClick();let tree=await h.ready();assert.equal(named(tree,'input','New Quantity').props.value,'4');assert.equal(button(tree,'Save').props.disabled,true);assert.match(html(tree),/Reload current data before another attempt/);
      button(tree,'Save').props.onClick();tree=await h.poll();assert.equal(button(tree,'Save').props.disabled,true);assert.equal(saves.length,1);button(tree,'Reload and discard edit').props.onClick();tree=await h.ready();assert.equal(editor(tree),undefined);assert.ok(named(tree,'button','Edit Quantity for row A'));
    }finally{h.stop();}
  }
});
await test('Cancel after an unknown outcome cannot reopen the old result before a fresh query',async()=>{
  const h=harness({onTableEdit:async()=>{throw new Error('response lost');}});
  try{await h.ready();h.edit('Quantity');h.change('Quantity','4');button(h.render(),'Save').props.onClick();await h.ready();
    const before=h.calls.filter(call=>call.path.endsWith('/execute')).length;
    h.fixture.rows[0].version=2;h.fixture.rows[0].quantity=4;
    button(h.render(),'Cancel').props.onClick();let tree=h.render();assert.equal(editor(tree),undefined);assert.equal(named(tree,'button','Edit Quantity for row A'),undefined);assert.match(html(tree),/Loading query/);
    tree=await h.ready();assert.ok(h.calls.filter(call=>call.path.endsWith('/execute')).length>before);h.edit('Quantity');assert.equal(named(h.render(),'input','New Quantity').props.value,'4');
  }finally{h.stop();}
});
await test('invalid keys, versions and editable source fields on off-page rows disable all editing',async()=>{
  for(const alter of [h=>{h.fixture.rows[1].id='A';},h=>{h.fixture.rows[1].version=-1;},h=>{h.fixture.rows[1].version=Number.MAX_SAFE_INTEGER+1;},h=>{delete h.fixture.rows[1].quantity;},h=>{h.fixture.columns=h.fixture.columns.filter(key=>key!=='version');}]){
    const h=harness();try{alter(h);const tree=await h.ready(),editButtons=descendants(tree,node=>node.props?.className==='table-cell-edit');if(!editButtons.length)assert.equal(descendants(tree,node=>node.type==='table').length,0,'invalid visible schema hides the entire table');assert.ok(editButtons.every(node=>node.props.disabled));for(const node of editButtons)node.props.onClick(keyboard(''));assert.equal(editor(h.render()),undefined);assert.equal(h.saves.length,0);assert.match(html(tree),/role="alert"/);}finally{h.stop();}
  }
});
await test('numeric and text keys remain distinct and preserve their native identities in save payloads',async()=>{
  const h=harness();h.fixture.rows[0].id=1;h.fixture.rows[1].id='1';
  try{await h.ready();h.edit('Quantity',1);h.change('Quantity','3');button(h.render(),'Save').props.onClick();await h.ready();assert.equal(h.saves[0].key,1);named(h.render(),'button','Next page of Production').props.onClick();h.edit('Quantity','1');h.change('Quantity','4');button(h.render(),'Save').props.onClick();await h.ready();assert.equal(h.saves[1].key,'1');assert.equal(h.saves[1].version,3);}finally{h.stop();}
});
await test('publication, parameter and query changes discard old context and ignore late save completion',async()=>{
  for(const change of [p=>{p.publishedAt='v2';},p=>{p.parameters={area:'South'};},p=>{p.queryId='other';}]){
    const pending=deferred(),h=harness({onTableEdit:()=>pending.promise});try{await h.ready();h.edit('Name');h.change('Name','Old context');button(h.render(),'Save').props.onClick();change(h.p);let tree=await h.ready();assert.equal(editor(tree),undefined);const before=h.calls.length;pending.resolve(success);tree=await h.ready();assert.equal(editor(tree),undefined);assert.doesNotMatch(html(tree),/Saved name|Old context/);assert.equal(h.calls.length,before,'late completion cannot refresh the replacement context');}finally{h.stop();}
  }
});
await test('unmounting during a save detaches subscriptions and ignores late rejection',async()=>{
  const pending=deferred(),h=harness({onTableEdit:()=>pending.promise});await h.ready();h.edit('Name');button(h.render(),'Save').props.onClick();h.stop();const before=h.calls.length;pending.reject(new Error('late failure'));await Promise.resolve();await Promise.resolve();assert.equal(h.calls.length,before);assert.equal(timers.size,0);
});
console.log(`${passed} inline table editing renderer checks passed.`);
