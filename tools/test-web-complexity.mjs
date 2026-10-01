#!/usr/bin/env node
import assert from 'node:assert/strict';
import { analyzeSource, summarize, compareReports, metric } from './analyze-web-complexity.mjs';

const fixture = analyzeSource('fixture.tsx', `
function decisions(a: number, b: number) {
  if (a && b || a ?? b) a++;
  for (let i = 0; i < 2; i++) a++;
  for (const key in {}) a++;
  for (const value of []) a++;
  while (a < 0) a++;
  do { a++ } while (a < 0);
  try { a++ } catch (error) { a++ }
  switch (a) { case 1: a++; break; case 2: a++; break; default: a++; }
  return a ? a : b;
}
function outer() {
  const inner = () => { if (true) return 1; return 0; };
  return <button onClick={() => { if (true) inner(); }}>Click</button>;
}
class Controller { get ready() { return true; } run() { return 1; } }
const optional = () => value?.result;
const assignments = () => { value ||= 1; value &&= 2; value ??= 3; };
`);
const find = name => fixture.functions.find(item => item.name === name);
assert.equal(find('decisions').complexity, 14);
assert.deepEqual(find('decisions').decisions, { if: 1, '||': 1, '&&': 1, '??': 1, for: 1, 'for-in': 1, 'for-of': 1, while: 1, 'do-while': 1, catch: 1, 'non-default switch case': 2, 'conditional expression': 1 });
assert.equal(find('outer').complexity, 1, 'nested functions do not inflate parent complexity');
assert.equal(find('outer / inner').complexity, 2);
assert.equal(find('outer / jsx:onClick').complexity, 2, 'JSX callbacks are independently reported');
assert.equal(find('Controller / ready').complexity, 1);
assert.equal(find('Controller / run').complexity, 1);
assert.equal(find('optional').complexity, 1);
assert.equal(find('assignments').complexity, 1);
assert.equal(fixture.functions.length, 8);
assert.equal(fixture.sha256.length, 64);
assert.ok(fixture.functions.every(item => item.line > 0 && item.column > 0 && item.endLine >= item.line));
assert.deepEqual(summarize([]), { functions: 0, totalComplexity: 0, totalDecisions: 0, maximum: 0, mean: 0, median: 0, above10: 0, above20: 0, above50: 0 });
assert.equal(summarize(fixture.functions).totalDecisions, 15);
const changed = analyzeSource('fixture.tsx', 'function decisions(a: number) { return a; }');
const report = files => ({ metric, summary: { files: files.length, ...summarize(files.flatMap(file => file.functions)) }, functions: files.flatMap(file => file.functions), files: files.map(file => ({ ...file, summary: summarize(file.functions) })) });
const comparison = compareReports(report([fixture]), report([changed]));
assert.equal(comparison.changedFiles.length, 1);
assert.equal(comparison.changedFunctions[0].delta, -13);
assert.equal(comparison.removedFunctions.length, 7);
assert.equal(comparison.addedFunctions.length, 0);
assert.throws(() => analyzeSource('invalid.ts', 'function broken('), /invalid.ts/);
assert.throws(() => compareReports({ ...report([fixture]), metric: {} }, report([changed])), /different complexity definitions/);
console.log('PASS web complexity: decisions, nested separation, JSX callbacks, class members, exclusions, source hashes, aggregation and comparison');
