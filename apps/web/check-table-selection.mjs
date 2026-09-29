import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync(new URL('./src/tableSelection.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { resolveTableSelection, tableRowIdentity } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }
const fields = { name: 'Name', amount: 'Amount', enabled: 'Enabled', note: 'Note' };
const row = (Id, overrides = {}) => ({ Id, Name: 'Order A', Amount: 0, Enabled: false, Note: '', ...overrides });
const selection = (rows, selected = rows[0], mapping = fields, rowKey = 'Id') => resolveTableSelection(rows, selected, rowKey, mapping);
function unchanged(result, before = { name: 'Previous', amount: 12, enabled: true, note: 'Keep' }) {
  assert.equal(result.ok, false);
  assert.deepEqual(result.changes, []);
  let after = before;
  for (const [field, value] of result.changes) after = { ...after, [field]: value };
  assert.equal(after, before, 'An invalid selection must expose no partial form update.');
}
test('valid mapping preserves exact false, zero, empty and text scalar values', () => {
  const result = selection([row(17)]);
  assert.equal(result.ok, true);
  assert.equal(result.key, 17);
  assert.deepEqual(result.changes, [['name', 'Order A'], ['amount', 0], ['enabled', false], ['note', '']]);
});
test('valid finite decimal and safe-integer boundary values retain their types', () => {
  for (const Amount of [2.25, -12.5, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
    const result = selection([row('A', { Amount })]);
    assert.equal(result.ok, true);
    assert.equal(result.changes.find(([field]) => field === 'amount')[1], Amount);
  }
});
test('null, missing, nested and unsafe mapped cells return no earlier partial changes', () => {
  for (const Amount of [null, undefined, NaN, Infinity, -Infinity, 9007199254740992, -9007199254740992, {}, [], 1n, Symbol('bad')]) unchanged(selection([row('A', { Amount })]));
  const missing = row('A'); delete missing.Amount;
  unchanged(selection([missing]));
});
test('a later invalid column prevents every preceding mapped assignment', () => {
  const selected = row('A', { Name: 'New name', Amount: 42, Enabled: true, Note: null });
  const result = selection([selected]);
  unchanged(result);
  assert.match(result.error, /Note has no usable form value/);
});
test('every source row requires a valid key even when the selected row is valid', () => {
  for (const Id of [null, undefined, '', ' \t ', true, false, 2.5, NaN, Infinity, 9007199254740992, {}, []]) unchanged(selection([row('valid'), row(Id)]));
  const missing = row('other'); delete missing.Id;
  unchanged(selection([row('valid'), missing]));
});
test('missing row-key configuration and stale row objects cannot update the form', () => {
  const rows = [row('A')];
  unchanged(selection(rows, rows[0], fields, ''));
  unchanged(resolveTableSelection(rows, rows[0], undefined, fields));
  unchanged(selection(rows, { ...rows[0] }));
  unchanged(selection([], row('A')));
});
test('duplicate text and numeric keys invalidate the entire result', () => {
  for (const Id of ['A', 0, 12]) unchanged(selection([row(Id), row(Id)]));
  unchanged(selection([row(0), row(-0)]));
});
test('text and numeric keys remain distinct in selection and React row identity', () => {
  const rows = [row(7), row('7')];
  assert.equal(selection(rows, rows[0]).key, 7);
  assert.equal(selection(rows, rows[1]).key, '7');
  assert.notEqual(tableRowIdentity(7), tableRowIdentity('7'));
});
test('zero and whitespace-containing nonempty text are stable valid keys', () => {
  for (const Id of [0, 'Order A', ' A ']) assert.equal(selection([row(Id)]).key, Id);
});
test('sorting and filtering change presentation without changing selected identity', () => {
  const rows = [row('C', { Amount: 30 }), row('A', { Amount: 10 }), row('B', { Amount: 20 })];
  const visible = rows.filter(item => item.Amount >= 20).sort((a, b) => a.Amount - b.Amount);
  const selected = visible[0];
  assert.equal(selected.Id, 'B');
  const original = selection(rows, selected);
  assert.deepEqual(selection([...rows].reverse(), selected), original);
  assert.equal(original.key, 'B');
  assert.equal(tableRowIdentity(original.key), tableRowIdentity(rows[2].Id));
  assert.deepEqual(rows.map(item => item.Id), ['C', 'A', 'B']);
});
test('hidden duplicate keys are checked against the full result, not filtered rows', () => {
  const rows = [row('A', { Name: 'Visible' }), row('A', { Name: 'Hidden' })];
  const visible = rows.filter(item => item.Name === 'Visible');
  unchanged(selection(rows, visible[0]));
});
test('inherited keys or mapped cells are never treated as returned database columns', () => {
  const inheritedKey = Object.assign(Object.create({ Id: 'A' }), { Name: 'Name', Amount: 1, Enabled: true, Note: '' });
  unchanged(selection([inheritedKey]));
  const inheritedValue = Object.assign(Object.create({ Amount: 4 }), row('A')); delete inheritedValue.Amount;
  unchanged(selection([inheritedValue]));
});
test('selection does not mutate the rows, mapping or previously entered values', () => {
  const rows = [Object.freeze(row('A'))]; Object.freeze(rows);
  const mapping = Object.freeze({ ...fields });
  assert.equal(selection(rows, rows[0], mapping).ok, true);
  assert.deepEqual(rows[0], row('A'));
  assert.deepEqual(mapping, fields);
});
console.log(`${passed}/${passed} table-selection checks passed.`);
