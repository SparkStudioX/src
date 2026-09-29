import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync(new URL('src/runtimeNavigation.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { defaultNavigationLabel, navigationLabelError, projectNavigationSettings, runtimeScreenId, runtimeMenuItems, reconcileNavigationAfterScreenChange } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const legacy = { id: 'test', name: 'Test', revision: 1, parameters: {}, screens: [
  { id: 'popup', kind: 'popup', name: 'Details' }, { id: 'home', name: 'Home' }, { id: 'orders', name: 'Orders' }, { id: 'setup', name: 'Setup' },
] };
const configured = { ...legacy, navigation: { startupScreenId: 'orders', mode: 'menu', items: [
  { screenId: 'setup', label: 'Configure equipment' }, { screenId: 'home', label: 'Overview' },
] } };
let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }
test('menu labels reject all C0 and C1 controls, whitespace-only labels and excessive UTF-16 length', () => {
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), ...Array.from({ length: 33 }, (_, index) => index + 127)]) {
    assert.match(navigationLabelError(`Order${String.fromCharCode(code)}s`), /control characters/);
  }
  assert.match(navigationLabelError('   '), /empty/);
  assert.match(navigationLabelError('x'.repeat(121)), /120/);
  assert.match(navigationLabelError('🚀'.repeat(61)), /120/);
  assert.equal(navigationLabelError('Live production'), undefined);
  assert.equal(navigationLabelError('🚀'.repeat(60)), undefined);
});
test('default menu labels sanitize screen names and retain complete Unicode characters within the gateway limit', () => {
  assert.equal(defaultNavigationLabel({ id: 'orders', name: '  Or\u0000de\u0085rs\u007f  ' }), 'Orders');
  assert.equal(defaultNavigationLabel({ id: 'orders', name: '\t\u009f' }), 'orders');
  assert.equal(defaultNavigationLabel({ id: '\u0000', name: '\t' }), 'Screen');
  const label = defaultNavigationLabel({ id: 'orders', name: 'x'.repeat(119) + '🚀' });
  assert.equal(label, 'x'.repeat(119));
  assert.equal(navigationLabelError(label), undefined);
});
test('legacy projects start on first regular screen without generating a menu or changing saved data', () => {
  const before = structuredClone(legacy);
  assert.deepEqual(projectNavigationSettings(legacy), { startupScreenId: 'home', mode: 'none', items: [] });
  assert.equal(runtimeScreenId(legacy), 'home');
  assert.deepEqual(runtimeMenuItems(legacy), []);
  assert.deepEqual(legacy, before);
});
test('an explicit startup screen overrides array order and may be outside the optional menu', () => {
  assert.equal(runtimeScreenId(configured), 'orders');
  assert.equal(runtimeMenuItems(configured).some(item => item.screenId === 'orders'), false);
});
test('publication reload preserves a regular current screen and resolves removed or popup screens to startup', () => {
  assert.equal(runtimeScreenId(configured, 'setup'), 'setup');
  assert.equal(runtimeScreenId(configured, 'gone'), 'orders');
  assert.equal(runtimeScreenId(configured, 'popup'), 'orders');
});
test('invalid explicit startup does not silently become the first screen', () => {
  assert.equal(runtimeScreenId({ ...configured, navigation: { ...configured.navigation, startupScreenId: 'gone' } }), '');
  assert.equal(runtimeScreenId({ ...configured, navigation: { ...configured.navigation, startupScreenId: 'popup' } }), '');
});
test('only authored menu entries appear in saved order with their custom labels', () => {
  assert.deepEqual(runtimeMenuItems(configured), configured.navigation.items);
  const filtered = { ...configured, navigation: { ...configured.navigation, items: [...configured.navigation.items, { screenId: 'popup', label: 'Popup' }, { screenId: 'deleted', label: 'Missing' }] } };
  assert.deepEqual(runtimeMenuItems(filtered), configured.navigation.items);
});
test('none hides a saved menu without discarding destinations or custom labels', () => {
  const hidden = { ...configured, navigation: { ...configured.navigation, mode: 'none' } };
  assert.deepEqual(runtimeMenuItems(hidden), []);
  assert.deepEqual(projectNavigationSettings(hidden).items, configured.navigation.items);
});
test('empty menu mode stays empty and adding screens does not populate it', () => {
  const empty = { ...configured, navigation: { ...configured.navigation, items: [] } };
  const next = { ...empty, screens: [...empty.screens, { id: 'new', name: 'New' }] };
  assert.equal(reconcileNavigationAfterScreenChange(empty, next), next);
  assert.deepEqual(runtimeMenuItems(next), []);
});
test('converting a startup screen to popup repairs startup and menu in one immutable edit', () => {
  const previous = { ...configured, navigation: { ...configured.navigation, items: [...configured.navigation.items, { screenId: 'orders', label: 'Production' }] } };
  const before = structuredClone(previous);
  const changed = { ...previous, screens: previous.screens.map(screen => screen.id === 'orders' ? { ...screen, kind: 'popup' } : screen) };
  const next = reconcileNavigationAfterScreenChange(previous, changed);
  assert.equal(next.navigation.startupScreenId, 'home');
  assert.deepEqual(next.navigation.items, configured.navigation.items);
  assert.deepEqual(previous, before);
  assert.equal(next.screens, changed.screens);
});
test('deleting a menu destination keeps startup and other destinations in their original order', () => {
  const next = reconcileNavigationAfterScreenChange(configured, { ...configured, screens: configured.screens.filter(screen => screen.id !== 'setup') });
  assert.equal(next.navigation.startupScreenId, 'orders');
  assert.deepEqual(next.navigation.items, [{ screenId: 'home', label: 'Overview' }]);
});
test('legacy screen edits do not create a navigation object', () => {
  const changed = { ...legacy, screens: legacy.screens.filter(screen => screen.id !== 'home') };
  assert.equal(reconcileNavigationAfterScreenChange(legacy, changed), changed);
  assert.equal(Object.hasOwn(changed, 'navigation'), false);
  assert.equal(runtimeScreenId(changed), 'orders');
});
test('unrelated edits do not normalize existing invalid settings silently', () => {
  const invalid = { ...configured, navigation: { ...configured.navigation, startupScreenId: 'missing', items: [{ screenId: 'missing', label: 'Missing' }] } };
  const renamed = { ...invalid, name: 'Renamed' };
  assert.equal(reconcileNavigationAfterScreenChange(invalid, renamed), renamed);
});
test('navigation survives serialized project round trips including hidden items', () => {
  const saved = { ...configured, navigation: { ...configured.navigation, mode: 'none' } };
  assert.deepEqual(JSON.parse(JSON.stringify(saved)).navigation, saved.navigation);
  assert.equal(runtimeScreenId(JSON.parse(JSON.stringify(saved))), 'orders');
});
console.log(`${passed} runtime navigation checks passed.`);
