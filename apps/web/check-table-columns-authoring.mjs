import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url), asModule = code=>`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const hookUrl = asModule(`export {Children,cloneElement,isValidElement} from ${JSON.stringify(pathToFileURL(require.resolve("react")).href)};
export const createContext=initial=>{const context={value:initial};context.Provider=({value,children})=>{context.value=value;return children;};return context;};
export const useContext=context=>context.value;
export const useId=()=>"runtime-property-test";
let values=[],index=0;export const begin=()=>{index=0;};export const clear=()=>{values=[];index=0;};export const useState=initial=>{const at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return[values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next;}];};export const useRef=initial=>{const at=index++;return values[at]??={current:initial};};export const useEffect=()=>{};`);
function loader(interactive=false) {
  const modules=new Map();
  return function url(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
    if(modules.has(name)) return modules.get(name);
    const file=['tsx','ts'].map(ext=>new URL(`src/${name}.${ext}`,import.meta.url)).find(file=>fs.existsSync(file)); assert.ok(file,name);
    const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
      .replace(/import "\.\/[^"\n]+\.css";\r?\n/g,'')
      .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g,(_full,prefix,_quote,dependency)=>`${prefix}${JSON.stringify(interactive&&dependency==='react'?hookUrl:dependency.startsWith('./')?url(dependency.slice(2)):pathToFileURL(require.resolve(dependency)).href)}`);
    const result=asModule(code); modules.set(name,result); return result;
  };
}
const real=loader(), interactive=loader(true), hooks=await import(hookUrl);
const { TableColumnsEditor }=await import(real('TableColumnsEditor'));
const { TableColumnsEditor: Editor }=await import(interactive('TableColumnsEditor'));
const { validateTableColumns,resolveTableColumns,formatTableCell }=await import(real('tableColumns'));
const { checkpoint,restoreHistory }=await import(real('canvasEditing'));
const nodes=node=>!node||typeof node!=='object'?[]:[node,...React.Children.toArray(node.props?.children).flatMap(nodes)];
const make=columns=>({id:'table',type:'table',x:0,y:0,width:600,height:300,props:{queryId:'orders',...(columns===undefined?{}:{tableColumns:columns})}});
function drive(component,onChange=()=>{},notify=()=>{}) {
  hooks.clear(); let tree;
  const refresh=()=>{hooks.begin();tree=Editor({component,onChange,notify});};
  const find=predicate=>{const result=nodes(tree).find(predicate);assert.ok(result,'Expected table column control');return result;};
  const field=label=>find(node=>node.props?.['aria-label']===label);
  const button=text=>find(node=>node.type==='button'&&React.Children.toArray(node.props.children).join('')===text);
  const change=(label,value)=>{field(label).props.onChange({target:{value,checked:value}});refresh();};
  const click=text=>{button(text).props.onClick();refresh();};
  refresh(); return {refresh,field,button,change,click,all:()=>nodes(tree)};
}
let checks=0;function check(name,run){run();checks++;console.log(`PASS ${name}`);}

check('automatic and configured summaries use ordinary fields and explain source keys and presentation-only hiding',()=>{
  for(const columns of [undefined,[],[{key:'part_number',label:'Part'},{key:'id',visible:false}]]) {
    const html=renderToStaticMarkup(React.createElement(TableColumnsEditor,{component:make(columns),onChange(){},notify(){}}));
    assert.match(html,/Edit columns/);assert.match(html,/exact query column names/);assert.match(html,/presentation only/);
    assert.doesNotMatch(html,/<textarea|JSON|<ul|<ol/);assert.match(html,/class="property-sheet-row[^"]*" data-property="tableColumns"/);
  }
});
check('table column row opens a staged dialog and title-bar dismissal preserves saved columns',()=>{
  const patches=[],ui=drive(make([{key:'amount',label:'Amount'}]),patch=>patches.push(patch));ui.click('Edit columns');ui.change('Column 1 heading','Unsaved');
  ui.all().find(node=>node.type?.name==='PropertyCollectionDialog').props.onClose();ui.refresh();assert.deepEqual(patches,[]);
  ui.click('Edit columns');assert.equal(ui.field('Column 1 heading').props.value,'Amount');
});
check('all column fields apply together in display order with one undo checkpoint',()=>{
  const component=make([{key:'id'},{key:'amount'}]),before=structuredClone(component),patches=[];
  const original={id:'project',name:'Project',revision:2,parameters:{},screens:[{id:'main',name:'Main',width:1000,height:600,components:[component]}]};
  let project=structuredClone(original),history={past:[],future:[]};
  const ui=drive(component,patch=>{patches.push(patch);history=checkpoint(history,project);project={...project,screens:[{...project.screens[0],components:[{...component,props:{...component.props,...patch}}]}]};});
  ui.click('Edit columns');ui.change('Column 2 heading','Amount due');ui.change('Column 2 width','160');ui.change('Column 2 alignment','right');ui.change('Column 2 format','number');ui.change('Column 2 precision','3');ui.change('Column 2 suffix',' USD');ui.change('Column 1 visible',false);
  ui.field('Move column 2 up').props.onClick();ui.refresh();assert.equal(ui.field('Column 1 source key').props.value,'amount');
  assert.deepEqual(patches,[]);ui.click('Apply columns');
  assert.deepEqual(patches,[{tableColumns:[{key:'amount',label:'Amount due',width:160,align:'right',format:'number',precision:3,suffix:' USD'},{key:'id',visible:false}]}]);
  assert.deepEqual(component,before);assert.equal(history.past.length,1);
  const undone=restoreHistory(history,project,'undo');assert.deepEqual(undone.project,original);
  const redone=restoreHistory(undone.history,undone.project,'redo');assert.deepEqual(redone.project,project);
});
check('Cancel and Escape retain authored columns, including local automatic reset',()=>{
  const component=make([{key:'a',width:200},{key:'b'}]),before=structuredClone(component),patches=[];
  const ui=drive(component,patch=>patches.push(patch));ui.click('Edit columns');ui.change('Column 1 source key','edited');ui.click('Cancel');assert.deepEqual(patches,[]);
  ui.click('Edit columns');assert.equal(ui.field('Column 1 source key').props.value,'a');ui.click('Use automatic columns');
  const group=ui.field('Edit table columns');group.props.onKeyDown({key:'Escape',stopPropagation(){},preventDefault(){}});ui.refresh();
  assert.deepEqual(patches,[]);assert.deepEqual(component,before);
});
check('duplicate, blank, whitespace and all-hidden definitions cannot replace saved columns',()=>{
  const patches=[],errors=[],ui=drive(make([{key:'a'},{key:'b'}]),patch=>patches.push(patch),message=>errors.push(message));ui.click('Edit columns');
  for(const key of ['a','',' b ','bad\nkey']) {ui.change('Column 2 source key',key);assert.equal(ui.button('Apply columns').props.disabled,true);ui.click('Apply columns');}
  ui.change('Column 2 source key','b');ui.change('Column 1 visible',false);ui.change('Column 2 visible',false);ui.click('Apply columns');
  assert.deepEqual(patches,[]);assert.equal(errors.length,5);assert.match(errors.at(-1),/at least one/);
  ui.change('Column 2 visible',true);ui.click('Apply columns');assert.equal(patches.length,1);
});
check('width and numeric precision reject invalid drafts before Apply',()=>{
  const patches=[],ui=drive(make([{key:'temperature'}]),patch=>patches.push(patch));ui.click('Edit columns');
  for(const width of ['39','1201','80.5']){ui.change('Column 1 width',width);assert.equal(ui.button('Apply columns').props.disabled,true);ui.click('Apply columns');}
  ui.change('Column 1 width','40');ui.change('Column 1 format','number');
  for(const precision of ['-1','11','1.5']){ui.change('Column 1 precision',precision);ui.click('Apply columns');}
  assert.deepEqual(patches,[]);ui.change('Column 1 precision','0');ui.click('Apply columns');assert.deepEqual(patches,[{tableColumns:[{key:'temperature',width:40,format:'number',precision:0}]}]);
});
check('format switching preserves local numeric draft and drops numeric-only fields from an applied text definition',()=>{
  const patches=[],ui=drive(make([{key:'amount',format:'number',precision:4,suffix:' kg'}]),patch=>patches.push(patch));ui.click('Edit columns');
  ui.change('Column 1 format','text');assert.ok(!ui.all().some(node=>node.props?.['aria-label']==='Column 1 precision'));
  ui.change('Column 1 format','number');assert.equal(ui.field('Column 1 precision').props.value,'4');assert.equal(ui.field('Column 1 suffix').props.value,' kg');
  ui.change('Column 1 format','text');ui.click('Apply columns');assert.deepEqual(patches,[{tableColumns:[{key:'amount',format:'text'}]}]);
});
check('adding, removing and resetting columns preserves explicit automatic semantics and enforces the limit',()=>{
  const patches=[],ui=drive(make(),patch=>patches.push(patch));ui.click('Edit columns');ui.click('Add column');ui.change('Column 1 source key','part');ui.click('Add column');ui.change('Column 2 source key','qty');
  ui.field('Remove column 1').props.onClick();ui.refresh();assert.equal(ui.field('Column 1 source key').props.value,'qty');ui.click('Apply columns');assert.deepEqual(patches,[{tableColumns:[{key:'qty'}]}]);
  const limited=drive(make(Array.from({length:64},(_,i)=>({key:`c${i}`}))),patch=>patches.push(patch));limited.click('Edit columns');assert.equal(limited.button('Add column').props.disabled,true);limited.click('Add column');assert.equal(limited.all().filter(node=>/^Column \d+ source key$/.test(node.props?.['aria-label']||'')).length,64);
  limited.click('Use automatic columns');assert.equal(patches.length,1);limited.click('Apply columns');assert.deepEqual(patches[1],{tableColumns:[]});
});
check('query changes preserve column configuration and manual source keys can be authored before data is available',()=>{
  const component=make([{key:'legacy_field',label:'Saved heading'}]),patches=[],ui=drive(component,patch=>patches.push(patch));ui.click('Edit columns');
  component.props.queryId='new-query';ui.refresh();assert.equal(ui.field('Column 1 source key').props.value,'legacy_field');assert.deepEqual(patches,[]);
  ui.change('Column 1 source key','future_field');ui.click('Apply columns');assert.deepEqual(patches,[{tableColumns:[{key:'future_field',label:'Saved heading'}]}]);
  assert.match(resolveTableColumns(patches[0].tableColumns,['other']).error,/future_field.*missing/);
});
check('Ctrl+S applies validated columns once and UTC formatting guidance is explicit',()=>{
  const patches=[],ui=drive(make([{key:'recorded_at'}]),patch=>patches.push(patch));ui.click('Edit columns');ui.change('Column 1 format','datetime');
  assert.ok(ui.all().some(node=>node.type==='option'&&node.props.value==='datetime'&&node.props.children==='Date/time (UTC)'));
  assert.ok(ui.all().some(node=>node.type==='p'&&String(node.props.children).includes('Dates display in UTC')));
  let prevented=0,stopped=0;ui.field('Edit table columns').props.onKeyDown({key:'s',ctrlKey:true,preventDefault(){prevented++;},stopPropagation(){stopped++;}});ui.refresh();
  assert.equal(prevented,1);assert.equal(stopped,1);assert.deepEqual(patches,[{tableColumns:[{key:'recorded_at',format:'datetime'}]}]);
});
check('column validation rejects null, unknown fields, null optionals, control characters and numeric-only metadata in other formats',()=>{
  for(const value of [null,{},[null],[{key:'x',extra:1}],[{key:'x',visible:null}],[{key:'x',label:null}],[{key:'x',width:null}],[{key:'x',align:null}],[{key:'x',format:null}],[{key:'x',precision:0}],[{key:'x',suffix:''}],[{key:'x',format:'text',precision:2}],[{key:'x',format:'number',suffix:'\u0080'}]]) assert.ok(validateTableColumns(value),JSON.stringify(value));
  for(const field of ['key','label','suffix'])for(const control of ['\u0000','\u001f','\u007f','\u009f'])assert.ok(validateTableColumns([{key:'x',format:'number',[field]:`a${control}b`}]));
  assert.equal(validateTableColumns([{key:'x',label:' padded label ',format:'number',suffix:'',precision:10,width:1200}]),null);
  assert.equal(validateTableColumns(undefined),null);assert.equal(validateTableColumns([]),null);
});
check('prototype-like source keys remain ordinary exact keys and inherited optional properties do not configure columns',()=>{
  assert.equal(validateTableColumns([{key:'__proto__'},{key:'constructor'}]),null);
  const inherited=Object.assign(Object.create({visible:false,width:1,align:'right',format:'number',precision:20,label:'inherited'}),{key:'own'});
  const result=resolveTableColumns([inherited],['own']);assert.equal(result.error,null);assert.deepEqual(result.columns,[{key:'own',label:'own',align:'left',format:'auto'}]);
  assert.ok(validateTableColumns([Object.create({key:'inherited'})]));
});
check('date formatting rejects normalized invalid calendars and trailing newlines and preserves exact fractions in UTC',()=>{
  const column={key:'time',label:'Time',align:'left',format:'datetime'};
  assert.equal(formatTableCell('2024-02-29T23:15:00.1234567-02:30',column).text,'2024-03-01 01:45:00.1234567 UTC');
  for(const value of ['2023-02-29T12:00:00Z','2024-04-31T12:00:00Z','2024-01-01T24:00:00Z','2024-01-01T12:60:00Z','2024-01-01T12:00:00+24:00','2024-01-01T12:00:00','2024-01-01T12:00:00Z\n','01/02/2024',0])assert.ok(formatTableCell(value,column).error,String(value));
});
check('text format preserves exact string identifiers while rejecting unsafe or nonfinite native numbers',()=>{
  const column={key:'id',label:'Identifier',align:'left',format:'text'};
  assert.equal(formatTableCell('9007199254740993',column).text,'9007199254740993');
  for(const value of [Number.MAX_SAFE_INTEGER+1,Infinity,-Infinity,NaN])assert.ok(formatTableCell(value,column).error);
  assert.equal(formatTableCell(0,column).text,'0');
  assert.equal(formatTableCell('<script>alert(1)</script>',column).text,'<script>alert(1)</script>');
});
console.log(`${checks} table column authoring checks passed.`);
