import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import React from 'react';
import ts from 'typescript';

const require=createRequire(import.meta.url),asModule=source=>`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const hooksUrl=asModule(`let slots=[],index=0,effects=[];export const begin=()=>{index=0};export const clear=()=>{slots=[];index=0;effects=[]};export const useId=()=>"account-test";export const useState=initial=>{const at=index++;if(!(at in slots))slots[at]={value:initial};return[slots[at].value,value=>{slots[at].value=value}]};export const useRef=value=>{const at=index++;return slots[at]??={current:value}};export const useEffect=callback=>{index++;effects.push(callback)};export const flush=()=>effects.splice(0).map(callback=>callback());`);
const authUrl=asModule('let auth;export const setAuth=value=>{auth=value};export const useAuth=()=>auth;');
const portalUrl=asModule('export const createPortal=node=>node;');
const themeUrl=asModule('export function ThemePicker(){return null;}');
const output=ts.transpileModule(fs.readFileSync(new URL('src/AccountSettings.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
  .replace(/import "\.\/[^"\n]+\.css";\r?\n/g,'')
  .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g,(_all,prefix,_quote,dependency)=>prefix+JSON.stringify(dependency==='react'?hooksUrl:dependency==='react-dom'?portalUrl:dependency==='./Auth'?authUrl:dependency==='./Theme'?themeUrl:pathToFileURL(require.resolve(dependency)).href));
const {AccountSettingsDialog}=await import(asModule(output)),hooks=await import(hooksUrl),auth=await import(authUrl);
const nodes=node=>!node||typeof node!=='object'?[]:[node,...React.Children.toArray(node.props?.children).flatMap(nodes)];
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const defer=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail});return{promise,resolve,reject}};
const nativeDocument=globalThis.document,nativeElement=globalThis.HTMLElement;
globalThis.document={body:{},activeElement:null};globalThis.HTMLElement=class{isConnected=true;focus(){this.focused=true}};
function dialog({unsaved=false,changePassword=async()=>{},gatewayAdmin=true,audience='engineering'}={}) {
  hooks.clear();let closed=0,tree;
  auth.setAuth({user:{username:'test-admin',displayName:'Test Administrator'},gatewayAdmin,audience,changePassword});
  const refresh=()=>{hooks.begin();tree=AccountSettingsDialog({onClose:()=>closed++,hasUnsavedChanges:unsaved})};
  const find=predicate=>{const node=nodes(tree).find(predicate);assert.ok(node,'Expected account control');return node};
  const field=label=>React.Children.toArray(find(node=>node.type==='label'&&React.Children.toArray(node.props.children)[0]===label).props.children).find(child=>child.type==='input');
  const button=text=>find(node=>node.type==='button'&&node.props.children===text);
  const change=(label,value)=>{field(label).props.onChange({target:{value}});refresh()};
  const submit=()=>{find(node=>node.type==='form').props.onSubmit({preventDefault(){}});refresh()};
  const fill=(current='old-password-for-test',next='new-password-for-test',confirmation=next)=>{change('Current password',current);change('New password',next);change('Confirm new password',confirmation)};
  refresh();return{refresh,find,field,button,change,submit,fill,all:()=>nodes(tree),closed:()=>closed};
}
const allBlank=ui=>['Current password','New password','Confirm new password'].every(label=>ui.field(label).props.value==='');
let passed=0;async function check(name,run){await run();passed++;console.log(`PASS ${name}`)}
try {
  await check('account dialog identifies the account and role and includes the reusable appearance picker',()=>{
    const ui=dialog();assert.equal(ui.find(node=>node.type==='h2').props.children,'Account settings');assert.ok(ui.all().some(node=>node.type==='strong'&&node.props.children==='Test Administrator'));
    assert.ok(ui.all().some(node=>node.type==='small'&&node.props.children==='Gateway administrator'));assert.ok(ui.all().some(node=>node.type?.name==='ThemePicker'));
    for(const label of['Current password','New password','Confirm new password'])assert.equal(ui.field(label).props.type,'password');
    assert.equal(ui.field('Current password').props.autoComplete,'current-password');assert.equal(ui.field('New password').props.autoComplete,'new-password');
  });
  await check('missing, short, excessive, mismatched and unchanged passwords never reach the gateway and are cleared',()=>{
    for(const values of[['','new-password-for-test'],['old','short'],['old','a'.repeat(257)],['old-password-for-test','new-password-for-test','different-password'],['same-password-for-test','same-password-for-test']]){
      let calls=0;const ui=dialog({changePassword:async()=>calls++});ui.fill(...values);ui.submit();assert.equal(calls,0);assert.ok(allBlank(ui));assert.ok(ui.all().some(node=>node.props?.role==='alert'));
    }
  });
  await check('only current and new password are sent; pending submit and close attempts cannot duplicate or dismiss it',async()=>{
    const gate=defer(),calls=[];const ui=dialog({changePassword:(...args)=>{calls.push(args);return gate.promise}});ui.fill();ui.submit();
    assert.deepEqual(calls,[['old-password-for-test','new-password-for-test']]);assert.equal(ui.button('Changing password…').props.disabled,true);
    assert.equal(ui.field('Current password').props.disabled,true);ui.submit();assert.equal(calls.length,1);ui.button('Done').props.onClick();
    let prevented=false;ui.find(node=>node.type==='dialog').props.onCancel({preventDefault(){prevented=true}});assert.equal(prevented,true);assert.equal(ui.closed(),0);
    gate.resolve();await settle();ui.refresh();assert.ok(allBlank(ui));assert.equal(ui.button('Change password').props.disabled,false);
  });
  await check('failed requests show the gateway message, clear every password and allow a retry',async()=>{
    let calls=0;const ui=dialog({changePassword:async()=>{calls++;throw new Error('Current password is incorrect.')}});ui.fill();ui.submit();await settle();ui.refresh();
    assert.ok(allBlank(ui));assert.equal(ui.find(node=>node.props?.role==='alert').props.children,'Current password is incorrect.');ui.fill();ui.submit();await settle();assert.equal(calls,2);
  });
  await check('Done and Escape discard staged passwords without changing them',()=>{
    for(const action of['done','escape']){let calls=0;const ui=dialog({changePassword:async()=>calls++});ui.fill();if(action==='done')ui.button('Done').props.onClick();else ui.find(node=>node.type==='dialog').props.onCancel({preventDefault(){}});ui.refresh();assert.equal(ui.closed(),1);assert.equal(calls,0);assert.ok(allBlank(ui));}
  });
  await check('unsaved project changes block password mutation while appearance remains available',()=>{
    let calls=0;const ui=dialog({unsaved:true,changePassword:async()=>calls++});assert.equal(ui.button('Change password').props.disabled,true);assert.equal(ui.field('New password').props.disabled,true);
    assert.ok(ui.all().some(node=>node.type?.name==='ThemePicker'));ui.fill();ui.submit();assert.equal(calls,0);assert.match(ui.find(node=>node.props?.role==='alert').props.children,/Save your project/);
  });
  await check('native modal lifecycle traps focus with showModal and restores its connected launcher on cleanup',()=>{
    const launcher=new HTMLElement();document.activeElement=launcher;const ui=dialog();let opened=0,closed=0;
    ui.find(node=>node.type==='dialog').props.ref.current={showModal(){opened++},close(){closed++}};const cleanup=hooks.flush();assert.equal(opened,1);cleanup.forEach(callback=>callback?.());assert.equal(closed,1);assert.equal(launcher.focused,true);
  });
} finally {if(nativeDocument===undefined)delete globalThis.document;else globalThis.document=nativeDocument;if(nativeElement===undefined)delete globalThis.HTMLElement;else globalThis.HTMLElement=nativeElement;}
console.log(`${passed} account settings checks passed.`);
