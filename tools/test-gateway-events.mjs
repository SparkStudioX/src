#!/usr/bin/env node
// Owns an isolated gateway and synthetic data. Never connects to installed gateways.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readZip } from './workshop-packages.mjs';

const root = process.cwd(), base = 'http://127.0.0.1:5091';
const fixture = path.resolve('.data/test-evidence', `gateway-events-${randomUUID()}`);
const buildDirectory = path.resolve('src/SparkStudio.Gateway/bin/Debug/net10.0');
const dll = path.join(fixture, 'app/SparkStudio.Gateway.dll');
const dotnet = path.resolve('.tools/dotnet/dotnet.exe');
const python = path.resolve('runtimes/python/windows-x64/python.exe');
await fs.mkdir(fixture, { recursive: true });
await fs.cp(buildDirectory, path.join(fixture, 'app'), { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(100); }
  throw new Error(`Timed out: ${message}`);
}
let child, output = '', admin, operator, viewer, projectId, prefix, draft, checks = 0;
const account = { username: 'events-admin', password: randomUUID() + randomUUID() };
const pass = name => { console.log(`PASS ${name}`); checks++; };
async function start() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(5091, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
  child = spawn(dotnet, [dll, '--urls', base], { cwd: root, windowsHide: true, env: {
    ...process.env, DOTNET_ROOT: path.dirname(dotnet), DOTNET_CLI_HOME: path.resolve('.tools/dotnet-home'),
    SPARKSTUDIO_DATA_DIR: path.join(fixture, 'data'), SPARKSTUDIO_PYTHON: python,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => output = (output + bytes).slice(-100000));
  child.stderr.on('data', bytes => output = (output + bytes).slice(-100000));
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Fixture gateway exited ${child.exitCode}: ${output.slice(-3000)}`);
    try { return (await fetch(base + '/api/ready')).ok; } catch { return false; }
  }, 'fixture readiness');
}
async function stop() {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
}
async function request(route, { method = 'GET', body, session = admin, status = 200, raw = false } = {}) {
  const headers = new Headers();
  if (session) { headers.set('Cookie', session.cookie); headers.set('X-SPARK-AUDIENCE', session.audience); headers.set('X-SPARK-CSRF', session.csrf); }
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, status, `${method} ${route}: ${response.status} ${bytes.toString().slice(0, 500)}`);
  return raw ? bytes : bytes.length ? JSON.parse(bytes.toString()) : null;
}
async function login(who = account, audience = 'engineering') {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...who, audience }) });
  assert.equal(response.status, 200); const data = await response.json();
  return { audience, csrf: data.csrfToken, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
}
const api = (route, options) => request(prefix + route, options);
const save = async resources => draft = await api('/scripts/resources', { method: 'PUT', body: { revision: draft.revision, resources } });
const logs = async id => (await api('/scripts/events/logs')).filter(item => !id || item.resourceId === id);
const publish = async () => {
  const result = await api('/scripts/publish', { method: 'POST', body: { revision: draft.revision } });
  await until(async () => { const state = await api('/scripts/events/status'); return state.activeRevision === result.revision && state.acceptingEvents; }, 'script activation');
  return result;
};
const resource = (id, event, code = 'result = event.type', extras = {}) => ({ id, name: id, type: 'gateway', event, code, enabled: true, parameters: {}, ...extras });
const call = (name, payload = {}, options = {}) => api(`/scripts/messages/${name}/request`, { method: 'POST', body: { payload }, ...options });
const run = id => api(`/scripts/resources/${id}/run`, { method: 'POST', body: { revision: draft.revision, source: 'draft' } });
try {
  await start();
  const setupCode = (await fs.readFile(path.join(fixture, 'data/security/setup-code.txt'), 'utf8')).trim();
  await request('/api/auth/setup', { method: 'POST', session: null, body: { ...account, displayName: 'Event fixture', setupCode } });
  admin = await login(); operator = await login(account, 'operator');
  projectId = (await request('/api/projects', { method: 'POST', body: { name: 'Gateway events fixture' } })).id;
  prefix = `/api/projects/${projectId}`; draft = await api('/scripts/resources');
  const readonly = { username: 'event-viewer', password: randomUUID() + randomUUID() };
  await request('/api/security/users', { method: 'POST', status: 201, body: { ...readonly, projectGrants: { [projectId]: { view: true } } } });
  viewer = await login(readonly, 'operator');
  const tag = '[default]GatewayEventFixture/Value';
  await request('/api/tags', { method: 'POST', body: { path: tag, kind: 'memory', dataType: 'Int32', value: 0 } });
  let resources = [
    resource('startup', 'startup', 'response = system.util.sendRequest(messageHandler="echo", payload={"startup": True})\nresult = {"type": event.type, "project": event.projectId, "reason": event.reason, "timestamp": event.timestamp, "response": response}'),
    resource('shutdown', 'shutdown', 'result = {"reason": event.reason}'),
    resource('update', 'update', 'result = {"actor": actor, "resources": resources, "reason": event.reason}'),
    resource('tag', 'tagChange', 'result = {"path": str(tagPath), "initial": initialChange, "value": newValue.getValue(), "prior": previousValue.getValue() if previousValue else None, "changes": event.changes, "count": executionCount, "missed": missedEvents}', { tagPaths: ['[default]GatewayEventFixture/*'], changeTriggers: ['value', 'quality', 'timestamp'] }),
    resource('clock', 'scheduled', 'result = event.type', { cron: '* * * * *', timeZone: 'UTC' }),
    resource('echo', 'message', 'result = {"payload": payload, "actor": actor}', { requiredPermission: 'operate' }),
    resource('restricted', 'message', 'result = "admin-only"', { requiredPermission: 'admin' }),
    resource('timer', 'timer', 'result = event.executionCount', { intervalMs: 150, enabled: false }),
  ];
  await save(resources);
  assert.equal((await logs()).length, 0, 'Draft does not execute');
  await publish();
  const started = await until(async () => (await logs('startup')).find(item => item.status === 'succeeded'), 'startup');
  assert.equal(started.result.response.payload.startup, true);
  assert.equal(started.result.reason, 'startup'); assert.ok(Number.isFinite(Date.parse(started.result.timestamp)));
  await until(async () => (await logs('tag')).some(item => item.result?.initial === true), 'initial tag event');
  const startupCount = (await logs('startup')).length; await publish(); await delay(250);
  assert.equal((await logs('startup')).length, startupCount);
  pass('published startup and initial tag events execute without clients; same publication is idempotent');

  await request('/api/tags', { method: 'POST', body: { path: tag, kind: 'memory', dataType: 'Int32', value: 7 } });
  const changed = await until(async () => (await logs('tag')).find(item => item.result?.value === 7 && !item.result.initial), 'tag change');
  assert.equal(changed.result.prior, 0); assert.ok(changed.result.changes.includes('value'));
  await request('/api/tags', { method: 'POST', body: { path: tag, kind: 'memory', dataType: 'Int32', value: 7, enabled: false } });
  await until(async () => (await logs('tag')).some(item => item.result?.changes.includes('quality')), 'quality event');
  pass('tag events expose real previous/current values, value/quality changes and initial context');

  assert.deepEqual((await call('echo', { nested: { value: 42 } })).result.payload, { nested: { value: 42 } });
  assert.equal((await api('/runtime/messages/echo/request', { method: 'POST', session: operator, body: { payload: {} } })).result.actor, account.username);
  await api('/runtime/messages/echo/request', { method: 'POST', session: viewer, body: { payload: {} }, status: 403 });
  await api('/runtime/messages/restricted/request', { method: 'POST', session: operator, body: { payload: {} }, status: 403 });
  await call('echo', {}, { session: null, status: 401 });
  await call('echo', {}, { session: { ...admin, csrf: '' }, status: 403 });
  await call('echo', {}, { body: { payload: {}, revision: draft.revision - 1 }, status: 409 });
  await call('echo', {}, { body: { payload: [] }, status: 400 });
  pass('message requests enforce audience, permission, CSRF, revision and payload checks');

  const project = await api('/project'); project.parameters = { ...project.parameters, eventTest: 'saved' };
  await api('/project', { method: 'PUT', body: project });
  await until(async () => (await logs('update')).some(item => item.result?.actor === account.username && item.result.resources.manifestChanged), 'project update');
  resources.push(resource('caller', 'startup', 'a = system.util.sendRequest(messageHandler="echo", payload={"source": "sync"})\nb = system.util.sendRequestAsync(messageHandler="echo", payload={"source": "async"}).result()\nc = system.util.sendMessage(messageHandler="echo", payload={"source": "send"})\nresult = {"a": a, "b": b, "c": c}', { enabled: false }));
  resources.push(resource('recursive', 'message', 'result = system.util.sendRequest(messageHandler="recursive")'));
  await save(resources); await publish();
  const called = await run('caller'); assert.equal(called.success, true, called.stderr);
  assert.equal(called.result.a.payload.source, 'sync'); assert.equal(called.result.b.payload.source, 'async');
  await until(async () => (await logs('echo')).some(item => item.result?.payload.source === 'send'), 'queued send');
  const recursive = await call('recursive'); assert.equal(recursive.success, false); assert.match(recursive.stderr, /recurs|cycle|already|chain/i);
  pass('saved updates carry actor/resource metadata; CPython sync, async, one-way messaging and recursion rejection');

  const scheduled = await until(async () => (await logs('clock')).find(item => item.status === 'succeeded'), 'calendar event at minute boundary', 65000);
  assert.equal(scheduled.result, 'scheduled');
  pass('cron event executes at an actual UTC minute boundary');

  const target = (await request('/api/projects', { method: 'POST', body: { name: 'Message destination fixture' } })).id;
  const targetPrefix = `/api/projects/${target}`;
  const targetDraft = await request(targetPrefix + '/scripts/resources');
  const targetSaved = await request(targetPrefix + '/scripts/resources', { method: 'PUT', body: {
    revision: targetDraft.revision, resources: [resource('destination', 'message', 'result = {"project": event.projectId, "payload": payload}'),
      resource('lane-hold', 'message', 'import time\ntime.sleep(2)\nresult = "released"', { threading: 'shared' }),
      resource('deadline-target', 'message', 'result = payload', { threading: 'shared' })],
  } });
  await request(targetPrefix + '/scripts/publish', { method: 'POST', body: { revision: targetSaved.revision } });
  await until(async () => (await request(targetPrefix + '/scripts/events/status')).acceptingEvents, 'cross-project destination');
  resources.push(resource('cross-project', 'startup', `result = system.util.sendRequest(project="${target}", messageHandler="destination", payload={"cross": True})`, { enabled: false }));
  resources.push(resource('shared-target', 'message', 'result = payload', { threading: 'shared' }));
  resources.push(resource('shared-caller', 'message', 'result = system.util.sendRequest(messageHandler="shared-target")', { threading: 'shared' }));
  resources.push(resource('manual-shared-caller', 'startup', 'result = system.util.sendRequest(messageHandler="shared-target")', { threading: 'shared', enabled: false }));
  resources.push(resource('deadline-caller', 'startup', `import time\nstart = time.monotonic()\ntry:\n    system.util.sendRequest(project="${target}", messageHandler="deadline-target", timeoutSec=0.2)\n    result = {"unexpected": True}\nexcept Exception as error:\n    result = {"error": str(error), "elapsed": time.monotonic() - start}`, { enabled: false }));
  await save(resources); await publish();
  const cross = await run('cross-project'); assert.equal(cross.success, true, cross.stderr);
  assert.equal(cross.result.project, target); assert.deepEqual(cross.result.payload, { cross: true });
  const sharedCycle = await call('shared-caller'); assert.equal(sharedCycle.success, false); assert.match(sharedCycle.stderr, /shared lane|busy handler/i);
  const manualShared = await run('manual-shared-caller'); assert.equal(manualShared.success, false); assert.match(manualShared.stderr, /shared lane|busy handler/i);
  pass('cross-project Python messages target the captured project; shared-lane synchronous deadlocks fail promptly');
  const laneHold = request(targetPrefix + '/scripts/messages/lane-hold/request', { method: 'POST', body: { payload: {} } });
  await until(async () => (await request(targetPrefix + '/scripts/events/logs')).some(item => item.resourceId === 'lane-hold' && item.status === 'running'), 'busy destination lane');
  const timedRequest = await run('deadline-caller'); assert.equal(timedRequest.success, true, timedRequest.stderr);
  assert.match(timedRequest.result.error, /timed out/i); assert.ok(timedRequest.result.elapsed < 1.5, 'Queued RPC obeys its own deadline');
  await laneHold; await delay(100);
  assert.ok(!(await request(targetPrefix + '/scripts/events/logs')).some(item => item.resourceId === 'deadline-target'), 'Expired queued handler never executes');
  pass('request deadlines expire while queued and prevent late handler execution');

  await save([resource('shutdown', 'shutdown', 'result = event.reason'),
    resource('busy-message', 'message', 'import time\ntime.sleep(1)\nresult = payload')]); await publish();
  const deliveries = await Promise.all(Array.from({ length: 60 }, (_, index) => fetch(base + prefix + '/scripts/messages/busy-message/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-SPARK-AUDIENCE': admin.audience, 'X-SPARK-CSRF': admin.csrf },
    body: JSON.stringify({ payload: { index } }),
  }).then(async response => ({ status: response.status, body: await response.json() }))));
  assert.ok(deliveries.some(item => item.status === 200 && item.body.accepted));
  assert.ok(deliveries.some(item => item.status === 409), 'Queue saturation rejects excess work explicitly');
  assert.ok(deliveries.every(item => [200,409].includes(item.status)));
  const activeMessage = await until(async () => (await logs('busy-message')).find(item => item.status === 'running'), 'queued-message worker');
  await save([resource('new-startup', 'startup', 'result = "replacement"')]); await publish();
  const nextStartup = await until(async () => (await logs('new-startup')).find(item => item.status === 'succeeded'), 'replacement startup');
  const stoppedMessage = (await logs('busy-message')).find(item => item.runId === activeMessage.runId);
  assert.equal(stoppedMessage.status, 'cancelled');
  const lastShutdown = (await logs('shutdown')).find(item => item.status === 'succeeded');
  assert.ok(Date.parse(nextStartup.startedAt) >= Date.parse(lastShutdown.finishedAt));
  assert.ok(Date.parse(lastShutdown.startedAt) >= Date.parse(stoppedMessage.finishedAt));
  pass('bounded queues reject overload; publication replacement cancels old work and completes shutdown before startup');

  resources = [resource('shutdown', 'shutdown', 'result = event.reason'),
    resource('slow', 'timer', 'import time\ntime.sleep(0.22)\nresult = event.executionCount', { intervalMs: 100, delayType: 'fixedRate' }),
    resource('timeout', 'startup', 'import time\ntime.sleep(4)', { enabled: false, timeoutMs: 200 }),
    resource('cancel', 'startup', 'import time\ntime.sleep(20)', { enabled: false, timeoutMs: 30000 }),
    resource('longer', 'startup', 'import time\ntime.sleep(10.1)\nresult = "longer"', { enabled: false, timeoutMs: 15000 }),
  ];
  await save(resources); await publish();
  await until(async () => (await logs('slow')).filter(item => item.status === 'succeeded').length >= 3, 'fixed rate invocations');
  const runs = (await logs('slow')).filter(item => item.status === 'succeeded').sort((a,b) => a.startedAt.localeCompare(b.startedAt));
  for (let index=1; index<runs.length; index++) assert.ok(Date.parse(runs[index].startedAt) >= Date.parse(runs[index-1].finishedAt), 'No overlap');
  assert.equal((await run('timeout')).success, false);
  const pending = run('cancel');
  const active = await until(async () => (await logs('cancel')).find(item => item.status === 'running'), 'active run');
  await api(`/scripts/events/runs/${active.runId}/cancel`, { method: 'POST', body: {}, session: operator, status: 401 });
  await api(`/scripts/events/runs/${active.runId}/cancel`, { method: 'POST', body: {} });
  await pending.catch(() => {});
  await until(async () => (await logs('cancel')).some(item => item.status === 'cancelled'), 'cancelled run');
  assert.equal((await run('longer')).result, 'longer');
  pass('fixed-rate overruns do not overlap; configurable deadlines and administrator cancellation work');

  await save([resource('shutdown', 'shutdown', 'result = event.reason'),
    resource('one', 'timer', 'import time\ntime.sleep(0.25)', { intervalMs: 100, threading: 'shared' }),
    resource('two', 'timer', 'import time\ntime.sleep(0.25)', { intervalMs: 100, threading: 'shared' })]); await publish();
  await until(async () => (await logs()).filter(item => ['one','two'].includes(item.resourceId) && item.status === 'succeeded').length >= 4, 'shared lane');
  const shared = (await logs()).filter(item => ['one','two'].includes(item.resourceId) && item.status === 'succeeded').sort((a,b) => a.startedAt.localeCompare(b.startedAt));
  for(let index=1;index<shared.length;index++) assert.ok(Date.parse(shared[index].startedAt) >= Date.parse(shared[index-1].finishedAt));
  await request(`/api/projects/${projectId}/archive`, { method: 'POST', body: { archived: true } });
  await request(`/api/projects/${projectId}/archive`, { method: 'POST', body: { archived: false } });
  await until(async () => (await logs('shutdown')).some(item => item.status === 'succeeded'), 'shutdown history');
  pass('shared execution lane serializes resources; archive/restore executes bounded shutdown and retains history');

  await save([resource('echo', 'message', 'result = payload')]); await publish();
  const beforeRestart = (await logs()).map(item => item.runId);
  await stop(); await start(); admin = await login();
  assert.ok((await logs()).some(item => beforeRestart.includes(item.runId)), 'Run history survives gateway restart');
  assert.deepEqual((await call('echo', { restarted: true })).result, { restarted: true });
  pass('published handlers and bounded execution history survive a process restart');

  const packageBytes = await request(`/api/projects/${projectId}/export`, { raw: true });
  const entries = readZip(packageBytes);
  const scripts = JSON.parse(entries.get('scripts-draft.json').toString());
  assert.equal(scripts.resources[0].event, 'message');
  pass('portable project export preserves gateway event configuration');
  const credentialsFile = path.join(fixture, 'test-accounts.json');
  await fs.writeFile(credentialsFile, JSON.stringify({ baseUrl: base + '/', admin: account }));
  const regression = spawn(process.execPath, ['--import', './tools/test-auth-session.mjs', 'tools/test-script-resources.mjs', base], {
    cwd: root, windowsHide: true, env: { ...process.env, SPARKSTUDIO_TEST_AUTH_FILE: credentialsFile }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let regressionOutput = '';
  regression.stdout.on('data', value => regressionOutput += value);
  regression.stderr.on('data', value => regressionOutput += value);
  const [regressionCode] = await once(regression, 'exit');
  assert.equal(regressionCode, 0, regressionOutput);
  console.log(regressionOutput.trim());
  pass('existing script-resource and library integration regressions');
  await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ passed: checks, projectId, verifiedAt: new Date().toISOString() }, null, 2));
  console.log(`${checks} gateway-event integration groups passed.`);
} finally {
  await stop();
  await fs.writeFile(path.join(fixture, 'gateway-output.log'), output);
}
