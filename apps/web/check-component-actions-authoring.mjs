import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';

// Exercise the real staged editor with persistent hooks, without running authored scripts.
const require = createRequire(import.meta.url), asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const hookUrl = asModule(`let scopes=new Map(),current='',index=0;
export const begin=scope=>{current=scope;index=0;if(!scopes.has(scope))scopes.set(scope,[]);};export const clear=()=>{scopes=new Map();};
export const useState=initial=>{const values=scopes.get(current),at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return[values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next;}];};
export const useRef=initial=>{const values=scopes.get(current),at=index++;return values[at]??={current:initial};};
export const useId=()=>'message-authoring';export const useEffect=()=>{};export const useMemo=factory=>factory();`);
const scriptUrl = asModule(`import React from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)};export default function ScriptEditor(props){return React.createElement('script-editor',props);}`);
const apiUrl = asModule(`let sequence=0;export const id=prefix=>prefix+'-'+(++sequence);export const resolvePath=value=>value;export const displayValue=value=>String(value??"");export const tagByPath=(tags,path)=>tags.find(tag=>tag.path===path);export const api=async()=>({resources:[]});`);
const modules = new Map();
function url(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  if (modules.has(name)) return modules.get(name);
  const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_full, prefix, _quote, dependency) => `${prefix}${JSON.stringify(dependency === './ScriptEditor' ? scriptUrl : dependency === './api' ? apiUrl : dependency === 'react' ? hookUrl : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
  const result = asModule(code); modules.set(name, result); return result;
}
const hooks = await import(hookUrl), { default: Editor } = await import(url('ComponentActionsEditor'));
const { componentActionsDraft, applyComponentActionsDraft, tagWriteValue, tagWritePathError, tagWritePropertyChoices, tagWritePropertyReferenceError } = await import(url('componentActionsAuthoring'));
const { componentEventProperties } = await import(url('componentEventModel'));
const { validateComponentMessageHandlers: validateHandlers } = await import(url('componentMessageAuthoring'));
const { eventScriptError, pythonSystemCompletions, pythonEventCompletions } = await import(url('eventScriptAuthoring'));
const { checkpoint, restoreHistory } = await import(url('canvasEditing'));
const base = { id: 'caption', type: 'label', x: 10, y: 20, width: 200, height: 40, props: { text: 'Caption' } };
const input = { ...base, id: 'amount', type: 'numberInput', props: { fieldKey: 'amount' } };
const secret = { ...base, id: 'password', type: 'passwordInput', props: { fieldKey: 'password' } };
const handler = (patch = {}) => ({ id: 'handler-a', messageType: 'refresh', scope: 'screen', language: 'javascript', code: 'app.notify(event.messageType);', ...patch });
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node ? '' : React.Children.toArray(node.props?.children).map(text).join('');
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
function drive(component = base, extra = {}) {
  hooks.clear(); let tree, focused; const applied = [], closed = [], hosts = new Map();
  const props = { component, components: [base, input, secret], inputs: { amount: 12, password: 'must-not-leak' }, parameters: { station: 'A' }, screens: [{id:'home',name:'Home'},{id:'popup',name:'Popup',kind:'popup',parameters:{station:''}}], ...extra, onApply: value => applied.push(value), onClose: () => closed.push(true) };
  function expand(node, path = 'root') {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') { hooks.begin(`${path}:${node.type.name}:${node.key || ''}`); return expand(node.type(node.props), `${path}:${node.type.name}`); }
    let host = hosts.get(path);
    if (!host) { host = { focus: () => { focused = host; } }; hosts.set(path, host); }
    const result = { ...node, props: { ...node.props, testHost: host, children: React.Children.toArray(node.props?.children).map((child, index) => expand(child, `${path}:${child?.key || index}`)) } };
    host.node = result;
    if (typeof node.props.ref === 'function') node.props.ref(host); else if (node.props.ref) node.props.ref.current = host;
    return result;
  }
  const refresh = () => { tree = expand(React.createElement(Editor, props)); };
  const all = () => nodes(tree), find = predicate => { const node = all().find(predicate); assert.ok(node, 'Expected message editor control'); return node; };
  const field = name => find(node => node.props?.['aria-label'] === name);
  const click = name => { const button = find(node => node.type === 'button' && text(node) === name); assert.ok(!button.props.disabled); button.props.onClick(); refresh(); };
  const edit = (name, value) => { field(name).props.onChange({ target: { value } }); refresh(); };
  const nav = name => { find(node => node.type === 'button' && node.props['aria-pressed'] !== undefined && text(node).startsWith(name)).props.onClick(); refresh(); };
  const watch = (name, checked = true) => { field('Watch '+name).props.onChange({target:{checked}}); refresh(); };
  const code = value => { find(node => node.type === 'script-editor').props.onChange(value); refresh(); };
  refresh(); return { refresh, all, find, field, click, edit, code, nav, watch, applied, closed, props, focus: node => node.props.testHost.focus(), focused: () => focused?.node, content: () => text(tree) };
}
let passed = 0;
const check = (name, run) => { run(); passed++; console.log(`PASS ${name}`); };
const apply = ui => ui.click('Apply actions & events');
const button = { ...base, type: 'button', props: { text: 'Save', action: 'script', script: 'print("saved")' } };
const selectLanguage = (ui, language) => ui.edit('Event script language', language);
const current = ui => ui.find(node => node.type === 'script-editor').props;
check('one draft preserves action, lifecycle and messages across navigation and applies once', () => {
  const snapshot = structuredClone(button), ui = drive(button);
  ui.code('self.text = "Saved"'); ui.nav('Mounted'); ui.code('self.text = "Ready"');
  ui.nav('Property changed'); ui.watch('text'); selectLanguage(ui, 'javascript'); ui.code('app.notify(event.value);');
  ui.nav('Unmounted'); ui.code('print(self.text)'); ui.nav('Messages'); ui.click('Add handler');
  ui.edit('Message handler type', 'orders.reset'); ui.code('self.text = event.payload["label"]');
  ui.nav('On click'); assert.equal(current(ui).value, 'self.text = "Saved"'); assert.deepEqual(ui.applied, []); apply(ui);
  assert.equal(ui.applied.length, 1); const props = ui.applied[0];
  assert.equal(props.script, 'self.text = "Saved"'); assert.equal(props.componentEvents.mount.language, 'python');
  assert.equal(props.componentEvents.propertyChange.language, 'javascript'); assert.deepEqual(props.componentEvents.propertyChange.properties, ['text']);
  assert.equal(props.componentEvents.unmount.code, 'print(self.text)'); assert.equal(props.messageHandlers[0].messageType, 'orders.reset'); assert.deepEqual(button, snapshot);
});
check('input change and commit retain independent language buffers with lifecycle and messages', () => {
  const ui = drive(input); ui.code('print(event.value)'); selectLanguage(ui, 'javascript'); ui.code('app.notify(event.value);');
  selectLanguage(ui, 'python'); assert.equal(current(ui).value, 'print(event.value)');
  ui.nav('Value committed'); selectLanguage(ui, 'javascript'); ui.code('app.notify("commit");');
  ui.nav('Mounted'); ui.code('print("mounted")'); ui.nav('Messages'); ui.click('Add handler'); apply(ui);
  assert.equal(ui.applied[0].events.change.language, 'python'); assert.equal(ui.applied[0].events.commit.language, 'javascript'); assert.equal(ui.applied[0].componentEvents.mount.language, 'python'); assert.equal(ui.applied[0].messageHandlers.length, 1);
});
check('Cancel, close and Escape discard all event and native action changes', () => {
  for (const action of ['cancel', 'close', 'escape']) {
    const ui = drive(button); ui.code('print("discard")'); ui.edit('Click action', 'message'); ui.edit('Button message type', 'discard'); ui.nav('Mounted'); ui.code('print("discard")'); ui.nav('Messages'); ui.click('Add handler');
    if (action === 'cancel') ui.click('Cancel');
    if (action === 'close') ui.field('Close actions and events').props.onClick();
    if (action === 'escape') ui.find(node => node.type === 'dialog').props.onCancel({ preventDefault() {} });
    assert.deepEqual(ui.applied, []); assert.equal(ui.closed.length, 1);
  }
});
check('notify buttons stage browser-only feedback text and drop it when the action changes', () => {
  const screens = [{ id: 'home', name: 'Home' }];
  const draft = componentActionsDraft(button); draft.action = 'notify'; draft.notifyMessage = '  Item saved.  ';
  const applied = applyComponentActionsDraft(button, draft, screens);
  assert.equal(applied.props.action, 'notify'); assert.equal(applied.props.notifyMessage, 'Item saved.'); assert.equal(applied.props.script ?? '', button.props.script ?? '');
  for (const notifyMessage of ['   ', 'x'.repeat(501), 'bad\u0007bell']) assert.equal(applyComponentActionsDraft(button, { ...draft, notifyMessage }, screens).tab, 'action', JSON.stringify(notifyMessage));
  assert.equal(applyComponentActionsDraft(button, { ...draft, notifyMessage: 'Line one\nLine two' }, screens).props.notifyMessage, 'Line one\nLine two');
  const notifying = { ...button, props: applied.props }, back = componentActionsDraft(notifying);
  assert.equal(back.action, 'notify'); assert.equal(back.notifyMessage, 'Item saved.');
  const navigating = applyComponentActionsDraft(notifying, { ...back, action: 'navigate', targetScreenId: 'home' }, screens);
  assert.equal(navigating.props.action, 'navigate'); assert.equal(navigating.props.notifyMessage, undefined);
});
check('saved Python button script and existing JavaScript events round trip without conversion', () => {
  const component = { ...button, props: { ...button.props, color: '#abcdef', componentEvents: { mount: {language:'javascript',code:'app.notify("legacy");'}, unmount: {language:'javascript',code:'console.log("closed");'} }, messageHandlers:[handler()] } };
  const ui = drive(component); apply(ui); assert.deepEqual(JSON.parse(JSON.stringify(ui.applied[0])), component.props);
  ui.nav('Mounted'); assert.equal(current(ui).language, 'javascript'); selectLanguage(ui,'python'); assert.equal(current(ui).value,''); ui.code('print("new")'); selectLanguage(ui,'javascript'); assert.equal(current(ui).value,'app.notify("legacy");');
});
check('native navigation and popup settings stay staged and keep separate destinations', () => {
  const ui=drive({...button,props:{action:'navigate',targetScreenId:'home',script:'print("retained")'}});
  ui.edit('Click action','openPopup'); ui.edit('Action destination','popup'); ui.edit('Popup parameter overrides','{"station":"A"}');
  ui.edit('Click action','navigate'); assert.equal(ui.field('Action destination').props.value,'home');
  ui.edit('Click action','openPopup'); assert.equal(ui.field('Action destination').props.value,'popup'); assert.equal(ui.field('Popup parameter overrides').props.value,'{"station":"A"}'); assert.deepEqual(ui.applied,[]); apply(ui);
  assert.equal(ui.applied[0].action,'openPopup'); assert.deepEqual(ui.applied[0].parameters,{station:'A'}); assert.equal(ui.applied[0].script,'print("retained")');
});
check('native action errors select On click and block the entire staged apply', () => {
  const ui=drive(button); ui.edit('Click action','openPopup'); ui.edit('Action destination','popup'); ui.edit('Popup parameter overrides','{"unknown":"A"}'); ui.nav('Mounted');ui.code('print("ready")');apply(ui);
  assert.deepEqual(ui.applied,[]);assert.match(ui.content(),/Overrides must use parameters/);assert.ok(ui.field('Click action'));
  ui.edit('Popup parameter overrides','{"station":12}');apply(ui);assert.match(ui.content(),/text values/);
  ui.edit('Popup parameter overrides','{');apply(ui);assert.match(ui.content(),/valid JSON/);
});
check('button messages validate JSON, type and scope within the shared draft', () => {
  const ui=drive(button);ui.edit('Click action','message');ui.edit('Button message type','  orders.refresh  ');ui.edit('Button message scope','instance');ui.edit('Button message payload','{"quantity":6}');apply(ui);
  assert.deepEqual(ui.applied[0].message,{messageType:'orders.refresh',scope:'instance',payload:{quantity:6}});
  ui.edit('Button message payload','[]');apply(ui);assert.equal(ui.applied.length,1);assert.match(ui.content(),/JSON object/);
  ui.edit('Button message payload','{}');ui.edit('Button message type','bad\nname');apply(ui);assert.equal(ui.applied.length,1);
});
check('Send message suggests authored types and distinguishes receiver locations as drafts change', () => {
  const sender={...button,id:'sender',props:{text:'Notify',action:'message',message:{messageType:'refresh',scope:'screen',payload:{}}}};
  const receiver={...base,id:'production-receiver',props:{text:'Production receiver',messageHandlers:[handler({language:'python',code:'print(event.messageType)'}),handler({id:'session-a',scope:'session'})]}};
  const popupReceiver={...base,id:'popup-receiver',props:{text:'Popup receiver',messageHandlers:[handler({id:'popup-a'}),handler({id:'popup-session',scope:'session',messageType:'popup.notice'})]}};
  const home={id:'home',name:'Production',width:800,height:600,components:[sender,receiver]},popup={id:'popup',name:'Inspection',kind:'popup',width:500,height:400,components:[popupReceiver]};
  const project={screens:[home,popup],templates:[]},ui=drive(sender,{components:home.components,parent:home,project,screens:project.screens});
  const panel=()=>ui.find(node=>node.type==='section'&&node.props['aria-label']==='Message receivers');
  const suggestions=()=>ui.find(node=>node.type==='datalist');
  assert.equal(ui.field('Button message type').props.list,suggestions().props.id);
  assert.ok(nodes(suggestions()).some(node=>node.type==='option'&&node.props.value==='refresh'));
  assert.match(text(panel()),/Production receiver/);assert.match(text(panel()),/Component ID production-receiver/);assert.match(text(panel()),/Handler ID handler-a/);assert.match(text(panel()),/label component/);assert.match(text(panel()),/Production/);assert.match(text(panel()),/Python/);
  assert.match(text(panel()),/Potential receivers in this scope/);assert.match(text(panel()),/Other locations/);assert.match(text(panel()),/Popup receiver/);
  ui.edit('Button message type','  refresh  ');assert.match(text(panel()),/Production receiver/);assert.equal(ui.field('Button message type').props.value,'  refresh  ');
  ui.edit('Button message scope','instance');assert.match(text(panel()),/No receiver definitions match/);
  ui.edit('Button message scope','session');assert.ok(nodes(suggestions()).some(node=>node.type==='option'&&node.props.value==='popup.notice'));
  ui.edit('Button message type','popup.notice');assert.match(text(panel()),/Popup receiver/);assert.doesNotMatch(text(panel()),/Production receiver/);
  ui.edit('Button message type','REFRESH');assert.match(text(panel()),/No receiver definitions match/);assert.match(text(panel()),/case-sensitive/);
  ui.edit('Button message type','');assert.match(text(panel()),/Choose or enter a message type/);
  assert.deepEqual(ui.applied,[]);assert.equal(sender.props.message.messageType,'refresh');
  ui.edit('Button message type','popup.notice');apply(ui);assert.deepEqual(ui.applied[0].message,{messageType:'popup.notice',scope:'session',payload:{}});
});
check('unapplied receiver edits are reflected in the same component Send message list without losing other drafts', () => {
  const sender={...button,id:'self-listener',props:{text:' ',action:'message',message:{messageType:'refresh',scope:'screen',payload:{}},messageHandlers:[handler()]}};
  const home={id:'home',name:'Local form',width:800,height:600,components:[sender]},ui=drive(sender,{components:[sender],parent:home,project:{screens:[home],templates:[]},screens:[home]});
  assert.equal(text(ui.find(node=>node.type==='h2')),'self-listener');
  ui.edit('Button message payload','{"draft":true}');ui.nav('Messages');assert.equal(ui.field('Message handler ID').props.value,'handler-a');assert.equal(ui.field('Message handler ID').props.readOnly,true);assert.match(text(ui.field('Selected message handler')),/handler-a/);ui.edit('Message handler type','  orders.updated  ');selectLanguage(ui,'python');ui.code('print(event.messageType)');
  ui.nav('On click');ui.edit('Button message type','orders.updated');
  const panel=ui.find(node=>node.type==='section'&&node.props['aria-label']==='Message receivers');assert.match(text(panel),/self-listener/);assert.match(text(panel),/Python/);
  assert.equal(ui.field('Button message payload').props.value,'{"draft":true}');assert.equal(sender.props.messageHandlers[0].messageType,'refresh');assert.deepEqual(ui.applied,[]);
  ui.nav('Messages');ui.click('Remove handler');ui.nav('On click');assert.match(text(ui.find(node=>node.type==='section'&&node.props['aria-label']==='Message receivers')),/No receiver definitions match/);
  ui.click('Cancel');assert.deepEqual(ui.applied,[]);assert.equal(sender.props.messageHandlers.length,1);
});
const writableTag = (path, dataType = 'Double', source = 'memory') => ({path,dataType,source,value:0,quality:'Good',timestamp:'2026-09-30T00:00:00Z'});
check('native tag action browses writable targets and stages a typed value without scripts or JSON', () => {
  const tags=[writableTag('[default]Workshop/Enabled','Boolean'),writableTag('[default]Workshop/Count','UInt16','opcua'),writableTag('[default]Workshop/Caption','String'),writableTag('[default]Workshop/Calculated','Double','expression')];
  const ui=drive(button,{tags});ui.edit('Click action','setTagValue');assert.ok(!ui.all().some(node=>node.type==='script-editor'));
  ui.click('Browse');assert.ok(!ui.all().some(node=>node.props?.['aria-label']==='Select tag [default]Workshop/Calculated'));const result=ui.field('Select tag [default]Workshop/Enabled');ui.focus(result);result.props.onClick();ui.refresh();
  assert.equal(ui.focused().props['aria-label'],'Set tag path');assert.ok(!ui.all().some(node=>node.props?.['aria-label']==='Writable tag browser'));assert.deepEqual(ui.closed,[]);
  assert.equal(ui.field('Set tag path').props.value,'[default]Workshop/Enabled');assert.equal(ui.field('Set tag data type').props.value,'Boolean');assert.equal(ui.field('Set tag data type').props.readOnly,true);
  ui.edit('Set tag Boolean value','true');ui.field('Require tag write confirmation').props.onChange({target:{checked:true}});ui.refresh();ui.edit('Tag write confirmation message','  Start this line?  ');
  ui.nav('Mounted');ui.code('print("ready")');assert.deepEqual(ui.applied,[]);apply(ui);
  assert.deepEqual(ui.applied[0].tagWrite,{tagPath:'[default]Workshop/Enabled',dataType:'Boolean',value:true,confirmation:'Start this line?'});assert.equal(ui.applied[0].script,button.props.script);assert.equal(ui.applied[0].componentEvents.mount.code,'print("ready")');
  assert.match(ui.content(),/Save and publish/);ui.nav('On click');assert.match(ui.content(),/Designer Preview does not write tags/);
});
check('tag-browser Escape restores focus and retains action and event drafts from search or a result', () => {
  const path='[default]Workshop/Count',tags=[writableTag(path,'UInt16')],ui=drive(button,{tags});
  ui.nav('Mounted');ui.code('print("retained event")');ui.nav('On click');ui.edit('Click action','setTagValue');
  ui.edit('Set tag path',path);ui.edit('Set tag value','42');
  for(const target of ['Find writable tag',`Select tag ${path}`]){
    ui.click('Browse');ui.edit('Find writable tag','Count');ui.focus(ui.field(target));
    const browser=ui.find(node=>node.props?.['aria-label']==='Writable tag browser');
    browser.props.onKeyDown({key:'ArrowDown',preventDefault(){assert.fail('Ordinary browser keys keep their native behavior');},stopPropagation(){assert.fail('Ordinary browser keys keep their native behavior');}});
    let prevented=false,stopped=false;
    browser.props.onKeyDown({key:'Escape',preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});ui.refresh();
    assert.ok(prevented&&stopped);assert.equal(ui.focused().props['aria-label'],'Set tag path');
    assert.ok(!ui.all().some(node=>node.props?.['aria-label']==='Writable tag browser'));
    assert.deepEqual(ui.closed,[]);assert.deepEqual(ui.applied,[]);assert.equal(ui.field('Set tag value').props.value,'42');
    assert.equal(ui.field('Set tag path').props.value,path);
  }
  apply(ui);assert.deepEqual(ui.applied[0].tagWrite,{tagPath:path,dataType:'UInt16',value:42});
  assert.equal(ui.applied[0].componentEvents.mount.code,'print("retained event")');assert.deepEqual(ui.closed,[]);
});
check('manual tag entry has typed numeric and plain text editors and preserves independent action drafts', () => {
  const ui=drive(button);ui.edit('Click action','setTagValue');ui.edit('Set tag path','[default]Workshop/Setpoint');ui.edit('Set tag data type','Int16');ui.edit('Set tag value','-12');
  ui.edit('Click action','script');assert.equal(current(ui).value,button.props.script);ui.edit('Click action','setTagValue');assert.equal(ui.field('Set tag value').props.value,'-12');apply(ui);
  assert.deepEqual(ui.applied[0].tagWrite,{tagPath:'[default]Workshop/Setpoint',dataType:'Int16',value:-12});
  ui.edit('Set tag data type','String');ui.edit('Set tag value','Hello "operator"');apply(ui);assert.equal(ui.applied[1].tagWrite.value,'Hello "operator"');assert.equal(ui.field('Set tag value').props.type,'text');
  ui.edit('Set tag data type','Boolean');assert.equal(ui.field('Set tag Boolean value').props.value,'false');apply(ui);assert.equal(ui.applied[2].tagWrite.value,false);
});
check('tag action validation rejects unavailable source kinds, invalid paths, type ranges and confirmation before Apply', () => {
  const tags=[writableTag('[default]Workshop/Calculated','Double','expression'),writableTag('[default]Workshop/Count','UInt16')],ui=drive(button,{tags});ui.edit('Click action','setTagValue');ui.edit('Set tag path','[default]Workshop/Calculated');apply(ui);assert.match(ui.content(),/writable memory, OPC UA or device tag/);
  ui.edit('Set tag path','[default]Workshop/Count');ui.edit('Set tag value','65536');apply(ui);assert.match(ui.content(),/65,535/);ui.edit('Set tag value','1.2');apply(ui);assert.match(ui.content(),/exact whole numbers/);
  ui.edit('Set tag value','42');ui.field('Require tag write confirmation').props.onChange({target:{checked:true}});ui.refresh();ui.edit('Tag write confirmation message','  ');apply(ui);assert.match(ui.content(),/1 to 512/);assert.deepEqual(ui.applied,[]);
  ui.edit('Tag write confirmation message','Continue?');apply(ui);assert.equal(ui.applied[0].tagWrite.dataType,'UInt16');
  for(const path of ['Workshop/Count','[default]','[default]../Count','[default]Area//Count','[default]Area/{parameter}','[default]Area\\Count','[default]Area/\nCount','[other]Area/Count'])assert.ok(tagWritePathError(path),path);
  assert.equal(tagWritePathError('[default]Workshop/Count'),undefined);
});
check('native tag values enforce exact canonical numeric, Boolean and String limits', () => {
  for(const [type,value,expected]of [['Boolean','true',true],['Boolean','false',false],['Int16','-32768',-32768],['UInt16','65535',65535],['Int32','2147483647',2147483647],['UInt32','4294967295',4294967295],['Int64','9007199254740991',9007199254740991],['Double','1.25e2',125],['Float','-2.5',-2.5],['String','', '']])assert.equal(tagWriteValue(type,value),expected);
  for(const [type,value]of [['Boolean','1'],['Double','NaN'],['Double','Infinity'],['Double',''],['Double','0x10'],['Double','9007199254740992'],['Float','1e39'],['UInt16','-1'],['Int16','32768'],['Int32','2147483648'],['UInt32','4294967296'],['Int64','9007199254740992'],['Int16','1.1'],['String','x'.repeat(1025)]])assert.throws(()=>tagWriteValue(type,value),undefined,`${type}: ${value.slice(0,40)}`);
});
check('saved tag actions round trip and remain inactive when another native action is selected', () => {
  const component={...button,props:{...button.props,action:'setTagValue',tagWrite:{tagPath:'[default]Workshop/Count',dataType:'UInt16',value:7,confirmation:'Continue?'}}},ui=drive(component);apply(ui);assert.deepEqual(ui.applied[0].tagWrite,component.props.tagWrite);
  ui.edit('Click action','navigate');ui.edit('Action destination','home');apply(ui);assert.deepEqual(ui.applied[1].tagWrite,component.props.tagWrite);
  const cancel=drive(component);cancel.edit('Set tag value','8');cancel.click('Cancel');assert.deepEqual(cancel.applied,[]);assert.equal(component.props.tagWrite.value,7);
});
check('component property tag values save a current input reference instead of its authored or preview value', () => {
  const ui=drive(button,{tags:[writableTag('[default]Workshop/Setpoint')]});ui.edit('Click action','setTagValue');ui.edit('Set tag path','[default]Workshop/Setpoint');ui.edit('Set tag value','42');ui.edit('Set tag value source','property');ui.edit('Set tag source component','component:amount');
  assert.equal(ui.field('Set tag source property').props.value,'value');assert.match(ui.content(),/current validated field/);apply(ui);
  assert.deepEqual(ui.applied[0].tagWrite,{tagPath:'[default]Workshop/Setpoint',dataType:'Double',valueReference:{kind:'property',componentId:'amount',property:'value'}});assert.equal(Object.hasOwn(ui.applied[0].tagWrite,'value'),false);
  ui.edit('Set tag value source','fixed');assert.equal(ui.field('Set tag value').props.value,'42');ui.edit('Set tag value source','property');assert.equal(ui.field('Set tag source component').props.value,'component:amount');ui.edit('Click action','script');assert.equal(current(ui).value,button.props.script);
});
check('property picker includes general, component-specific, nested and custom scalar properties', () => {
  const chart={...base,id:'trend',type:'chart',props:{chart:{kind:'line',xKey:'time',series:[{key:'amount'}],yMax:300,showLegend:true},customProperties:{ceiling:{type:'number',value:350}}}};
  const choices=tagWritePropertyChoices(chart).map(choice=>choice.property);
  for(const key of ['text','width','height','chart.yMax','chart.showLegend','customProperties.ceiling.value'])assert.ok(choices.includes(key),key);
  for(const key of ['chart.series','data','tableColumns'])assert.ok(!choices.includes(key),key);
  const ui=drive(button,{components:[button,chart]});ui.edit('Click action','setTagValue');ui.edit('Set tag path','[default]Workshop/Setpoint');ui.edit('Set tag value source','property');ui.edit('Set tag source component','component:trend');ui.edit('Set tag source property','customProperties.ceiling.value');apply(ui);
  assert.deepEqual(ui.applied[0].tagWrite.valueReference,{kind:'property',componentId:'trend',property:'customProperties.ceiling.value'});
  ui.edit('Set tag source property','chart.yMax');apply(ui);assert.equal(ui.applied[1].tagWrite.valueReference.property,'chart.yMax');
});
check('self text and parent metadata references remain explicit and round trip without converting to constants', () => {
  const parent={id:'home',name:'Workshop',width:1000,height:700,components:[button]},ui=drive(button,{parent});ui.edit('Click action','setTagValue');ui.edit('Set tag path','[default]Workshop/Caption');ui.edit('Set tag data type','String');ui.edit('Set tag value source','property');ui.edit('Set tag source property','text');apply(ui);
  assert.deepEqual(ui.applied[0].tagWrite.valueReference,{kind:'property',property:'text'});
  ui.edit('Set tag source component','parent');assert.equal(ui.field('Set tag source property').props.value,'name');apply(ui);assert.deepEqual(ui.applied[1].tagWrite.valueReference,{kind:'parentProperty',property:'name'});
  ui.edit('Set tag data type','Double');ui.edit('Set tag source property','height');apply(ui);assert.deepEqual(ui.applied[2].tagWrite.valueReference,{kind:'parentProperty',property:'height'});
  const saved={...button,props:{...button.props,action:'setTagValue',tagWrite:ui.applied[2].tagWrite}},reopened=drive(saved,{parent});assert.equal(reopened.field('Set tag value source').props.value,'property');assert.equal(reopened.field('Set tag source component').props.value,'parent');apply(reopened);assert.deepEqual(reopened.applied[0].tagWrite,saved.props.tagWrite);
});
check('property sources reject password values, structured paths, other forms and incompatible scalar types', () => {
  const ui=drive(button);ui.edit('Click action','setTagValue');ui.edit('Set tag path','[default]Workshop/Setpoint');ui.edit('Set tag value source','property');ui.edit('Set tag source component','component:password');
  assert.ok(!React.Children.toArray(ui.field('Set tag source property').props.children).some(option=>option.props.value==='value'));
  ui.edit('Set tag source property','value');apply(ui);assert.match(ui.content(),/Password values and structured properties/);assert.deepEqual(ui.applied,[]);
  ui.edit('Set tag source component','component:caption');ui.edit('Set tag source property','text');apply(ui);assert.match(ui.content(),/does not match the Double tag/);
  ui.edit('Set tag source component','component:other-form');ui.edit('Set tag source property','width');apply(ui);assert.match(ui.content(),/not in this form/);
  for(const reference of [{kind:'property',property:'data'},{kind:'property',property:'__proto__'},{kind:'property',componentId:'',property:'text'},{kind:'property',property:'width',extra:'x'},{kind:'parentProperty',property:'height'},{kind:'parentProperty',property:'titlebarHeight'},{kind:'expression',property:'width'}])assert.ok(tagWritePropertyReferenceError(reference,button,[button],undefined,'Double'));
});
check('component IDs matching picker scopes retain unambiguous saved identities', () => {
  const sibling={...input,id:'self'},ui=drive(button,{components:[button,sibling]});ui.edit('Click action','setTagValue');ui.edit('Set tag path','[default]Workshop/Setpoint');ui.edit('Set tag value source','property');ui.edit('Set tag source component','component:self');apply(ui);assert.deepEqual(ui.applied[0].tagWrite.valueReference,{kind:'property',componentId:'self',property:'value'});
});
check('declared command rules explain inherited confirmation and block conflicting definitions before Apply', () => {
  const command={id:'set-speed',name:'Change speed',tagPath:'[default]Workshop/Speed',dataType:'Double',min:0,max:100,readbackPath:'[default]Workshop/ActualSpeed',confirmation:'Apply the requested speed?'};
  const ui=drive(button,{commands:[command]});ui.edit('Click action','setTagValue');ui.edit('Set tag path',command.tagPath);ui.edit('Set tag value','50');
  assert.equal(ui.field('Require tag write confirmation').props.checked,false);assert.match(ui.content(),/Uses declared command: Change speed/);assert.match(ui.content(),/bounds, readback and required confirmation take precedence/);assert.match(ui.content(),/\[default\]Workshop\/ActualSpeed/);assert.match(ui.content(),/Apply the requested speed\?/);assert.ok(!ui.all().some(node=>node.type==='script-editor'));
  apply(ui);assert.deepEqual(ui.applied[0].tagWrite,{tagPath:command.tagPath,dataType:'Double',value:50});ui.edit('Set tag value','101');apply(ui);assert.equal(ui.applied.length,1);assert.match(ui.content(),/declared command's range of 0 to 100/);
  const conflicting=drive(button,{commands:[command,{...command,id:'also-speed'}]});conflicting.edit('Click action','setTagValue');conflicting.edit('Set tag path',command.tagPath);assert.match(conflicting.content(),/Multiple declared equipment commands/);apply(conflicting);assert.deepEqual(conflicting.applied,[]);assert.match(conflicting.content(),/Use a declared command control/);
});
check('close-popup and equipment symbol activation retain their original supported definitions', () => {
  for(const component of [{...button,props:{action:'closePopup'}},{...base,type:'equipmentSymbol',props:{}},{...base,type:'equipmentSymbol',props:{action:'navigate',targetScreenId:'home'}},{...base,type:'equipmentSymbol',props:{action:'openPopup',targetScreenId:'popup',parameters:{station:'A'}}}]) {
    const ui=drive(component);apply(ui);assert.deepEqual(JSON.parse(JSON.stringify(ui.applied[0])),component.props);
  }
  const ui=drive({...base,type:'equipmentSymbol'});assert.deepEqual(React.Children.toArray(ui.field('Click action').props.children).flatMap(node=>node?.type===React.Fragment?React.Children.toArray(node.props.children):[node]).filter(Boolean).map(node=>node.props.value),['','navigate','openPopup']);
  const nested=drive(button,{popupAllowed:false});nested.edit('Click action','openPopup');apply(nested);assert.match(nested.content(),/cannot open another popup/);
});
check('non-action components retain parameters and unrelated props untouched', () => {
  const component={...base,type:'template',props:{templateId:'t',parameters:{station:'A'},rows:[{id:'r'}],text:'Keep'}};
  const ui=drive(component);ui.code('app.notify("mounted");');apply(ui);assert.deepEqual(ui.applied[0].parameters,component.props.parameters);assert.deepEqual(ui.applied[0].rows,component.props.rows);assert.equal(ui.applied[0].templateId,'t');
});
check('wrappers and password presentation events support Python; password input events remain JavaScript', () => {
  for(const type of ['passwordInput','template','repeater']) {
    const ui=drive({...base,type});for(const label of ['Mounted','Property changed','Unmounted']){ui.nav(label);assert.equal(current(ui).language,'python');assert.deepEqual(React.Children.toArray(ui.field('Event script language').props.children).map(node=>node.props.value),['python','javascript']);}
    ui.nav('Messages');ui.click('Add handler');assert.equal(current(ui).language,'python');assert.doesNotMatch(ui.content(),/must-not-leak/);
    if(type==='passwordInput'){const labels=current(ui).completions.map(item=>item.label);assert.ok(labels.includes('self.enabled'));assert.ok(!labels.includes('self.text'));assert.ok(!labels.includes('self.value'));ui.nav('Value changed');assert.equal(current(ui).language,'javascript');assert.deepEqual(React.Children.toArray(ui.field('Event script language').props.children).map(node=>node.props.value),['javascript']);}
  }
});
check('unmount exposes captured read help and omits UI-write completions', () => {
  const ui=drive();ui.nav('Unmounted');assert.equal(current(ui).language,'python');assert.match(ui.content(),/UI changes are rejected/);assert.match(ui.content(),/captured component/);
  const labels=current(ui).completions.map(item=>item.label);assert.ok(labels.includes('self.text'));assert.ok(labels.includes('system.ui.getState'));assert.ok(!labels.includes('system.ui.setState'));assert.ok(!labels.includes('system.ui.setProperty'));
  selectLanguage(ui,'javascript');assert.ok(!current(ui).completions.some(item=>item.label==='app.setInput'));assert.match(ui.content(),/already aborted/);
});
check('button help explicitly preserves form submission and password input semantics', () => {
  const ui=drive(button);assert.match(ui.content(),/including password inputs/);assert.match(ui.content(),/do not receive an automatic event payload/);assert.doesNotMatch(ui.content(),/must-not-leak/);assert.ok(!current(ui).completions.some(item=>item.label.startsWith('event.')));
});
check('property watches validate across other tabs and maintain selection order', () => {
  const ui=drive();ui.nav('Property changed');ui.code('print(event.value)');ui.watch('y');ui.watch('text');ui.watch('x');ui.watch('text',false);ui.watch('text');ui.nav('Mounted');apply(ui);assert.deepEqual(ui.applied[0].componentEvents.propertyChange.properties,['y','x','text']);
  const invalid=drive({...base,props:{componentEvents:{propertyChange:{language:'python',code:'print(event.value)',properties:['missing']}}}});apply(invalid);assert.deepEqual(invalid.applied,[]);assert.match(invalid.content(),/1–16 unique/);invalid.field('Remove unsupported watched property missing').props.onClick();invalid.refresh();invalid.watch('text');apply(invalid);assert.equal(invalid.applied.length,1);
  const component={...base,type:'progressBar'},many=drive(component);many.nav('Property changed');many.code('print(event.value)');const allowed=componentEventProperties(component);allowed.slice(0,16).forEach(name=>many.watch(name));assert.equal(many.field(`Watch ${allowed[16]}`).props.disabled,true);
});
check('message handlers keep stable identities and independent code across navigation', () => {
  const ui=drive();ui.nav('Messages');ui.click('Add handler');const first=ui.field('Selected message handler').props.value;ui.code('print("first")');ui.click('Add handler');const second=ui.field('Selected message handler').props.value;assert.notEqual(first,second);ui.code('print("second")');ui.edit('Selected message handler',first);assert.equal(current(ui).value,'print("first")');ui.nav('Mounted');ui.nav('Messages');assert.equal(current(ui).value,'print("first")');apply(ui);assert.equal(ui.applied[0].messageHandlers[1].id,second);
  ui.edit('Selected message handler',second);ui.edit('Message handler type','refresh');ui.nav('Unmounted');apply(ui);assert.equal(ui.applied.length,1);assert.match(ui.content(),/already listens/);assert.equal(ui.field('Selected message handler').props.value,second);
  ui.click('Remove handler');apply(ui);assert.equal(ui.applied[1].messageHandlers.length,1);
});
check('invalid JavaScript and oversize Python block all changes without running code', () => {
  const ui=drive(button);ui.nav('Mounted');selectLanguage(ui,'javascript');ui.code('if (');ui.nav('On click');apply(ui);assert.deepEqual(ui.applied,[]);assert.match(ui.content(),/JavaScript syntax/);
  ui.code('globalThis.componentActionsExecuted = true; await Promise.resolve();');apply(ui);assert.equal(ui.applied.length,1);assert.equal(globalThis.componentActionsExecuted,undefined);
  selectLanguage(ui,'python');ui.code('x'.repeat(65537));apply(ui);assert.equal(ui.applied.length,1);assert.match(ui.content(),/65,536/);
});
check('clearing only one script and deleting messages preserve all other definitions', () => {
  const component={...button,props:{...button.props,componentEvents:{mount:{language:'python',code:'print("mount")'},unmount:{language:'python',code:'print("close")'}},messageHandlers:[handler()]}};
  const ui=drive(component);ui.nav('Mounted');ui.code('  ');ui.nav('Messages');ui.click('Remove handler');apply(ui);assert.equal(ui.applied[0].componentEvents.mount,undefined);assert.equal(ui.applied[0].componentEvents.unmount.code,'print("close")');assert.equal(ui.applied[0].script,button.props.script);assert.equal(ui.applied[0].messageHandlers,undefined);
});
check('maximum message count, forged restrictions and invalid native destinations reject consistently', () => {
  const many=Array.from({length:16},(_,index)=>handler({id:`m-${index}`,messageType:`m-${index}`}));const ui=drive({...base,props:{messageHandlers:many}});ui.nav('Messages');assert.equal(ui.find(node=>node.type==='button'&&text(node)==='Add handler').props.disabled,true);
  const secretDraft=componentActionsDraft(secret);secretDraft.scripts.change={language:'python',buffers:{python:'print("bad")',javascript:''}};assert.match(applyComponentActionsDraft(secret,secretDraft,[]).error,/JavaScript only/);
  const draft=componentActionsDraft(button);draft.action='navigate';draft.targetScreenId='missing';assert.match(applyComponentActionsDraft(button,draft,[]).error,/existing destination/);
});
check('Ctrl+S and ScriptEditor save apply the complete draft without leaking the shortcut', () => {
  const ui=drive(button);ui.nav('Mounted');ui.code('print("mounted")');let prevented=false,stopped=false;ui.find(node=>node.type==='dialog').props.onKeyDown({ctrlKey:true,key:'s',preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});assert.ok(prevented&&stopped);assert.equal(ui.applied[0].script,button.props.script);assert.equal(ui.applied[0].componentEvents.mount.code,'print("mounted")');current(ui).onSave();assert.equal(ui.applied.length,2);
});
check('actual Designer has one entry point, one modal and one undoable whole-props Apply', () => {
  const source=fs.readFileSync(new URL('src/App.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let editor;let entries=0;function visit(node){if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(ast)==='ComponentActionsEditor')editor=node;if(ts.isJsxOpeningElement(node)&&node.tagName.getText(ast)==='button'&&node.attributes.properties.some(item=>ts.isJsxAttribute(item)&&item.name.text==='className'&&item.initializer?.text==='button component-actions-open'))entries++;ts.forEachChild(node,visit);}visit(ast);assert.ok(editor);assert.equal(entries,1);assert.doesNotMatch(source,/<(?:InputEventsEditor|ComponentLifecycleEditor|ComponentMessageEditor|ComponentEventEditor)\b/);
  const expression=editor.attributes.properties.find(item=>ts.isJsxAttribute(item)&&item.name.text==='onApply').initializer.expression.getText(ast);
  const original={id:'p',revision:1,screens:[{id:'s',components:[button]}]};let project=structuredClone(original),history={past:[],future:[]},changes=0,closes=0;
  const update=(id,patch)=>{changes++;history=checkpoint(history,project);project={...project,screens:[{...project.screens[0],components:project.screens[0].components.map(item=>item.id===id?{...item,...patch}:item)}]};};
  const props={...button.props,script:'print("changed")',componentEvents:{mount:{language:'python',code:'print("mounted")'}},messageHandlers:[handler()]};
  const invoke=value=>new Function('screen','eventEditorId','updateComponent','setEventEditorId',`return (${expression});`)(project.screens[0],button.id,update,()=>closes++)(value);
  invoke(props);assert.equal(changes,1);assert.equal(closes,1);invoke(props);assert.equal(changes,1);const undone=restoreHistory(history,project,'undo');assert.deepEqual(undone.project,original);assert.deepEqual(restoreHistory(undone.history,undone.project,'redo').project,project);
});
check('handler identity, type, scope and language bounds are retained after consolidation', () => {
  for (const patch of [{id:'x'.repeat(81)},{id:'bad/path'},{id:'1-start'},{messageType:''},{messageType:'x'.repeat(81)},{messageType:'bad\nname'},{messageType:'bad\u0085name'},{scope:'all'},{language:'ruby'}]) assert.ok(validateHandlers([handler(patch)]));
  assert.ok(validateHandlers([handler(),handler({messageType:'other'})]));
  assert.equal(validateHandlers([handler({id:'x'.repeat(80),messageType:'x'.repeat(80),code:' '.repeat(65535)+';'})]),null);
  assert.match(eventScriptError({language:'ruby',code:'x'}),/Choose Python or JavaScript/);
});
check('every component type exposes supported watches and mounted authoring', () => {
  const ast=ts.createSourceFile('types.ts',fs.readFileSync(new URL('src/types.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
  const definition=ast.statements.find(node=>ts.isTypeAliasDeclaration(node)&&node.name.text==='ComponentType');
  for(const member of definition.type.types){const component={...base,type:member.literal.text},ui=drive(component);ui.nav('Property changed');assert.deepEqual(ui.all().filter(node=>node.type==='input'&&node.props.type==='checkbox').map(node=>node.props['aria-label'].slice(6)),componentEventProperties(component,'python'));ui.nav('Mounted');selectLanguage(ui,'javascript');ui.code('app.notify("Mounted");');apply(ui);assert.equal(ui.applied[0].componentEvents.mount.language,'javascript');}
});
check('password JavaScript caption watches survive until explicitly replaced for Python', () => {
  const component={...secret,props:{...secret.props,componentEvents:{propertyChange:{language:'javascript',code:'app.notify(event.value);',properties:['text']}}}},ui=drive(component);
  ui.nav('Property changed');assert.equal(ui.field('Watch text').props.checked,true);apply(ui);assert.equal(ui.applied[0].componentEvents.propertyChange.language,'javascript');
  selectLanguage(ui,'python');ui.code('print(event.value)');apply(ui);assert.equal(ui.applied.length,1);assert.match(ui.content(),/Unsupported property: text/);
  ui.field('Remove unsupported watched property text').props.onClick();ui.refresh();ui.watch('enabled');apply(ui);assert.equal(ui.applied[1].componentEvents.propertyChange.language,'python');
});
check('form value completions distinguish writable fields, bound reads and cleanup reads', () => {
  const ui=drive(input);assert.match(current(ui).completions.find(item=>item.label==='self.value').detail,/stage a typed/);assert.match(ui.content(),/Programmatic writes do not fire change or commit/);
  ui.nav('Unmounted');assert.match(current(ui).completions.find(item=>item.label==='self.value').detail,/read-only/);
  const bound=drive({...input,props:{...input.props,readOnly:true}});assert.match(current(bound).completions.find(item=>item.label==='self.value').detail,/Read current form value/);
  const action=drive(button);assert.ok(current(action).completions.some(item=>item.label==='self.getSibling("quantity").value'||item.label===`self.getSibling(${JSON.stringify(input.id)}).value`));
});
check('common system API completions are shared by components, resources and table commits', () => {
  const names=pythonSystemCompletions.map(item=>item.label),componentNames=pythonEventCompletions([base],[]).map(item=>item.label);
  for(const name of ['system.ui.sendMessage','system.ui.getSessionInfo','system.util.sendMessage','system.util.sendRequest','system.util.sendRequestAsync','system.util.jsonEncode','system.util.jsonDecode','system.date.now','system.db.runNamedQuery'])assert.ok(names.includes(name),name);
  assert.equal(new Set(componentNames).size,componentNames.length);for(const name of names)assert.ok(componentNames.includes(name));
  for(const filename of ['Scripts.tsx','TableEditingEditor.tsx'])assert.match(fs.readFileSync(new URL('src/'+filename,import.meta.url),'utf8'),/\.\.\.pythonSystemCompletions/);
});
check('JavaScript input help only offers implemented helpers and explains its password snapshot', () => {
  const ui=drive(input);selectLanguage(ui,'javascript');let names=current(ui).completions.map(item=>item.label);assert.ok(names.includes('app.signal'));assert.ok(!names.includes('app.onCleanup'));assert.match(ui.content(),/JavaScript input handlers receive the form snapshot including password fields/);
  ui.nav('Mounted');selectLanguage(ui,'javascript');names=current(ui).completions.map(item=>item.label);assert.ok(names.includes('app.onCleanup'));assert.equal(current(ui).completions.find(item=>item.label==='inputs').detail,'Frozen form snapshot; passwords omitted');
});
check('syntax and message help distinguish compile checks, local messages and gateway resources', () => {
  const ui=drive(input);assert.match(ui.content(),/Check syntax compiles Python on the gateway without running code/);ui.nav('Messages');ui.click('Add handler');assert.match(ui.content(),/Gateway system.ui.sendMessage reaches only session-scope handlers/);assert.match(ui.content(),/published gateway message resources/);
});
check('all interaction handlers remain staged with independent languages and preserve existing lifecycle definitions',()=>{
  const original={...base,props:{...base.props,componentEvents:{mount:{language:'javascript',code:'app.notify("original");'}}}},ui=drive(original);
  const interactions=[['focus','Focus gained'],['blur','Focus lost'],['keyDown','Key down'],['keyUp','Key up'],['doubleClick','Double click'],['pointerDown','Pointer down'],['pointerUp','Pointer up']];
  for(const[type,label]of interactions){ui.nav(label);selectLanguage(ui,'javascript');ui.code(`app.notify(${JSON.stringify(type)});`);selectLanguage(ui,'python');ui.code(`print(${JSON.stringify(type)})`);assert.deepEqual(ui.applied,[]);}
  ui.nav('Key down');assert.ok(current(ui).completions.some(item=>item.label==='event.key'));selectLanguage(ui,'javascript');assert.equal(current(ui).value,'app.notify("keyDown");');
  apply(ui);assert.equal(ui.applied.length,1);assert.equal(ui.applied[0].componentEvents.mount.code,'app.notify("original");');
  for(const[type]of interactions)assert.equal(ui.applied[0].componentEvents[type].language,type==='keyDown'?'javascript':'python');
  assert.deepEqual(Object.keys(original.props.componentEvents),['mount']);
});
check('password keyboard authoring permits gateway events but documents redacted keys and exposes no secret values',()=>{
  const ui=drive(secret);ui.nav('Key down');assert.equal(current(ui).language,'python');ui.code('result = event.redacted');
  assert.ok(current(ui).completions.some(item=>item.label==='event.redacted'));assert.match(ui.content(),/empty key\/code and redacted=true/);assert.ok(!ui.content().includes('must-not-leak'));
  apply(ui);assert.equal(ui.applied[0].componentEvents.keyDown.code,'result = event.redacted');
  ui.nav('Pointer up');selectLanguage(ui,'javascript');ui.code('app.notify(event.pointerType);');ui.click('Cancel');assert.equal(ui.applied.length,1);
});
console.log(`${passed}/${passed} unified component action authoring checks passed.`);
