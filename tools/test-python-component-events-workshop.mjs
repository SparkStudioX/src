#!/usr/bin/env node
// Owned loopback acceptance using authored synthetic projects; never live gateway data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { buildWorkshop, readCatalog, readZip } from './workshop-packages.mjs';

assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--browser', 'Only --browser is supported.');
const browser = process.argv.includes('--browser'), base = 'http://127.0.0.1:5094';
const fixture = path.resolve('.data/test-evidence', `python-component-events-${randomUUID()}`);
const application = path.join(fixture, 'app'), data = path.join(fixture, 'data');
const dotnet = path.resolve('.tools/dotnet/dotnet.exe');
const account = { username: 'event-admin', password: randomUUID() + randomUUID() };
let child, output = '', admin, projectId, checks = 0;
const pass = name => { checks++; console.log(`PASS ${name}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(100); }
  throw new Error(`Timed out: ${description}`);
}
async function login(audience = 'engineering', identity = account) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...identity, audience, ...(projectId ? { projectId } : {}) }) });
  assert.equal(response.status, 200);
  return { audience, csrf: (await response.json()).csrfToken, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
}
async function request(route, { method = 'GET', body, status = 200, session = admin, binary = false, previewToken, csrf = true } = {}) {
  const headers = new Headers();
  if (session) { headers.set('Cookie', session.cookie); headers.set('X-SPARK-AUDIENCE', session.audience); if (csrf) headers.set('X-SPARK-CSRF', session.csrf); }
  if (previewToken) headers.set('X-SPARK-PREVIEW', previewToken);
  if (body !== undefined) headers.set('Content-Type', binary ? 'application/zip' : 'application/json');
  const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : binary ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, status, `${method} ${route}: ${response.status} ${bytes.toString().slice(0, 650)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString()) : null;
}
const project = (suffix, options) => request(`/api/projects/${projectId}${suffix}`, options);
const ui = (instance = {}) => ({ state: { session: {}, screen: {}, instance }, properties: {} });
const inputs = { order: 'WO1001', quantity: 12, note: 'Ready' };
const inputEvent = (id, type, value, previousValue) => ({ type, componentId: id, fieldKey: id, value, previousValue, origin: 'user' });
const inputSelector = type => ({ family: 'input', type });
const stateValue = (response, key) => response.uiEffects?.find(effect => effect.kind === 'state' && effect.key === key)?.value;
const propertyValue = (response, id) => response.uiEffects?.find(effect => effect.kind === 'property' && effect.componentId === id)?.value;
function success(response) { assert.equal(response.success, true, response.stderr); return response; }
let runtime;
const bodyFor = (eventHandler, event, patch = {}) => ({ publishedAt: runtime.publishedAt, parameters: {}, inputs: { ...inputs }, ui: ui(), instanceId: 'station-a', eventHandler, event, ...patch });
const send = (component, body, options = {}) => project(`/runtime/screens/python-component-events/components/${component}/events`, { method: 'POST', body, ...options });

try {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(5094, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
  await fs.mkdir(fixture, { recursive: true });
  await fs.cp(path.resolve('artifacts/python-component-events-tests'), application, { recursive: true });
  await fs.cp(path.resolve('apps/web/dist'), path.join(application, 'wwwroot'), { recursive: true });
  child = spawn(dotnet, [path.join(application, 'SparkStudio.Gateway.dll'), '--urls', base], {
    cwd: application, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DOTNET_ROOT: path.dirname(dotnet), DOTNET_CLI_HOME: path.resolve('.tools/dotnet-home'), SPARKSTUDIO_DATA_DIR: data, SPARKSTUDIO_PYTHON: path.resolve('runtimes/python/windows-x64/python.exe') },
  });
  child.stdout.on('data', bytes => output = (output + bytes).slice(-150000)); child.stderr.on('data', bytes => output = (output + bytes).slice(-150000));
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Fixture exited ${child.exitCode}: ${output.slice(-1500)}`);
    try { return (await fetch(base + '/api/ready')).ok; } catch { return false; }
  }, 'gateway readiness');
  const setupCode = (await fs.readFile(path.join(data, 'security/setup-code.txt'), 'utf8')).trim();
  await request('/api/auth/setup', { method: 'POST', session: null, body: { ...account, displayName: 'Python event fixture', setupCode } });
  admin = await login();
  const gatewayBefore = { tags: await request('/api/tag-definitions'), connections: await request('/api/connections') };
  const catalog = await readCatalog(process.cwd()), entry = catalog.workshops.find(item => item.id === 'python-component-events');
  const built = await buildWorkshop(process.cwd(), entry, '2026-09-30T00:00:00.000Z');
  const imported = JSON.parse((await request('/api/projects/import?name=Python%20event%20acceptance', { method: 'POST', binary: true, body: built.bytes })).toString());
  projectId = imported.id; assert.equal(imported.published, false);
  const saved = await project('/project');
  assert.deepEqual(saved.screens, built.project.screens); assert.deepEqual(saved.templates, built.project.templates);
  await project('/project/publish', { method: 'POST', body: { revision: saved.revision } });
  const operatorA = await login('operator'), operatorB = await login('operator');
  assert.notEqual(operatorA.cookie, operatorB.cookie);
  runtime = await project('/runtime/project', { session: operatorA });
  assert.deepEqual((await project('/runtime/project', { session: operatorB })).templates, runtime.templates);
  assert.ok(!JSON.stringify(runtime).includes('orders = {'), 'Published Python event code must not be sent to operators.');
  pass('authored package imports unpublished, publishes for two sessions and withholds executable Python event source');

  const loadBody = bodyFor(inputSelector('commit'), inputEvent('order', 'commit', 'WO1002', 'WO1001'), { inputs: { ...inputs, order: 'WO1002' } });
  const loaded = success(await send('order', loadBody, { session: operatorA }));
  assert.equal(stateValue(loaded, 'part'), 'Mounting bracket'); assert.equal(stateValue(loaded, 'target'), 24); assert.equal(stateValue(loaded, 'quantity'), 24);
  assert.match(loaded.stdout, /Loaded WO1002/);
  assert.deepEqual((await project('/runtime/project', { session: operatorB })).templates, runtime.templates);
  const note = success(await send('note', bodyFor(inputSelector('change'), inputEvent('note', 'change', 'Shift B', 'Ready'), { inputs: { ...inputs, note: 'Shift B' } }), { session: operatorA }));
  assert.equal(propertyValue(note, 'note-preview'), 'Note: Shift B');
  const invalid = success(await send('quantity', bodyFor(inputSelector('change'), inputEvent('quantity', 'change', 0, 12), { inputs: { ...inputs, quantity: 0 } }), { session: operatorA }));
  assert.equal(stateValue(invalid, 'valid'), false); assert.match(stateValue(invalid, 'validation'), /between 1 and 12/);
  pass('actual CPython input commit/change loads private form state, returns sibling effects and handles an invalid business quantity');

  const propertyEvent = { type: 'propertyChange', componentId: 'part', property: 'text', value: 'Mounting bracket', previousValue: 'Valve housing', available: true, previousAvailable: true, error: '', previousError: '', origin: 'binding' };
  const changed = success(await send('part', bodyFor({ family: 'propertyChange' }, propertyEvent), { session: operatorA }));
  assert.match(propertyValue(changed, 'event-log'), /Valve housing to Mounting bracket \(binding\)/);
  const messageEvent = { type: 'message', componentId: 'event-log', messageType: 'orders.reset', scope: 'instance', messageId: 'acceptance-1', payload: { reason: 'Requested reset' } };
  const messageBody = bodyFor({ family: 'message', handlerId: 'reset' }, messageEvent, { ui: ui({ target: 24, quantity: 0 }) });
  const reset = success(await send('event-log', messageBody, { session: operatorA }));
  assert.equal(stateValue(reset, 'quantity'), 24); assert.equal(propertyValue(reset, 'event-log'), 'Requested reset at station A');
  assert.match(reset.stdout, /orders.reset/);
  pass('property-change and message receivers execute saved Python with their own component, event data and current state');

  const rowBody = bodyFor(inputSelector('change'), inputEvent('note', 'change', 'Row one only', 'Ready'), { instanceId: 'stations', rowId: 'row-1', inputs: { ...inputs, note: 'Row one only' } });
  const row = success(await project('/runtime/screens/python-event-rows/components/note/events', { method: 'POST', session: operatorA, body: rowBody }));
  assert.equal(propertyValue(row, 'note-preview'), 'Note: Row one only');
  await project('/runtime/screens/python-event-rows/components/note/events', { method: 'POST', session: operatorA, body: { ...rowBody, rowId: 'missing' }, status: 404 });
  pass('published repeater membership resolves the receiving form and rejects an absent row');

  for (const [component, body, status = 400] of [
    ['order', { ...loadBody, eventHandler: { family: 'input', type: 'unknown' } }],
    ['order', { ...loadBody, event: { ...loadBody.event, value: 23 } }],
    ['order', { ...loadBody, inputs: { ...loadBody.inputs, password: 'not-declared' } }],
    ['part', bodyFor({ family: 'propertyChange' }, { ...propertyEvent, property: 'visible' })],
    ['event-log', { ...messageBody, eventHandler: { family: 'message', handlerId: 'missing' } }, 404],
    ['event-log', { ...messageBody, event: { ...messageEvent, payload: { text: 'x'.repeat(70000) } } }],
  ]) await send(component, body, { session: operatorA, status });
  await send('order', loadBody, { session: operatorA, csrf: false, status: 403 });
  await send('order', loadBody, { session: admin, status: 401 });
  const viewerIdentity = { username: 'event-viewer', password: randomUUID() + randomUUID() };
  await request('/api/security/users', { method: 'POST', status: 201, body: { ...viewerIdentity, displayName: 'Event viewer', projectGrants: { [projectId]: { view: true, operate: false, design: false, publish: false } } } });
  await send('order', loadBody, { session: await login('operator', viewerIdentity), status: 403 });
  pass('event selectors, value types, foreign inputs, watchlists, payload size, CSRF, audience and Operate permission are enforced');

  const readOnly = await project('/preview/sessions', { method: 'POST', body: { mode: 'read-only' } });
  const live = await project('/preview/sessions', { method: 'POST', body: { mode: 'live-actions' } });
  try {
    const previewBody = { ...loadBody }; delete previewBody.publishedAt;
    const route = '/preview/screens/python-component-events/components/order/events';
    await project(route, { method: 'POST', body: previewBody, previewToken: readOnly.token, status: 403 });
    await project(route, { method: 'POST', body: previewBody, status: 403 });
    const previewLoad = success(await project(route, { method: 'POST', body: previewBody, previewToken: live.token }));
    assert.equal(stateValue(previewLoad, 'quantity'), 24);
    const standalone = { ...previewBody }; delete standalone.instanceId;
    const standaloneLoad = success(await project('/preview/templates/python-order-form/components/order/events', { method: 'POST', body: standalone, previewToken: live.token }));
    assert.equal(stateValue(standaloneLoad, 'part'), 'Mounting bracket');
    await project(route, { method: 'POST', body: previewBody, previewToken: live.token, session: operatorA, status: 401 });
  } finally {
    for (const session of [readOnly, live]) await project('/preview/session', { method: 'DELETE', previewToken: session.token, status: 204 });
  }
  pass('real Preview event endpoints require a live capability and resolve both saved screens and standalone templates');

  const exported = readZip(await project('/export', { binary: true }));
  const portable = JSON.parse(exported.get('project.json'));
  assert.deepEqual(portable.screens, built.project.screens); assert.deepEqual(portable.templates, built.project.templates);
  assert.deepEqual(await request('/api/tag-definitions'), gatewayBefore.tags); assert.deepEqual(await request('/api/connections'), gatewayBefore.connections);
  pass('re-export retains authored handlers/defaults and the workshop creates no gateway tags, connections or data writes');

  const draft = await project('/project');
  draft.templates[0].components.find(component => component.id === 'note').props.events.change.code = 'self.getSibling("note-preview").text = "Draft source must remain private"';
  await project('/project', { method: 'PUT', body: draft });
  const publishedAgain = success(await send('note', bodyFor(inputSelector('change'), inputEvent('note', 'change', 'Published only', 'Ready'), { inputs: { ...inputs, note: 'Published only' } }), { session: operatorA }));
  assert.equal(propertyValue(publishedAgain, 'note-preview'), 'Note: Published only');
  const restoredDraft = await project('/project'); restoredDraft.templates = structuredClone(built.project.templates);
  const restored = await project('/project', { method: 'PUT', body: restoredDraft });
  await project('/project/publish', { method: 'POST', body: { revision: restored.revision } });
  await send('order', loadBody, { session: operatorA, status: 409 });
  pass('unsaved publication changes cannot replace event code and replaced publication revisions reject old requests');

  await fs.writeFile(path.join(fixture, 'verification.json'), JSON.stringify({ checks, projectId, baseUrl: base, completedAt: new Date().toISOString(), browserVerified: false }, null, 2));
  console.log(`${checks}/${checks} Python component event acceptance checks passed.`);
  if (browser) {
    await fs.writeFile(path.join(fixture, 'browser-auth.json'), JSON.stringify({ baseUrl: base, projectId, admin: account }, null, 2));
    console.log(`BROWSER fixture: ${fixture}`); console.log(`BROWSER URL: ${base}/designer/${projectId}`);
    let finished = false; process.stdin.once('data', () => { finished = true; });
    while (!finished) { try { await fs.access(path.join(fixture, 'browser-done')); finished = true; } catch { await pause(250); } }
  }
} finally {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  await fs.mkdir(fixture, { recursive: true }); await fs.writeFile(path.join(fixture, 'gateway.log'), output);
}
