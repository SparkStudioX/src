#!/usr/bin/env node
// Explicitly isolated local gateway only. Passwords are generated, never embedded or printed.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
const dataDir = path.resolve(process.argv[3] ?? '.data/security-verification');
assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && base.port === '5091');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
assert.equal(path.basename(dataDir), 'security-verification', 'Use the dedicated security-verification data directory.');
const credentialPath = path.join(dataDir, 'security', 'test-identity.json');
const password = () => randomBytes(24).toString('base64url');
const run = randomUUID().slice(0, 8), identities = {}, secrets = [];
let passed = 0, projectA, projectB, draft, publishedAt, fixture;

class Client {
  constructor(audience = 'engineering', projectId = null) { this.audience = audience; this.projectId = projectId; this.cookies = new Map(); this.csrf = null; }
  headers({ method = 'GET', body, csrf = true, headers = {} } = {}) {
    const result = { 'X-SPARK-AUDIENCE': this.audience, ...(this.projectId ? { 'X-SPARK-PROJECT': this.projectId } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(this.cookies.size ? { Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
      ...(csrf && method !== 'GET' && this.csrf ? { 'X-SPARK-CSRF': this.csrf } : {}), ...headers };
    return result;
  }
  async request(url, options = {}) {
    const { method = 'GET', body, status = 200, binary = false, raw, ...rest } = options;
    const response = await fetch(new URL(url, base), { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: this.headers({ ...rest, method, body }), body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    for (const cookie of response.headers.getSetCookie()) {
      const [item] = cookie.split(';'), index = item.indexOf('='), name = item.slice(0, index), value = item.slice(index + 1);
      if (value) this.cookies.set(name, value); else this.cookies.delete(name);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok((Array.isArray(status) ? status : [status]).includes(response.status), `${method} ${url}: expected ${status}, received ${response.status}; ${bytes.toString('utf8').slice(0, 500)}`);
    if (binary) return { bytes, headers: response.headers };
    const value = bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
    if (url.startsWith('/api/auth/') && value?.csrfToken) this.csrf = value.csrfToken;
    return value;
  }
  async login(identity, status = 200) {
    return this.request('/api/auth/login', { method: 'POST', body: { audience: this.audience, username: identity.username,
      password: identity.password, ...(this.projectId ? { projectId: this.projectId } : {}) }, status });
  }
  session() { return this.request(`/api/auth/session?audience=${this.audience}${this.projectId ? `&projectId=${this.projectId}` : ''}`); }
}
const admin = new Client(), anon = new Client(), route = suffix => `/api/projects/${projectA}${suffix}`;
const component = (id, type, props) => ({ id, type, props, x: 10, y: 10, width: 260, height: 150 });
const grant = (value = {}) => ({ view: false, operate: false, design: false, publish: false, ...value });
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const persistFixture = async () => {
  await writeFile(credentialPath, JSON.stringify(fixture, null, 2), { mode: 0o600 });
  const evidenceDir = path.resolve('.data/test-evidence'); await mkdir(evidenceDir, { recursive: true });
  const shared = { baseUrl: base.origin, admin: fixture.admin, ...Object.fromEntries(Object.entries(fixture.users).map(([role, identity]) =>
    [role, { username: identity.username, password: identity.password }])), projectId: fixture.projects.a, otherProjectId: fixture.projects.b };
  await writeFile(path.join(evidenceDir, 'security-test-accounts.json'), JSON.stringify(shared, null, 2), { mode: 0o600 });
};
const query = (id, sql, kind = 'query') => ({ id, name: id, connectionId: `security-${run}`, sql, kind, parameters: [] });
const saveQuery = (id, sql, kind) => admin.request(route(`/queries/${id}`), { method: 'PUT', body: query(id, sql, kind) });
function png(value) {
  const chunk = (type, data) => {
    const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); result.write(type, 4); data.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    result.writeUInt32BE((~crc) >>> 0, result.length - 4); return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, value, 80, 120, 255]))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
async function updateUser(id, changes = {}) {
  const users = (await admin.request('/api/security/users')).users;
  const current = users.find(user => user.id === id); assert.ok(current);
  return admin.request(`/api/security/users/${id}`, { method: 'PUT', body: { ...current, ...changes } });
}
async function updateSettings(changes) {
  const current = await admin.request('/api/security/settings');
  return admin.request('/api/security/settings', { method: 'PUT', body: { ...current, ...changes } });
}
async function stream(client) {
  const controller = new AbortController();
  const query = new URLSearchParams({ audience: client.audience, projectId: client.projectId });
  const response = await fetch(new URL(`/api/events?${query}`, base), { headers: client.headers(), signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  async function next() {
    const end = buffer.indexOf('\n\n');
    if (end >= 0) { const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); return JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)); }
    const result = await reader.read(); if (result.done) return null;
    buffer += decoder.decode(result.value, { stream: true }); return next();
  }
  return { next, close: () => controller.abort(), async ended() {
    const timer = setTimeout(() => controller.abort(new Error('SSE did not close after revocation.')), 5500);
    try { for (let index = 0; index < 8; index++) if (await next() === null) return; assert.fail('SSE continued after revocation.'); }
    finally { clearTimeout(timer); controller.abort(); }
  } };
}

await test('bootstrap is local, has no HTTP secret, and establishes an HttpOnly separate engineering cookie', async () => {
  const session = await anon.session(); assert.equal(session.user, null); assert.equal(session.csrfToken, null);
  assert.ok(!JSON.stringify(session).includes('setupCode'));
  if (session.setupRequired) {
    const setupCode = (await readFile(path.join(dataDir, 'security', 'setup-code.txt'), 'utf8')).trim(); secrets.push(setupCode);
    const identity = { username: `admin-${run}`, password: password() }; secrets.push(identity.password);
    await anon.request('/api/auth/setup', { method: 'POST', body: { ...identity, setupCode: 'incorrect' }, status: 403 });
    await anon.request('/api/auth/setup', { method: 'POST', body: { ...identity, setupCode }, headers: { Origin: 'https://untrusted.invalid' }, status: 403 });
    await anon.request('/api/auth/setup', { method: 'POST', body: { ...identity, setupCode }, headers: { 'Sec-Fetch-Site': 'cross-site' }, status: 403 });
    const response = await fetch(new URL('/api/auth/setup', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...identity, setupCode }) });
    assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.user.gatewayAdmin, true);
    const cookies = response.headers.getSetCookie(); assert.equal(cookies.length, 1); assert.match(cookies[0], /^SparkStudio\.Engineering=/);
    assert.match(cookies[0], /httponly/i); assert.match(cookies[0], /samesite=strict/i);
    const item = cookies[0].split(';')[0], index = item.indexOf('='); admin.cookies.set(item.slice(0, index), item.slice(index + 1)); admin.csrf = result.csrfToken;
    fixture = { admin: identity, projects: {}, users: {} }; await persistFixture();
    await assert.rejects(access(path.join(dataDir, 'security', 'setup-code.txt')));
    await anon.request('/api/auth/setup', { method: 'POST', body: { ...identity, setupCode }, status: 409 });
  } else {
    fixture = JSON.parse(await readFile(credentialPath, 'utf8')); secrets.push(fixture.admin.password); await admin.login(fixture.admin);
  }
  const operator = new Client('operator'); operator.cookies = new Map(admin.cookies); assert.equal((await operator.session()).user, null);
  await operator.request('/api/runtime/project', { status: 401 });
});

await test('anonymous access fails closed across legacy and project API aliases', async () => {
  for (const url of ['/api/projects', '/api/health', '/api/project', '/api/tags', '/api/connections', '/api/queries', '/api/scripts/resources', '/api/runtime/project', '/api/events', '/api/security/users', '/api/security/settings', '/api/security/audit'])
    await anon.request(url, { status: 401 });
  await anon.request('/api/not-a-real-endpoint', { status: 404 });
  for (const [url, body] of [['/api/projects', { name: 'Unauthorized' }], ['/api/scripts/run', { code: 'result=1' }]])
    await anon.request(url, { method: 'POST', body, status: 401 });
});

await test('CSRF and Origin validation precede authenticated mutations', async () => {
  await admin.request('/api/projects', { method: 'POST', body: { name: 'No CSRF' }, csrf: false, status: 403 });
  await admin.request('/api/projects', { method: 'POST', body: { name: 'Wrong CSRF' }, headers: { 'X-SPARK-CSRF': 'wrong' }, status: 403 });
  await admin.request('/api/projects', { method: 'POST', body: { name: 'Cross origin' }, headers: { Origin: 'https://untrusted.invalid' }, status: 403 });
  await anon.request('/api/auth/login', { method: 'POST', body: { audience: 'engineering', ...fixture.admin }, headers: { 'Content-Type': 'text/plain' }, status: [404, 415] });
  await anon.request('/api/auth/login', { method: 'POST', body: { audience: 'engineering', ...fixture.admin }, headers: { Origin: 'https://untrusted.invalid' }, status: 403 });
});

await test('administrator provisions isolated projects, accounts, grants and local sample data', async () => {
  projectA = (await admin.request('/api/projects', { method: 'POST', body: { name: `Access workshop ${run}` } })).id;
  projectB = (await admin.request('/api/projects', { method: 'POST', body: { name: `Private workshop ${run}` } })).id;
  admin.projectId = projectA;
  const roles = { viewer: grant({ view: true }), operator: grant({ view: true, operate: true }), designer: grant({ design: true }), publisher: grant({ design: true, publish: true }) };
  for (const [role, permissions] of Object.entries(roles)) {
    const identity = { username: `${role}-${run}`, password: password() }; secrets.push(identity.password);
    identity.user = await admin.request('/api/security/users', { method: 'POST', body: { ...identity, displayName: `Test ${role}`, projectGrants: { [projectA]: permissions } }, status: 201 });
    identities[role] = identity;
  }
  fixture.projects = { a: projectA, b: projectB }; fixture.users = identities; await persistFixture();
  await admin.request('/api/security/users', { method: 'POST', body: { username: `invalid-${run}`, password: password(), projectGrants: { [projectA]: grant({ operate: true }) } }, status: 400 });
  await admin.request('/api/security/users', { method: 'POST', body: { username: `invalid-${run}`, password: password(), projectGrants: { [projectA]: grant({ publish: true }) } }, status: 400 });
  await admin.request('/api/security/users', { method: 'POST', body: { username: `invalid-${run}`, password: password(), projectGrants: { 'unknown-project': grant({ view: true }) } }, status: 404 });
  await admin.request('/api/connections', { method: 'POST', body: { id: `security-${run}`, name: 'Security test SQLite', type: 'sqlite', database: `security-${run}.db` } });
  assert.equal((await admin.request(`/api/connections/security-${run}/database`, { method: 'POST', body: { initializeSampleData: true } })).success, true);
  await saveQuery('read-value', 'SELECT 42 AS answer'); await saveQuery('update-value', 'UPDATE production_records SET version=version WHERE id=1', 'update');
  draft = await admin.request(route('/project')); delete draft.navigation; draft.parameters = { actor: '' }; draft.templates = [];
  draft.screens = [{ id: 'main', name: 'Access workshop', width: 1000, height: 700, parameters: {}, components: [
    component('hello', 'label', { text: 'Authenticated operator application' }),
    component('read-table', 'table', { queryId: 'read-value' }),
    component('apply', 'button', { text: 'Run published action', action: 'script', script: "result = {'ok': True, 'claimed_actor': parameters['actor']}" }),
  ] }];
  draft = await admin.request(route('/project'), { method: 'PUT', body: draft });
  publishedAt = (await admin.request(route('/project/publish'), { method: 'POST', body: { revision: draft.revision } })).publishedAt;
});

const viewer = new Client('operator'), operator = new Client('operator'), designer = new Client(), publisher = new Client();
await test('catalog filtering and fixed audience selection prevent cookie and project-header confusion', async () => {
  for (const [client, role] of [[viewer, 'viewer'], [operator, 'operator'], [designer, 'designer'], [publisher, 'publisher']]) {
    client.projectId = projectA; await client.login(identities[role]);
    const catalog = await client.request('/api/projects'); assert.deepEqual(catalog.projects.map(item => item.id), [projectA]);
    assert.equal(catalog.defaultProjectId, projectA);
    await client.request(`/api/projects/${projectB}/${client.audience === 'operator' ? 'runtime/project' : 'project'}`, { headers: { 'X-SPARK-PROJECT': projectA }, status: 403 });
    await client.request(client.audience === 'operator' ? '/api/runtime/project' : '/api/project', { headers: { 'X-SPARK-PROJECT': projectA }, status: 403 });
  }
  await viewer.request(route('/project'), { status: 401 });
  await designer.request(route('/runtime/project'), { status: 401 });
  await new Client('engineering', projectA).login(identities.viewer, 403);
  await new Client('operator', projectA).login(identities.designer, 403);
  const both = new Client('operator', projectA); both.cookies = new Map([...admin.cookies, ...viewer.cookies]); both.csrf = viewer.csrf;
  await both.request(route('/runtime/screens/main/components/apply/action'), { method: 'POST', body: { publishedAt, parameters: { actor: '' } }, status: 403 });
  await both.request('/api/projects', { method: 'POST', body: { name: 'Wrong audience token' }, status: 403 });
});

await test('viewer reads only publications; operator invokes captured actions; designer and publisher remain distinct', async () => {
  assert.equal((await viewer.request(route('/runtime/project'))).screens[0].components.find(item => item.id === 'apply').props.script, undefined);
  await viewer.request(route('/runtime/screens/main/components/apply/action'), { method: 'POST', body: { publishedAt }, status: 403 });
  const action = await operator.request(route('/runtime/screens/main/components/apply/action'), { method: 'POST', body: { publishedAt, parameters: { actor: 'forged-administrator' } } });
  assert.equal(action.success, true, action.stderr); assert.equal(action.result.ok, true);
  await designer.request(route('/project/publish'), { method: 'POST', body: { revision: draft.revision }, status: 403 });
  await designer.request('/api/connections', { status: 403 });
  await designer.request(route('/connections'), { status: 403 });
  await designer.request('/api/scripts/run', { method: 'POST', body: { code: 'result=1' }, status: 403 });
  await designer.request(route('/scripts/run'), { method: 'POST', body: { code: 'result=1' }, status: 403 });
  await designer.request('/api/projects', { method: 'POST', body: { name: 'Unauthorized creation' }, status: 403 });
  await designer.request(`/api/projects/${projectA}`, { method: 'PATCH', body: { name: 'Unauthorized rename', revision: draft.revision }, status: 403 });
  await designer.request(route('/project'), { method: 'PUT', body: { ...draft, name: 'Unauthorized rename' }, status: 403 });
  draft = await designer.request(route('/project'), { method: 'PUT', body: draft });
  publishedAt = (await publisher.request(route('/project/publish'), { method: 'POST', body: { revision: draft.revision } })).publishedAt;
  await viewer.request('/api/security/users', { status: 401 }); await designer.request('/api/security/users', { status: 403 });
});

await test('read query execution uses the captured publication while update execution is administrator-only', async () => {
  const result = await viewer.request(route('/runtime/queries/read-value/execute'), { method: 'POST', body: { publishedAt, parameters: {} } }); assert.equal(result.rows[0].answer, 42);
  await saveQuery('read-value', 'UPDATE production_records SET version=version WHERE id=1', 'update');
  const isolated = await viewer.request(route('/runtime/queries/read-value/execute'), { method: 'POST', body: { publishedAt, parameters: {} } }); assert.equal(isolated.rows[0].answer, 42);
  await designer.request(route('/queries/read-value/execute'), { method: 'POST', body: { parameters: {} }, status: 403 });
  await viewer.request(route('/runtime/queries/update-value/execute'), { method: 'POST', body: { publishedAt, parameters: {} }, status: 404 });
  assert.equal(typeof await admin.request(route('/queries/update-value/execute'), { method: 'POST', body: { parameters: {} } }), 'number');
  await saveQuery('read-value', 'SELECT 42 AS answer');
});

await test('runtime assets are limited to published references and never reuse draft-asset authorization', async () => {
  const first = png(30), second = png(180);
  const published = await admin.request(route('/assets'), { method: 'POST', body: { name: 'Published test image', contentType: 'image/png', dataBase64: first } });
  const hidden = await admin.request(route('/assets'), { method: 'POST', body: { name: 'Draft test image', contentType: 'image/png', dataBase64: second } });
  draft.screens[0].components.push(component('image', 'image', { assetId: published.id, fit: 'contain' }));
  draft = await admin.request(route('/project'), { method: 'PUT', body: draft });
  publishedAt = (await publisher.request(route('/project/publish'), { method: 'POST', body: { revision: draft.revision } })).publishedAt;
  const asset = await viewer.request(route(`/runtime/assets/${published.id}`), { binary: true }); assert.ok(asset.bytes.length); assert.match(asset.headers.get('cache-control'), /no-store/);
  await viewer.request(route(`/runtime/assets/${hidden.id}`), { status: 404 });
  await viewer.request(route(`/assets/${published.id}`), { status: 401 });
  await anon.request(route(`/runtime/assets/${published.id}`), { status: 401 });
  await viewer.request(`/api/projects/${projectB}/runtime/assets/${published.id}`, { status: 403 });
});

const allowedTag = `[default]Access-${run}/Allowed/Value`, hiddenTag = `[default]Access-${run}/Private/Value`;
await test('operator tag scopes filter snapshots, check resolved indirection, and immediately affect SSE', async () => {
  for (const [index, tagPath] of [allowedTag, hiddenTag].entries()) await admin.request('/api/tags', { method: 'POST', body: { path: tagPath, kind: 'memory', dataType: 'Int32', value: index + 1, enabled: true } });
  assert.deepEqual(await viewer.request('/api/tags'), []);
  await viewer.request('/api/tags/read', { method: 'POST', body: { paths: [allowedTag] }, status: 403 });
  const prefixes = { [projectA]: [`[default]Access-${run}/Allowed/`] };
  await updateSettings({ projectTagPrefixes: prefixes });
  assert.deepEqual((await viewer.request('/api/tags')).map(item => item.path), [allowedTag]);
  assert.equal((await viewer.request('/api/tags/read', { method: 'POST', body: { paths: [`[default]Access-${run}/{folder}/Value`], parameters: { folder: 'Allowed' } } }))[0].path, allowedTag);
  await viewer.request('/api/tags/read', { method: 'POST', body: { paths: [`[default]Access-${run}/{folder}/Value`], parameters: { folder: 'Private' } }, status: 403 });
  const events = await stream(viewer);
  try {
    assert.deepEqual((await events.next()).map(item => item.path), [allowedTag]);
    await updateSettings({ projectTagPrefixes: {} });
    let frame; for (let count = 0; count < 4; count++) { frame = await events.next(); if (!frame.length) break; }
    assert.deepEqual(frame, []);
  } finally { events.close(); }
  await updateSettings({ projectTagPrefixes: prefixes });
});

await test('logout revokes the selected ticket, closes its SSE, and leaves the other audience independent', async () => {
  const pair = new Client('engineering', projectA); await pair.login(fixture.admin);
  pair.audience = 'operator'; await pair.login(fixture.admin);
  const operatorToken = pair.csrf, engineeringCookie = pair.cookies.get('SparkStudio.Engineering');
  const replay = new Client('operator', projectA); replay.cookies = new Map(pair.cookies); replay.csrf = operatorToken;
  const events = await stream(pair); await events.next();
  await pair.request('/api/auth/logout', { method: 'POST', body: { audience: 'operator' } }); await events.ended();
  assert.equal((await replay.session()).user, null); await replay.request(route('/runtime/project'), { status: 401 });
  pair.audience = 'engineering'; assert.equal(pair.cookies.get('SparkStudio.Engineering'), engineeringCookie);
  assert.equal((await pair.session()).user.username, fixture.admin.username);
  const tampered = new Client(); const cookie = engineeringCookie; tampered.cookies.set('SparkStudio.Engineering', cookie.slice(0, 20) + (cookie[20] === 'A' ? 'B' : 'A') + cookie.slice(21));
  assert.equal((await tampered.session()).user, null);
});

await test('grant changes and disabled accounts immediately revoke active sessions and streams', async () => {
  const events = await stream(operator); await events.next();
  await updateUser(identities.operator.user.id, { disabled: true }); await events.ended();
  await operator.request(route('/runtime/project'), { status: 401 }); assert.equal((await operator.session()).user, null);
  await new Client('operator', projectA).login(identities.operator, 401);
  await updateUser(identities.operator.user.id, { disabled: false }); await operator.login(identities.operator);
  const events2 = await stream(operator); await events2.next();
  await updateUser(identities.operator.user.id, { projectGrants: { [projectA]: grant({ view: true }) } }); await events2.ended();
  await operator.login(identities.operator);
  await operator.request(route('/runtime/screens/main/components/apply/action'), { method: 'POST', body: { publishedAt }, status: 403 });
  await updateUser(identities.operator.user.id, { projectGrants: { [projectA]: grant({ view: true, operate: true }) } }); await operator.login(identities.operator);
});

await test('archiving a project closes existing operator streams and rejects direct global tag routes for it', async () => {
  const events = await stream(viewer); await events.next();
  await admin.request(`/api/projects/${projectA}/archive`, { method: 'POST', body: { archived: true } }); await events.ended();
  await viewer.request('/api/tags', { status: 404 });
  await viewer.request('/api/tags/read', { method: 'POST', body: { paths: [allowedTag] }, status: 404 });
  await viewer.request(route('/runtime/project'), { status: 404 });
  await admin.request(`/api/projects/${projectA}/archive`, { method: 'POST', body: { archived: false } });
  assert.ok((await viewer.request(route('/runtime/project'))).screens.length);
});

await test('last-administrator safety, revision checks, password resets and bounded login lockout', async () => {
  const root = (await admin.request('/api/security/users')).users.find(item => item.username === fixture.admin.username);
  await admin.request(`/api/security/users/${root.id}`, { method: 'PUT', body: { ...root, disabled: true }, status: 409 });
  await admin.request(`/api/security/users/${root.id}`, { method: 'PUT', body: { ...root, gatewayAdmin: false }, status: 409 });
  const viewerUser = (await admin.request('/api/security/users')).users.find(item => item.id === identities.viewer.user.id);
  await admin.request(`/api/security/users/${viewerUser.id}`, { method: 'PUT', body: { ...viewerUser, revision: viewerUser.revision - 1 }, status: 409 });
  const replacement = password(); secrets.push(replacement);
  await updateUser(viewerUser.id, { password: replacement }); assert.equal((await viewer.session()).user, null);
  await new Client('operator', projectA).login(identities.viewer, 401);
  identities.viewer.password = replacement; fixture.users = identities; await persistFixture(); await viewer.login(identities.viewer);
  const wrong = new Client('operator', projectA), invalid = { ...identities.viewer, password: password() };
  for (let index = 0; index < 5; index++) await wrong.login(invalid, 401);
  await wrong.login(identities.viewer, 429);
  // Restore this fixture for manual review with an administrative password reset.
  await updateUser(viewerUser.id, { password: replacement });
});

await test('settings and audit stay bounded and never return passwords, hashes, setup codes or session tokens', async () => {
  let settings = await admin.request('/api/security/settings');
  for (const publicBaseUrl of ['http://factory.example', 'https://factory.example/path', 'https://name:secret@factory.example'])
    await admin.request('/api/security/settings', { method: 'PUT', body: { ...settings, publicBaseUrl }, status: 400 });
  settings = await updateSettings({ publicBaseUrl: 'https://sparkstudio.example' }); assert.equal(settings.publicBaseUrl, 'https://sparkstudio.example');
  assert.equal((await operator.session()).operatorBaseUrl, 'https://sparkstudio.example');
  await updateSettings({ publicBaseUrl: null });
  await admin.request('/api/security/audit?limit=501', { status: 400 });
  const audit = await admin.request('/api/security/audit?limit=500'), users = await admin.request('/api/security/users');
  assert.ok(audit.entries.some(entry => entry.actor === identities.operator.username && entry.action.includes('/action')));
  assert.ok(!audit.entries.some(entry => entry.actor === 'forged-administrator'));
  assert.ok(audit.entries.some(entry => entry.outcome === 'denied'));
  const publicText = JSON.stringify({ users, audit }); assert.ok(!/passwordHash|csrfToken|setupCode/i.test(publicText));
  const stored = await readFile(path.join(dataDir, 'security', 'identities.json'), 'utf8'); assert.ok(stored.includes('passwordHash'));
  const auditText = await readFile(path.join(dataDir, 'security', 'audit.jsonl'), 'utf8');
  for (const secret of [...secrets, admin.csrf, operator.csrf].filter(Boolean)) {
    assert.ok(!stored.includes(secret), 'The identity store contains a plaintext credential.');
    assert.ok(!auditText.includes(secret), 'Audit contains a credential.'); assert.ok(!publicText.includes(secret), 'Security API exposed a credential.');
  }
  assert.ok(!JSON.stringify(JSON.parse(stored).users).includes('test-identity'));
});

console.log(`PASS ${passed} gateway security integration groups. Fixtures retained in the dedicated ignored data directory.`);
