import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// The shipped component's event handlers run against a deterministic hook host.
// All requests are promises controlled by this file; no network/device is used.
const require=createRequire(import.meta.url), asModule=code=>`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const realReact=pathToFileURL(require.resolve('react')).href;
const hooks=asModule(`export * from ${JSON.stringify(realReact)};export const useState=initial=>globalThis.__commandHost.useState(initial);export const useRef=initial=>globalThis.__commandHost.useRef(initial);export const useEffect=effect=>globalThis.__commandHost.effects.push(effect);`);
const dependencies={react:hooks,'./Auth':asModule('export const useAuth=()=>globalThis.__commandAuth;'),'./api':asModule('export const api=(...args)=>globalThis.__commandHost.request(...args);')};
const code=ts.transpileModule(fs.readFileSync(new URL('src/EquipmentCommand.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
  .replace(/import "\.\/[^"\n]+\.css";\r?\n/g,'')
  .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g,(_match,prefix,_quote,dependency)=>`${prefix}${JSON.stringify(dependencies[dependency]??pathToFileURL(require.resolve(dependency)).href)}`);
const {default:EquipmentCommand,commandRequestedValue}=await import(asModule(code));
const definition={id:'setpoint',name:'Synthetic setpoint',tagPath:'[default]Fixture/Setpoint',dataType:'Int32',min:0,max:100,confirmation:'Set the synthetic value?'};
const review={token:'review-token',commandId:'setpoint',name:'Synthetic setpoint',currentValue:1,requestedValue:2,confirmation:'Set the synthetic value?',expiresAt:'2099-01-01T00:00:00Z'};
const component={id:'command',type:'equipmentCommand',x:0,y:0,width:500,height:180,props:{commandId:'setpoint'}};
const defaults={component,publishedAt:'publication-1',queryScope:'runtime'};
const descendants=(node,predicate)=>!node||typeof node!=='object'?[]:[...(predicate(node)?[node]:[]),...React.Children.toArray(node.props?.children).flatMap(child=>descendants(child,predicate))];
function host({value='2',pendingReview,commands=true,type='Int32'}={}) {
  const data={states:[{...definition,dataType:type},value,pendingReview,undefined,'',false],refs:[],calls:[],effects:[],stateIndex:0,refIndex:0,
    useState(initial){const index=this.stateIndex++;if(index>=this.states.length)this.states[index]=typeof initial==='function'?initial():initial;return[this.states[index],next=>{this.states[index]=typeof next==='function'?next(this.states[index]):next;}];},
    useRef(initial){const index=this.refIndex++;return this.refs[index]??= {current:initial};},
    request(...args){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});this.calls.push({args,resolve,reject});return promise;},
    render(props={}){this.stateIndex=0;this.refIndex=0;this.effects=[];return EquipmentCommand({...defaults,...props});}};
  globalThis.__commandHost=data;globalThis.__commandAuth={permissions:{view:true,operate:true,commands}};return data;
}
const button=(tree,text)=>descendants(tree,node=>node.type==='button'&&node.props.children===text)[0];
const settle=async()=>{await Promise.resolve();await Promise.resolve();};
let passed=0;async function check(name,run){await run();passed++;console.log(`PASS ${name}`);}
await check('integer inputs cannot silently round, truncate fractions or accept exponent notation',()=>{
  for(const dataType of ['Int16','Int32','Int64']){
    const target={...definition,dataType};for(const value of ['9007199254740993','9007199254740992','-9007199254740992','1.0000000000000001','1.1','1e2','',true])assert.throws(()=>commandRequestedValue(target,value));
    assert.equal(commandRequestedValue(target,'42'),42);assert.equal(commandRequestedValue(target,'-2'),-2);assert.equal(commandRequestedValue(target,'9007199254740991'),9007199254740991);
  }
  for(const [dataType,max] of [['UInt16',65535],['UInt32',4294967295]]) { const target={...definition,dataType}; assert.equal(commandRequestedValue(target,'0'),0); assert.equal(commandRequestedValue(target,String(max)),max); for(const value of ['-1','1.1','1e2',String(max+1)]) assert.throws(()=>commandRequestedValue(target,value)); }
  assert.equal(commandRequestedValue({...definition,dataType:'Double'},'1.25'),1.25);assert.equal(commandRequestedValue({...definition,dataType:'Boolean'},false),false);assert.equal(commandRequestedValue({...definition,dataType:'String'},'exact text'),'exact text');
  assert.throws(()=>commandRequestedValue({...definition,dataType:'Double'},'Infinity'));
});
await check('ordinary operate permission, communication loss and interaction lock block review handlers',()=>{
  for(const options of [{commands:false},{communicationLost:true},{interactionLocked:true}]){
    const state=host(options),tree=state.render(options),control=button(tree,'Review command');assert.equal(control.props.disabled,true);control.props.onClick();assert.equal(state.calls.length,0);
  }
});
await check('duplicate review clicks dispatch one typed request and show only its reviewed value',async()=>{
  const state=host(),tree=state.render(),control=button(tree,'Review command');control.props.onClick();control.props.onClick();assert.equal(state.calls.length,1);
  assert.deepEqual(state.calls[0].args,['/runtime/commands/setpoint/review','POST',{publishedAt:'publication-1',value:2}]);
  state.calls[0].resolve(review);await settle();assert.deepEqual(state.states[2],review);assert.equal(state.states[5],false);
  const html=renderToStaticMarkup(state.render());assert.match(html,/Current value/);assert.match(html,/Requested value/);assert.match(html,/Confirm command/);
});
await check('an unsafe numeric input never reaches the review API',async()=>{
  const state=host({value:'9007199254740993',type:'Int64'});button(state.render(),'Review command').props.onClick();await settle();assert.equal(state.calls.length,0);assert.match(state.states[4],/cannot represent larger integers exactly/);
});
await check('a pending review cannot reopen confirmation after disconnect and reconnect',async()=>{
  const state=host();button(state.render(),'Review command').props.onClick();state.render({communicationLost:true});state.render({communicationLost:false});
  state.calls[0].resolve(review);await settle();assert.equal(state.states[2],undefined);assert.equal(state.states[5],false);
});
await check('a pending review is discarded if command privilege is revoked',async()=>{
  const state=host();button(state.render(),'Review command').props.onClick();globalThis.__commandAuth.permissions.commands=false;state.render();state.calls[0].resolve(review);await settle();assert.equal(state.states[2],undefined);
});
await check('duplicate confirmation clicks use one reviewed token and retain the receipt',async()=>{
  const state=host({pendingReview:review}),control=button(state.render(),'Confirm command');control.props.onClick();control.props.onClick();assert.equal(state.calls.length,1);
  assert.deepEqual(state.calls[0].args,['/runtime/commands/setpoint/execute','POST',{token:'review-token',confirmed:true}]);assert.equal(state.states[2],undefined);
  state.calls[0].resolve({correlationId:'receipt-1',status:'Acknowledged',message:'Synthetic value observed.',requestedValue:2,observedValue:2});await settle();
  const html=renderToStaticMarkup(state.render());assert.match(html,/Acknowledged/);assert.match(html,/receipt-1/);assert.match(html,/Readback: 2/);
});
await check('confirmation is disabled while interaction is unavailable and uncertain execution does not claim success',async()=>{
  const blocked=host({pendingReview:review});const blockedControl=button(blocked.render({interactionLocked:true}),'Confirm command');assert.equal(blockedControl.props.disabled,true);blockedControl.props.onClick();assert.equal(blocked.calls.length,0);
  const state=host({pendingReview:review});button(state.render(),'Confirm command').props.onClick();state.calls[0].reject(new Error('connection lost'));await settle();assert.equal(state.states[3],undefined);assert.match(state.states[4],/No command receipt was received/);assert.match(state.states[4],/target may have changed/);
});
await check('Designer shows a descriptive placeholder with no execution controls',()=>{
  const state=host(),html=renderToStaticMarkup(state.render({queryScope:'designer'}));assert.match(html,/published operator application/);assert.doesNotMatch(html,/<button|<input|<select/);assert.equal(state.calls.length,0);
});
await check('numeric input commit reviews once and cancellation never executes a write', async()=>{
  const state=host(), props={component:{...component,type:'numberInput'},commit:{value:27,sequence:1}};
  let tree=state.render(props);state.effects.at(-1)();assert.equal(state.calls.length,1);assert.equal(state.calls[0].args[0],'/runtime/commands/setpoint/review');assert.equal(state.calls[0].args[2].value,27);
  state.render(props);state.effects.at(-1)();assert.equal(state.calls.length,1);
  state.calls[0].resolve({...review,requestedValue:27});await settle();tree=state.render(props);button(tree,'Cancel').props.onClick();assert.equal(state.calls.length,1);assert.equal(state.states[2],undefined);
});
await check('setpoint commits preserve Commands and communication guards and require explicit confirmation',async()=>{
  const numeric={component:{...component,type:'numberInput'},commit:{value:8,sequence:2}};
  for(const options of [{commands:false},{communicationLost:true},{interactionLocked:true}]){const state=host(options);state.render({...numeric,...options});state.effects.at(-1)();assert.equal(state.calls.length,0);}
  const state=host();state.render(numeric);state.effects.at(-1)();state.calls[0].resolve({...review,requestedValue:8});await settle();assert.equal(state.calls.length,1);
  button(state.render(numeric),'Confirm command').props.onClick();assert.equal(state.calls.length,2);assert.equal(state.calls[1].args[0],'/runtime/commands/setpoint/execute');assert.deepEqual(state.calls[1].args[2],{token:'review-token',confirmed:true});state.calls[1].resolve({status:'Conflict',message:'The setpoint changed.',requestedValue:8,observedValue:3,correlationId:'conflict'});await settle();assert.equal(state.states[3].status,'Conflict');
});
console.log(`${passed} equipment command UI checks passed.`);
