import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('src/projectPaneLayout.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { DEFAULT_PROJECT_PANES, MIN_PROJECT_PANES, PROJECT_PANE_SEPARATOR_HEIGHT, restoreProjectPanes, fitProjectPanes, moveProjectPaneDivider, projectPaneKeyDelta,
  DEFAULT_DESIGNER_PANES, MIN_DESIGNER_PANES, MAX_DESIGNER_PANES, MIN_DESIGNER_CANVAS, DESIGNER_PANE_SEPARATOR_WIDTH,
  restoreDesignerPanes, fitDesignerPanes, moveDesignerPane, designerPaneMaximum, designerPaneKeyDelta,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`); }
function sum(values) { return values.reduce((total, value) => total + value, 0); }

test('invalid or unavailable browser preferences restore the default split', () => {
  for (const value of [null, {}, [], [1, 2], [1, 2, 3, 4], ['1', 2, 3], [0, 1, 2], [-1, 2, 3], [NaN, 2, 3], [Infinity, 2, 3]]) {
    assert.deepEqual(restoreProjectPanes(value), DEFAULT_PROJECT_PANES);
  }
});
test('saved dimensions normalize without overflowing and preserve their relative split', () => {
  assert.deepEqual(restoreProjectPanes([2, 3, 5]), [0.2, 0.3, 0.5]);
  const large = restoreProjectPanes([Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE]);
  for (const weight of large) near(weight, 1 / 3);
});
test('normal windows fit all three panes and both handles into the available height', () => {
  const heights = fitProjectPanes(DEFAULT_PROJECT_PANES, 700);
  near(sum(heights) + PROJECT_PANE_SEPARATOR_HEIGHT * 2, 700);
  heights.forEach((height, index) => assert.ok(height >= MIN_PROJECT_PANES[index]));
});
test('short or unmeasured windows retain minimum usable panes for stack scrolling', () => {
  for (const height of [0, -20, 100, 293, NaN, Infinity]) assert.deepEqual(fitProjectPanes(DEFAULT_PROJECT_PANES, height), MIN_PROJECT_PANES);
});
test('a constrained pane receives its minimum while remaining space is redistributed', () => {
  const heights = fitProjectPanes([0.01, 0.49, 0.5], 700);
  assert.equal(heights[0], 112);
  near(sum(heights), 686);
  near(heights[1] / heights[2], 0.49 / 0.5);
});
test('dragging each divider changes its two neighbors without disturbing the third', () => {
  const original = [240, 180, 280];
  assert.deepEqual(moveProjectPaneDivider(original, 0, 40), [280, 140, 280]);
  assert.deepEqual(moveProjectPaneDivider(original, 1, -35), [240, 145, 315]);
  assert.deepEqual(original, [240, 180, 280]);
});
test('dragging beyond either edge clamps to minimum height without collapsing sections', () => {
  const heights = [240, 180, 280];
  assert.deepEqual(moveProjectPaneDivider(heights, 0, -10000), [112, 308, 280]);
  assert.deepEqual(moveProjectPaneDivider(heights, 0, 10000), [336, 84, 280]);
  assert.deepEqual(moveProjectPaneDivider(heights, 1, -10000), [240, 84, 376]);
  assert.deepEqual(moveProjectPaneDivider(heights, 1, 10000), [240, 376, 84]);
});
test('resizing at the minimum stack height cannot hide another pane', () => {
  for (const divider of [0, 1]) for (const delta of [-100, 100]) assert.deepEqual(moveProjectPaneDivider(MIN_PROJECT_PANES, divider, delta), MIN_PROJECT_PANES);
});
test('a saved drag round trips through reload and scales with a taller window', () => {
  const initial = fitProjectPanes(DEFAULT_PROJECT_PANES, 700);
  const dragged = moveProjectPaneDivider(initial, 0, 70);
  const preferences = restoreProjectPanes(JSON.parse(JSON.stringify(restoreProjectPanes(dragged))));
  const restored = fitProjectPanes(preferences, 700);
  restored.forEach((height, index) => near(height, dragged[index]));
  const taller = fitProjectPanes(preferences, 1000);
  near(sum(taller), 986);
  taller.forEach((height, index) => near(height / 986, preferences[index]));
});
test('shrinking then expanding does not overwrite the intended proportions', () => {
  const preferences = restoreProjectPanes([400, 100, 200]);
  fitProjectPanes(preferences, 294);
  const expanded = fitProjectPanes(preferences, 714);
  expanded.forEach((height, index) => near(height, [400, 100, 200][index]));
});
test('keyboard arrows support precise and coarse adjustments; Home and End reach boundaries', () => {
  assert.equal(projectPaneKeyDelta('ArrowUp', false), -8);
  assert.equal(projectPaneKeyDelta('ArrowDown', false), 8);
  assert.equal(projectPaneKeyDelta('ArrowUp', true), -32);
  assert.equal(projectPaneKeyDelta('ArrowDown', true), 32);
  assert.deepEqual(moveProjectPaneDivider([240, 180, 280], 0, projectPaneKeyDelta('Home', false)), [112, 308, 280]);
  assert.deepEqual(moveProjectPaneDivider([240, 180, 280], 0, projectPaneKeyDelta('End', false)), [336, 84, 280]);
  assert.equal(projectPaneKeyDelta('Tab', false), null);
});
test('non-finite pointer movement is ignored', () => {
  assert.deepEqual(moveProjectPaneDivider([240, 180, 280], 0, NaN), [240, 180, 280]);
});

test('horizontal pane preferences recover from malformed storage and clamp extreme saved widths', () => {
  for (const value of [null, {}, [], [220], [1, 2, 3], ['220', 300], [0, 300], [-1, 300], [NaN, 300], [Infinity, 300]]) assert.deepEqual(restoreDesignerPanes(value), DEFAULT_DESIGNER_PANES);
  assert.deepEqual(restoreDesignerPanes([1, 1]), MIN_DESIGNER_PANES);
  assert.deepEqual(restoreDesignerPanes([Number.MAX_VALUE, Number.MAX_VALUE]), MAX_DESIGNER_PANES);
});

test('normal desktop layout preserves widths and reserves enough canvas for editing', () => {
  assert.deepEqual(fitDesignerPanes([360, 480], 1600), [360, 480]);
  const fitted = fitDesignerPanes([360, 480], 1100);
  near(sum(fitted) + MIN_DESIGNER_CANVAS + DESIGNER_PANE_SEPARATOR_WIDTH * 2, 1100);
  fitted.forEach((width, index) => assert.ok(width >= MIN_DESIGNER_PANES[index]));
});

test('shrinking the browser never saves over desired horizontal widths; expanding restores them', () => {
  const preferences = [420, 600];
  assert.deepEqual(fitDesignerPanes(preferences, 600), MIN_DESIGNER_PANES);
  assert.deepEqual(fitDesignerPanes(preferences, 1600), preferences);
  assert.deepEqual(preferences, [420, 600]);
});

test('very narrow windows retain useful panes and a scrollable canvas instead of collapsing them', () => {
  for (const width of [1, 300, 733, 734]) assert.deepEqual(fitDesignerPanes([400, 400], width), MIN_DESIGNER_PANES);
  for (const width of [0, NaN, Infinity]) assert.deepEqual(fitDesignerPanes([400, 400], width), [400, 400]);
});

test('horizontal drags change only the requested pane and keep the canvas above its minimum', () => {
  assert.deepEqual(moveDesignerPane([244, 280], 0, 56, 1200), [300, 280]);
  assert.deepEqual(moveDesignerPane([244, 280], 1, 120, 1200), [244, 400]);
  const fitted = moveDesignerPane([244, 280], 1, 10000, 1000);
  assert.deepEqual(fitted, [244, 422]);
  near(1000 - sum(fitted) - DESIGNER_PANE_SEPARATOR_WIDTH * 2, MIN_DESIGNER_CANVAS);
});

test('both panes respect minimum and maximum widths without stealing the other pane', () => {
  assert.deepEqual(moveDesignerPane([244, 280], 0, -10000, 2000), [180, 280]);
  assert.deepEqual(moveDesignerPane([244, 280], 1, -10000, 2000), [244, 220]);
  assert.deepEqual(moveDesignerPane([244, 280], 0, 10000, 2000), [480, 280]);
  assert.deepEqual(moveDesignerPane([244, 280], 1, 10000, 2000), [244, 640]);
  assert.equal(designerPaneMaximum([244, 280], 0, 1000), 386);
  for (const side of [0, 1]) assert.deepEqual(moveDesignerPane(MIN_DESIGNER_PANES, side, 10000, 600), MIN_DESIGNER_PANES);
});

test('keyboard left and right move each horizontal divider in the physical arrow direction', () => {
  assert.equal(designerPaneKeyDelta('ArrowLeft', false, 0), -8);
  assert.equal(designerPaneKeyDelta('ArrowRight', false, 0), 8);
  assert.equal(designerPaneKeyDelta('ArrowLeft', false, 1), 8);
  assert.equal(designerPaneKeyDelta('ArrowRight', false, 1), -8);
  assert.equal(designerPaneKeyDelta('ArrowLeft', true, 1), 32);
  assert.equal(designerPaneKeyDelta('Tab', false, 0), null);
  for (const side of [0, 1]) {
    const smallest = moveDesignerPane([244, 280], side, designerPaneKeyDelta('Home', false, side), 1200);
    assert.equal(smallest[side], MIN_DESIGNER_PANES[side]);
    const largest = moveDesignerPane([244, 280], side, designerPaneKeyDelta('End', false, side), 1200);
    assert.equal(largest[side], designerPaneMaximum([244, 280], side, 1200));
  }
});

test('horizontal widths survive JSON persistence and ignore invalid pointer movement', () => {
  const adjusted = moveDesignerPane([244, 280], 1, 100, 1200);
  assert.deepEqual(fitDesignerPanes(restoreDesignerPanes(JSON.parse(JSON.stringify(adjusted))), 1200), adjusted);
  for (const delta of [NaN, Infinity, -Infinity]) assert.deepEqual(moveDesignerPane(adjusted, 0, delta, 1200), adjusted);
});
console.log(`${passed} project-pane checks passed.`);
