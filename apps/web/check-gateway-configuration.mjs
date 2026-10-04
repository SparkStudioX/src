import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url), uri = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
// Independent hook scopes exercise the authored parent and child callbacks,
// effect cleanup, delayed API responses and conditional tab disposal.
const hooks = uri(`
let scopes=new Map(),current=null,visited=new Set(),effects=[],changed=false,lateWrites=0;
const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>value===b[index]);
const dispose=scope=>{scope.mounted=false;for(const slot of scope.slots)slot?.cleanup?.()};
export const clear=()=>{scopes=new Map();current=null;visited=new Set();effects=[];changed=false;lateWrites=0};
export const begin=()=>{visited=new Set();changed=false};export const dirty=()=>changed;
export const run=(id,callback)=>{let scope=scopes.get(id);if(!scope){scope={id,slots:[],index:0,mounted:true};scopes.set(id,scope)}scope.index=0;visited.add(id);const previous=current;current=scope;try{return callback()}finally{current=previous}};
export const finish=()=>{for(const[id,scope]of scopes)if(!visited.has(id)){dispose(scope);scopes.delete(id)}};
export const useState=initial=>{const scope=current,slots=scope.slots,at=scope.index++;if(!(at in slots)){slots[at]={value:typeof initial==='function'?initial():initial};slots[at].set=value=>{if(!scope.mounted){lateWrites++;return}const next=typeof value==='function'?value(slots[at].value):value;if(!Object.is(next,slots[at].value)){slots[at].value=next;changed=true}}}return[slots[at].value,slots[at].set]};
export const useRef=value=>current.slots[current.index++]??={current:value};
export const useMemo=(callback,deps)=>{const slots=current.slots,at=current.index++;if(!slots[at]||!equal(slots[at].deps,deps))slots[at]={value:callback(),deps};return slots[at].value};
export const useCallback=(callback,deps)=>useMemo(()=>callback,deps);
export const useEffect=(callback,deps)=>{const scope=current,slots=scope.slots,at=scope.index++;if(!slots[at]||!equal(slots[at].deps,deps)){const old=slots[at];slots[at]={effect:callback,deps};effects.push(()=>{if(scope.mounted){old?.cleanup?.();slots[at].cleanup=callback()}})}};
export const useId=()=>{const at=current.index++;return(current.slots[at]??={value:'configuration-'+current.id+'-'+at}).value};
export const flush=()=>effects.splice(0).forEach(callback=>callback());
export const replay=()=>{for(const scope of scopes.values())for(const slot of scope.slots)slot?.cleanup?.();for(const scope of scopes.values())for(const slot of scope.slots)if(slot?.effect)slot.cleanup=slot.effect()};
export const unmount=()=>{for(const scope of scopes.values())dispose(scope);scopes.clear()};
export const updatesAfterUnmount=()=>lateWrites;
`);
const react = pathToFileURL(require.resolve('react')).href;
const api = uri(`export class ApiError extends Error{constructor(message,status){super(message);this.status=status;this.name='ApiError'}}export const api=(...args)=>globalThis.__configurationApi(...args);export const apiUrl=route=>'/api'+route;export const authenticatedFetch=(...args)=>globalThis.__configurationApi(args[0],'FETCH',args[1]);export const assertAuthResponseCurrent=()=>{};export const id=kind=>'new-'+kind;export const displayValue=value=>typeof value==='string'?value:JSON.stringify(value);`);
const shells = {
  Auth: uri('const user={id:"configuration-test"};export const useAuth=()=>({user,gatewayAccess:true,gatewayCapabilities:{configuration:true}});'),
  AskSpark: uri('export const AskSparkLauncher=()=>null;'),
  OperatorAccess: uri('export const SessionIdentity=()=>null;'),
  AccountSettings: uri('export const AccountSettingsDialog=()=>null;'),
  askSparkContext: uri('const entries=new Map();const sync=()=>{globalThis.__configurationAskContext=[...entries.values()].sort((a,b)=>a.priority-b.priority).at(-1)};const registerContext=(owner,getter,priority)=>{const entry={owner,getter,priority};entries.set(owner,entry);sync();return()=>{if(entries.get(owner)===entry){entries.delete(owner);sync()}}};const value={registerContext};export const useAskSpark=()=>value;'),
  App: uri(`import React from ${JSON.stringify(react)};export const Field=({label,hint,children})=>React.createElement('label',null,label,children,hint&&React.createElement('small',null,hint));`),
  Icon: uri('export default function Icon(){return null}'),
  CreationMenu: uri(`import React from ${JSON.stringify(react)};export default function CreationMenu({choices,onSelect}){return React.createElement('div',null,choices.map(choice=>React.createElement('button',{key:choice.value,onClick:()=>onSelect(choice.value)},'Create '+choice.label)))}`),
  TagTransfer: uri(`import React from ${JSON.stringify(react)};export default function TagTransfer({onClose}){return React.createElement('button',{onClick:onClose},'Close transfer')}`),
  TagModels: uri(`import React from ${JSON.stringify(react)};export default function TagModels(props){globalThis.__configurationModelProps=props;return React.createElement('button',{onClick:props.onClose},'Close tag models')}`),
};
const modules = new Map(), compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX };
function load(name) {
  if (shells[name]) return shells[name];
  if (modules.has(name)) return modules.get(name);
  if (name.endsWith('.json')) { const result = uri(`export default ${fs.readFileSync(new URL(`src/${name}`, import.meta.url), 'utf8')};`); modules.set(name, result); return result; }
  const file = ['tsx', 'ts'].map(extension => new URL(`src/${name}.${extension}`, import.meta.url)).find(file => fs.existsSync(file));
  assert.ok(file, `Authored module ${name} exists.`);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dependency) => prefix + JSON.stringify(dependency === 'react' ? hooks : dependency === './api' ? api : dependency.startsWith('./') ? load(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href));
  const result = uri(source); modules.set(name, result); return result;
}
const components = Object.fromEntries(await Promise.all(['GatewayConfiguration', 'Tags', 'ModelsWorkspace', 'DataWorkspace', 'Connections', 'ConnectionDiagnostics', 'OpcCertificates'].map(async name => [name, (await import(load(name))).default])));
const { ApiError } = await import(api);
const draftWorkspace = await import(load('modelWorkspace'));
const navigation = await import(load('modelNavigation'));
const lifecycle = await import(hooks), nativeWindow = globalThis.window, nativeDocument = globalThis.document, nativeStorage = globalThis.sessionStorage;
const nodes = (node, visible = true) => Array.isArray(node) ? node.flatMap(child => nodes(child, visible)) : !node || typeof node !== 'object' || (visible && node.props?.hidden) ? [] : [node, ...nodes(node.props?.children, visible)];
const text = node => Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' || node.props?.hidden ? '' : text(node.props?.children);
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const connections = () => [{ id: 'db', name: 'Production database', type: 'sqlserver', server: 'database.example.test', database: 'Production', enabled: true, revision: 1 }];
const definitions = () => [{ path: '[default]Production/Speed', kind: 'memory', dataType: 'Double', value: 12, enabled: true, publishingIntervalMs: 1000 }];
const certificate = () => ({ store: 'trusted', sha256: 'A'.repeat(64), subject: 'CN=Test OPC server', issuer: 'CN=Test CA', notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' });
const listing = () => ({ certificates: [certificate()], invalidFiles: 0, note: 'Synthetic public certificate fixture.' });
const publicBytes = new Uint8Array([0x30, 31, 0x30, 21, ...Array(21).fill(1), 0x30, 1, 5, 3, 3, 0, 1, 2]);
const publicFile = (arrayBuffer = async () => publicBytes.slice().buffer) => ({ name: 'server.der', size: publicBytes.length, arrayBuffer });
async function start(name, handler, { settled = true, props: given, hash = "#data" } = {}) {
  lifecycle.clear(); let tree, focused = null, nextTimer = 0;
  const events=new EventTarget(),storage=new Map();globalThis.__configurationModelProps=undefined;
  globalThis.sessionStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
  const calls = [], notices = [], changed = [], hosts = new Map(), timers = new Map();
  let props = { connections: connections(), tags: [], onChange: value => { changed.push(value); props = { ...props, connections: value }; }, onTagsChanged: () => changed.push('tags'), notify: (...args) => notices.push(args), ...given };
  globalThis.__configurationApi = async (route, method = 'GET', body) => {
    calls.push({ route, method, body: body && structuredClone(body) });
    const overridden = handler?.(route, method, body); if (overridden !== undefined) return await overridden;
    if (route === '/connections') return structuredClone(method === 'POST' ? body : connections());
    if (route === '/tag-engineering/definitions') return definitions();
    if (route === '/tag-engineering/export') return { scanGroups: [{ name: 'Production', enabled: true, publishingIntervalMs: 1000 }] };
    if (route === '/tag-engineering/values') return [];
    if (route === '/gateway/opcua/certificates') return listing();
    if (route === '/tags' && method === 'POST') return {};
    if (/^\/connections\/[^/]+\/diagnostics$/.test(route)) return { capturedAt: new Date().toISOString(), revision: 1, enabled: true, dependencyCount: 0, omittedDependencies: 0, omittedValues: 0, dependencies: [], values: [], subscriptions: [] };
    throw new Error(`Unexpected configuration API request: ${method} ${route}`);
  };
  const expand = (node, path = 'root', parent = null) => {
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${child?.key ?? index}`, parent));
    if (!node || typeof node !== 'object') return node;
    const identity = `${path}:${node.key ?? ''}:${typeof node.type === 'function' ? node.type.name : String(node.type)}`;
    if (typeof node.type === 'function') return expand(lifecycle.run(identity, () => node.type(node.props)), identity, parent);
    let host = hosts.get(identity); if (!host) { host = { focus: () => { focused = host; }, showModal() {}, close() {} }; hosts.set(identity, host); }
    const result = { ...node, host, props: { ...node.props } }; host.node = result; host.parentElement = parent;
    result.props.children = expand(node.props?.children, identity, host);
    if (typeof node.props.ref === 'function') node.props.ref(host); else if (node.props.ref) node.props.ref.current = host;
    return result;
  };
  globalThis.document = { visibilityState: 'visible' };
  const navigate = (_state, _title, url) => { globalThis.window.location = new URL(url, globalThis.window.location.href); };
  globalThis.window = { location:new URL('http://localhost/gateway'+hash), history:{state:null,pushState:navigate,replaceState:navigate}, addEventListener:events.addEventListener.bind(events), removeEventListener:events.removeEventListener.bind(events), dispatchEvent:events.dispatchEvent.bind(events), setInterval: (callback, delay) => { assert.ok([5000, 15_000, 30_000].includes(delay)); const id = ++nextTimer; timers.set(id, callback); return id; }, clearInterval: id => timers.delete(id) };
  const render = () => { let passes = 0; do { assert.ok(passes++ < 25, 'Configuration effects settle.'); lifecycle.begin(); tree = expand(lifecycle.run(name, () => components[name](props))); lifecycle.finish(); lifecycle.flush(); } while (lifecycle.dirty()); };
  const all = () => nodes(tree);
  const find = (predicate, description) => { const found = all().find(predicate); assert.ok(found, description); return found; };
  const button = label => find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node) === label), `button ${label}`);
  const field = label => { const controls = ['input', 'textarea', 'select']; const direct = all().find(node => controls.includes(node.type) && node.props['aria-label'] === label); if (direct) return direct; return nodes(find(node => node.type === 'label' && text(node).startsWith(label), `label ${label}`)).find(node => controls.includes(node.type)); };
  const invoke = control => { assert.ok(!control.props.disabled, 'Control is enabled.'); const result = control.props.onClick({ currentTarget: control.host }); render(); return result; };
  const click = label => invoke(button(label));
  const change = (label, value) => { const control = field(label); control.props.onChange({ target: control.props.type === 'checkbox' ? { checked: value } : { value } }); render(); };
  const flush = async () => { await settle(); render(); await settle(); render(); };
  render(); if (settled) await flush();
  return { hashChange: next => { window.location.hash=next; window.dispatchEvent(new Event("hashchange")); render(); }, calls, notices, changed, all, find, button, field, click, invoke, change, render, flush, setHandler: next => { handler = next; }, text: () => text(tree), timers: () => timers.size, hide: value => { document.visibilityState = value ? 'hidden' : 'visible'; }, poll: () => { for (const callback of [...timers.values()]) callback(); render(); }, tick: async () => { for (const callback of [...timers.values()]) callback(); await flush(); }, unmount: () => lifecycle.unmount(), replay: () => { lifecycle.replay(); render(); }, selectTag: () => invoke(find(node => node.type === 'button' && node.props.className === 'tag-name-button', 'configured tag selection')), chooseFile: file => { const control = find(node => node.type === 'input' && node.props.type === 'file', 'certificate upload input'); control.props.onChange({ target: { files: file ? [file] : [] } }); render(); }, focused: () => focused?.node };
}
const reads = (ui, route) => ui.calls.filter(call => call.method === 'GET' && call.route === route).length;
const noRefreshButtons = ui => assert.ok(!ui.all().some(node => node.type === 'button' && /\b(refresh|reload)\b/i.test(`${node.props['aria-label'] || ''} ${text(node)}`)), 'Routine refresh/reload buttons are absent.');
let checks = 0;
const check = async (name, run) => { try { await run(); checks++; console.log(`PASS ${name}`); } finally { lifecycle.unmount(); } };
try {
  await check('Ask Spark follows the selected connection tab without exposing credentials or unsaved generated IDs', async () => {
    const ui = await start('Connections');
    const current = () => globalThis.__configurationAskContext.getter();
    assert.equal(globalThis.__configurationAskContext.priority, 20); assert.equal(current().connectionId, 'db'); assert.equal(current().connectionName, 'Production database');
    ui.click('Security'); ui.change('Password', 'synthetic-context-secret'); assert.equal(current().connectionSection, 'security'); assert.equal(current().connectionHasUnsavedChanges, true); assert.equal(current().password, undefined); assert.ok(!JSON.stringify(current()).includes('synthetic-context-secret'));
    ui.click('Create OPC UA client'); assert.equal(current().connectionId, undefined); assert.match(current().connectionName, /New/); assert.equal(current().connectionHasUnsavedChanges, true); assert.equal(current().snapshotToken, undefined);
    ui.unmount(); assert.equal(globalThis.__configurationAskContext, undefined);
  });
  await check('Data tabs link panels, preserve keyboard focus and quietly refresh only visible sections', async () => {
    const ui = await start('GatewayConfiguration'); noRefreshButtons(ui); assert.equal(ui.timers(), 1);
    assert.equal(globalThis.__configurationAskContext.priority, 20); assert.equal(globalThis.__configurationAskContext.getter().section, 'connections');
    assert.equal(ui.all().some(node => node.props?.role === 'tab' && text(node) === 'Tags'), false);
    const initial = reads(ui, '/connections'); await ui.tick(); assert.equal(reads(ui, '/connections'), initial + 1);
    ui.hide(true); await ui.tick(); assert.equal(reads(ui, '/connections'), initial + 1); ui.hide(false);
    const tag = ui.button('Connections'); let prevented = false; tag.props.onKeyDown({ key: 'End', preventDefault: () => { prevented = true; } }); ui.render(); await ui.flush();
    assert.ok(prevented); assert.equal(text(ui.focused()), 'Public OPC certificates'); assert.equal(ui.button('Public OPC certificates').props['aria-selected'], true);
    assert.equal(globalThis.__configurationAskContext.getter().section, 'certificates'); assert.equal(window.location.hash, '#data/certificates');
    const active = ui.button('Public OPC certificates'); assert.ok(ui.all().some(node => node.props.id === active.props['aria-controls'] && node.props.role === 'tabpanel')); const count = reads(ui, '/connections'); await ui.tick(); assert.equal(reads(ui, '/connections'), count); assert.equal(ui.timers(), 1);
    ui.click('Connections'); await ui.flush(); assert.equal(globalThis.__configurationAskContext.priority, 20); assert.equal(globalThis.__configurationAskContext.getter().connectionId, 'db');
  });
  await check('Data deep links select certificates and hash navigation restores the correct child tools', async () => {
    const ui = await start('GatewayConfiguration', undefined, { hash: '#data/certificates' });
    assert.equal(ui.button('Public OPC certificates').props['aria-selected'], true); assert.equal(reads(ui, '/connections'), 0); assert.equal(globalThis.__configurationAskContext.getter().section, 'certificates');
    assert.ok(ui.all().some(node => node.props.role === 'tablist' && node.props['aria-label'] === 'Gateway data'));
    ui.hashChange('#data/connections'); await ui.flush(); assert.equal(ui.button('Connections').props['aria-selected'], true); assert.equal(globalThis.__configurationAskContext.getter().section, 'connections');
    ui.hashChange('#data/certificates'); await ui.flush(); assert.equal(ui.button('Public OPC certificates').props['aria-selected'], true);
    ui.hashChange('#data'); await ui.flush(); assert.equal(ui.button('Connections').props['aria-selected'], true); assert.equal(nodes(ui.all().find(node => node.props.role === 'tablist' && node.props['aria-label'] === 'Gateway data')).filter(node => node.props.role === 'tab').length, 2);
  });
  await check('Configuration failed initial requests expose only contextual Retry and recover together', async () => {
    let failed = true; const ui = await start('GatewayConfiguration', route => route === '/connections' && failed ? Promise.reject(new Error('Configuration unavailable')) : undefined);
    assert.match(ui.text(), /Configuration unavailable/); noRefreshButtons(ui); failed = false; ui.click('Retry'); await ui.flush(); assert.doesNotMatch(ui.text(), /Configuration unavailable/);
    ui.click('Connections'); await ui.flush(); assert.match(ui.text(), /Production database/);
  });
  await check('Tab switches dispose old configuration and tag requests before delayed replies can update another section', async () => {
    const oldConnections = deferred(), oldDefinitions = deferred(); let firstConnections = true, firstDefinitions = true;
    const ui = await start('GatewayConfiguration', route => { if (route === '/connections' && firstConnections) { firstConnections = false; return oldConnections.promise; } if (route === '/tag-engineering/definitions' && firstDefinitions) { firstDefinitions = false; return oldDefinitions.promise; } }, { settled: false });
    ui.click('Public OPC certificates'); await ui.flush(); oldConnections.resolve([{ ...connections()[0], name: 'Outdated connection response' }]); oldDefinitions.resolve([{ ...definitions()[0], path: '[default]Old/Discarded' }]); await ui.flush();
    assert.equal(lifecycle.updatesAfterUnmount(), 0); ui.click('Connections'); await ui.flush(); assert.match(ui.text(), /Production database/); assert.doesNotMatch(ui.text(), /Outdated connection response/);
  });
  await check('Configuration pending requests do not overlap quiet polling and unmount ignores late failures', async () => {
    const pending = deferred(); const ui = await start('GatewayConfiguration', route => route === '/connections' ? pending.promise : undefined, { settled: false });
    ui.poll(); ui.poll(); assert.equal(reads(ui, '/connections'), 1); ui.unmount(); pending.reject(new Error('Disposed request')); await settle(); await settle(); assert.equal(lifecycle.updatesAfterUnmount(), 0); assert.equal(ui.timers(), 0);
  });
  await check('Tag-definition polling pauses for drafts, transfer dialogs and deletion review', async () => {
    const ui = await start('Tags'); noRefreshButtons(ui); const initial = reads(ui, '/tag-engineering/definitions'); await ui.tick(); assert.equal(reads(ui, '/tag-engineering/definitions'), initial + 1);
    ui.click('Import / export'); await ui.tick(); assert.equal(reads(ui, '/tag-engineering/definitions'), initial + 1); ui.click('Close transfer');
    ui.selectTag(); ui.click('Delete tag'); await ui.tick(); assert.equal(reads(ui, '/tag-engineering/definitions'), initial + 1); ui.click('Cancel');
    ui.change('Publishing interval', '2500'); await ui.tick(); assert.equal(reads(ui, '/tag-engineering/definitions'), initial + 1); assert.equal(ui.field('Publishing interval').props.value, 2500);
  });
  await check('an assistant draft reaches the active model immediately without unmounting the workspace', async () => {
    const ui=await start('ModelsWorkspace', undefined, {props:{ownerId:'configuration-test',onApplied(){}}});assert.equal(globalThis.__configurationModelProps.initialDraft,undefined);
    draftWorkspace.openModelDraft({csv:'path,definitionId,version\n[default]A,CNC,1'},'configuration-test');ui.render();
    assert.equal(globalThis.__configurationModelProps.pendingDraft,undefined);assert.match(globalThis.__configurationModelProps.initialDraft.csv,/\[default\]A/);assert.equal(globalThis.__configurationModelProps.ownerId,'configuration-test');assert.equal(draftWorkspace.takeModelDraft('configuration-test'),undefined);
    const first=globalThis.__configurationModelProps.initialDraft;
    draftWorkspace.openModelDraft({csv:'path,definitionId,version\n[default]B,CNC,1'},'configuration-test');ui.render();
    assert.notEqual(globalThis.__configurationModelProps.initialDraft,first);assert.match(globalThis.__configurationModelProps.initialDraft.csv,/\[default\]B/);
  });
  await check('Tags has no nested Models editor and leaves incoming proposals for the Models workspace', async () => {
    const ui=await start('Tags');ui.click('Import / export');draftWorkspace.openModelDraft({csv:'review later'},'configuration-test');ui.render();
    assert.equal(globalThis.__configurationModelProps,undefined);assert.ok(ui.button('Close transfer'));ui.click('Close transfer');assert.equal(globalThis.__configurationModelProps,undefined);assert.equal(draftWorkspace.takeModelDraft('configuration-test').csv,'review later');
  });
  await check('Leaving Tags for Models preserves a draft on Stay and discards only after confirmation', async () => {
    const ui=await start('Tags');ui.selectTag();ui.change('Publishing interval','2500');
    const before=window.location.href;navigation.openModelsWorkspace();assert.equal(window.location.href,before);assert.equal(navigation.modelNavigationSubject(),'Tags');
    navigation.resolveModelNavigation(false);ui.render();assert.equal(ui.field('Publishing interval').props.value,2500);
    navigation.openModelsWorkspace();navigation.resolveModelNavigation(true);ui.render();assert.equal(new URL(window.location.href).searchParams.get('workspace'),'models');
    assert.equal(navigation.modelNavigationDirty(),false);
  });
  await check('The project-independent Models workspace refreshes live values without overlapping or stale updates', async () => {
    let value=1, reply;const ui=await start('DataWorkspace',route=>route==='/tag-engineering/values'?(reply?.promise??[{path:'[default]Speed',value,quality:'Good'}]):undefined);
    assert.equal(globalThis.__configurationModelProps.tags[0].value,1);value=2;await ui.tick();assert.equal(globalThis.__configurationModelProps.tags[0].value,2);
    const before=reads(ui,'/tag-engineering/values');ui.hide(true);await ui.tick();assert.equal(reads(ui,'/tag-engineering/values'),before);ui.hide(false);
    reply=deferred();ui.poll();ui.poll();assert.equal(reads(ui,'/tag-engineering/values'),before+1);
    ui.unmount();reply.resolve([{path:'[default]Speed',value:3,quality:'Good'}]);await settle();await settle();assert.equal(lifecycle.updatesAfterUnmount(),0);assert.equal(ui.timers(),0);
  });
  await check('Tags transfer dialogs require a decision and a pending save cannot be discarded by navigation', async () => {
    const result=deferred();const ui=await start('Tags',(route,method)=>route==='/tags'&&method==='POST'?result.promise:undefined);
    ui.click('Import / export');navigation.openModelsWorkspace();navigation.resolveModelNavigation(false);ui.render();assert.ok(ui.button('Close transfer'));ui.click('Close transfer');
    ui.click('Create Memory tag');ui.change('Tag path','[default]Test/Guard');ui.click('Save');const before=window.location.href;
    navigation.openModelsWorkspace();navigation.resolveModelNavigation(true);ui.render();assert.equal(window.location.href,before);assert.match(ui.text(),/Wait for the tag request/);
    result.resolve({});await ui.flush();
  });
  await check('Tag busy saves and deletes suppress polls and disposed operations cannot load, notify or write state', async () => {
    for (const operation of ['save', 'delete']) {
      const result = deferred(); const ui = await start('Tags', (route, method) => (route === '/tags' && method === 'POST') || (route.startsWith('/tag-definitions?path=') && method === 'DELETE') ? result.promise : undefined);
      if (operation === 'save') { ui.click('Create Memory tag'); ui.change('Tag path', '[default]Test/New'); ui.click('Save'); }
      else { ui.selectTag(); ui.click('Delete tag'); ui.click('Delete tag'); }
      const initial = reads(ui, '/tag-engineering/definitions'); await ui.tick(); assert.equal(reads(ui, '/tag-engineering/definitions'), initial); ui.unmount(); result.resolve({}); await settle(); await settle();
      assert.equal(reads(ui, '/tag-engineering/definitions'), initial); assert.equal(ui.notices.length, 0); assert.equal(ui.changed.length, 0); assert.equal(lifecycle.updatesAfterUnmount(), 0);
    }
  });
  await check('Tag load failure Retry recovers and late disposed loads never write state', async () => {
    let failed = true; const ui = await start('Tags', route => route === '/tag-engineering/definitions' && failed ? Promise.reject(new Error('Tags unavailable')) : undefined); assert.match(ui.text(), /Tags unavailable/); noRefreshButtons(ui); failed = false; ui.click('Retry'); await ui.flush(); assert.doesNotMatch(ui.text(), /Tags unavailable/);
    const pending = deferred(); ui.setHandler(route => route === '/tag-engineering/definitions' ? pending.promise : undefined); ui.poll(); ui.unmount(); pending.resolve([]); await settle(); await settle(); assert.equal(lifecycle.updatesAfterUnmount(), 0);
  });
  await check('Connection Cancel appears only for a draft and failed cancellation preserves edited credentials', async () => {
    let fail = true; const ui = await start('Connections', route => route === '/connections' && fail ? Promise.reject(new Error('Saved connections unavailable')) : undefined); noRefreshButtons(ui); assert.ok(!ui.all().some(node => node.type === 'button' && text(node) === 'Cancel changes'));
    ui.change('Connection name', 'Edited database'); ui.click('Security'); ui.change('Password', 'synthetic-unsaved-password'); ui.click('Cancel changes'); await ui.flush(); assert.equal(ui.field('Password').props.value, 'synthetic-unsaved-password'); ui.click('Connection'); assert.equal(ui.field('Connection name').props.value, 'Edited database'); assert.match(ui.notices.at(-1)[0], /Saved connections unavailable/);
    fail = false; ui.click('Cancel changes'); await ui.flush(); assert.equal(ui.field('Connection name').props.value, 'Production database'); ui.click('Security'); assert.equal(ui.field('Password').props.value, ''); assert.ok(!ui.all().some(node => node.type === 'button' && text(node) === 'Cancel changes'));
  });
  await check('A superseded Connection Cancel never discards newer edits or updates shared connections', async () => {
    const pending = deferred(); const ui = await start('Connections', route => route === '/connections' ? pending.promise : undefined); ui.change('Connection name', 'First draft'); ui.click('Cancel changes'); ui.change('Connection name', 'Newer draft'); pending.resolve(connections()); await ui.flush(); assert.equal(ui.field('Connection name').props.value, 'Newer draft'); assert.equal(ui.changed.length, 0);
  });
  await check('Automatic shared connection updates preserve the selected local draft and secret until successful Cancel', async () => {
    const ui = await start('GatewayConfiguration'); ui.click('Connections'); await ui.flush(); ui.change('Connection name', 'Local connection draft'); ui.click('Security'); ui.change('Password', 'synthetic-staged-secret');
    const latest = [{ ...connections()[0], name: 'Externally updated database', server: 'new.database.example.test', revision: 2 }]; ui.setHandler(route => route === '/connections' ? latest : undefined); await ui.tick();
    assert.equal(ui.field('Password').props.value, 'synthetic-staged-secret'); ui.click('Connection'); assert.equal(ui.field('Connection name').props.value, 'Local connection draft'); assert.match(ui.text(), /Externally updated database/); ui.click('Cancel changes'); await ui.flush();
    assert.equal(ui.field('Connection name').props.value, 'Externally updated database'); assert.equal(ui.field('Server').props.value, 'new.database.example.test'); ui.click('Security'); assert.equal(ui.field('Password').props.value, ''); noRefreshButtons(ui);
  });
  await check('Disposing a Connection Cancel prevents late shared writes, notifications and component state updates', async () => {
    const pending = deferred(); const ui = await start('Connections', route => route === '/connections' ? pending.promise : undefined); ui.change('Connection name', 'Draft'); ui.click('Cancel changes'); ui.unmount(); pending.resolve(connections()); await settle(); await settle(); assert.equal(ui.changed.length, 0); assert.equal(ui.notices.length, 0); assert.equal(lifecycle.updatesAfterUnmount(), 0);
  });
  await check('Connection deletion requires confirmation, sends the saved revision and selects the remaining connection', async () => {
    const remaining = [{ id: 'opc', name: 'Remaining OPC server', type: 'opcua', endpoint: 'opc.tcp://127.0.0.1:4840', revision: 1 }];
    const ui = await start('Connections', (route, method) => method === 'DELETE' ? null : route === '/connections' ? remaining : undefined);
    ui.click('Delete connection'); assert.match(ui.text(), /Delete Production database\?/); assert.match(ui.text(), /Database files are retained/);
    assert.equal(ui.calls.filter(call => call.method === 'DELETE').length, 0); ui.click('Cancel'); assert.equal(ui.calls.filter(call => call.method === 'DELETE').length, 0);
    ui.click('Delete connection'); ui.click('Delete connection'); await ui.flush();
    assert.deepEqual(ui.calls.find(call => call.method === 'DELETE'), { route: '/connections/db', method: 'DELETE', body: { revision: 1 } });
    assert.deepEqual(ui.changed.at(-1), remaining); assert.equal(ui.field('Connection name').props.value, 'Remaining OPC server'); assert.match(ui.notices.at(-1)[0], /Connection deleted/);
  });
  await check('Delete conflicts preserve the connection and show dependencies; sample and unsaved connections cannot be deleted', async () => {
    const ui = await start('Connections', (_route, method) => method === 'DELETE' ? Promise.reject(new ApiError('This connection is used by 1 saved tag reference. Remove it before deleting.', 409)) : undefined);
    ui.click('Delete connection'); ui.click('Delete connection'); await ui.flush(); assert.match(ui.text(), /used by 1 saved tag/); assert.equal(ui.changed.length, 0);
    assert.equal(ui.button('Diagnostics').props['aria-selected'], true); ui.find(node => node.type === 'section' && node.props.className === 'connection-diagnostics', 'visible dependency diagnostics');
    ui.click('Cancel'); ui.click('Connection'); assert.equal(ui.field('Connection name').props.value, 'Production database'); ui.change('Connection name', 'Unsaved change'); assert.equal(ui.button('Delete connection').props.disabled, true);
    ui.click('Create OPC UA client'); assert.ok(!ui.all().some(node => node.type === 'button' && text(node) === 'Delete connection'));
    const sample = await start('Connections', undefined, { props: { connections: [{ id: 'sample', name: 'Sample', type: 'opcua' }] } }); assert.ok(!sample.all().some(node => node.type === 'button' && text(node) === 'Delete connection'));
  });
  await check('Pending deletion prevents editing and selection; successful deletion survives a failed list refresh', async () => {
    const pending = deferred(); const ui = await start('Connections', (route, method) => method === 'DELETE' ? pending.promise : route === '/connections' ? Promise.reject(new Error('List temporarily unavailable')) : undefined);
    ui.click('Delete connection'); ui.click('Delete connection'); ui.change('Connection name', 'Must not replace deletion'); assert.equal(ui.field('Connection name').props.value, 'Production database');
    const item = ui.find(node => node.type === 'button' && node.props.className?.includes('resource-item'), 'selected list item'); assert.equal(item.props.disabled, true);
    pending.resolve(null); await ui.flush(); assert.deepEqual(ui.changed.at(-1), []); assert.match(ui.text(), /Connect to your plant/); assert.match(ui.notices.at(-1)[0], /Connection deleted/);
  });
  await check('Disposing a pending Connection deletion avoids late list reads, notifications and state changes', async () => {
    const pending = deferred(); const ui = await start('Connections', (_route, method) => method === 'DELETE' ? pending.promise : undefined);
    ui.click('Delete connection'); ui.click('Delete connection'); const initial = reads(ui, '/connections'); ui.unmount(); pending.resolve(null); await settle(); await settle();
    assert.equal(reads(ui, '/connections'), initial); assert.equal(ui.changed.length, 0); assert.equal(ui.notices.length, 0); assert.equal(lifecycle.updatesAfterUnmount(), 0);
  });
  await check('An older parent poll cannot restore a deleted connection after the child applies its result', async () => {
    const delayedConnections = deferred(); let pendingPoll = false, current = connections();
    const ui = await start('GatewayConfiguration', (route, method) => {
      if (route === '/connections') { if (pendingPoll) { pendingPoll = false; return delayedConnections.promise; } return structuredClone(current); }
      if (route === '/connections/db' && method === 'DELETE') { current = []; return null; }
    });
    ui.click('Connections'); await ui.flush(); pendingPoll = true; ui.poll(); await settle();
    ui.click('Delete connection'); ui.click('Delete connection'); await ui.flush(); assert.match(ui.text(), /Connect to your plant/);
    delayedConnections.resolve(connections()); await ui.flush(); assert.match(ui.text(), /Connect to your plant/); assert.doesNotMatch(ui.text(), /Production database/);
  });
  await check('Delete fallback retains connections added by a newer parent poll while deletion was pending', async () => {
    const deletion = deferred(); let deleted = false, current = connections();
    const ui = await start('GatewayConfiguration', (route, method) => {
      if (route === '/connections') return deleted ? Promise.reject(new Error('Post-delete listing failed')) : structuredClone(current);
      if (route === '/connections/db' && method === 'DELETE') return deletion.promise.then(() => { deleted = true; return null; });
    });
    ui.click('Connections'); await ui.flush(); ui.click('Delete connection'); ui.click('Delete connection');
    current.push({ id: 'new-db', name: 'Newly added database', type: 'sqlite', database: 'new.db', revision: 1 }); await ui.tick();
    deletion.resolve(null); await ui.flush(); assert.equal(ui.field('Connection name').props.value, 'Newly added database'); assert.doesNotMatch(ui.text(), /Production database/);
  });
  await check('Configuration tab disposal fences pending register-map files and reopening uses the saved map', async () => {
    const point = { id: 'speed', name: 'Speed', address: 'holdingRegister:0', dataType: 'UInt16', writable: false };
    const device = { id: 'plc', name: 'Synthetic PLC', type: 'modbus-tcp', revision: 1, device: { host: '127.0.0.1', port: 502, points: [point] } }, pending = deferred();
    const ui = await start('GatewayConfiguration', route => route === '/connections' ? [device] : undefined);
    ui.click('Connections'); await ui.flush(); ui.click('Register map'); ui.click('Import / edit JSON'); ui.chooseFile({ size: 100, text: () => pending.promise });
    ui.click('Public OPC certificates'); await ui.flush(); pending.resolve(JSON.stringify([{ ...point, id: 'obsolete-import' }])); await ui.flush(); assert.equal(lifecycle.updatesAfterUnmount(), 0);
    ui.click('Connections'); await ui.flush(); ui.click('Register map'); ui.click('Import / edit JSON'); assert.equal(JSON.parse(ui.field('Points JSON').props.value)[0].id, 'speed'); assert.doesNotMatch(ui.text(), /obsolete-import/);
  });
  await check('Connection cancellation and saved-revision refresh fence register-map preparation without changing saved points', async () => {
    const point = { id: 'speed', name: 'Speed', address: 'holdingRegister:0', dataType: 'UInt16', writable: false };
    const device = { id: 'plc', name: 'Synthetic PLC', type: 'modbus-tcp', revision: 1, device: { host: '127.0.0.1', port: 502, points: [point] } };
    const file = deferred(), cancel = deferred();
    const canceled = await start('Connections', route => route === '/connections' ? cancel.promise : undefined, { props: { connections: [device] } });
    canceled.change('Connection name', 'Unsaved PLC'); canceled.click('Register map'); canceled.click('Import / edit JSON'); canceled.chooseFile({ size: 100, text: () => file.promise }); canceled.click('Cancel changes');
    file.resolve(JSON.stringify([{ ...point, id: 'discarded-on-cancel' }])); await canceled.flush(); assert.equal(JSON.parse(canceled.field('Points JSON').props.value)[0].id, 'speed');
    cancel.resolve([device]); await canceled.flush(); assert.equal(canceled.field('Connection name').props.value, 'Synthetic PLC'); canceled.click('Register map'); assert.equal(JSON.parse(canceled.field('Points JSON').props.value)[0].id, 'speed');
    canceled.unmount();
    let current = device; const refreshedFile = deferred();
    const refreshed = await start('GatewayConfiguration', route => route === '/connections' ? [current] : undefined);
    refreshed.click('Connections'); await refreshed.flush(); refreshed.click('Register map'); refreshed.click('Import / edit JSON'); refreshed.chooseFile({ size: 100, text: () => refreshedFile.promise });
    current = { ...device, revision: 2, device: { ...device.device, host: '127.0.0.2' } }; await refreshed.tick();
    refreshedFile.resolve(JSON.stringify([{ ...point, id: 'discarded-on-refresh' }])); await refreshed.flush();
    assert.equal(JSON.parse(refreshed.field('Points JSON').props.value)[0].id, 'speed'); refreshed.click('Connection'); assert.equal(refreshed.field('Controller host').props.value, '127.0.0.2'); assert.equal(lifecycle.updatesAfterUnmount(), 0);
  });
  await check('Connection diagnostics poll only while their section is visible and stop when another section is selected', async () => {
    const ui = await start('Connections'); const route = '/connections/db/diagnostics'; assert.equal(reads(ui, route), 1); assert.equal(ui.timers(), 0);
    assert.ok(!ui.all().some(node => node.props.className === 'connection-diagnostics')); ui.click('Diagnostics'); await ui.flush(); ui.find(node => node.type === 'section' && node.props.className === 'connection-diagnostics', 'visible diagnostics section'); assert.equal(ui.timers(), 2); const opened = reads(ui, route);
    await ui.tick(); assert.equal(reads(ui, route), opened + 1); ui.click('Connection'); await ui.flush(); assert.equal(ui.timers(), 0);
    await ui.tick(); assert.equal(reads(ui, route), opened + 1); assert.doesNotMatch(ui.text(), /Deletion is not available|Dependencies and tag values|Read-only snapshots/);
  });
  await check('OPC discovery shows authentication requirements and does not pin a certificate until an endpoint is chosen', async () => {
    const endpoints = [{ endpointUrl: 'opc.tcp://localhost:49320', securityMode: 'SignAndEncrypt', securityPolicy: 'http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256', serverCertificateSha256: 'A'.repeat(64), userTokenTypes: ['UserName'] }];
    const ui = await start('Connections', route => route.startsWith('/opcua/endpoints?') ? endpoints : undefined);
    ui.click('Create OPC UA client'); ui.change('Server endpoint', 'opc.tcp://localhost:49320'); ui.click('Security'); ui.click('Discover endpoints'); await ui.flush();
    assert.match(ui.text(), /Authentication: Username and password/); assert.equal(ui.field('Server certificate SHA-256 pin').props.value, '');
    ui.click('Use endpoint'); assert.equal(ui.field('Server certificate SHA-256 pin').props.value, 'A'.repeat(64)); assert.match(ui.notices.at(-1)[0], /Verify the certificate fingerprint/);
  });
  await check('Certificate polling recovers failed loads using contextual Retry and does not overlap pending requests', async () => {
    let failed = true; const ui = await start('OpcCertificates', route => route === '/gateway/opcua/certificates' && failed ? Promise.reject(new Error('Certificate listing unavailable')) : undefined); noRefreshButtons(ui); assert.match(ui.text(), /Certificate listing unavailable/); failed = false; ui.click('Retry'); await ui.flush(); assert.doesNotMatch(ui.text(), /Certificate listing unavailable/);
    const pending = deferred(); ui.setHandler(route => route === '/gateway/opcua/certificates' ? pending.promise : undefined); const before = reads(ui, '/gateway/opcua/certificates'); ui.poll(); ui.poll(); assert.equal(reads(ui, '/gateway/opcua/certificates'), before + 1); ui.unmount(); pending.resolve(listing()); await settle(); await settle(); assert.equal(lifecycle.updatesAfterUnmount(), 0);
  });
  await check('Certificate polls pause throughout upload preparation, staged file and trust review', async () => {
    const bytes = deferred(), ui = await start('OpcCertificates'); const initial = reads(ui, '/gateway/opcua/certificates'); ui.chooseFile(publicFile(() => bytes.promise)); await ui.tick(); assert.equal(reads(ui, '/gateway/opcua/certificates'), initial);
    bytes.resolve(publicBytes.slice().buffer); await ui.flush(); await ui.tick(); assert.equal(reads(ui, '/gateway/opcua/certificates'), initial);
    const hash = await crypto.subtle.digest('SHA-256', publicBytes); const fingerprint = Buffer.from(hash).toString('hex').toUpperCase(); ui.change('Independently verified SHA-256', fingerprint); ui.change('I verified this fingerprint', true); ui.click('Review certificate trust'); await ui.tick(); assert.equal(reads(ui, '/gateway/opcua/certificates'), initial); assert.match(ui.text(), /Trust this public certificate/);
    ui.click('Cancel'); ui.chooseFile(undefined); await ui.tick(); assert.equal(reads(ui, '/gateway/opcua/certificates'), initial + 1);
  });
  await check('Certificate removal review pauses polls and canceled review resumes automatic updates', async () => {
    const ui = await start('OpcCertificates'); const initial = reads(ui, '/gateway/opcua/certificates'); ui.click('Remove trust…'); await ui.tick(); assert.equal(reads(ui, '/gateway/opcua/certificates'), initial); ui.click('Cancel'); await ui.tick(); assert.equal(reads(ui, '/gateway/opcua/certificates'), initial + 1);
  });
  await check('Disposed certificate preparation and listing responses cannot write state or revive timers', async () => {
    const raw = deferred(), listingReply = deferred(); const ui = await start('OpcCertificates', route => route === '/gateway/opcua/certificates' ? listingReply.promise : undefined, { settled: false }); ui.chooseFile(publicFile(() => raw.promise)); ui.unmount(); raw.resolve(publicBytes.slice().buffer); listingReply.resolve(listing()); await settle(); await settle(); assert.equal(lifecycle.updatesAfterUnmount(), 0); assert.equal(ui.timers(), 0);
  });
  await check('Configuration, Tags, Connections and certificate lifecycles recover from Strict Mode effect replay', async () => {
    for (const [name, expectedTimers] of [['GatewayConfiguration', 1], ['Tags', 1], ['Connections', 0], ['OpcCertificates', 1]]) {
      const ui = await start(name); ui.replay(); await ui.flush(); assert.equal(ui.timers(), expectedTimers); assert.equal(lifecycle.updatesAfterUnmount(), 0); noRefreshButtons(ui); ui.unmount();
    }
  });
  console.log(`${checks} gateway configuration lifecycle groups passed.`);
} finally { lifecycle.unmount(); globalThis.window = nativeWindow; globalThis.document = nativeDocument; globalThis.sessionStorage=nativeStorage; delete globalThis.__configurationApi; }
