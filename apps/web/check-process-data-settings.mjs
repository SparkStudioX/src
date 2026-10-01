import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const require = createRequire(import.meta.url), uri = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const hooks = uri(`
let scopes=new Map(),current=null,visited=new Set(),effects=[],changed=false,lateWrites=0;
const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>value===b[index]);
const dispose=scope=>{scope.mounted=false;for(const slot of scope.slots)slot?.cleanup?.()};
export const clear=()=>{scopes=new Map();current=null;visited=new Set();effects=[];changed=false;lateWrites=0};
export const begin=()=>{visited=new Set();changed=false}; export const dirty=()=>changed;
export const run=(id,callback)=>{let scope=scopes.get(id);if(!scope){scope={id,slots:[],index:0,mounted:true};scopes.set(id,scope)}scope.index=0;visited.add(id);const previous=current;current=scope;try{return callback()}finally{current=previous}};
export const finish=()=>{for(const[id,scope]of scopes)if(!visited.has(id)){dispose(scope);scopes.delete(id)}};
export const useState=initial=>{const scope=current,slots=scope.slots,at=scope.index++;if(!(at in slots))slots[at]={value:typeof initial==='function'?initial():initial};return[slots[at].value,value=>{if(!scope.mounted){lateWrites++;return}const next=typeof value==='function'?value(slots[at].value):value;if(!Object.is(next,slots[at].value)){slots[at].value=next;changed=true;}}]};
export const useRef=value=>current.slots[current.index++]??={current:value};
export const useMemo=(callback,deps)=>{const slots=current.slots,at=current.index++;if(!slots[at]||!equal(slots[at].deps,deps))slots[at]={value:callback(),deps};return slots[at].value};
export const useCallback=(callback,deps)=>useMemo(()=>callback,deps);
export const useEffect=(callback,deps)=>{const scope=current,slots=scope.slots,at=scope.index++;if(!slots[at]||!equal(slots[at].deps,deps)){const old=slots[at];slots[at]={effect:callback,deps};effects.push(()=>{if(scope.mounted){old?.cleanup?.();slots[at].cleanup=callback()}})}};
export const useId=()=>{const at=current.index++;return(current.slots[at]??={value:'process-field-'+current.id+'-'+at}).value};
export const flush=()=>effects.splice(0).forEach(callback=>callback());
export const unmount=()=>{for(const scope of scopes.values())dispose(scope);scopes.clear()};
export const updatesAfterUnmount=()=>lateWrites;
`);
const api = uri(`export const api = (...args) => globalThis.__processApi(...args);`);
const source = ts.transpileModule(fs.readFileSync(new URL('src/GatewayProcessData.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
  .replace(/(from\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dependency) => prefix + JSON.stringify(dependency === 'react' ? hooks : dependency === './api' ? api : pathToFileURL(require.resolve(dependency)).href));
const { processDataError, default: Settings } = await import(uri(source));
const lifecycle = await import(hooks);
const config = () => ({ revision: 4, alarmRetentionDays: 7, alarms: [{ id: 'high', name: 'High', tagPath: '[default]Workshop/Value', enabled: true, mode: 'high', setpoint: 80, deadband: 5, priority: 3 }], history: [{ tagPath: '[default]Workshop/Value', enabled: true, deadband: 0.5, maxIntervalMs: 1000, retentionDays: 7 }] });
let checks = 0;
const check = async (name, run) => { try { await run(); checks++; console.log(`PASS ${name}`); } finally { lifecycle.unmount(); } };
await check('saved rules and their bounded numeric fields are validated before Save', () => {
  assert.equal(processDataError(config()), null);
  for (const edit of [x => x.alarmRetentionDays = 0, x => x.alarmRetentionDays = 7.5, x => x.alarms[0].id = 'bad id', x => x.alarms.push(x.alarms[0]), x => x.alarms[0].tagPath = '[default]{station}/Value', x => x.alarms[0].setpoint = Number.NaN, x => x.alarms[0].deadband = -1, x => x.alarms[0].priority = 5, x => x.history.push(x.history[0]), x => x.history[0].maxIntervalMs = 249, x => x.history[0].maxIntervalMs = 1000.5, x => x.history[0].retentionDays = 3651, x => x.history[0].deadband = Infinity]) {
    const draft = config(); edit(draft); assert.equal(typeof processDataError(draft), 'string');
  }
});
// Give child components independent hooks and honor keys so changing the selected
// rule runs the real picker's cleanup rather than retaining an unrelated request.
const expand = (node, path = 'root') => {
  if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${child?.key ?? index}`));
  if (!node || typeof node !== 'object') return node;
  const identity = `${path}:${node.key ?? ''}:${typeof node.type === 'function' ? node.type.name : String(node.type)}`;
  if (typeof node.type === 'function') return expand(lifecycle.run(identity, () => node.type(node.props)), identity);
  return { ...node, props: { ...node.props, children: expand(node.props?.children, identity) } };
};
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : !node || typeof node !== 'object' ? [] : [node, ...nodes(node.props?.children)];
const text = node => Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : text(node.props?.children);
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function start(saved = config(), handler, initialSection = 'alarms') {
  lifecycle.clear();
  const calls = []; let tree, section = initialSection;
  globalThis.__processApi = async (route, method = 'GET', body) => {
    calls.push({ route, method, body: body && structuredClone(body) });
    return handler ? handler(route, method, body) : structuredClone(method === 'PUT' ? { ...body, revision: body.revision + 1 } : saved);
  };
  const render = () => {
    let passes = 0;
    do { assert.ok(passes++ < 20, 'Effects must settle.'); lifecycle.begin(); tree = expand(lifecycle.run('settings', () => Settings({ section, onSectionChange: next => { section = next; } }))); lifecycle.finish(); lifecycle.flush(); } while (lifecycle.dirty());
  };
  const find = (predicate, description) => { const result = nodes(tree).find(predicate); assert.ok(result, description); return result; };
  const button = label => find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node) === label), `button ${label}`);
  const field = label => {
    const direct = nodes(tree).find(node => ['input', 'select'].includes(node.type) && node.props['aria-label'] === label);
    if (direct) return direct;
    const enclosing = find(node => node.type === 'label' && text(node).startsWith(label), `field ${label}`);
    return nodes(enclosing).find(node => node.type === 'input' || node.type === 'select')
      ?? find(node => ['input', 'select'].includes(node.type) && node.props.id === enclosing.props.htmlFor, `input for ${label}`);
  };
  const change = (label, value) => { const input = field(label); input.props.onChange({ target: input.props.type === 'checkbox' ? { checked: value } : { value } }); render(); };
  const click = label => { const control = button(label); assert.ok(!control.props.disabled, `${label} is enabled`); control.props.onClick(); render(); };
  const switchSection = next => { section = next; render(); };
  render(); await settle(); render();
  return { calls, render, button, field, change, click, switchSection, all: () => nodes(tree), text: () => text(tree), section: () => section };
}
const multiple = () => {
  const saved = config();
  saved.alarms.push({ ...saved.alarms[0], id: 'low', name: 'Low', mode: 'low', setpoint: 20, priority: 2 });
  saved.history.push({ ...saved.history[0], tagPath: '[default]Workshop/Other' });
  return saved;
};
await check('selection and tab changes preserve every staged rule and one atomic save includes both sections', async () => {
  const saved = multiple(), original = structuredClone(saved), ui = await start(saved);
  ui.click('Edit alarm High'); ui.change('Setpoint', '90');
  ui.click('Edit alarm Low'); ui.change('Name', 'Low edited');
  ui.click('Edit alarm High'); assert.equal(ui.field('Setpoint').props.value, 90);
  ui.switchSection('history'); ui.click('Edit historical tag [default]Workshop/Value'); ui.change('Retention (days)', '30');
  ui.click('Edit historical tag [default]Workshop/Other'); ui.change('Deadband', '1.5');
  ui.switchSection('alarms'); assert.equal(ui.field('Setpoint').props.value, 90);
  assert.match(ui.text(), /Unsaved changes in Alarms and History/);
  assert.equal(ui.calls.filter(call => call.method === 'GET').length, 1, 'Switching tabs must not reload or discard drafts.');
  ui.click('Save configuration'); await settle(); ui.render();
  const updates = ui.calls.filter(call => call.method === 'PUT'); assert.equal(updates.length, 1);
  assert.equal(updates[0].route, '/gateway/process-data');
  const expected = structuredClone(saved); expected.alarms[0].setpoint = 90; expected.alarms[1].name = 'Low edited'; expected.history[0].retentionDays = 30; expected.history[1].deadband = 1.5;
  assert.deepEqual(updates[0].body, expected); assert.deepEqual(saved, original, 'Editing must not mutate the gateway snapshot.');
  assert.equal(ui.button('Save configuration').props.disabled, true);
  ui.change('Setpoint', '91'); ui.click('Save configuration'); await settle(); ui.render();
  assert.equal(ui.calls.filter(call => call.method === 'PUT')[1].body.revision, 5, 'Next save uses the returned gateway revision.');
});
await check('Cancel restores shared changes without gateway writes', async () => {
  const ui = await start(multiple());
  ui.click('Edit alarm High'); ui.change('Setpoint', '90');
  ui.switchSection('history'); ui.click('Edit historical tag [default]Workshop/Value'); ui.change('Retention (days)', '30');
  ui.click('Cancel changes'); await settle(); ui.render();
  ui.click('Edit historical tag [default]Workshop/Value'); assert.equal(ui.field('Retention (days)').props.value, 7);
  ui.switchSection('alarms'); ui.click('Edit alarm High'); assert.equal(ui.field('Setpoint').props.value, 80);
  assert.equal(ui.button('Save configuration').props.disabled, true);
  assert.equal(ui.calls.filter(call => call.method === 'PUT').length, 0);
});
await check('adding and removing alarms selects the intended draft and Cancel restores membership', async () => {
  const ui = await start(multiple());
  ui.click('Edit alarm High'); ui.change('Setpoint', '90');
  ui.click('Add alarm');
  ui.change('ID', 'added'); ui.change('Name', 'Added'); ui.change('Tag path', '[default]Workshop/Added');
  assert.equal(ui.button('Edit alarm Added').props['aria-pressed'], true);
  ui.click('Edit alarm High'); assert.equal(ui.field('Setpoint').props.value, 90);
  ui.click('Edit alarm Added'); ui.click('Remove alarm'); ui.click('Keep alarm');
  assert.equal(ui.field('ID').props.value, 'added');
  ui.click('Remove alarm'); ui.click('Confirm remove alarm');
  assert.ok(!ui.all().some(node => node.props?.['aria-label'] === 'Edit alarm Added'));
  const selected = ui.all().filter(node => node.type === 'button' && node.props['aria-pressed'] === true);
  assert.equal(selected.length, 1); assert.notEqual(ui.field('ID').props.value, 'added');
  ui.click('Edit alarm Low'); ui.click('Remove alarm'); ui.click('Confirm remove alarm');
  ui.click('Cancel changes'); await settle(); ui.render();
  assert.ok(ui.button('Edit alarm Low')); ui.click('Edit alarm High'); assert.equal(ui.field('Setpoint').props.value, 80);
  assert.equal(ui.calls.filter(call => call.method === 'PUT').length, 0);
});
await check('adding and removing historical tags retains alarm edits and chooses a surviving rule', async () => {
  const ui = await start(multiple());
  ui.click('Edit alarm High'); ui.change('Setpoint', '90');
  ui.switchSection('history'); ui.click('New historical tag');
  ui.change('Tag path', '[default]Workshop/Added'); ui.change('Retention (days)', '90');
  assert.equal(ui.button('Edit historical tag [default]Workshop/Added').props['aria-pressed'], true);
  ui.click('Edit historical tag [default]Workshop/Value'); ui.change('Deadband', '2');
  ui.click('Edit historical tag [default]Workshop/Added'); assert.equal(ui.field('Retention (days)').props.value, 90);
  ui.click('Remove historical tag'); ui.click('Keep history'); assert.equal(ui.field('Tag path').props.value, '[default]Workshop/Added');
  ui.click('Remove historical tag'); ui.click('Confirm remove history');
  assert.ok(!ui.all().some(node => node.props?.['aria-label'] === 'Edit historical tag [default]Workshop/Added'));
  assert.equal(ui.all().filter(node => node.type === 'button' && node.props['aria-pressed'] === true).length, 1);
  assert.notEqual(ui.field('Tag path').props.value, '[default]Workshop/Added');
  ui.click('Edit historical tag [default]Workshop/Value'); assert.equal(ui.field('Deadband').props.value, 2);
  ui.switchSection('alarms'); assert.equal(ui.field('Setpoint').props.value, 90);
});
await check('removing the last rule clears selection and Cancel restores both empty lists', async () => {
  const ui = await start();
  ui.click('Remove alarm'); ui.click('Confirm remove alarm');
  assert.equal(ui.all().filter(node => node.type === 'button' && node.props['aria-pressed'] === true).length, 0);
  assert.ok(!ui.all().some(node => node.type === 'label' && text(node).startsWith('ID')));
  assert.equal(ui.button('Add alarm').props.disabled, false);
  ui.switchSection('history'); ui.click('Remove historical tag'); ui.click('Confirm remove history');
  assert.equal(ui.all().filter(node => node.type === 'button' && node.props['aria-pressed'] === true).length, 0);
  assert.ok(!ui.all().some(node => node.type === 'label' && text(node).startsWith('Tag path')));
  assert.equal(ui.button('New historical tag').props.disabled, false);
  ui.click('Cancel changes'); await settle(); ui.render(); assert.equal(ui.button('Edit historical tag [default]Workshop/Value').props['aria-pressed'], true);
  ui.switchSection('alarms'); assert.equal(ui.button('Edit alarm High').props['aria-pressed'], true);
  assert.equal(ui.button('Save configuration').props.disabled, true); assert.equal(ui.calls.length, 2, 'Cancel loads the latest shared configuration.');
});
await check('search and paging keep selected edits while bounding long lists in both sections', async () => {
  const saved = config();
  saved.alarms = Array.from({ length: 101 }, (_, index) => ({ ...saved.alarms[0], id: `rule_${index}`, name: `Alarm ${String(index).padStart(3, '0')}`, enabled: index % 2 === 0 }));
  saved.history = Array.from({ length: 101 }, (_, index) => ({ ...saved.history[0], tagPath: `[default]Workshop/Tag${String(index).padStart(3, '0')}`, enabled: index % 2 === 0 }));
  const ui = await start(saved);
  const rows = prefix => ui.all().filter(node => node.type === 'button' && node.props['aria-label']?.startsWith(prefix));
  for (const section of ['alarms', 'history']) {
    ui.switchSection(section);
    const prefix = section === 'alarms' ? 'Edit alarm ' : 'Edit historical tag ';
    const search = section === 'alarms' ? 'Search alarms' : 'Search historical tags';
    const first = section === 'alarms' ? 'Edit alarm Alarm 000' : 'Edit historical tag [default]Workshop/Tag000';
    const target = section === 'alarms' ? 'Edit alarm Alarm 075' : 'Edit historical tag [default]Workshop/Tag075';
    const field = section === 'alarms' ? 'Setpoint' : 'Retention (days)';
    ui.click(first); ui.change(field, '90');
    assert.equal(rows(prefix).length, 50); assert.match(ui.text(), /Page 1 of 3/);
    ui.click('Next'); assert.equal(rows(prefix).length, 50); assert.match(ui.text(), /Page 2 of 3/);
    ui.click('Next'); assert.equal(rows(prefix).length, 1); assert.match(ui.text(), /Page 3 of 3/);
    assert.equal(ui.button('Next').props.disabled, true);
    ui.change(search, '075'); assert.equal(rows(prefix).length, 1); assert.match(ui.text(), /Page 1 of 1/);
    ui.click(target); ui.change(field, '95');
    ui.change(search, 'nothing matches'); assert.equal(rows(prefix).length, 0);
    ui.change(search, ''); assert.equal(rows(prefix).length, 50);
    ui.click(first); assert.equal(ui.field(field).props.value, 90);
    ui.click('Next'); ui.click(target); assert.equal(ui.field(field).props.value, 95);
  }
  assert.equal(ui.calls.length, 1, 'Search and paging are local draft interactions.');
});
await check('Save preserves edits and the reviewed revision after a stale-write error', async () => {
  const saved = config(), ui = await start(saved, async (_route, method) => { if (method === 'PUT') throw new Error('Configuration changed. Reload before saving.'); return structuredClone(saved); });
  ui.switchSection('history'); ui.click('Edit historical tag [default]Workshop/Value'); ui.change('Retention (days)', '30');
  ui.click('Save configuration'); await settle(); ui.render();
  const update = ui.calls.find(call => call.method === 'PUT'); assert.equal(update.body.revision, 4); assert.equal(update.body.history[0].retentionDays, 30);
  assert.equal(ui.field('Retention (days)').props.value, 30); assert.equal(ui.button('Cancel changes').props.disabled, false); assert.match(ui.text(), /Configuration changed. Reload/);
  assert.ok(!ui.all().some(node => node.type === 'button' && text(node) === 'Reload'));
});
await check('Cancel after a conflict fetches the latest revision across both editors without a toolbar Reload', async () => {
  let current = config();
  const ui = await start(current, async (_route, method) => {
    if (method === 'PUT') throw new Error('Configuration changed.');
    return structuredClone(current);
  });
  ui.change('Setpoint', '95'); ui.switchSection('history'); ui.change('Retention (days)', '30');
  current = { ...config(), revision: 5, alarmRetentionDays: 14 };
  current.alarms[0].setpoint = 85; current.history[0].retentionDays = 21;
  ui.click('Save configuration'); await settle(); ui.render();
  assert.equal(ui.field('Retention (days)').props.value, 30, 'A conflict preserves the complete draft.');
  ui.click('Cancel changes'); await settle(); ui.render();
  assert.equal(ui.field('Retention (days)').props.value, 21);
  ui.switchSection('alarms'); assert.equal(ui.field('Setpoint').props.value, 85);
  assert.equal(ui.field('Alarm journal retention (days)').props.value, 14);
  assert.match(ui.text(), /Revision 5/); assert.equal(ui.button('Save configuration').props.disabled, true);
  assert.equal(ui.calls.filter(call => call.method === 'GET').length, 2);
});
await check('a failed Cancel load keeps the draft and permits a later explicit cancellation', async () => {
  let reads = 0;
  const ui = await start(config(), async (_route, method) => {
    assert.equal(method, 'GET');
    if (++reads === 2) throw new Error('Gateway temporarily unavailable.');
    return config();
  });
  ui.change('Setpoint', '95'); ui.click('Cancel changes'); await settle(); ui.render();
  assert.equal(ui.field('Setpoint').props.value, 95); assert.match(ui.text(), /Your draft is retained/);
  ui.click('Cancel changes'); await settle(); ui.render();
  assert.equal(ui.field('Setpoint').props.value, 80); assert.equal(ui.calls.filter(call => call.method === 'PUT').length, 0);
});
await check('initial load failures have a contextual Retry and reject duplicate in-flight reads', async () => {
  let reads = 0; const retry = deferred();
  const ui = await start(config(), async () => {
    if (++reads === 1) throw new Error('Gateway temporarily unavailable.');
    return retry.promise;
  });
  assert.match(ui.text(), /Gateway temporarily unavailable/);
  const control = ui.button('Retry configuration'); control.props.onClick(); control.props.onClick(); ui.render();
  assert.equal(reads, 2); retry.resolve(config()); await settle(); ui.render();
  assert.equal(ui.field('Setpoint').props.value, 80);
  assert.ok(!ui.all().some(node => node.type === 'button' && text(node) === 'Reload'));
});
await check('late configuration reads and saves cannot update an unmounted editor', async () => {
  const read = deferred(); const loading = await start(config(), async () => read.promise);
  assert.match(loading.text(), /Loading configuration/); lifecycle.unmount(); read.resolve(config()); await settle();
  assert.equal(lifecycle.updatesAfterUnmount(), 0);
  const update = deferred(); const editing = await start(config(), async (_route, method) => method === 'PUT' ? update.promise : config());
  editing.change('Setpoint', '95'); editing.click('Save configuration'); lifecycle.unmount(); update.resolve({ ...config(), revision: 5 }); await settle();
  assert.equal(lifecycle.updatesAfterUnmount(), 0);
});
await check('invalid numeric edits in either section block the shared save and can be located from the other tab', async () => {
  const ui = await start();
  ui.click('Edit alarm High'); ui.change('Setpoint', '');
  assert.equal(ui.field('Setpoint').props.value, ''); assert.equal(ui.button('Save configuration').props.disabled, true);
  ui.switchSection('history'); assert.equal(ui.button('Save configuration').props.disabled, true);
  ui.button('Save configuration').props.onClick(); await settle(); ui.render();
  assert.equal(ui.calls.filter(call => call.method === 'PUT').length, 0);
  ui.click('Show invalid rule'); assert.equal(ui.section(), 'alarms'); assert.equal(ui.field('ID').props.value, 'high');
  ui.change('Setpoint', '80');
  ui.switchSection('history'); ui.click('Edit historical tag [default]Workshop/Value'); ui.change('Maximum interval (ms)', '249');
  ui.switchSection('alarms'); assert.equal(ui.button('Save configuration').props.disabled, true);
  ui.click('Show invalid rule'); assert.equal(ui.section(), 'history'); assert.equal(ui.field('Maximum interval (ms)').props.value, 249);
  ui.change('Maximum interval (ms)', '1000'); assert.equal(ui.button('Save configuration').props.disabled, true, 'Restoring saved values clears dirty state.');
});
await check('corrupt configuration needs explicit recovery consent and storage failure blocks saving', async () => {
  const ui = await start({ ...config(), configurationError: 'Unreadable configuration' });
  ui.change('Alarm journal retention (days)', '9'); assert.equal(ui.button('Save configuration').props.disabled, true);
  ui.change('Archive the invalid configuration and replace it with this reviewed draft', true);
  assert.equal(ui.button('Save configuration').props.disabled, false);
  ui.click('Save configuration'); await settle(); ui.render();
  assert.equal(ui.calls.find(call => call.method === 'PUT').body.replaceInvalidConfiguration, true);
  lifecycle.unmount();
  const blocked = await start({ ...config(), storageError: 'Database requires repair' });
  blocked.change('Alarm journal retention (days)', '9'); assert.equal(blocked.button('Save configuration').props.disabled, true);
  blocked.button('Save configuration').props.onClick(); await settle(); blocked.render();
  assert.equal(blocked.calls.filter(call => call.method === 'PUT').length, 0); assert.match(blocked.text(), /Database requires repair/);
});
const configuredTags = () => [
  { path: '[default]Storage/Memory', kind: 'memory', dataType: 'Double', enabled: true },
  { path: '[plant]Area A/Motor.Speed', kind: 'opcua', dataType: 'Int32', enabled: true, connectionId: 'fixture-opc', nodeId: 'ns=2;s=Motor.Speed' },
  { path: '[default]Calculated/Total', kind: 'expression', dataType: 'Double', enabled: false, effectiveEnabled: false, expression: 'left + right', inputs: {} },
];
const tagChoices = ui => ui.all().filter(node => node.type === 'button' && node.props['aria-label']?.startsWith('Use tag '));
await check('both editors browse every configured tag kind, preserve manual entry and stage only the selected path', async () => {
  const saved = multiple(), definitions = configuredTags();
  const ui = await start(saved, async (route, method, body) => structuredClone(route === '/tag-definitions' ? definitions : method === 'PUT' ? { ...body, revision: 5 } : saved));
  assert.equal(ui.calls.filter(call => call.route === '/tag-definitions').length, 0, 'Browsing is loaded only on request.');
  const manual = '[manual]Unlisted/Tag';
  ui.change('Tag path', manual); ui.click('Browse'); await settle(); ui.render();
  assert.equal(tagChoices(ui).length, 3);
  for (const definition of definitions) {
    const choice = ui.button(`Use tag ${definition.path}`);
    assert.match(text(choice), new RegExp(definition.dataType)); assert.equal(Boolean(choice.props.disabled), false);
  }
  assert.match(ui.text(), /memory/i); assert.match(ui.text(), /OPC UA|opcua/i); assert.match(ui.text(), /expression/i); assert.match(ui.text(), /disabled/i);
  ui.click('Close tag browser'); assert.equal(ui.field('Tag path').props.value, manual);
  ui.click('Browse'); await settle(); ui.render(); ui.click(`Use tag ${definitions[1].path}`);
  assert.equal(ui.field('Tag path').props.value, definitions[1].path); assert.equal(tagChoices(ui).length, 0);
  ui.click('Edit alarm Low'); assert.equal(ui.field('Tag path').props.value, saved.alarms[1].tagPath);
  ui.click('Browse'); await settle(); ui.render(); ui.click(`Use tag ${definitions[0].path}`);
  ui.switchSection('history'); ui.click('Browse'); await settle(); ui.render(); ui.click(`Use tag ${definitions[2].path}`);
  assert.equal(ui.field('Tag path').props.value, definitions[2].path);
  ui.click('Edit historical tag [default]Workshop/Other'); assert.equal(ui.field('Tag path').props.value, saved.history[1].tagPath);
  ui.change('Tag path', manual); assert.equal(ui.field('Tag path').props.value, manual, 'Manual paths remain editable after browsing.');
  assert.equal(ui.calls.filter(call => call.method === 'PUT').length, 0, 'Choosing a path must not save automatically.');
  ui.click('Save configuration'); await settle(); ui.render();
  const expected = structuredClone(saved); expected.alarms[0].tagPath = definitions[1].path; expected.alarms[1].tagPath = definitions[0].path; expected.history[0].tagPath = definitions[2].path; expected.history[1].tagPath = manual;
  assert.deepEqual(ui.calls.find(call => call.method === 'PUT').body, expected);
});
await check('tag browse search and paging cover path, kind and data type without changing the draft', async () => {
  const saved = config(), definitions = Array.from({ length: 101 }, (_, index) => ({ path: `[default]Browse/Tag${String(index).padStart(3, '0')}`, kind: index === 75 ? 'expression' : 'memory', dataType: index === 100 ? 'Int64' : 'Double', enabled: true }));
  const ui = await start(saved, async route => structuredClone(route === '/tag-definitions' ? definitions.slice().reverse() : saved));
  ui.click('Browse'); await settle(); ui.render();
  assert.equal(tagChoices(ui).length, 50); assert.equal(tagChoices(ui)[0].props['aria-label'], `Use tag ${definitions[0].path}`);
  ui.click('Next tags'); assert.equal(tagChoices(ui).length, 50); assert.equal(tagChoices(ui)[0].props['aria-label'], `Use tag ${definitions[50].path}`);
  ui.click('Next tags'); assert.equal(tagChoices(ui).length, 1); assert.equal(ui.button('Next tags').props.disabled, true);
  ui.click('Previous tags'); assert.equal(tagChoices(ui).length, 50);
  for (const [search, expected] of [['Tag075', definitions[75]], ['expression', definitions[75]], ['Int64', definitions[100]]]) {
    ui.change('Search configured tags', search); assert.equal(tagChoices(ui).length, 1); assert.equal(tagChoices(ui)[0].props['aria-label'], `Use tag ${expected.path}`);
    assert.equal(ui.button('Previous tags').props.disabled, true);
  }
  ui.change('Search configured tags', 'nothing matches'); assert.equal(tagChoices(ui).length, 0);
  ui.change('Search configured tags', ''); assert.equal(tagChoices(ui).length, 50);
  assert.equal(ui.field('Tag path').props.value, saved.alarms[0].tagPath); assert.equal(ui.button('Save configuration').props.disabled, true);
  assert.equal(ui.calls.filter(call => call.route === '/tag-definitions').length, 1); assert.equal(ui.calls.filter(call => call.method === 'PUT').length, 0);
});
await check('tag browse errors can retry to an empty catalog without clearing a manual path', async () => {
  let attempts = 0; const saved = config();
  const ui = await start(saved, async route => { if (route !== '/tag-definitions') return structuredClone(saved); if (++attempts === 1) throw new Error('Configured tags unavailable.'); return []; });
  ui.change('Tag path', '[manual]Local/Value'); ui.click('Browse'); await settle(); ui.render();
  assert.match(ui.text(), /Configured tags unavailable/); assert.equal(tagChoices(ui).length, 0);
  ui.click('Retry tag browse'); await settle(); ui.render();
  assert.equal(attempts, 2); assert.equal(tagChoices(ui).length, 0); assert.match(ui.text(), /No configured tags|No tags/i);
  assert.equal(ui.field('Tag path').props.value, '[manual]Local/Value'); ui.click('Close tag browser');
  assert.equal(ui.field('Tag path').props.value, '[manual]Local/Value'); assert.equal(ui.calls.filter(call => call.method === 'PUT').length, 0);
});
await check('closing a tag lookup fences a late result after the browser is reopened', async () => {
  const pending = deferred(), saved = config(), definitions = configuredTags(); let attempts = 0;
  const ui = await start(saved, async route => route !== '/tag-definitions' ? structuredClone(saved) : ++attempts === 1 ? pending.promise : [definitions[1]]);
  ui.click('Browse'); ui.click('Close tag browser'); ui.click('Browse'); await settle(); ui.render();
  assert.equal(tagChoices(ui).length, 1); assert.ok(ui.button(`Use tag ${definitions[1].path}`));
  pending.resolve([definitions[0]]); await settle(); ui.render();
  assert.equal(tagChoices(ui).length, 1); assert.ok(ui.button(`Use tag ${definitions[1].path}`));
  assert.equal(ui.field('Tag path').props.value, saved.alarms[0].tagPath); assert.equal(lifecycle.updatesAfterUnmount(), 0);
  assert.equal(ui.calls.filter(call => call.method === 'PUT').length, 0);
});
await check('changing rules or tabs and unmounting fence pending tag browse responses', async () => {
  const saved = multiple(), definitions = configuredTags(), first = deferred(), last = deferred(); let attempts = 0;
  const ui = await start(saved, async route => route !== '/tag-definitions' ? structuredClone(saved) : ++attempts === 1 ? first.promise : attempts === 2 ? [definitions[1]] : last.promise);
  ui.click('Browse'); ui.click('Edit alarm Low'); assert.equal(tagChoices(ui).length, 0);
  ui.click('Browse'); await settle(); ui.render(); assert.ok(ui.button(`Use tag ${definitions[1].path}`));
  first.resolve([definitions[0]]); await settle(); ui.render();
  assert.equal(tagChoices(ui).length, 1); assert.ok(ui.button(`Use tag ${definitions[1].path}`)); assert.equal(lifecycle.updatesAfterUnmount(), 0);
  ui.switchSection('history'); assert.equal(tagChoices(ui).length, 0); assert.equal(ui.field('Tag path').props.value, saved.history[0].tagPath);
  ui.click('Browse'); lifecycle.unmount(); last.resolve([definitions[2]]); await settle();
  assert.equal(lifecycle.updatesAfterUnmount(), 0); assert.equal(ui.calls.filter(call => call.method === 'PUT').length, 0);
});
const example = JSON.parse(fs.readFileSync(new URL('../../examples/process-data-workshop.json', import.meta.url), 'utf8'));
await check('authored workshop uses one memory source, explicit commands and all three runtime controls', () => {
  assert.equal(example.tags.length, 1); assert.equal(example.tags[0].kind, 'memory');
  assert.equal(processDataError({ revision: 1, alarmRetentionDays: 7, ...example.processData }), null);
  const types = example.screens.flatMap(screen => screen.components.map(component => component.type));
  for (const type of ['alarmStatusTable', 'alarmJournalTable', 'historicalTrend', 'equipmentCommand']) assert.ok(types.includes(type));
  assert.equal(example.commands[0].tagPath, example.tags[0].path);
});
delete globalThis.__processApi;
console.log(`${checks} process data settings groups passed.`);
