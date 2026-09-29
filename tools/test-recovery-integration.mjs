// Run each phase against an explicitly started disposable gateway on 5091.
// This script never starts/stops a service or reads installed gateway data.
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { buildWorkshop } from './workshop-packages.mjs';

const [phase, fixtureInput] = process.argv.slice(2);
assert.ok(['seed', 'isolated', 'approve', 'resumed'].includes(phase));
const fixture = await realpath(path.resolve(fixtureInput ?? ''));
assert.ok(fixture.toLowerCase().startsWith((await realpath('.data')).toLowerCase() + path.sep));
assert.match(path.basename(fixture), /^recovery-integration-[a-f0-9]{32}$/);
const identityPath = path.join(fixture, 'test-accounts.json'), base = 'http://127.0.0.1:5091';
let accounts = phase === 'seed' ? { baseUrl: base, admin: { username: 'recovery-admin', password: randomBytes(24).toString('base64url') }, designer: { username: 'recovery-designer', password: randomBytes(24).toString('base64url') } } : JSON.parse(await readFile(identityPath, 'utf8'));
let cookie = '', csrf = '', audience = 'engineering';
async function request(route, method = 'GET', body, expected = 200, raw = false) {
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(20000), headers: {
    'X-SPARK-AUDIENCE': audience, ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' && csrf ? { 'X-SPARK-CSRF': csrf } : {}),
    ...(body === undefined ? {} : { 'Content-Type': raw ? 'application/zip' : 'application/json' }),
  }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, expected, `${method} ${route}: ${response.status} ${bytes.toString().slice(0, 350)}`);
  if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const result = bytes.length && response.headers.get('content-type')?.includes('json') ? JSON.parse(bytes.toString()) : bytes;
  if (result?.csrfToken) csrf = result.csrfToken;
  return result;
}
async function login(who = accounts.admin, target = 'engineering') { cookie = ''; csrf = ''; audience = target; await request('/api/auth/login', 'POST', { ...who, audience }); }
const route = suffix => `/api/projects/${accounts.projectId}${suffix}`;
const sentinel = path.join(fixture, 'startup-observation.txt');
const observations = async () => (await readFile(sentinel, 'utf8')).replaceAll('\r\n', '\n');
async function waitFor(predicate) { for (let attempt = 0; attempt < 50; attempt++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); } assert.fail('Timed out waiting for fixture state.'); }

if (phase === 'seed') {
  await assert.rejects(access(identityPath));
  assert.equal((await request('/api/auth/session?audience=engineering')).setupRequired, true);
  const setupCode = (await readFile(path.join(fixture, 'data/security/setup-code.txt'), 'utf8')).trim();
  await request('/api/auth/setup', 'POST', { ...accounts.admin, setupCode });
  await writeFile(identityPath, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  const catalog = JSON.parse(await readFile('examples/catalog.json', 'utf8'));
  const entry = catalog.workshops.find(item => item.id === 'gateway-recovery');
  // The screen itself is portable; its recovery exercises require separate gateway setup.
  const built = await buildWorkshop(process.cwd(), { ...entry, distribution: 'portable' }, new Date().toISOString());
  const imported = await request('/api/projects/import', 'POST', built.bytes, 200, true);
  accounts.projectId = imported.id;
  await writeFile(identityPath, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  let project = await request(route('/project'));
  await request(route('/project/publish'), 'POST', { revision: project.revision });
  project.screens[0].components.find(item => item.id === 'checkpoint').props.text = 'Unpublished checkpoint: RECOVERY-LAB-B';
  await request(route('/project'), 'PUT', project);
  await request('/api/tags', 'POST', { path: '[default]RecoveryLab/Checkpoint', kind: 'memory', dataType: 'Int32', value: 37 });
  await request('/api/connections', 'POST', { id: 'recovery-sqlite', name: 'Recovery fixture SQLite', type: 'sqlite', database: 'recovery-lab.db' });
  await request('/api/connections/recovery-sqlite/database', 'POST', { initializeSampleData: true });
  await request(route('/queries/recovery-rows'), 'PUT', { id: 'recovery-rows', name: 'Recovery row check', connectionId: 'recovery-sqlite', sql: 'SELECT COUNT(*) AS count FROM production_records', kind: 'query', parameters: [] });
  const scripts = await request(route('/scripts/resources'));
  scripts.resources = [{ id: 'recovery-startup', name: 'Synthetic startup observation', type: 'gateway', event: 'startup', enabled: true, parameters: {}, code: `with open(${JSON.stringify(sentinel)}, "a", encoding="utf-8") as observation:\n    observation.write("started" + chr(10))\nresult = True` }];
  const savedScripts = await request(route('/scripts/resources'), 'PUT', scripts);
  await request(route('/scripts/publish'), 'POST', { revision: savedScripts.revision });
  await waitFor(async () => { try { return (await observations()) === 'started\n'; } catch { return false; } });
  await request('/api/security/users', 'POST', { ...accounts.designer, displayName: 'Recovery designer', projectGrants: { [accounts.projectId]: { design: true, publish: false, view: false, operate: false } } }, 201);
  await writeFile(identityPath, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  console.log('PASS seeded published/draft workshop, memory tag, SQLite, accounts and observable startup job in a disposable gateway');
} else {
  await login();
  const recovery = await request('/api/gateway/recovery');
  if (phase === 'isolated') {
    assert.equal(recovery.active, true); assert.equal(recovery.invalidMarker, false); assert.equal(recovery.restartRequired, false);
    const deployment = await request('/api/gateway/deployment');
    assert.deepEqual(deployment.listeners.addresses, ['http://127.0.0.1:5091']);
    const project = await request(route('/project'));
    assert.equal(project.screens[0].components.find(item => item.id === 'checkpoint').props.text, 'Unpublished checkpoint: RECOVERY-LAB-B');
    const definitions = await request('/api/tag-definitions'); assert.equal(definitions.find(item => item.path === '[default]RecoveryLab/Checkpoint').value, 37);
    await request('/api/connections/recovery-sqlite/schema', 'GET', undefined, 409);
    await request(route('/queries/recovery-rows/execute'), 'POST', { parameters: {} }, 409);
    await request(route('/scripts/run'), 'POST', { code: 'result = 1' }, 409);
    assert.equal((await request(route('/scripts/events/logs'))).length, 0);
    assert.equal(await observations(), 'started\n');
    const savedCsrf = csrf; csrf = '';
    await request('/api/gateway/recovery/approve', 'POST', {}, 403); csrf = savedCsrf;
    await request('/api/gateway/recovery/approve', 'POST', { revision: recovery.revision, confirmation: 'wrong' }, 400);
    await login(accounts.designer);
    await request('/api/gateway/recovery', 'GET', undefined, 403);
    await request('/api/gateway/recovery/approve', 'POST', {}, 403);
    await login(accounts.admin, 'operator');
    await request(route('/runtime/project'), 'GET', undefined, 503);
    console.log('PASS restored draft/tags/accounts; loopback isolation, blocked connectors/jobs/operators, administrator boundary and CSRF');
  } else if (phase === 'approve') {
    await request('/api/gateway/recovery/approve', 'POST', { revision: recovery.revision, confirmation: 'RESUME RESTORED GATEWAY', reviewedConnections: true, reviewedScripts: true, reviewedIdentityAndDeployment: true });
    assert.equal((await request('/api/gateway/recovery')).restartRequired, true);
    await request(route('/scripts/run'), 'POST', { code: 'result = 1' }, 409);
    assert.equal(await observations(), 'started\n');
    console.log('PASS audited approval retains runtime isolation until restart');
  } else {
    assert.equal(recovery.active, false);
    const rows = await request(route('/queries/recovery-rows/execute'), 'POST', { parameters: {} });
    assert.equal(rows.rows[0].count, 3);
    await waitFor(async () => (await observations()) === 'started\nstarted\n');
    const exported = await request(`/api/projects/${accounts.projectId}/export`);
    assert.ok(exported.length > 0);
    await login(accounts.admin, 'operator');
    const published = await request(route('/runtime/project'));
    assert.equal(published.screens[0].components.find(item => item.id === 'checkpoint').props.text, 'Published checkpoint: RECOVERY-LAB-A');
    console.log('PASS explicit restart resumes only the restored copy; SQLite, startup job, publication, draft and package re-export survived');
  }
}
