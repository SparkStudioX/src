import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = name => fs.readFileSync(new URL(`./src/${name}.ts`, import.meta.url), 'utf8');
const compile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const authSessionUrl = asModule(compile(source('authSession')));
const previewRequestUrl = asModule(compile(source('previewRequest')));
const apiUrl = asModule(compile(source('api')).replaceAll('"./authSession"', JSON.stringify(authSessionUrl)).replaceAll('"./previewRequest"', JSON.stringify(previewRequestUrl)));
const listTreeUrl = asModule(compile(source('listTreeModel')));
const validationUrl = asModule(compile(source('inputValidation')));
const cameraUrl = asModule(compile(source('computerCameraModel')));
const inputsUrl = asModule(compile(source('inputs')).replaceAll('"./api"', JSON.stringify(apiUrl)).replaceAll('"./listTreeModel"', JSON.stringify(listTreeUrl)).replaceAll('"./inputValidation"', JSON.stringify(validationUrl)).replaceAll('"./computerCameraModel"', JSON.stringify(cameraUrl)));
const compiled = compile(source('canvasEditing')).replaceAll('"./inputs"', JSON.stringify(inputsUrl));
const { selectionBounds, snapToGrid, moveSelected, resizeComponent, alignSelected, distributeSelected, duplicateSelected, marqueeBounds, marqueeSelection, checkpoint, restoreHistory, projectContent, expandGroupSelection, toggleGroupSelection, groupSelected, ungroupSelected, deleteSelected, resizeGroup, arrangementCount, selectComponentType, parseGridSize, matchSelectedSize } =
  await import(asModule(compiled));

let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
const component = (id, x, y, width = 40, height = 28, type = 'label', props = {}) => ({ id, x, y, width, height, type, props });
const bounds = { width: 300, height: 200 };
const geometries = components => components.map(({ id, x, y, width, height }) => ({ id, x, y, width, height }));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !== ${expected}`);

check('selection bounds use only selected IDs and ignore missing/repeated IDs', () => {
  const items = [component('a', 11, 17, 40, 28), component('b', 100, 60, 70, 44), component('other', 0, 0)];
  assert.deepEqual(selectionBounds(items, ['b', 'a', 'a', 'missing']), { x: 11, y: 17, width: 159, height: 87 });
  assert.equal(selectionBounds(items, []), null);
  assert.equal(selectionBounds([], ['a']), null);
});

check('grid snapping handles disabled, negative and fractional coordinates', () => {
  assert.equal(snapToGrid(19), 16);
  assert.equal(snapToGrid(19, 0), 19);
  assert.equal(snapToGrid(19, -8), 19);
  assert.equal(snapToGrid(19, NaN), 19);
  assert.equal(snapToGrid(-13, 8), -16);
  assert.equal(snapToGrid(3.4, 0.5), 3.5);
  assert.equal(snapToGrid(1, Number.MIN_VALUE), 1);
});

check('group movement clamps once at right/bottom and preserves relative offsets', () => {
  const items = [component('a', 20, 10), component('other', 5, 5), component('b', 230, 150, 50, 40)];
  const moved = moveSelected(items, new Set(['a', 'b']), { x: 100, y: 100 }, bounds);
  assert.equal(moved[0].x, 40);
  assert.equal(moved[0].y, 20);
  assert.equal(moved[2].x, 250);
  assert.equal(moved[2].y, 160);
  assert.equal(moved[2].x - moved[0].x, items[2].x - items[0].x);
  assert.equal(moved[2].y - moved[0].y, items[2].y - items[0].y);
  assert.equal(moved[1], items[1]);
  assert.equal(items[0].x, 20);
});

check('left/top clamping and grid snapping use selection origin', () => {
  const items = [component('a', 13, 17), component('b', 82, 55)];
  const snapped = moveSelected(items, ['a', 'b'], { x: 8, y: 8 }, bounds, 8);
  assert.deepEqual([snapped[0].x, snapped[0].y], [24, 24]);
  assert.deepEqual([snapped[1].x, snapped[1].y], [93, 62]);
  const left = moveSelected(items, ['a', 'b'], { x: -999, y: -999 }, bounds, 8);
  assert.deepEqual([left[0].x, left[0].y, left[1].x, left[1].y], [0, 0, 69, 38]);
});

check('canvas boundary wins over grid without squeezing the group', () => {
  const items = [component('a', 10, 10, 53), component('b', 101, 40, 47)];
  const moved = moveSelected(items, ['a', 'b'], { x: 200, y: 0 }, { width: 205, height: 200 }, 8);
  assert.equal(moved[1].x + moved[1].width, 205);
  assert.equal(moved[1].x - moved[0].x, 91);
});

check('imported outside/oversized groups preserve shape without clamp inversion', () => {
  const outside = [component('a', -30, -10), component('b', 90, 20)];
  const moved = moveSelected(outside, ['a', 'b'], { x: 0, y: 0 }, bounds);
  assert.deepEqual(selectionBounds(moved), { x: 0, y: 0, width: 160, height: 58 });
  const huge = [component('a', 40, 15, 280), component('b', 330, 60)];
  const anchored = moveSelected(huge, ['a', 'b'], { x: -999, y: 10 }, bounds);
  assert.equal(anchored[0].x, 0);
  assert.equal(anchored[1].x, 290);
  assert.equal(anchored[0].width, 280);
  assert.equal(anchored[1].y - anchored[0].y, 45);
});

check('resizing enforces minimum, bottom/right edges and optional grid', () => {
  const item = component('a', 13, 17, 100, 70);
  const minimum = resizeComponent(item, { width: -100, height: 0 }, bounds);
  assert.deepEqual([minimum.x, minimum.y, minimum.width, minimum.height], [13, 17, 40, 28]);
  const maximum = resizeComponent(item, { width: 900, height: 900 }, bounds, 8);
  assert.deepEqual([maximum.width, maximum.height], [287, 183]);
  const snapped = resizeComponent(item, { width: 90, height: 50 }, bounds, 8);
  assert.equal(snapped.x + snapped.width, 104);
  assert.equal(snapped.y + snapped.height, 64);
  assert.equal(item.width, 100);
});

check('resizing recovers imported origins and respects canvases smaller than minimum', () => {
  const item = component('a', 999, -30, 10, 10);
  const resized = resizeComponent(item, { width: 50, height: 60 }, bounds);
  assert.deepEqual([resized.x, resized.y, resized.width, resized.height], [260, 0, 40, 60]);
  const tiny = resizeComponent(item, { width: 50, height: 60 }, { width: 20, height: 15 });
  assert.deepEqual([tiny.x, tiny.y, tiny.width, tiny.height], [0, 0, 20, 15]);
});

check('all six alignments use selected bounds and preserve dimensions and unselected items', () => {
  const items = [component('a', 20, 10, 40, 30), component('b', 180, 110, 80, 50), component('c', 0, 0)];
  const expected = { left: [20, 20], hcenter: [120, 100], right: [220, 180], top: [10, 10], vcenter: [70, 60], bottom: [130, 110] };
  for (const [alignment, positions] of Object.entries(expected)) {
    const aligned = alignSelected(items, ['a', 'b'], alignment);
    const key = ['left', 'hcenter', 'right'].includes(alignment) ? 'x' : 'y';
    assert.deepEqual(aligned.slice(0, 2).map(item => item[key]), positions);
    assert.equal(aligned[2], items[2]);
    assert.deepEqual(aligned.map(item => [item.width, item.height]), items.map(item => [item.width, item.height]));
  }
});

check('horizontal distribution preserves z-order with equal gaps between unequal widths', () => {
  const items = [component('right', 220, 10, 30), component('left', 10, 20, 40), component('middle', 70, 40, 80), component('other', 0, 0)];
  const distributed = distributeSelected(items, ['right', 'middle', 'left'], 'horizontal');
  assert.deepEqual(distributed.map(item => item.id), items.map(item => item.id));
  assert.equal(distributed[0].x, 220);
  assert.equal(distributed[1].x, 10);
  assert.equal(distributed[2].x, 95);
  assert.equal(distributed[2].x - (distributed[1].x + distributed[1].width), 45);
  assert.equal(distributed[0].x - (distributed[2].x + distributed[2].width), 45);
  assert.equal(distributed[3], items[3]);
  assert.deepEqual(distributed.map(item => item.y), items.map(item => item.y));
});

check('vertical distribution supports fractional gaps and pins the final edge', () => {
  const items = [component('a', 20, 0, 40, 29), component('b', 30, 34, 40, 30), component('c', 40, 100, 40, 32)];
  const distributed = distributeSelected(items, ['a', 'b', 'c'], 'vertical');
  close(distributed[1].y, 49.5);
  close(distributed[1].y - distributed[0].height, distributed[2].y - distributed[1].y - distributed[1].height);
  assert.equal(distributed[2].y + distributed[2].height, 132);
});

check('distribution requires three items and rejects negative gaps', () => {
  const items = [component('a', 0, 0, 80), component('b', 20, 0, 80), component('c', 50, 0, 80)];
  assert.deepEqual(distributeSelected(items, ['a', 'b'], 'horizontal'), items);
  assert.deepEqual(distributeSelected(items, ['a', 'b', 'c'], 'horizontal'), items);
});

check('zero-gap distribution is allowed and repeated-ID selection cannot count twice', () => {
  const items = [component('a', 0, 0), component('b', 60, 0), component('c', 80, 0)];
  const distributed = distributeSelected(items, ['a', 'b', 'c'], 'horizontal');
  assert.deepEqual(distributed.map(item => item.x), [0, 40, 80]);
  assert.deepEqual(distributeSelected(items, ['a', 'a', 'b'], 'horizontal'), items);
});

check('duplication preserves source/z-order and applies one clamped group offset', () => {
  const items = [component('a', 10, 20), component('other', 0, 0), component('b', 250, 140, 40, 50)];
  const duplicated = duplicateSelected(items, ['b', 'a'], bounds);
  assert.deepEqual(duplicated.selectedIds, ['a_copy', 'b_copy']);
  assert.deepEqual(duplicated.components.slice(0, 3), items);
  const [a, b] = duplicated.components.slice(3);
  assert.deepEqual([a.x, a.y, b.x, b.y], [20, 30, 260, 150]);
  assert.equal(b.x - a.x, 240);
  assert.equal(b.y - a.y, 120);
});

check('duplicate IDs tolerate existing suffixes and colliding ID factories', () => {
  const items = [component('a', 0, 0), component('a_copy', 0, 0), component('a_copy_2', 0, 0), component('b', 50, 0)];
  const defaultCopy = duplicateSelected(items, ['a'], bounds);
  assert.deepEqual(defaultCopy.selectedIds, ['a_copy_3']);
  const collided = duplicateSelected(items, ['a', 'b'], bounds, { createId: () => 'a' });
  assert.deepEqual(collided.selectedIds, ['a_2', 'a_3']);
  assert.equal(new Set(collided.components.map(item => item.id)).size, collided.components.length);
});

check('duplicate input field keys remain valid, unique and within publication length limits', () => {
  const key = 'x'.repeat(64);
  const items = [
    component('text-a', 0, 0, 40, 28, 'textInput', { fieldKey: key }),
    component('text-b', 50, 0, 40, 28, 'numberInput', { fieldKey: key }),
    component('check', 100, 0, 40, 28, 'checkbox', { fieldKey: 'enabled' }),
    component('existing', 0, 50, 40, 28, 'textInput', { fieldKey: 'enabled_copy' }),
    component('12-select', 150, 0, 40, 28, 'select', { options: [{ label: 'One', value: 'one' }] }),
  ];
  const duplicated = duplicateSelected(items, ['text-a', 'text-b', 'check', '12-select'], bounds);
  const copies = duplicated.components.slice(items.length);
  assert.equal(new Set(copies.map(item => item.props.fieldKey)).size, 4);
  for (const copy of copies) {
    assert.match(copy.props.fieldKey, /^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
    assert.ok(!items.some(item => item.props.fieldKey === copy.props.fieldKey));
  }
  assert.equal(copies[2].props.fieldKey, 'enabled_copy_2');
});

check('duplicates deep-clone nested props while retaining authored script and binding text', () => {
  const items = [component('form', 0, 0, 100, 80, 'repeater', { templateId: 'form', rows: [{ id: 'row', parameters: { name: 'Original' } }], parameters: { line: '{line}' } }), component('save', 150, 0, 40, 28, 'button', { script: 'result = inputs.target', tagPath: '[default]Line/{line}/Target' })];
  const duplicated = duplicateSelected(items, ['form', 'save'], bounds);
  const [form, save] = duplicated.components.slice(items.length);
  form.props.rows[0].parameters.name = 'Changed';
  assert.equal(items[0].props.rows[0].parameters.name, 'Original');
  assert.equal(save.props.script, items[1].props.script);
  assert.equal(save.props.tagPath, items[1].props.tagPath);
});
check('copied native tag property sources follow copied components while external and self scopes remain stable', () => {
  const tagWrite=reference=>({tagPath:'[default]Workshop/Setpoint',dataType:'Double',valueReference:reference});
  const items=[component('amount',0,0,40,28,'numberInput'),component('write',50,0,40,28,'button',{action:'setTagValue',tagWrite:tagWrite({kind:'property',componentId:'amount',property:'value'})}),
    component('self-read',100,0,40,28,'button',{action:'setTagValue',tagWrite:tagWrite({kind:'property',property:'width'})}),component('parent-read',150,0,40,28,'button',{action:'setTagValue',tagWrite:tagWrite({kind:'parentProperty',property:'height'})})];
  const copies=duplicateSelected(items,items.map(item=>item.id),bounds).components.slice(items.length);
  assert.equal(copies[1].props.tagWrite.valueReference.componentId,copies[0].id);assert.equal(items[1].props.tagWrite.valueReference.componentId,'amount');
  assert.deepEqual(copies[2].props.tagWrite.valueReference,{kind:'property',property:'width'});assert.deepEqual(copies[3].props.tagWrite.valueReference,{kind:'parentProperty',property:'height'});
  assert.equal(duplicateSelected(items,['write'],bounds).components.at(-1).props.tagWrite.valueReference.componentId,'amount');
});

check('every supported input type receives a new unique field name', () => {
  const types = ['textInput', 'textArea', 'numberInput', 'spinner', 'slider', 'checkbox', 'toggle', 'select', 'radioGroup', 'dateTimeInput'];
  const items = types.map((type, index) => component(type, index * 20, 0, 40, 28, type, { fieldKey: `field${index}` }));
  const copies = duplicateSelected(items, items.map(item => item.id), bounds).components.slice(items.length);
  assert.equal(copies.length, types.length);
  assert.equal(new Set(copies.map(item => item.props.fieldKey)).size, types.length);
  copies.forEach((copy, index) => assert.notEqual(copy.props.fieldKey, items[index].props.fieldKey));
});

check('no selection, invalid geometry and invalid canvas dimensions are safe no-ops', () => {
  const items = [component('a', 10, 20)];
  assert.deepEqual(moveSelected(items, [], { x: 10, y: 10 }, bounds), items);
  assert.deepEqual(duplicateSelected(items, ['missing'], bounds), { components: items, selectedIds: [] });
  assert.deepEqual(moveSelected(items, ['a'], { x: 10, y: 10 }, { width: -1, height: 200 }), items);
  const bad = [component('bad', NaN, 0)];
  assert.equal(selectionBounds(bad), null);
  assert.equal(moveSelected(bad, ['bad'], { x: 10, y: 10 }, bounds)[0], bad[0]);
  assert.equal(resizeComponent(bad[0], { width: 100, height: 100 }, bounds), bad[0]);
  const finiteMove = moveSelected(items, ['a'], { x: NaN, y: Infinity }, bounds);
  assert.deepEqual(geometries(finiteMove), geometries(items));
});

check('marquee supports reverse drags, intersection and additive selection without stale IDs', () => {
  const items = [component('a', 10, 10), component('b', 100, 70), component('c', 210, 120), component('bad', NaN, 0)];
  const rect = marqueeBounds({ x: 110, y: 80 }, { x: 30, y: 20 });
  assert.deepEqual(rect, { x: 30, y: 20, width: 80, height: 60 });
  assert.deepEqual(marqueeSelection(items, rect), ['a', 'b']);
  assert.deepEqual(marqueeSelection(items, rect, ['c', 'missing', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(marqueeSelection(items, { x: 50, y: 0, width: 30, height: 80 }), []);
  assert.deepEqual(marqueeSelection(items, { x: 10, y: 10, width: 0, height: 50 }), []);
  assert.equal(marqueeBounds({ x: NaN, y: 0 }, { x: 1, y: 1 }), null);
});

check('duplicate custom-property links follow copied siblings but retain links outside selection', () => {
  const items = [component('a', 10, 20, 40, 28, 'button', {
    script: 'result = "a"',
    customProperties: { count: { type: 'number', value: 5 } },
    bindings: { enabled: { expression: '{mine} > {other}', references: {
      mine: { kind: 'custom', key: 'count' }, other: { kind: 'custom', componentId: 'b', key: 'count' },
      external: { kind: 'custom', componentId: 'outside', key: 'count' }, tag: { kind: 'tag', path: '[default]a' },
    } } },
  }), component('b', 60, 20)];
  const copies = duplicateSelected(items, ['a', 'b'], bounds).components.slice(2);
  const references = copies[0].props.bindings.enabled.references;
  assert.equal(references.mine.componentId, undefined);
  assert.equal(references.other.componentId, copies[1].id);
  assert.equal(references.external.componentId, 'outside');
  assert.equal(references.tag.path, '[default]a');
  assert.equal(items[0].props.bindings.enabled.references.other.componentId, 'b');
  copies[0].props.customProperties.count.value = 0;
  assert.equal(items[0].props.customProperties.count.value, 5);
  assert.equal(copies[0].props.script, items[0].props.script);
});
check('duplicate remaps custom query and dataset parameters inside the copied scope', () => {
  const reference = { expression: 'value', references: { value: { kind: 'custom', componentId: 'source', key: 'value' } } };
  const source = component('source', 0, 0, 40, 28, 'label', { customProperties: { value: { type: 'number', value: 2 } } });
  const target = component('target', 60, 0, 40, 28, 'chart', {
    queryBindings: { 'chart.yMax': { queryId: 'q', column: 'maximum', parameters: { amount: reference } }, 'customProperties.limit.value': { queryId: 'q', column: 'maximum', parameters: { amount: reference } } },
    dataSource: { queryId: 'data', parameters: { amount: reference } },
  });
  const copies = duplicateSelected([source, target], ['source', 'target'], bounds).components.slice(2);
  for (const query of Object.values(copies[1].props.queryBindings)) assert.equal(query.parameters.amount.references.value.componentId, copies[0].id);
  assert.equal(copies[1].props.dataSource.parameters.amount.references.value.componentId, copies[0].id);
  assert.equal(target.props.dataSource.parameters.amount.references.value.componentId, 'source');
});

check('Undo/Redo preserve current server revision and save equivalence through edits and saves', () => {
  const original = { id: 'p', name: 'Original', revision: 1, screens: [], parameters: {} };
  const edited = { ...original, name: 'Edited' };
  let history = checkpoint({ past: [], future: [] }, original);
  const saved = { ...edited, revision: 8 };
  const undone = restoreHistory(history, saved, 'undo');
  assert.equal(undone.project.name, 'Original');
  assert.equal(undone.project.revision, 8);
  assert.notEqual(projectContent(undone.project), projectContent(saved));
  const redone = restoreHistory(undone.history, undone.project, 'redo');
  assert.equal(redone.project.name, 'Edited');
  assert.equal(redone.project.revision, 8);
  assert.equal(projectContent(redone.project), projectContent(saved));
  const savedUndo = { ...undone.project, revision: 9 };
  assert.equal(restoreHistory(undone.history, savedUndo, 'redo').project.revision, 9);
  history = checkpoint(undone.history, undone.project);
  assert.equal(restoreHistory(history, { ...undone.project, name: 'Replacement edit' }, 'redo'), null);
  assert.equal(restoreHistory({ past: [], future: [] }, original, 'undo'), null);
});

check('history keeps a bounded checkpoint list and a new edit discards all redo entries', () => {
  let history = { past: [], future: [] };
  for (let revision = 0; revision < 50; revision++) history = checkpoint(history, { revision, id: 'p' });
  assert.equal(history.past.length, 30);
  assert.equal(history.past[0].revision, 20);
  assert.equal(checkpoint({ past: [], future: [{ revision: 1 }] }, { revision: 2 }).future.length, 0);
});

check('group membership expands click, toggle and intersecting marquee selections atomically', () => {
  const items = [{ ...component('a', 10, 10), groupId: 'group_one' }, component('other', 80, 10), { ...component('b', 210, 110), groupId: 'group_one' }];
  assert.deepEqual(expandGroupSelection(items, ['a', 'missing', 'a']), ['a', 'b']);
  assert.deepEqual(toggleGroupSelection(items, ['other'], 'a'), ['a', 'other', 'b']);
  assert.deepEqual(toggleGroupSelection(items, ['a', 'other', 'b'], 'b'), ['other']);
  assert.deepEqual(marqueeSelection(items, { x: 5, y: 5, width: 10, height: 10 }), ['a', 'b']);
  assert.deepEqual(marqueeSelection(items, { x: 5, y: 5, width: 10, height: 10 }, ['other']), ['a', 'other', 'b']);
  // A different document may reuse a group ID without acquiring these members.
  assert.deepEqual(expandGroupSelection([{ ...component('elsewhere', 0, 0), groupId: 'group_one' }], ['a']), []);
});

check('grouping merges complete groups without changing order, geometry or component data', () => {
  const a = { ...component('a', 0, 0, 60, 40, 'button', { script: 'result = 1' }), groupId: 'one' };
  const b = { ...component('b', 60, 0), groupId: 'one' };
  const c = { ...component('c', 120, 0), groupId: 'two' };
  const d = { ...component('d', 180, 0), groupId: 'two' };
  const outside = component('outside', 0, 100);
  const items = [a, outside, b, c, d];
  const merged = groupSelected(items, ['a', 'c'], 'merged');
  assert.deepEqual(geometries(merged), geometries(items));
  assert.deepEqual(merged.map(item => item.groupId), ['merged', undefined, 'merged', 'merged', 'merged']);
  assert.equal(merged[0].props, a.props);
  assert.equal(merged[1], outside);
  assert.equal(a.groupId, 'one');
  const ungrouped = ungroupSelected(merged, ['b']);
  assert.ok(ungrouped.every(item => !Object.hasOwn(item, 'groupId')));
  assert.deepEqual(geometries(ungrouped), geometries(items));
});

check('group commands reject invalid IDs/single controls, preserve an existing group and avoid ID collisions', () => {
  const items = [{ ...component('a', 0, 0), groupId: 'taken' }, { ...component('b', 50, 0), groupId: 'taken' }, component('c', 100, 0), component('d', 150, 0)];
  assert.equal(groupSelected(items, ['a'], 'new')[0], items[0]);
  assert.deepEqual(groupSelected(items, ['c'], 'single'), items);
  assert.deepEqual(groupSelected(items, ['c', 'd'], 'bad group'), items);
  const grouped = groupSelected(items, ['c', 'd'], 'taken');
  assert.equal(grouped[2].groupId, 'taken_2');
  assert.equal(grouped[3].groupId, 'taken_2');
  assert.equal(grouped[0], items[0]);
  assert.equal(ungroupSelected(items, ['c'])[0], items[0]);
});

check('moving and deleting one member changes the entire group and leaves other controls alone', () => {
  const items = [{ ...component('a', 10, 20), groupId: 'pair' }, component('other', 0, 0), { ...component('b', 240, 140), groupId: 'pair' }];
  const moved = moveSelected(items, ['a'], { x: 100, y: 100 }, bounds);
  assert.deepEqual([moved[0].x, moved[0].y, moved[2].x, moved[2].y], [30, 52, 260, 172]);
  assert.equal(moved[1], items[1]);
  assert.deepEqual(deleteSelected(items, ['b']), [items[1]]);
});

check('group resize uses shared independent axis factors and preserves authored props and IDs', () => {
  const items = [{ ...component('a', 10, 20, 40, 28, 'label', { fontSize: 16 }), groupId: 'pair' }, component('other', 0, 0), { ...component('b', 70, 62, 80, 56), groupId: 'pair' }];
  const resized = resizeGroup(items, 'pair', { width: 280, height: 147 }, { width: 500, height: 300 });
  assert.deepEqual([resized[0].x, resized[0].y, resized[0].width, resized[0].height], [10, 20, 80, 42]);
  assert.deepEqual([resized[2].x, resized[2].y, resized[2].width, resized[2].height], [130, 83, 160, 84]);
  assert.equal(resized[0].props, items[0].props);
  assert.equal(resized[0].props.fontSize, 16);
  assert.equal(resized[0].groupId, 'pair');
  assert.equal(resized[1], items[1]);
  assert.deepEqual(geometries(items), geometries([{ ...component('a', 10, 20, 40, 28), groupId: 'pair' }, component('other', 0, 0), { ...component('b', 70, 62, 80, 56), groupId: 'pair' }]));
});

check('group resize enforces every child minimum, grid and canvas edges without squeezing offsets', () => {
  const items = [{ ...component('a', 13, 17, 80, 56), groupId: 'pair' }, { ...component('b', 113, 87, 120, 84), groupId: 'pair' }];
  const small = resizeGroup(items, 'pair', { width: 1, height: 1 }, { width: 500, height: 400 });
  assert.deepEqual([small[0].width, small[0].height, small[1].width, small[1].height], [40, 28, 60, 42]);
  assert.deepEqual([small[1].x, small[1].y], [63, 52]);
  const grid = resizeGroup(items, 'pair', { width: 253, height: 185 }, { width: 500, height: 400 }, 8);
  const gridBounds = selectionBounds(grid);
  close(gridBounds.x + gridBounds.width, 264);
  close(gridBounds.y + gridBounds.height, 200);
  const maximum = resizeGroup(items, 'pair', { width: 900, height: 900 }, { width: 297, height: 213 }, 8);
  const maxBounds = selectionBounds(maximum);
  close(maxBounds.x + maxBounds.width, 297);
  close(maxBounds.y + maxBounds.height, 213);
  close((maximum[1].x - maximum[0].x) / (items[1].x - items[0].x), maximum[0].width / items[0].width);
});

check('group resize is a safe no-op for impossible child minima, negative origins and invalid geometry', () => {
  const items = [{ ...component('a', 0, 0), groupId: 'pair' }, { ...component('b', 200, 0), groupId: 'pair' }];
  assert.deepEqual(resizeGroup(items, 'pair', { width: 50, height: 50 }, { width: 100, height: 100 }), items);
  assert.deepEqual(resizeGroup(items, 'missing', { width: 50, height: 50 }, bounds), items);
  assert.deepEqual(resizeGroup([items[0]], 'pair', { width: 80, height: 56 }, bounds), [items[0]]);
  const negative = [{ ...items[0], x: -1 }, items[1]];
  assert.deepEqual(resizeGroup(negative, 'pair', { width: 100, height: 100 }, bounds), negative);
  const invalid = [{ ...items[0], width: NaN }, items[1]];
  assert.deepEqual(resizeGroup(invalid, 'pair', { width: 100, height: 100 }, bounds), invalid);
  assert.equal(resizeGroup(items, 'pair', { width: 240, height: 28 }, bounds)[0], items[0]);
});

check('duplicate selection copies whole groups with new group IDs and remapped custom links', () => {
  const groupId = 'g'.repeat(64);
  const items = [{ ...component('a', 0, 0, 40, 28, 'button', { bindings: { text: { expression: 'other', references: { other: { kind: 'custom', key: 'count', componentId: 'b' } } } } }), groupId }, { ...component('b', 60, 0, 40, 28, 'textInput', { fieldKey: 'field', customProperties: { count: { type: 'number', value: 1 } } }), groupId }, component('outside', 0, 100)];
  const result = duplicateSelected(items, ['a'], bounds);
  assert.equal(result.components.length, 5);
  const [a, b] = result.components.slice(3);
  assert.equal(a.groupId, b.groupId);
  assert.notEqual(a.groupId, groupId);
  assert.match(a.groupId, /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
  assert.equal(a.props.bindings.text.references.other.componentId, b.id);
  assert.notEqual(b.props.fieldKey, 'field');
  const again = duplicateSelected(result.components, ['a'], bounds).components.slice(5);
  assert.notEqual(again[0].groupId, a.groupId);
  assert.equal(again[0].groupId, again[1].groupId);
});

check('alignment and distribution treat each persistent group as a single geometry unit', () => {
  const items = [{ ...component('a', 10, 10), groupId: 'pair' }, { ...component('b', 60, 30), groupId: 'pair' }, component('middle', 115, 70), component('right', 260, 110)];
  assert.equal(arrangementCount(items, ['a']), 1);
  assert.equal(arrangementCount(items, ['a', 'middle', 'right']), 3);
  assert.deepEqual(alignSelected(items, ['a'], 'left'), items);
  const aligned = alignSelected(items, ['a', 'middle'], 'right');
  assert.equal(aligned[1].x - aligned[0].x, 50);
  assert.equal(aligned[1].y - aligned[0].y, 20);
  assert.equal(aligned[1].x + aligned[1].width, aligned[2].x + aligned[2].width);
  const distributed = distributeSelected(items, ['a', 'middle', 'right'], 'horizontal');
  assert.equal(distributed[0].x, 10);
  assert.equal(distributed[1].x, 60);
  assert.equal(distributed[2].x, 160);
  assert.equal(distributed[3].x, 260);
  assert.deepEqual(distributeSelected(items, ['a', 'middle'], 'horizontal'), items);
});

check('group creation and resize round-trip through save serialization, Undo and Redo with current revision', () => {
  const items = [component('a', 10, 10), component('b', 70, 40)];
  const original = { id: 'p', name: 'Project', revision: 3, parameters: {}, screens: [{ id: 's', name: 'Screen', width: 400, height: 300, components: items }] };
  const grouped = { ...original, screens: [{ ...original.screens[0], components: groupSelected(items, ['a', 'b'], 'saved_group') }] };
  const history = checkpoint(checkpoint({ past: [], future: [] }, original), grouped);
  const resized = { ...grouped, revision: 9, screens: [{ ...grouped.screens[0], components: resizeGroup(grouped.screens[0].components, 'saved_group', { width: 200, height: 116 }, original.screens[0]) }] };
  const saved = JSON.parse(JSON.stringify(resized));
  assert.ok(saved.screens[0].components.every(item => item.groupId === 'saved_group'));
  const undone = restoreHistory(history, saved, 'undo');
  assert.deepEqual(geometries(undone.project.screens[0].components), geometries(items));
  assert.equal(undone.project.revision, 9);
  assert.ok(undone.project.screens[0].components.every(item => item.groupId === 'saved_group'));
  const ungrouped = restoreHistory(undone.history, undone.project, 'undo');
  assert.ok(ungrouped.project.screens[0].components.every(item => !item.groupId));
  const regrouped = restoreHistory(ungrouped.history, ungrouped.project, 'redo');
  const redone = restoreHistory(regrouped.history, regrouped.project, 'redo');
  assert.equal(projectContent(redone.project), projectContent(saved));
  assert.equal(redone.project.revision, 9);
});

check('custom grids accept bounded whole pixels and reject empty, fractional or malformed values', () => {
  for (const [value, expected] of [['0', 0], ['1', 1], ['12', 12], ['128', 128], [' 24 ', 24], ['008', 8]]) assert.equal(parseGridSize(value), expected);
  for (const value of ['', ' ', '-1', '129', '2.5', 'NaN', 'Infinity', '1e2', '0x10', '5px', '+8']) assert.equal(parseGridSize(value), null, value);
});

check('selection by type includes group siblings, preserves layer order and stays document local', () => {
  const items = [component('label', 0, 0), { ...component('button', 50, 0, 40, 28, 'button'), groupId: 'pair' }, component('outside', 150, 0, 40, 28, 'button'), { ...component('group-label', 100, 0), groupId: 'pair' }];
  assert.deepEqual(selectComponentType(items, 'label'), ['label', 'button', 'group-label']);
  assert.deepEqual(selectComponentType(items, 'button'), ['button', 'outside', 'group-label']);
  assert.deepEqual(selectComponentType(items, 'unknown'), []);
  assert.deepEqual(selectComponentType([], 'label'), []);
});

check('matching width uses first selected layer regardless of selection order and preserves data', () => {
  const binding = { width: { expression: '200', references: {} } };
  const items = [component('reference', 0, 10, 80, 50), component('outside', 100, 10, 70, 60), component('target', 150, 100, 40, 28, 'button', { text: 'Keep', bindings: binding })];
  const result = matchSelectedSize(items, ['target', 'reference', 'reference', 'missing'], 'width', bounds);
  assert.equal(result.error, undefined);
  assert.deepEqual(geometries(result.components), [{ id: 'reference', x: 0, y: 10, width: 80, height: 50 }, { id: 'outside', x: 100, y: 10, width: 70, height: 60 }, { id: 'target', x: 150, y: 100, width: 80, height: 28 }]);
  assert.equal(result.components[0], items[0]);
  assert.equal(result.components[1], items[1]);
  assert.equal(result.components[2].props, items[2].props);
  assert.equal(result.components[2].props.bindings, binding);
  assert.equal(items[2].width, 40);
});

check('matching height and both dimensions retain target origins', () => {
  const items = [component('first', 10, 10, 75, 60), component('next', 120, 70, 110, 40)];
  assert.deepEqual(geometries(matchSelectedSize(items, ['first', 'next'], 'height', bounds).components)[1], { id: 'next', x: 120, y: 70, width: 110, height: 60 });
  assert.deepEqual(geometries(matchSelectedSize(items, ['first', 'next'], 'both', bounds).components)[1], { id: 'next', x: 120, y: 70, width: 75, height: 60 });
});

check('matching a group scales child geometry on the requested axis as one object', () => {
  const items = [component('reference', 0, 0, 240, 112), { ...component('a', 10, 130, 40, 28), groupId: 'pair' }, { ...component('b', 70, 144, 60, 28), groupId: 'pair' }];
  const result = matchSelectedSize(items, ['reference', 'a'], 'width', { width: 500, height: 500 });
  assert.equal(result.error, undefined);
  assert.deepEqual(geometries(result.components).slice(1), [{ id: 'a', x: 10, y: 130, width: 80, height: 28 }, { id: 'b', x: 130, y: 144, width: 120, height: 28 }]);
  assert.equal(selectionBounds(result.components, ['a', 'b']).width, 240);
  assert.ok(result.components.slice(1).every(item => item.groupId === 'pair'));
});

check('a reference group measures its complete bounds and does not change', () => {
  const items = [{ ...component('a', 10, 10, 40, 28), groupId: 'pair' }, component('target', 100, 100, 80, 30), { ...component('b', 60, 30, 80, 42), groupId: 'pair' }];
  const result = matchSelectedSize(items, ['target', 'b'], 'both', bounds);
  assert.equal(result.error, undefined);
  assert.equal(result.components[0], items[0]);
  assert.equal(result.components[2], items[2]);
  assert.deepEqual(geometries(result.components)[1], { id: 'target', x: 100, y: 100, width: 130, height: 62 });
});

check('matching sizes fails atomically if any target cannot fit or a grouped child is too small', () => {
  const items = [component('reference', 0, 0, 100, 80), component('fits', 110, 0, 40, 28), component('edge', 260, 100, 40, 28)];
  const oversized = matchSelectedSize(items, items.map(item => item.id), 'width', bounds);
  assert.match(oversized.error, /beyond the canvas/);
  assert.ok(oversized.components.every((item, index) => item === items[index]));
  const group = [component('reference', 0, 0, 60, 28), { ...component('a', 0, 100), groupId: 'pair' }, { ...component('b', 60, 100), groupId: 'pair' }];
  const small = matchSelectedSize(group, ['reference', 'b'], 'width', bounds);
  assert.match(small.error, /smaller than 40/);
  assert.ok(small.components.every((item, index) => item === group[index]));
});

check('matching size ignores grid rounding and safely handles empty, invalid and unchanged selections', () => {
  const items = [component('first', 0, 0, 70.5, 28), component('second', 90, 0, 40, 28)];
  assert.equal(matchSelectedSize(items, ['first', 'second'], 'width', bounds).components[1].width, 70.5);
  assert.deepEqual(matchSelectedSize(items, [], 'both', bounds), { components: items });
  assert.deepEqual(matchSelectedSize(items, ['first'], 'width', bounds), { components: items });
  assert.deepEqual(matchSelectedSize(items, ['first', 'second'], 'width', { width: NaN, height: 200 }), { components: items });
  const invalid = [{ ...items[0], width: Infinity }, items[1]];
  assert.deepEqual(matchSelectedSize(invalid, ['first', 'second'], 'width', bounds), { components: invalid });
  const same = matchSelectedSize(items, ['first', 'second'], 'height', bounds);
  assert.ok(same.components.every((item, index) => item === items[index]));
  assert.deepEqual(matchSelectedSize(items, ['first', 'second'], 'invalid', bounds), { components: items });
  const tiny = [component('reference', 0, 0, 80, 40), component('tiny', 0, 80, Number.MIN_VALUE, 30)];
  assert.match(matchSelectedSize(tiny, ['reference', 'tiny'], 'width', bounds).error, /cannot be resized safely/);
});

check('a size command is one reversible history transaction and preserves server revisions', () => {
  const original = { id: 'p', name: 'Sizing', revision: 1, parameters: {}, screens: [{ id: 's', ...bounds, components: [component('a', 0, 0, 90, 56), component('b', 100, 50), component('c', 200, 100)] }] };
  const result = matchSelectedSize(original.screens[0].components, ['a', 'b', 'c'], 'both', bounds);
  assert.equal(result.error, undefined);
  const edited = { ...original, revision: 5, screens: [{ ...original.screens[0], components: result.components }] };
  const undone = restoreHistory(checkpoint({ past: [], future: [] }, original), edited, 'undo');
  assert.equal(projectContent(undone.project), projectContent(original));
  assert.equal(undone.project.revision, 5);
  assert.equal(undone.history.past.length, 0);
  const redone = restoreHistory(undone.history, undone.project, 'redo');
  assert.equal(projectContent(redone.project), projectContent(edited));
});

console.log(`${checks}/${checks} canvas model checks passed.`);
