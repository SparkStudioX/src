#!/usr/bin/env node
// Isolated local gateway only. Synthetic resources and disposable identities.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

assert.ok(process.env.SPARKSTUDIO_TEST_AUTH_FILE, 'Set SPARKSTUDIO_TEST_AUTH_FILE to the local isolated test account file; do not use the auth preload.');
const credentialsPath = path.resolve(process.env.SPARKSTUDIO_TEST_AUTH_FILE);
assert.ok(credentialsPath.startsWith(path.resolve('.data') + path.sep));
const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
const base = new URL(credentials.baseUrl);
assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname) && base.port === '5091' && base.pathname === '/');
const run = randomUUID().slice(0, 8), created = [], tokens = [];
let passed = 0, projectId, otherProjectId, draft, designer, designerUser;
const signal = `[default]PreviewTests/${run}/Value`, started = `[default]PreviewTests/${run}/Started`;
let tagsCreated = false;
class Client {
  constructor(audience = 'engineering') { this.audience = audience; this.cookie = ''; this.csrf = ''; }
  async call(url, { method = 'GET', body, status = 200, token, headers = {}, csrf = true } = {}) {
    const response = await fetch(new URL(url, base), { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: {
      'X-SPARK-AUDIENCE': this.audience, ...(this.cookie ? { Cookie: this.cookie } : {}),
      ...(method !== 'GET' && csrf && this.csrf ? { 'X-SPARK-CSRF': this.csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'X-SPARK-PREVIEW': token } : {}), ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const cookies = response.headers.getSetCookie(); if (cookies.length) this.cookie = cookies.map(value => value.split(';')[0]).join('; ');
    const raw = await response.text(); let data; try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    assert.ok((Array.isArray(status) ? status : [status]).includes(response.status), `${method} ${url}: expected ${status}, received ${response.status}; ${raw.slice(0, 500)}`);
    if (data?.csrfToken) this.csrf = data.csrfToken;
    return data;
  }
  login(identity) { return this.call('/api/auth/login', { method: 'POST', body: { audience: this.audience, username: identity.username, password: identity.password } }); }
}
const admin = new Client(), second = new Client(), operator = new Client('operator'), anonymous = new Client();
const route = suffix => `/api/projects/${projectId}${suffix}`;
const begin = async (client, mode = 'read-only') => { const value = await client.call(route('/preview/sessions'), { method: 'POST', body: { mode } }); tokens.push([client, value.token]); return value; };
const script = (client, token, code, status = 200) => client.call(route('/preview/scripts/run'), { method: 'POST', body: { code }, token, status });
const readTag = async tag => (await admin.call('/api/tags/read', { method: 'POST', body: { paths: [tag] } }))[0].value;
const writeCode = tag => `system.tag.writeBlocking([${JSON.stringify(tag)}], [True])\nresult = True`;
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
try {
  await admin.login(credentials.admin); await second.login(credentials.admin); await operator.login(credentials.admin);
  projectId = (await admin.call('/api/projects', { method: 'POST', body: { name: `Preview boundary ${run}` } })).id; created.push(projectId);
  otherProjectId = (await admin.call('/api/projects', { method: 'POST', body: { name: `Other preview ${run}` } })).id; created.push(otherProjectId);
  draft = await admin.call(route('/project'));
  await admin.call(route('/queries/production-summary'), { method: 'PUT', body: { id: 'production-summary', name: 'Sample read', connectionId: 'sample', sql: 'SELECT Line, Product, Produced, Target FROM ProductionSummary WHERE Line = @line', parameters: [{ name: 'line', type: 'string', defaultValue: 'Line1' }] } });
  for (const tag of [signal, started]) await admin.call('/api/tags', { method: 'POST', body: { path: tag, kind: 'memory', dataType: 'Boolean', value: false, enabled: true } });
  tagsCreated = true;
  const designerIdentity = { username: `preview-designer-${run}`, password: randomBytes(24).toString('base64url') };
  designerUser = await admin.call('/api/security/users', { method: 'POST', status: 201, body: { ...designerIdentity, projectGrants: { [projectId]: { design: true } } } });
  designer = new Client(); await designer.login(designerIdentity);
  await test('session admission requires engineering authentication and CSRF', async () => {
    await anonymous.call(route('/preview/sessions'), { method: 'POST', body: { mode: 'read-only' }, status: 401 });
    await operator.call(route('/preview/sessions'), { method: 'POST', body: { mode: 'read-only' }, status: 401 });
    await admin.call(route('/preview/sessions'), { method: 'POST', body: { mode: 'read-only' }, csrf: false, status: 403 });
    for (const body of [{ mode: 'unsafe' }, { mode: 'read-only', liveActions: true }]) await admin.call(route('/preview/sessions'), { method: 'POST', body, status: 400 });
  });
  const readOnly = await begin(admin), live = await begin(admin, 'live-actions');
  await test('capabilities are random, mode-specific and expire in fifteen minutes', async () => {
    assert.match(readOnly.token, /^[A-F0-9]{64}$/); assert.notEqual(readOnly.token, live.token); assert.equal(readOnly.mode, 'read-only'); assert.equal(live.mode, 'live-actions');
    assert.ok(Date.parse(readOnly.expiresAt) > Date.now() + 14 * 60000 && Date.parse(readOnly.expiresAt) <= Date.now() + 15 * 60000);
  });
  await test('design permission admits reads but cannot grant live action authority', async () => {
    const read = await begin(designer);
    const rows = await designer.call(route('/preview/queries/production-summary/execute'), { method: 'POST', token: read.token, body: { parameters: { line: 'Line1' } } }); assert.equal(rows.rows.length, 1);
    await designer.call(route('/preview/sessions'), { method: 'POST', body: { mode: 'live-actions' }, status: 403 });
    await script(designer, read.token, 'result = True', 403);
    await designer.call(`/api/projects/${otherProjectId}/preview/sessions`, { method: 'POST', body: { mode: 'read-only' }, status: 403 });
  });
  await test('missing forged and cross-session capabilities fail before execution', async () => {
    await script(admin, undefined, writeCode(signal), 403); await script(admin, '0'.repeat(64), writeCode(signal), 403);
    await script(second, live.token, writeCode(signal), 403);
    await admin.call(`/api/projects/${otherProjectId}/preview/scripts/run`, { method: 'POST', token: live.token, body: { code: writeCode(signal) }, status: 403 });
    assert.equal(await readTag(signal), false);
  });
  await test('read-only preview blocks all Python including direct imports and writes', async () => {
    for (const code of ['result = True', writeCode(signal), "import os\nresult = os.getcwd()", "result = system.db.runNamedQuery('update')"])
      await script(admin, readOnly.token, code, 403);
    assert.equal(await readTag(signal), false);
  });
  await test('guarded sample reads and tag reads work without action authority', async () => {
    const rows = await admin.call(route('/preview/queries/production-summary/execute'), { method: 'POST', token: readOnly.token, body: { parameters: { line: 'Line1' } } }); assert.equal(rows.rows.length, 1);
    const values = await admin.call('/api/tags/read', { method: 'POST', token: readOnly.token, headers: { 'X-SPARK-PROJECT': projectId }, body: { paths: [signal] } }); assert.equal(values[0].value, false);
    const scoped = await admin.call(route('/tags/read'), { method: 'POST', token: readOnly.token, body: { paths: [signal] } }); assert.equal(scoped[0].value, false);
    await admin.call(`/api/projects/${otherProjectId}/tags/read`, { method: 'POST', token: readOnly.token, body: { paths: [signal] }, status: 403 });
  });
  await test('read-only routes reject named update definitions in both modes', async () => {
    await admin.call(route('/queries/preview-update'), { method: 'PUT', body: { id: 'preview-update', name: 'Unused update boundary', kind: 'update', connectionId: 'unused-preview-fixture', sql: 'UPDATE fixture SET value=@value', parameters: [{ name: 'value', type: 'int' }] } });
    for (const token of [readOnly.token, live.token]) await admin.call(route('/preview/queries/preview-update/execute'), { method: 'POST', token, body: { parameters: { value: 1 } }, status: 400 });
  });
  await test('capabilities cannot escape into generic mutation and table-action APIs', async () => {
    for (const token of [readOnly.token, live.token]) {
      await admin.call(route('/scripts/run'), { method: 'POST', token, body: { code: writeCode(signal) }, status: 403 });
      await admin.call(route('/queries/production-summary/execute'), { method: 'POST', token, body: { parameters: {} }, status: 403 });
      await admin.call(route('/project'), { method: 'PUT', token, body: draft, status: 403 });
      await admin.call(route('/project/publish'), { method: 'POST', token, body: { revision: draft.revision }, status: 403 });
      await operator.call(route('/runtime/screens/main/components/table/table-edit'), { method: 'POST', token, body: {}, status: 403 });
      await operator.call(route('/runtime/screens/main/components/button/action'), { method: 'POST', token, body: {}, status: 403 });
      await admin.call(route('/preview/unknown-action'), { method: 'POST', token, body: {}, status: 404 });
    }
    assert.deepEqual(await admin.call(route('/project')), draft); assert.equal(await readTag(signal), false);
  });
  await test('live actions require current admin session and can execute a disposable memory write', async () => {
    assert.equal((await script(admin, live.token, writeCode(signal))).success, true); assert.equal(await readTag(signal), true);
    await admin.call(route('/scripts/run'), { method: 'POST', body: { code: `system.tag.writeBlocking([${JSON.stringify(signal)}], [False])` } });
  });
  await test('revoked capabilities remain denied and cannot be escalated by a requested mode', async () => {
    await admin.call(route('/preview/session'), { method: 'DELETE', token: live.token, status: 204 });
    await script(admin, live.token, writeCode(signal), 403);
    await admin.call(route('/preview/scripts/run'), { method: 'POST', token: readOnly.token, body: { code: writeCode(signal), mode: 'live-actions' }, status: 403 });
    assert.equal(await readTag(signal), false);
  });
  await test('revoking an in-flight live capability cancels Python before a delayed write', async () => {
    const running = await begin(admin, 'live-actions');
    const pending = script(admin, running.token, `import time\n${writeCode(started)}\ntime.sleep(5)\n${writeCode(signal)}`, [500, 502]);
    for (let attempts = 0; ; attempts++) { if (await readTag(started)) break; assert.ok(attempts < 100, 'Worker did not start.'); await new Promise(resolve => setTimeout(resolve, 20)); }
    await admin.call(route('/preview/session'), { method: 'DELETE', token: running.token, status: 204 }); await pending;
    assert.equal(await readTag(signal), false); await script(admin, running.token, writeCode(signal), 403);
  });
  await test('signing out invalidates capabilities even while their lifetime remains', async () => {
    const value = await begin(second, 'live-actions'); await second.call('/api/auth/logout', { method: 'POST', body: { audience: 'engineering' } });
    await second.login(credentials.admin); await script(second, value.token, writeCode(signal), 403); assert.equal(await readTag(signal), false);
  });
  console.log(`${passed} preview communication gateway checks passed.`);
} finally {
  for (const [client, token] of tokens) { try { await client.call(route('/preview/session'), { method: 'DELETE', token, status: [204, 401, 403] }); } catch {} }
  if (tagsCreated) for (const tag of [signal, started]) await admin.call(`/api/tag-definitions?path=${encodeURIComponent(tag)}`, { method: 'DELETE', status: [204, 404] });
  if (designerUser) {
    const user = (await admin.call('/api/security/users')).users.find(value => value.id === designerUser.id);
    if (user) await admin.call(`/api/security/users/${user.id}`, { method: 'PUT', body: { ...user, disabled: true } });
  }
  for (const id of created) await admin.call(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } });
}
