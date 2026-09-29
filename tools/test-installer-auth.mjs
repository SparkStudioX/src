#!/usr/bin/env node
// Bootstrap only a newly extracted installer fixture. Never reads or replaces shared test credentials.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { access, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

assert.equal(process.argv.length, 3, 'Pass the fresh installer verification directory.');
const fixture = await realpath(path.resolve(process.argv[2]));
const local = await realpath(path.resolve('.data'));
assert.equal(path.dirname(fixture).toLowerCase(), local.toLowerCase());
assert.match(path.basename(fixture), /^installer-verification-[a-f0-9]{32}$/);
const data = await realpath(path.join(fixture, 'data')), program = await realpath(path.join(fixture, 'app'));
assert.equal(path.dirname(data).toLowerCase(), fixture.toLowerCase());
assert.equal(path.dirname(program).toLowerCase(), fixture.toLowerCase());
const authFile = path.join(fixture, 'test-accounts.json');
await assert.rejects(access(authFile), error => error.code === 'ENOENT');
const base = new URL('http://127.0.0.1:5091');
const password = () => randomBytes(24).toString('base64url');
const admin = { username: 'installer-admin', password: password() };
const designer = { username: 'installer-designer', password: password() };
let cookie, csrf;
async function request(route, method = 'GET', body, expected = 200) {
  const response = await fetch(new URL(route, base), {
    method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie, 'X-SPARK-CSRF': csrf, 'X-SPARK-AUDIENCE': 'engineering' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, expected, `${method} ${route}: unexpected status ${response.status}`);
  if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const result = await response.json();
  if (result?.csrfToken) csrf = result.csrfToken;
  return result;
}

const before = await request('/api/auth/session?audience=engineering');
assert.equal(before.setupRequired, true); assert.equal(before.user, null);
await request('/api/health', 'GET', undefined, 401);
const setupCode = (await readFile(path.join(data, 'security', 'setup-code.txt'), 'utf8')).trim();
const after = await request('/api/auth/setup', 'POST', { ...admin, setupCode });
assert.equal(after.setupRequired, false); assert.equal(after.user.username, admin.username); assert.ok(cookie && csrf);
await assert.rejects(access(path.join(data, 'security', 'setup-code.txt')), error => error.code === 'ENOENT');
const deployment = await request('/api/gateway/deployment');
assert.equal(path.resolve(deployment.configuration.dataDirectory.value).toLowerCase(), data.toLowerCase(), 'Gateway data is outside this installer fixture.');
const projects = await request('/api/projects');
const defaultProject = projects.projects.find(item => item.isDefault);
assert.ok(defaultProject);
await request('/api/security/users', 'POST', { ...designer, displayName: 'Installer verification designer', projectGrants: { [defaultProject.id]: { view: false, operate: false, design: true, publish: false } } }, 201);
const manifest = JSON.parse(await readFile(path.join(program, 'package-manifest.json'), 'utf8'));
const health = await request('/api/health'); assert.equal(health.pythonAvailable, true);
assert.equal(health.version, `${manifest.version}+${manifest.sourceCommit}`, 'Authenticated health version differs from extracted release provenance.');
const python = await request('/api/scripts/run', 'POST', { code: 'import sys\nresult = {"executable": sys.executable, "version": sys.version.split()[0], "value": sum([2, 3, 5])}' });
assert.equal(python.success, true, 'Bundled Python script failed.');
const expectedPython = await realpath(path.join(program, 'runtimes', 'python', 'windows-x64', 'python.exe'));
assert.equal((await realpath(python.result.executable)).toLowerCase(), expectedPython.toLowerCase(), 'The script used an external Python executable.');
assert.equal(python.result.value, 10);
await writeFile(authFile, JSON.stringify({ baseUrl: base.origin, admin, designer, projectId: defaultProject.id }, null, 2), { mode: 0o600, flag: 'wx' });
await writeFile(path.join(fixture, 'auth-python-verification.json'), JSON.stringify({ setupUsedLocalCode: true, anonymousHealthDenied: true, gatewayVersion: health.version, defaultProjectId: defaultProject.id, executable: expectedPython, version: python.result.version, result: 10 }, null, 2), { flag: 'wx' });
await request('/api/auth/logout', 'POST', { audience: 'engineering' });
console.log('PASS fresh local administrator setup, isolated test credentials, authenticated health and actual bundled Python execution.');
