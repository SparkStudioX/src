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
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  if (modules.has(name)) return modules.get(name);
  const file = ['ts', 'tsx'].map(extension => new URL(`src/${name}.${extension}`, import.meta.url)).find(file => fs.existsSync(file));
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dependency) => prefix + JSON.stringify(dependency === 'react' ? hookUrl : dependency === './api' ? apiUrl : dependency.startsWith('./') ? load(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href));
  const url = moduleData(source); modules.set(name, url); return url;
}
const { backupDraftFromSaved, backupSettingsRequest, emptyBackupSecrets, emptyDestinationSecrets, newBackupDestination, newBackupSchedule } = await import(load('gatewayBackupModel'));
const { default: GatewayBackups } = await import(load('GatewayBackups'));
const hooks = await import(hookUrl), api = await import(apiUrl);
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : React.Children.toArray(node.props?.children).map(text).join('');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fixture = (patch = {}) => ({
  revision: 'fixture-revision-1', saved: { destinations: [{ id: 'default-destination', name: 'Primary destination', settings: { kind: 'smb', address: '', username: '', domain: '', timeoutSeconds: 300 } }], schedules: [{ id: 'default-schedule', name: 'Daily backup', enabled: false, destinationId: 'default-destination', dailyTime: '02:00', timeZoneId: 'America/Chicago', retentionDays: 7 }] },
  destinationSecrets: [{ destinationId: 'default-destination', hasPassword: false, hasSecretAccessKey: false, hasSessionToken: false }], scheduleStates: [], hasArchivePassphrase: false, gatewayTimeZoneId: 'America/Chicago', running: false,
  downloadId: null, recoveryBlocked: false, coverage: 'Configuration only; database files are excluded.', lastRun: null, ...patch,
});
const configured = () => fixture({
  hasArchivePassphrase: true,
  saved: {
    destinations: [
      { id: 'share', name: 'Plant share', settings: { kind: 'smb', address: '\\\\backup-server\\share\\sparkstudio', username: '', domain: '', timeoutSeconds: 300 } },
      { id: 'ftp', name: 'FTPS archive', settings: { kind: 'ftps', address: 'ftp://backup.example.test:2121/line-a/', username: 'backup-user', domain: '', timeoutSeconds: 300 } },
      { id: 's3', name: 'Cloud archive', settings: { kind: 's3', address: '', bucket: 'fixture-backups', region: 'us-east-1', prefix: 'plant/', accessKeyId: 'synthetic-key-id', endpoint: '', forcePathStyle: false, timeoutSeconds: 300 } },
    ], schedules: [
      { id: 'morning', name: 'Morning backup', enabled: false, destinationId: 'share', dailyTime: '02:00', timeZoneId: 'America/Chicago', retentionDays: 7 },
      { id: 'weekly', name: 'Weekly cloud', enabled: true, destinationId: 's3', dailyTime: '04:00', timeZoneId: 'UTC', retentionDays: 30, daysOfWeek: [1, 5] },
    ],
  },
  destinationSecrets: [{ destinationId: 'share', hasPassword: false, hasSecretAccessKey: false, hasSessionToken: false }, { destinationId: 'ftp', hasPassword: true, hasSecretAccessKey: false, hasSessionToken: false }, { destinationId: 's3', hasPassword: false, hasSecretAccessKey: true, hasSessionToken: true }],
  scheduleStates: [{ scheduleId: 'morning', lastScheduledDate: null, lastRun: null, nextDueAt: null }, { scheduleId: 'weekly', lastScheduledDate: '2026-09-28', lastRun: null, nextDueAt: '2026-10-02T04:00:00Z' }],
});
const nativeWindow = globalThis.window, nativeDocument = globalThis.document;
let timers = new Map(), timerNumber = 0, downloaded = [], hashListeners = new Set();
globalThis.window = { location: { hash: '#backups' }, addEventListener: (event, callback) => { if (event === 'hashchange') hashListeners.add(callback); }, removeEventListener: (_event, callback) => hashListeners.delete(callback), setInterval: (callback, period) => { const id = ++timerNumber; timers.set(id, { callback, period }); return id; }, clearInterval: id => timers.delete(id), setTimeout: callback => { callback(); return 0; } };
globalThis.document = { body: { appendChild() {} }, createElement: () => ({ click() { downloaded.push(this.download); }, remove() {} }) };
function start(snapshot = fixture(), handler, props = {}, hash = '#backups') {
  hooks.clear(); timers = new Map(); downloaded = []; hashListeners = new Set(); window.location.hash = hash;
  api.reset(handler || (async (_route, method, body) => structuredClone(method === 'PUT' ? { ...snapshot, saved: body.settings, revision: 'fixture-revision-2', hasArchivePassphrase: snapshot.hasArchivePassphrase || Boolean(body.archivePassphrase) } : snapshot)));
  let tree; const focused = [];
  const render = () => { hooks.begin(); tree = GatewayBackups(props); for (const tab of nodes(tree).filter(node => node.props.role === 'tab')) tab.props.ref?.({ focus: () => focused.push(text(tab)) }); hooks.flush(); };
  const find = (predicate, description = 'Expected backup control.') => { const found = nodes(tree).find(predicate); assert.ok(found, description); return found; };
  const button = label => find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node) === label), `button ${label}`);
  const field = label => { const enclosing = find(node => node.type === 'label' && text(node).startsWith(label), `field ${label}`); return nodes(enclosing).find(node => node.type === 'input' || node.type === 'select'); };
  const change = (label, value) => { const input = field(label); input.props.onChange({ target: input.props.type === 'checkbox' ? { checked: value } : { value } }); render(); };
  const click = label => { const control = button(label); assert.ok(!control.props.disabled, `${label} is enabled`); control.props.onClick(); render(); };
  const submit = () => { find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); render(); };
  const poll = () => { for (const timer of [...timers.values()]) timer.callback(); };
  const hashChange = value => { window.location.hash = value; for (const listener of hashListeners) listener(); render(); };
  const pressKey = (label, key) => { let prevented = false; button(label).props.onKeyDown({ key, preventDefault() { prevented = true; } }); render(); return prevented; };
  render();
  return { render, find, button, field, change, click, submit, poll, hashChange, pressKey, focused: () => focused.at(-1), all: () => nodes(tree), text: () => text(tree) };
}
async function loaded(snapshot = fixture(), handler, props, hash) { const ui = start(snapshot, handler, props, hash); await settle(); ui.render(); return ui; }
const modelRequest = (draft, secrets = emptyBackupSecrets(), status = configured()) => backupSettingsRequest('r1', draft, secrets, status.destinationSecrets, status.hasArchivePassphrase);
let passed = 0;
async function check(name, action) { try { await action(); passed++; console.log(`PASS ${name}`); } finally { hooks.unmount(); } }
try {
  await check('settings requests omit retained secrets and isolate replacements or clears by destination', () => {
    const draft = backupDraftFromSaved(configured().saved, 'America/Chicago');
    assert.deepEqual(Object.keys(modelRequest(draft)).sort(), ['revision', 'settings']);
    const edits = { ...emptyBackupSecrets(), destinations: { ftp: { ...emptyDestinationSecrets(), replacePassword: true, password: 'synthetic-password' }, s3: { ...emptyDestinationSecrets(), replaceSecretAccessKey: true, secretAccessKey: 'synthetic-access-secret', clearSessionToken: true } }, replaceArchivePassphrase: true, archivePassphrase: 'synthetic-archive-passphrase', confirmation: 'synthetic-archive-passphrase' };
    const request = modelRequest(draft, edits);
    assert.deepEqual(request.destinationSecrets, [{ destinationId: 'ftp', password: 'synthetic-password' }, { destinationId: 's3', secretAccessKey: 'synthetic-access-secret', clearSessionToken: true }]);
    assert.equal(request.archivePassphrase, edits.archivePassphrase); assert.ok(!Object.hasOwn(request, 'confirmation'));
    assert.doesNotMatch(JSON.stringify(request.settings), /synthetic-password|synthetic-access-secret/);
    assert.throws(() => modelRequest(draft, { ...edits, destinations: { ftp: { ...edits.destinations.ftp, clearPassword: true } } }));
  });
  await check('FTP and FTPS round trip explicit ports and folders without embedded credentials', () => {
    const draft = backupDraftFromSaved(configured().saved, 'America/Chicago');
    const target = draft.destinations[1]; target.ftpFolder = '/line-A/backups'; target.domain = 'not-for-ftp';
    const request = modelRequest(draft), saved = request.settings.destinations[1].settings;
    assert.equal(saved.address, 'ftp://backup.example.test:2121/line-A/backups/'); assert.equal(saved.domain, '');
    const restored = backupDraftFromSaved(request.settings, 'America/Chicago').destinations[1]; assert.equal(restored.ftpPort, 2121); assert.equal(restored.ftpFolder, '/line-A/backups/');
    for (const host of ['ftp://backup.example.test', 'person:secret@backup.example.test', 'backup.example.test/folder', 'backup.example.test?token=123']) { const changed = structuredClone(draft); changed.destinations[1].ftpHost = host; assert.throws(() => modelRequest(changed)); }
    for (const folder of ['/line A/backups', '/encoded%20folder/', '/../other/']) { const changed = structuredClone(draft); changed.destinations[1].ftpFolder = folder; assert.throws(() => modelRequest(changed)); }
    target.kind = 'ftp'; assert.throws(() => modelRequest(draft), /acknowledge/); target.allowInsecureFtp = true; assert.equal(modelRequest(draft).settings.destinations[1].settings.allowInsecureFtp, true);
  });
  await check('S3 uses HTTPS origins and rejects unsafe bucket, prefix and endpoint values', () => {
    const draft = backupDraftFromSaved(configured().saved, 'America/Chicago');
    Object.assign(draft.destinations[2], { endpoint: 'https://s3.example.test:9443/', forcePathStyle: true });
    const saved = modelRequest(draft).settings.destinations[2].settings;
    assert.equal(saved.endpoint, 'https://s3.example.test:9443'); assert.equal(saved.forcePathStyle, true); assert.equal(saved.prefix, 'plant/'); assert.equal(saved.address, ''); assert.ok(!Object.hasOwn(saved, 'username'));
    const boundary = structuredClone(draft); boundary.destinations[2].prefix = 'x'.repeat(699); assert.equal(modelRequest(boundary).settings.destinations[2].settings.prefix.length, 700); boundary.destinations[2].prefix += 'x'; assert.throws(() => modelRequest(boundary));
    for (const patch of [{ endpoint: 'http://s3.example.test' }, { endpoint: 'https://user:pass@s3.example.test' }, { endpoint: 'https://s3.example.test/path' }, { endpoint: 'https://s3.example.test?key=1' }, { endpoint: 'https:\\s3.example.test' }, { bucket: 'Bad Bucket' }, { bucket: '10.2.3.4' }, { bucket: 'xn--reserved' }, { bucket: 'bucket--table-s3' }, { prefix: '../outside' }, { prefix: '/leading' }, { prefix: 'repeated//slash' }, { prefix: 'x'.repeat(701) }, { region: 'US EAST' }, { accessKeyId: 'key with spaces' }]) { const changed = structuredClone(draft); Object.assign(changed.destinations[2], patch); assert.throws(() => modelRequest(changed)); }
  });
  await check('validation blocks incomplete targets, broken references, invalid weekdays and enabled schedules without credentials', () => {
    const draft = backupDraftFromSaved(configured().saved, 'America/Chicago');
    for (const edit of [x => x.destinations[0].sharePath = '', x => x.destinations[0].timeoutSeconds = 29, x => x.destinations[0].sharePath = 'Z:\\backups', x => x.schedules[0].dailyTime = '24:00', x => x.schedules[0].retentionDays = 0, x => x.schedules[0].destinationId = 'missing', x => x.schedules[0].daysOfWeek = [1, 1], x => x.schedules[0].daysOfWeek = [7], x => x.schedules[0].name = '', x => x.destinations.push(x.destinations[0])]) { const changed = structuredClone(draft); edit(changed); assert.throws(() => modelRequest(changed)); }
    const missing = emptyBackupSecrets(); missing.destinations.s3 = { ...emptyDestinationSecrets(), clearSecretAccessKey: true }; assert.throws(() => modelRequest(draft, missing), /credentials/);
    assert.doesNotThrow(() => backupSettingsRequest('r1', backupDraftFromSaved(fixture().saved, 'UTC'), { ...emptyBackupSecrets(), replaceArchivePassphrase: true, archivePassphrase: 'synthetic-passphrase', confirmation: 'synthetic-passphrase' }));
    for (const phrase of ['short', 'x'.repeat(1025)]) assert.throws(() => modelRequest(draft, { ...emptyBackupSecrets(), replaceArchivePassphrase: true, archivePassphrase: phrase, confirmation: phrase }));
    assert.throws(() => modelRequest(draft, { ...emptyBackupSecrets(), replaceArchivePassphrase: true, archivePassphrase: 'synthetic-passphrase', confirmation: 'different' }));
  });
  await check('new installs show disabled 02:00 seven-day defaults and require a saved archive passphrase', async () => {
    const ui = await loaded();
    assert.equal(ui.field('Daily time').props.value, '02:00'); assert.equal(ui.field('Keep backups for days').props.value, 7); assert.equal(ui.field('Enable schedule').props.checked, false);
    assert.equal(ui.button('Create download').props.disabled, true); assert.equal(ui.button('Run saved schedule now').props.disabled, true);
    ui.change('Set archive passphrase', true); ui.change('New archive passphrase', 'synthetic-archive-passphrase'); ui.change('Confirm archive passphrase', 'synthetic-archive-passphrase');
    assert.equal(ui.field('New archive passphrase').props.type, 'password'); ui.submit(); await settle(); ui.render();
    assert.equal(ui.button('Create download').props.disabled, false); assert.ok(!ui.all().some(node => node.type === 'input' && node.props.type === 'password'));
  });
  await check('enabling a schedule explains missing archive encryption and accepts a replacement in the same save', async () => {
    const initial = configured(); initial.hasArchivePassphrase = false; initial.saved.schedules.forEach(item => item.enabled = false);
    const ui = await loaded(initial); ui.change('Enable schedule', true);
    assert.equal(ui.button('Save backup settings').props.disabled, true); assert.match(ui.text(), /Set an archive passphrase before enabling/);
    ui.change('Set archive passphrase', true); ui.change('New archive passphrase', 'synthetic-new-passphrase'); ui.change('Confirm archive passphrase', 'synthetic-new-passphrase');
    assert.equal(ui.button('Save backup settings').props.disabled, false); ui.submit(); await settle(); ui.render();
    const request = api.calls.find(call => call.method === 'PUT').body; assert.equal(request.settings.schedules[0].enabled, true); assert.equal(request.archivePassphrase, 'synthetic-new-passphrase');
  });
  await check('destination forms show only fields and write-only secret controls for the selected transport', async () => {
    const ui = await loaded(configured()); ui.click('Destinations');
    assert.ok(ui.field('Network share folder')); assert.ok(ui.field('Domain (optional)')); assert.ok(!ui.all().some(node => node.type === 'label' && /FTP host|Bucket|Secret access key/.test(text(node))));
    ui.click('Edit destination FTPS archive'); assert.equal(ui.field('FTP port').props.value, 2121); assert.ok(!ui.all().some(node => node.type === 'label' && /Network share folder|Domain \(optional\)|Bucket/.test(text(node))));
    ui.click('Edit destination Cloud archive'); assert.equal(ui.field('Bucket').props.value, 'fixture-backups'); assert.ok(ui.field('HTTPS endpoint (optional)')); assert.ok(!ui.all().some(node => node.type === 'label' && /FTP host|Destination username|Domain \(optional\)/.test(text(node))));
    ui.change('Replace secret access key', true); assert.equal(ui.field('New secret access key').props.value, ''); assert.equal(ui.field('New secret access key').props.type, 'password');
  });
  await check('drafts and independent destination secrets survive selection, tabs and the Restore panel', async () => {
    const ui = await loaded(configured(), undefined, { restoreContent: React.createElement('div', null, 'Restore review fixture') });
    ui.change('Keep backups for days', '14'); ui.click('Destinations'); ui.click('Edit destination FTPS archive'); ui.change('Replace destination password', true); ui.change('New destination password', 'synthetic-ftp-password');
    ui.click('Edit destination Cloud archive'); ui.change('Replace secret access key', true); ui.change('New secret access key', 'synthetic-s3-secret'); ui.change('Key prefix', 'new-prefix/');
    ui.click('Restore'); assert.match(ui.text(), /Restore review fixture/); assert.equal(window.location.hash, '#backups/restore');
    ui.click('Schedules'); assert.equal(ui.field('Keep backups for days').props.value, 14);
    ui.click('Destinations'); assert.equal(ui.field('New secret access key').props.value, 'synthetic-s3-secret'); ui.click('Edit destination FTPS archive'); assert.equal(ui.field('New destination password').props.value, 'synthetic-ftp-password');
    assert.equal(api.calls.length, 1); assert.equal(ui.button('Create download').props.disabled, true);
  });
  await check('tabs support arrow, Home and End navigation with one tab stop, focus and preserved drafts', async () => {
    const ui = await loaded(configured(), undefined, { restoreContent: React.createElement('div', null, 'Restore review fixture') });
    ui.change('Keep backups for days', '14');
    const active = label => {
      const tabs = ui.all().filter(node => node.props.role === 'tab');
      assert.equal(tabs.filter(node => node.props.tabIndex === 0).length, 1);
      for (const tab of tabs) { assert.equal(tab.props.tabIndex, text(tab) === label ? 0 : -1); assert.equal(tab.props['aria-selected'], text(tab) === label); }
      const panel = ui.find(node => node.props.role === 'tabpanel'); assert.equal(panel.props.id, ui.button(label).props['aria-controls']); assert.equal(panel.props['aria-labelledby'], ui.button(label).props.id);
    };
    active('Schedules');
    for (const [from, key, to] of [['Schedules', 'ArrowRight', 'Destinations'], ['Destinations', 'End', 'Restore'], ['Restore', 'Home', 'Schedules'], ['Schedules', 'ArrowLeft', 'Restore'], ['Restore', 'ArrowRight', 'Schedules']]) {
      assert.equal(ui.pressKey(from, key), true); active(to); assert.equal(ui.focused(), to); assert.equal(window.location.hash, `#backups/${to.toLowerCase()}`);
    }
    assert.equal(ui.field('Keep backups for days').props.value, 14); assert.equal(ui.pressKey('Schedules', 'ArrowDown'), false); active('Schedules'); assert.equal(api.calls.length, 1);
    hooks.unmount(); const restricted = await loaded(configured()); assert.equal(restricted.all().filter(node => node.props.role === 'tab').length, 2);
    restricted.pressKey('Schedules', 'ArrowLeft'); assert.equal(restricted.focused(), 'Destinations'); assert.equal(restricted.button('Destinations').props.tabIndex, 0);
    restricted.pressKey('Destinations', 'Home'); assert.equal(restricted.focused(), 'Schedules'); assert.equal(restricted.button('Schedules').props.tabIndex, 0);
  });
  await check('destination usage labels distinguish zero, one and multiple schedules as drafts change', async () => {
    const ui = await loaded(configured()); ui.click('Destinations');
    const count = label => text(nodes(ui.button(label)).find(node => node.type === 'small'));
    assert.equal(count('Edit destination FTPS archive'), '0 schedules'); assert.equal(count('Edit destination Plant share'), '1 schedule');
    ui.click('Schedules'); ui.click('Add schedule'); ui.click('Destinations'); assert.equal(count('Edit destination Plant share'), '2 schedules');
    assert.equal(api.calls.filter(call => call.method === 'PUT').length, 0);
  });
  await check('status polling preserves shared drafts and Cancel adopts the latest saved snapshot without reloading', async () => {
    const initial = configured(), ui = await loaded(initial); ui.change('Keep backups for days', '14');
    ui.click('Destinations'); ui.click('Edit destination FTPS archive'); ui.change('Replace destination password', true); ui.change('New destination password', 'synthetic-password');
    const latest = structuredClone(initial); latest.revision = 'changed-elsewhere'; latest.saved.schedules[0].retentionDays = 30;
    api.setHandler(async () => latest); ui.poll(); await settle(); ui.render();
    assert.match(ui.text(), /changed in another session/); assert.equal(ui.field('New destination password').props.value, 'synthetic-password'); assert.equal(ui.button('Save backup settings').props.disabled, true);
    ui.submit(); assert.equal(api.calls.filter(call => call.method === 'PUT').length, 0);
    const requestsBeforeCancel = api.calls.length; ui.click('Cancel changes'); assert.equal(api.calls.length, requestsBeforeCancel);
    ui.click('Schedules'); assert.equal(ui.field('Keep backups for days').props.value, 30); assert.doesNotMatch(ui.text(), /changed in another session/); assert.equal(ui.button('Cancel changes').props.disabled, true);
    ui.click('Destinations'); assert.ok(!ui.all().some(node => node.type === 'input' && node.props.type === 'password'));
    assert.ok(!ui.all().some(node => node.type === 'button' && /\b(refresh|reload)\b/i.test(text(node))));
    ui.click('Schedules'); ui.change('Keep backups for days', '31'); ui.submit(); await settle(); ui.render();
    assert.equal(api.calls.find(call => call.method === 'PUT').body.revision, latest.revision);
  });
  await check('Cancel clears local edits while keeping failed status visible and contextual Retry available', async () => {
    const initial = configured(), ui = await loaded(initial); assert.equal(ui.button('Cancel changes').props.disabled, true);
    ui.change('Keep backups for days', '14'); api.setHandler(async () => { throw new Error('Status temporarily unavailable'); }); ui.poll(); await settle(); ui.render();
    assert.match(ui.text(), /Status temporarily unavailable/); const requestsBeforeCancel = api.calls.length; ui.click('Cancel changes');
    assert.equal(api.calls.length, requestsBeforeCancel); assert.equal(ui.field('Keep backups for days').props.value, 7); assert.match(ui.text(), /Status temporarily unavailable/);
    assert.equal(ui.button('Cancel changes').props.disabled, true); assert.equal(ui.button('Create download').props.disabled, true);
    api.setHandler(async () => structuredClone(initial)); ui.click('Retry'); await settle(); ui.render(); assert.doesNotMatch(ui.text(), /Status temporarily unavailable/); assert.equal(ui.button('Create download').props.disabled, false);
  });
  await check('adding and removing items updates selection and prevents removal of a referenced destination', async () => {
    const ui = await loaded(configured()); ui.click('Add schedule'); assert.equal(ui.field('Daily time').props.value, '02:00'); assert.equal(ui.field('Enable schedule').props.checked, false);
    ui.change('Schedule name', 'Added schedule'); ui.click('Remove schedule'); ui.click('Keep schedule'); assert.equal(ui.field('Schedule name').props.value, 'Added schedule'); ui.click('Remove schedule'); ui.click('Confirm remove schedule');
    assert.equal(ui.field('Schedule name').props.value, 'Morning backup'); ui.click('Destinations'); assert.equal(ui.button('Remove destination').props.disabled, true);
    ui.click('Add destination'); ui.change('Destination name', 'Added share'); ui.change('Network share folder', '\\\\backup-server\\added'); assert.equal(ui.button('Edit destination Added share').props['aria-pressed'], true);
    ui.click('Remove destination'); ui.click('Confirm remove destination'); assert.equal(ui.field('Destination name').props.value, 'Plant share'); assert.equal(api.calls.filter(call => call.method === 'PUT').length, 0);
  });
  await check('list searches preserve selected item edits across both tabs', async () => {
    const ui = await loaded(configured()); ui.change('Keep backups for days', '14'); ui.change('Search schedules', 'Weekly');
    assert.equal(ui.all().filter(node => node.props?.['aria-label']?.startsWith('Edit schedule ')).length, 1); ui.click('Edit schedule Weekly cloud'); ui.change('Daily time', '05:00'); ui.change('Search schedules', ''); ui.click('Edit schedule Morning backup'); assert.equal(ui.field('Keep backups for days').props.value, 14);
    ui.click('Destinations'); ui.change('Search destinations', 'Cloud'); assert.equal(ui.all().filter(node => node.props?.['aria-label']?.startsWith('Edit destination ')).length, 1); ui.click('Edit destination Cloud archive'); ui.change('Key prefix', 'edited/'); ui.change('Search destinations', ''); ui.click('Edit destination Plant share'); ui.click('Edit destination Cloud archive'); assert.equal(ui.field('Key prefix').props.value, 'edited/');
    ui.change('Search destinations', 'no matches'); assert.match(ui.text(), /No destinations match/); ui.click('Schedules'); ui.change('Search schedules', 'no matches'); assert.match(ui.text(), /No schedules match/);
  });
  await check('one atomic save includes weekday schedules, target edits and isolated secrets, and clears successful replacements', async () => {
    const initial = configured(), pending = deferred(), ui = await loaded(initial, async (_route, method) => method === 'PUT' ? pending.promise : structuredClone(initial));
    ui.change('Repeat', 'weekly'); ui.change('Wednesday', true); ui.change('Keep backups for days', '14'); ui.click('Destinations'); ui.click('Edit destination FTPS archive'); ui.change('Replace destination password', true); ui.change('New destination password', 'synthetic-password'); ui.click('Edit destination Cloud archive'); ui.change('Clear stored session token', true); ui.change('Key prefix', 'new-prefix/');
    ui.submit(); ui.submit(); assert.equal(api.calls.filter(call => call.method === 'PUT').length, 1);
    const request = api.calls.find(call => call.method === 'PUT').body; assert.equal(request.revision, initial.revision); assert.deepEqual(request.settings.schedules[0].daysOfWeek, [1, 3]); assert.equal(request.settings.schedules[0].retentionDays, 14); assert.equal(request.settings.destinations[2].settings.prefix, 'new-prefix/'); assert.deepEqual(request.destinationSecrets, [{ destinationId: 'ftp', password: 'synthetic-password' }, { destinationId: 's3', clearSessionToken: true }]);
    pending.resolve({ ...initial, saved: request.settings, revision: 'fixture-revision-2' }); await settle(); ui.render(); assert.equal(ui.button('Save backup settings').props.disabled, true); ui.click('Edit destination FTPS archive'); assert.ok(!ui.all().some(node => node.type === 'input' && node.props.type === 'password'));
  });
  await check('invalid edits block submit and failed saves retain the draft and replacement secrets', async () => {
    const initial = configured(), ui = await loaded(initial, async (_route, method) => { if (method === 'PUT') throw new Error('Synthetic save failure.'); return structuredClone(initial); });
    ui.change('Keep backups for days', ''); assert.equal(ui.button('Save backup settings').props.disabled, true); ui.submit(); assert.equal(api.calls.filter(call => call.method === 'PUT').length, 0);
    ui.change('Keep backups for days', '14'); ui.click('Destinations'); ui.click('Edit destination FTPS archive'); ui.change('Replace destination password', true); ui.change('New destination password', 'synthetic-password'); ui.submit(); await settle(); ui.render();
    assert.match(ui.text(), /Synthetic save failure/); assert.equal(ui.field('New destination password').props.value, 'synthetic-password'); ui.click('Schedules'); assert.equal(ui.field('Keep backups for days').props.value, 14);
  });
  await check('manual downloads and per-schedule or per-target runs use saved identities and authenticated downloads', async () => {
    const initial = { ...configured(), downloadId: 'fixture-archive' };
    const ui = await loaded(initial, async (_route, method) => method === 'FETCH' ? new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Disposition': 'attachment; filename="fixture.sparkbak"' } }) : structuredClone(initial));
    ui.click('Create download'); await settle(); ui.render(); ui.click('Run saved schedule now'); await settle(); ui.render(); ui.click('Destinations'); ui.click('Edit destination FTPS archive'); ui.click('Back up to saved destination'); await settle(); ui.render();
    assert.deepEqual(api.calls.filter(call => call.method === 'POST').map(call => call.body), [{ deliver: false }, { deliver: true, scheduleId: 'morning' }, { deliver: true, destinationId: 'ftp' }]);
    ui.click('Download latest archive'); await settle(); ui.render(); assert.deepEqual(downloaded, ['fixture.sparkbak']); assert.ok(api.calls.some(call => call.method === 'FETCH' && call.route === '/api/gateway/backups/download/fixture-archive'));
    ui.change('Destination name', 'Unsaved target'); assert.equal(ui.button('Back up to saved destination').props.disabled, true);
  });
  await check('recovery, running, failed status and missing credentials prevent new backup actions', async () => {
    const initial = configured(), ui = await loaded(initial);
    for (const patch of [{ recoveryBlocked: true }, { running: true }, { configurationError: 'Invalid backup configuration' }]) { api.setHandler(async () => ({ ...initial, ...patch })); ui.poll(); await settle(); ui.render(); assert.equal(ui.button('Create download').props.disabled, true); }
    api.setHandler(async () => { throw new Error('Status request failed'); }); ui.poll(); await settle(); ui.render(); assert.match(ui.text(), /Status request failed/); assert.equal(ui.button('Create download').props.disabled, true);
    api.setHandler(async () => ({ ...initial, destinationSecrets: [] })); ui.poll(); await settle(); ui.render(); ui.click('Destinations'); ui.click('Edit destination Cloud archive'); assert.equal(ui.button('Back up to saved destination').props.disabled, true);
  });
  await check('recovery permits configuration repair while runs stay blocked and the global result names its owner', async () => {
    const initial = { ...configured(), recoveryBlocked: true, lastRun: { id: 'run-fixture', status: 'succeeded', startedAt: '2026-09-30T12:00:00Z', completedAt: '2026-09-30T12:00:10Z', message: 'Verified fixture archive.', archiveName: 'fixture.sparkbak', bytes: 4096, removedCount: 0, scheduleId: 'weekly', destinationId: 's3' } };
    const ui = await loaded(initial); assert.match(ui.text(), /Schedule: Weekly cloud/); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, false);
    ui.change('Keep backups for days', '14'); assert.equal(ui.button('Save backup settings').props.disabled, false); ui.submit(); await settle(); ui.render();
    assert.equal(api.calls.filter(call => call.method === 'PUT').length, 1); assert.equal(ui.button('Create download').props.disabled, true); assert.equal(ui.button('Run saved schedule now').props.disabled, true);
  });
  await check('Restore bookmarks require supplied content and hash navigation preserves the draft', async () => {
    const ui = await loaded(configured(), undefined, { restoreContent: React.createElement('div', null, 'Restore review fixture') }, '#recovery'); assert.match(ui.text(), /Restore review fixture/);
    ui.hashChange('#backups/schedules'); ui.change('Daily time', '03:00'); ui.hashChange('#backups/restore'); assert.match(ui.text(), /Restore review fixture/); ui.hashChange('#backups/schedules'); assert.equal(ui.field('Daily time').props.value, '03:00');
    hooks.unmount(); const restricted = await loaded(configured(), undefined, {}, '#backups/restore'); assert.ok(!restricted.all().some(node => node.type === 'button' && text(node) === 'Restore')); assert.ok(restricted.field('Daily time'));
  });
  await check('Strict Mode effect replay does not leave initial loading locked', async () => {
    const first = deferred(); let calls = 0;
    const ui = start(fixture(), async () => ++calls === 1 ? first.promise : fixture()); hooks.replay(); await settle(); ui.render(); first.resolve(fixture()); await settle(); ui.render();
    assert.equal(ui.field('Daily time').props.value, '02:00'); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, false);
  });
  console.log(`${passed} backup UI/model groups passed.`);
} finally { globalThis.window = nativeWindow; globalThis.document = nativeDocument; }
