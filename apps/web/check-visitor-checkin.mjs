// Independently authored workshop acceptance. No external requests or real visitor data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { buildWorkshop, readCatalog, readZip } from '../../tools/workshop-packages.mjs';

const require = createRequire(import.meta.url), modules = new Map();
function load(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  if (modules.has(name)) return modules.get(name);
  const file = ['ts', 'tsx'].map(extension => new URL(`src/${name}.${extension}`, import.meta.url)).find(file => fs.existsSync(file));
  assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText.replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_match, prefix, _quote, dependency) => prefix + JSON.stringify(dependency.startsWith('./') ? load(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href));
  const result = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64'); modules.set(name, result); return result;
}
const { ApplicationStateStore } = await import(load('applicationStateModel'));
const { ComponentEventLifecycle, executeComponentEvent } = await import(load('componentEventModel'));
const { InputStateBindingForm } = await import(load('inputStateBindings'));
const root = new URL('../../', import.meta.url);
const source = JSON.parse(fs.readFileSync(new URL('examples/visitor-checkin.json', root), 'utf8'));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve, reject; const promise = new Promise((success, failure) => { resolve = success; reject = failure; }); return { promise, resolve, reject }; };
let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`); }
async function until(predicate, message) {
  const end = Date.now() + 1000;
  while (Date.now() < end) { if (predicate()) return; await delay(2); }
  throw new Error(`Timed out: ${message}`);
}

// The remaining checks run the authored mounted controller through the real
// component and state lifetimes. The injected transport supplies synthetic PNGs.
const welcome = source.screens.find(screen => screen.id === 'welcome');
assert.ok(welcome, 'The workshop must start with a welcome screen.');
const controller = welcome.components.find(component => component.id === 'visitor-controller');
assert.ok(controller?.props.componentEvents?.mount && controller.props.messageHandlers?.length);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4xkAAAAASUVORK5CYII=', 'base64');
const pngResponse = () => new Response(png, { headers: { 'Content-Type': 'image/png' } });
function fixture() {
  const store = new ApplicationStateStore(); store.configure('visitor-fixture', source.sessionState);
  const screen = store.activateScreen(welcome.id, welcome.state);
  const life = new ComponentEventLifecycle(executeComponentEvent);
  const form = new InputStateBindingForm();
  function render() {
    const state = store.context(screen);
    form.update({ document: welcome, tags: [], parameters: {}, state, active: true, onEdit() {} });
    life.prepare({ key: state.key, component: controller, components: welcome.components,
      inputs: form.values(),
      parameters: {}, state: state.api, stateValues: state.values, isCurrent: state.isCurrent,
      coordinator: store.componentEvents,
      messages: { bus: store.componentMessages, screenKey: screen.key, instanceKey: screen.key },
    });
    life.commit();
  }
  life.activate(); render();
  const read = key => store.context(screen).api.get('screen', key);
  const set = (key, value) => { store.context(screen).api.set('screen', key, value); render(); };
  const host = welcome.components.find(component => component.props.stateBinding?.key === 'host').props.options.find(option => option.value && option.value !== 'choose').value;
  const fill = (changes = {}) => { for (const [key, value] of Object.entries({ name: 'Sample Visitor', email: 'sample@example.com', host, photoUrl: 'blob:http://127.0.0.1:5093/visitor-photo', ...changes })) set(key, value); };
  const send = async type => {
    render();
    const receipt = store.context(screen).sendMessage(type, {}, { scope: 'screen' });
    assert.equal(receipt.accepted, 1, `Mounted ${type} controller must be reachable.`);
    await life.whenIdle(); render();
  };
  const edit = (field, value) => { form.assignment()(field, value); render(); };
  const dispose = async () => { render(); form.deactivate(); store.closeScope(screen); life.deactivate(); await life.whenIdle(); };
  return { store, screen, life, form, render, read, set, fill, edit, send, dispose };
}

await check('portable draft includes static hosts, camera, transient badge binding and no gateway resources', async () => {
  const catalog = await readCatalog(fileURLToPath(root));
  const entry = catalog.workshops.find(workshop => workshop.id === 'visitor-checkin');
  assert.equal(entry.distribution, 'portable'); assert.equal(entry.gatewayWrites, 'none'); assert.equal(entry.entryScreenId, 'welcome');
  const built = await buildWorkshop(fileURLToPath(root), entry, '2026-09-30T00:00:00.000Z');
  assert.deepEqual(built.project.screens, source.screens); assert.deepEqual(built.queries, []); assert.deepEqual(built.scripts.resources, []);
  assert.equal(built.project.navigation.mode, 'none'); assert.equal(built.project.navigation.startupScreenId, 'welcome');
  assert.deepEqual([...readZip(built.bytes).keys()].sort(), ['manifest.json', 'project.json', 'queries.json', 'scripts-draft.json']);
  const form = welcome.components.filter(component => component.props.stateBinding);
  for (const key of ['name', 'email', 'host', 'photoUrl']) assert.ok(form.some(component => component.props.stateBinding.key === key), key);
  const hosts = form.find(component => component.props.stateBinding.key === 'host');
  assert.ok(hosts.props.options.length >= 3); assert.equal(hosts.props.optionsSource, undefined);
  const image = welcome.components.find(component => component.type === 'image');
  assert.ok(image.props.bindings.imageUrl); assert.equal(image.props.imageUrl ?? '', '');
});

await check('missing, invalid or forged details are rejected before contacting Labelary', async () => {
  await withTransport(async transport => {
    for (const changes of [
      { name: '   ' }, { email: 'invalid-email' }, { email: 'person@example' },
      { name: 'x'.repeat(1000) }, { email: 'x'.repeat(1000) + '@example.com' },
      { host: '' }, { host: 'choose' }, { host: 'unlisted-person' }, { photoUrl: '' }, { photoUrl: 'https://unexpected.example/photo.png' },
    ]) {
      const app = fixture(); await app.life.whenIdle(); app.fill(changes);
      try {
        await app.send('visitor-check-in');
        assert.ok(app.read('error'), `Expected validation for ${JSON.stringify(changes)}`);
        assert.equal(app.read('busy'), false); assert.equal(app.read('badgeReady'), false); assert.equal(app.read('badgeUrl'), '');
      } finally { await app.dispose(); }
    }
    assert.equal(transport.requests.length, 0);
  });
});

await check('cleared or invalid input drafts cannot submit previously accepted visitor details', async () => {
  await withTransport(async transport => {
    for (const [field, value, stateKey, stored] of [
      ['visitorName', '', 'name', ''],
      ['visitorName', 'x'.repeat(73), 'name', 'Sample Visitor'],
      ['visitorEmail', '', 'email', ''],
      ['visitorEmail', 'x'.repeat(101), 'email', 'sample@example.com'],
      ['visitorPhoto', '', 'photoUrl', ''],
      ['visitorPhoto', 'https://unexpected.example/photo.png', 'photoUrl', 'blob:http://127.0.0.1:5093/visitor-photo'],
    ]) {
      const app = fixture(); await app.life.whenIdle(); app.fill(); app.edit(field, value);
      try {
        assert.equal(app.read(stateKey), stored, 'Over-length text and invalid camera drafts preserve accepted state; cleared fields remain empty.');
        assert.equal(app.form.values()[field], value, 'The action receives the actual current draft.');
        await app.send('visitor-check-in');
        assert.ok(app.read('error')); assert.equal(app.read('busy'), false); assert.equal(app.read('badgeReady'), false);
      } finally { await app.dispose(); }
    }
    assert.equal(transport.requests.length, 0); assert.equal(transport.photos.length, 0);
  });
});

await check('a synthetic photo and UTF-8 details produce escaped ZPL, one PNG badge and a clean Dismiss', async () => {
  await withTransport(async transport => {
    const app = fixture(); await app.life.whenIdle();
    const visitor = 'Zoë ^XZ ~JA _7E'; app.fill({ name: visitor });
    try {
      await app.send('visitor-check-in');
      await until(() => app.read('badgeReady'), 'badge ready'); app.render();
      assert.equal(transport.requests.length, 1); assert.equal(transport.photos.length, 1);
      const request = transport.requests[0];
      assert.match(request.url, /^https:\/\/api\.labelary\.com\/v1\/printers\/8dpmm\/labels\/4x3\/0\/?$/);
      assert.equal(request.method, 'POST'); assert.equal(new Headers(request.headers).get('accept'), 'image/png');
      assert.equal(new Headers(request.headers).get('content-type'), 'application/x-www-form-urlencoded');
      assert.equal(request.credentials, 'omit'); assert.equal(request.referrerPolicy, 'no-referrer'); assert.equal(request.redirect, 'error');
      const body = String(request.body), encoded = [...Buffer.from(visitor, 'utf8')].map(byte => '_' + byte.toString(16).padStart(2, '0').toUpperCase()).join('');
      assert.ok(body.includes('^FH_^FD' + encoded), 'Visitor text must be encoded as UTF-8 field data.');
      assert.ok(!body.includes(visitor)); assert.equal((body.match(/\^XZ/g) ?? []).length, 1); assert.ok(!body.includes('~JA'));
      const graphic = /\^GFA,(\d+),(\d+),(\d+),([0-9A-F]+)/.exec(body);
      assert.ok(graphic, 'Captured image must be embedded as monochrome ZPL graphics.');
      assert.equal(Number(graphic[1]), 4608); assert.equal(Number(graphic[2]), 4608); assert.equal(Number(graphic[3]), 24); assert.equal(graphic[4].length, 4608 * 2);
      assert.equal(graphic[4], ('FF'.repeat(12) + '00'.repeat(12)).repeat(192), 'Synthetic black/white pixels produce the expected thermal-printer bits.');
      assert.deepEqual(transport.imageCalls.find(call => Array.isArray(call)).slice(1), [40, 0, 320, 320, 0, 0, 192, 192], 'The camera capture is center-cropped to the badge square.');
      assert.equal(app.read('busy'), false); assert.equal(app.read('error'), '');
      assert.equal(app.read('badgeUrl'), transport.created[0].url); assert.ok(transport.imageCalls.includes('close'));
      const badge = app.read('badgeUrl');
      await app.send('visitor-dismiss');
      for (const key of ['name', 'email', 'host', 'photoUrl', 'badgeUrl', 'error', 'busy', 'badgeReady']) assert.equal(app.read(key), welcome.state[key].value, `Dismiss restores ${key}.`);
      assert.ok(transport.revoked.includes(badge)); assert.equal(transport.requests.length, 1);
    } finally { await app.dispose(); }
  });
});

await check('repeated check-in messages share one pending request and failures retain the entered form for retry', async () => {
  await withTransport(async transport => {
    const pending = deferred(); transport.respond(() => pending.promise);
    const app = fixture(); await app.life.whenIdle(); app.fill();
    try {
      await app.send('visitor-check-in'); await until(() => transport.requests.length === 1, 'pending request');
      assert.equal(app.read('busy'), true); await app.send('visitor-check-in'); assert.equal(transport.requests.length, 1);
      pending.resolve(new Response('Too many requests', { status: 429 }));
      await until(() => !app.read('busy'), 'failure completes');
      assert.ok(app.read('error')); assert.equal(app.read('name'), 'Sample Visitor'); assert.equal(app.read('email'), 'sample@example.com'); assert.equal(app.read('badgeReady'), false); assert.equal(app.read('badgeUrl'), '');
      transport.respond(() => pngResponse()); await app.send('visitor-check-in');
      await until(() => app.read('badgeReady'), 'explicit retry renders badge'); assert.equal(transport.requests.length, 2);
    } finally { await app.dispose(); }
    for (const { url } of transport.created) assert.ok(transport.revoked.includes(url), 'Closing the screen revokes every displayed badge.');
  });
});

await check('network, HTTP and invalid image failures never display a badge or lose typed details', async () => {
  await withTransport(async transport => {
    for (const response of [
      () => { throw new TypeError('Synthetic network failure'); },
      () => new Response('Invalid ZPL', { status: 400 }),
      () => new Response('Unavailable', { status: 503 }),
      () => new Response('<html>Not an image</html>', { headers: { 'Content-Type': 'text/html' } }),
      () => new Response(new Uint8Array(), { headers: { 'Content-Type': 'image/png' } }),
      () => new Response('Synthetic non-PNG bytes', { headers: { 'Content-Type': 'image/png' } }),
      () => new Response(new Uint8Array(2000001), { headers: { 'Content-Type': 'image/png' } }),
    ]) {
      transport.respond(response);
      const app = fixture(); await app.life.whenIdle(); app.fill();
      try {
        await app.send('visitor-check-in'); await until(() => !app.read('busy'), 'failed request completes');
        assert.ok(app.read('error')); assert.equal(app.read('name'), 'Sample Visitor'); assert.equal(app.read('badgeReady'), false); assert.equal(app.read('badgeUrl'), '');
      } finally { await app.dispose(); }
    }
    assert.equal(transport.created.length, 0);
  });
});

await check('leaving during a request aborts transport and prevents a late badge from reaching another visit', async () => {
  await withTransport(async transport => {
    const pending = deferred(); transport.respond(() => pending.promise);
    const app = fixture(); await app.life.whenIdle(); app.fill();
    await app.send('visitor-check-in'); await until(() => transport.requests.length === 1, 'request starts');
    const old = { ...app.screen.values };
    await app.dispose(); assert.equal(transport.requests[0].signal.aborted, true);
    pending.resolve(pngResponse()); await delay(25);
    assert.deepEqual(app.screen.values, old); assert.equal(transport.created.length, 0);
    const next = fixture(); await next.life.whenIdle();
    try { assert.equal(next.read('badgeUrl'), ''); assert.equal(next.read('name'), ''); assert.equal(next.read('busy'), false); }
    finally { await next.dispose(); }
  });
});
console.log(`${checks}/${checks} visitor check-in workshop checks passed.`);
async function withTransport(run) {
  const savedFetch = globalThis.fetch, savedCreate = URL.createObjectURL, savedRevoke = URL.revokeObjectURL;
  const globals = ['document', 'window', 'location', 'createImageBitmap'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const requests = [], photos = [], created = [], revoked = [], imageCalls = [];
  let respond = () => pngResponse();
  globalThis.fetch = async (url, options = {}) => {
    const request = { url: String(url), ...options };
    if (request.url.startsWith('blob:')) { photos.push(request); return pngResponse(); }
    requests.push(request);
    return await respond(request);
  };
  URL.createObjectURL = blob => { assert.equal(blob.type, 'image/png'); const url = `blob:http://127.0.0.1:5093/visitor-label-${created.length + 1}`; created.push({ url, blob }); return url; };
  URL.revokeObjectURL = url => revoked.push(url);
  globalThis.window = { location: { origin: 'http://127.0.0.1:5093' } };
  globalThis.location = globalThis.window.location;
  globalThis.createImageBitmap = async () => ({ width: 400, height: 320, close() { imageCalls.push('close'); } });
  globalThis.document = { createElement(name) {
    assert.equal(name, 'canvas');
    return { width: 0, height: 0, getContext(type) {
      assert.equal(type, '2d');
      return { fillStyle: '', fillRect() {}, drawImage(...args) { imageCalls.push(args); }, getImageData(_x, _y, width, height) {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let pixel = 0; pixel < width * height; pixel++) {
          const offset = pixel * 4, shade = pixel % width < width / 2 ? 0 : 255;
          data[offset] = data[offset + 1] = data[offset + 2] = shade; data[offset + 3] = 255;
        }
        return { width, height, data };
      } };
    } };
  } };
  const controls = { requests, photos, created, revoked, imageCalls, respond: next => { respond = next; } };
  try { await run(controls); }
  finally {
    globalThis.fetch = savedFetch; URL.createObjectURL = savedCreate; URL.revokeObjectURL = savedRevoke;
    for (const [key, descriptor] of globals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
}
