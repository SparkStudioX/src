import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const metadata = JSON.parse(fs.readFileSync(new URL('src/askSparkGatewayTools.json', import.meta.url), 'utf8'));
const source = fs.readFileSync(new URL('src/askSparkGatewayTools.ts', import.meta.url), 'utf8');
const uri = value => `data:text/javascript;base64,${Buffer.from(value).toString('base64')}`;
const preview = uri(ts.transpileModule(fs.readFileSync(new URL('src/previewRequest.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
const { setPreviewRequestContext } = await import(preview);
const auth = uri('export const authSessionRevision=()=>globalThis.__askGatewayAuthRevision;');
const navigation = uri(ts.transpileModule(fs.readFileSync(new URL('src/askSparkNavigation.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
const runtime = uri('export const runtimeAuthenticatedFetch=(path,init,context,grant)=>globalThis.__askGatewayFetch(path,{...init,operatorGrant:grant}); export const testRuntimeSession=async()=>({available:true}); export const signInRuntime=async()=>({signedIn:true});');
const api = uri(`
export class ApiError extends Error { constructor(message,status){super(message);this.status=status} }
export function apiUrl(path,projectId=null){ const scoped=/^\\/(?:project|queries|scripts|assets|runtime|preview|alarms|alarm-journal|history)(?:\\/|\\?|$)/.test(path);return scoped&&projectId?'/api/projects/'+encodeURIComponent(projectId)+path:'/api'+path; }
export const authenticatedFetch=(...args)=>globalThis.__askGatewayFetch(...args);
export const assertAuthResponseCurrent=response=>globalThis.__askGatewayCurrent(response);
`);
// Model drafts use the same merge/preview code as the Models page, so load the real modules.
const requireFromHere = createRequire(import.meta.url), loaded = new Map([['api', api], ['react', uri('export const useState=()=>{throw new Error("hooks are not used here")};')]]);
function load(name) {
  if (loaded.has(name)) return loaded.get(name);
  if (name.endsWith('.json')) { const json = uri('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8') + ';'); loaded.set(name, json); return json; }
  const file = ['ts', 'tsx'].map(extension => new URL('src/' + name + '.' + extension, import.meta.url)).find(path => fs.existsSync(path));
  assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/from (["'])([^"']+)\1/g, (_match, _quote, dependency) => 'from ' + JSON.stringify(dependency === 'react' ? loaded.get('react') : dependency.startsWith('./') ? load(dependency.slice(2)) : pathToFileURL(requireFromHere.resolve(dependency)).href));
  const result = uri(code); loaded.set(name, result); return result;
}
const sessionValues = new Map();
globalThis.sessionStorage = { getItem: key => sessionValues.get(key) ?? null, setItem: (key, value) => sessionValues.set(key, String(value)), removeItem: key => sessionValues.delete(key) };
globalThis.window ??= { dispatchEvent: () => true };
const modelWorkspace = load('modelWorkspace'), modelDraft = load('modelDraft');
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace(/import declarations from "\.\/askSparkGatewayTools.json";/, `const declarations=${JSON.stringify(metadata)};`)
  .replace(/from "\.\/api"/, `from ${JSON.stringify(api)}`)
  .replace(/from "\.\/previewRequest"/, `from ${JSON.stringify(preview)}`)
  .replace(/from "\.\/authSession"/, `from ${JSON.stringify(auth)}`)
  .replace(/from "\.\/askSparkNavigation"/, `from ${JSON.stringify(navigation)}`)
  .replace(/from "\.\/askSparkRuntimeTools"/, `from ${JSON.stringify(runtime)}`)
  .replace(/import\("\.\/modelWorkspace"\)/g, `import(${JSON.stringify(modelWorkspace)})`)
  .replace(/import\("\.\/modelDraft"\)/g, `import(${JSON.stringify(modelDraft)})`);
const { executeGatewayTool, supportsGatewayTool } = await import(uri(output));
const context = { projectId: 'fixture-project' };
let calls = [], respond, checks = 0;
globalThis.__askGatewayCurrent = () => {};
globalThis.__askGatewayAuthRevision = 0;
globalThis.__askGatewayFetch = async (url, options = {}) => {
  const call = { url, ...options, body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body };
  calls.push(call);
  const answer = await respond(call);
  return answer instanceof Response ? answer : Response.json(answer ?? null);
};
const run = (name, args = {}, nextContext = context, signal) => executeGatewayTool(name, args, nextContext, signal);
const fixture = callback => { calls = []; respond = callback; globalThis.__askGatewayCurrent = () => {}; setPreviewRequestContext(null, false); };
const check = async (name, callback) => { fixture(() => { throw new Error('Unexpected request'); }); await callback(); checks++; console.log(`PASS ${name}`); };

await check('Every declared tool has one executable handler and bounded parameter metadata', async () => {
  assert.equal(new Set(metadata.map(tool => tool.name)).size, metadata.length);
  assert.ok(metadata.length >= 120);
  for (const tool of metadata) {
    assert.equal(supportsGatewayTool(tool.name), true, tool.name);
    assert.equal(tool.parameters.additionalProperties, false, tool.name);
    assert.ok(['read', 'draft', 'write', 'destructive'].includes(tool.kind));
    assert.equal(typeof tool.confirmation, 'boolean');
    assert.equal(typeof tool.parallelSafe, 'boolean');
    assert.equal(tool.target, 'gateway');
    assert.equal(Object.hasOwn(tool.parameters.properties, 'resultPath'), tool.kind === 'read', tool.name);
  }
  assert.equal(supportsGatewayTool('request_url'), false);
  assert.equal(supportsGatewayTool('__proto__'), false);
});

await check('Unknown tools, extra fields, missing revisions and path injection fail before HTTP', async () => {
  await assert.rejects(run('fetch', { url: 'https://example.test' }), /Unknown gateway tool/);
  await assert.rejects(run('connections_get', { id: 'safe', method: 'DELETE' }), /not supported/);
  await assert.rejects(run('connections_delete', { id: 'safe' }), /revision is required/);
  await assert.rejects(run('connections_delete', { id: '../projects', revision: 1 }), /invalid format/);
  await assert.rejects(run('connections_delete', { id: 'safe', revision: '1' }), /must have type/);
  await assert.rejects(run('connections_delete', { id: 'safe', revision: 1.5 }), /safe integer/);
  await assert.rejects(run('gateway_overview', JSON.parse('{"__proto__":{}}')), /forbidden field/);
  assert.equal(calls.length, 0);
});

await check('Workspace navigation returns only fixed local links and never fetches or navigates', async () => {
  const ai = await run('navigate_workspace', { destination: 'ai' }); assert.equal(ai.data.url, '/gateway#ai'); assert.equal(ai.data.navigated, false); assert.equal(ai.data.status, 'awaiting_user_navigation');
  const scripts = await run('navigate_workspace', { destination: 'scripts' }); assert.equal(scripts.data.url, '/designer/fixture-project'); assert.match(scripts.data.nextStep, /Scripts/); assert.match(scripts.data.guidance, /unsaved drafts remain/);
  const explicit = await run('navigate_workspace', { destination: 'designer', projectId: 'another-project' }); assert.equal(explicit.data.url, '/designer/another-project');
  const data = await run('navigate_workspace', { destination: 'data' }); assert.equal(data.data.url, '/gateway#data'); assert.equal(data.data.label, 'Gateway data');
  const connections = await run('navigate_workspace', { destination: 'connections' }); assert.equal(connections.data.url, '/gateway#data/connections'); assert.equal(connections.data.nextStep, undefined);
  const certificates = await run('navigate_workspace', { destination: 'certificates' }); assert.equal(certificates.data.url, '/gateway#data/certificates'); assert.equal(certificates.data.nextStep, undefined);
  const models = await run('navigate_workspace', { destination: 'models' }); assert.equal(models.data.url, '/workspace?workspace=models&view=plant');
  const model = await run('navigate_workspace', { destination: 'model', modelKey: 'Press@2' }); assert.equal(model.data.url, '/workspace?workspace=models&view=models&type=Press%402');
  const machine = await run('navigate_workspace', { destination: 'machine', path: '[default]Acme/Line1/Press01' }); assert.equal(machine.data.url, '/workspace?workspace=models&view=plant&item=%5Bdefault%5DAcme%2FLine1%2FPress01&kind=machine');
  const location = await run('navigate_workspace', { destination: 'location', path: '[default]Acme' }); assert.equal(location.data.url, '/workspace?workspace=models&view=plant&item=%5Bdefault%5DAcme&kind=location');
  const tools = await run('navigate_workspace', { destination: 'model-tools', tool: 'publish' }); assert.equal(tools.data.url, '/workspace?workspace=models&view=tools&tool=publish');
  await assert.rejects(run('navigate_workspace', { destination: 'model', modelKey: 'Press' }), /format|ModelId@version/);
  await assert.rejects(run('navigate_workspace', { destination: 'machine', path: 'no-provider' }), /format|full machine path/);
  const tags = await run('navigate_workspace', { destination: 'tags' }); assert.equal(tags.data.url, '/workspace?workspace=tags');
  await assert.rejects(run('navigate_workspace', { destination: 'https://example.test' }), /not a supported value/);
  await assert.rejects(run('navigate_workspace', { destination: 'configuration' }), /not a supported value/);
  await assert.rejects(run('navigate_workspace', { destination: 'designer' }, {}), /explicit project/);
  await assert.rejects(run('navigate_workspace', { destination: 'designer', projectId: '../other' }), /invalid format/);
  await assert.rejects(run('navigate_workspace', { destination: 'ai', url: '/api/anything' }), /not supported/);
  assert.equal(calls.length, 0);
});

await check('Project scope is explicit and cannot fall back to the active page', async () => {
  await assert.rejects(run('project_get', {}, {}), /explicit project/);
  await assert.rejects(run('project_get', {}, { projectId: '../other' }), /explicit project/);
  fixture(() => ({ id: 'fixture-project', revision: 4 }));
  await run('project_get');
  assert.equal(calls[0].url, '/api/projects/fixture-project/project');
  await run('connections_list');
  assert.equal(calls[1].url, '/api/connections');
  await run('tags_read', { paths: ['[default]Fixture'] });
  assert.equal(calls[2].url, '/api/projects/fixture-project/tags/read', 'Tag reads use the requested project scope rather than an ambient session header');
});

await check('Read pagination never silently skips rows when a model requests a large page', async () => {
  fixture(() => Array.from({ length: 505 }, (_, index) => ({ id: index })));
  const first = await run('connections_list', { offset: 0, limit: 12000 });
  assert.equal(first.data.length, 200); assert.equal(first.nextOffset, 200); assert.equal(first.total, 505);
  const second = await run('connections_list', { offset: first.nextOffset, limit: 200 });
  assert.equal(second.data[0].id, 200); assert.equal(second.nextOffset, 400);
});

await check('Read lists default to twenty-five with exact counts, continuation and an explicit narrowing hint', async () => {
  fixture(() => Array.from({ length: 140 }, (_, id) => ({ id })));
  const result = await run('connections_list');
  assert.equal(result.data.length, 25); assert.equal(result.returnedCount, 25); assert.equal(result.total, 140); assert.equal(result.nextOffset, 25); assert.equal(result.showing, 'Showing 25 of 140 items.'); assert.equal(result.truncated, true); assert.match(result.filterHint, /filter.*resultPath.*offset/);
  const last = await run('connections_list', { offset: 125 }); assert.equal(last.returnedCount, 15); assert.equal(last.nextOffset, null); assert.equal(last.truncated, false);
});

await check('A byte-heavy row omitted by the output budget is the first row of the next page', async () => {
  fixture(() => Array.from({ length: 12 }, (_, id) => ({ id, text: 'x'.repeat(10000) })));
  const first = await run('connections_list'); assert.ok(first.returnedCount < 12); assert.equal(first.returnedCount, first.data.length); assert.equal(first.nextOffset, first.returnedCount);
  const second = await run('connections_list', { offset: first.nextOffset }); assert.equal(second.data[0].id, first.returnedCount); assert.equal(second.nextOffset, null);
});

await check('Nested lists report bounded counts and an escaped JSON Pointer for retrieving remaining rows', async () => {
  fixture(() => [{ id: 'sensor', 'points/with~name': Array.from({ length: 140 }, (_, id) => ({ id })) }]);
  const first = await run('connections_get', { id: 'sensor' }); assert.equal(first.data['points/with~name'].length, 25); assert.deepEqual(first.truncatedLists, [{ path: '/points~1with~0name', total: 140, returnedCount: 25, nextOffset: 25 }]);
  const next = await run('connections_get', { id: 'sensor', resultPath: '/points~1with~0name', offset: 25 }); assert.equal(next.data[0].id, 25); assert.equal(next.returnedCount, 25); assert.equal(next.total, 140);
});

await check('Result projection is rejected before direct mutation dispatch or any HTTP request', async () => {
  await assert.rejects(run('scripts_run_code', { code: 'perform_side_effect()', parameters: {}, inputs: {}, resultPath: '/missing' }), /only available for read tools.*No operation was performed/);
  await assert.rejects(run('connections_delete', { id: 'safe', revision: 1, resultPath: '' }), /only available for read tools/);
  await assert.rejects(run('commands_execute', { id: 'speed', token: 'review-token', confirmed: true, resultPath: '/message' }), /only available for read tools/);
  assert.equal(calls.length, 0);
});

await check('HTTP-success bodies reporting failed scripts produce failed receipts without automatic retry', async () => {
  fixture(() => ({ success: false, stdout: 'one action ran', stderr: 'Script exceeded its timeout; password=hidden', durationMs: 1000 }));
  const result = await run('scripts_run_code', { code: 'perform_side_effect()', parameters: {}, inputs: {} });
  assert.equal(calls.length, 1);
  assert.match(result.error, /exceeded its timeout/);
  assert.ok(!result.error.includes('hidden'));
  assert.equal(result.outcome, 'failed');
  assert.equal(result.effectsMayHaveOccurred, true);
  assert.equal(result.retryAutomatically, false);
  assert.match(result.guidance, /Inspect authoritative state/);
  assert.equal(result.data.success, false);
  assert.equal(result.data.stdout, 'one action ran');
});

await check('Uncertain and unconfirmed physical outcomes cannot appear completed or invite automatic retries', async () => {
  for (const status of ['uncertain', 'notConfirmed', 'interrupted', 'unknown']) {
    fixture(() => ({ status, message: 'Readback unavailable', correlationId: 'command-receipt' }));
    const result = await run('commands_execute', { id: 'speed', token: 'review-token', confirmed: true });
    assert.equal(result.error, 'Readback unavailable');
    assert.equal(result.outcome, 'uncertain');
    assert.equal(result.effectsMayHaveOccurred, true);
    assert.equal(result.retryAutomatically, false);
    assert.equal(result.data.status, status);
    assert.equal(calls.length, 1);
  }
  fixture(() => ({ status: 'confirmed', message: 'Readback matched', correlationId: 'command-receipt' }));
  const confirmed = await run('commands_execute', { id: 'speed', token: 'review-token', confirmed: true });
  assert.equal(Object.hasOwn(confirmed, 'error'), false);
  assert.equal(confirmed.data.status, 'confirmed');
});

await check('Read result projection preserves explicit failures and diagnostic statuses remain successful data', async () => {
  fixture(() => ({ success: false, error: 'Payload cannot be decoded', detail: { sample: 'bad' } }));
  const result = await run('mqtt_test_payload', { id: 'mqtt', revision: 1, topic: 'plant/value', payload: 'bad', resultPath: '/detail' });
  assert.equal(result.error, 'Payload cannot be decoded');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.effectsMayHaveOccurred, false);
  assert.equal(result.retryAutomatically, false);
  assert.deepEqual(result.data, { sample: 'bad' });
  for (const status of ['unknown', 'failed', 'uncertain']) {
    fixture(() => ({ status, message: 'Observed component status' }));
    const diagnostic = await run('gateway_overview');
    assert.equal(Object.hasOwn(diagnostic, 'error'), false);
    assert.equal(diagnostic.data.status, status);
  }
});

await check('Nested resultPath cannot bypass credential redaction and long text can be paged', async () => {
  fixture(() => [{ id: 'sensor', password: 'never-chat', hasPassword: true, source: { authentication: { token: 'never-chat', client_secret: 'never-chat', refresh_token: 'never-chat', privateKeyReference: 'tls-key-reference' } }, description: 'Bearer opaque-secret-value', code: 'x'.repeat(15000) }]);
  const full = await run('connections_get', { id: 'sensor' });
  assert.equal(full.data.password, '[redacted]'); assert.equal(full.data.hasPassword, true);
  assert.equal(full.data.source.authentication.token, '[redacted]');
  assert.equal(full.data.source.authentication.client_secret, '[redacted]');
  assert.equal(full.data.source.authentication.refresh_token, '[redacted]');
  assert.equal(full.data.source.authentication.privateKeyReference, 'tls-key-reference');
  assert.equal(full.data.description, 'Bearer [redacted]'); assert.equal(full.truncated, true);
  const secret = await run('connections_get', { id: 'sensor', resultPath: '/password', limit: 1000 });
  assert.equal(secret.data, '[redacted]');
  const code = await run('connections_get', { id: 'sensor', resultPath: '/code', offset: 12000, limit: 12000 });
  assert.equal(code.data.length, 3000); assert.equal(code.nextOffset, null);
  await assert.rejects(run('connections_get', { id: 'sensor', resultPath: '/constructor' }), /does not exist/);
});

await check('Stale auth, aborted requests and HTTP authorization failures cannot produce successful tool results', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run('connections_list', {}, context, controller.signal), /abort/i);
  assert.equal(calls.length, 0);
  fixture(() => []); globalThis.__askGatewayCurrent = () => { throw new Error('Session changed'); };
  await assert.rejects(run('connections_list'), /Session changed/);
  fixture(() => Response.json({ error: 'Permission denied' }, { status: 403 }));
  await assert.rejects(run('connections_list'), error => error.status === 403 && error.message === 'Permission denied');
});

await check('Response byte limits reject oversized observations before parsing', async () => {
  fixture(() => new Response('[]', { headers: { 'content-length': String(20 * 1024 * 1024) } }));
  await assert.rejects(run('connections_list'), /too large/);
});

await check('Designer preview policy follows the same headers, mapped read-only routes and generation fence as manual UI', async () => {
  fixture(call => call.body);
  setPreviewRequestContext({ token: 'preview-capability', mode: 'read-only', expiresAt: new Date(Date.now() + 60000).toISOString() });
  await run('queries_execute', { id: 'machines', parameters: {} });
  assert.equal(calls[0].url, '/api/projects/fixture-project/preview/queries/machines/execute');
  assert.equal(calls[0].headers['X-SPARK-PREVIEW'], 'preview-capability');
  await run('connections_delete', { id: 'test', revision: 3 });
  assert.equal(calls[1].headers['X-SPARK-PREVIEW'], 'preview-capability', 'Server preview policy sees and rejects non-preview mutations');
  setPreviewRequestContext(null);
  await assert.rejects(run('connections_list'), /preview session is unavailable/);
});

await check('Connection edits preserve unrelated settings and refuse stale revisions', async () => {
  const saved = { id: 'plc', revision: 7, name: 'Fixture PLC', type: 'modbus-tcp', enabled: true, device: { host: '127.0.0.1', port: 502, points: [] } };
  fixture(call => call.method === 'GET' ? [saved] : call.body);
  await assert.rejects(run('connections_set_enabled', { id: 'plc', revision: 6, enabled: false }), /resource changed/);
  assert.equal(calls.length, 1);
  await run('connections_set_enabled', { id: 'plc', revision: 7, enabled: false });
  assert.deepEqual(calls.at(-1).body, { ...saved, enabled: false });
  await run('points_configure', { id: 'plc', revision: 7, settings: { timeoutMs: 3000 } });
  assert.deepEqual(calls.at(-1).body.device, { ...saved.device, timeoutMs: 3000 });
});

await check('Raw credentials are rejected while secure credentials stay in the authenticated request only', async () => {
  await assert.rejects(run('connections_save', { connection: { id: 'x', name: 'X', type: 'opcua', password: 'secret' } }), /not supported/);
  await assert.rejects(run('connections_save', { connection: { id: 'x', name: 'X', type: 'mqtt', source: { authentication: { mode: 'bearer', token: 'secret' } } } }), /not supported/);
  fixture(call => call.method === 'GET' ? [{ id: 'source', revision: 2, name: 'Source', type: 'i3x', source: { endpoint: 'http://localhost', authentication: { mode: 'bearer', hasToken: false } } }] : call.body);
  let asked;
  const result = await run('connections_set_credentials', { id: 'source', revision: 2 }, { ...context, resolveSecret: async (handle, purpose) => { asked = { handle, purpose }; return { token: 'secure-dialog-value' }; } });
  assert.deepEqual(asked, { handle: undefined, purpose: 'source-connection' });
  assert.equal(calls.at(-1).body.source.authentication.token, 'secure-dialog-value');
  assert.equal(result.data.source.authentication.token, '[redacted]');
});

await check('User creation obtains password outside model arguments and updates keep supplied revision', async () => {
  fixture(call => call.body);
  const args = { username: 'fixture-user', gatewayAdmin: false, disabled: false, projectGrants: { 'fixture-project': { view: true } }, gatewayCapabilities: {} };
  const result = await run('users_create', args, { ...context, resolveSecret: async (_handle, purpose) => { assert.equal(purpose, 'create-user'); return { password: 'secure-user-password' }; } });
  assert.equal(calls[0].url, '/api/security/users'); assert.equal(calls[0].body.password, 'secure-user-password');
  assert.equal(result.data.password, '[redacted]');
  await run('users_update', { ...args, id: 'user', revision: 4, displayName: 'Fixture' });
  assert.equal(calls.at(-1).body.revision, 4); assert.equal('password' in calls.at(-1).body, false);
});

await check('A session change during secure entry cannot submit credentials using another account', async () => {
  const args = { username: 'fixture-user', gatewayAdmin: false, disabled: false, projectGrants: {}, gatewayCapabilities: {} };
  await assert.rejects(run('users_create', args, { ...context, resolveSecret: async () => {
    globalThis.__askGatewayAuthRevision++;
    return { password: 'stale-dialog-password' };
  } }), /signed-in session changed/);
  assert.equal(calls.length, 0);
});

await check('MQTT mapping edits retain sibling mappings and carry migration acknowledgment', async () => {
  const old = { id: 'old', topicFilter: 'old/#', root: '[default]Old', tags: 'review', payload: 'scalar' };
  fixture(call => call.method === 'GET' ? [{ id: 'mqtt', revision: 3, type: 'mqtt', source: { mqtt: { mappings: [old] } } }] : call.body);
  await run('mqtt_mapping_save', { id: 'mqtt', revision: 3, mapping: { ...old, id: 'new', topicFilter: 'new/#' }, sourceMigrationToken: 'reviewed-migration' });
  assert.equal(calls.at(-1).body.source.mqtt.mappings.length, 2);
  assert.equal(calls.at(-1).body.sourceMigrationToken, 'reviewed-migration');
});

await check('Partial source configuration preserves nested transport and authentication settings', async () => {
  fixture(call => call.method === 'GET' ? [{ id: 'mqtt', revision: 4, type: 'mqtt', source: { endpoint: 'mqtt://localhost', mqtt: { transport: 'tls', protocolVersion: '5', keepAliveSeconds: 30, mappings: [] } } }] : call.body);
  await run('source_configure', { id: 'mqtt', revision: 4, settings: { mqtt: { keepAliveSeconds: 60 } } });
  assert.deepEqual(calls.at(-1).body.source.mqtt, { transport: 'tls', protocolVersion: '5', keepAliveSeconds: 60, mappings: [] });
});

await check('Model previews remain read-only while direct tag imports carry exact review tokens', async () => {
  fixture(call => call.url.endsWith('/preview') ? { revision: 'model-r7', previewToken: 'review-token', canApply: true } : call.body);
  const preview = await run('udts_instances_preview', { items: [{ path: '[default]Pumps/P1', definitionId: 'Pump', version: 1, overrides: {} }] });
  const package_ = preview.data.package;
  assert.deepEqual(package_.tags, []); assert.deepEqual(package_.scanGroups, []); assert.deepEqual(package_.udtDefinitions, []);
  assert.equal(package_.instances[0].definitionId, 'Pump');
  const before = calls.length;
  await assert.rejects(run('tags_import_apply', { package: package_, revision: 'model-r7', previewToken: 'review-token' }), /reviewed and applied by the user/);
  assert.equal(calls.length, before, 'A confirmed UDT preview cannot bypass manual Model review');
  for (const modelChange of [{ hierarchy: [{ path: '[default]Acme', level: 'Enterprise' }] }, { removeHierarchy: ['[default]Acme'] }]) {
    await assert.rejects(run('tags_import_apply', { package: { ...package_, instances: [], ...modelChange }, revision: 'model-r7', previewToken: 'review-token' }), /reviewed and applied by the user/);
  }
  assert.equal(calls.length, before, 'Hierarchy additions and removals require manual Model review');
  const direct = { ...package_, instances: [], tags: [{ path: '[default]Fixture', kind: 'memory', dataType: 'Double', value: 1 }] };
  await run('tags_import_apply', { package: direct, revision: 'model-r7', previewToken: 'review-token' });
  assert.deepEqual(calls.at(-1).body.package, direct); assert.equal(calls.at(-1).body.previewToken, 'review-token');
  const provider = await run('provider_preview', { enabled: false });
  assert.deepEqual(provider.data.package.provider, { name: 'default', enabled: false });
  assert.equal(provider.data.review.previewToken, 'review-token');
});

await check('provider enablement review omits hierarchy policy and cannot approve policy changes', async () => {
  fixture(call => call.url.endsWith('/preview') ? { revision: 'provider-r8', previewToken: 'provider-token', canApply: true } : call.body);
  const preview = await run('provider_preview', { enabled: false });
  const package_ = preview.data.package;
  assert.deepEqual(package_.provider, { name: 'default', enabled: false }, 'An omitted hierarchy policy is preserved by the gateway merge');
  await run('tags_import_apply', { package: package_, revision: 'provider-r8', previewToken: 'provider-token' });
  assert.deepEqual(calls.at(-1).body.package.provider, { name: 'default', enabled: false });
  const before = calls.length;
  for (const requireDeclaredHierarchy of [false, true]) {
    await assert.rejects(run('tags_import_apply', { package: { ...package_, provider: { ...package_.provider, requireDeclaredHierarchy } }, revision: 'provider-r8', previewToken: 'provider-token' }), /requireDeclaredHierarchy is not supported|reviewed and applied by the user/);
  }
  assert.equal(calls.length, before, 'Both explicit policy values require the user-controlled Model workspace');
});

await check('Model reads use explicit project scopes and separate server paging from result projection', async () => {
  fixture(() => ({ generation: 3, items: [], total: 0, nextOffset: null }));
  await run('model_instances', { type: 'CNC', version: 2, under: '[default]Acme', pageOffset: 200, pageSize: 50 });
  const url = new URL(calls[0].url, 'https://fixture.invalid');
  assert.equal(url.pathname, '/api/projects/fixture-project/model/instances');
  assert.equal(url.searchParams.get('offset'), '200'); assert.equal(url.searchParams.get('limit'), '50');
  assert.equal(url.searchParams.get('type'), 'CNC'); assert.equal(url.searchParams.get('under'), '[default]Acme');
  await run('model_tree', { path: '[default]Acme', depth: 2 });
  assert.equal(new URL(calls[1].url, 'https://fixture.invalid').searchParams.get('limit'), '25');
  await run('model_object', { path: '[default]Acme/CNC01' });
  assert.equal(new URL(calls[2].url, 'https://fixture.invalid').pathname, '/api/projects/fixture-project/model/object');
  await assert.rejects(run('model_types', {}, { projectId: '../other' }), /explicit project/);
  assert.equal(calls.length, 3, 'An invalid explicit project cannot fall back to gateway scope');
});

await check('Projectless Models can read every model resource without inventing a project scope', async () => {
  fixture(() => ({ generation: 3, items: [], total: 0 }));
  for (const nextContext of [{}, { projectId: null, section: 'models' }]) {
    await run('model_types', { type: 'CNC', pageOffset: 100, pageSize: 50 }, nextContext);
    await run('model_tree', { path: '[default]Acme', depth: 2 }, nextContext);
    await run('model_instances', { type: 'CNC', under: '[default]Acme' }, nextContext);
    await run('model_object', { path: '[default]Acme/CNC01' }, nextContext);
  }
  assert.deepEqual(calls.map(call => new URL(call.url, 'https://fixture.invalid').pathname),
    ['types', 'tree', 'instances', 'object', 'types', 'tree', 'instances', 'object'].map(resource => `/api/model/${resource}`));
  assert.ok(calls.every(call => call.method === 'GET'));
  const page = new URL(calls[0].url, 'https://fixture.invalid');
  assert.equal(page.searchParams.get('offset'), '100'); assert.equal(page.searchParams.get('limit'), '50');
  assert.equal(page.searchParams.get('type'), 'CNC');
  assert.equal(new URL(calls[3].url, 'https://fixture.invalid').searchParams.get('path'), '[default]Acme/CNC01');
  fixture(() => Response.json({ message: 'Configuration permission required' }, { status: 403 }));
  await assert.rejects(run('model_types', {}, {}), /Configuration permission required/);
  assert.equal(calls.length, 1, 'Denied gateway reads must not retry through another scope');
});

const savedModel = { format: 'sparkstudio.tags', version: 3, tags: [], scanGroups: [], udtDefinitions: [{ id: 'Press', version: 1, parameters: [], members: [{ path: 'Speed', kind: 'memory', dataType: 'Double', value: 0 }] }],
  hierarchy: [{ path: '[default]Acme', level: 'Enterprise' }, { path: '[default]Acme/Line1', level: 'Line' }, { path: '[default]Acme/Line2', level: 'Line' }],
  instances: [{ path: '[default]Acme/Line1/Press01', definitionId: 'Press', version: 1, parameters: {}, overrides: {} }] };
const handoff = () => { const text = sessionStorage.getItem('sparkstudio.model-draft'); sessionStorage.removeItem('sparkstudio.model-draft'); return text ? JSON.parse(text) : undefined; };
const modelFixture = preview => fixture(call => call.url === '/api/tag-engineering/export' ? structuredClone(savedModel) : preview(call));

await check('Model drafts only preview and preserve a user-owned browser handoff after current authorization', async () => {
  const definition = { id: 'CNC', version: 1, members: [{ path: 'Value', kind: 'memory', dataType: 'Double', value: 0 }] };
  const args = { definitionJson: JSON.stringify(definition) }, signed = { ...context, ownerId: 'fixture-user' };
  await assert.rejects(run('model_draft', args), /signed-in engineering user/);
  modelFixture(() => ({ canApply: true, revision: 'model-r1', previewToken: 'preview-only' }));
  const result = await run('model_draft', args, signed);
  assert.equal(result.data.applied, false); assert.equal(result.data.status, 'draft_prepared');
  assert.equal(result.data.url, '/workspace?workspace=models&view=models&type=CNC%401');
  assert.deepEqual(handoff(), { ownerId: 'fixture-user', draft: { origin: 'ask-spark', definition } });
  assert.deepEqual(calls.map(call => call.url), ['/api/tag-engineering/export', '/api/tag-engineering/preview']);
  assert.equal(calls[1].body.version, 3); assert.deepEqual(calls[1].body.udtDefinitions, [definition]);
  modelFixture(() => { globalThis.__askGatewayAuthRevision++; return { canApply: true }; });
  await assert.rejects(run('model_draft', args, signed), /session|account|changed/i);
  assert.equal(handoff(), undefined, 'A stale account response cannot open another user’s draft');
});

await check('Model drafts combine types, machines, locations, renames and moves and never overwrite a version', async () => {
  const signed = { ...context, ownerId: 'fixture-user' };
  const package_ = { udtDefinitions: [{ id: 'Spindle', version: 1, parameters: [], members: [{ path: 'Load', kind: 'memory', dataType: 'Double', value: 0 }] },
    { id: 'Lathe', version: 1, parameters: [], members: [{ path: 'Spindle', kind: 'type', definitionId: 'Spindle', version: 1 }] }],
    hierarchy: [{ path: '[default]Acme/Line3', level: 'Line' }],
    instances: [{ path: '[default]Acme/Line3/Lathe01', definitionId: 'Lathe', version: 1, parameters: {}, overrides: {} }] };
  modelFixture(call => ({ canApply: true, received: call.body }));
  const result = await run('model_draft', { packageJson: JSON.stringify(package_), locationRenames: [{ path: '[default]Acme/Line2', name: 'Packing' }],
    moves: [{ paths: ['[default]Acme/Line1/Press01'], destination: '[default]Acme/Line3' }] }, signed);
  const sent = calls.at(-1).body;
  assert.deepEqual(sent.udtDefinitions.map(item => item.id + '@' + item.version), ['Spindle@1', 'Lathe@1']);
  assert.deepEqual(sent.hierarchy.map(item => item.path).sort(), ['[default]Acme/Line3', '[default]Acme/Packing']);
  assert.deepEqual(sent.removeHierarchy, ['[default]Acme/Line2']);
  assert.deepEqual(sent.instances.map(item => item.path).sort(), ['[default]Acme/Line3/Lathe01', '[default]Acme/Line3/Press01']);
  assert.deepEqual(sent.removeInstances, ['[default]Acme/Line1/Press01']);
  assert.match(result.data.summary, /2 models/); assert.ok(result.data.changeCount >= 6);
  assert.equal(result.data.url, '/workspace?workspace=models&view=models&type=Spindle%401');
  assert.equal(handoff().draft.moves[0].destination, '[default]Acme/Line3');
  modelFixture(() => ({ canApply: true }));
  await assert.rejects(run('model_draft', { packageJson: JSON.stringify({ udtDefinitions: [savedModel.udtDefinitions[0]] }) }, signed), /already exist.*immutable/);
  await assert.rejects(run('model_draft', { packageJson: JSON.stringify({ removeUdtDefinitions: ['Press@1'] }) }, signed), /cannot remove model versions/);
  await assert.rejects(run('model_draft', { moves: [{ paths: ['[default]Acme/Line1/Press01'], destination: '[default]Nowhere' }] }, signed), /destination/);
  await assert.rejects(run('model_draft', {}, signed), /Provide a definition/);
  assert.equal(handoff(), undefined, 'Rejected proposals never reach the Models draft');
});

await check('Model draft reader reports the tab draft and an unopened proposal without gateway calls', async () => {
  fixture(() => { throw new Error('No gateway request expected'); });
  const signed = { ...context, ownerId: 'fixture-user' };
  let draft = await run('model_draft_get', {}, signed);
  assert.equal(draft.data.hasDraft, false); assert.equal(draft.data.pendingAssistantProposal, false);
  sessionStorage.setItem('sparkstudio.model-workspace.fixture-user', JSON.stringify({ schema: 1, ownerId: 'fixture-user', package: { udtDefinitions: [{ id: 'Press', version: 2 }] },
    expected: [{ kind: 'udtDefinitions', key: 'Press@2', action: 'add', before: null }], fromAskSpark: ['Press@2'] }));
  sessionStorage.setItem('sparkstudio.model-draft', '{}');
  draft = await run('model_draft_get', {}, signed);
  assert.deepEqual(draft.data.changes, [{ kind: 'udtDefinitions', key: 'Press@2', action: 'add' }]);
  assert.equal(draft.data.pendingAssistantProposal, true); assert.deepEqual(draft.data.fromAskSpark, ['Press@2']);
  assert.equal(calls.length, 0);
  sessionStorage.removeItem('sparkstudio.model-workspace.fixture-user'); sessionStorage.removeItem('sparkstudio.model-draft');
  await assert.rejects(run('model_draft_get', {}, context), /signed-in engineering user/);
});

await check('Model checks, export and publishing reach their exact gateway endpoints', async () => {
  fixture(call => ({ ok: true, url: call.url }));
  await run('model_issues', { path: '[default]Acme', pageSize: 20 });
  await run('model_dependencies', { type: 'Press@1', query: 'speed' });
  await run('model_versions_compare', { definitionJson: '{"id":"Press","version":2,"members":[]}', fromVersion: 1 });
  await run('model_export', { definitionKeys: ['Press@1'], includeSourceTags: false });
  await run('model_publishing_get', {});
  const publisher = { id: 'line1', name: 'Line 1', endpoint: 'mqtt://broker.test:1883', instancePaths: ['[default]Acme/Line1/Press01'] };
  await run('model_publishing_preview', { publisher });
  assert.deepEqual(calls.map(call => call.method ?? 'GET'), ['GET', 'GET', 'POST', 'POST', 'GET', 'POST']);
  assert.equal(new URL(calls[0].url, 'https://fixture.invalid').pathname, '/api/projects/fixture-project/model/issues');
  assert.equal(new URL(calls[0].url, 'https://fixture.invalid').searchParams.get('path'), '[default]Acme');
  assert.equal(calls[1].url, '/api/model/dependencies?type=Press%401&query=speed');
  assert.deepEqual(calls[2].body, { definition: { id: 'Press', version: 2, members: [] }, fromVersion: 1 });
  assert.deepEqual(calls[3].body, { definitionKeys: ['Press@1'], includeSourceTags: false });
  assert.deepEqual(calls[5].body, { publisher });
  fixture(call => call.url === '/api/model/publishing' && (call.method ?? 'GET') === 'GET' ? { revision: 3, publishers: [{ ...publisher, username: 'spark' }] } : { saved: true, body: call.body });
  await assert.rejects(run('model_publishing_save', { revision: 2, publisher }), /changed after it was read/);
  const saved = await run('model_publishing_save', { revision: 3, publisher: { ...publisher, enabled: true } });
  assert.equal(calls.at(-1).method, 'PUT'); assert.equal(calls.at(-1).url, '/api/model/publishing/line1'); assert.deepEqual(saved.data.body, { revision: 3, publisher: { ...publisher, enabled: true } });
  const secrets = [];
  await run('model_publishing_set_credentials', { id: 'line1', revision: 3 }, { ...context, resolveSecret: async (_handle, purpose) => { secrets.push(purpose); return { password: 'typed-in-dialog' }; } });
  assert.deepEqual(secrets, ['model-publisher']); assert.equal(calls.at(-1).body.publisher.password, 'typed-in-dialog');
  await assert.rejects(run('model_publishing_set_credentials', { id: 'line1', revision: 3 }, context), /Secure credential entry/);
  await run('model_publishing_delete', { id: 'line1', revision: 3, discardPending: true });
  assert.equal(calls.at(-1).method, 'DELETE'); assert.equal(calls.at(-1).url, '/api/model/publishing/line1?revision=3&discardPending=true');
});

await check('Source browse/import requests pin revision and keep preview tokens', async () => {
  fixture(call => call.body);
  await run('source_browse', { id: 'agent', revision: 8, pageSize: 50, continuationToken: 'next-page' });
  assert.equal(calls[0].url, '/api/connections/agent/source/browse');
  assert.deepEqual(calls[0].body, { revision: 8, pageSize: 50, continuationToken: 'next-page' });
  await run('source_import_apply', { id: 'agent', revision: 8, points: [], previewToken: 'reviewed' });
  assert.equal(calls[1].body.previewToken, 'reviewed');
  await assert.rejects(run('source_import_apply', { id: 'agent', revision: 8, points: [] }), /previewToken is required/);
});

await check('Named-query mutations use server CAS endpoints and cannot fall back to an unreviewed PUT', async () => {
  fixture(call => call.body);
  await run('queries_save', { id: 'machines', expectedFingerprint: 'missing', definition: { name: 'Machines', connectionId: 'sample', sql: 'SELECT 1', kind: 'query', parameters: [] } });
  assert.equal(calls[0].url, '/api/projects/fixture-project/queries/machines/reviewed');
  assert.equal(calls[0].body.expectedFingerprint, 'missing'); assert.equal(calls[0].body.query.sql, 'SELECT 1');
  await run('queries_delete', { id: 'machines', expectedFingerprint: 'fingerprint+value' });
  assert.equal(calls[1].url, '/api/projects/fixture-project/queries/machines/reviewed?expectedFingerprint=fingerprint%2Bvalue');
  assert.equal(calls[1].method, 'DELETE');
  await assert.rejects(run('queries_save', { id: 'machines', definition: {} }), /expectedFingerprint is required/);
  await run('queries_review', { id: 'machines' }, { projectId: 'other-project' });
  assert.equal(calls.at(-1).url, '/api/projects/other-project/queries/machines/review');
});

await check('Script save/delete preserve siblings, pin draft revision and do not publish', async () => {
  const resource = { id: 'lib', name: 'lib', type: 'library', code: 'x=1', enabled: true, parameters: {} };
  fixture(call => call.method === 'GET' ? { revision: 5, resources: [resource, { ...resource, id: 'keep' }] } : call.body);
  await run('scripts_save', { revision: 5, resource: { ...resource, code: 'x=2' } });
  assert.equal(calls.at(-1).url, '/api/projects/fixture-project/scripts/resources');
  assert.equal(calls.at(-1).body.revision, 5); assert.equal(calls.at(-1).body.resources.length, 2);
  assert.equal(calls.at(-1).body.resources.find(item => item.id === 'lib').code, 'x=2');
  await run('scripts_delete', { id: 'lib', revision: 5 });
  assert.deepEqual(calls.at(-1).body.resources.map(item => item.id), ['keep']);
  assert.ok(calls.every(call => !call.url.includes('/publish')));
});

await check('Publication and physical execution require their reviewed revision/token contracts', async () => {
  fixture(call => call.url.endsWith('/review') ? { token: 'physical-review-token', requestedValue: 12 } : call.body);
  const review = await run('commands_review', { id: 'speed', publishedAt: '2026-10-03T10:00:00Z', value: 12 });
  assert.equal(review.data.token, 'physical-review-token');
  await assert.rejects(run('commands_execute', { id: 'speed', token: review.data.token, confirmed: false }), /not a supported value/);
  await run('commands_execute', { id: 'speed', token: review.data.token, confirmed: true });
  assert.equal(calls.at(-1).url, '/api/projects/fixture-project/runtime/commands/speed/execute');
  assert.equal(calls.at(-1).operatorGrant, 'command');
  assert.deepEqual(calls.at(-1).body, { token: 'physical-review-token', confirmed: true });
  await assert.rejects(run('publication_publish', { revision: 4, scriptsRevision: 5 }), /reviewToken is required/);
  await run('publication_publish', { revision: 4, scriptsRevision: 5, reviewToken: 'publication-review' });
  assert.equal(calls.at(-1).body.reviewToken, 'publication-review');
  assert.equal(metadata.find(tool => tool.name === 'commands_execute').audience, 'operator');
  assert.equal(metadata.find(tool => tool.name === 'commands_execute').confirmation, true);
});

await check('Configuration backups preserve current settings while adding secure credential material', async () => {
  const saved = { destinations: [], schedules: [] };
  fixture(call => call.method === 'GET' ? { revision: 'backup-r2', saved } : call.body);
  const result = await run('backups_set_credentials', { revision: 'backup-r2', destinationId: 'remote' }, { ...context, resolveSecret: async () => ({ secretAccessKey: 'outside-chat' }) });
  assert.deepEqual(calls.at(-1).body.settings, saved);
  assert.equal(calls.at(-1).body.destinationSecrets[0].secretAccessKey, 'outside-chat');
  assert.equal(result.data.destinationSecrets[0].secretAccessKey, '[redacted]');
});

await check('Project import and image upload use local attachment bytes without returning them to chat', async () => {
  fixture(call => ({ imported: true, receivedBytes: call.body instanceof Blob ? call.body.size : 4 }));
  let purpose;
  await run('projects_import', { name: 'Fixture' }, { ...context, resolveAttachment: async (_handle, nextPurpose) => { purpose = nextPurpose; return new Blob(['PKfixture'], { type: 'application/zip' }); } });
  assert.equal(purpose, 'project-import'); assert.ok(calls[0].body instanceof Blob); assert.equal(calls[0].url, '/api/projects/import?name=Fixture');
  await run('assets_upload', { name: 'pixel.png' }, { ...context, resolveAttachment: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) });
  assert.equal(calls.at(-1).body.dataBase64, 'AQID'); assert.equal(calls.at(-1).url, '/api/projects/fixture-project/assets');
  await assert.rejects(run('assets_upload', { name: 'too-large.png' }, { ...context, resolveAttachment: async () => new Blob([new Uint8Array(512 * 1024 + 1)]) }), /Attachment size/);
});

await check('Binary exports download locally and report metadata only', async () => {
  fixture(() => new Response(new Uint8Array([80, 75, 1, 2]), { headers: { 'content-type': 'application/zip' } }));
  let received;
  const result = await run('projects_export', { id: 'fixture-project' }, { ...context, download: async (blob, filename) => { received = { bytes: blob.size, filename }; } });
  assert.deepEqual(received, { bytes: 4, filename: 'fixture-project.sparkproj' });
  assert.deepEqual(result.data, { downloaded: true, bytes: 4, filename: 'fixture-project.sparkproj' });
});

await check('Alarm/history configuration accepts actual supported modes and rejects invented modes', async () => {
  fixture(call => call.body);
  const config = { revision: 1, alarmRetentionDays: 30, alarms: [{ id: 'alarm', name: 'Hot', tagPath: '[default]Temperature', enabled: true, mode: 'high', setpoint: 100, priority: 2 }], history: [] };
  await run('process_data_save', config);
  assert.equal(calls[0].body.alarms[0].mode, 'high');
  await assert.rejects(run('process_data_save', { ...config, alarms: [{ ...config.alarms[0], mode: 'outside' }] }), /not a supported value/);
});

await check('Recovery preparation reads actual state and never pretends to restore or restart', async () => {
  fixture(call => ({ route: call.url, revision: 'r1', active: true }));
  const result = await run('recovery_prepare');
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.method === 'GET'));
  assert.equal(result.data.onlineRestoreSupported, false); assert.equal(result.data.changesApplied, false);
  assert.ok(result.data.checklist.length > 0);
});

console.log(`Ask Spark gateway tools: ${checks} checks passed; ${metadata.length} handlers registered.`);
