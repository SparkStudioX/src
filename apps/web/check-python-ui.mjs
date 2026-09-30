import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';

process.on('uncaughtException', error => { console.error(error.stack?.split('\n').filter(line => !line.includes('data:')).join('\n') ?? error.message); process.exit(1); });
process.on('unhandledRejection', error => { console.error(error?.message ?? error); process.exit(1); });
const require = createRequire(import.meta.url), cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const file = ['ts', 'tsx'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX}}).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dep) => prefix + JSON.stringify(dep.startsWith('./') ? load(dep.slice(2)) : pathToFileURL(require.resolve(dep)).href));
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64'); cache.set(name, url); return url;
}
const {ApplicationStateStore} = await import(load('applicationStateModel'));
const {InputStateBindingForm} = await import(load('inputStateBindings'));
const {capturePythonUiAction, applyPythonUiOverrides, pythonUiRequest, pythonUiPreviewContext, applyPythonUiResult} = await import(load('pythonUiModel'));
const c = (id, type = 'label', props = {}) => ({id, type, x: 0, y: 0, width: 150, height: 40, props});
const components = [c('button', 'button', {action: 'script'}), c('title', 'label', {text: 'Authored'})];
const text = (value, componentId = 'title') => ({kind: 'property', componentId, property: 'text', value});
const state = (value, scope = 'screen', key = 'title') => ({kind: 'state', scope, key, value});
function environment() {
  const store = new ApplicationStateStore(); store.configure('project', {notice: {type: 'string', value: 'session'}});
  const screen = store.activateScreen('main', {title: {type: 'string', value: 'screen'}, count: {type: 'number', value: 0}});
  return {store, screen, context: () => store.context(screen)};
}
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const inputEffect = (componentId, value) => ({kind: 'input', componentId, value});
function formEnvironment(items, env = environment(), context = env.context) {
  const form = new InputStateBindingForm(), edits = {}, seen = [];
  let options = {document: {id: 'main', name: 'Main', width: 800, height: 600, components: items}, tags: [], parameters: {}, state: context(), active: true,
    edits, onEdit(field, value, automatic) { edits[field] = value; seen.push([field, value, automatic]); }};
  const update = patch => { options = {...options, ...patch, state: context()}; form.update(options); };
  update(); return {env, form, seen, update, action: () => capturePythonUiAction(context(), items, () => true, {assign: form.assignment(true), parameters: options.parameters})};
}

await check('typed input effects update the form without triggering operator input events', () => {
  const cases = [['textInput', 'typed'], ['textArea', 'long'], ['numberInput', 3], ['spinner', 4], ['slider', 5], ['checkbox', true], ['toggle', false],
    ['select', 'b'], ['radioGroup', 'b'], ['multiStateButton', 'b'], ['list', 'b'], ['treeView', 'b'], ['dateTimeInput', '2026-09-30T12:30']];
  const items = cases.map(([type], index) => c(`i${index}`, type, {fieldKey: `f${index}`, options: [{label: 'A', value: 'a'}, {label: 'B', value: 'b'}], min: 0, max: 10}));
  const f = formEnvironment(items); f.action().apply(cases.map(([, value], index) => inputEffect(`i${index}`, value)));
  assert.deepEqual(f.form.values(), Object.fromEntries(cases.map(([, value], index) => [`f${index}`, value])));
  assert.ok(f.seen.every(([, , automatic]) => automatic === true)); assert.deepEqual(f.env.context().propertyOverrides, {});
  assert.deepEqual(f.action().ui.properties, {}, 'input values are separate from presentation overrides');
});

await check('input, presentation and state effects publish one complete batch', () => {
  const f = formEnvironment([...components, c('note', 'textInput')]), snapshots = [];
  f.env.store.subscribe(() => snapshots.push({ui: f.env.context().uiSnapshot(), inputs: f.form.values()}));
  f.action().apply([inputEffect('note', 'first'), state('changed'), text('ready'), inputEffect('note', 'last')]);
  assert.equal(snapshots.length, 1); assert.equal(snapshots[0].inputs.note, 'last'); assert.equal(snapshots[0].ui.state.screen.title, 'changed');
  assert.equal(snapshots[0].ui.properties.title.text, 'ready'); assert.deepEqual(f.seen, [['note', 'last', true]]);
});

await check('invalid input effects reject the entire mixed batch before mutation', () => {
  const variants = [[c('field', 'numberInput', {min: 1, max: 10}), ''], [c('field', 'numberInput'), Infinity], [c('field', 'numberInput'), Number.MAX_SAFE_INTEGER + 1],
    [c('field', 'numberInput', {min: 1, max: 10}), 11], [c('field', 'checkbox'), 'true'], [c('field', 'textInput'), 'x'.repeat(4097)],
    [c('field', 'textInput'), null], [c('field', 'dateTimeInput'), '2026-02-30T10:00'],
    [c('field', 'select', {options: [{label: 'A', value: 'a'}]}), 'b'], [c('field', 'passwordInput'), 'secret'], [c('field', 'label'), 'x']];
  for (const props of [{readOnly: true}, {stateBinding: {scope: 'screen', key: 'title'}}, {tagPath: '[default]x'}, {optionsSource: {queryId: 'q'}},
    {selectionFields: []}, {bindings: {value: {expression: '1'}}}, {queryBindings: {value: {queryId: 'q'}}}]) variants.push([c('field', 'textInput', props), 'x']);
  for (const [item, value] of variants) {
    const f = formEnvironment([...components, item]); assert.throws(() => f.action().apply([state('invalid'), text('invalid'), inputEffect(item.id, value)]), `${item.type} ${JSON.stringify(item.props)}`);
    assert.deepEqual(f.seen, []); assert.equal(f.env.context().api.get('screen', 'title'), 'screen'); assert.deepEqual(f.env.context().propertyOverrides, {});
  }
  const f = formEnvironment([c('field', 'textInput')]);
  for (const effect of [inputEffect('missing', 'x'), {...inputEffect('field', 'x'), extra: true}, {...inputEffect('field', 'x'), componentId: 3}]) assert.throws(() => f.action().apply([effect]));
  assert.throws(() => capturePythonUiAction(f.env.context(), [c('field', 'textInput')]).apply([inputEffect('field', 'x')]), /live form/);
});

await check('newer target edits including A to B to A reject every stale effect', () => {
  const f = formEnvironment([...components, c('note', 'textInput', {defaultValue: 'A'}), c('other', 'textInput')]), action = f.action();
  f.form.assignment()('note', 'B'); f.form.assignment()('note', 'A');
  assert.throws(() => action.apply([state('stale'), inputEffect('note', 'late')]), /changed while Python/);
  assert.equal(f.form.values().note, 'A'); assert.equal(f.env.context().api.get('screen', 'title'), 'screen');
  const unrelated = f.action(); f.form.assignment()('other', 'new'); unrelated.apply([inputEffect('note', 'valid')]); assert.equal(f.form.values().other, 'new'); assert.equal(f.form.values().note, 'valid');
  const stateConflict = f.action(); f.env.context().api.set('screen', 'title', 'newer'); assert.throws(() => stateConflict.apply([inputEffect('note', 'not applied'), state('stale')]), /UI changed/); assert.equal(f.form.values().note, 'valid');
});

await check('form context changes retire responses but action busy locks permit automatic assignments', () => {
  const items = [c('note', 'textInput')];
  for (const retire of [f => {f.form.deactivate(); f.form.activate();}, f => f.update({contextKey: 'replaced'}), f => f.update({parameters: {station: 'other'}}), f => f.env.store.closeScope(f.env.screen)]) {
    const f = formEnvironment(items), action = f.action(); retire(f); assert.throws(() => action.apply([inputEffect('note', 'late')]), /closed/); assert.deepEqual(f.seen, []);
  }
  const f = formEnvironment(items), action = f.action(); f.update({active: false}); action.apply([inputEffect('note', 'finished')]); assert.equal(f.form.values().note, 'finished');
});

await check('current input definitions are rechecked and a newly readonly field rejects all effects', () => {
  for (const props of [{readOnly: true}, {selectionFields: []}, {bindings: {value: {expression: '1'}}}, {queryBindings: {value: {queryId: 'q'}}}]) {
    const f = formEnvironment([...components, c('note', 'textInput')]), action = f.action();
    f.update({document: {id: 'main', components: [...components, c('note', 'textInput', props)]}});
    assert.throws(() => action.apply([state('invalid'), inputEffect('note', 'late')])); assert.deepEqual(f.seen, []); assert.equal(f.env.context().api.get('screen', 'title'), 'screen');
  }
});

await check('matching field names in popup and row forms remain isolated', () => {
  const env = environment(), items = [c('note', 'textInput')], popup = env.store.createScope('popup'), rowA = env.store.createScope('row'), rowB = env.store.createScope('row');
  const forms = [formEnvironment(items, env), formEnvironment(items, env, () => env.store.context(popup)), formEnvironment(items, env, () => env.store.context(env.screen, rowA)), formEnvironment(items, env, () => env.store.context(env.screen, rowB))];
  forms[2].action().apply([inputEffect('note', 'only row A')]); assert.deepEqual(forms.map(f => f.form.values().note), ['', '', 'only row A', '']);
});

await check('password presentation is available while text and value remain inaccessible', () => {
  const env = environment(), password = c('secret', 'passwordInput');
  capturePythonUiAction(env.context(), [password]).apply([{kind: 'property', componentId: 'secret', property: 'enabled', value: false}]);
  assert.equal(applyPythonUiOverrides(password, env.context()).props.enabled, false);
  for (const property of ['text', 'value', 'defaultValue']) assert.throws(() => capturePythonUiAction(env.context(), [password]).apply([{kind: 'property', componentId: 'secret', property, value: 'secret'}]));
});

await check('UI snapshots are detached, frozen, exact, and exclude authored component definitions', () => {
  const env = environment(), context = env.context(), action = capturePythonUiAction(context, components);
  assert.deepEqual(action.ui, {state: {session: {notice: 'session'}, screen: {title: 'screen', count: 0}}, properties: {}});
  assert.ok(Object.isFrozen(action.ui) && Object.isFrozen(action.ui.state.screen));
  context.api.set('screen', 'title', 'later'); assert.equal(action.ui.state.screen.title, 'screen');
  assert.deepEqual(pythonUiRequest(action), {ui: action.ui}); assert.deepEqual(pythonUiRequest(undefined), {});
});

await check('Preview descriptors select one document and one instance-path representation', () => {
  assert.deepEqual(pythonUiPreviewContext({screenId: 'main'}, 'button'), {screenId: 'main', componentId: 'button'});
  assert.deepEqual(pythonUiPreviewContext({templateId: 'panel'}, 'button'), {templateId: 'panel', componentId: 'button'});
  assert.deepEqual(pythonUiPreviewContext({screenId: 'popup'}, 'button', {instanceId: 'rows', rowId: 'r1'}), {screenId: 'popup', componentId: 'button', instanceId: 'rows', rowId: 'r1'});
  const instance = {instanceId: 'outer', rowId: 'r1', instancePath: [{instanceId: 'outer', rowId: 'r1'}, {instanceId: 'inner'}]};
  const result = pythonUiPreviewContext({screenId: 'main'}, 'button', instance);
  assert.deepEqual(result, {screenId: 'main', componentId: 'button', instancePath: instance.instancePath});
  instance.instancePath[0].rowId = 'changed'; assert.equal(result.instancePath[0].rowId, 'r1');
});

await check('state and presentation effects publish atomically and survive into the next action snapshot', () => {
  const env = environment(), seen = [], unsubscribe = env.store.subscribe(() => seen.push(env.context().uiSnapshot()));
  capturePythonUiAction(env.context(), components).apply([state('Changed'), text('Override'), {kind: 'property', componentId: 'title', property: 'color', value: '#1234'}]);
  assert.equal(seen.length, 1); assert.equal(seen[0].state.screen.title, 'Changed'); assert.equal(seen[0].properties.title.text, 'Override');
  const next = capturePythonUiAction(env.context(), components); assert.equal(next.ui.properties.title.text, 'Override');
  const rendered = applyPythonUiOverrides(components[1], env.context()); assert.equal(rendered.props.text, 'Override'); assert.equal(rendered.props.color, '#1234');
  assert.equal(components[1].props.text, 'Authored'); unsubscribe();
});

await check('separate tabs, screen and popup openings retain distinct property state', () => {
  const first = environment(), second = environment(); capturePythonUiAction(first.context(), components).apply([text('Tab one')]);
  assert.deepEqual(second.context().propertyOverrides, {});
  const popup = first.store.createScope('popup', {title: {type: 'string', value: 'popup'}}), popupContext = first.store.context(popup);
  capturePythonUiAction(popupContext, components).apply([text('Popup only'), state('Popup title')]);
  assert.equal(first.context().propertyOverrides.title.text, 'Tab one'); assert.equal(popupContext.uiSnapshot().properties.title.text, 'Popup only');
  assert.equal(first.context().api.get('screen', 'title'), 'screen'); first.store.closeScope(popup);
  const reopened = first.store.createScope('popup', {title: {type: 'string', value: 'popup'}}); assert.deepEqual(first.store.context(reopened).propertyOverrides, {});
});

await check('repeated and nested instance overrides stay in the exact calling form', () => {
  const env = environment(), a = env.store.createScope('row', {title: {type: 'string', value: 'a'}}), b = env.store.createScope('row', {title: {type: 'string', value: 'b'}});
  const ca = env.store.context(env.screen, a), cb = env.store.context(env.screen, b);
  capturePythonUiAction(ca, components).apply([text('Row A'), state('changed a', 'instance')]);
  assert.equal(ca.uiSnapshot().properties.title.text, 'Row A'); assert.deepEqual(cb.propertyOverrides, {}); assert.deepEqual(env.context().propertyOverrides, {});
  assert.equal(cb.api.get('instance', 'title'), 'b');
  const nested = env.store.createScope('child'), child = env.store.context(env.screen, nested, [a]), late = capturePythonUiAction(child, components);
  env.store.closeScope(a); assert.equal(late.isCurrent(), false); assert.throws(() => late.apply([text('late')]), /closed/);
});

await check('disposed, reopened, suspended and reconfigured scopes revoke pending UI results', () => {
  const env = environment(), action = capturePythonUiAction(env.context(), components);
  env.store.closeScope(env.screen); env.store.resumeScope(env.screen); assert.throws(() => action.apply([text('late')]), /closed/);
  const suspended = capturePythonUiAction(env.context(), components); env.store.suspend(); env.store.resume(); assert.throws(() => suspended.apply([text('late')]), /closed/);
  const reloaded = capturePythonUiAction(env.context(), components); env.store.configure('next'); assert.throws(() => reloaded.apply([text('late')]), /closed/);
});

await check('whole response fails before mutation on invalid target, property type or undeclared state', () => {
  const bad = [text('no target', 'missing'), {kind: 'property', componentId: 'title', property: 'width', value: 10}, state(3), state('x', 'instance'),
    {kind: 'state', scope: 'screen', key: 'missing', value: 'x'}, {...text('x'), unknown: true}, {kind: 'property', componentId: 'title', property: 'fontSize', value: 0},
    {kind: 'property', componentId: 'title', property: 'color', value: 'red'}, {kind: 'property', componentId: 'title', property: 'visible', value: 'false'}];
  for (const invalid of bad) {
    const env = environment(); assert.throws(() => capturePythonUiAction(env.context(), components).apply([state('must not persist'), invalid]));
    assert.equal(env.context().api.get('screen', 'title'), 'screen'); assert.deepEqual(env.context().propertyOverrides, {});
  }
});

await check('passwords, expression bindings and query bindings reject UI property writes', () => {
  for (const item of [c('title', 'passwordInput'), c('title', 'label', {bindings: {text: {expression: 'x'}}}),
    c('title', 'label', {queryBindings: {text: {queryId: 'q'}}})]) {
    const env = environment(); assert.throws(() => capturePythonUiAction(env.context(), [item]).apply([state('no'), text('invalid')]));
    assert.equal(env.context().api.get('screen', 'title'), 'screen'); assert.deepEqual(env.context().propertyOverrides, {});
  }
});

await check('wrapper presentation properties are bounded while structural template and row data remain inaccessible', () => {
  for (const type of ['template', 'repeater']) {
    const item = c('title', type), env = environment(); capturePythonUiAction(env.context(), [item]).apply([text('Wrapper title')]);
    assert.equal(applyPythonUiOverrides(item, env.context()).props.text, 'Wrapper title');
    for (const property of ['templateId', 'rows', 'parameters', 'children'])
      assert.throws(() => capturePythonUiAction(env.context(), [item]).apply([{kind: 'property', componentId: 'title', property, value: 'forged'}]));
  }
});

await check('late state edits and resets to the same value conflict without applying any UI property', () => {
  for (const edit of [context => context.api.set('screen', 'title', 'newer'), context => context.api.reset('screen', 'title'), context => {
    context.api.set('screen', 'title', 'other'); context.api.set('screen', 'title', 'screen'); }]) {
    const env = environment(), context = env.context(), action = capturePythonUiAction(context, components); edit(context);
    assert.throws(() => action.apply([text('no property'), state('stale')]), /UI changed/); assert.deepEqual(env.context().propertyOverrides, {});
  }
});

await check('property conflicts reject the full batch while unrelated local state edits are preserved', () => {
  const env = environment(), older = capturePythonUiAction(env.context(), components), newer = capturePythonUiAction(env.context(), components);
  newer.apply([text('newer')]); assert.throws(() => older.apply([state('no state'), text('older')]), /UI changed/);
  assert.equal(env.context().api.get('screen', 'title'), 'screen'); assert.equal(env.context().propertyOverrides.title.text, 'newer');
  const unrelated = capturePythonUiAction(env.context(), components); env.context().api.set('screen', 'count', 2); unrelated.apply([text('allowed')]);
  assert.equal(env.context().api.get('screen', 'count'), 2); assert.equal(env.context().propertyOverrides.title.text, 'allowed');
});

await check('source identity changes fence responses, and a result cannot be applied twice', () => {
  const env = environment(); let current = true; const edited = capturePythonUiAction(env.context(), components, () => current); current = false;
  assert.throws(() => edited.apply([text('wrong publication')]), /closed/); assert.throws(() => pythonUiRequest(edited), /closed/);
  const action = capturePythonUiAction(env.context(), components); action.apply([text('first')]); assert.throws(() => action.apply([text('second')]), /already applied/);
  assert.equal(env.context().propertyOverrides.title.text, 'first');
});

await check('new bindings override previous presentation changes and are excluded from later snapshots', () => {
  const env = environment(); capturePythonUiAction(env.context(), components).apply([text('old override')]);
  const bound = c('title', 'label', {text: 'Binding value', bindings: {text: {expression: 'x'}}});
  assert.equal(applyPythonUiOverrides(bound, env.context()).props.text, 'Binding value');
  const action = capturePythonUiAction(env.context(), [bound]); assert.deepEqual(action.ui.properties, {}); assert.throws(() => action.apply([text('new override')]), /binding/);
});

await check('effects enforce precise UTF-8 size boundaries including non-ASCII text', () => {
  const make = () => {
    const effects = Array.from({length: 16}, () => text('é'.repeat(2048)));
    const excess = Buffer.byteLength(JSON.stringify(effects)) - 65536;
    effects[15].value = 'é'.repeat(2048 - Math.ceil(excess / 2)) + (excess % 2 ? 'a' : '');
    assert.equal(Buffer.byteLength(JSON.stringify(effects)), 65536); return effects;
  };
  const env = environment(); capturePythonUiAction(env.context(), components).apply(make());
  const invalid = make(); invalid[15].value += 'a'; assert.throws(() => capturePythonUiAction(env.context(), components).apply(invalid), /64 KiB/);
  assert.throws(() => capturePythonUiAction(env.context(), components).apply(Array.from({length: 129}, () => text('x'))), /128/);
  assert.throws(() => capturePythonUiAction(env.context(), components).apply([text('x'.repeat(4097))]), /Invalid/);
});

await check('UI snapshots enforce 256 KiB without truncating state', () => {
  const env = environment(), values = Object.fromEntries(Array.from({length: 64}, (_, index) => ['value' + index, {type: 'string', value: 'x'.repeat(4096)}]));
  env.store.configure('large', values); const screen = env.store.activateScreen('large');
  assert.throws(() => capturePythonUiAction(env.store.context(screen), components), /256 KiB/);
});

await check('all supported scalar presentation properties accept boundary values', () => {
  const env = environment(), effects = [text(''), ['enabled', false], ['visible', false], ['color', '#abc'], ['backgroundColor', '#abcd'],
    ['foregroundColor', '#abcdef'], ['borderColor', '#abcdef12'], ['borderWidth', 32], ['fontSize', 256]]
    .map(item => Array.isArray(item) ? {kind: 'property', componentId: 'title', property: item[0], value: item[1]} : item);
  capturePythonUiAction(env.context(), components).apply(effects); const rendered = applyPythonUiOverrides(components[1], env.context());
  assert.equal(rendered.props.enabled, false); assert.equal(rendered.props.borderWidth, 32); assert.equal(rendered.props.fontSize, 256);
});

await check('unsuccessful gateway results never apply effects; local conflicts report completed gateway data separately', () => {
  const env = environment(), action = capturePythonUiAction(env.context(), components);
  applyPythonUiResult(action, {success: false, uiEffects: [text('ignored')]}); assert.deepEqual(env.context().propertyOverrides, {});
  env.context().api.reset('screen', 'title');
  assert.throws(() => applyPythonUiResult(action, {success: true, uiEffects: [state('stale')]}), /Gateway data changes may already have completed/);
  assert.throws(() => applyPythonUiResult(undefined, {success: true, uiEffects: [text('ignored')]}), /no live UI action context/);
});

await check('actual ComponentView and BoundComponent preserve Python text braces and empty captions', async () => {
  const {createElement} = await import('react'), {renderToStaticMarkup} = await import('react-dom/server');
  const {ComponentView} = await import(load('Components'));
  const {default: BoundComponent} = await import(load('BoundComponent'));
  const {ApplicationStateProvider} = await import(load('applicationState'));
  const shared = {tags: [], parameters: {station: 'REPLACED'}, preview: true, onNavigate() {}};
  for (const value of ['Order {station}', '']) {
    const direct = renderToStaticMarkup(createElement(ComponentView, {...shared, component: c('title', 'button', {text: value}), literalText: true}));
    assert.ok(!direct.includes('REPLACED')); assert.ok(!direct.includes('>Button<'));
    if (value) assert.ok(direct.includes(value));
    const env = environment(); capturePythonUiAction(env.context(), components).apply([text(value)]);
    const rendered = renderToStaticMarkup(createElement(ApplicationStateProvider, {value: {...env.context(), store: env.store}},
      createElement(BoundComponent, {...shared, component: components[1], components})));
    assert.ok(!rendered.includes('REPLACED')); assert.ok(!rendered.includes('Authored')); assert.ok(!rendered.includes('>Text<'));
    if (value) assert.ok(rendered.includes(value));
  }
});

await check('a Python effect on the clicked button changes its caption after busy clears without changing its action', async () => {
  const {createElement} = await import('react'), {renderToStaticMarkup} = await import('react-dom/server');
  const {default: BoundComponent} = await import(load('BoundComponent'));
  const {ApplicationStateProvider} = await import(load('applicationState'));
  const env = environment(), button = c('run-python', 'button', {text: 'Run Python', action: 'script', script: 'self.text = "hi"'});
  const render = (actionBusy, preview = true) => renderToStaticMarkup(createElement(ApplicationStateProvider, {value: {...env.context(), store: env.store}},
    createElement(BoundComponent, {component: button, components: [button], tags: [], parameters: {station: 'REPLACED'}, preview, actionBusy, onNavigate() {}})));
  assert.match(render(false), />Run Python</);
  for (const value of ['hi', 'Order {station}', '']) {
    const action = capturePythonUiAction(env.context(), [button]);
    applyPythonUiResult(action, {success: true, uiEffects: [text(value, button.id)]});
    assert.match(render(true), /Running…/);
    const idle = render(false); assert.ok(!idle.includes('Running…')); assert.ok(!idle.includes('>Button<')); assert.ok(!idle.includes('REPLACED'));
    if (value) assert.ok(idle.includes(`>${value}<`)); else assert.ok(!idle.includes('>Run Python<'));
    assert.equal(capturePythonUiAction(env.context(), [button]).ui.properties[button.id].text, value);
  }
  assert.equal(button.props.action, 'script'); assert.equal(button.props.script, 'self.text = "hi"'); assert.equal(button.props.text, 'Run Python');
  assert.match(render(false, false), />Run Python</, 'runtime caption changes do not rewrite the designer canvas');
});

console.log(`Python UI bridge: ${passed} groups passed.`);
