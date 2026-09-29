import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync(new URL('src/designerDocuments.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { restoreDesignerDocuments, openDesignerDocument, closeDesignerDocument } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const project = { screens: [{ id: 'a', components: [{ id: 'unsaved' }] }, { id: 'b' }, { id: 'shared' }], templates: [{ id: 'shared' }] };
let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }
test('first visit opens one screen, while closed-all preference remains empty', () => {
  assert.deepEqual(restoreDesignerDocuments(project), { open: [{ kind: 'screen', id: 'a' }], active: 'screen:a' });
  assert.deepEqual(restoreDesignerDocuments(project, { open: [], active: null }), { open: [], active: null });
});
test('reopening a resource selects its existing tab without duplicate entries', () => {
  const first = openDesignerDocument(restoreDesignerDocuments(project), { kind: 'screen', id: 'b' });
  const again = openDesignerDocument(first, { kind: 'screen', id: 'a' });
  assert.equal(again.open.length, 2); assert.equal(again.active, 'screen:a');
});
test('screen and template identities do not collide', () => {
  const state = openDesignerDocument(openDesignerDocument({ open: [], active: null }, { kind: 'screen', id: 'shared' }), { kind: 'template', id: 'shared' });
  assert.equal(state.open.length, 2); assert.equal(state.active, 'template:shared');
});
test('closing active tabs selects a neighbor and closing the last leaves no document', () => {
  const state = restoreDesignerDocuments(project, { open: ['a', 'b', 'shared'].map(id => ({ kind: 'screen', id })), active: 'screen:b' });
  const next = closeDesignerDocument(state, 'screen:b'); assert.equal(next.active, 'screen:shared');
  const last = closeDesignerDocument(next, 'screen:shared'); assert.equal(last.active, 'screen:a');
  assert.deepEqual(closeDesignerDocument(last, 'screen:a'), { open: [], active: null });
});
test('closing background tabs preserves active tab and never mutates application content', () => {
  const before = structuredClone(project);
  const state = restoreDesignerDocuments(project, { open: ['a', 'b'].map(id => ({ kind: 'screen', id })), active: 'screen:b' });
  assert.equal(closeDesignerDocument(state, 'screen:a').active, 'screen:b'); assert.deepEqual(project, before);
});
test('saved tabs tolerate deleted documents, duplicate entries, and invalid preference shapes', () => {
  assert.deepEqual(restoreDesignerDocuments(project, { open: [null, { kind: 'wrong', id: 'a' }, { kind: 'screen', id: 'gone' }, { kind: 'screen', id: 'b' }, { kind: 'screen', id: 'b' }], active: 'screen:gone' }), { open: [{ kind: 'screen', id: 'b' }], active: 'screen:b' });
  assert.equal(restoreDesignerDocuments(project, { open: 'invalid' }).active, 'screen:a');
});
console.log(`${passed} designer-document checks passed.`);
