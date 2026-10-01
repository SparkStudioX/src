import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';
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

// Exercise the actual footer control with persistent state and native-modal seams.
// No preview session, script or gateway mutation is started by this harness.
const require = createRequire(import.meta.url), asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const hooksUrl = asModule(`let slots=[],index=0,pending=[];
export const begin=()=>{index=0};export const clear=()=>{slots=[];index=0;pending=[]};
export const useState=initial=>{const at=index++;if(!(at in slots))slots[at]={value:initial};const slot=slots[at];return[slot.value,value=>{slot.value=typeof value==='function'?value(slot.value):value}]};
export const useRef=value=>{const at=index++;return slots[at]??={current:value}};
export const useEffect=(callback,deps)=>{const at=index++,old=slots[at];if(!old||deps.some((value,index)=>value!==old.deps[index])){slots[at]={deps,cleanup:old?.cleanup};pending.push(()=>{slots[at].cleanup?.();slots[at].cleanup=callback()})}};
export const flush=()=>pending.splice(0).forEach(callback=>callback());
export const cleanup=()=>slots.forEach(slot=>slot?.cleanup?.());`);
const iconUrl = asModule('export default function Icon(){return null;}');
const controlSource = await readFile(new URL('src/PreviewControls.tsx', import.meta.url), 'utf8');
const controlCode = ts.transpileModule(controlSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
  .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_full, prefix, _quote, dependency) => prefix + JSON.stringify(dependency === 'react' ? hooksUrl : dependency === './Icon' ? iconUrl : pathToFileURL(require.resolve(dependency)).href));
const { PreviewControls } = await import(asModule(controlCode)), hooks = await import(hooksUrl);
const elements = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(elements)];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node ? '' : React.Children.toArray(node.props?.children).map(text).join('');
const accessibleText = node => node?.props?.['aria-hidden'] === true || node?.props?.['aria-hidden'] === 'true' ? ''
  : typeof node === 'string' || typeof node === 'number' ? String(node) : !node ? '' : React.Children.toArray(node.props?.children).map(accessibleText).join('');
const settle = () => new Promise(resolve => setImmediate(resolve));
const nativeDocument = globalThis.document, nativeElement = globalThis.HTMLElement;
globalThis.document = { activeElement: null };
globalThis.HTMLElement = class { isConnected = true; focused = false; focus() { this.focused = true; } };
function driveControls(extra = {}) {
  hooks.clear(); let tree, diagnostics = 0;
  const modes = [], props = { session: session('read-only'), busy: false, gatewayAdmin: true,
    children: React.createElement('select', { 'aria-label': 'Application language' }, React.createElement('option', null, 'English')),
    onDiagnostics: () => diagnostics++, ...extra,
    onChangeMode: async mode => { modes.push(mode); await extra.onChangeMode?.(mode); props.session = session(mode); },
  };
  const refresh = () => { hooks.begin(); tree = PreviewControls(props); };
  const all = () => elements(tree), find = predicate => { const node = all().find(predicate); assert.ok(node, 'Expected preview control'); return node; };
  const button = label => find(node => node.type === 'button' && (node.props['aria-label'] || accessibleText(node)) === label);
  const click = label => { const node = button(label); assert.ok(!node.props.disabled, `${label} is disabled`); node.props.onClick(); refresh(); };
  refresh(); return { refresh, all, find, button, click, modes, props, diagnostics: () => diagnostics, content: () => text(tree), root: () => tree };
}
async function uiCheck(name, run) { hooks.clear(); try { await run(); passed++; console.log(`PASS ${name}`); } finally { hooks.cleanup(); } }
try {
  await uiCheck('footer Live actions toggle opens confirmation before granting any authority', async () => {
    const ui = driveControls(); assert.equal(ui.root().type, 'div'); assert.equal(ui.root().props['aria-label'], 'Preview communication');
    assert.equal(ui.button('Live actions').props['aria-pressed'], false); ui.click('Live actions'); assert.deepEqual(ui.modes, []);
    assert.ok(ui.all().some(node => node.type === 'dialog')); assert.match(ui.content(), /Actions can change real tags and database data/);
    ui.click('Enable live actions'); await settle(); ui.refresh(); assert.deepEqual(ui.modes, ['live-actions']);
    assert.equal(ui.button('Live actions').props['aria-pressed'], true); assert.ok(!ui.all().some(node => node.type === 'dialog'));
  });
  await uiCheck('all confirmation dismissals preserve read-only mode without requesting a session', () => {
    for (const method of ['keep', 'close', 'escape']) {
      const ui = driveControls(); ui.click('Live actions');
      if (method === 'keep') ui.click('Keep read-only');
      if (method === 'close') ui.find(node => node.props?.['aria-label'] === 'Close live actions confirmation').props.onClick();
      if (method === 'escape') ui.find(node => node.type === 'dialog').props.onCancel({ preventDefault() {} });
      ui.refresh(); assert.deepEqual(ui.modes, []); assert.equal(ui.button('Live actions').props['aria-pressed'], false);
      assert.ok(!ui.all().some(node => node.type === 'dialog'));
    }
  });
  await uiCheck('an enabled toggle returns directly to read-only including a nonadministrator session', async () => {
    for (const gatewayAdmin of [true, false]) {
      const ui = driveControls({ session: session('live-actions'), gatewayAdmin }); assert.equal(ui.button('Live actions').props.disabled, false);
      ui.click('Live actions'); await settle(); ui.refresh(); assert.deepEqual(ui.modes, ['read-only']);
      assert.equal(ui.button('Live actions').props['aria-pressed'], false); assert.ok(!ui.all().some(node => node.type === 'dialog'));
    }
  });
  await uiCheck('busy, missing or expired capability and nonadministrator sessions cannot enable live actions', () => {
    for (const extra of [{ busy: true }, { session: null }, { gatewayAdmin: false }]) {
      const ui = driveControls(extra); assert.equal(ui.button('Live actions').props.disabled, true); assert.deepEqual(ui.modes, []);
      if (extra.busy || extra.session === null) {
        const status = ui.find(node => node.props?.role === 'status');
        assert.equal(text(status), extra.busy ? 'Connecting preview…' : 'Preview unavailable');
        assert.match(status.props.title, /Exit and reopen Preview/);
      }
    }
    const ui = driveControls({ session: session('live-actions'), busy: true }); assert.equal(ui.button('Live actions').props.disabled, true);
    ui.props.busy = false; ui.props.session = null; ui.refresh(); assert.equal(ui.button('Live actions').props['aria-pressed'], false);
    assert.equal(ui.button('Live actions').props.disabled, true, 'the session-expiry update must remove the enabled state');
  });
  await uiCheck('failed mode changes surface an error and never imply live actions are enabled', async () => {
    const ui = driveControls({ onChangeMode: async () => { throw new Error('The preview session could not be started.'); } });
    ui.click('Live actions'); ui.click('Enable live actions'); await settle(); ui.refresh();
    assert.equal(ui.button('Live actions').props['aria-pressed'], false); assert.match(ui.content(), /preview session could not be started/);
    assert.ok(ui.all().some(node => node.props?.role === 'alert')); assert.ok(!ui.all().some(node => node.type === 'dialog'));
  });
  await uiCheck('language selection and project diagnostics remain available beside the inline toggle', () => {
    const ui = driveControls(); assert.ok(ui.all().some(node => node.props?.['aria-label'] === 'Application language'));
    ui.click('Project diagnostics'); assert.equal(ui.diagnostics(), 1); assert.deepEqual(ui.modes, []);
    ui.props.busy = true; ui.refresh(); assert.equal(ui.button('Project diagnostics').props.disabled, true);
  });
  await uiCheck('native confirmation modal focuses Keep read-only and restores its launcher when dismissed', () => {
    const launcher = new HTMLElement(); document.activeElement = launcher;
    const ui = driveControls(); hooks.flush(); ui.click('Live actions');
    let opened = 0, closed = 0;
    ui.find(node => node.type === 'dialog').props.ref.current = { showModal() { opened++; }, close() { closed++; } };
    const keep = new HTMLElement(); ui.button('Keep read-only').props.ref.current = keep;
    hooks.flush(); assert.equal(opened, 1); assert.equal(keep.focused, true);
    ui.click('Keep read-only'); hooks.flush(); assert.equal(closed, 1); assert.equal(launcher.focused, true); assert.deepEqual(ui.modes, []);
  });
  await uiCheck('Designer places preview controls and screen dimensions in the footer without the redundant context and canvas strips', async () => {
    const appText = await readFile(new URL('src/App.tsx', import.meta.url), 'utf8');
    const app = ts.createSourceFile('App.tsx', appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), controls = [], footers = [], strips = [];
    function visit(node) {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(app) === 'PreviewControls') controls.push(node);
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(app) === 'footer') footers.push(node);
      if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.text === 'className' && ['canvas-bottom', 'canvas-footnote'].includes(attribute.initializer?.text))) strips.push(node);
      ts.forEachChild(node, visit);
    }
    visit(app); assert.equal(controls.length, 1);
    const footer = footers.find(node => node.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.text === 'className' && attribute.initializer?.text === 'statusbar'));
    assert.ok(footer); assert.ok(controls[0].pos > footer.pos && controls[0].end < footer.end, 'Live actions belongs in the persistent status footer');
    assert.match(footer.getText(app), /screen\.width/); assert.match(footer.getText(app), /screen\.height/);
    assert.doesNotMatch(appText, /className="parameter-toolbar"|className="toolbar-group parameter-toolbar"/);
    assert.equal(strips.length, 2, 'design-only selection and grid hints remain available');
    for (const strip of strips) {
      let guarded = false;
      for (let ancestor = strip.parent; ancestor; ancestor = ancestor.parent) {
        if (ts.isBinaryExpression(ancestor) && ancestor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && ancestor.left.getText(app) === '!preview') guarded = true;
      }
      assert.ok(guarded, 'canvas selection and grid hints are excluded from Preview');
    }
    assert.match(appText, /<ComponentEventDiagnostics state=\{applicationState\}/, 'real conditional script diagnostics are retained');
  });
} finally {
  if (nativeDocument === undefined) delete globalThis.document; else globalThis.document = nativeDocument;
  if (nativeElement === undefined) delete globalThis.HTMLElement; else globalThis.HTMLElement = nativeElement;
}
console.log(`${passed} preview communication model and footer UI checks passed.`);
