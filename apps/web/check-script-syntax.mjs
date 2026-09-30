import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const file = fs.readFileSync(new URL('src/scriptSyntax.ts', import.meta.url), 'utf8');
const module = ts.transpileModule(file, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { checkScriptSyntax, scriptSyntaxMessage, ScriptSyntaxCheck } = await import('data:text/javascript;base64,' + Buffer.from(module).toString('base64'));
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
const signal = () => new AbortController().signal;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
await check('JavaScript compiles async handler syntax without executing any statements', async () => {
  globalThis.syntaxSideEffect = 0;
  assert.deepEqual(await checkScriptSyntax('javascript', 'globalThis.syntaxSideEffect++; while (true) {}', () => assert.fail(), signal()), { valid: true });
  assert.equal(globalThis.syntaxSideEffect, 0); delete globalThis.syntaxSideEffect;
  assert.equal((await checkScriptSyntax('javascript', 'await Promise.resolve(); return event;', () => assert.fail(), signal())).valid, true);
});
await check('invalid JavaScript reports a syntax error without using the Python endpoint', async () => {
  const result = await checkScriptSyntax('javascript', 'if (', () => assert.fail(), signal()); assert.equal(result.valid, false); assert.ok(result.message);
});
await check('Python validation forwards only source and cancellation to the compiler endpoint', async () => {
  const expected = { valid: false, message: 'expected colon', line: 2, column: 8 }, token = signal();
  assert.deepEqual(await checkScriptSyntax('python', 'if True', async (code, cancellation) => { assert.equal(code, 'if True'); assert.equal(cancellation, token); return expected; }, token), expected);
  assert.match(scriptSyntaxMessage(expected), /Line 2, column 8: expected colon/);
  assert.match(scriptSyntaxMessage({valid:true}), /Code was not run/);
});
await check('oversized and cancelled source never reaches the compiler', async () => {
  await assert.rejects(checkScriptSyntax('python', 'x'.repeat(65537), () => assert.fail(), signal()), /65,536/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(checkScriptSyntax('python', '', () => assert.fail(), controller.signal));
});
await check('editing or closing discards a late syntax result and aborts its request', async () => {
  const state = new ScriptSyntaxCheck(), wait = deferred(); let token;
  const result = state.run(signal => { token = signal; return wait.promise; }); state.cancel();
  assert.equal(token.aborted, true); wait.resolve({valid:true}); assert.equal(await result, undefined);
});
await check('a new check fences older success and failure without replacing the current result', async () => {
  const state = new ScriptSyntaxCheck(), first = deferred(), second = deferred();
  const old = state.run(() => first.promise), current = state.run(() => second.promise);
  first.reject(new Error('old network error')); second.resolve({valid:false,message:'new error'});
  assert.equal(await old, undefined); assert.deepEqual(await current, {valid:false,message:'new error'});
});
await check('real compiler failures stay distinct from invalid source', async () => {
  const state = new ScriptSyntaxCheck(); await assert.rejects(state.run(() => Promise.reject(new Error('Python unavailable'))), /unavailable/);
});
await check('every shared editor exposes compile-only checking and clears feedback when source changes', () => {
  const editor = fs.readFileSync(new URL('src/ScriptEditor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /Check syntax/); assert.match(editor, /Compile only · no script execution/);
  assert.match(editor, /"\/scripts\/validate", "POST", \{ code \}/); assert.match(editor, /\[value, language\]/);
  assert.match(editor, /syntaxCheck.current.cancel\(\)/); assert.match(editor, /Syntax check unavailable/);
});
console.log(`${passed}/${passed} shared script syntax checks passed.`);
