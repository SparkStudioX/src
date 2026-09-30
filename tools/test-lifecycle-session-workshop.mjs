#!/usr/bin/env node
// Real HTTP/SSE + CPython acceptance against an owned, disposable loopback gateway.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { buildWorkshop, readCatalog, readZip } from './workshop-packages.mjs';

const args = process.argv.slice(2);
let browser = false, packageDirectory;
while (args.length) {
  const option = args.shift();
  if (option === '--browser' && !browser) browser = true;
  else if (option === '--package' && !packageDirectory && args[0] && !args[0].startsWith('--')) packageDirectory = path.resolve(args.shift());
  else throw new Error('Usage: node tools/test-lifecycle-session-workshop.mjs [--package EXTRACTED_DIRECTORY] [--browser]');
}
const base = 'http://127.0.0.1:5094';
const fixture = path.resolve('.data/test-evidence', `lifecycle-session-${randomUUID()}`);
const application = packageDirectory ?? path.join(fixture, 'app'), data = path.join(fixture, 'data');
const dotnet = path.resolve('.tools/dotnet/dotnet.exe');
const account = { username: 'session-admin', password: randomUUID() + randomUUID() };
let child, output = '', admin, projectId, runtime, checks = 0, packageProvenance;
const streams = [];
const pass = name => { checks++; console.log(`PASS ${name}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(75); }
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
const register = (session, options = {}) => project('/runtime/sessions', { method: 'POST', body: { publishedAt: runtime.publishedAt }, session, ...options });
const close = (identity, session, options = {}) => project(`/runtime/sessions/${identity.sessionId}`, { method: 'DELETE', session, status: 204, ...options });
const ui = properties => ({ state: { session: {}, screen: {}, instance: {} }, properties: properties ?? {} });
const success = response => { assert.equal(response.success, true, response.stderr); return response; };
const action = (id, session, values = {}) => project(`/runtime/screens/session-messaging/components/${id}/action`, { method: 'POST', session, body: { publishedAt: runtime.publishedAt, parameters: {}, inputs: { note: 'Integration notice', target: '', ...values }, ui: { state: { session: {}, screen: {} }, properties: {} } } });
const lifecycleBody = (type, patch = {}) => ({ publishedAt: runtime.publishedAt, parameters: {}, inputs: {}, instanceId: 'station-a', ui: ui(), eventHandler: { family: 'lifecycle', type }, event: { type, componentId: 'receiver' }, ...patch });
const lifecycle = (type, session, patch = {}, options = {}) => project('/runtime/screens/session-messaging/components/receiver/events', { method: 'POST', session, body: lifecycleBody(type, patch), ...options });
async function stream(identity, session) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/projects/${projectId}/runtime/sessions/${identity.sessionId}/messages?audience=operator`, { headers: { Cookie: session.cookie }, signal: controller.signal });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const receiver = { identity, events: [], ended: false, stop: () => controller.abort() }; streams.push(receiver);
  receiver.work = (async () => {
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let end; while ((end = pending.indexOf('\n\n')) !== -1) {
          const block = pending.slice(0, end); pending = pending.slice(end + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
          if (type && data) receiver.events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch (error) { if (!controller.signal.aborted) receiver.error = error; }
    finally { receiver.ended = true; reader.releaseLock(); }
  })();
  await until(() => receiver.events.find(event => event.type === 'ready'), 'ready frame');
  assert.deepEqual(receiver.events[0].data, identity);
  return receiver;
}
const messages = receiver => receiver.events.filter(event => event.type === 'message').map(event => event.data);
async function received(receivers, id) { return Promise.all(receivers.map(receiver => until(() => messages(receiver).find(message => message.messageId === id), 'message delivery'))); }

try {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(5094, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
  await fs.mkdir(fixture, { recursive: true });
  let executable = dotnet, launch = [path.join(application, 'SparkStudio.Gateway.dll'), '--urls', base];
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(ASPNETCORE_|DOTNET_|SPARKSTUDIO_|Kestrel__|Python__|DataDirectory$|URLS$)/i.test(key)) delete environment[key];
  if (packageDirectory) {
    const manifest = JSON.parse((await fs.readFile(path.join(application, 'package-manifest.json'), 'utf8')).replace(/^\uFEFF/, ''));
    assert.equal(manifest.product, 'SparkStudio'); assert.equal(manifest.sourceDirty, false);
    assert.match(manifest.sourceCommit, /^[0-9a-f]{40}$/);
    for (const file of manifest.files) {
      const target = path.resolve(application, file.path);
      assert.ok(target.startsWith(application + path.sep), 'Manifest payload remains inside the extracted directory.');
      const bytes = await fs.readFile(target);
      assert.equal(bytes.length, file.size, file.path);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
    }
    packageProvenance = { version: manifest.version, sourceCommit: manifest.sourceCommit, payloadHashes: manifest.files.length, browser: manifest.browser };
    executable = path.join(application, 'SparkStudio.Gateway.exe');
    launch = ['--urls', base, '--contentRoot', application];
    environment.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
    environment.DOTNET_ROOT = path.join(fixture, 'no-installed-dotnet');
    environment.DOTNET_ROOT_X64 = environment.DOTNET_ROOT;
  } else {
    await fs.cp(path.resolve('artifacts/lifecycle-messaging-tests'), application, { recursive: true });
    await fs.cp(path.resolve('apps/web/dist'), path.join(application, 'wwwroot'), { recursive: true });
    environment.DOTNET_ROOT = path.dirname(dotnet);
    environment.DOTNET_CLI_HOME = path.resolve('.tools/dotnet-home');
    environment.SPARKSTUDIO_PYTHON = path.resolve('runtimes/python/windows-x64/python.exe');
  }
  environment.SPARKSTUDIO_DATA_DIR = data;
  child = spawn(executable, launch, {
    cwd: application, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  });
  child.stdout.on('data', bytes => output = (output + bytes).slice(-150000)); child.stderr.on('data', bytes => output = (output + bytes).slice(-150000));
  await until(async () => { if (child.exitCode !== null) throw new Error(`Fixture exited ${child.exitCode}: ${output.slice(-1500)}`); try { return (await fetch(base + '/api/ready')).ok; } catch { return false; } }, 'gateway readiness');
  const setupCode = (await fs.readFile(path.join(data, 'security/setup-code.txt'), 'utf8')).trim();
  await request('/api/auth/setup', { method: 'POST', session: null, body: { ...account, displayName: 'Session acceptance', setupCode } }); admin = await login();
  const before = { tags: await request('/api/tag-definitions'), connections: await request('/api/connections') };
  const catalog = await readCatalog(process.cwd()), entry = catalog.workshops.find(item => item.id === 'lifecycle-session-messaging');
  const built = await buildWorkshop(process.cwd(), entry, '2026-09-30T00:00:00.000Z');
  const imported = JSON.parse((await request('/api/projects/import?name=Lifecycle%20session%20acceptance', { method: 'POST', binary: true, body: built.bytes })).toString());
  projectId = imported.id; assert.equal(imported.published, false);
  const saved = await project('/project'); assert.deepEqual(saved.screens, built.project.screens); assert.deepEqual(saved.templates, built.project.templates);
  assert.deepEqual(await project('/scripts/resources'), built.scripts);
  await project('/project/publish', { method: 'POST', body: { revision: saved.revision } });
  const operatorA = await login('operator'), operatorB = await login('operator'); assert.notEqual(operatorA.cookie, operatorB.cookie);
  runtime = await project('/runtime/project', { session: operatorA });
  assert.ok(!JSON.stringify(runtime).includes('self.text ='), 'Runtime withholds Python source.');
  const exported = JSON.parse(readZip(await project('/export', { binary: true })).get('project.json'));
  assert.deepEqual(exported.screens, built.project.screens); assert.deepEqual(exported.templates, built.project.templates);
  pass('authored package imports unpublished, retains disabled gateway event and re-exports exact lifecycle and message definitions');

  const syntaxMarker = path.join(fixture, 'syntax-must-not-run.txt');
  const syntaxCode = `open(${JSON.stringify(syntaxMarker)}, "w").write("executed")\nwhile True:\n    pass\n`;
  assert.equal((await project('/scripts/validate', { method: 'POST', body: { code: syntaxCode } })).valid, true);
  await assert.rejects(fs.access(syntaxMarker), { code: 'ENOENT' });
  const invalidSyntax = await project('/scripts/validate', { method: 'POST', body: { code: 'value = 1\nif True\n    pass' } });
  assert.equal(invalidSyntax.valid, false); assert.equal(invalidSyntax.line, 2); assert.ok(invalidSyntax.column > 0); assert.ok(invalidSyntax.message);
  await project('/scripts/validate', { method: 'POST', body: { code: 'x'.repeat(65537) }, status: 400 });
  await project('/scripts/validate', { method: 'POST', body: { code: 'pass' }, csrf: false, status: 403 });
  await project('/scripts/validate', { method: 'POST', body: { code: 'pass' }, session: operatorA, status: 401 });
  const author = { username: 'syntax-author', password: randomUUID() + randomUUID() };
  await request('/api/security/users', { method: 'POST', status: 201, body: { ...author, displayName: 'Syntax author', projectGrants: { [projectId]: { view: false, operate: false, design: true, publish: false } } } });
  const authorSession = await login('engineering', author);
  assert.equal((await project('/scripts/validate', { method: 'POST', body: { code: 'system.tag.writeBlocking(["[default]NeverExecuted"], [1])' }, session: authorSession })).valid, true);
  pass('compile-only Python checking reports locations, performs no authored work, and enforces Design, audience, CSRF and source bounds');

  await register(operatorA, { body: { publishedAt: 'stale' }, status: 409 });
  await register(operatorA, { csrf: false, status: 403 }); await register(admin, { status: 401 });
  let idA = await register(operatorA), idA2 = await register(operatorA), idB = await register(operatorB);
  assert.equal(new Set([idA.sessionId, idA2.sessionId, idB.sessionId]).size, 3);
  await project(`/runtime/sessions/${idA.sessionId}/messages`, { session: operatorB, status: 404 });
  await close(idA, operatorB, { status: 404 });
  let a = await stream(idA, operatorA), a2 = await stream(idA2, operatorA), b = await stream(idB, operatorB);
  await until(() => [a, a2, b].every(receiver => receiver.events.some(event => event.type === 'tags')), 'multiplexed tags');
  pass('server identities distinguish same-cookie tabs; ownership, audience, CSRF and stale publication checks protect registration/SSE/cleanup');

  const broadcast = success(await action('broadcast', operatorA)).result.receipt;
  assert.equal(broadcast.queued, 3); assert.equal(broadcast.eligible, 3);
  const frames = await received([a, a2, b], broadcast.messageId);
  for (const [index, frame] of frames.entries()) {
    assert.equal(frame.sessionId, [idA, idA2, idB][index].sessionId); assert.equal(frame.projectId, projectId); assert.equal(frame.scope, 'session'); assert.equal(frame.payload.text, 'Integration notice');
  }
  const targeted = success(await action('send-target', operatorA, { note: 'Only A2', target: idA2.sessionId })).result.receipt;
  assert.equal(targeted.eligible, 1); await received([a2], targeted.messageId); await pause(200);
  assert.ok(!messages(a).some(item => item.messageId === targeted.messageId)); assert.ok(!messages(b).some(item => item.messageId === targeted.messageId));
  success(await action('identify', operatorA));
  await until(() => [a, a2, b].every(receiver => messages(receiver).some(item => item.messageType === 'workshop.identity' && item.payload.sessionId === receiver.identity.sessionId)), 'same-project Python session discovery');
  pass('real CPython button broadcasts, single-tab targeting and discovery route correct envelopes to live queues');

  const populated = success(await action('fill-message', operatorA));
  assert.deepEqual(populated.uiEffects, [{ kind: 'input', componentId: 'note', value: 'Prepared by Python' }]);
  const renamed = success(await action('rename', operatorA));
  assert.ok(renamed.uiEffects.some(effect => effect.kind === 'property' && effect.componentId === 'rename' && effect.property === 'text' && effect.value === 'Hello from Python'));
  pass('Python button actions distinguish caption changes from typed form-value effects');

  const mounted = success(await lifecycle('mount', operatorA)); assert.ok(mounted.uiEffects.some(effect => effect.value === 'Mounted receiver A'));
  const mountBurst = await Promise.all(Array.from({ length: 8 }, () => lifecycle('mount', operatorA)));
  for (const response of mountBurst) success(response);
  const cleanup = success(await lifecycle('unmount', operatorA, { ui: ui({ receiver: { text: 'Captured before leaving' } }) }));
  assert.match(cleanup.stdout, /Cleanup A last text: Captured before leaving/); assert.ok(!cleanup.uiEffects?.length);
  await lifecycle('mount', operatorA, { event: { type: 'unmount', componentId: 'receiver' } }, { status: 400 });
  await lifecycle('mount', operatorA, {}, { csrf: false, status: 403 }); await lifecycle('mount', admin, {}, { status: 401 });
  const viewer = { username: 'session-viewer', password: randomUUID() + randomUUID() };
  await request('/api/security/users', { method: 'POST', status: 201, body: { ...viewer, displayName: 'Viewer', projectGrants: { [projectId]: { view: true, operate: false, design: false, publish: false } } } });
  await lifecycle('mount', await login('operator', viewer), {}, { status: 403 });
  const preview = await project('/preview/sessions', { method: 'POST', body: { mode: 'live-actions' } });
  const previewBody = lifecycleBody('mount'); delete previewBody.publishedAt;
  success(await project('/preview/screens/session-messaging/components/receiver/events', { method: 'POST', previewToken: preview.token, body: previewBody }));
  assert.equal((await project('/scripts/validate', { method: 'POST', previewToken: preview.token, body: { code: 'self.text = "Not executed"' } })).valid, true);
  await project('/preview/session', { method: 'DELETE', previewToken: preview.token, status: 204 });
  const readonlyPreview = await project('/preview/sessions', { method: 'POST', body: { mode: 'read-only' } });
  assert.equal((await project('/scripts/validate', { method: 'POST', previewToken: readonlyPreview.token, body: { code: 'while True:\n    pass' } })).valid, true);
  await project('/scripts/run', { method: 'POST', previewToken: readonlyPreview.token, body: { code: 'result = 1' }, status: 403 });
  await project('/preview/session', { method: 'DELETE', previewToken: readonlyPreview.token, status: 204 });
  pass('Python mount applies instance effects, unmount reads captured properties, and lifecycle preserves runtime and Preview authority');

  const scripts = await project('/scripts/resources'); scripts.resources[0].enabled = true;
  const scriptDraft = await project('/scripts/resources', { method: 'PUT', body: scripts });
  const scriptPublication = await project('/scripts/publish', { method: 'POST', body: { revision: scriptDraft.revision } });
  await until(async () => (await project('/scripts/events/status')).activeRevision === scriptPublication.revision, 'gateway event activation');
  await until(() => a.ended && a2.ended && b.ended, 'whole-application script publication retires old sessions');
  runtime = await project('/runtime/project', { session: operatorA });
  idA = await register(operatorA); idA2 = await register(operatorA); idB = await register(operatorB);
  a = await stream(idA, operatorA); a2 = await stream(idA2, operatorA); b = await stream(idB, operatorB);
  const event = success(await project('/scripts/messages/Workshop%20broadcast/request', { method: 'POST', body: { payload: { text: 'Gateway event notification' }, revision: scriptPublication.revision } }));
  assert.equal(event.result.queued, 3); const fromEvent = await received([a, a2, b], event.result.messageId); assert.equal(fromEvent[0].payload.text, 'Gateway event notification');
  pass('an explicitly published gateway event pushes to active operator streams without a browser action');

  await close(idA2, operatorA); await until(() => a2.ended, 'closed stream completion');
  assert.equal(success(await action('send-target', operatorA, { target: idA2.sessionId })).result.receipt.status, 'noRecipients');
  const replacement = await register(operatorA); assert.notEqual(replacement.sessionId, idA2.sessionId);
  const replaced = await stream(replacement, operatorA); assert.equal(messages(replaced).length, 0);
  a.stop(); await a.work;
  await until(async () => success(await action('send-target', operatorB, { target: idA.sessionId })).result.receipt.status === 'noRecipients', 'disconnect retires old identity');
  pass('DELETE and disconnected streams retire mailboxes; replacement IDs do not replay previous messages');

  const invalidDraft = await project('/project');
  invalidDraft.templates[0].components.find(item => item.id === 'receiver').props.componentEvents.unmount.code = 'self.text = "Cannot update retired UI"';
  const changed = await project('/project', { method: 'PUT', body: invalidDraft }); await project('/project/publish', { method: 'POST', body: { revision: changed.revision } });
  await until(() => b.ended && replaced.ended, 'publication replacement closes old streams');
  await register(operatorA, { status: 409 }); await lifecycle('mount', operatorA, {}, { status: 409 });
  runtime = await project('/runtime/project', { session: operatorA });
  const denied = await lifecycle('unmount', operatorA); assert.equal(denied.success, false); assert.match(denied.stderr, /read.only|unmount/i); assert.ok(!denied.uiEffects?.length);
  const restoredDraft = await project('/project'); restoredDraft.templates = structuredClone(built.project.templates);
  const restored = await project('/project', { method: 'PUT', body: restoredDraft }); await project('/project/publish', { method: 'POST', body: { revision: restored.revision } });
  const disabled = await project('/scripts/resources'); disabled.resources[0].enabled = false;
  const disabledSaved = await project('/scripts/resources', { method: 'PUT', body: disabled }); await project('/scripts/publish', { method: 'POST', body: { revision: disabledSaved.revision } });
  assert.deepEqual(await request('/api/tag-definitions'), before.tags); assert.deepEqual(await request('/api/connections'), before.connections);
  pass('publication changes retire streams and stale events; unmount setters fail server-side; workshop preserves gateway configuration');

  await fs.writeFile(path.join(fixture, 'verification.json'), JSON.stringify({ checks, projectId, baseUrl: base, packageProvenance, completedAt: new Date().toISOString(), browserVerified: false }, null, 2));
  console.log(`${checks}/${checks} lifecycle/session acceptance groups passed.`);
  if (browser) {
    await fs.writeFile(path.join(fixture, 'browser-auth.json'), JSON.stringify({ baseUrl: base, projectId, admin: account }, null, 2));
    console.log(`BROWSER fixture: ${fixture}`); console.log(`BROWSER URL: ${base}/designer/${projectId}`);
    let finished = false; process.stdin.once('data', () => { finished = true; });
    while (!finished) { try { await fs.access(path.join(fixture, 'browser-done')); finished = true; } catch { await pause(250); } }
  }
} finally {
  for (const receiver of streams) receiver.stop(); await Promise.allSettled(streams.map(receiver => receiver.work));
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  await fs.mkdir(fixture, { recursive: true }); await fs.writeFile(path.join(fixture, 'gateway.log'), output);
}
