#!/usr/bin/env node
// Independently authored project acceptance on an owned loopback fixture; never installed gateway data.
// Run from source/: node tools/test-python-ui-workshop.mjs [--browser]
// --browser holds the fixture until Enter or its browser-done file is created.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { buildWorkshop, readCatalog, readZip } from './workshop-packages.mjs';

assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--browser', 'Only --browser is supported.');
const port = process.env.SPARKSTUDIO_TEST_PORT ?? '5092';
assert.ok(['5092', '5093'].includes(port), 'Only isolated fixture ports 5092 or 5093 are supported.');
const browser = process.argv.includes('--browser'), root = process.cwd(), base = `http://127.0.0.1:${port}`;
const fixture = path.resolve('.data/test-evidence', `python-ui-workshop-${randomUUID()}`);
const application = path.join(fixture, 'app'), data = path.join(fixture, 'data');
const dotnet = path.resolve('.tools/dotnet/dotnet.exe');
const account = { username: 'workshop-admin', password: randomUUID() + randomUUID() };
const sharedTag = '[default]Workshops/PythonUi/SharedTitle';
let child, output = '', admin, checks = 0, projectId, sharedProjectId;
const pass = name => { console.log(`PASS ${name}`); checks++; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(100); }
  throw new Error(`Timed out: ${description}`);
}
async function login(audience = 'engineering', projectId) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...account, audience, ...(projectId ? { projectId } : {}) }) });
  assert.equal(response.status, 200);
  return { csrf: (await response.json()).csrfToken, audience, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
}
async function request(route, { method = 'GET', body, binary = false, status = 200, session = admin, previewToken } = {}) {
  const headers = new Headers();
  if (session) { headers.set('Cookie', session.cookie); headers.set('X-SPARK-AUDIENCE', session.audience); headers.set('X-SPARK-CSRF', session.csrf); }
  if (previewToken) headers.set('X-SPARK-PREVIEW', previewToken);
  if (body !== undefined) headers.set('Content-Type', binary ? 'application/zip' : 'application/json');
  const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : binary ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error' });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, status, `${method} ${route}: ${response.status} ${bytes.toString().slice(0, 700)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString()) : null;
}
const route = (id, suffix) => `/api/projects/${encodeURIComponent(id)}${suffix}`;
const projectRequest = (id, suffix, options) => request(route(id, suffix), options);
const snapshot = (scope = 'screen', overrides = {}) => ({ state: { session: {}, screen: { title: 'Local state · initial' }, ...(scope === 'instance' ? { instance: { title: 'State · initial' } } : {}) }, properties: {}, ...overrides });
const effect = (kind, value, extra) => ({ kind, ...extra, value });
const stateEffect = (scope, value) => effect('state', value, { scope, key: 'title' });
const propertyEffect = (componentId, value) => effect('property', value, { componentId, property: 'text' });
const noEffects = result => assert.equal(result.uiEffects?.length ?? 0, 0);
async function action(id, runtime, buttonId, session, { title = 'Changed title', ui = snapshot(), scope = {}, status = 200 } = {}) {
  return projectRequest(id, `/runtime/screens/python-ui/components/${encodeURIComponent(buttonId)}/action`, { method: 'POST', session, status,
    body: { publishedAt: runtime.publishedAt, parameters: {}, inputs: { title }, ui, ...scope } });
}
async function stop() { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
try {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(Number(port), '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
  await fs.mkdir(fixture, { recursive: true });
  await fs.cp(path.resolve(process.env.SPARKSTUDIO_TEST_GATEWAY_DIR ?? 'artifacts/python-ui-tests/bin/SparkStudio.Gateway/debug'), application, { recursive: true });
  await fs.cp(path.resolve('apps/web/dist'), path.join(application, 'wwwroot'), { recursive: true });
  child = spawn(dotnet, [path.join(application, 'SparkStudio.Gateway.dll'), '--urls', base], {
    cwd: application, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DOTNET_ROOT: path.dirname(dotnet), DOTNET_CLI_HOME: path.resolve('.tools/dotnet-home'), SPARKSTUDIO_DATA_DIR: data, SPARKSTUDIO_PYTHON: path.resolve('runtimes/python/windows-x64/python.exe') },
  });
  child.stdout.on('data', bytes => output = (output + bytes).slice(-120000)); child.stderr.on('data', bytes => output = (output + bytes).slice(-120000));
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Fixture gateway exited ${child.exitCode}: ${output.slice(-1500)}`);
    try { return (await fetch(base + '/api/ready')).ok; } catch { return false; }
  }, 'fixture readiness');
  const setupCode = (await fs.readFile(path.join(data, 'security/setup-code.txt'), 'utf8')).trim();
  await request('/api/auth/setup', { method: 'POST', session: null, body: { ...account, displayName: 'Python UI fixture', setupCode } });
  admin = await login();
  const connectionsBefore = await request('/api/connections'), tagsBefore = await request('/api/tag-definitions');
  const catalog = await readCatalog(root), entry = catalog.workshops.find(item => item.id === 'python-ui');
  assert.ok(entry && entry.distribution === 'portable' && entry.gatewayWrites === 'none');
  const built = await buildWorkshop(root, entry, '2026-09-30T00:00:00.000Z');
  const imported = JSON.parse((await request('/api/projects/import?name=Python%20UI%20acceptance', { method: 'POST', binary: true, body: built.bytes })).toString());
  projectId = imported.id; assert.equal(imported.published, false);
  const project = await projectRequest(projectId, '/project');
  assert.deepEqual(project.screens, built.project.screens); assert.deepEqual(project.templates, built.project.templates);
  await projectRequest(projectId, '/project/publish', { method: 'POST', body: { revision: project.revision } });
  const operatorA = await login('operator', projectId), operatorB = await login('operator', projectId);
  assert.notEqual(operatorA.cookie, operatorB.cookie);
  const runtimeA = await projectRequest(projectId, '/runtime/project', { session: operatorA });
  const runtimeB = await projectRequest(projectId, '/runtime/project', { session: operatorB });
  assert.deepEqual(runtimeA.screens, runtimeB.screens);
  pass('authored portable workshop imports unpublished and publishes for two independently authenticated operator sessions');

  const selfResult = await action(projectId, runtimeA, 'rename-self', operatorA);
  assert.equal(selfResult.success, true, selfResult.stderr);
  assert.equal(selfResult.result.buttonText, 'hi'); assert.deepEqual(selfResult.uiEffects, [propertyEffect('rename-self', 'hi')]);
  assert.equal((await projectRequest(projectId, '/runtime/project', { session: operatorB })).screens[0].components.find(component => component.id === 'rename-self').props.text, 'Rename this button · self.text');
  pass('self.text updates only the calling button and reads back its staged value without changing another session caption');

  for (const button of ['set-sibling-title', 'set-property-title']) {
    const result = await action(projectId, runtimeA, button, operatorA, { title: 'Tab A property' });
    assert.equal(result.success, true, result.stderr); assert.deepEqual(result.uiEffects, [propertyEffect('direct-title', 'Tab A property')]);
  }
  const stateResult = await action(projectId, runtimeA, 'set-state-title', operatorA, { title: 'Tab A state' });
  assert.equal(stateResult.success, true, stateResult.stderr); assert.deepEqual(stateResult.uiEffects, [stateEffect('screen', 'Tab A state')]);
  assert.deepEqual((await projectRequest(projectId, '/runtime/project', { session: operatorB })).screens, runtimeB.screens);
  assert.deepEqual(await projectRequest(projectId, '/project'), project);
  pass('published Python sibling, property and state helpers return local effects without editing another session publication or the saved draft');

  for (const scope of [{ instanceId: 'station-a' }, { instanceId: 'station-b' }, { instanceId: 'stations', rowId: 'row-1' }, { instanceId: 'stations', rowId: 'row-2' }]) {
    const title = JSON.stringify(scope);
    const changed = await action(projectId, runtimeA, 'set-row-property', operatorA, { title, ui: snapshot('instance'), scope });
    assert.equal(changed.success, true, changed.stderr); assert.deepEqual(changed.uiEffects, [propertyEffect('row-title', title)]);
    const custom = await action(projectId, runtimeA, 'set-row-state', operatorA, { title, ui: snapshot('instance'), scope });
    assert.equal(custom.success, true, custom.stderr); assert.deepEqual(custom.uiEffects, [stateEffect('instance', title)]);
  }
  pass('parent.getChild and parent.custom work against each resolved template placement and saved repeater row');

  const previewBody = { code: 'self.getSibling("direct-title").props.text = inputs["title"]', inputs: { title: 'Preview title' }, parameters: {},
    ui: snapshot(), uiContext: { screenId: 'python-ui', componentId: 'set-sibling-title' } };
  const standaloneBody = { code: 'self.parent.custom.title = inputs["title"]', inputs: { title: 'Standalone template title' }, parameters: { station: 'Draft' },
    ui: { state: { session: {}, screen: {}, instance: { title: 'State · initial' } }, properties: {} }, uiContext: { templateId: 'python-title-card', componentId: 'set-row-state' } };
  for (const [body, expected] of [[previewBody, propertyEffect('direct-title', 'Preview title')], [standaloneBody, stateEffect('instance', 'Standalone template title')]]) {
    const response = await projectRequest(projectId, '/scripts/run', { method: 'POST', body });
    assert.equal(response.success, true, response.stderr); assert.deepEqual(response.uiEffects, [expected]);
  }
  for (const uiContext of [
    { screenId: 'missing-screen', componentId: 'set-sibling-title' },
    { screenId: 'python-ui', componentId: 'missing-button' },
    { screenId: 'python-ui', componentId: 'direct-title' },
    { screenId: 'python-ui', templateId: 'python-title-card', componentId: 'set-row-state' },
    { screenId: 'python-ui', componentId: 'set-row-state', instanceId: 'stations', rowId: 'missing-row' },
  ]) await projectRequest(projectId, '/scripts/run', { method: 'POST', body: { ...previewBody, uiContext }, status: 400 });
  await projectRequest(projectId, '/scripts/run', { method: 'POST', body: { ...previewBody, ui: snapshot('screen', { state: { session: {}, screen: { title: 12 } } }) }, status: 400 });
  await projectRequest(projectId, '/scripts/run', { method: 'POST', body: previewBody, session: operatorA, status: 401 });
  pass('engineering Python UI resolves saved screen and standalone template context and rejects invalid snapshots, identities and operator audience');

  const readOnlyPreview = await projectRequest(projectId, '/preview/sessions', { method: 'POST', body: { mode: 'read-only' } });
  const livePreview = await projectRequest(projectId, '/preview/sessions', { method: 'POST', body: { mode: 'live-actions' } });
  try {
    await projectRequest(projectId, '/preview/scripts/run', { method: 'POST', body: previewBody, previewToken: readOnlyPreview.token, status: 403 });
    await projectRequest(projectId, '/preview/scripts/run', { method: 'POST', body: previewBody, status: 403 });
    await projectRequest(projectId, '/preview/scripts/run', { method: 'POST', body: previewBody, session: operatorA, previewToken: livePreview.token, status: 401 });
    for (const [body, expected] of [[previewBody, propertyEffect('direct-title', 'Preview title')], [standaloneBody, stateEffect('instance', 'Standalone template title')]]) {
      const response = await projectRequest(projectId, '/preview/scripts/run', { method: 'POST', body, previewToken: livePreview.token });
      assert.equal(response.success, true, response.stderr); assert.deepEqual(response.uiEffects, [expected]);
    }
    const rowPreview = await projectRequest(projectId, '/preview/scripts/run', { method: 'POST', previewToken: livePreview.token, body: {
      code: 'self.parent.getChild("row-title").props.text = inputs["title"]', inputs: { title: 'Preview row one' }, parameters: { station: 'Row 1' },
      ui: snapshot('instance'), uiContext: { screenId: 'python-ui', componentId: 'set-row-property', instanceId: 'stations', rowId: 'row-1' },
    } });
    assert.equal(rowPreview.success, true, rowPreview.stderr); assert.deepEqual(rowPreview.uiEffects, [propertyEffect('row-title', 'Preview row one')]);
    await projectRequest(projectId, '/preview/scripts/run', { method: 'POST', body: { ...previewBody, uiContext: { screenId: 'missing', componentId: 'set-sibling-title' } }, previewToken: livePreview.token, status: 400 });
    assert.deepEqual(await projectRequest(projectId, '/project'), project);
  } finally {
    for (const preview of [readOnlyPreview, livePreview]) await projectRequest(projectId, '/preview/session', { method: 'DELETE', previewToken: preview.token, status: 204 });
  }
  pass('actual Designer Preview endpoint returns scoped Python UI effects only with an active Live actions capability');

  for (const invalidUi of [
    snapshot('screen', { state: { session: {}, screen: { title: 12 } } }),
    snapshot('screen', { state: { session: {}, screen: { unknown: 'value' } } }),
    snapshot('screen', { state: { session: {}, screen: {}, instance: { title: 'outside an instance' } } }),
    snapshot('screen', { properties: { 'missing-control': { text: 'forged' } } }),
    snapshot('screen', { properties: { 'state-title': { text: 'bound property' } } }),
    snapshot('screen', { properties: { 'station-a': { text: 'wrapper' } } }),
    snapshot('screen', { properties: { 'direct-title': { script: 'forged source' } } }),
    snapshot('screen', { properties: { 'direct-title': { text: 'x'.repeat(4097) } } }),
  ]) await action(projectId, runtimeA, 'set-sibling-title', operatorA, { ui: invalidUi, status: 400 });
  assert.deepEqual(await projectRequest(projectId, '/project'), project);
  pass('invalid state types, undeclared keys, foreign forms, bound properties and oversized UI snapshots reject before execution');

  const exported = readZip(await projectRequest(projectId, '/export', { binary: true }));
  const portable = JSON.parse(exported.get('project.json'));
  assert.deepEqual(portable.screens, built.project.screens); assert.deepEqual(portable.templates, built.project.templates);
  assert.deepEqual([...exported.keys()].sort(), ['manifest.json', 'project.json', 'queries.json', 'scripts-draft.json']);
  assert.deepEqual(await request('/api/connections'), connectionsBefore); assert.deepEqual(await request('/api/tag-definitions'), tagsBefore);
  pass('core workshop re-export preserves authored defaults and creates no gateway tags or connections');

  // Deliberately separate from the distributable project: local negative probes and optional shared writer.
  const created = await request('/api/projects', { method: 'POST', body: { name: 'Python UI validation and optional shared data' } });
  sharedProjectId = created.id;
  const validation = await projectRequest(sharedProjectId, '/project');
  Object.assign(validation, { parameters: {}, screens: structuredClone(built.project.screens), templates: structuredClone(built.project.templates), navigation: structuredClone(built.project.navigation) });
  const buttons = [
    ['read-write', 'Read and write UI', 'before = system.ui.getProperty("direct-title", "text")\nstate_before = system.ui.getState("screen", "title")\nself.parent.custom.title = "Local state after"\nself.parent.getChild("direct-title").props.text = "Local property after"\nresult = {"before": before, "stateBefore": state_before, "after": self.getSibling("direct-title").props.text, "stateAfter": self.parent.custom.title, "selfName": self.name}'],
    ['fail-after-effect', 'Intentional rollback', 'system.ui.setProperty("direct-title", "text", "Must not apply")\nraise RuntimeError("Intentional workshop failure")'],
    ['write-bound', 'Reject bound property', 'system.ui.setProperty("state-title", "text", "Cannot replace binding")'],
    ['write-other-form', 'Reject another form', 'self.getSibling("row-title").props.text = "Outside this form"'],
    ['invalid-state-effect', 'Reject state type', 'system.ui.setState("screen", "title", 12)'],
    ['effect-overflow', 'Reject effect overflow', 'for index in range(20):\n    system.ui.setState("screen", "effectProbe" + str(index), "x" * 4096)'],
    ['write-shared', 'Write shared title', `quality = system.tag.writeBlocking([${JSON.stringify(sharedTag)}], [str(inputs["title"])])\nif not all(item.isGood() for item in quality):\n    raise RuntimeError("Shared tag write failed")\nresult = {"message": "Shared title updated for every subscribed session."}`],
  ];
  validation.screens[0].height = 1540;
  for (let index = 0; index < 20; index++) validation.screens[0].state[`effectProbe${index}`] = { type: 'string', value: '' };
  for (const [index, [id, text, script]] of buttons.entries()) validation.screens[0].components.push({ id, type: 'button', x: 32 + index % 3 * 365, y: 1210 + Math.floor(index / 3) * 74, width: 330, height: 46, props: { text, action: 'script', script } });
  const savedValidation = await projectRequest(sharedProjectId, '/project', { method: 'PUT', body: validation });
  await projectRequest(sharedProjectId, '/project/publish', { method: 'POST', body: { revision: savedValidation.revision } });
  const validationA = await login('operator', sharedProjectId), validationB = await login('operator', sharedProjectId);
  const validationRuntime = await projectRequest(sharedProjectId, '/runtime/project', { session: validationA });
  const prior = snapshot('screen', { state: { session: {}, screen: { title: 'Caller state before' } }, properties: { 'direct-title': { text: 'Caller property before' } } });
  const read = await action(sharedProjectId, validationRuntime, 'read-write', validationA, { ui: prior });
  assert.equal(read.success, true, read.stderr);
  assert.deepEqual(read.result, { before: 'Caller property before', stateBefore: 'Caller state before', after: 'Local property after', stateAfter: 'Local state after', selfName: 'read-write' });
  assert.deepEqual(read.uiEffects, [stateEffect('screen', 'Local state after'), propertyEffect('direct-title', 'Local property after')]);
  for (const button of ['fail-after-effect', 'write-bound', 'write-other-form', 'invalid-state-effect', 'effect-overflow']) {
    const failure = await action(sharedProjectId, validationRuntime, button, validationA);
    assert.equal(failure.success, false, `${button} should fail`); noEffects(failure);
  }
  pass('real CPython reads prior caller snapshots, supports read-your-writes, and discards all UI effects after invalid or failed scripts');

  await request('/api/tags', { method: 'POST', body: { path: sharedTag, kind: 'memory', dataType: 'String', value: 'Shared initial', enabled: true } });
  const shared = await action(sharedProjectId, validationRuntime, 'write-shared', validationA, { title: 'Shared production title' });
  assert.equal(shared.success, true, shared.stderr); noEffects(shared);
  for (const session of [validationA, validationB]) await until(async () => {
    const tags = await request('/api/tags', { session });
    return tags.some(tag => tag.path === sharedTag && tag.value === 'Shared production title' && tag.quality === 'Good');
  }, 'shared tag visible in both operator sessions');
  assert.deepEqual(await projectRequest(projectId, '/project'), project);
  assert.deepEqual(await request('/api/connections'), connectionsBefore);
  pass('optional memory-tag write is visible through two operator cookie jars while portable project defaults remain untouched');

  await fs.writeFile(path.join(fixture, 'verification.json'), JSON.stringify({ checks, projectId, sharedProjectId, baseUrl: base, completedAt: new Date().toISOString(), source: entry.source, sharedTag, browserVerified: false }, null, 2));
  if (browser) {
    await fs.writeFile(path.join(fixture, 'browser-auth.json'), JSON.stringify({ baseUrl: base, projectId, sharedProjectId, admin: account }, null, 2));
    console.log(`BROWSER fixture: ${fixture}`); console.log(`BROWSER URL: ${base}/designer/${projectId}`);
    console.log('Press Enter, or create browser-done in the fixture directory, to stop this owned fixture.');
    let finished = false; process.stdin.once('data', () => { finished = true; });
    while (!finished) { try { await fs.access(path.join(fixture, 'browser-done')); finished = true; } catch { await delay(250); } }
  }
  console.log(`${checks}/${checks} authored Python UI acceptance checks passed.`);
} finally {
  await stop(); await fs.mkdir(fixture, { recursive: true }); await fs.writeFile(path.join(fixture, 'gateway.log'), output);
}
