import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const modules = new Map();
function load(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  if (modules.has(name)) return modules.get(name);
  const code = ts.transpileModule(fs.readFileSync(new URL(`src/${name}.ts`, import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
    .replace(/from "\.\/([^"]+)"/g, (_match, dependency) => `from ${JSON.stringify(load(dependency))}`);
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  modules.set(name, url); return url;
}
const {drawingTypes,drawingDefaults,resolveDrawingComponent,validateDrawingProps} = await import(load('drawingComponents'));
const {evaluateComponentBindings,validatePropertyBinding,supportsBindingTarget} = await import(load('propertyBindings'));
const {runtimeBindingHealth} = await import(load('runtimeQuality'));
const component = (type='pipe', props={}) => ({id:'graphic',type,x:0,y:0,width:240,height:160,props:{...drawingDefaults(type),...props}});
const binding = (expression,references={}) => ({expression,references});
const context = changes => ({components:[],tags:[],parameters:{},inputs:{},...changes});
const evaluate = (type, target, expression, references={}, changes={}) => evaluateComponentBindings(component(type,{bindings:{[target]:binding(expression,references)}}),context(changes));
let count=0; const check=(name,run)=>{run();count++;console.log('PASS '+name);};
check('six defaults are valid, independent typed geometry',()=>{
  for(const type of drawingTypes) assert.equal(resolveDrawingComponent(component(type)).available,true,type);
  const a=drawingDefaults('pipe'), b=drawingDefaults('pipe');a.points[0].x=99;assert.equal(b.points[0].x,0);
  assert.equal(resolveDrawingComponent(component('button')).available,false);
});
check('route bounds, exact points, duplicates and count limits',()=>{
  const valid=component().props;
  for(const points of [[],[{x:0,y:0}], [{x:0,y:0},{x:0,y:0}], [{x:0,y:0},{x:101,y:1}], [{x:0,y:0},{x:1,y:1,z:1}], [{x:'0',y:0},{x:1,y:1}], Array.from({length:65},(_,x)=>({x,y:0}))]) assert.ok(validateDrawingProps('pipe',{...valid,points}));
  assert.equal(validateDrawingProps('pipe',{points:[{x:0.125,y:100},{x:100,y:0.75}]}),null);
  assert.ok(validateDrawingProps('line',{points:[{x:0,y:0},{x:50,y:50},{x:100,y:100}]}));
});
check('static geometry and state are exact, and unsupported fields cannot leak',()=>{
  for(const props of [{rotation:361},{rotation:null},{strokeWidth:0},{flowing:1},{flowReverse:'false'},{active:true},{symbol:'pump'},{cornerRadius:2}]) assert.ok(validateDrawingProps('pipe',props));
  assert.equal(validateDrawingProps('rectangle',{cornerRadius:50,rotation:360,strokeWidth:32}),null);
  assert.ok(validateDrawingProps('equipmentSymbol',{symbol:'unknown'}));
  for(const key of ['svg','path','d','markup','src','url','href','script','tagPath']) assert.ok(validateDrawingProps('pipe',{[key]:'value'}),key);
});
check('paint rejects URLs, whitespace and null; none only applies to fill',()=>{
  for(const value of ['red','url(#paint)','#abc\n',' #abc','none',null]) assert.ok(validateDrawingProps('rectangle',{strokeColor:value}));
  for(const value of ['#abc','#abcd','#abcdef','#abcdef01']) assert.equal(validateDrawingProps('rectangle',{strokeColor:value,fillColor:value,color:value}),null);
  assert.equal(validateDrawingProps('rectangle',{fillColor:'none'}),null);
  assert.ok(validatePropertyBinding(binding("'#abc\\n'"),'fillColor',component('rectangle')));
});
check('binding targets are constrained to their owning graphic types',()=>{
  for(const type of drawingTypes) assert.equal(supportsBindingTarget(type,'rotation'),true);
  assert.equal(supportsBindingTarget('button','rotation'),false);
  assert.equal(supportsBindingTarget('line','fillColor'),false);
  assert.equal(supportsBindingTarget('equipmentSymbol','flowing'),false);
  assert.equal(supportsBindingTarget('pipe','active'),false);
  for(const [target,expression] of [['rotation','361'],['strokeWidth','0'],['flowing','1'],['flowReverse','"true"']]) assert.ok(validatePropertyBinding(binding(expression),target,component()));
});
check('typed expressions resolve actual route state and template parameter scopes',()=>{
  const reverse=evaluate('pipe','flowReverse','direction < 0',{direction:{kind:'parameter',key:'direction'}},{parameters:{direction:-1}});
  assert.deepEqual(reverse.errors,{});assert.equal(resolveDrawingComponent(reverse.component).flowReverse,true);
  const active=evaluate('equipmentSymbol','active','running',{running:{kind:'input',key:'running'}},{inputs:{running:true}});
  assert.deepEqual(active.errors,{});assert.equal(resolveDrawingComponent(active.component).active,true);
});
check('bad tag, lost communications and wrong type clear activity and signal unavailable',()=>{
  for(const change of [{tags:[]},{tags:[{path:'[default]Run',value:true,quality:'Bad'}]},{tags:[{path:'[default]Run',value:true,quality:'Good'}],communicationLost:true},{tags:[{path:'[default]Run',value:'true',quality:'Good'}]}]) {
    const result=evaluate('pipe','flowing','run',{run:{kind:'tag',path:'[default]Run'}},change);
    assert.ok(result.errors.flowing);const model=resolveDrawingComponent(result.component);assert.equal(model.available,false);assert.equal(model.flowing,false);
  }
});
check('failed bound accent, invalid dimensions and missing bound properties cannot silently default',()=>{
  const result=evaluate('pipe','color','missing',{missing:{kind:'input',key:'missing'}});
  assert.equal(resolveDrawingComponent(result.component).available,false);
  assert.equal(resolveDrawingComponent({...component(),width:NaN}).available,false);
  assert.equal(resolveDrawingComponent(component('pipe',{flowing:undefined,bindings:{flowing:binding('true')}})).available,false);
});
check('equipment actions are explicit and navigation only',()=>{
  assert.equal(validateDrawingProps('equipmentSymbol',{}),null);
  assert.equal(validateDrawingProps('equipmentSymbol',{action:'openPopup',targetScreenId:'detail'}),null);
  for(const props of [{action:'navigate'},{action:'script',script:'x'},{action:'closePopup'}]) assert.ok(validateDrawingProps('equipmentSymbol',props));
  assert.ok(validateDrawingProps('pipe',{action:'navigate',targetScreenId:'main'}));
});
check('quality counts one component once, even with multiple failed visual bindings',()=>{
  const broken=component('pipe',{bindings:{flowing:binding('run',{run:{kind:'tag',path:'[default]Missing'}}),rotation:binding('missing',{missing:{kind:'input',key:'missing'}})}});
  const screen={id:'main',components:[broken],width:1200,height:800};
  assert.deepEqual(runtimeBindingHealth(screen,[],[],{},{}),{badCount:1,simulated:false});
  screen.components=[component()];assert.deepEqual(runtimeBindingHealth(screen,[],[],{},{}),{badCount:0,simulated:false});
});
console.log(`${count} drawing model/binding/quality checks passed.`);
