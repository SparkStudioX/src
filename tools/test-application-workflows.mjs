#!/usr/bin/env node
// Authenticated acceptance against the disposable combined 5093 fixture only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readZip } from './workshop-packages.mjs';

const authPath = path.resolve(process.env.SPARKSTUDIO_TEST_AUTH_FILE ?? 'missing');
assert.ok(authPath.startsWith(path.resolve('.data/test-evidence') + path.sep), 'Use disposable fixture credentials.');
const auth = JSON.parse(await fs.readFile(authPath, 'utf8')), base = new URL(auth.baseUrl);
assert.ok(base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.port === '5093');
const interactionId = auth.projects['component-interactions'], batchId = auth.projects['table-batch-workflow'];
assert.ok(interactionId && batchId, 'Start the combined browser fixture first.');
let admin, checks = 0; const suffix = randomUUID().slice(0, 8);
async function login(account, audience = 'engineering') {
  const response = await fetch(new URL('/api/auth/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...account, audience }) });
  assert.equal(response.status, 200); return { audience, csrf: (await response.json()).csrfToken, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
}
async function api(route, { method = 'GET', body, session = admin, status = 200, csrf = true, previewToken, binary = false, raw = false, withStatus = false } = {}) {
  const headers = new Headers({ Cookie: session.cookie, 'X-SPARK-AUDIENCE': session.audience });
  if (csrf) headers.set('X-SPARK-CSRF', session.csrf);
  if (previewToken) headers.set('X-SPARK-PREVIEW', previewToken);
  if (body !== undefined) headers.set('Content-Type', raw ? 'application/zip' : 'application/json');
  const response = await fetch(new URL('/api' + route, base), { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok((Array.isArray(status) ? status : [status]).includes(response.status), `${method} ${route}: ${response.status} ${bytes.toString().slice(0, 600)}`);
  const result = binary ? bytes : bytes.length ? JSON.parse(bytes) : null;
  return withStatus ? { status: response.status, result } : result;
}
const pass = text => { checks++; console.log(`PASS ${text}`); };
admin = await login(auth.admin);
const operatorAccount = { username: `workflow-operator-${suffix}`, password: randomUUID() + randomUUID() }, viewerAccount = { username: `workflow-viewer-${suffix}`, password: randomUUID() + randomUUID() };
for (const [account, operate] of [[operatorAccount, true], [viewerAccount, false]]) await api('/security/users', { method: 'POST', status: 201,
  body: { ...account, projectGrants: Object.fromEntries(Object.values(auth.projects).filter(Boolean).map(id => [id, { view: true, operate }])) } });
await fs.writeFile(path.join(path.dirname(authPath), 'workflow-role-auth.json'), JSON.stringify({ baseUrl: base.href, operator: operatorAccount, viewer: viewerAccount }, null, 2));
const operator = await login(operatorAccount, 'operator'), viewer = await login(viewerAccount, 'operator');
const route = (id, suffix) => `/projects/${id}${suffix}`;
const published = await api(route(interactionId, '/runtime/project'), { session: operator });
const modifiers = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
const doubleEvent = { type: 'doubleClick', componentId: 'pointer-pad', origin: 'user', button: 0, buttons: 0, clientX: 600, clientY: 220, ...modifiers };
const eventBody = { publishedAt: published.publishedAt, eventHandler: { family: 'interaction', type: 'doubleClick' }, event: doubleEvent, inputs: {}, parameters: {} };
const eventsRoute = route(interactionId, '/runtime/screens/interaction-lab/components/pointer-pad/events');
const send = (body = eventBody, options = {}) => api(eventsRoute, { method: 'POST', body, session: operator, ...options });
await send(eventBody, { session: viewer, status: 403 }); await send(eventBody, { csrf: false, status: 403 }); await send(eventBody, { session: admin, status: 401 });
await send({ ...eventBody, publishedAt: 'stale' }, { status: 409 });
await send({ ...eventBody, eventHandler: { family: 'interaction', type: 'click' } }, { status: 400 });
await send({ ...eventBody, event: { ...doubleEvent, actor: 'forged' } }, { status: 400 });
await send({ ...eventBody, code: 'result = True' }, { status: 400 });
pass('interaction API enforces Operate, audience, CSRF, saved selector, publication and payload authority');
for (const count of [3, 11]) {
  const screen = Object.fromEntries(Object.entries(published.screens[0].state).map(([key, value]) => [key, value.value])); screen.doubleClicks = count;
  const response = await send({ ...eventBody, ui: { state: { session: {}, screen }, properties: {} } });
  assert.equal(response.success, true); assert.equal(response.uiEffects.find(effect => effect.key === 'doubleClicks').value, count + 1);
}
const secretBody = { ...eventBody, eventHandler: { family: 'interaction', type: 'keyUp' }, event: { type: 'keyUp', componentId: 'secret', origin: 'user', key: '', code: '', repeat: false, isComposing: false, redacted: true, ...modifiers } };
const secretRoute = route(interactionId, '/runtime/screens/interaction-lab/components/secret/events');
assert.equal((await api(secretRoute, { method: 'POST', body: secretBody, session: operator })).success, true);
await api(secretRoute, { method: 'POST', body: { ...secretBody, event: { ...secretBody.event, key: 's' } }, session: operator, status: 400 });
await api(secretRoute, { method: 'POST', body: { ...secretBody, inputs: { secretSample: 'never log this' } }, session: operator, status: 400 });
pass('real Python interactions return receiving-session UI effects and reject password keys or input snapshots');
const readOnly = await api(route(interactionId, '/preview/sessions'), { method: 'POST', body: { mode: 'read-only' } });
const live = await api(route(interactionId, '/preview/sessions'), { method: 'POST', body: { mode: 'live-actions' } });
try {
  const previewBody = { ...eventBody }; delete previewBody.publishedAt;
  const previewRoute = route(interactionId, '/preview/screens/interaction-lab/components/pointer-pad/events');
  await api(previewRoute, { method: 'POST', body: previewBody, previewToken: readOnly.token, status: 403 });
  await api(previewRoute, { method: 'POST', body: previewBody, status: 403 });
  assert.equal((await api(previewRoute, { method: 'POST', body: previewBody, previewToken: live.token })).success, true);
} finally { for (const preview of [readOnly, live]) await api(route(interactionId, '/preview/session'), { method: 'DELETE', previewToken: preview.token, status: 204 }); }
const archive = await api(route(interactionId, '/export'), { binary: true }), exported = JSON.parse(readZip(archive).get('project.json'));
const imported = await api(`/projects/import?name=Interaction%20roundtrip%20${suffix}`, { method: 'POST', raw: true, body: archive });
assert.equal(imported.published, false); assert.deepEqual((await api(route(imported.id, '/project'))).screens, exported.screens);
pass('Live Preview capability and authored workshop export/unpublished re-import preserve interaction definitions');

let batchPublication = await api(route(batchId, '/runtime/project'), { session: operator });
const batchRoute = route(batchId, '/runtime/screens/table-batch/components/batch-table/table-edit');
const rows = async () => (await api(route(batchId, '/runtime/queries/batch-records/execute'), { method: 'POST', session: operator, body: { publishedAt: batchPublication.publishedAt, parameters: {} } })).rows;
const initial = await rows(); assert.ok(initial.length >= 2);
const cell = (row, column = 'quantity', value = 17) => ({ key: row.id, version: row.version, column, value });
const batch = (edits, options = {}) => api(batchRoute, { method: 'POST', session: operator, body: { publishedAt: batchPublication.publishedAt, edits, parameters: {} }, ...options });
await batch([cell(initial[0])], { session: viewer, status: 403 }); await batch([cell(initial[0])], { csrf: false, status: 403 });
await batch([cell(initial[0])], { session: admin, status: 401 });
const preview = await api(route(batchId, '/preview/sessions'), { method: 'POST', body: { mode: 'read-only' } });
try { await batch([cell(initial[0])], { previewToken: preview.token, status: 403 }); }
finally { await api(route(batchId, '/preview/session'), { method: 'DELETE', previewToken: preview.token, status: 204 }); }
for (const edits of [[], [cell(initial[0], 'quantity', -1)], [cell(initial[0], 'quantity', '17')], [cell(initial[0], 'version', 4)], [cell(initial[0]), cell(initial[0])], [cell(initial[0]), { ...cell(initial[1]), version: initial[1].version + 1 }], [cell(initial[0]), cell(initial[1], 'status', 'invalid')]]) await batch(edits, { status: [400, 409] });
assert.deepEqual(await rows(), initial);
pass('atomic batch API rejects unauthorized, Preview and malformed/stale requests without partial changes');
const oldStamp = batchPublication.publishedAt, reviewed = await api(route(batchId, '/project/publication-review'));
await api(route(batchId, '/project/publish'), { method: 'POST', body: reviewed }); batchPublication = await api(route(batchId, '/runtime/project'), { session: operator });
await batch([cell(initial[0])], { body: { publishedAt: oldStamp, edits: [cell(initial[0])], parameters: {} }, status: 409 });
const applied = await batch([cell(initial[0], 'quantity', 17), cell(initial[0], 'status', 'running'), cell(initial[1], 'quantity', 23)]);
assert.equal(applied.success, true); assert.deepEqual(applied.result, { rowsAffected: 2, cellsApplied: 3, atomic: true });
let changed = await rows(); assert.equal(changed[0].quantity, 17); assert.equal(changed[0].status, 'running'); assert.equal(changed[1].quantity, 23);
for (let index = 0; index < 2; index++) assert.equal(changed[index].version, initial[index].version + 1);
const contenders = await Promise.all([24, 25].map(value => batch([cell(changed[0], 'quantity', value)], { status: [200, 400, 409], withStatus: true })));
assert.equal(contenders.filter(item => item.status === 200).length, 1);
assert.match(contenders.find(item => item.status !== 200).result.error, /stale/i);
const current = await rows(); assert.equal(current[0].version, changed[0].version + 1);
await batch([cell(current[0], 'quantity', initial[0].quantity), cell(current[0], 'status', initial[0].status), cell(current[1], 'quantity', initial[1].quantity)]);
pass('one transaction commits all cells once per row; concurrent same-version requests serialize and reject the loser');
console.log(`PASS ${checks} authenticated application-workflow groups. Synthetic row values restored; versions retain verified commits.`);
