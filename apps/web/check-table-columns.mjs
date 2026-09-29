import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

const require=createRequire(import.meta.url), modules=new Map();
const asModule=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const hooks=asModule('export const useState=v=>globalThis.__tableHooks.useState(v); export const useEffect=(run,deps)=>globalThis.__tableHooks.useEffect(run,deps); export const useRef=v=>globalThis.__tableHooks.useRef(v);');
const api=asModule('export const api=(...args)=>globalThis.__tableApi(...args); export const scriptFailureMessage=value=>value;');
function load(name){
  if(modules.has(name))return modules.get(name);
  const file=['tsx','ts'].map(ext=>new URL(`src/${name}.${ext}`,import.meta.url)).find(file=>fs.existsSync(file));
  assert.ok(file,name);
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g,'')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g,(_all,prefix,_quote,dependency)=>`${prefix}${JSON.stringify(name==='QueryTable'&&dependency==='react'?hooks:name==='QueryTable'&&dependency==='./api'?api:dependency.startsWith('./')?load(dependency.slice(2)):pathToFileURL(require.resolve(dependency)).href)}`);
  const url=asModule(code);modules.set(name,url);return url;
}
const {validateTableColumns,resolveTableColumns,formatTableCell}=await import(load('tableColumns'));
const {tablePage}=await import(load('tableModel'));
const {resolveTableSelection}=await import(load('tableSelection'));
const {QueryTable}=await import(load('QueryTable'));
const resolve=(config,keys=['id','name','amount','enabled','stamp'])=>resolveTableColumns(config,keys);
const format=(value,props)=>formatTableCell(value,{key:'value',label:'Value',align:'left',format:'auto',...props});
const descendants=(node,predicate)=>!node||typeof node!=='object'?[]:[...(predicate(node)?[node]:[]),...React.Children.toArray(node.props?.children).flatMap(child=>descendants(child,predicate))];
const named=(tree,type,name)=>descendants(tree,node=>node.type===type&&node.props['aria-label']===name)[0];
const text=node=>!node?'':typeof node==='string'||typeof node==='number'?String(node):React.Children.toArray(node.props?.children).map(text).join('');
let passed=0;
async function test(name,run){await run();passed++;console.log('PASS '+name);}

await test('automatic columns retain source ordering and legacy headings',()=>{
  for(const config of [undefined,[]])assert.deepEqual(resolve(config,['recordId','part_name']).columns.map(c=>[c.key,c.label,c.format]),[['recordId','record Id','auto'],['part_name','part name','auto']]);
  assert.equal(format(false,{}).text,'False');assert.equal(format(null,{}).text,'—');
});
await test('explicit columns retain exact keys, order, labels and hidden identity',()=>{
  const config=[{key:'id',visible:false},{key:'amount',label:'Amount (kg)',width:120,align:'right',format:'number',precision:1,suffix:' kg'},{key:'name',label:'Asset'}];
  const before=structuredClone(config),result=resolve(config);
  assert.equal(result.error,null);assert.deepEqual(result.columns.map(c=>c.key),['amount','name']);
  assert.equal(result.columns[0].label,'Amount (kg)');assert.equal(result.columns[0].width,120);assert.deepEqual(config,before);
});
await test('malformed definitions reject coercion, duplicate identities and no visible columns',()=>{
  const invalid=[null,{},'auto',[null],[{}],[{key:''}],[{key:' x'}],[{key:'x\ufeff'}],[{key:'x\n'}],[{key:'x',unknown:1}],[{key:'x'},{key:'x'}],[{key:'x',visible:false}]];
  for(const [key,values] of Object.entries({label:[null,'',' ',false,'x'.repeat(121)],visible:[null,0,'false'],width:[null,'100',39,1201,1.5],align:[null,'justify'],format:[null,'html'],precision:[null,'2',-1,11,2.5],suffix:[null,4,'\n','x'.repeat(33)]}))
    for(const value of values)invalid.push([{key:'x',...(key==='precision'||key==='suffix'?{format:'number'}:{}),[key]:value}]);
  invalid.push([{key:'x',precision:2}],[{key:'x',suffix:''}],Array.from({length:65},(_,i)=>({key:String(i)})));
  for(const config of invalid)assert.ok(validateTableColumns(config),JSON.stringify(config));
  assert.equal(validateTableColumns([{key:'x',width:40,format:'number',precision:0,suffix:''},{key:'X',width:1200,format:'number',precision:10}]),null);
  assert.equal(validateTableColumns(Array.from({length:64},(_,i)=>({key:String(i)}))),null);
});
await test('missing and duplicate query schema produce no partial projection even with no rows',()=>{
  for(const config of [[{key:'missing'}],[{key:'id'},{key:'missing',visible:false}]]){const result=resolve(config);assert.match(result.error,/missing/);assert.deepEqual(result.columns,[]);}
  assert.match(resolve([{key:'id'}],[]).error,/missing/);assert.match(resolve(undefined,['id','id']).error,/unique/);
});
await test('numbers use explicit precision and units without turning nulls or invalid types into zero',()=>{
  assert.equal(format(0,{format:'number',precision:3,suffix:' kg'}).text,'0.000 kg');
  assert.equal(format(12.345,{format:'number',precision:1}).text,'12.3');assert.equal(format(-12.345,{format:'number',precision:1}).text,'-12.3');
  for(const value of ['12.3',true,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){const cell=format(value,{format:'number'});assert.equal(cell.text,'—');assert.ok(cell.error);}
  assert.deepEqual(format(null,{format:'number',suffix:' kg'}),{text:'—'});
});
await test('Boolean formatting preserves false and accepts only native flags or numeric zero/one',()=>{
  for(const value of [false,0])assert.equal(format(value,{format:'boolean'}).text,'False');
  for(const value of [true,1])assert.equal(format(value,{format:'boolean'}).text,'True');
  for(const value of ['false','0','true',2,{},[]])assert.ok(format(value,{format:'boolean'}).error);
  assert.equal(format(null,{format:'boolean'}).text,'—');
});
await test('date/time output is UTC with calendar validation and preserved fractional precision',()=>{
  assert.equal(format('2026-09-28T08:30:00-05:00',{format:'datetime'}).text,'2026-09-28 13:30:00 UTC');
  assert.equal(format('2024-02-29T23:59:59.1234567+01:00',{format:'datetime'}).text,'2024-02-29 22:59:59.1234567 UTC');
  for(const value of ['2023-02-29T00:00:00Z','2026-04-31T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:00:60Z','2026-09-28T08:30:00','9/28/2026','2026-09-28T08:30:00Z\n',0])assert.ok(format(value,{format:'datetime'}).error,String(value));
  assert.equal(format(null,{format:'datetime'}).text,'—');
});
await test('plain text retains literal markup, braces and nested data without executing anything',()=>{
  assert.equal(format('<img src=x onerror=alert(1)> {asset}',{format:'text'}).text,'<img src=x onerror=alert(1)> {asset}');
  assert.equal(format({message:'x'},{format:'text'}).text,'{"message":"x"}');
});
await test('configured filtering sees visible formatted text while sorting and selection keep raw values',()=>{
  const data={columns:['id','amount','enabled'],rows:[{id:'secret-a',amount:10,enabled:false,unlisted:'secret-c'},{id:'secret-b',amount:2,enabled:true}]};
  const cols=resolve([{key:'id',visible:false},{key:'amount',format:'number',precision:2,suffix:' kg'},{key:'enabled',format:'boolean'}],data.columns).columns;
  const search={columns:cols.map(c=>c.key),cellText:(row,key)=>formatTableCell(row[key],cols.find(c=>c.key===key)).text};
  assert.equal(tablePage(data,'secret',null,0,25,search).filtered,0);
  assert.equal(tablePage(data,'kg',null,0,25,search).filtered,2);
  assert.deepEqual(tablePage(data,'false',null,0,25,search).rows,[data.rows[0]]);
  const sorted=tablePage(data,'',{column:'amount',descending:false},0,25,search).rows;assert.deepEqual(sorted.map(row=>row.amount),[2,10]);
  assert.deepEqual(resolveTableSelection(data.rows,sorted[0],'id',{quantity:'amount'}).changes,[['quantity',2]]);
  assert.deepEqual(tablePage(data,'',{column:'id',descending:true},0,25,search).rows,data.rows);
  assert.equal(tablePage(data,'secret',null,0,25).filtered,2,'legacy automatic filter retains its behavior');
});

globalThis.window=new EventTarget();
const fixture={columns:['id','name','amount'],rows:[{id:'raw-key-a',name:'Alpha',amount:10},{id:'raw-key-b',name:'Beta',amount:2}],durationMs:1};
function harness(changes={}){
  let values=[],effects=[],pending=[],cursor=0,sessionKey;
  const p={queryId:'records',title:'Production',parameters:{},queryScope:'runtime',publishedAt:'v1',pageSize:1,
    tableColumns:[{key:'id',visible:false},{key:'amount',label:'Output',format:'number',precision:1,suffix:' kg',width:100,align:'right'},{key:'name',label:'Station',width:180}],...changes};
  globalThis.__tableApi=async path=>path.includes('/execute')?structuredClone(fixture):[{id:'records',kind:'query',parameters:[]}];
  const context={useState(initial){const slots=values,i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next}];},useRef(initial){const i=cursor++;if(!(i in values))values[i]={current:initial};return values[i];},useEffect(run,deps){const i=cursor++,previous=effects[i];if(!previous||deps.some((v,n)=>!Object.is(v,previous.deps[n])))pending.push(()=>{previous?.cleanup?.();effects[i]={deps,cleanup:run()};});}};
  const render=()=>{const element=QueryTable(p);if(sessionKey!==element.key){effects.forEach(e=>e?.cleanup?.());values=[];effects=[];pending=[];sessionKey=element.key;}cursor=0;globalThis.__tableHooks=context;return element.type(element.props);};
  return {p,render,async ready(){for(let i=0;i<7;i++){render();while(pending.length)pending.shift()();await Promise.resolve();}return render();},stop(){effects.forEach(e=>e?.cleanup?.());}};
}
await test('real table renderer applies headings, fixed widths and alignment without rendering hidden values',async()=>{
  const h=harness();try{const tree=await h.ready(),html=renderToStaticMarkup(tree);assert.match(html,/>Output/);assert.match(html,/>Station/);assert.match(html,/width:280px/);assert.match(html,/text-align:right/);assert.match(html,/10.0 kg/);assert.doesNotMatch(html,/raw-key-a/);assert.match(html,/aria-sort="none"/);}finally{h.stop();}
});
await test('table sort, page selection and configuration changes preserve raw form mapping',async()=>{
  const changes=[],h=harness({rowKey:'id',selectionFields:{quantity:'amount'},components:[{id:'quantity',type:'numberInput',props:{fieldKey:'quantity'}}],onSelect:(...args)=>changes.push(args)});
  try{let tree=await h.ready();const sort=descendants(tree,node=>node.type==='button'&&text(node)==='Output')[0];sort.props.onClick();tree=h.render();
    let rows=descendants(tree,node=>node.type==='tr'&&node.props.className==='selectable-row');rows[0].props.onClick();assert.deepEqual(changes,[['quantity',2]]);
    named(tree,'button','Next page of Production').props.onClick();tree=h.render();assert.match(renderToStaticMarkup(tree),/10.0 kg/);
    named(tree,'input','Filter Production').props.onChange({target:{value:'Alpha'}});tree=h.render();assert.match(renderToStaticMarkup(tree),/1 matches/);
    h.p.tableColumns=[{key:'name',label:'Asset'}];tree=await h.ready();assert.equal(named(tree,'input','Filter Production').props.value,'');assert.match(renderToStaticMarkup(tree),/1–1 of 2 loaded/);assert.deepEqual(changes,[['quantity',2]]);
  }finally{h.stop();}
});
await test('invalid configuration removes displayed data, disables paging and cannot select a row',async()=>{
  const h=harness({tableColumns:[{key:'name'},{key:'missing',visible:false}],selectionFields:{quantity:'amount'},onSelect(){assert.fail('invalid table selected');}});
  try{const tree=await h.ready(),html=renderToStaticMarkup(tree);assert.match(html,/role="alert"/);assert.match(html,/missing/);assert.doesNotMatch(html,/<table /);assert.equal(named(tree,'button','Next page of Production').props.disabled,true);}finally{h.stop();}
});
await test('returning to an earlier column configuration or page size does not revive stale view state',async()=>{
  const h=harness();try{
    let tree=await h.ready();const original=h.p.tableColumns;
    named(tree,'input','Filter Production').props.onChange({target:{value:'Alpha'}});
    h.p.tableColumns=[{key:'name'}];await h.ready();h.p.tableColumns=original;tree=await h.ready();
    assert.equal(named(tree,'input','Filter Production').props.value,'');
    named(tree,'button','Next page of Production').props.onClick();tree=h.render();assert.match(renderToStaticMarkup(tree),/2–2 of 2 loaded/);
    h.p.pageSize=2;await h.ready();h.p.pageSize=1;tree=await h.ready();assert.match(renderToStaticMarkup(tree),/1–1 of 2 loaded/);
  }finally{h.stop();}
});
await test('format errors have visible and accessible diagnostics rather than misleading values',async()=>{
  const h=harness({tableColumns:[{key:'name',label:'Timestamp',format:'datetime'}]});
  try{const html=renderToStaticMarkup(await h.ready());assert.match(html,/table-cell-error/);assert.match(html,/aria-label="Timestamp:/);assert.match(html,/1 cell on this page/);assert.doesNotMatch(html,/>Alpha</);}finally{h.stop();}
});
console.log(`${passed} table column model and renderer checks passed.`);
