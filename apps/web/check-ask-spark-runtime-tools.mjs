import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const uri = value => `data:text/javascript;base64,${Buffer.from(value).toString('base64')}`;
const auth = uri('export const authSessionRevision=()=>globalThis.__askRuntimeRevision;');
const source = fs.readFileSync(new URL('src/askSparkRuntimeTools.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace(/from "\.\/authSession"/, `from ${JSON.stringify(auth)}`);
const { testRuntimeSession, signInRuntime, runtimeAuthenticatedFetch } = await import(uri(compiled));
const context = { projectId: 'fixture-project', currentUserId: 'same-user' };
const permissions = { design: true, view: true, operate: true, commands: true };
const account = audience => ({ audience, user: { id: 'same-user', username: 'verified-engineer' }, csrfToken: `${audience}-private-csrf`, project: { id: 'fixture-project' }, permissions: { ...permissions } });
let calls, engineering, operator, afterFetch, checks = 0;
const reset = () => { calls = []; engineering = account('engineering'); operator = account('operator'); afterFetch = undefined; globalThis.__askRuntimeRevision = 1; };
globalThis.fetch = async (path, init) => {
  const call = { path, ...init, body: init.body ? JSON.parse(init.body) : undefined }; calls.push(call);
  const value = path.startsWith('/api/auth/session?audience=engineering') ? engineering
    : path.startsWith('/api/auth/session?audience=operator') ? operator
      : path === '/api/auth/login' ? (operator = account('operator')) : { published: true };
  afterFetch?.(call);
  return Response.json(value);
};
const check = async (name, run) => { reset(); await run(); checks++; console.log(`PASS ${name}`); };

await check('Probe binds both audiences to the current engineering account and project without exposing CSRF', async () => {
  const result = await testRuntimeSession(context);
  assert.equal(result.available, true); assert.equal(result.projectId, context.projectId);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => !call.method));
  assert.ok(!JSON.stringify(result).includes('private-csrf'));
});

await check('Anonymous operator session produces an actionable probe result without signing in', async () => {
  operator = { ...operator, user: null, csrfToken: null, project: null };
  const result = await testRuntimeSession(context);
  assert.equal(result.available, false); assert.match(result.nextStep, /runtime_operator_sign_in/);
  assert.ok(calls.every(call => call.path !== '/api/auth/login'));
});

await check('A different operator account is neither used nor replaced', async () => {
  operator.user.id = 'another-user';
  await assert.rejects(testRuntimeSession(context), /Another account/);
  await assert.rejects(signInRuntime({}, { ...context, resolveSecret: async () => { throw new Error('Must not prompt'); } }), /Another account/);
  await assert.rejects(runtimeAuthenticatedFetch('/api/projects/fixture-project/runtime/project', {}, context, 'view'), /Another account/);
  assert.ok(calls.every(call => call.path !== '/api/auth/login' && !call.path.includes('/runtime/')));
});

await check('Engineering identity, design permission and exact project must remain current', async () => {
  await assert.rejects(testRuntimeSession({ projectId: 'fixture-project' }), /identity is unavailable/);
  await assert.rejects(testRuntimeSession({ ...context, projectId: '../other' }), /Select a project/);
  engineering.user.id = 'other-engineer';
  await assert.rejects(testRuntimeSession(context), /design permission/);
  engineering = account('engineering'); engineering.permissions.design = false;
  await assert.rejects(testRuntimeSession(context), /design permission/);
  engineering = account('engineering'); engineering.project.id = 'other-project';
  await assert.rejects(testRuntimeSession(context), /design permission/);
});

await check('Runtime requests retain exact scoped route, separate operator headers and private CSRF', async () => {
  const response = await runtimeAuthenticatedFetch('/api/projects/fixture-project/runtime/commands/speed/execute', { method: 'POST', body: JSON.stringify({ token: 'reviewed-token', confirmed: true }) }, context, 'command');
  assert.deepEqual(await response.json(), { published: true });
  const request = calls.at(-1), headers = new Headers(request.headers);
  assert.equal(headers.get('X-SPARK-AUDIENCE'), 'operator'); assert.equal(headers.get('X-SPARK-PROJECT'), 'fixture-project');
  assert.equal(headers.get('X-SPARK-CSRF'), 'operator-private-csrf'); assert.equal(request.credentials, 'same-origin'); assert.equal(request.redirect, 'error');
  assert.equal(headers.get('X-SPARK-EXPECTED-USER'), 'same-user');
  assert.deepEqual(request.body, { token: 'reviewed-token', confirmed: true });
});

await check('Runtime route and grant checks reject cross-project, arbitrary URL and missing permissions', async () => {
  for (const path of ['/api/projects/other-project/runtime/project', 'https://other.test/api/runtime/project', '/api/projects/fixture-project/connections'])
    await assert.rejects(runtimeAuthenticatedFetch(path, {}, context, 'view'), /permitted project runtime route/);
  assert.equal(calls.length, 0);
  operator.permissions.commands = false;
  await assert.rejects(runtimeAuthenticatedFetch('/api/projects/fixture-project/runtime/commands/speed/review', { method: 'POST' }, context, 'command'), /commands permission/);
  assert.ok(calls.every(call => !call.path.includes('/runtime/')));
  operator = account('operator'); operator.project.id = 'other-project';
  await assert.rejects(runtimeAuthenticatedFetch('/api/projects/fixture-project/runtime/project', {}, context, 'view'), /permission for this project/);
});

await check('Explicit sign-in uses a private password and verified engineering username, never model identity', async () => {
  operator = { ...operator, user: null, csrfToken: null, project: null };
  let purpose;
  const result = await signInRuntime({ secretHandle: 'opaque-handle' }, { ...context, resolveSecret: async (handle, next) => {
    assert.equal(handle, 'opaque-handle'); purpose = next; return { password: 'private-password', username: 'must-not-use' };
  } });
  const login = calls.find(call => call.path === '/api/auth/login');
  assert.equal(purpose, 'runtime-operator-sign-in');
  assert.deepEqual(login.body, { audience: 'operator', username: 'verified-engineer', password: 'private-password', projectId: 'fixture-project' });
  assert.equal(result.signedIn, true); assert.ok(!JSON.stringify(result).includes('password')); assert.ok(!JSON.stringify(result).includes('csrf'));
});

await check('An operator who signs in during the private dialog is not overwritten', async () => {
  operator = { ...operator, user: null, csrfToken: null, project: null };
  await assert.rejects(signInRuntime({}, { ...context, resolveSecret: async () => {
    operator = account('operator'); operator.user.id = 'other-person'; return { password: 'private-password' };
  } }), /Another account/);
  assert.ok(calls.every(call => call.path !== '/api/auth/login'));
});

await check('Engineering session changes during secure entry or fetch stop runtime use', async () => {
  operator = { ...operator, user: null, csrfToken: null, project: null };
  await assert.rejects(signInRuntime({}, { ...context, resolveSecret: async () => { globalThis.__askRuntimeRevision++; return { password: 'private-password' }; } }), /engineering session changed/);
  assert.ok(calls.every(call => call.path !== '/api/auth/login'));
  reset(); afterFetch = call => { if (call.path.includes('/runtime/')) globalThis.__askRuntimeRevision++; };
  await assert.rejects(runtimeAuthenticatedFetch('/api/projects/fixture-project/runtime/project', {}, context, 'view'), /engineering session changed/);
});

await check('Existing same-account operator session needs no credential prompt', async () => {
  const result = await signInRuntime({}, { ...context, resolveSecret: async () => { throw new Error('Must not prompt'); } });
  assert.equal(result.available, true); assert.ok(calls.every(call => call.path !== '/api/auth/login'));
});

console.log(`Ask Spark runtime tools: ${checks} checks passed.`);
