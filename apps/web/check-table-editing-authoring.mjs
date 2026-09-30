import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require=createRequire(import.meta.url),asModule=code=>`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const hookUrl=asModule(`let values=[],index=0;export const begin=()=>{index=0};export const clear=()=>{values=[];index=0};export const useState=initial=>{const at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return[values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next}]};export const useRef=initial=>{const at=index++;return values[at]??={current:initial}};export const useEffect=()=>{};`);
const scriptUrl=asModule('export default function ScriptEditor(){return null}');
function loader(interactive=false){const modules=new Map();return function url(name){if(modules.has(name))return modules.get(name);const file=['tsx','ts'].map(ext=>new URL(`src/${name}.${ext}`,import.meta.url)).find(file=>fs.existsSync(file));assert.ok(file,name);let source=fs.readFileSync(file,'utf8');if(name==='TableEditingEditor')source+='\nexport { TableEditingDialog };';const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText.replace(/import "\.\/[^"\n]+\.css";\r?\n/g,'').replace(/(from\s+|import\s+)(["'])([^"']+)\2/g,(_all,prefix,_quote,dependency)=>`${prefix}${JSON.stringify(interactive&&dependency==='react'?hookUrl:dependency==='./ScriptEditor'?scriptUrl:dependency.startsWith('./')?url(dependency.slice(2)):pathToFileURL(require.resolve(dependency)).href)}`);const result=asModule(code);modules.set(name,result);return result}}
const real=loader(),interactive=loader(true),hooks=await import(hookUrl);
const {TableEditingEditor}=await import(real('TableEditingEditor'));
const {TableEditingDialog:Dialog}=await import(interactive('TableEditingEditor'));
const {validateTableEditDefinition}=await import(real('tableEditing'));
const {checkpoint,restoreHistory}=await import(real('canvasEditing'));
const make=definition=>({id:'orders',type:'table',x:0,y:0,width:700,height:400,props:{queryId:'orders-read',rowKey:'id',...(definition?{tableEdit:definition}:{})}});
const saved=()=>({versionColumn:'version',columns:[{key:'quantity',type:'number',min:0,max:100,integer:true}],script:'result = {"message": "Reviewed"}'});
const nodes=node=>!node||typeof node!=='object'?[]:[node,...React.Children.toArray(node.props?.children).flatMap(nodes)];
function drive(component,onChange=()=>{},notify=()=>{}){hooks.clear();let tree,closed=0;const refresh=()=>{hooks.begin();tree=Dialog({component,onChange,notify,onClose:()=>closed++})};const find=predicate=>{const node=nodes(tree).find(predicate);assert.ok(node,'Expected table editing control');return node};const field=label=>find(node=>node.props?.['aria-label']===label);const button=text=>find(node=>node.type==='button'&&React.Children.toArray(node.props.children).join('')===text);const change=(label,value)=>{field(label).props.onChange({target:{value,checked:value}});refresh()};const code=()=>find(node=>node.type?.name==='ScriptEditor');const setCode=value=>{code().props.onChange(value);refresh()};const click=text=>{button(text).props.onClick();refresh()};refresh();return{refresh,field,button,change,code,setCode,click,find,all:()=>nodes(tree),get closed(){return closed},get tree(){return tree}}}
let checks=0;function check(name,run){run();checks++;console.log(`PASS ${name}`)}

check('disabled and configured summaries expose a transactional handler editor and runtime-only testing',()=>{
  for(const definition of [undefined,saved()]){const html=renderToStaticMarkup(React.createElement(TableEditingEditor,{component:make(definition),onChange(){},notify(){}}));assert.match(html,/Inline editing/);assert.match(html,/operator runtime to test writes/);assert.match(html,/Designer Preview never executes cell writes/);assert.doesNotMatch(html,/<textarea|<pre/)}
});
check('configuration applies types, constraints and Python together as one Undo entry',()=>{
  const component=make(),before=structuredClone(component),patches=[];
  const original={id:'project',name:'Plant',revision:1,parameters:{},screens:[{id:'main',name:'Main',width:1000,height:700,components:[component]}]};let project=structuredClone(original),history={past:[],future:[]};
  const ui=drive(component,patch=>{patches.push(patch);history=checkpoint(history,project);project={...project,screens:[{...project.screens[0],components:[{...component,props:{...component.props,...patch}}]}]}});
  ui.change('Enable table inline editing',true);ui.change('Table edit version column','revision');ui.change('Editable field 1 key','quantity');ui.change('Editable field 1 type','number');ui.change('Editable field 1 minimum','-0.5');ui.change('Editable field 1 maximum','100');ui.change('Editable field 1 integer',true);
  ui.click('Add editable field');ui.change('Editable field 2 key','comment');ui.change('Editable field 2 required',true);ui.change('Editable field 2 maximum length','200');ui.click('Add editable field');ui.change('Editable field 3 key','approved');ui.change('Editable field 3 type','boolean');ui.setCode('result = {"message": "Saved"}');assert.deepEqual(patches,[]);ui.click('Apply editing');
  assert.equal(patches.length,1);assert.deepEqual(patches[0].tableEdit,{versionColumn:'revision',script:'result = {"message": "Saved"}',columns:[{key:'quantity',type:'number',min:-0.5,max:100,integer:true},{key:'comment',type:'string',required:true,maxLength:200},{key:'approved',type:'boolean'}]});assert.equal(validateTableEditDefinition(patches[0].tableEdit,'id'),null);assert.deepEqual(component,before);assert.equal(history.past.length,1);assert.equal(ui.closed,1);assert.deepEqual(restoreHistory(history,project,'undo').project,original);
});
check('Cancel and dialog Escape preserve all saved editing configuration',()=>{
  const component=make(saved()),before=structuredClone(component),patches=[];const ui=drive(component,patch=>patches.push(patch));ui.change('Table edit version column','other_revision');ui.setCode('raise RuntimeError("draft")');ui.click('Cancel');assert.equal(ui.closed,1);assert.deepEqual(patches,[]);assert.deepEqual(component,before);
  const another=drive(component,patch=>patches.push(patch));let prevented=false;another.tree.props.onCancel({preventDefault(){prevented=true}});assert.equal(prevented,true);assert.equal(another.closed,1);assert.deepEqual(patches,[]);
});
check('disabled Apply removes editing only and never runs its saved handler',()=>{
  const component=make(saved()),patches=[];const ui=drive(component,patch=>patches.push(patch));ui.change('Enable table inline editing',false);assert.deepEqual(patches,[]);ui.click('Apply editing');assert.deepEqual(patches,[{tableEdit:undefined}]);assert.equal(component.props.queryId,'orders-read');assert.equal(component.props.rowKey,'id');
});
check('enabled editing requires both a source query and stable row column',()=>{
  for(const missing of ['queryId','rowKey']){const component=make(saved());delete component.props[missing];const patches=[],errors=[],ui=drive(component,patch=>patches.push(patch),text=>errors.push(text));assert.equal(ui.button('Apply editing').props.disabled,true);ui.click('Apply editing');assert.deepEqual(patches,[]);assert.equal(errors.length,1)}
});
check('row and version identities, duplicate keys and malformed source names block Apply without trimming',()=>{
  for(const key of ['id','version',' quantity','quantity ','quantity\n','']){const patches=[],ui=drive(make(saved()),patch=>patches.push(patch));ui.change('Editable field 1 key',key);assert.equal(ui.button('Apply editing').props.disabled,true);ui.click('Apply editing');assert.deepEqual(patches,[])}
  const patches=[],ui=drive(make(saved()),patch=>patches.push(patch));ui.change('Table edit version column','id');assert.equal(ui.button('Apply editing').props.disabled,true);ui.change('Table edit version column','version');ui.click('Add editable field');ui.change('Editable field 2 key','quantity');assert.equal(ui.button('Apply editing').props.disabled,true);assert.deepEqual(patches,[]);
});
check('numeric draft constraints reject invalid coercions, unsafe values and reversed ranges',()=>{
  for(const value of [' ','0x10','NaN','Infinity','9007199254740993','1e400']){const patches=[],ui=drive(make(saved()),patch=>patches.push(patch));ui.change('Editable field 1 minimum',value);assert.equal(ui.button('Apply editing').props.disabled,true,value);ui.click('Apply editing');assert.deepEqual(patches,[])}
  const patches=[],ui=drive(make(saved()),patch=>patches.push(patch));ui.change('Editable field 1 minimum','101');assert.equal(ui.button('Apply editing').props.disabled,true);ui.change('Editable field 1 minimum','-.5');ui.change('Editable field 1 maximum','2e2');ui.click('Apply editing');assert.equal(patches[0].tableEdit.columns[0].min,-.5);assert.equal(patches[0].tableEdit.columns[0].max,200);
});
check('text length and script limits retain invalid drafts rather than saving coerced defaults',()=>{
  const definition={...saved(),columns:[{key:'note',type:'string'}]};for(const length of ['0','4097','1.5',' ']){const patches=[],ui=drive(make(definition),patch=>patches.push(patch));ui.change('Editable field 1 maximum length',length);assert.equal(ui.button('Apply editing').props.disabled,true);ui.click('Apply editing');assert.deepEqual(patches,[])}
  const patches=[],ui=drive(make(definition),patch=>patches.push(patch));for(const script of ['',' \n ','#'.repeat(64001)]){ui.setCode(script);assert.equal(ui.button('Apply editing').props.disabled,true);ui.click('Apply editing');assert.deepEqual(patches,[])}ui.setCode('#'.repeat(64000));ui.change('Editable field 1 maximum length','4096');ui.click('Apply editing');assert.equal(patches[0].tableEdit.script.length,64000);
});
check('changing value types keeps only applicable constraints in the applied definition',()=>{
  const patches=[],ui=drive(make({...saved(),columns:[{key:'note',type:'string',required:true,maxLength:20}]}),patch=>patches.push(patch));ui.change('Editable field 1 type','number');ui.change('Editable field 1 minimum','0');ui.change('Editable field 1 integer',true);ui.change('Editable field 1 type','boolean');ui.click('Apply editing');assert.deepEqual(patches[0].tableEdit.columns,[{key:'note',type:'boolean'}]);
});
check('field bounds keep one definition and cap authoring at64 without losing row data',()=>{
  const definition={...saved(),columns:Array.from({length:64},(_,i)=>({key:`field${i}`,type:'string'}))};const ui=drive(make(definition));assert.equal(ui.button('Add editable field').props.disabled,true);ui.field('Remove editable field 64').props.onClick();ui.refresh();assert.equal(ui.button('Add editable field').props.disabled,false);
  const single=drive(make(saved()));assert.equal(single.field('Remove editable field 1').props.disabled,true);
});
check('CodeMirror has completion and Apply but no Run action; context explains server reconstruction and atomic conflict checks',()=>{
  const ui=drive(make(saved()));assert.equal(ui.code().props.language,'python');assert.equal(ui.code().props.onRun,undefined);assert.equal(typeof ui.code().props.onSave,'function');assert.ok(ui.code().props.completions.some(item=>item.label==='system.db.runNamedQuery'));
  const labels=ui.code().props.completions.map(item=>item.label);for(const name of ['system.ui.sendMessage','system.ui.getSessionInfo','system.util.sendMessage','system.util.sendRequest','system.util.jsonEncode','system.date.now','inputs["value"]','inputs["row"]'])assert.ok(labels.includes(name),name);assert.ok(!labels.some(name=>name.startsWith('self.')||name.startsWith('event.')));
  const content=renderToStaticMarkup(ui.tree);for(const key of ['column','value','oldValue','rowKey','version','row'])assert.ok(content.includes(`inputs[&quot;${key}&quot;]`));assert.match(content,/reconstructed by the gateway/);assert.match(content,/affected-row count/);assert.match(content,/does not make the database update atomic/);assert.doesNotMatch(content,/>Run</);
  assert.match(content,/same gateway/);assert.match(content,/does not receive component/);
});
check('dialog shortcuts isolate pending drafts while preserving native editor undo',()=>{
  const patches=[],ui=drive(make(saved()),patch=>patches.push(patch));let stopped=0,prevented=0;ui.tree.props.onKeyDown({key:'z',ctrlKey:true,stopPropagation(){stopped++},preventDefault(){prevented++}});assert.equal(stopped,1);assert.equal(prevented,0);assert.deepEqual(patches,[]);
  ui.tree.props.onKeyDown({key:'s',ctrlKey:true,stopPropagation(){stopped++},preventDefault(){prevented++}});assert.equal(prevented,1);assert.equal(patches.length,1);
});
check('App integrates the editor only in table properties and resets drafts on source/configuration change',()=>{
  const source=fs.readFileSync(new URL('src/App.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TSX);let found;
  function visit(node){if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(ast)==='TableEditingEditor')found=node;ts.forEachChild(node,visit)}visit(ast);assert.ok(found);const key=found.attributes.properties.find(attribute=>attribute.name?.getText(ast)==='key').getText(ast);assert.match(key,/selected\.id/);for(const field of ['queryId','rowKey','tableEdit'])assert.ok(key.includes(field));
  let parent=found.parent;while(parent&&!ts.isBinaryExpression(parent))parent=parent.parent;assert.ok(parent?.getText(ast).startsWith('selected.type === "table" &&'));
});
console.log(`${checks} table editing authoring checks passed.`);
