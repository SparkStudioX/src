import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import React from 'react';
import ts from 'typescript';

const require=createRequire(import.meta.url),modules=new Map(),encoded=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const hooks=encoded('export const useState=v=>globalThis.__batchHooks.useState(v);export const useEffect=(f,d)=>globalThis.__batchHooks.useEffect(f,d);export const useRef=v=>globalThis.__batchHooks.useRef(v);');
function load(name){
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');if(modules.has(name))return modules.get(name);const file=['tsx','ts'].map(ext=>new URL(`src/${name}.${ext}`,import.meta.url)).find(file=>fs.existsSync(file));const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText.replace(/(from\s+)(["'])([^"']+)\2/g,(_a,p,_q,d)=>`${p}${JSON.stringify(d==='react'?hooks:d.startsWith('./')?load(d.slice(2)):pathToFileURL(require.resolve(d)).href)}`);const url=encoded(code);modules.set(name,url);return url;}
const {TableBatchEditor}=await import(load('TableBatchEditor'));
const nodes=node=>!node||typeof node!=='object'?[]:[node,...React.Children.toArray(node.props?.children).flatMap(nodes)];
const text=node=>typeof node==='string'?node:React.Children.toArray(node?.props?.children).map(text).join('');
function harness(changes={}){
  let values=[],effects=[],cursor=0,pending=[];const saves=[],closed=[];
  const result={columns:['id','version','quantity','name','enabled'],rows:[{id:1,version:3,quantity:10,name:'One',enabled:true},{id:'1',version:4,quantity:20,name:'Two',enabled:null}],durationMs:0};
  const p={snapshot:result,current:structuredClone(result),keys:[1,'1'],rowKey:'id',definition:{versionColumn:'version',batch:{table:'records'},columns:[{key:'quantity',type:'number',min:0,max:100,integer:true},{key:'name',type:'string',required:true,maxLength:8},{key:'enabled',type:'boolean'}]},onApply:async intent=>{saves.push(intent);return{success:true};},onClose:reload=>closed.push(reload),...changes};
  const context={useState(initial){const i=cursor++;if(!(i in values))values[i]=typeof initial==='function'?initial():initial;return[values[i],next=>{values[i]=typeof next==='function'?next(values[i]):next;}];},useRef(initial){const i=cursor++;return values[i]??={current:initial};},useEffect(run,deps){const i=cursor++,old=effects[i];if(!old||deps.some((d,n)=>!Object.is(d,old.deps[n])))pending.push(()=>{old?.cleanup?.();effects[i]={deps,cleanup:run()};});}};
  const h={p,saves,closed};h.render=()=>{cursor=0;globalThis.__batchHooks=context;const tree=TableBatchEditor(p);for(const run of pending)run();pending=[];return tree;};
  h.field=label=>{const value=nodes(h.render()).find(node=>node.props?.['aria-label']===label);assert.ok(value,label);return value;};
  h.button=label=>nodes(h.render()).find(node=>node.type==='button'&&text(node)===label);
  h.change=(label,value)=>{h.field(label).props.onChange({target:{value,checked:value}});return h.render();};
  h.flush=async()=>{for(let i=0;i<6;i++){h.render();await Promise.resolve();}return h.render();};h.stop=()=>effects.forEach(effect=>effect?.cleanup?.());return h;
}
let passed=0;async function test(name,run){await run();passed++;console.log('PASS '+name);}
await test('staging typed values does not write until explicit Apply and preserves captured typed keys and versions',async()=>{
  const h=harness();try{assert.equal(h.button('Apply all changes').props.disabled,true);h.change('New quantity for row 1 (number)','0');h.change('New name for row 1 (number)','Changed');h.change('New enabled for row 1 (string)','false');assert.deepEqual(h.saves,[]);assert.equal(h.button('Apply all changes').props.disabled,false);h.button('Apply all changes').props.onClick();await h.flush();assert.deepEqual(h.saves,[{edits:[{key:1,version:3,column:'quantity',value:0},{key:1,version:3,column:'name',value:'Changed'},{key:'1',version:4,column:'enabled',value:false}]}]);assert.deepEqual(h.closed,[true]);}finally{h.stop();}
});
await test('Cancel and native Escape discard all staged cells, keyboard events cannot undo the project behind the dialog',async()=>{
  for(const escape of [false,true]){const h=harness();try{h.change('New quantity for row 1 (number)','7');let stopped=false;h.render().props.onKeyDown({key:'z',ctrlKey:true,stopPropagation(){stopped=true;}});assert.equal(stopped,true);if(escape){let prevented=false;h.render().props.onCancel({preventDefault(){prevented=true;}});assert.equal(prevented,true);}else h.button('Cancel').props.onClick();assert.deepEqual(h.saves,[]);assert.deepEqual(h.closed,[false]);}finally{h.stop();}}
});
await test('every included cell is validated before any submission; excluded values do not silently join the batch',async()=>{
  const h=harness();try{for(const value of ['','-1','101','1.5','0x10','NaN']){h.change('New quantity for row 1 (number)',value);assert.equal(h.button('Apply all changes').props.disabled,true);h.button('Apply all changes').props.onClick();assert.deepEqual(h.saves,[]);}h.change('New quantity for row 1 (number)','7');h.change('New name for row 1 (string)','');assert.equal(h.button('Apply all changes').props.disabled,true);h.change('Include name for row 1 (string)',false);assert.equal(h.button('Apply all changes').props.disabled,false);h.button('Apply all changes').props.onClick();await h.flush();assert.equal(h.saves[0].edits.length,1);}finally{h.stop();}
});
await test('changed versions or missing rows make conflicts sticky and never overwrite typed drafts',async()=>{
  for(const missing of [false,true]){const h=harness();try{h.change('New quantity for row 1 (number)','7');if(missing)h.p.current.rows.shift();else h.p.current.rows[0].version++;h.render();assert.equal(h.button('Apply all changes').props.disabled,true);assert.equal(h.field('New quantity for row 1 (number)').props.value,'7');h.p.current=structuredClone(h.p.snapshot);assert.equal(h.button('Apply all changes').props.disabled,true);h.button('Cancel').props.onClick();assert.deepEqual(h.closed,[true]);assert.deepEqual(h.saves,[]);}finally{h.stop();}}
});
await test('offline or read-only sessions cannot apply; callback loss during a pending operation cannot duplicate it',async()=>{
  const h=harness();try{h.change('New quantity for row 1 (number)','7');h.p.unavailable='Communication lost';assert.equal(h.button('Apply all changes').props.disabled,true);h.button('Apply all changes').props.onClick();assert.deepEqual(h.saves,[]);h.p.unavailable=undefined;const callback=h.p.onApply;h.p.onApply=undefined;assert.equal(h.button('Apply all changes').props.disabled,true);h.p.onApply=callback;assert.equal(h.button('Apply all changes').props.disabled,false);}finally{h.stop();}
  let resolve;const calls=[],pending=new Promise(done=>resolve=done),busy=harness({onApply:intent=>{calls.push(intent);return pending;}});try{busy.change('New quantity for row 1 (number)','8');const apply=busy.button('Apply all changes');apply.props.onClick();apply.props.onClick();busy.p.onApply=undefined;assert.equal(busy.button('Cancel').props.disabled,true);assert.equal(calls.length,1);resolve({success:true});await busy.flush();assert.deepEqual(busy.closed,[true]);}finally{busy.stop();}
});
await test('unknown network outcomes require a reload; late completion after unmount cannot close a new context',async()=>{
  const h=harness({onApply:async()=>{throw Error('connection dropped');}});try{h.change('New quantity for row 1 (number)','7');h.button('Apply all changes').props.onClick();await h.flush();assert.equal(h.button('Apply all changes').props.disabled,true);assert.match(text(h.render()),/could not be confirmed/);h.button('Cancel').props.onClick();assert.deepEqual(h.closed,[true]);}finally{h.stop();}
  let resolve;const late=harness({onApply:()=>new Promise(done=>resolve=done)});late.change('New quantity for row 1 (number)','7');late.button('Apply all changes').props.onClick();late.stop();resolve({success:true});await Promise.resolve();await Promise.resolve();assert.deepEqual(late.closed,[]);
});
await test('more than 100 staged cells cannot enter the atomic endpoint',async()=>{
  const rows=Array.from({length:51},(_,index)=>({id:index,version:1,quantity:index,name:'Name'})),result={columns:['id','version','quantity','name'],rows,durationMs:0};const h=harness({snapshot:result,current:structuredClone(result),keys:rows.map(row=>row.id),definition:{versionColumn:'version',batch:{table:'records'},columns:[{key:'quantity',type:'number'},{key:'name',type:'string'}]}});try{for(const row of rows){h.change(`New quantity for row ${row.id} (number)`,'1');h.change(`New name for row ${row.id} (number)`,'New');}assert.equal(h.button('Apply all changes').props.disabled,true);assert.match(text(h.render()),/at most 100 cell changes/);h.button('Apply all changes').props.onClick();assert.deepEqual(h.saves,[]);h.change('Include name for row 0 (number)',false);h.change('Include quantity for row 0 (number)',false);assert.equal(h.button('Apply all changes').props.disabled,false);}finally{h.stop();}
});
console.log(`${passed} atomic table batch editor checks passed.`);
