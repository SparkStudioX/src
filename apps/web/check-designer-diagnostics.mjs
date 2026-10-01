import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const modules = new Map();
function load(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  if (modules.has(name)) return modules.get(name);
  const code = fs.readFileSync(new URL(`./src/${name}.ts`, import.meta.url), 'utf8');
  const output = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/from "\.\/([^"]+)"/g, (_match, dependency) => `from ${JSON.stringify(load(dependency))}`);
  const url = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`; modules.set(name, url); return url;
}
const { collectDesignerDiagnostics, filterDesignerDiagnostics } = await import(load('designerDiagnostics'));
const c = (id, props = {}) => ({ id, type: 'label', x: 0, y: 0, width: 100, height: 40, props });
const document = { id: 'main', name: 'Main', width: 800, height: 600, components: [c('bound', { bindings: { width: { expression: 'value', references: { value: { kind: 'input', key: 'width' } } } } })] };
const fixture = (changes = {}) => ({ project: { id: 'test', name: 'Test', parameters: {}, screens: [document], templates: [] }, document, ownerKind: 'screen',
  context: { tags: [], parameters: {}, inputs: { width: 100 }, components: document.components }, ...changes });
let passed = 0;
const check = (name, test) => { test(); passed++; console.log(`PASS ${name}`); };
check('snapshot evaluates the current root scope without mutating input', () => {
  const options = fixture(); options.context.inputs.width = -1; const before = JSON.stringify(options); const result = collectDesignerDiagnostics(options, '2026-09-29T00:00:00Z');
  assert.equal(JSON.stringify(options), before); assert.equal(result.capturedAt, '2026-09-29T00:00:00Z'); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].category, 'binding');
  assert.deepEqual(result.rows[0].target, { kind: 'screen', id: 'main', componentId: 'bound', property: 'props.bindings.width' });
});
check('valid root bindings and good-quality tag variants produce no false errors', () => {
  const options = fixture(); options.context.tags = ['Good', 'good', 'Good_LocalOverride', 'Good (synthetic)'].map(quality => ({ path: quality, quality, value: 12, timestamp: 'now' }));
  assert.equal(collectDesignerDiagnostics(options).rows.length, 0);
});
check('nested forms are not evaluated using parent inputs', () => {
  const options = fixture(); options.project.templates = [{ ...document, id: 'nested', name: 'Nested', components: [c('bad-nested', { bindings: { width: { expression: '-1', references: {} } } })] }];
  assert.equal(collectDesignerDiagnostics(options).rows.length, 0); options.document = options.project.templates[0]; options.ownerKind = 'template';
  assert.equal(collectDesignerDiagnostics(options).rows[0].target.kind, 'template');
});
check('missing query samples are information rather than fabricated execution failures', () => {
  const options = fixture(); options.document = { ...document, components: [c('query', { queryBindings: { text: { queryId: 'rows', column: 'name' } } })] };
  const result = collectDesignerDiagnostics(options); assert.equal(result.queriesNotCaptured, 1); assert.equal(result.rows[0].level, 'info'); assert.match(result.rows[0].message, /not captured/);
});
check('supplied query failures remain a separate category', () => {
  const options = fixture(); options.document = { ...document, components: [c('query', { queryBindings: { text: { queryId: 'rows', column: 'name' } } })] };
  options.context.queryProperties = { query: { text: { status: 'error', error: 'Timed out' } } };
  const result = collectDesignerDiagnostics(options); assert.equal(result.queriesNotCaptured, 0); assert.equal(result.rows[0].category, 'query'); assert.equal(result.rows[0].message, 'Timed out');
});
check('missing structured references retain their owner and ignore code-text guesses', () => {
  const options = fixture({ searchEntries: [{ id: 'r', missing: true, reference: { kind: 'screen', id: 'gone' }, location: 'Main', label: 'destination', target: { kind: 'screen', id: 'main', componentId: 'button' } },
    { id: 'code', missing: true, textOnly: true, reference: { kind: 'query', id: 'guess' } }] });
  const result = collectDesignerDiagnostics(options); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].target.componentId, 'button'); assert.equal(result.referencesChecked, true);
});
check('a supplied pending query sample is informational rather than a failed execution', () => {
  const options = fixture(); options.document = { ...document, components: [c('query', { queryBindings: { text: { queryId: 'rows', column: 'name' } } })] };
  options.context.queryProperties = { query: { text: { status: 'loading' } } };
  const row = collectDesignerDiagnostics(options).rows[0]; assert.equal(row.category, 'query'); assert.equal(row.level, 'info'); assert.match(row.message, /loading/);
});
check('bad tag quality and disconnection omit raw values and retain source timestamps', () => {
  const options = fixture(); options.context.communicationLost = true; options.context.tags = [{ path: '[default]Bad', quality: 'BadDisconnected', timestamp: 'yesterday', value: 'do-not-copy' }];
  const result = collectDesignerDiagnostics(options); assert.equal(result.rows.length, 2); assert.equal(result.communicationLost, true); assert.doesNotMatch(JSON.stringify(result), /do-not-copy/); assert.match(result.rows[1].message, /yesterday/);
});
check('event messages retain timestamps and uniquely resolvable owner links', () => {
  const options = fixture({ events: { breaker: '', diagnostics: [{ id: 1, componentId: 'bound', level: 'error', message: 'Event failed', recordedAt: '2026-09-29T00:00:00Z' }] } });
  const row = collectDesignerDiagnostics(options).rows[0]; assert.equal(row.category, 'browser-event'); assert.equal(row.recordedAt, options.events.diagnostics[0].recordedAt); assert.equal(row.target.id, 'main');
});
check('duplicate event component IDs do not fabricate a screen or template owner', () => {
  const options = fixture({ events: { breaker: '', diagnostics: [{ id: 1, componentId: 'bound', level: 'info', message: 'Shared message' }] } });
  options.project.templates = [{ ...document, id: 'same-id-owner' }]; const row = collectDesignerDiagnostics(options).rows[0]; assert.equal(row.target, undefined); assert.match(row.location, /not uniquely/);
});
check('latched event breaker stays visible independently of ordinary messages', () => {
  const result = collectDesignerDiagnostics(fixture({ events: { breaker: 'Feedback stopped', diagnostics: [] } })); assert.equal(result.rows[0].level, 'error'); assert.equal(result.rows[0].message, 'Feedback stopped');
});
check('snapshot bounds disclose exactly how many additional messages were omitted', () => {
  const options = fixture(); options.context.tags = Array.from({ length: 1200 }, (_, i) => ({ path: `tag-${i}`, quality: 'Bad', timestamp: '', value: 0 }));
  const result = collectDesignerDiagnostics(options); assert.equal(result.rows.length, 1000); assert.equal(result.omitted, 200); assert.equal(result.tagsChecked, 1200);
});
check('category severity and literal AND filters compose without executing code', () => {
  const rows = [{ category: 'binding', level: 'error', location: 'Main / width', message: 'Invalid number' }, { category: 'quality', level: 'warning', location: 'Main', message: 'Bad' }];
  assert.equal(filterDesignerDiagnostics(rows, 'binding', 'MAIN number', 'error').length, 1); assert.equal(filterDesignerDiagnostics(rows, 'all', '.*').length, 0); assert.equal(filterDesignerDiagnostics(rows, 'quality', '', 'error').length, 0);
});
check('collection never invokes network or script APIs', () => {
  const previous = globalThis.fetch; globalThis.fetch = () => { throw Error('Network must not run'); };
  try { const options = fixture(); options.document = { ...document, components: [c('script', { action: 'script', script: 'throw new Error("must not execute")', componentEvents: { mount: { language: 'javascript', code: 'fetch("/")' } } })] }; assert.equal(collectDesignerDiagnostics(options).rows.length, 0); }
  finally { globalThis.fetch = previous; }
});
console.log(`${passed} Designer diagnostic model checks passed.`);
