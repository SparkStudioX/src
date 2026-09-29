import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = stripTypeScriptTypes(await readFile(new URL('./src/previewRequest.ts', import.meta.url), 'utf8'));
const { setPreviewRequestContext, preparePreviewRequest } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const session = mode => ({ token: mode === 'read-only' ? 'a'.repeat(64) : 'b'.repeat(64), mode, expiresAt: new Date(Date.now() + 60000).toISOString() });
let passed = 0;
function check(name, run) { setPreviewRequestContext(null, false); run(); passed++; console.log(`PASS ${name}`); }
check('authoring requests retain their normal endpoint', () => {
  const request = preparePreviewRequest('/scripts/run'); assert.equal(request.path, '/scripts/run'); assert.deepEqual(request.headers, {}); request.assertCurrent(); request.finish();
});
check('starting preview fails closed without a capability', () => {
  setPreviewRequestContext(null); assert.throws(() => preparePreviewRequest('/scripts/run'), /unavailable/); assert.throws(() => preparePreviewRequest('/queries/rows/execute'), /unavailable/);
  assert.equal(preparePreviewRequest('/preview/sessions').path, '/preview/sessions');
});
check('read-only routes every script to the preview action boundary', () => {
  setPreviewRequestContext(session('read-only')); const request = preparePreviewRequest('/scripts/run'); assert.equal(request.path, '/preview/scripts/run'); assert.equal(request.headers['X-SPARK-PREVIEW'], 'a'.repeat(64)); request.finish();
});
check('query routing reaches the read-only gateway path', () => {
  setPreviewRequestContext(session('read-only')); const request = preparePreviewRequest('/queries/a%20b/execute'); assert.equal(request.path, '/preview/queries/a%20b/execute'); request.finish();
});
check('unrecognized mutations retain the capability for gateway rejection', () => {
  setPreviewRequestContext(session('live-actions'));
  for (const path of ['/project', '/tags', '/runtime/screens/main/components/table/table-edit', '/scripts/resources/handler/run']) {
    const request = preparePreviewRequest(path); assert.equal(request.path, path); assert.equal(request.headers['X-SPARK-PREVIEW'], 'b'.repeat(64)); request.finish();
  }
});
check('mode changes cancel all previous requests and reject late results', () => {
  setPreviewRequestContext(session('read-only')); const request = preparePreviewRequest('/queries/rows/execute'); setPreviewRequestContext(session('live-actions')); assert.equal(request.signal.aborted, true); assert.throws(() => request.assertCurrent(), /mode changed/); request.finish();
});
check('leaving preview cancels requests before authoring resumes', () => {
  setPreviewRequestContext(session('live-actions')); const request = preparePreviewRequest('/scripts/run'); setPreviewRequestContext(null, false); assert.equal(request.signal.aborted, true); assert.throws(() => request.assertCurrent(), /mode changed/); assert.deepEqual(preparePreviewRequest('/scripts/run').headers, {}); request.finish();
});
check('expired capabilities never fall through to unrestricted scripts', () => {
  setPreviewRequestContext({ ...session('live-actions'), expiresAt: new Date(0).toISOString() }); assert.throws(() => preparePreviewRequest('/scripts/run'), /expired/);
});
check('incoming cancellation aborts the preview request', () => {
  setPreviewRequestContext(session('read-only')); const controller = new AbortController(); const request = preparePreviewRequest('/tags', controller.signal); controller.abort(); assert.equal(request.signal.aborted, true); request.finish();
});
check('already-cancelled requests remain cancelled', () => {
  setPreviewRequestContext(session('read-only')); const controller = new AbortController(); controller.abort(); const request = preparePreviewRequest('/tags', controller.signal); assert.equal(request.signal.aborted, true); request.finish();
});
check('completed requests detach caller cancellation listeners', () => {
  setPreviewRequestContext(session('read-only')); const controller = new AbortController(); const request = preparePreviewRequest('/tags', controller.signal); request.finish(); controller.abort(); assert.equal(request.signal.aborted, false);
});
check('session control calls cannot inherit another preview capability', () => {
  setPreviewRequestContext(session('live-actions')); const request = preparePreviewRequest('/preview/sessions'); assert.deepEqual(request.headers, {}); request.finish();
});
setPreviewRequestContext(null, false);
console.log(`${passed} preview communication model checks passed.`);
