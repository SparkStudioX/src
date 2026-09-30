import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';

const require = createRequire(import.meta.url), moduleData = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const hookUrl = moduleData(`
let slots=[],index=0,effects=[];
const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>value===b[index]);
export const clear=()=>{slots=[];index=0;effects=[]};export const begin=()=>{index=0};
export const useState=initial=>{const at=index++;if(!(at in slots))slots[at]={value:typeof initial==='function'?initial():initial};return[slots[at].value,value=>{slots[at].value=typeof value==='function'?value(slots[at].value):value}]};
export const useRef=value=>slots[index++]??=( {current:value} );
export const useCallback=(callback,deps)=>{const at=index++;if(!slots[at]||!equal(slots[at].deps,deps))slots[at]={callback,deps};return slots[at].callback};
export const useEffect=(callback,deps)=>{const at=index++;if(!slots[at]||!equal(slots[at].deps,deps)){const old=slots[at];slots[at]={effect:callback,deps};effects.push(()=>{old?.cleanup?.();slots[at].cleanup=callback()})}};
export const flush=()=>effects.splice(0).forEach(callback=>callback());
export const replay=()=>{for(const slot of slots)if(slot?.effect)slot.cleanup?.();for(const slot of slots)if(slot?.effect)slot.cleanup=slot.effect()};
export const unmount=()=>{for(const slot of slots)slot?.cleanup?.()};
`);
const apiUrl = moduleData(`
let handler;export const calls=[];export const reset=next=>{handler=next;calls.length=0};export const setHandler=next=>{handler=next};
export const api=async(route,method='GET',body)=>{calls.push({route,method,body});return handler(route,method,body)};
export const apiUrl=route=>'/api'+route;
export const authenticatedFetch=async(route,options)=>{calls.push({route,method:'FETCH',options});return handler(route,'FETCH')};
export const assertAuthResponseCurrent=()=>{};
`);
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const file = ['ts', 'tsx'].map(extension => new URL(`src/${name}.${extension}`, import.meta.url)).find(file => fs.existsSync(file));
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dependency) => prefix + JSON.stringify(dependency === 'react' ? hookUrl : dependency === './api' ? apiUrl : dependency.startsWith('./') ? load(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href));
  const url = moduleData(source); modules.set(name, url); return url;
}
const { backupDraftFromSaved, backupSettingsRequest, emptyBackupSecrets } = await import(load('gatewayBackupModel'));
const { default: GatewayBackups } = await import(load('GatewayBackups'));
const hooks = await import(hookUrl), api = await import(apiUrl);
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : React.Children.toArray(node.props?.children).map(text).join('');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fixture = (patch = {}) => ({
  revision: 'fixture-revision-1', saved: { enabled: false, dailyTime: '02:00', timeZoneId: 'America/Chicago', retentionDays: 7, destination: { kind: 'smb', address: '', username: '', domain: '', timeoutSeconds: 300 } },
  hasDestinationPassword: false, hasArchivePassphrase: false, gatewayTimeZoneId: 'America/Chicago', running: false,
  nextDueAt: null, downloadId: null, recoveryBlocked: false, coverage: 'Configuration only; database files are excluded.', lastRun: null, ...patch,
});
const nativeWindow = globalThis.window, nativeDocument = globalThis.document;
let timers = new Map(), timerNumber = 0, downloaded = [];
globalThis.window = { setInterval: (callback, period) => { const id = ++timerNumber; timers.set(id, { callback, period }); return id; }, clearInterval: id => timers.delete(id), setTimeout: callback => { callback(); return 0; } };
globalThis.document = { body: { appendChild() {} }, createElement: () => ({ click() { downloaded.push(this.download); }, remove() {} }) };
function start(snapshot = fixture(), handler) {
  hooks.clear(); timers = new Map(); downloaded = [];
  api.reset(handler || (async () => structuredClone(snapshot)));
  let tree;
  const render = () => { hooks.begin(); tree = GatewayBackups(); hooks.flush(); };
  const find = predicate => { const found = nodes(tree).find(predicate); assert.ok(found, 'Expected backup control.'); return found; };
  const button = label => find(node => node.type === 'button' && text(node) === label);
  const field = label => {
    const enclosing = find(node => node.type === 'label' && text(node).startsWith(label));
    return nodes(enclosing).find(node => node.type === 'input' || node.type === 'select');
  };
  const change = (label, value) => { const input = field(label); input.props.onChange({ target: input.props.type === 'checkbox' ? { checked: value } : { value } }); render(); };
  const click = label => { button(label).props.onClick(); render(); };
  const submit = () => { find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); render(); };
  const poll = () => { for (const timer of [...timers.values()]) timer.callback(); };
  render();
  return { render, find, button, field, change, click, submit, poll, all: () => nodes(tree), text: () => text(tree) };
}
let passed = 0;
async function check(name, action) { try { await action(); passed++; console.log(`PASS ${name}`); } finally { hooks.unmount(); } }
try {
  await check('settings updates omit retained secrets and transmit only deliberate replacements or clears', () => {
    const draft = backupDraftFromSaved(fixture().saved, 'America/Chicago');
    const ordinary = backupSettingsRequest('r1', draft, emptyBackupSecrets());
    assert.deepEqual(Object.keys(ordinary).sort(), ['revision', 'settings']);
    const updated = backupSettingsRequest('r1', draft, { ...emptyBackupSecrets(), replaceDestinationPassword: true, destinationPassword: 'synthetic-destination-password', replaceArchivePassphrase: true, archivePassphrase: 'synthetic-archive-passphrase', confirmation: 'synthetic-archive-passphrase' });
    assert.equal(updated.destinationPassword, 'synthetic-destination-password'); assert.equal(updated.archivePassphrase, 'synthetic-archive-passphrase'); assert.ok(!Object.hasOwn(updated, 'confirmation'));
    const cleared = backupSettingsRequest('r1', draft, { ...emptyBackupSecrets(), clearDestinationPassword: true });
    assert.equal(cleared.clearDestinationPassword, true); assert.ok(!Object.hasOwn(cleared, 'destinationPassword'));
  });
  await check('FTP and explicit FTPS preserve host, port and supported folders without credentials in URLs', () => {
    const draft = { ...backupDraftFromSaved(fixture().saved, 'America/Chicago'), kind: 'ftps', ftpHost: 'backup.example.test', ftpPort: 2121, ftpFolder: '/line-A/backups', username: 'backup-user', domain: 'ignored' };
    const request = backupSettingsRequest('r1', draft, emptyBackupSecrets());
    assert.equal(request.settings.destination.address, 'ftp://backup.example.test:2121/line-A/backups/'); assert.equal(request.settings.destination.kind, 'ftps'); assert.equal(request.settings.destination.domain, '');
    const restored = backupDraftFromSaved(request.settings, 'America/Chicago'); assert.equal(restored.ftpHost, draft.ftpHost); assert.equal(restored.ftpPort, 2121); assert.equal(restored.ftpFolder, '/line-A/backups/');
    for (const host of ['ftp://backup.example.test', 'person:secret@backup.example.test', 'backup.example.test/folder', 'backup.example.test?token=123']) assert.throws(() => backupSettingsRequest('r1', { ...draft, ftpHost: host }, emptyBackupSecrets()));
    for (const folder of ['/line A/backups', '/encoded%20folder/', '/../other/']) assert.throws(() => backupSettingsRequest('r1', { ...draft, ftpFolder: folder }, emptyBackupSecrets()));
    assert.throws(() => backupSettingsRequest('r1', { ...draft, username: '' }, emptyBackupSecrets()));
  });
  await check('invalid schedules, bounds, paths and secret confirmations fail before sending requests', () => {
    const draft = backupDraftFromSaved(fixture().saved, 'America/Chicago');
    for (const patch of [{ enabled: true }, { dailyTime: '24:00' }, { dailyTime: '2:00' }, { timeZoneId: '' }, { retentionDays: 0 }, { retentionDays: 3651 }, { retentionDays: 1.2 }, { timeoutSeconds: 29 }, { timeoutSeconds: 3601 }, { sharePath: 'Z:\\backups' }]) assert.throws(() => backupSettingsRequest('r1', { ...draft, ...patch }, emptyBackupSecrets()));
    for (const passphrase of ['short', 'x'.repeat(1025)]) assert.throws(() => backupSettingsRequest('r1', draft, { ...emptyBackupSecrets(), replaceArchivePassphrase: true, archivePassphrase: passphrase, confirmation: passphrase }));
    assert.throws(() => backupSettingsRequest('r1', draft, { ...emptyBackupSecrets(), replaceArchivePassphrase: true, archivePassphrase: 'synthetic-archive-passphrase', confirmation: 'different-passphrase' }));
    assert.throws(() => backupSettingsRequest('r1', draft, { ...emptyBackupSecrets(), replaceDestinationPassword: true, destinationPassword: '' }));
  });
  await check('first load displays disabled 02:00/seven-day defaults and requires a stored archive passphrase for backup actions', async () => {
    const ui = start(); await settle(); ui.render();
    assert.equal(ui.field('Daily time').props.value, '02:00'); assert.equal(ui.field('Keep backups for days').props.value, 7); assert.equal(ui.field('Enable daily backups').props.checked, false);
    assert.equal(ui.button('Create download').props.disabled, true); assert.equal(ui.button('Back up to destination').props.disabled, true);
    ui.change('Set archive passphrase', true); ui.change('New archive passphrase', 'synthetic-archive-passphrase');
    assert.equal(ui.field('New archive passphrase').props.type, 'password'); assert.equal(ui.field('Confirm archive passphrase').props.type, 'password');
    assert.match(ui.text(), /Configuration only; database files are excluded/);
  });
  await check('status polling retains unsaved settings and secrets and exposes cross-session revision conflicts', async () => {
    const ui = start(fixture({ hasArchivePassphrase: true, hasDestinationPassword: true })); await settle(); ui.render();
    ui.change('Keep backups for days', '14'); ui.change('Replace stored password', true); ui.change('New destination password', 'synthetic-destination-password');
    api.setHandler(async () => fixture({ revision: 'fixture-revision-2', hasArchivePassphrase: true, hasDestinationPassword: true })); ui.poll(); await settle(); ui.render();
    assert.equal(ui.field('Keep backups for days').props.value, 14); assert.equal(ui.field('New destination password').props.value, 'synthetic-destination-password');
    assert.match(ui.text(), /changed in another session/); assert.equal(ui.button('Save backup settings').props.disabled, true); assert.equal(ui.button('Create download').props.disabled, true);
  });
  await check('successful save clears replacement fields and concurrent submits make one update', async () => {
    const pending = deferred(), initial = fixture();
    const ui = start(initial, async (_route, method) => method === 'PUT' ? pending.promise : structuredClone(initial)); await settle(); ui.render();
    ui.change('Set archive passphrase', true); ui.change('New archive passphrase', 'synthetic-archive-passphrase'); ui.change('Confirm archive passphrase', 'synthetic-archive-passphrase');
    ui.submit(); ui.submit(); assert.equal(api.calls.filter(call => call.method === 'PUT').length, 1);
    assert.equal(api.calls.find(call => call.method === 'PUT').body.archivePassphrase, 'synthetic-archive-passphrase');
    pending.resolve(fixture({ revision: 'fixture-revision-2', hasArchivePassphrase: true })); await settle(); ui.render();
    assert.ok(!ui.all().some(node => node.type === 'input' && node.props.type === 'password')); assert.equal(ui.button('Create download').props.disabled, false);
  });
  await check('manual local and remote actions use saved settings, respect recovery, and download through authenticated fetch', async () => {
    const snapshot = fixture({ hasArchivePassphrase: true, downloadId: 'fixture-archive', saved: { ...fixture().saved, destination: { ...fixture().saved.destination, address: '\\\\backup-server\\share\\sparkstudio' } } });
    const ui = start(snapshot, async (_route, method) => method === 'FETCH' ? new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Disposition': 'attachment; filename="fixture.sparkbak"' } }) : structuredClone(snapshot)); await settle(); ui.render();
    ui.click('Create download'); await settle(); ui.render(); assert.deepEqual(api.calls.find(call => call.method === 'POST').body, { deliver: false });
    ui.click('Back up to destination'); await settle(); ui.render(); assert.deepEqual(api.calls.filter(call => call.method === 'POST').at(-1).body, { deliver: true });
    ui.click('Download latest archive'); await settle(); ui.render(); assert.ok(api.calls.some(call => call.method === 'FETCH' && call.route === '/api/gateway/backups/download/fixture-archive')); assert.deepEqual(downloaded, ['fixture.sparkbak']);
    api.setHandler(async () => ({ ...snapshot, recoveryBlocked: true })); ui.poll(); await settle(); ui.render(); assert.equal(ui.button('Create download').props.disabled, true); assert.equal(ui.button('Back up to destination').props.disabled, true);
  });
  await check('Strict Mode effect replay does not leave initial loading locked', async () => {
    const first = deferred(); let calls = 0;
    const ui = start(fixture(), async () => ++calls === 1 ? first.promise : fixture());
    hooks.replay(); await settle(); ui.render(); first.resolve(fixture()); await settle(); ui.render();
    assert.equal(ui.field('Daily time').props.value, '02:00'); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, false);
  });
  console.log(`${passed} backup UI/model groups passed.`);
} finally { globalThis.window = nativeWindow; globalThis.document = nativeDocument; }
