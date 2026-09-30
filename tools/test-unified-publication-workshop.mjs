#!/usr/bin/env node
// Owned loopback fixture only; never installed gateway data or external services.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { buildWorkshop, readZip } from './workshop-packages.mjs';

const root = process.cwd(), port = '5093', base = `http://127.0.0.1:${port}`;
const browser = process.argv.includes('--browser');
const fixture = path.resolve('.data/test-evidence', `unified-publication-${randomUUID()}`);
const application = path.join(fixture, 'app'), data = path.join(fixture, 'data'), dotnet = path.resolve('.tools/dotnet/dotnet.exe');
const account = { username: 'publication-admin', password: randomUUID() + randomUUID() };
let child, output = '', admin, checks = 0;
const pass = name => { checks++; console.log(`PASS ${name}`); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(50); }
  throw new Error(`Timed out: ${description}`);
}
async function request(route, { method = 'GET', body, raw = false, binary = false, status = 200, session = admin } = {}) {
  const headers = new Headers();
  if (session) { headers.set('Cookie', session.cookie); headers.set('X-SPARK-AUDIENCE', session.audience); headers.set('X-SPARK-CSRF', session.csrf); }
  if (body !== undefined) headers.set('Content-Type', raw ? 'application/zip' : 'application/json');
  const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error' });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, status, `${method} ${route}: ${response.status} ${bytes.toString().slice(0, 1000)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString()) : null;
}
async function login(audience = 'engineering', projectId) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...account, audience, ...(projectId ? { projectId } : {}) }) });
  assert.equal(response.status, 200);
  return { csrf: (await response.json()).csrfToken, audience, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
}
try {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(Number(port), '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
  await fs.mkdir(fixture, { recursive: true });
  await fs.cp(path.resolve(process.env.SPARKSTUDIO_TEST_GATEWAY_DIR ?? 'src/SparkStudio.Gateway/bin/UnifiedPublicationCheck/net10.0'), application, { recursive: true });
  if (browser) await fs.cp(path.resolve('apps/web/dist'), path.join(application, 'wwwroot'), { recursive: true });
  child = spawn(dotnet, [path.join(application, 'SparkStudio.Gateway.dll'), '--urls', base], { cwd: application, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DOTNET_ROOT: path.dirname(dotnet), DOTNET_CLI_HOME: path.resolve('.tools/dotnet-home'), SPARKSTUDIO_DATA_DIR: data, SPARKSTUDIO_PYTHON: path.resolve('runtimes/python/windows-x64/python.exe') } });
  child.stdout.on('data', bytes => output = (output + bytes).slice(-100000)); child.stderr.on('data', bytes => output = (output + bytes).slice(-100000));
  await until(async () => { if (child.exitCode !== null) throw new Error(output); try { return (await fetch(base + '/api/ready')).ok; } catch { return false; } }, 'gateway readiness');
  const setupCode = (await fs.readFile(path.join(data, 'security/setup-code.txt'), 'utf8')).trim();
  await request('/api/auth/setup', { method: 'POST', session: null, body: { ...account, displayName: 'Publication fixture', setupCode } });
  admin = await login();
  const connections = await request('/api/connections'), tags = await request('/api/tag-definitions');
  const entry = { id: 'unified-publication', source: 'examples/unified-publication.json', title: 'Unified publication · Dispatch desk', distribution: 'portable', entryScreenId: 'release-desk' };
  const built = await buildWorkshop(root, entry, '2026-09-30T00:00:00.000Z');
  const imported = await request('/api/projects/import?name=Unified%20publication%20acceptance', { method: 'POST', raw: true, body: built.bytes });
  const scope = suffix => `/api/projects/${imported.id}${suffix}`;
  assert.equal(imported.published, false);
  assert.equal((await request(scope('/scripts/publication'))).published, false);
  let project = await request(scope('/project')), scripts = await request(scope('/scripts/resources'));
  assert.deepEqual(scripts, built.scripts); assert.deepEqual(project.screens, built.project.screens);
  pass('authored package imports with every script disabled and no publication');
  scripts.resources.forEach(resource => resource.enabled = true);
  scripts = await request(scope('/scripts/resources'), { method: 'PUT', body: scripts });
  let review = await request(scope('/project/publication-review'));
  assert.equal(review.resources.length, 3); assert.equal(review.queries, 1); assert.equal(review.screens, 1);
  const query = (await request(scope('/queries')))[0]; query.name = 'Reviewed dispatch sample';
  await request(scope(`/queries/${query.id}`), { method: 'PUT', body: query });
  await request(scope('/project/publish'), { method: 'POST', body: review, status: 409 });
  assert.equal((await request(scope('/project/publication'))).published, false);
  pass('concurrent saved query invalidates the complete review before any activation');
  async function publish() { const next = await request(scope('/project/publication-review')); return request(scope('/project/publish'), { method: 'POST', body: next }); }
  async function ready(publication) { return until(async () => { const state = await request(scope('/scripts/events/status')); return state.acceptingEvents && state.publishedAt === publication.publishedAt; }, 'matching event generation'); }
  const amber = await publish(); await ready(amber);
  const operator = await login('operator', imported.id);
  async function verify(publication, expected) {
    const action = await request(scope('/runtime/screens/release-desk/components/verify/action'), { method: 'POST', session: operator, body: { publishedAt: publication.publishedAt, parameters: {}, inputs: {} } });
    assert.equal(action.success, true, action.stderr); assert.equal(action.result, expected);
    assert.ok(action.uiEffects.some(effect => effect.componentId === 'result' && effect.value === expected));
    const logs = await request(scope('/scripts/events/logs'));
    assert.equal(logs.find(log => log.event === 'startup').result, expected);
    const browser = await request(scope(`/runtime/scripts?publishedAt=${encodeURIComponent(publication.publishedAt)}`), { session: operator });
    assert.equal(browser.applicationPublishedAt, publication.publishedAt); assert.equal(browser.resources.length, 1);
    assert.equal(browser.resources[0].type, 'client'); assert.ok(!JSON.stringify(browser).includes('def caption'));
    return browser;
  }
  assert.match((await verify(amber, 'Release Amber / Line1')).resources[0].code, /Amber/);
  const amberId = (await request(scope('/project/history'))).entries[0].id;
  pass('one reviewed publish activates paired screen/Python/query/gateway/browser resources');
  project.screens[0].components[0].props.text = 'Release Indigo · Dispatch desk';
  project = await request(scope('/project'), { method: 'PUT', body: project });
  scripts.resources[0].code = scripts.resources[0].code.replaceAll('Amber', 'Indigo');
  scripts.resources[2].code = scripts.resources[2].code.replaceAll('Amber', 'Indigo');
  scripts = await request(scope('/scripts/resources'), { method: 'PUT', body: scripts });
  query.parameters[0].defaultValue = 'Line2'; await request(scope(`/queries/${query.id}`), { method: 'PUT', body: query });
  const indigo = await publish(); await ready(indigo);
  await request(scope(`/runtime/scripts?publishedAt=${encodeURIComponent(amber.publishedAt)}`), { session: operator, status: 409 });
  await request(scope('/runtime/screens/release-desk/components/verify/action'), { method: 'POST', session: operator, body: { publishedAt: amber.publishedAt }, status: 409 });
  assert.match((await verify(indigo, 'Release Indigo / Line2')).resources[0].code, /Indigo/);
  pass('second complete release switches every resource and rejects stale operator/browser requests');
  const restored = await request(scope(`/project/history/${amberId}/restore`), { method: 'POST', body: { expectedPublishedAt: indigo.publishedAt } }); await ready(restored);
  assert.match((await verify(restored, 'Release Amber / Line1')).resources[0].code, /Amber/);
  assert.equal((await request(scope('/runtime/project'), { session: operator })).screens[0].components[0].props.text, 'Release Amber · Dispatch desk');
  assert.deepEqual(await request(scope('/project')), project); assert.deepEqual(await request(scope('/scripts/resources')), scripts);
  assert.equal((await request(scope('/queries')))[0].parameters[0].defaultValue, 'Line2');
  pass('complete rollback reactivates Amber resources and preserves every Indigo draft');
  const exported = await request(scope('/export'), { binary: true }), entries = readZip(exported);
  assert.deepEqual([...entries.keys()].sort(), ['manifest.json', 'project.json', 'queries.json', 'scripts-draft.json']);
  assert.deepEqual(JSON.parse(entries.get('project.json')), project); assert.deepEqual(JSON.parse(entries.get('scripts-draft.json')), { ...scripts, revision: 0 });
  const again = await request('/api/projects/import?name=Unified%20publication%20re-export', { method: 'POST', raw: true, body: exported }); assert.equal(again.published, false);
  assert.equal((await request(`/api/projects/${again.id}/scripts/publication`)).published, false);
  assert.deepEqual(await request('/api/connections'), connections); assert.deepEqual(await request('/api/tag-definitions'), tags);
  pass('re-export/re-import preserves current drafts with no runtime or gateway state');
  console.log(`PASS ${checks} authenticated unified-publication workshop groups`);
  if (browser) {
    const projects = { publication: imported.id };
    const catalog = JSON.parse(await fs.readFile(path.join(root, 'examples/catalog.json'), 'utf8'));
    for (const id of ['supplied-data-charts', 'dataset-nested-queries', 'component-interactions', 'validated-inputs', 'view-containers']) {
      const item = catalog.workshops.find(workshop => workshop.id === id); assert.ok(item);
      const pack = await buildWorkshop(root, item, '2026-09-30T00:00:00.000Z');
      const created = await request(`/api/projects/import?name=${encodeURIComponent(item.title)}`, { method: 'POST', raw: true, body: pack.bytes });
      const reviewed = await request(`/api/projects/${created.id}/project/publication-review`);
      await request(`/api/projects/${created.id}/project/publish`, { method: 'POST', body: reviewed }); projects[id] = created.id;
    }
    const authPath = path.join(fixture, 'browser-auth.json');
    await fs.writeFile(authPath, JSON.stringify({ baseUrl: base, projectId: imported.id, projects, admin: account }, null, 2));
    for (const loader of ['load-unit-model-example.mjs', 'load-equipment-commands-example.mjs', 'load-table-batch-example.mjs']) {
      const task = spawn(process.execPath, [path.join(root, 'tools', loader), base, '--publish'], { cwd: root, windowsHide: true, env: { ...process.env, SPARKSTUDIO_ADMIN_AUTH_FILE: authPath }, stdio: ['ignore', 'pipe', 'pipe'] });
      let transcript = ''; task.stdout.on('data', value => transcript += value); task.stderr.on('data', value => transcript += value);
      const [code] = await once(task, 'exit'); assert.equal(code, 0, transcript); console.log(transcript.trim());
    }
    const all = await request('/api/projects');
    projects['table-batch-workflow'] = all.projects.find(project => project.name === 'Atomic table batch workshop')?.id;
    await fs.writeFile(authPath, JSON.stringify({ baseUrl: base, projectId: imported.id, projects, admin: account }, null, 2));
    await fs.writeFile(path.join(fixture, 'browser-ready.json'), JSON.stringify({ baseUrl: base, fixture, authPath, application, projects: all.projects.map(project => ({ id: project.id, name: project.name })) }, null, 2));
    console.log(`BROWSER_READY ${path.join(fixture, 'browser-ready.json')}`);
    while (true) { try { await fs.access(path.join(fixture, 'browser-done')); break; } catch { await delay(500); } }
  }
} catch (error) { console.error(output.slice(-3000)); throw error; }
finally {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  await fs.writeFile(path.join(fixture, 'gateway.log'), output).catch(() => {});
}
