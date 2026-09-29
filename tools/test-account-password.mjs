#!/usr/bin/env node
// Uses only newly generated disposable accounts on the isolated verification gateway.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && base.port === '5091');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
const fixture = JSON.parse(await readFile('.data/test-evidence/security-test-accounts.json', 'utf8'));
assert.equal(new URL(fixture.baseUrl).origin, base.origin);
const secrets = [], identities = [], run = randomUUID().slice(0, 8);
const password = () => { const value = randomBytes(24).toString('base64url'); secrets.push(value); return value; };
let passed = 0;
class Client {
  constructor(audience = 'engineering') { this.audience = audience; this.cookies = new Map(); this.csrf = null; }
  async request(route, { method = 'GET', body, status = 200, csrf = true, headers = {} } = {}) {
    const response = await fetch(new URL(route, base), { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'X-SPARK-AUDIENCE': this.audience, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(csrf && method !== 'GET' && this.csrf ? { 'X-SPARK-CSRF': this.csrf } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'), split = pair.indexOf('='), key = pair.slice(0, split), value = pair.slice(split + 1);
      if (value) this.cookies.set(key, value); else this.cookies.delete(key);
    }
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${route}: unexpected HTTP status`);
    const result = raw ? JSON.parse(raw) : null;
    if (route.startsWith('/api/auth/') && result?.csrfToken) this.csrf = result.csrfToken;
    // Cross-origin requests are rejected by the outer gateway middleware before
    // the authentication endpoint; they contain no account response to cache.
    if (!headers.Origin) assert.ok(response.headers.get('cache-control')?.includes('no-store'));
    return result;
  }
  login(identity, status = 200) { return this.request('/api/auth/login', { method: 'POST', status,
    body: { audience: this.audience, username: identity.username, password: identity.password, projectId: fixture.projectId } }); }
  session() { return this.request(`/api/auth/session?audience=${this.audience}&projectId=${fixture.projectId}`); }
  change(currentPassword, newPassword, rest = {}) { return this.request('/api/auth/password', {
    method: 'POST', body: { currentPassword, newPassword }, ...rest }); }
  copy(audience = this.audience) { const copy = new Client(audience); copy.cookies = new Map(this.cookies); copy.csrf = this.csrf; return copy; }
}
const admin = new Client(), test = async (name, action) => { await action(); console.log(`PASS ${name}`); passed++; };
await admin.login(fixture.admin);
async function newIdentity(suffix, design = true) {
  const identity = { username: `password-${run}-${suffix}`, password: password() };
  const user = await admin.request('/api/security/users', { method: 'POST', status: 201, body: {
    ...identity, displayName: 'Disposable password verification', gatewayAdmin: false,
    projectGrants: { [fixture.projectId]: { view: true, operate: false, design, publish: false } } } });
  identity.id = user.id; identities.push(identity); return identity;
}
async function account(identity) { return (await admin.request('/api/security/users')).users.find(user => user.id === identity.id); }
try {
  const identity = await newIdentity('self'), other = await newIdentity('other'), limited = await newIdentity('operator', false);
  const designer = new Client(), secondDevice = new Client(), operator = new Client('operator'), otherSession = new Client('operator');
  await designer.login(identity); await secondDevice.login(identity); await operator.login(identity); await otherSession.login(other);
  const before = await account(identity), next = password();
  await test('anonymous, missing CSRF, mismatched audience and foreign origins cannot change passwords', async () => {
    await new Client().change(identity.password, next, { status: 401 });
    await designer.change(identity.password, next, { csrf: false, status: 403 });
    await designer.change(identity.password, next, { headers: { 'X-SPARK-CSRF': operator.csrf }, status: 403 });
    await operator.copy('engineering').change(identity.password, next, { status: 401 });
    await designer.change(identity.password, next, { headers: { 'X-SPARK-AUDIENCE': 'administrator' }, status: 400 });
    await designer.change(identity.password, next, { headers: { Origin: 'https://other.example' }, status: 403 });
    await designer.change(identity.password, next, { headers: { 'Sec-Fetch-Site': 'cross-site' }, status: 403 });
  });
  await test('request cannot name another account and enforces current/new password policy', async () => {
    for (const extension of [{ userId: other.id }, { username: other.username }, { audience: 'operator' }])
      await designer.change(identity.password, next, { body: { currentPassword: identity.password, newPassword: next, ...extension }, status: 400 });
    await designer.change(password(), next, { status: 400 });
    await designer.change(identity.password, 'short', { status: 400 });
    await designer.change(identity.password, 'x'.repeat(257), { status: 400 });
    await designer.change(identity.password, null, { status: 400 });
    await designer.change(identity.password, identity.password, { status: 400 });
    assert.deepEqual(await account(identity), before);
    for (const client of [designer, secondDevice, operator]) assert.equal((await client.session()).user.id, identity.id);
  });
  await test('successful self change revokes every device and audience and clears both matching cookies', async () => {
    designer.cookies.set('SparkStudio.Operator', operator.cookies.get('SparkStudio.Operator'));
    const oldTicket = designer.copy(), oldOperatorTicket = operator.copy();
    assert.deepEqual(await designer.change(identity.password, next), { changed: true });
    assert.equal(designer.cookies.size, 0);
    await oldTicket.change(next, password(), { status: 401 });
    for (const client of [designer, oldTicket, secondDevice, oldOperatorTicket]) assert.equal((await client.session()).user, null);
    const after = await account(identity);
    assert.equal(after.revision, before.revision + 1);
    for (const key of ['id', 'username', 'displayName', 'gatewayAdmin', 'disabled', 'projectGrants', 'createdAt'])
      assert.deepEqual(after[key], before[key]);
    await new Client().login(identity, 401);
    identity.password = next;
    assert.equal((await designer.login(identity)).user.id, identity.id);
    assert.equal((await otherSession.session()).user.id, other.id);
  });
  await test('changing engineering password preserves an unrelated operator account cookie', async () => {
    designer.cookies.set('SparkStudio.Operator', otherSession.cookies.get('SparkStudio.Operator'));
    const replacement = password();
    await designer.change(identity.password, replacement);
    assert.ok(!designer.cookies.has('SparkStudio.Engineering'));
    assert.ok(designer.cookies.has('SparkStudio.Operator'));
    assert.equal((await designer.copy('operator').session()).user.id, other.id);
    identity.password = replacement;
  });
  await test('operator without design/admin permission can change only their own password', async () => {
    const client = new Client('operator'), replacement = password();
    await client.login(limited);
    await client.change(limited.password, replacement);
    assert.equal(client.cookies.size, 0);
    await new Client('operator').login(limited, 401);
    limited.password = replacement;
    const signedIn = await client.login(limited);
    assert.equal(signedIn.user.id, limited.id);
    assert.equal(signedIn.permissions.design, false); assert.equal(signedIn.permissions.gatewayAdmin, false);
  });
  await test('repeated wrong current passwords are throttled without changing or revoking the account', async () => {
    const locked = await newIdentity('throttle'), client = new Client(); await client.login(locked);
    const original = await account(locked), wrong = password(), replacement = password();
    for (let attempt = 0; attempt < 5; attempt++) await client.change(wrong, replacement, { status: 400 });
    await client.change(locked.password, replacement, { status: 429 });
    await new Client().login(locked, 429);
    assert.deepEqual(await account(locked), original);
    assert.equal((await client.session()).user.id, locked.id);
  });
  await test('self-service audit includes outcome and account but no credentials or session tokens', async () => {
    const audit = await admin.request('/api/security/audit?limit=500');
    for (const outcome of ['started', 'allowed', 'failed']) assert.ok(audit.entries.some(entry =>
      entry.action === 'auth.password.change' && entry.actor === identity.username && entry.targetUserId === identity.id && entry.outcome === outcome));
    const text = JSON.stringify(audit);
    for (const secret of [...secrets, admin.csrf, designer.csrf, operator.csrf].filter(Boolean))
      assert.ok(!text.includes(secret), 'Audit must not contain secrets.');
  });
} finally {
  for (const identity of identities) {
    const user = await account(identity);
    if (user && !user.disabled) await admin.request(`/api/security/users/${identity.id}`, { method: 'PUT', body: { ...user, disabled: true } });
  }
}
console.log(`PASS ${passed} self-service password integration groups. Disposable accounts disabled.`);
