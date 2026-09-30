#!/usr/bin/env node
// Authored portable workshop acceptance on an owned disposable gateway, never an installed service.
// Run from source/: node tools/test-component-messaging-workshop.mjs [--browser]
// --browser leaves the fixture open until Enter or a browser-done file in its fixture directory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { buildWorkshop, readCatalog, readZip } from './workshop-packages.mjs';

assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--browser', 'Only --browser is supported.');
const browser = process.argv.includes('--browser');
const root = process.cwd(), base = 'http://127.0.0.1:5092';
const fixture = path.resolve('.data/test-evidence', `component-messaging-workshop-${randomUUID()}`);
const application = path.join(fixture, 'app'), data = path.join(fixture, 'data');
const dotnet = path.resolve('.tools/dotnet/dotnet.exe');
const account = { username: 'workshop-admin', password: randomUUID() + randomUUID() };
let child, output = '', session, checks = 0, projectId, prefix;
const pass = name => { console.log(`PASS ${name}`); checks++; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(100); }
  throw new Error(`Timed out: ${description}`);
}
async function request(route, { method = 'GET', body, binary, status = 200, authenticated = true } = {}) {
  const headers = new Headers();
  if (authenticated && session) { headers.set('Cookie', session.cookie); headers.set('X-SPARK-AUDIENCE', 'engineering'); headers.set('X-SPARK-CSRF', session.csrf); }
  if (body !== undefined) headers.set('Content-Type', binary ? 'application/zip' : 'application/json');
  const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : binary ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error' });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, status, `${method} ${route}: ${response.status} ${bytes.toString().slice(0, 500)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString()) : null;
}
const api = (route, options) => request(prefix + route, options);
async function stop() {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
}
try {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(5092, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
  await fs.mkdir(fixture, { recursive: true });
  await fs.cp(path.resolve(process.env.SPARKSTUDIO_TEST_GATEWAY_DIR ?? 'src/SparkStudio.Gateway/bin/Debug/net10.0'), application, { recursive: true });
  await fs.cp(path.resolve('apps/web/dist'), path.join(application, 'wwwroot'), { recursive: true });
  child = spawn(dotnet, [path.join(application, 'SparkStudio.Gateway.dll'), '--urls', base], {
    cwd: application, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DOTNET_ROOT: path.dirname(dotnet), DOTNET_CLI_HOME: path.resolve('.tools/dotnet-home'),
      SPARKSTUDIO_DATA_DIR: data, SPARKSTUDIO_PYTHON: path.resolve('runtimes/python/windows-x64/python.exe') },
  });
  child.stdout.on('data', bytes => output = (output + bytes).slice(-100000));
  child.stderr.on('data', bytes => output = (output + bytes).slice(-100000));
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Fixture gateway exited ${child.exitCode}: ${output.slice(-1500)}`);
    try { return (await fetch(base + '/api/ready')).ok; } catch { return false; }
  }, 'fixture readiness');
  const setupCode = (await fs.readFile(path.join(data, 'security/setup-code.txt'), 'utf8')).trim();
  await request('/api/auth/setup', { method: 'POST', authenticated: false, body: { ...account, displayName: 'Workshop fixture', setupCode } });
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...account, audience: 'engineering' }) });
  assert.equal(login.status, 200);
  session = { csrf: (await login.json()).csrfToken, cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  const connectionsBefore = await request('/api/connections'), tagsBefore = await request('/api/tag-definitions');
  const catalog = await readCatalog(root), entry = catalog.workshops.find(item => item.id === 'component-messaging');
  assert.ok(entry && entry.distribution === 'portable');
  const built = await buildWorkshop(root, entry, '2026-09-29T00:00:00.000Z');
  assert.equal(built.scripts.resources.length, 0);
  const importedBytes = await request('/api/projects/import?name=Component%20messaging%20acceptance', { method: 'POST', binary: true, body: built.bytes });
  const imported = JSON.parse(importedBytes.toString());
  projectId = imported.id; prefix = `/api/projects/${encodeURIComponent(projectId)}`;
  assert.equal(imported.published, false);
  let project = await api('/project');
  assert.deepEqual(project.screens, built.project.screens);
  assert.deepEqual(project.templates, built.project.templates);
  const components = project => [...project.screens, ...project.templates].flatMap(document => document.components);
  const handlers = project => components(project).filter(component => component.props.messageHandlers?.length);
  assert.ok(handlers(project).length >= 3);
  const button = project => components(project).find(component => component.props.action === 'message');
  assert.ok(button(project));
  pass('authored messaging package imports all handlers and native sender defaults without publishing');

  project = await api('/project', { method: 'PUT', body: project });
  const original = structuredClone(project);
  for (const mutate of [
    project => { handlers(project)[0].props.messageHandlers[0].scope = 'other'; },
    project => { handlers(project)[0].props.messageHandlers[0].language = 'python'; },
    project => { const handler = handlers(project)[0]; handler.props.messageHandlers.push({ ...handler.props.messageHandlers[0], id: 'duplicate-scope' }); },
    project => { button(project).props.message.payload = ['not an object']; },
    project => { button(project).props.message.messageType = ' padded '; },
    project => { handlers(project)[0].props.messageHandlers[0].code = ' '; },
  ]) {
    const invalid = structuredClone(project); mutate(invalid);
    await api('/project', { method: 'PUT', body: invalid, status: 400 });
    assert.deepEqual(await api('/project'), original, 'Invalid definitions never modify the saved draft.');
  }
  pass('save validates handler scopes, language, duplicate listeners and native sender payloads atomically');

  const publication = await api('/project/publish', { method: 'POST', body: { revision: project.revision } });
  assert.equal(publication.published, true);
  const runtimeLogin = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...account, audience: 'operator', projectId }) });
  assert.equal(runtimeLogin.status, 200);
  const runtimeResponse = await fetch(base + prefix + '/runtime/project', { headers: { Cookie: runtimeLogin.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), 'X-SPARK-AUDIENCE': 'operator' } });
  assert.equal(runtimeResponse.status, 200);
  const runtime = await runtimeResponse.json();
  assert.deepEqual(runtime.screens, project.screens);
  assert.deepEqual(runtime.templates, project.templates);
  pass('explicit publication delivers identical message listeners and buttons to authenticated operators');

  const exported = readZip(await api('/export', { binary: true }));
  const portable = JSON.parse(exported.get('project.json'));
  assert.deepEqual(portable.screens, built.project.screens);
  assert.deepEqual(portable.templates, built.project.templates);
  assert.deepEqual([...exported.keys()].sort(), ['manifest.json', 'project.json', 'queries.json', 'scripts-draft.json']);
  assert.deepEqual(await request('/api/connections'), connectionsBefore);
  assert.deepEqual(await request('/api/tag-definitions'), tagsBefore);
  pass('portable re-export preserves message contracts without modifying connections or tags');
  await fs.writeFile(path.join(fixture, 'verification.json'), JSON.stringify({ checks, projectId, baseUrl: base, completedAt: new Date().toISOString(), source: entry.source, browserVerified: false }, null, 2));
  if (browser) {
    await fs.writeFile(path.join(fixture, 'browser-auth.json'), JSON.stringify({ baseUrl: base, projectId, admin: account }, null, 2));
    console.log(`BROWSER fixture: ${fixture}`);
    console.log(`BROWSER URL: ${base}/designer/${projectId}`);
    console.log('Press Enter, or create browser-done in the fixture directory, to stop this owned fixture.');
    let finished = false;
    process.stdin.once('data', () => { finished = true; });
    while (!finished) {
      try { await fs.access(path.join(fixture, 'browser-done')); finished = true; } catch { await delay(250); }
    }
  }
  console.log(`${checks}/${checks} authored component-messaging acceptance checks passed.`);
} finally {
  await stop();
  await fs.mkdir(fixture, { recursive: true });
  await fs.writeFile(path.join(fixture, 'gateway.log'), output);
}
