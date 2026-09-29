import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import React from 'react';
import ts from 'typescript';

process.on('uncaughtException', error => {console.error(error.message); process.exit(1);});
process.on('unhandledRejection', error => {console.error(error?.message ?? error); process.exit(1);});
const require = createRequire(import.meta.url), moduleUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const hookUrl = moduleUrl(`export {createContext} from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)};
let slots=[],index=0; export const begin=()=>{index=0;}; export const clear=()=>{slots=[];index=0;}; export const count=()=>index;
export const useState=initial=>{const at=index++;if(!(at in slots))slots[at]=typeof initial==='function'?initial():initial;return[slots[at],next=>{slots[at]=typeof next==='function'?next(slots[at]):next;}];};
export const useRef=initial=>{const at=index++;return slots[at]??={current:initial};}; export const useEffect=()=>{index++;}; export const useId=()=>{index++;return'input-state-test';}; export const useContext=()=>{index++;return undefined;};`);
const portalUrl = moduleUrl('export const createPortal=child=>child;');
const rowsUrl = moduleUrl('export const useQueryRepeater=()=>({rows:[],loading:false,error:""});');
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const file = ['tsx','ts'].map(ext => new URL(`src/${name}.${ext}`,import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file,name);
  const code = ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g,'')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g,(_all,prefix,_quote,dependency)=>prefix+JSON.stringify(
      dependency==='react'?hookUrl:dependency==='react-dom'?portalUrl:name==='Popup'&&dependency==='./useQueryRepeater'?rowsUrl
      :name==='Popup'&&dependency==='./templates'?moduleUrl(`export {actionKey} from ${JSON.stringify(load('templateModel'))};export function ProjectComponentView(){return null;}`)
      :dependency.startsWith('./')?load(dependency.slice(2)):pathToFileURL(require.resolve(dependency)).href));
  const result=moduleUrl(code);cache.set(name,result);return result;
}
const hooks=await import(hookUrl),{InputStateBindingEditor,inputStateBindingDraftError}=await import(load('InputStateBindingEditor'));
const {default:Popup}=await import(load('Popup'));
const component=(type='numberInput',props={})=>({id:'quantity',type,x:0,y:0,width:220,height:80,props:{fieldKey:'quantity',defaultValue:9,min:0,max:100,...props}});
const state={session:{quantity:4,note:'Ready',enabled:true},screen:{count:2,choice:'A',at:'2026-09-29T12:30'}};
const nodes=node=>!node||typeof node!=='object'?[]:[node,...React.Children.toArray(node.props?.children).flatMap(nodes)];
function editor(extra={}) {
  hooks.clear();globalThis.document={body:{}}; const patches=[],props={component:component(),state,onChange:patch=>patches.push(patch),...extra};let tree;
  const refresh=()=>{hooks.begin();tree=InputStateBindingEditor(props);};
  const find=predicate=>{const result=nodes(tree).find(predicate);assert.ok(result,'Expected input value binding control');return result;};
  const field=label=>find(node=>node.props?.['aria-label']===label);
  const button=text=>find(node=>node.type==='button'&&React.Children.toArray(node.props.children).join('')===text);
  const click=text=>{button(text).props.onClick();refresh();};
  const change=(label,value)=>{field(label).props.onChange({target:{value}});refresh();};
  const open=()=>{field(`${props.component.props.stateBinding?'Edit':'Add'} Value binding`).props.onClick();refresh();};
  refresh();return{props,patches,refresh,find,field,button,click,change,open,all:()=>nodes(tree)};
}
let passed=0;function check(name,run){run();passed++;console.log(`PASS ${name}`);}
check('input value fx selects compatible scalar state and applies a minimal staged patch',()=>{
  for(const[type,key]of[['numberInput','quantity'],['textInput','note'],['checkbox','enabled']]){
    const original=component(type),ui=editor({component:original});ui.open();
    assert.equal(ui.field('Value binding state property').props.value,key);
    assert.deepEqual(ui.all().filter(node=>node.type==='datalist').flatMap(node=>React.Children.toArray(node.props.children).map(option=>option.props.value)),[key]);
    assert.deepEqual(ui.patches,[]);ui.click('Apply');assert.deepEqual(ui.patches,[{stateBinding:{scope:'session',key}}]);assert.equal(original.props.stateBinding,undefined);
  }
});
check('scope switching, explicit screen names and static selection defaults use the same validation',()=>{
  const ui=editor();ui.open();ui.change('Value binding scope','screen');assert.equal(ui.field('Value binding state property').props.value,'count');ui.click('Apply');
  assert.deepEqual(ui.patches,[{stateBinding:{scope:'screen',key:'count'}}]);
  const selection=editor({component:component('select',{options:[{label:'A',value:'A'}]})});selection.open();selection.change('Value binding scope','screen');selection.change('Value binding state property','choice');selection.click('Apply');
  assert.equal(selection.patches[0].stateBinding.key,'choice');
});
check('Cancel and dialog dismissal discard drafts; Ctrl+S applies once and stops editor shortcuts',()=>{
  const ui=editor();ui.open();ui.change('Value binding state property','count');ui.click('Cancel');assert.deepEqual(ui.patches,[]);
  ui.open();assert.equal(ui.field('Value binding state property').props.value,'quantity');let cancelled=0;
  ui.find(node=>node.type==='dialog').props.onCancel({preventDefault(){cancelled++;}});ui.refresh();assert.equal(cancelled,1);assert.deepEqual(ui.patches,[]);
  ui.open();let prevented=0,stopped=0;ui.find(node=>node.type==='dialog').props.onKeyDown({key:'s',ctrlKey:true,preventDefault(){prevented++;},stopPropagation(){stopped++;}});ui.refresh();
  assert.equal(prevented,1);assert.equal(stopped,1);assert.equal(ui.patches.length,1);
});
check('invalid, missing, conflicting and incompatible state sources cannot Apply',()=>{
  const ui=editor();ui.open();
  for(const key of['','unknown','note','enabled','__proto__','constructor','x'.repeat(65),'quantity\n']){ui.change('Value binding state property',key);ui.click('Apply');assert.equal(ui.patches.length,0);assert.ok(ui.all().some(node=>node.props?.role==='alert'));}
  for(const props of[{tagPath:'[default]value'},{optionsSource:null},{selectionFields:{}}]){const invalid=editor({component:component('numberInput',props)});invalid.open();invalid.click('Apply');assert.equal(invalid.patches.length,0);}
});
check('templates defer only unknown containing-screen declarations and still reject invalid binding contracts',()=>{
  const ui=editor({allowUnresolvedScreenState:true,state:{session:state.session,screen:{}}});ui.open();ui.change('Value binding scope','screen');ui.change('Value binding state property','futureCount');ui.click('Apply');
  assert.deepEqual(ui.patches,[{stateBinding:{scope:'screen',key:'futureCount'}}]);
  for(const candidate of[component('passwordInput'),component('label'),component('numberInput',{tagPath:'x'}),component('select',{optionsSource:null})])assert.ok(inputStateBindingDraftError(candidate,{scope:'screen',key:'later'},undefined,true));
  for(const binding of[{scope:'screen',key:'later',extra:true},{scope:'invalid',key:'later'},{scope:'screen',key:'later\n'}])assert.ok(inputStateBindingDraftError(component(),binding,undefined,true));
  assert.ok(inputStateBindingDraftError(component(),{scope:'screen',key:'choice'},state,true));
  assert.ok(inputStateBindingDraftError(component(),{scope:'session',key:'missing'},state,true));
});
check('removing a binding preserves authored defaults and existing component configuration',()=>{
  const original=component('numberInput',{stateBinding:{scope:'session',key:'quantity'}}),ui=editor({component:original});ui.open();ui.click('Remove binding');
  assert.deepEqual(ui.patches,[{stateBinding:undefined}]);assert.equal(original.props.defaultValue,9);assert.deepEqual(original.props.stateBinding,{scope:'session',key:'quantity'});
});
check('password and non-input components never expose a value-binding editor',()=>{
  for(const type of['passwordInput','label','template'])assert.equal(editor({component:component(type)}).all().length,0);
});
check('popup hooks stay stable when its target screen disappears and returns',()=>{
  hooks.clear();const screen={id:'popup',name:'Popup',kind:'popup',width:400,height:240,components:[]};
  const props={project:{id:'p',name:'P',revision:1,parameters:{},screens:[screen],templates:[]},popup:{id:'opening',screenId:'popup',parameters:{},origin:{screenId:'main',componentId:'open'}},tags:[],communicationLost:false,queryScope:'designer',onClose(){},onNavigate(){},onExecute:async()=>({success:true}),onBusyChange(){}};
  hooks.begin();assert.ok(Popup(props));const count=hooks.count();
  hooks.begin();assert.equal(Popup({...props,project:{...props.project,screens:[]}}),null);assert.equal(hooks.count(),count);
  hooks.begin();assert.ok(Popup(props));assert.equal(hooks.count(),count);
});
delete globalThis.document;
console.log(`${passed} input-state authoring checks passed.`);
