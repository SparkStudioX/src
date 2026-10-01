import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url), uri = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
// Run the real parent and children with independent hook scopes. In particular,
// a conditional unmount must dispose the operator editor and lose its draft.
const hooks = uri(`
let scopes=new Map(),current=null,visited=new Set(),effects=[],changed=false,lateWrites=0;
const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>value===b[index]);
const dispose=scope=>{scope.mounted=false;for(const slot of scope.slots)slot?.cleanup?.()};
export const clear=()=>{scopes=new Map();current=null;visited=new Set();effects=[];changed=false;lateWrites=0};
export const begin=()=>{visited=new Set();changed=false}; export const dirty=()=>changed;
export const run=(id,callback)=>{let scope=scopes.get(id);if(!scope){scope={id,slots:[],index:0,mounted:true};scopes.set(id,scope)}scope.index=0;visited.add(id);const previous=current;current=scope;try{return callback()}finally{current=previous}};
export const finish=()=>{for(const[id,scope]of scopes)if(!visited.has(id)){dispose(scope);scopes.delete(id)}};
export const useState=initial=>{const scope=current,slots=scope.slots,at=scope.index++;if(!(at in slots)){slots[at]={value:typeof initial==='function'?initial():initial};slots[at].set=value=>{if(!scope.mounted){lateWrites++;return}const next=typeof value==='function'?value(slots[at].value):value;if(!Object.is(next,slots[at].value)){slots[at].value=next;changed=true;}}}return[slots[at].value,slots[at].set]};
export const useRef=value=>current.slots[current.index++]??={current:value};
export const useMemo=(callback,deps)=>{const slots=current.slots,at=current.index++;if(!slots[at]||!equal(slots[at].deps,deps))slots[at]={value:callback(),deps};return slots[at].value};
export const useCallback=(callback,deps)=>useMemo(()=>callback,deps);
export const useEffect=(callback,deps)=>{const scope=current,slots=scope.slots,at=scope.index++;if(!slots[at]||!equal(slots[at].deps,deps)){const old=slots[at];slots[at]={effect:callback,deps};effects.push(()=>{if(scope.mounted){old?.cleanup?.();slots[at].cleanup=callback()}})}};
export const useId=()=>{const at=current.index++;return(current.slots[at]??={value:'security-field-'+current.id+'-'+at}).value};
export const flush=()=>effects.splice(0).forEach(callback=>callback());
export const unmount=()=>{for(const scope of scopes.values())dispose(scope);scopes.clear()};
export const updatesAfterUnmount=()=>lateWrites;
`);
const api = uri('export const api=(...args)=>globalThis.__securityApi(...args);');
const auth = uri('export const useAuth=()=>({refresh:()=>globalThis.__securityRefresh()});');
const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX };
const authSession = uri(ts.transpileModule(fs.readFileSync(new URL('src/authSession.ts', import.meta.url), 'utf8'), { compilerOptions }).outputText);
const source = ts.transpileModule(fs.readFileSync(new URL('src/Security.tsx', import.meta.url), 'utf8'), { compilerOptions }).outputText
  .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
  .replace(/(from\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dependency) => prefix + JSON.stringify(dependency === 'react' ? hooks : dependency === './api' ? api : dependency === './Auth' ? auth : dependency === './authSession' ? authSession : pathToFileURL(require.resolve(dependency)).href));
const { default: Security } = await import(uri(source));
const lifecycle = await import(hooks);
const nodes = (node, visible = true) => Array.isArray(node) ? node.flatMap(child => nodes(child, visible)) : !node || typeof node !== 'object' || (visible && node.props?.hidden) ? [] : [node, ...nodes(node.props?.children, visible)];
const text = node => Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' || node.props?.hidden ? '' : text(node.props?.children);
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settings = () => ({ revision: 7, publicBaseUrl: 'https://operators.example.test', projectTagPrefixes: { alpha: ['[default]Area A/'], bravo: ['[plant]Packaging/'], retired: ['[legacy]Retained/', '*'] } });
const projects = () => [{ id: 'alpha', name: 'Alpha plant', archived: false }, { id: 'bravo', name: 'Bravo plant', archived: true }];
let checks = 0;
const check = async (name, run) => { try { await run(); checks++; console.log(`PASS ${name}`); } finally { lifecycle.unmount(); } };

async function start({ saved = settings(), catalog = projects(), handler, section = 'security' } = {}) {
  lifecycle.clear();
  let tree, focused = null, refreshes = 0;
  const calls = [], hosts = new Map(), timers = new Map(); let nextTimer = 0;
  globalThis.__securityRefresh = async () => { refreshes++; };
  globalThis.__securityApi = async (route, method = 'GET', body) => {
    calls.push({ route, method, body: body && structuredClone(body) });
    if (handler) {
      const value = handler(route, method, body);
      if (value !== undefined) return await value;
    }
    if (route === '/security/settings') return structuredClone(method === 'PUT' ? { ...body, revision: body.revision + 1 } : saved);
    if (route === '/projects') return { projects: structuredClone(catalog), defaultProjectId: catalog[0]?.id ?? null };
    if (route === '/security/users') return { users: [] };
    if (route === '/security/audit?limit=100') return { entries: [] };
    throw new Error(`Unexpected request: ${method} ${route}`);
  };
  // Only host focus and refs are modeled. Assertions still exercise the real
  // tab keyboard handlers, aria attributes and conditional component lifetime.
  const expand = (node, path = 'root', parent = null) => {
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${child?.key ?? index}`, parent));
    if (!node || typeof node !== 'object') return node;
    const identity = `${path}:${node.key ?? ''}:${typeof node.type === 'function' ? node.type.name : String(node.type)}`;
    if (typeof node.type === 'function') return expand(lifecycle.run(identity, () => node.type(node.props)), identity, parent);
    let host = hosts.get(identity);
    if (!host) {
      host = { focus: () => { focused = host; }, showModal() {}, close() {}, querySelectorAll: selector => nodes(host.node, false).filter(child => selector === '[role="tab"]' && child.props.role === 'tab').map(child => child.host) };
      hosts.set(identity, host);
    }
    const result = { ...node, host, props: { ...node.props } };
    host.node = result; host.parentElement = parent;
    result.props.children = expand(node.props?.children, identity, host);
    const ref = node.props?.ref;
    if (typeof ref === 'function') ref(host); else if (ref) ref.current = host;
    return result;
  };
  globalThis.document = { visibilityState: 'visible', getElementById: id => [...hosts.values()].find(host => host.node.props.id === id) ?? null };
  globalThis.window = { setInterval: (callback, delay) => { assert.equal(delay, 15_000); const id = ++nextTimer; timers.set(id, callback); return id; }, clearInterval: id => timers.delete(id) };
  const render = () => {
    let passes = 0;
    do {
      assert.ok(passes++ < 20, 'Effects must settle.');
      lifecycle.begin(); tree = expand(lifecycle.run('security', () => Security({ section })));
      lifecycle.finish(); lifecycle.flush();
    } while (lifecycle.dirty());
  };
  const all = () => nodes(tree);
  const find = (predicate, description) => { const found = all().find(predicate); assert.ok(found, description); return found; };
  const button = label => find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node) === label), `button ${label}`);
  const field = label => {
    const controls = ['input', 'textarea', 'select'];
    const direct = all().find(node => controls.includes(node.type) && node.props['aria-label'] === label);
    if (direct) return direct;
    const enclosing = find(node => node.type === 'label' && text(node).startsWith(label), `field ${label}`);
    return nodes(enclosing).find(node => controls.includes(node.type)) ?? find(node => controls.includes(node.type) && node.props.id === enclosing.props.htmlFor, `input for ${label}`);
  };
  const invoke = control => {
    if (control.props.onClick) return control.props.onClick({ currentTarget: control.host });
    const form = find(node => node.type === 'form' && nodes(node).includes(control), 'form for submit button');
    return form.props.onSubmit({ preventDefault() {} });
  };
  const click = label => { const control = button(label); assert.ok(!control.props.disabled, `${label} is enabled`); invoke(control); render(); };
  const change = (label, value) => { const control = field(label); assert.ok(!control.props.disabled, `${label} is enabled`); control.props.onChange({ target: { value } }); render(); };
  const flush = async () => { await settle(); render(); await settle(); render(); };
  const key = (label, key) => {
    const control = button(label); let prevented = false;
    control.props.onKeyDown({ key, currentTarget: control.host, preventDefault() { prevented = true; } }); render();
    return prevented;
  };
  render(); await flush();
  return { calls, render, flush, button, field, click, change, invoke, key, all, tick: async () => { for (const callback of [...timers.values()]) callback(); await flush(); }, hide: hidden => { globalThis.document.visibilityState = hidden ? 'hidden' : 'visible'; }, timers: () => timers.size, text: () => text(tree), focused: () => focused?.node, refreshes: () => refreshes, mounted: () => nodes(tree, false) };
}
const operator = async options => { const ui = await start(options); ui.click('Operator settings'); await ui.flush(); return ui; };
const writes = ui => ui.calls.filter(call => call.method === 'PUT');
const settingsReads = ui => ui.calls.filter(call => call.method === 'GET' && call.route === '/security/settings');
const routineReads = (ui, view) => ui.calls.filter(call => call.method === 'GET' && call.route === (view === 'audit' ? '/security/audit?limit=100' : '/security/users'));
const noRefreshButtons = ui => assert.ok(!ui.all().some(node => node.type === 'button' && /refresh|reload/i.test(`${node.props['aria-label'] || ''} ${text(node)}`)), 'Routine Refresh/Reload buttons are absent.');

await check('Security tabs expose linked panels and keyboard navigation moves the active tab and focus', async () => {
  const ui = await start();
  const tabs = () => ui.all().filter(node => node.props.role === 'tab');
  assert.equal(tabs().length, 2);
  assert.equal(ui.all().filter(node => node.props.role === 'tablist').length, 1);
  const active = label => {
    assert.equal(ui.button(label).props['aria-selected'], true);
    assert.equal(ui.button(label).props.tabIndex, 0);
    assert.equal(tabs().filter(node => node.props.tabIndex === 0).length, 1);
    for (const tab of tabs()) {
      assert.equal(tab.props.tabIndex, tab.props['aria-selected'] ? 0 : -1);
      const panel = ui.mounted().find(node => node.props.id === tab.props['aria-controls']);
      assert.ok(panel, `panel for ${text(tab)}`); assert.equal(panel.props.role, 'tabpanel'); assert.equal(panel.props['aria-labelledby'], tab.props.id);
    }
  };
  active('Users & access');
  noRefreshButtons(ui);
  for (const [from, key, to] of [['Users & access', 'ArrowRight', 'Operator settings'], ['Operator settings', 'ArrowRight', 'Users & access'], ['Users & access', 'ArrowLeft', 'Operator settings'], ['Operator settings', 'Home', 'Users & access'], ['Users & access', 'End', 'Operator settings']]) {
    assert.equal(ui.key(from, key), true); await ui.flush(); active(to); assert.equal(text(ui.focused()), to);
  }
  assert.equal(ui.key('Operator settings', 'Escape'), false); active('Operator settings');
});

await check('two project drafts, URL and retained mappings save atomically with exact prefix semantics', async () => {
  const saved = settings(), original = structuredClone(saved), ui = await operator({ saved });
  ui.click('Edit tag access Alpha plant');
  assert.equal(ui.button('Edit tag access Alpha plant').props['aria-pressed'], true);
  ui.change('Tag-path prefixes', '  [default]MixedCase/Line A/  \r\n\r\n  *  \n [Plant]Upper/ ');
  ui.click('Edit tag access Bravo plant'); ui.change('Tag-path prefixes', ' \r\n\t\n ');
  ui.change('Public operator base URL', '  https://operators.new.test  ');
  ui.click('Edit tag access Alpha plant');
  assert.equal(ui.field('Tag-path prefixes').props.value, '  [default]MixedCase/Line A/  \r\n\r\n  *  \n [Plant]Upper/ ');
  ui.click('Save operator settings'); await ui.flush();
  assert.equal(writes(ui).length, 1);
  assert.deepEqual(writes(ui)[0], { route: '/security/settings', method: 'PUT', body: { revision: 7, publicBaseUrl: 'https://operators.new.test', projectTagPrefixes: { alpha: ['[default]MixedCase/Line A/', '*', '[Plant]Upper/'], bravo: [], retired: original.projectTagPrefixes.retired } } });
  assert.deepEqual(saved, original, 'Editing must not mutate the loaded gateway snapshot.');
  assert.equal(ui.button('Save operator settings').props.disabled, true);
  ui.change('Public operator base URL', ''); ui.click('Save operator settings'); await ui.flush();
  assert.equal(writes(ui)[1].body.revision, 8); assert.equal(writes(ui)[1].body.publicBaseUrl, null);
});

await check('project selection, searches, Security tabs and automatic account updates preserve staged operator settings', async () => {
  const ui = await operator();
  ui.click('Edit tag access Alpha plant'); ui.change('Tag-path prefixes', '[default]StagedAlpha/');
  ui.click('Edit tag access Bravo plant'); ui.change('Tag-path prefixes', '[plant]StagedBravo/');
  ui.change('Public operator base URL', 'https://staged.example.test');
  ui.change('Search projects', 'Alpha');
  assert.equal(ui.field('Tag-path prefixes').props.value, '[plant]StagedBravo/', 'Filtering out the selected row must retain its editor.');
  const reads = settingsReads(ui).length;
  ui.click('Users & access'); assert.ok(!ui.all().some(node => node.type === 'textarea'));
  assert.equal(ui.mounted().filter(node => node.type === 'textarea').length, 1, 'The operator editor must remain mounted while hidden.');
  await ui.flush(); const accountReads = routineReads(ui, 'users').length; await ui.tick();
  assert.equal(routineReads(ui, 'users').length, accountReads + 1);
  ui.click('Operator settings'); await ui.flush();
  assert.equal(settingsReads(ui).length, reads, 'Account refresh and tab switches must not reload saved settings over the draft.');
  assert.equal(ui.field('Public operator base URL').props.value, 'https://staged.example.test');
  assert.equal(ui.field('Search projects').props.value, 'Alpha'); assert.equal(ui.field('Tag-path prefixes').props.value, '[plant]StagedBravo/');
  ui.change('Search projects', ''); ui.click('Edit tag access Alpha plant'); assert.equal(ui.field('Tag-path prefixes').props.value, '[default]StagedAlpha/');
  ui.click('Edit tag access Bravo plant'); assert.equal(ui.field('Tag-path prefixes').props.value, '[plant]StagedBravo/');
  assert.equal(writes(ui).length, 0); noRefreshButtons(ui);
});

await check('Cancel discards staged fields and retrieves the latest saved configuration and revision', async () => {
  const latest = { ...settings(), revision: 9, publicBaseUrl: 'https://latest.example.test', projectTagPrefixes: { ...settings().projectTagPrefixes, alpha: ['[default]Latest/'] } };
  let reads = 0;
  const ui = await operator({ handler: (route, method) => route === '/security/settings' && method === 'GET' && ++reads > 1 ? structuredClone(latest) : undefined });
  ui.click('Edit tag access Alpha plant'); ui.change('Tag-path prefixes', '*');
  ui.click('Edit tag access Bravo plant'); ui.change('Tag-path prefixes', ''); ui.change('Public operator base URL', 'https://staged.example.test');
  ui.click('Cancel changes'); assert.equal(ui.field('Public operator base URL').props.disabled, true); await ui.flush();
  assert.equal(ui.field('Public operator base URL').props.value, latest.publicBaseUrl);
  ui.click('Edit tag access Alpha plant'); assert.equal(ui.field('Tag-path prefixes').props.value, '[default]Latest/');
  ui.click('Edit tag access Bravo plant'); assert.equal(ui.field('Tag-path prefixes').props.value, '[plant]Packaging/');
  assert.equal(ui.button('Save operator settings').props.disabled, true);
  assert.equal(settingsReads(ui).length, 2); assert.equal(writes(ui).length, 0); assert.match(ui.text(), /Revision 9/);
  ui.change('Public operator base URL', 'https://reviewed.example.test'); ui.click('Save operator settings'); await ui.flush(); assert.equal(writes(ui)[0].body.revision, 9);
  noRefreshButtons(ui);
});

await check('101 projects have bounded pages and filtering never discards an off-page selected draft', async () => {
  const catalog = Array.from({ length: 101 }, (_, index) => ({ id: `project-${index}`, name: `Project ${String(index).padStart(3, '0')}`, archived: index === 75 }));
  const ui = await operator({ catalog });
  const rows = () => ui.all().filter(node => node.type === 'button' && node.props['aria-label']?.startsWith('Edit tag access '));
  assert.equal(rows().length, 50); assert.match(ui.text(), /Page 1 of 3/);
  ui.click('Edit tag access Project 000'); ui.change('Tag-path prefixes', '[default]First/');
  ui.click('Next projects'); assert.equal(rows().length, 50); assert.match(ui.text(), /Page 2 of 3/);
  assert.equal(ui.field('Tag-path prefixes').props.value, '[default]First/');
  ui.click('Edit tag access Project 075'); ui.change('Tag-path prefixes', '*'); assert.match(text(ui.button('Edit tag access Project 075')), /archived/i);
  assert.match(text(ui.button('Edit tag access Project 075')), /All gateway tags/);
  ui.click('Next projects'); assert.equal(rows().length, 1); assert.match(ui.text(), /Page 3 of 3/); assert.equal(ui.button('Next projects').props.disabled, true);
  assert.equal(ui.field('Tag-path prefixes').props.value, '*');
  ui.change('Search projects', 'Project 000'); assert.equal(rows().length, 1); assert.match(ui.text(), /Page 1 of 1/);
  assert.equal(ui.field('Tag-path prefixes').props.value, '*'); ui.click('Edit tag access Project 000'); assert.equal(ui.field('Tag-path prefixes').props.value, '[default]First/');
  ui.change('Search projects', 'not present'); assert.equal(rows().length, 0); assert.match(ui.text(), /No projects match/i);
  assert.equal(ui.field('Tag-path prefixes').props.value, '[default]First/');
  ui.change('Search projects', ''); assert.equal(rows().length, 50);
  ui.click('Next projects'); ui.click('Edit tag access Project 075'); assert.equal(ui.field('Tag-path prefixes').props.value, '*');
  assert.equal(writes(ui).length, 0);
});

await check('native save failures preserve all draft values and the reviewed revision for retry', async () => {
  for (const failure of ['The public operator URL must not contain credentials.', 'Settings changed. Reload before saving.']) {
    lifecycle.unmount();
    const ui = await operator({ handler: (route, method) => { if (route === '/security/settings' && method === 'PUT') return Promise.reject(new Error(failure)); } });
    ui.click('Edit tag access Alpha plant'); ui.change('Tag-path prefixes', '[default]Keep/');
    ui.click('Edit tag access Bravo plant'); ui.change('Tag-path prefixes', '*'); ui.change('Public operator base URL', 'https://draft.example.test');
    ui.click('Save operator settings'); await ui.flush();
    assert.ok(ui.text().includes(failure)); assert.equal(writes(ui)[0].body.revision, 7);
    assert.equal(ui.field('Public operator base URL').props.value, 'https://draft.example.test'); assert.equal(ui.field('Tag-path prefixes').props.value, '*');
    ui.click('Edit tag access Alpha plant'); assert.equal(ui.field('Tag-path prefixes').props.value, '[default]Keep/');
    noRefreshButtons(ui); assert.equal(ui.button('Cancel changes').props.disabled, false); assert.equal(ui.button('Save operator settings').props.disabled, false);
    ui.click('Save operator settings'); await ui.flush(); assert.equal(writes(ui)[1].body.revision, 7); assert.deepEqual(writes(ui)[1].body, writes(ui)[0].body);
  }
});

await check('a repeated submit before rendering issues one atomic write and locks pending edits', async () => {
  const pending = deferred(), ui = await operator({ handler: (route, method) => route === '/security/settings' && method === 'PUT' ? pending.promise : undefined });
  ui.change('Public operator base URL', 'https://draft.example.test');
  const save = ui.button('Save operator settings'); ui.invoke(save); ui.invoke(save); ui.render();
  assert.equal(writes(ui).length, 1); assert.equal(ui.field('Public operator base URL').props.disabled, true);
  assert.equal(ui.button('Cancel changes').props.disabled, true); noRefreshButtons(ui);
  pending.resolve({ ...writes(ui)[0].body, revision: 8 }); await ui.flush();
  assert.equal(ui.button('Save operator settings').props.disabled, true);
});

await check('invalid prefixes block the shared save even while a different project is selected', async () => {
  const ui = await operator();
  for (const invalid of ['[default]Duplicate/\n[default]Duplicate/', '[default]Bad\u0001Path/', 'x'.repeat(513), Array.from({ length: 101 }, (_, index) => `[default]Scope${index}/`).join('\n')]) {
    ui.click('Edit tag access Alpha plant'); ui.change('Tag-path prefixes', invalid);
    ui.click('Edit tag access Bravo plant');
    assert.equal(ui.button('Save operator settings').props.disabled, true); assert.match(ui.text(), /Alpha plant:.*prefixes/);
    ui.invoke(ui.button('Save operator settings')); await ui.flush(); assert.equal(writes(ui).length, 0);
    ui.click('Cancel changes'); await ui.flush();
  }
  ui.click('Edit tag access Alpha plant'); ui.change('Tag-path prefixes', '[default]Case/\n[default]case/');
  assert.equal(ui.button('Save operator settings').props.disabled, false, 'Case-sensitive distinct prefixes are valid.');
  ui.click('Save operator settings'); await ui.flush(); assert.deepEqual(writes(ui)[0].body.projectTagPrefixes.alpha, ['[default]Case/', '[default]case/']);
});

await check('settings load has a distinct loading state, hides the editor on failure and supports retry', async () => {
  const pending = deferred(); let attempts = 0;
  const ui = await start({ handler: (route, method) => {
    if (route !== '/security/settings' || method !== 'GET') return undefined;
    attempts++; return attempts === 1 ? pending.promise : structuredClone(settings());
  } });
  ui.click('Operator settings'); assert.match(ui.text(), /Loading operator settings/);
  assert.ok(!ui.all().some(node => node.type === 'textarea' || node.type === 'input' && node.props.type === 'url'));
  pending.resolve(Promise.reject(new Error('Operator settings temporarily unavailable.'))); await ui.flush();
  assert.match(ui.text(), /Operator settings temporarily unavailable/);
  assert.ok(!ui.all().some(node => node.type === 'textarea' || node.type === 'input' && node.props.type === 'url'));
  ui.click('Retry operator settings'); await ui.flush();
  assert.equal(attempts, 2); assert.equal(ui.field('Public operator base URL').props.value, settings().publicBaseUrl);
  assert.equal(ui.button('Save operator settings').props.disabled, true); assert.equal(writes(ui).length, 0);
});

await check('account and audit observations update automatically only while visible, without overlapping requests', async () => {
  for (const view of ['users', 'audit']) {
    lifecycle.unmount();
    const route = view === 'users' ? '/security/users' : '/security/audit?limit=100', pending = deferred(); let reads = 0;
    const ui = await start({ section: view === 'audit' ? 'audit' : 'security', handler: (candidate, method) => candidate === route && method === 'GET' && ++reads === 2 ? pending.promise : undefined });
    noRefreshButtons(ui); assert.equal(ui.timers(), 1); assert.equal(reads, 1);
    ui.hide(true); await ui.tick(); assert.equal(reads, 1, 'A hidden browser does not poll.');
    ui.hide(false); await ui.tick(); assert.equal(reads, 2);
    await ui.tick(); assert.equal(reads, 2, 'Only one observation per view can be in flight.');
    pending.resolve(view === 'users' ? { users: [] } : { entries: [{ id: 'event-1', recordedAt: '2026-09-30T00:00:00Z', actor: 'Synthetic observer', action: 'Test observation', projectId: null, outcome: 'Succeeded', targetUserId: null }] });
    await ui.flush(); if (view === 'audit') assert.match(ui.text(), /Test observation/);
    await ui.tick(); assert.equal(reads, 3); noRefreshButtons(ui);
  }
});

await check('account dialogs pause observation and reject an already pending response without changing form values', async () => {
  const pending = deferred(); let reads = 0;
  const ui = await start({ handler: (route, method) => route === '/security/users' && method === 'GET' && ++reads === 2 ? pending.promise : undefined });
  await ui.tick(); assert.equal(reads, 2);
  ui.click('New user'); ui.change('Display name', 'Staged account name'); assert.equal(ui.timers(), 0);
  await ui.tick(); assert.equal(reads, 2);
  pending.resolve({ users: [{ id: 'injected', username: 'ServerInjected', displayName: 'ServerInjected', gatewayAdmin: false, disabled: false, revision: 1, projectGrants: {}, createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' }] });
  await ui.flush(); assert.equal(ui.field('Display name').props.value, 'Staged account name'); assert.ok(!ui.text().includes('ServerInjected'));
  ui.click('Cancel'); await ui.flush(); assert.equal(ui.timers(), 1); assert.equal(reads, 3); assert.equal(writes(ui).length, 0);
});

await check('Cancel retrieval failures retain the previous saved baseline and offer contextual recovery to the latest revision', async () => {
  const latest = { ...settings(), revision: 11, publicBaseUrl: 'https://recovered.example.test' }; let reads = 0;
  const ui = await operator({ handler: (route, method) => {
    if (route !== '/security/settings' || method !== 'GET') return undefined;
    if (++reads === 2) return Promise.reject(new Error('Saved settings temporarily unavailable.'));
    if (reads > 2) return structuredClone(latest);
  } });
  ui.change('Public operator base URL', 'https://discard.example.test'); ui.click('Cancel changes'); await ui.flush();
  assert.equal(ui.field('Public operator base URL').props.value, settings().publicBaseUrl); assert.match(ui.text(), /Saved settings temporarily unavailable/);
  assert.equal(ui.button('Save operator settings').props.disabled, true); assert.equal(ui.button('Retry operator settings').props.disabled, false);
  ui.click('Retry operator settings'); await ui.flush(); assert.equal(ui.field('Public operator base URL').props.value, latest.publicBaseUrl); assert.match(ui.text(), /Revision 11/);
  noRefreshButtons(ui); assert.equal(writes(ui).length, 0);
});

await check('automatic observations and pending cancellation cannot write state after unmount', async () => {
  const observed = deferred(); let reads = 0;
  const observer = await start({ handler: (route, method) => route === '/security/users' && method === 'GET' && ++reads === 2 ? observed.promise : undefined });
  await observer.tick(); lifecycle.unmount(); assert.equal(observer.timers(), 0); observed.resolve({ users: [] }); await settle();
  assert.equal(lifecycle.updatesAfterUnmount(), 0);
  const canceled = deferred(); let attempts = 0;
  const editor = await operator({ handler: (route, method) => route === '/security/settings' && method === 'GET' && ++attempts === 2 ? canceled.promise : undefined });
  editor.change('Public operator base URL', 'https://discard.example.test'); const cancel = editor.button('Cancel changes'); editor.invoke(cancel); editor.invoke(cancel); editor.render();
  assert.equal(attempts, 2, 'Repeated cancellation before rendering performs one saved-settings read.');
  lifecycle.unmount(); canceled.resolve(settings()); await settle(); assert.equal(lifecycle.updatesAfterUnmount(), 0);
});

await check('an empty project catalog still permits URL changes and preserves unknown saved scopes', async () => {
  const saved = settings(), ui = await operator({ saved, catalog: [] });
  assert.match(ui.text(), /No projects (?:are )?available/i);
  assert.equal(ui.all().filter(node => node.type === 'textarea').length, 0);
  ui.change('Public operator base URL', 'https://empty.example.test'); ui.click('Save operator settings'); await ui.flush();
  assert.equal(writes(ui).length, 1); assert.deepEqual(writes(ui)[0].body.projectTagPrefixes, saved.projectTagPrefixes);
});

await check('late load and save responses cannot write state after the Security view unmounts', async () => {
  const loadPending = deferred();
  const loading = await start({ handler: (route, method) => route === '/security/settings' && method === 'GET' ? loadPending.promise : undefined });
  loading.click('Operator settings'); lifecycle.unmount(); loadPending.resolve(settings()); await settle();
  assert.equal(lifecycle.updatesAfterUnmount(), 0);
  const savePending = deferred();
  const saving = await operator({ handler: (route, method) => route === '/security/settings' && method === 'PUT' ? savePending.promise : undefined });
  saving.change('Public operator base URL', 'https://pending.example.test'); saving.click('Save operator settings');
  lifecycle.unmount(); savePending.resolve({ ...writes(saving)[0].body, revision: 8 }); await settle();
  assert.equal(lifecycle.updatesAfterUnmount(), 0); assert.equal(saving.refreshes(), 0);
});

delete globalThis.__securityApi;
delete globalThis.__securityRefresh;
delete globalThis.document;
delete globalThis.window;
console.log(`${checks} Security settings groups passed.`);
