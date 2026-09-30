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
const apiUrl = asModule(`let sequence=0;export const id=prefix=>prefix+'-'+(++sequence);export const resolvePath=value=>value;export const api=async()=>({resources:[]});`);
const modules = new Map();
function url(name) {
  if (modules.has(name)) return modules.get(name);
  const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_full, prefix, _quote, dependency) => `${prefix}${JSON.stringify(dependency === './ScriptEditor' ? scriptUrl : dependency === './api' ? apiUrl : dependency === 'react' ? hookUrl : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
  const result = asModule(code); modules.set(name, result); return result;
}
const hooks = await import(hookUrl), { default: Editor } = await import(url('ComponentActionsEditor'));
const { componentActionsDraft, applyComponentActionsDraft } = await import(url('componentActionsAuthoring'));
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
  hooks.clear(); let tree; const applied = [], closed = [];
  const props = { component, components: [base, input, secret], inputs: { amount: 12, password: 'must-not-leak' }, parameters: { station: 'A' }, screens: [{id:'home',name:'Home'},{id:'popup',name:'Popup',kind:'popup',parameters:{station:''}}], ...extra, onApply: value => applied.push(value), onClose: () => closed.push(true) };
  function expand(node, path = 'root') {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') { hooks.begin(`${path}:${node.type.name}:${node.key || ''}`); return expand(node.type(node.props), `${path}:${node.type.name}`); }
    return { ...node, props: { ...node.props, children: React.Children.toArray(node.props?.children).map((child, index) => expand(child, `${path}:${child?.key || index}`)) } };
  }
  const refresh = () => { tree = expand(React.createElement(Editor, props)); };
  const all = () => nodes(tree), find = predicate => { const node = all().find(predicate); assert.ok(node, 'Expected message editor control'); return node; };
  const field = name => find(node => node.props?.['aria-label'] === name);
  const click = name => { const button = find(node => node.type === 'button' && text(node) === name); assert.ok(!button.props.disabled); button.props.onClick(); refresh(); };
  const edit = (name, value) => { field(name).props.onChange({ target: { value } }); refresh(); };
  const nav = name => { find(node => node.type === 'button' && node.props['aria-pressed'] !== undefined && text(node).startsWith(name)).props.onClick(); refresh(); };
  const watch = (name, checked = true) => { field('Watch '+name).props.onChange({target:{checked}}); refresh(); };
  const code = value => { find(node => node.type === 'script-editor').props.onChange(value); refresh(); };
  refresh(); return { refresh, all, find, field, click, edit, code, nav, watch, applied, closed, props, content: () => text(tree) };
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
console.log(`${passed}/${passed} unified component action authoring checks passed.`);
