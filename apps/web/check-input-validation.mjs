import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';
process.on('uncaughtException', error => { console.error(error.message); process.exit(1); });
process.on('unhandledRejection', error => { console.error(error?.message ?? error); process.exit(1); });
const require = createRequire(import.meta.url), moduleUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const hooksUrl = moduleUrl(`export {Children,cloneElement,isValidElement} from ${JSON.stringify(pathToFileURL(require.resolve("react")).href)};
export const createContext=initial=>{const context={value:initial};context.Provider=({value,children})=>{context.value=value;return children;};return context;};
export const useContext=context=>context.value;
export * from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)};
let slots=[],index=0;export const begin=()=>{index=0;};export const clear=()=>{slots=[];index=0;};
export const useState=initial=>{const at=index++;if(!(at in slots))slots[at]=typeof initial==='function'?initial():initial;return[slots[at],next=>{slots[at]=typeof next==='function'?next(slots[at]):next;}];};
export const useRef=value=>{const at=index++;return slots[at]??={current:value};};export const useEffect=()=>{};export const useId=()=>{index++;return'validation-field';};`);
const cache = new Map();
function load(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  if (cache.has(name)) return cache.get(name);
  const file = ['ts', 'tsx'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dependency) => prefix + JSON.stringify(dependency === 'react' ? hooksUrl : dependency.startsWith('./') ? load(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href));
  const url = moduleUrl(code); cache.set(name, url); return url;
}
const hooks = await import(hooksUrl);
const { inputDefinitionError, inputConstraintError, formatInputText, parseInputMask } = await import(load('inputValidation'));
const { initialInput, isInput, validateInputs, stateInputError } = await import(load('inputs'));
const { ComponentView } = await import(load('Components'));
const { InputValidationEditor } = await import(load('InputValidationEditor'));
const { InputEventLifecycle } = await import(load('inputEvents'));
const component = (type='formattedInput', props={}) => ({ id:'part',type,x:0,y:0,width:280,height:110,props:{fieldKey:'part',text:'Part',...props} });
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
await check('formatted and barcode fields retain text, leading zeros and unavailable source quality', () => {
  for (const type of ['formattedInput','barcodeInput']) {
    assert.equal(isInput(type),true); assert.equal(initialInput(component(type,{defaultValue:'00123'}),[],{}),'00123');
    assert.equal(initialInput(component(type,{tagPath:'[default]Code'}),[],{}),null);
    assert.equal(initialInput(component(type,{defaultValue:123}),[],{}),null);
  }
});
await check('mask commit inserts literals and ASCII case without dropping malformed or excess characters', () => {
  const field=component('formattedInput',{formatMask:'AA-####',textCase:'upper'});
  for (const value of ['ab0012','ab-0012','AB-0012']) assert.equal(formatInputText(field,value),'AB-0012');
  for (const value of ['AB-12','AB-00123','AB-00X2']) { const next=formatInputText(field,value); assert.equal(next,value); assert.ok(inputConstraintError(field,next)); }
  assert.equal(inputConstraintError(field,'AB-0012'),null);
  assert.equal(formatInputText(component('formattedInput',{formatMask:'\\A-###'}),'001'),'A-001');
  assert.equal(formatInputText(component('barcodeInput'),'0000123'),'0000123');
});
await check('mask definitions reject unbounded, tokenless, non-ASCII and dangling escapes', () => {
  for(const mask of ['', 'abc', '#'.repeat(129), '#\\', '#\n', '#Ω']) assert.throws(()=>parseInputMask(mask));
  assert.equal(parseInputMask('#'.repeat(128)).length,128);
  assert.ok(inputDefinitionError(component('textInput',{formatMask:'###'})));
});
await check('required and text rules agree across direct validation and submitted forms', () => {
  const field=component('textInput',{validation:{required:true,minLength:3,maxLength:8,format:'alphanumeric'}});
  for (const value of ['', '   ', 'ab','abcd efgh','Ω123']) assert.ok(inputConstraintError(field,value));
  assert.equal(inputConstraintError(field,'ABC001'),null);
  assert.ok(validateInputs({id:'form',name:'Form',width:1,height:1,components:[field]}, {part:''}));
  assert.equal(inputConstraintError(component('checkbox',{validation:{required:true}}),false),'A value is required.');
  assert.equal(inputConstraintError(component('numberInput',{validation:{required:true}}),0),null);
  assert.equal(inputConstraintError(component('textInput',{validation:{format:'email'}}),'a@example.test'),null);
  assert.ok(inputConstraintError(component('textInput',{validation:{format:'email'}}),'a@b'));
  for(const [format,value] of [['email','a@example.test\n'],['digits','123\n'],['alphanumeric','AB123\n']]) assert.ok(inputConstraintError(component('textInput',{validation:{format}}),value));
});
await check('blank required state-bound fields remain editable until form submission', () => {
  const field=component('formattedInput',{formatMask:'AA-####',validation:{required:true},stateBinding:{scope:'screen',key:'part'}});
  assert.equal(stateInputError(field,{screen:{part:''},session:{},instance:{}}),null);
  assert.equal(stateInputError(field,{screen:{part:'AB-1'},session:{},instance:{}}),null);
  assert.ok(validateInputs({id:'form',name:'Form',width:1,height:1,components:[field]},{part:''}));
  assert.equal(validateInputs({id:'form',name:'Form',width:1,height:1,components:[field]},{part:'AB-0012'}),null);
});
await check('malformed rules fail before execution and custom errors never expose the rejected value', () => {
  for (const validation of [null,[],{unknown:true},{required:'yes'},{minLength:-1},{maxLength:4097},{minLength:5,maxLength:2},{format:'regex'},{message:'x'.repeat(201)}]) assert.ok(inputDefinitionError(component('textInput',{validation})));
  assert.ok(inputDefinitionError(component('numberInput',{validation:{minLength:3}})));
  const field=component('passwordInput',{validation:{minLength:12,message:'Use a longer password.'}});
  assert.equal(inputConstraintError(field,'secret'),'Use a longer password.');
});
function view(field, extra={}) {
  hooks.clear(); hooks.begin(); const changes=[], commits=[];
  const tree=ComponentView({component:field,tags:[],parameters:{},preview:true,onNavigate(){},inputs:{part:field.props.defaultValue??''},onInputChange:(_key,value)=>changes.push(value),onInputCommit:(_key,value)=>commits.push(value),...extra});
  return {tree,changes,commits,input:nodes(tree).find(node=>node.type==='input'&&node.props['aria-label']==='Part')};
}
await check('formatted control commits the formatted value and exposes accessible inline errors', () => {
  const ui=view(component('formattedInput',{defaultValue:'ab0012',formatMask:'AA-####',textCase:'upper'}));
  assert.equal(ui.input.props['aria-invalid'],true); assert.ok(nodes(ui.tree).some(node=>node.props?.id===ui.input.props['aria-describedby']));
  ui.input.props.onBlur(); assert.deepEqual(ui.changes,['AB-0012']); assert.deepEqual(ui.commits,['AB-0012']);
});
await check('barcode terminator commits once, preserves Tab navigation and ignores repeat/composition/blur', () => {
  for(const terminator of ['enter','tab']) {
    const ui=view(component('barcodeInput',{defaultValue:'000012',scanTerminator:terminator,validation:{required:true}})); let prevented=0, selected=0;
    const event={key:terminator==='enter'?'Enter':'Tab',nativeEvent:{isComposing:false},repeat:false,preventDefault:()=>prevented++,currentTarget:{select:()=>selected++}};
    assert.equal(ui.input.props.onBlur,undefined);
    ui.input.props.onKeyDown({...event,repeat:true}); ui.input.props.onKeyDown({...event,nativeEvent:{isComposing:true}}); assert.equal(ui.commits.length,0);
    ui.input.props.onKeyDown(event); assert.deepEqual(ui.commits,['000012']); assert.equal(selected,1); assert.equal(prevented,terminator==='enter'?1:0);
    const locked=view(component('barcodeInput',{defaultValue:'000012'}),{readOnly:true}); locked.input.props.onKeyDown({...event,key:'Enter'}); assert.equal(locked.commits.length,0);
  }
});
await check('repeated identical scans are distinct commit events without changing normal text deduplication', async () => {
  for(const type of ['barcodeInput','textInput']) {
    const calls=[], lifecycle=new InputEventLifecycle((_script,event)=>calls.push(event));
    const field=component(type,{events:{commit:{language:'javascript',code:'return;'}}});
    lifecycle.activate(); lifecycle.setContext({key:type,component:field,components:[field],inputs:{part:'001'},parameters:{},setInput(){},notify(){},error(message){throw Error(message);}},'001');
    lifecycle.commit('001'); lifecycle.commit('001'); await lifecycle.whenIdle();
    assert.equal(calls.length,type==='barcodeInput'?2:0); lifecycle.deactivate();
  }
});
await check('property-grid rule editor stages invalid drafts, applies once and discards Cancel/close', () => {
  const field=component('formattedInput',{formatMask:'AA-####'}),patches=[];let tree;
  hooks.clear();const refresh=()=>{hooks.begin();tree=InputValidationEditor({component:field,onChange:patch=>patches.push(patch)});};
  const find=predicate=>{const node=nodes(tree).find(predicate);assert.ok(node);return node;};
  const click=text=>{find(node=>node.type==='button'&&node.props.children===text).props.onClick();refresh();};
  refresh(); assert.ok(find(node=>node.props?.['data-property']==='validation'));click('Edit rules');
  find(node=>node.props?.['aria-label']==='Input format mask').props.onChange({target:{value:'literal'}});refresh();click('Apply rules');assert.equal(patches.length,0);assert.ok(find(node=>node.props?.role==='alert'));
  click('Cancel');click('Edit rules');assert.equal(find(node=>node.props?.['aria-label']==='Input format mask').props.value,'AA-####');
  find(node=>node.props?.['aria-label']==='Input format mask').props.onChange({target:{value:'###-AA'}});refresh();click('Apply rules');assert.equal(patches.length,1);assert.equal(patches[0].formatMask,'###-AA');
  click('Edit rules');find(node=>node.type?.name==='PropertyCollectionDialog').props.onClose();refresh();assert.equal(patches.length,1);
});
console.log(`${passed} input validation, formatted-field and barcode groups passed.`);
